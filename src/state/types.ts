/**
 * Canonical TDD workflow state types. The plugin owns this state as a security
 * boundary: every write permission is bound to worktree + workflow + slice +
 * file-hash + verified run. Keyed by worktree+workflowId (never sessionID, since
 * subagents run under distinct child sessions — SPEC-v2 §2.3).
 */

export type Phase =
  | "INACTIVE"
  | "DOCTOR"
  | "CONTEXT"
  | "CLARIFY"
  | "PLAN"
  | "BASELINE"
  | "TEST_WRITE"
  | "VERIFY_RED"
  | "IMPL"
  | "VERIFY_GREEN"
  | "REFACTOR"
  | "INSPECT"
  | "ARCH_GATE"
  | "REGRESSION_GATE"
  | "REPORT"
  | "DONE";

export type RedClassifier = "RED_ASSERTION" | "RED_MISSING_SYMBOL";

export interface FailingTestIdentity {
  classname: string;
  method: string;
  assertionType?: string;
}

/**
 * Hash-bound proof that a correctly-failing test exists for a slice. Replaces a
 * coarse boolean: any drift in the recorded hashes voids it (SPEC-v2 §2.4).
 */
export interface RedProof {
  workflowId: string;
  sliceId: string;
  runId: string;
  module: string;
  variant: string;
  testTask: string;
  testSelectors: string[];
  expectedSymbols: string[];
  classifier: RedClassifier;
  failingTestIdentity: FailingTestIdentity[];
  sliceTestFileHashes: Record<string, string>;
  productionPreHashes: Record<string, string>;
  buildConfigHash: string;
  toolchainId: string;
  timestamp: number;
}

/**
 * A single TDD slice. Scope fields bound IMPL writes to declared targets only;
 * a redProof never unlocks the whole production tree (SPEC-v2 §2.4 / Blocker #7).
 */
export interface Slice {
  id: string;
  description: string;
  module: string;
  sourceSet: string;
  variant: string;
  testTask: string;
  allowedTestFiles: string[];
  allowedProductionPaths: string[];
  allowedSymbols: string[];
  expectedSymbols: string[];
  baselineFailures?: FailingTestIdentity[];
  status: "pending" | "active" | "done" | "aborted";
}

/**
 * Gate lease binding decision↔execution atomicity: tool.execute.before acquires
 * it for a specific file+phase+stateVersion; tool.execute.after releases it.
 * While held, phase transitions and other mutators for the worktree are blocked
 * (SPEC-v2 §2.3 / Blocker #4).
 */
export interface GateLease {
  callID: string;
  tool: string;
  filePath: string;
  phase: Phase;
  stateVersion: number;
  acquiredAt: number;
}

export interface WorkflowState {
  schemaVersion: 1;
  worktree: string;
  workflowId: string;
  /** monotonic; every mutating transition does compare-and-swap on this */
  stateVersion: number;
  phase: Phase;
  ownerSessionId?: string;
  currentSliceId?: string;
  slices: Slice[];
  redProof?: RedProof;
  greenVerifiedAt?: number;
  toolchainId?: string;
  activeLease?: GateLease;
  /** activation observed (turn-1 bootstrap deny lifts only after this) */
  activated: boolean;
  lastRunId?: string;
  updatedAt: number;
}

export function initialState(worktree: string, workflowId: string): WorkflowState {
  return {
    schemaVersion: 1,
    worktree,
    workflowId,
    stateVersion: 0,
    phase: "INACTIVE",
    slices: [],
    activated: false,
    updatedAt: Date.now(),
  };
}
