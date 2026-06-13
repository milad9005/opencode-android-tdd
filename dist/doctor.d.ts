/**
 * tdd_doctor orchestration: combine JDK toolchain discovery with per-module
 * Gradle discovery into a single SUPPORTED/UNSUPPORTED verdict that gates the
 * whole workflow. A project is workable only if a real JDK exists AND at least
 * one target module exposes a supported unit-test task.
 *
 * Gradle execution is injected (GradleRunner) so the decision logic is pure and
 * testable against captured stdout fixtures.
 */
import { type ToolchainResult } from "./gradle/toolchain.js";
import { type ModuleModel } from "./gradle/discover.js";
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
export declare function runDoctor(modulePaths: string[], runner: GradleRunner, env?: Record<string, string | undefined>): Promise<DoctorReport>;
