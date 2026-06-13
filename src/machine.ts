/**
 * Phase machine (SPEC-v2 §3). The plugin owns the canonical phase; callers may
 * only advance it through `advance()`, which:
 *  - validates the transition against the allowed-transitions table,
 *  - refuses while a gate lease is held (a mutator is mid-flight — Blocker #4),
 *  - commits via compare-and-swap on stateVersion (Blocker #3),
 *  - records every transition + lease event to the append-only ledger.
 *
 * It never trusts a caller's claim ("this is green"); evidence-producing tools
 * (tdd_verify_*) attach proofs before requesting a transition.
 */

import type { Phase, WorkflowState, GateLease } from "./state/types.js";
import { StateStore, CasConflictError } from "./state/store.js";
import { Ledger } from "./state/ledger.js";

const ALLOWED: Record<Phase, Phase[]> = {
  INACTIVE: ["DOCTOR"],
  DOCTOR: ["CONTEXT", "INACTIVE"],
  CONTEXT: ["CLARIFY"],
  CLARIFY: ["PLAN"],
  PLAN: ["BASELINE"],
  BASELINE: ["TEST_WRITE"],
  TEST_WRITE: ["VERIFY_RED"],
  // VERIFY_RED stays put on BROKEN/NO_TESTS/ENV (caller re-enters TEST_WRITE),
  // or advances to IMPL once a redProof is set.
  VERIFY_RED: ["IMPL", "TEST_WRITE"],
  IMPL: ["VERIFY_GREEN"],
  // still-red returns to IMPL; green advances to REFACTOR.
  VERIFY_GREEN: ["REFACTOR", "IMPL"],
  REFACTOR: ["VERIFY_GREEN", "INSPECT", "TEST_WRITE"],
  INSPECT: ["BASELINE", "ARCH_GATE"],
  ARCH_GATE: ["REGRESSION_GATE"],
  REGRESSION_GATE: ["REPORT"],
  REPORT: ["DONE"],
  DONE: [],
};

export class IllegalTransitionError extends Error {
  constructor(from: Phase, to: Phase) {
    super(`Illegal phase transition ${from} -> ${to}. Allowed: ${ALLOWED[from].join(", ") || "(none)"}.`);
    this.name = "IllegalTransitionError";
  }
}

export class LeaseHeldError extends Error {
  constructor(lease: GateLease) {
    super(`Cannot transition while a gate lease is held (tool=${lease.tool}, file=${lease.filePath}, callID=${lease.callID}).`);
    this.name = "LeaseHeldError";
  }
}

export function canTransition(from: Phase, to: Phase): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export interface AdvanceInput {
  to: Phase;
  /** mutate the state alongside the transition (set/clear slice, proof, etc.) */
  mutate?: (draft: WorkflowState) => void;
  detail?: Record<string, unknown>;
}

export class PhaseMachine {
  constructor(
    private readonly store: StateStore,
    private readonly ledger: Ledger,
  ) {}

  current(): WorkflowState {
    const s = this.store.read();
    if (!s) throw new Error("No workflow state; call tdd_start first.");
    return s;
  }

  /**
   * Advance the phase under the worktree lock with CAS. Throws (fails closed) on
   * illegal transition, held lease, or version conflict — the caller must not
   * retry blindly; it must re-read and re-decide.
   */
  advance(input: AdvanceInput): WorkflowState {
    const state = this.current();

    if (state.activeLease) throw new LeaseHeldError(state.activeLease);
    if (!canTransition(state.phase, input.to)) {
      throw new IllegalTransitionError(state.phase, input.to);
    }

    const draft: WorkflowState = structuredClone(state);
    draft.phase = input.to;
    input.mutate?.(draft);

    const committed = this.store.commit(state.stateVersion, draft);
    this.ledger.append({
      workflowId: committed.workflowId,
      stateVersion: committed.stateVersion,
      type: "PHASE_TRANSITION",
      phase: committed.phase,
      sliceId: committed.currentSliceId,
      detail: { from: state.phase, to: input.to, ...input.detail },
    });
    return committed;
  }

  /** Acquire a gate lease for a mutator that passed the gate. CAS-guarded. */
  acquireLease(lease: Omit<GateLease, "acquiredAt" | "stateVersion">): WorkflowState {
    const state = this.current();
    if (state.activeLease) throw new LeaseHeldError(state.activeLease);
    const draft: WorkflowState = structuredClone(state);
    draft.activeLease = { ...lease, stateVersion: state.stateVersion, acquiredAt: Date.now() };
    const committed = this.store.commit(state.stateVersion, draft);
    this.ledger.append({
      workflowId: committed.workflowId,
      stateVersion: committed.stateVersion,
      type: "LEASE_ACQUIRED",
      phase: committed.phase,
      sliceId: committed.currentSliceId,
      detail: { tool: lease.tool, filePath: lease.filePath, callID: lease.callID },
    });
    return committed;
  }

  /** Release the gate lease iff it matches the given callID. */
  releaseLease(callID: string): WorkflowState {
    const state = this.current();
    if (!state.activeLease || state.activeLease.callID !== callID) return state;
    const draft: WorkflowState = structuredClone(state);
    const released = draft.activeLease;
    draft.activeLease = undefined;
    const committed = this.store.commit(state.stateVersion, draft);
    this.ledger.append({
      workflowId: committed.workflowId,
      stateVersion: committed.stateVersion,
      type: "LEASE_RELEASED",
      phase: committed.phase,
      sliceId: committed.currentSliceId,
      detail: { callID, tool: released?.tool, filePath: released?.filePath },
    });
    return committed;
  }
}

export { CasConflictError };
