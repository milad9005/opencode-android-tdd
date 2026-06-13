/**
 * Quality checks runner (SPEC-v2 §7 — tdd_quality). Runs the project's
 * configured Gradle quality tasks (detekt / ktlint / lint) via the injected
 * ShellExec and reports per-check pass/fail. Deterministic: exit code is the
 * verdict for a quality task (unlike the test classifier, a non-zero quality
 * task IS a real failure — these tasks do not have the JDK/RED ambiguity).
 *
 * Only tasks that exist for the module are run; unknown tasks are skipped, not
 * failed, so a project without detekt isn't penalized for not having it.
 */
import type { ShellExec } from "./runner.js";
export type QualityCheck = "detekt" | "ktlintCheck" | "lintDebug" | "ktlint" | "lint";
export interface QualityCheckResult {
    check: string;
    task: string;
    status: "pass" | "fail" | "skipped";
    detail: string;
}
export interface QualityResult {
    results: QualityCheckResult[];
    allPassed: boolean;
}
export interface QualityRequest {
    worktree: string;
    module: string;
    checks: string[];
    javaHome: string;
    /** task names known to exist for the module (from discovery); skip the rest */
    availableTasks?: string[];
}
export declare function runQuality(req: QualityRequest, sh: ShellExec): Promise<QualityResult>;
