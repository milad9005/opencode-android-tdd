// Validates the quality runner (src/gradle/quality.ts) with a fake shell:
// pass (exit 0), fail (exit 1 with violation), skipped (task-not-found or not in
// availableTasks). Uses the real runQuality from dist/.

import { runQuality } from "../dist/gradle/quality.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

// scripted fake shell keyed on the task argument
const makeShell = (script) => ({
  async run(_cwd, argv, _env) {
    const task = argv.find((a) => a.includes(":")) ?? "";
    const check = task.split(":").pop();
    return script[check] ?? { exitCode: 0, stdout: "BUILD SUCCESSFUL\n" };
  },
});

const req = (checks, availableTasks) => ({
  worktree: "/wt", module: ":common:regex", checks, javaHome: "/jdk", availableTasks,
});

// all pass
let r = await runQuality(req(["detekt", "ktlintCheck"]), makeShell({
  detekt: { exitCode: 0, stdout: "BUILD SUCCESSFUL\n" },
  ktlintCheck: { exitCode: 0, stdout: "BUILD SUCCESSFUL\n" },
}));
ok("all pass => allPassed true", r.allPassed && r.results.every((x) => x.status === "pass"));

// one fails
r = await runQuality(req(["detekt", "ktlintCheck"]), makeShell({
  detekt: { exitCode: 0, stdout: "BUILD SUCCESSFUL\n" },
  ktlintCheck: { exitCode: 1, stdout: "> Task :common:regex:ktlintCheck FAILED\nktlint violation: foo.kt:1:1\nBUILD FAILED\n" },
}));
ok("one fail => allPassed false", !r.allPassed);
ok("failing check marked fail", r.results.find((x) => x.check === "ktlintCheck")?.status === "fail");
ok("passing check still pass", r.results.find((x) => x.check === "detekt")?.status === "pass");

// task not found => skipped (not fail)
r = await runQuality(req(["detekt"]), makeShell({
  detekt: { exitCode: 1, stdout: "Task 'detekt' not found in project ':common:regex'.\n" },
}));
ok("task-not-found => skipped", r.results[0].status === "skipped");
ok("skipped does not fail overall", r.allPassed);

// availableTasks filter => skip checks not present
r = await runQuality(req(["detekt", "lintDebug"], ["lintDebug"]), makeShell({
  lintDebug: { exitCode: 0, stdout: "BUILD SUCCESSFUL\n" },
}));
ok("unavailable check skipped via availableTasks", r.results.find((x) => x.check === "detekt")?.status === "skipped");
ok("available check ran", r.results.find((x) => x.check === "lintDebug")?.status === "pass");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
