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
import { join } from "node:path";
import { classify } from "./classifier.js";
import { collectSuites } from "./junit.js";
function modulePathToDir(worktree, module) {
    // ":common:regex" -> "<worktree>/common/regex"
    const rel = module.replace(/^:/, "").split(":").join("/");
    return join(worktree, rel);
}
function randomId() {
    return "run-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
export async function runTargetedTest(req, sh) {
    const argv = [
        "./gradlew",
        `${req.module}:${req.testTask}`,
        "--rerun-tasks",
        "--console=plain",
        ...req.testSelectors.flatMap((t) => ["--tests", t]),
    ];
    const env = { JAVA_HOME: req.javaHome, PATH: `${req.javaHome}/bin:${process.env.PATH ?? ""}` };
    const runStartedMs = Date.now();
    const sh_result = await sh.run(req.worktree, argv, env);
    const moduleDir = modulePathToDir(req.worktree, req.module);
    const suites = collectSuites(moduleDir, req.testTask);
    const input = {
        exitCode: sh_result.exitCode,
        stdout: sh_result.stdout,
        suites,
        runStartedMs,
        expectedSymbols: req.expectedSymbols,
        sliceTestFiles: req.sliceTestFiles,
    };
    return {
        runId: randomId(),
        result: classify(input),
        command: argv.join(" "),
    };
}
