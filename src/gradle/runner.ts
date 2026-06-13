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
import { classify, type ClassifierInput, type ClassifierResult } from "./classifier.js";
import { collectSuites } from "./junit.js";

export interface ShellResult {
  exitCode: number;
  stdout: string; // combined stdout+stderr
}

export interface ShellExec {
  /** run argv in cwd with extra env; never throws on non-zero exit. */
  run(cwd: string, argv: string[], env: Record<string, string>): Promise<ShellResult>;
}

export interface RunRequest {
  worktree: string;
  module: string; // gradle path, e.g. ":common:regex"
  testTask: string; // e.g. "testDebugUnitTest"
  testSelectors: string[]; // FQN or class#method patterns for --tests
  expectedSymbols: string[];
  sliceTestFiles: string[];
  javaHome: string;
}

export interface RunOutcome {
  runId: string;
  result: ClassifierResult;
  command: string;
}

function modulePathToDir(worktree: string, module: string): string {
  // ":common:regex" -> "<worktree>/common/regex"
  const rel = module.replace(/^:/, "").split(":").join("/");
  return join(worktree, rel);
}

function randomId(): string {
  return "run-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export async function runTargetedTest(req: RunRequest, sh: ShellExec): Promise<RunOutcome> {
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

  const input: ClassifierInput = {
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
