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
export declare class IllegalTransitionError extends Error {
    constructor(from: Phase, to: Phase);
}
export declare class LeaseHeldError extends Error {
    constructor(lease: GateLease);
}
export declare function canTransition(from: Phase, to: Phase): boolean;
export interface AdvanceInput {
    to: Phase;
    /** mutate the state alongside the transition (set/clear slice, proof, etc.) */
    mutate?: (draft: WorkflowState) => void;
    detail?: Record<string, unknown>;
}
export declare class PhaseMachine {
    private readonly store;
    private readonly ledger;
    constructor(store: StateStore, ledger: Ledger);
    current(): WorkflowState;
    /**
     * Advance the phase under the worktree lock with CAS. Throws (fails closed) on
     * illegal transition, held lease, or version conflict — the caller must not
     * retry blindly; it must re-read and re-decide.
     */
    advance(input: AdvanceInput): WorkflowState;
    /** Acquire a gate lease for a mutator that passed the gate. CAS-guarded. */
    acquireLease(lease: Omit<GateLease, "acquiredAt" | "stateVersion">): WorkflowState;
    /** Release the gate lease iff it matches the given callID. */
    releaseLease(callID: string): WorkflowState;
}
export { CasConflictError };
