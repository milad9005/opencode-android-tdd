/**
 * tdd_doctor orchestration: combine JDK toolchain discovery with per-module
 * Gradle discovery into a single SUPPORTED/UNSUPPORTED verdict that gates the
 * whole workflow. A project is workable only if a real JDK exists AND at least
 * one target module exposes a supported unit-test task.
 *
 * Gradle execution is injected (GradleRunner) so the decision logic is pure and
 * testable against captured stdout fixtures.
 */

import { discoverToolchain, type ToolchainResult } from "./gradle/toolchain.js";
import { discoverModule, type ModuleModel } from "./gradle/discover.js";

export interface GradleRunner {
  /** run `:module:tasks --all`; return stdout (combined) */
  moduleTasks(modulePath: string): Promise<string>;
}

export type DoctorVerdict = "READY" | "UNSUPPORTED" | "NO_TOOLCHAIN";

export interface DoctorReport {
  verdict: DoctorVerdict;
  toolchain: ToolchainResult;
  modules: ModuleModel[];
  supportedModules: string[];
  message: string;
}

function renderMessage(report: Omit<DoctorReport, "message">): string {
  if (report.verdict === "NO_TOOLCHAIN") {
    return `tdd_doctor: NO_TOOLCHAIN. ${report.toolchain.reason}`;
  }
  if (report.verdict === "UNSUPPORTED") {
    const lines = report.modules
      .filter((m) => m.status === "UNSUPPORTED")
      .map((m) => `  ${m.path}: ${m.unsupported?.code} — ${m.unsupported?.detail}`);
    return [
      "tdd_doctor: UNSUPPORTED. No target module is in v1 scope.",
      ...lines,
    ].join("\n");
  }
  const jdk = report.toolchain.toolchain;
  return [
    `tdd_doctor: READY.`,
    `  JDK: ${jdk?.version} (${jdk?.javaHome})`,
    `  supported modules: ${report.supportedModules.join(", ")}`,
  ].join("\n");
}

export async function runDoctor(
  modulePaths: string[],
  runner: GradleRunner,
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorReport> {
  const toolchain = discoverToolchain(env);
  if (!toolchain.ok) {
    const base = { verdict: "NO_TOOLCHAIN" as const, toolchain, modules: [], supportedModules: [] };
    return { ...base, message: renderMessage(base) };
  }

  const modules: ModuleModel[] = [];
  for (const path of modulePaths) {
    const tasksStdout = await runner.moduleTasks(path);
    modules.push(discoverModule({ path, tasksStdout }));
  }

  const supportedModules = modules.filter((m) => m.status === "SUPPORTED").map((m) => m.path);
  const verdict: DoctorVerdict = supportedModules.length > 0 ? "READY" : "UNSUPPORTED";
  const base = { verdict, toolchain, modules, supportedModules };
  return { ...base, message: renderMessage(base) };
}
