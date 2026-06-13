/**
 * opencode-android-tdd — plugin entry.
 *
 * Wires the tested gate + phase machine + ledger into the real @opencode-ai/plugin
 * hooks. The gate is the security boundary (SPEC-v2 §2): every write/edit goes
 * through tool.execute.before -> decideGate(); DENY throws (which opencode surfaces
 * to the model as a tool error, verified in prompt.ts:421-455). On ALLOW a gate
 * lease is acquired and released in tool.execute.after, closing the decision↔exec
 * window. experimental.chat.system.transform injects the phase banner every turn,
 * the only reliable channel given the turn-1 tool-hook gap (issue #6862).
 *
 * Subagent detection: tool.execute.before carries no agent name, but chat.message
 * does. We record each session's agent there; any session whose agent is not the
 * primary orchestrator is treated as a subagent and held read-only (SPEC-v2 §2.3).
 */
import { StateStore } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { PhaseMachine } from "./machine.js";
import { decideGate } from "./gate/decide.js";
import { createTools } from "./tools.js";
import { discoverToolchain } from "./gradle/toolchain.js";
import { installAgentsGlobal, resolveBundledAgentsDir, TDD_PRIMARY_AGENT, TDD_READONLY_SUBAGENTS } from "./install.js";
const PRIMARY_AGENT = TDD_PRIMARY_AGENT;
function extractFilePath(tool, args) {
    if (!args || typeof args !== "object")
        return undefined;
    return args.filePath ?? args.path ?? args.file ?? undefined;
}
function banner(state) {
    if (!state) {
        return [
            "## TDD gate: INACTIVE",
            "No active TDD workflow. Production code writes are DENIED until you call `tdd_start`.",
            "Read-only tools are allowed. Begin with `tdd_start` then `tdd_doctor`.",
        ].join("\n");
    }
    const slice = state.slices.find((s) => s.id === state.currentSliceId);
    const lines = [
        `## TDD gate: phase ${state.phase}` + (state.activated ? "" : " (NOT ACTIVATED — writes denied)"),
        slice ? `Active slice: ${slice.id} — ${slice.description}` : "No active slice.",
    ];
    switch (state.phase) {
        case "TEST_WRITE":
            lines.push("You may edit ONLY the slice's test files. Production edits are DENIED. Write the failing test, then `tdd_run` + `tdd_verify_red`.");
            break;
        case "IMPL":
            lines.push(state.redProof
                ? "Verified RED exists. You may edit ONLY the slice's allowed production paths. Test edits are DENIED. Then `tdd_verify_green`."
                : "No verified RED. Production writes are DENIED. Run `tdd_verify_red` first.");
            break;
        case "REFACTOR":
            lines.push("GREEN verified. Slice-scoped test+prod edits allowed; behavior must not change.");
            break;
        default:
            lines.push("No file writes permitted in this phase. Advance via the appropriate `tdd_*` tool.");
    }
    lines.push("Raw `bash`, `patch`, `move`, `delete`, and unknown tools are DISABLED in TDD mode. Run builds/tests via `tdd_run` / `tdd_quality`.");
    return lines.join("\n");
}
export const AndroidTddPlugin = async ({ worktree, directory, $ }, options) => {
    const root = worktree ?? directory;
    // Plugin hooks are global to the opencode instance; scope all TDD behaviour to
    // one agent so it stays dormant under every other agent. Override via options.
    const tddAgent = options?.agent ?? PRIMARY_AGENT;
    const store = new StateStore(root);
    const ledger = new Ledger(root);
    const machine = new PhaseMachine(store, ledger);
    const bundledAgents = resolveBundledAgentsDir(import.meta.url);
    // Install the agent .md once into the GLOBAL opencode config (~/.config/opencode/
    // agent), like a normal plugin — not into each project's .opencode/agent. The
    // gate stays dormant unless the active agent is the TDD agent, and tdd_doctor
    // does the per-project Gradle/JDK requirement check at runtime.
    if (bundledAgents) {
        try {
            installAgentsGlobal(bundledAgents);
        }
        catch {
            // never block plugin load on agent install
        }
    }
    const toolchain = discoverToolchain(process.env);
    const cleanEnv = () => {
        const out = {};
        for (const [k, v] of Object.entries(process.env))
            if (v !== undefined)
                out[k] = v;
        return out;
    };
    // nothrow: failing tests exit non-zero by design; combined out+err so the
    // classifier sees compiler diagnostics Gradle writes to stderr.
    const shell = {
        async run(cwd, argv, env) {
            const [cmd, ...rest] = argv;
            const res = await $ `${cmd} ${rest}`.cwd(cwd).env({ ...cleanEnv(), ...env }).quiet().nothrow();
            const out = (res.stdout?.toString() ?? "") + (res.stderr?.toString() ?? "");
            return { exitCode: res.exitCode ?? 0, stdout: out };
        },
    };
    const doctorRunner = {
        async moduleTasks(modulePath) {
            const res = await shell.run(root, ["./gradlew", `${modulePath}:tasks`, "--all", "--console=plain"], {
                JAVA_HOME: toolchain.toolchain?.javaHome ?? "",
                PATH: `${toolchain.toolchain?.javaHome ?? ""}/bin:${process.env.PATH ?? ""}`,
            });
            return res.stdout;
        },
    };
    const tools = createTools({
        worktree: root,
        store,
        ledger,
        machine,
        shell,
        doctorRunner,
        toolchainJavaHome: () => toolchain.toolchain?.javaHome,
        toolchainId: () => toolchain.toolchain?.toolchainId,
    });
    // Maps each session to its agent name (recorded by chat.message). The gate
    // activates for the TDD agent FAMILY (primary + the plugin's own read-only
    // subagents) and is dormant for every unrelated agent. Scoping to the family
    // makes decideGate's subagent-read-only rule reachable as defense-in-depth
    // (opencode .md permissions are the first layer; this is the second).
    const sessionAgent = new Map();
    const agentOf = (sessionID) => sessionAgent.get(sessionID);
    const subagentNames = new Set(TDD_READONLY_SUBAGENTS);
    const isPrimary = (sessionID) => agentOf(sessionID) === tddAgent;
    const isSubagent = (sessionID) => {
        const a = agentOf(sessionID);
        return a !== undefined && subagentNames.has(a);
    };
    const inTddScope = (sessionID) => isPrimary(sessionID) || isSubagent(sessionID);
    const hooks = {
        tool: tools,
        "chat.message": async (input) => {
            if (input.sessionID && input.agent)
                sessionAgent.set(input.sessionID, input.agent);
        },
        "tool.execute.before": async (input, output) => {
            // Dormant for every agent outside the TDD family (unrelated globally-installed
            // agents must be untouched). Unknown sub-sessions (no chat.message recorded)
            // also stay dormant — opencode .md permissions still block bundled subagents.
            if (!inTddScope(input.sessionID))
                return;
            const state = store.read();
            const filePath = extractFilePath(input.tool, output.args);
            const gateInput = {
                tool: input.tool,
                callID: input.callID,
                filePath,
                worktree: root,
                state,
                isSubagent: isSubagent(input.sessionID),
            };
            const result = decideGate(gateInput);
            if (result.decision === "DENY") {
                if (state) {
                    ledger.append({
                        workflowId: state.workflowId,
                        stateVersion: state.stateVersion,
                        type: "WRITE_BLOCKED",
                        phase: state.phase,
                        sliceId: state.currentSliceId,
                        detail: { tool: input.tool, filePath, reason: result.reason },
                    });
                }
                throw new Error(result.message);
            }
            // ALLOW: for guarded mutators, take a gate lease so no transition or other
            // mutator can slip in before tool.execute.after releases it.
            if (result.bucket === "guarded-mutator" && state && filePath) {
                try {
                    store.acquireLock();
                    machine.acquireLease({
                        callID: input.callID,
                        tool: input.tool,
                        filePath,
                        phase: state.phase,
                    });
                    ledger.append({
                        workflowId: state.workflowId,
                        stateVersion: state.stateVersion,
                        type: "WRITE_ALLOWED",
                        phase: state.phase,
                        sliceId: state.currentSliceId,
                        detail: { tool: input.tool, filePath, pathBucket: result.pathBucket },
                    });
                }
                finally {
                    store.releaseLock();
                }
            }
        },
        "tool.execute.after": async (input) => {
            const state = store.read();
            if (state?.activeLease?.callID === input.callID) {
                try {
                    store.acquireLock();
                    machine.releaseLease(input.callID);
                }
                finally {
                    store.releaseLock();
                }
            }
        },
        "experimental.chat.system.transform": async (input, output) => {
            if (input.sessionID !== undefined && !inTddScope(input.sessionID))
                return;
            output.system.push(banner(store.read()));
        },
    };
    return hooks;
};
export default AndroidTddPlugin;
