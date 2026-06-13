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
import type { Plugin } from "@opencode-ai/plugin";
export declare const AndroidTddPlugin: Plugin;
export default AndroidTddPlugin;
