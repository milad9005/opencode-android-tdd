/**
 * Agent copy-on-init (SPEC-v2 §9 / Major #39).
 *
 * Plugins cannot register agents, so the package bundles four agent `.md` files
 * and the plugin writes them into `.opencode/agent/` on init. This MUST be safe:
 *  - idempotent: re-running never thrashes,
 *  - never overwrites a user's edits,
 *  - refreshes only files this plugin wrote and the user has not since changed.
 *
 * Provenance is tracked by a manifest of content hashes we last wrote. On init,
 * for each bundled agent:
 *   - absent on disk          -> write it,
 *   - on disk == our manifest -> plugin-owned & unchanged -> refresh if bundled
 *                                content changed (version bump), else leave,
 *   - on disk != our manifest -> user-modified -> LEAVE IT, log a notice.
 */
/**
 * Locate the bundled agent `.md` directory. Works in dev (src/agents next to
 * src/install.ts) and when published (dist/agents next to dist/install.js).
 */
export declare function resolveBundledAgentsDir(moduleUrl: string): string | undefined;
export type InstallAction = "written" | "refreshed" | "kept-user-modified" | "kept-current";
export interface InstallResult {
    agent: string;
    action: InstallAction;
}
export declare function installAgents(worktree: string, bundledDir: string): InstallResult[];
