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
export type ToolBucket = "read-only" | "plugin-owned" | "guarded-mutator" | "denied";
export declare function classifyTool(tool: string): ToolBucket;
export declare function isKnownDenied(tool: string): boolean;
