/**
 * Canonical TDD workflow state types. The plugin owns this state as a security
 * boundary: every write permission is bound to worktree + workflow + slice +
 * file-hash + verified run. Keyed by worktree+workflowId (never sessionID, since
 * subagents run under distinct child sessions — SPEC-v2 §2.3).
 */
export function initialState(worktree, workflowId) {
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
