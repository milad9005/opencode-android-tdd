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
const RE_TASK_NOT_FOUND = /Task '[^']+' not found|Cannot locate tasks|not found in (project|root)/i;
export async function runQuality(req, sh) {
    const env = { JAVA_HOME: req.javaHome, PATH: `${req.javaHome}/bin:${process.env.PATH ?? ""}` };
    const results = [];
    for (const check of req.checks) {
        const task = `${req.module}:${check}`;
        if (req.availableTasks && !req.availableTasks.includes(check)) {
            results.push({ check, task, status: "skipped", detail: "task not available for module" });
            continue;
        }
        const res = await sh.run(req.worktree, ["./gradlew", task, "--console=plain"], env);
        if (res.exitCode === 0) {
            results.push({ check, task, status: "pass", detail: "BUILD SUCCESSFUL" });
        }
        else if (RE_TASK_NOT_FOUND.test(res.stdout)) {
            results.push({ check, task, status: "skipped", detail: "task not found" });
        }
        else {
            const firstFail = res.stdout.split(/\r?\n/).find((l) => /FAILED|>\s|error:|violation/i.test(l)) ?? "BUILD FAILED";
            results.push({ check, task, status: "fail", detail: firstFail.trim().slice(0, 200) });
        }
    }
    const allPassed = results.every((r) => r.status !== "fail");
    return { results, allPassed };
}
