/**
 * Tool -> bucket classification (SPEC-v2 §2.1 / Blocker #1).
 *
 * The gate is an ALLOW-LIST, not a block-list: every tool is read-only,
 * plugin-owned, or a guarded mutator; ANYTHING ELSE is denied. A new/MCP/unknown
 * tool with filesystem capability therefore fails closed by default.
 *
 * Raw `bash` is denied while a workflow is active so the plugin's classifier is
 * the only arbiter of pass/fail — all Gradle goes through tdd_run/tdd_quality.
 */
const READ_ONLY = new Set([
    "read",
    "grep",
    "glob",
    "list",
    "webfetch",
    "task",
]);
const READ_ONLY_PREFIXES = ["lsp_"];
const GUARDED_MUTATORS = new Set(["write", "edit"]);
const PLUGIN_OWNED_PREFIX = "tdd_";
/**
 * Tools explicitly known to mutate or escape the gate; named for clear deny
 * messages. Not load-bearing for safety — the allow-list default already denies
 * anything not read-only/plugin-owned/guarded — but produces better UX.
 */
const KNOWN_DENIED = new Set([
    "bash",
    "patch",
    "apply",
    "move",
    "rename",
    "delete",
    "remove",
]);
export function classifyTool(tool) {
    if (tool.startsWith(PLUGIN_OWNED_PREFIX))
        return "plugin-owned";
    if (READ_ONLY.has(tool) || READ_ONLY_PREFIXES.some((p) => tool.startsWith(p))) {
        return "read-only";
    }
    if (GUARDED_MUTATORS.has(tool))
        return "guarded-mutator";
    // KNOWN_DENIED falls through here too; everything unrecognized => denied.
    return "denied";
}
export function isKnownDenied(tool) {
    return KNOWN_DENIED.has(tool);
}
