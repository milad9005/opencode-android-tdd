/**
 * Gradle runner: executes a targeted unit-test task and classifies the result.
 *
 * Execution is abstracted behind `ShellExec` so the tools layer is testable with
 * a fake runner (no real Gradle in unit spikes) while production injects a
 * `$`-backed (Bun shell) executor from the plugin. Hard rules from the spike:
 *   - always --rerun-tasks --console=plain (defeats up-to-date + stale XML),
 *   - run from the resolved toolchain's JAVA_HOME (JRE-only => ENV_FAILURE),
 *   - capture runStartedMs BEFORE launch so stale XML is rejected by mtime.
 */
import { type ClassifierResult } from "./classifier.js";
export interface ShellResult {
    exitCode: number;
    stdout: string;
}
export interface ShellExec {
    /** run argv in cwd with extra env; never throws on non-zero exit. */
    run(cwd: string, argv: string[], env: Record<string, string>): Promise<ShellResult>;
}
export interface RunRequest {
    worktree: string;
    module: string;
    testTask: string;
    testSelectors: string[];
    expectedSymbols: string[];
    sliceTestFiles: string[];
    javaHome: string;
    sliceTargetClass?: string;
    baselineFingerprints?: string[];
}
export interface RunOutcome {
    runId: string;
    result: ClassifierResult;
    command: string;
}
export declare function runTargetedTest(req: RunRequest, sh: ShellExec): Promise<RunOutcome>;
