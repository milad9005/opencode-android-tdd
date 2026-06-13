/**
 * tdd_* tools (SPEC-v2 §7). Each tool is self-evidencing: it validates phase /
 * slice / stateVersion and produces its own evidence — it never trusts a model
 * claim like "this is green". All mutations go through the phase machine under
 * the worktree lock with CAS, and every action is logged to the ledger.
 *
 * Built as a factory over injected deps (store/ledger/machine/runner/doctor) so
 * the whole tool surface is testable with a fake Gradle runner.
 */
import { type ToolDefinition } from "@opencode-ai/plugin";
import { StateStore } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { PhaseMachine } from "./machine.js";
import { type GradleRunner } from "./doctor.js";
import { type ShellExec } from "./gradle/runner.js";
export interface ToolDeps {
    worktree: string;
    store: StateStore;
    ledger: Ledger;
    machine: PhaseMachine;
    shell: ShellExec;
    doctorRunner: GradleRunner;
    toolchainJavaHome: () => string | undefined;
    toolchainId: () => string | undefined;
    qualityChecks?: string[];
}
export declare function createTools(deps: ToolDeps): Record<string, ToolDefinition>;
