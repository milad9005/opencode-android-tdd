/**
 * The fail-closed gate decision (SPEC-v2 §2.1-2.4 / Blockers #1, #2, #5, #6, #7).
 *
 * A PURE function: given the workflow state, the tool call, and an injected
 * drift-check, it returns ALLOW or DENY with a prescriptive next-action message.
 * The hook wrapper (tool.execute.before) does the I/O (read state, run this,
 * throw on DENY, acquire lease on ALLOW). Keeping the decision pure makes the
 * security boundary fully testable against fixtures.
 *
 * Order of checks is deliberate and fails closed at every step.
 */
import type { WorkflowState } from "../state/types.js";
import { type ToolBucket } from "./buckets.js";
import { type PathBucket } from "./paths.js";
export type GateDecision = "ALLOW" | "DENY";
export interface GateResult {
    decision: GateDecision;
    bucket: ToolBucket;
    pathBucket?: PathBucket;
    reason: string;
    message: string;
}
export interface GateInput {
    tool: string;
    callID: string;
    /** write/edit target; absent for non-file tools */
    filePath?: string;
    worktree: string;
    state: WorkflowState | undefined;
    /** true when the call originates from a delegated subagent (read-only always) */
    isSubagent: boolean;
}
export declare function decideGate(input: GateInput): GateResult;
