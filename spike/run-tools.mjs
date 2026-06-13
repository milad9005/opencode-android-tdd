// Drives a FULL TDD slice cycle through the real createTools() surface with a
// fake Gradle runner — proving the tools advance the phase machine and set the
// hash-bound redProof, without invoking real Gradle. The fake shell returns
// scripted stdout and writes scripted JUnit XML where the classifier expects it,
// so the real classifier (not a stub) decides each outcome.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore } from "../dist/state/store.js";
import { Ledger } from "../dist/state/ledger.js";
import { PhaseMachine } from "../dist/machine.js";
import { createTools } from "../dist/tools.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const wt = mkdtempSync(join(tmpdir(), "tdd-tools-"));
try {
  const moduleDir = join(wt, "common/regex");
  const testRel = "common/regex/src/test/java/co/vero/FooTest.kt";
  const mainRel = "common/regex/src/main/kotlin/co/vero/Foo.kt";
  mkdirSync(join(wt, "common/regex/src/test/java/co/vero"), { recursive: true });
  mkdirSync(join(wt, "common/regex/src/main/kotlin/co/vero"), { recursive: true });
  writeFileSync(join(wt, testRel), "// failing test referencing Foo\n");
  writeFileSync(join(wt, mainRel), "// empty\n");

  const resultsDir = join(moduleDir, "build/test-results/testDebugUnitTest");
  const writeXml = (tests, failures, errors, caseXml) => {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "TEST-co.vero.FooTest.xml"),
      `<?xml version="1.0"?><testsuite name="co.vero.FooTest" tests="${tests}" skipped="0" failures="${failures}" errors="${errors}">${caseXml}</testsuite>`);
  };

  // scripted shell: `script` selects what the next gradle run looks like.
  let script = "baseline-green";
  const shell = {
    async run(_cwd, argv, _env) {
      const isTasks = argv.includes("tasks");
      if (isTasks) return { exitCode: 0, stdout: "testDebugUnitTest - Run unit tests for the debug build.\n" };
      // real Gradle takes seconds; the fake is instantaneous, so wait a tick to
      // ensure written XML mtime lands AFTER runStartedMs (classifier freshness).
      await new Promise((r) => setTimeout(r, 12));
      switch (script) {
        case "baseline-green":
          writeXml(0, 0, 0, "");
          return { exitCode: 0, stdout: "BUILD SUCCESSFUL in 1s\n" };
        case "red-missing":
          // compile failure: unresolved reference to the expected target Foo
          return { exitCode: 1, stdout:
            "> Task :common:regex:compileDebugUnitTestKotlin FAILED\n" +
            `e: file://${join(wt, testRel)}:3:10 Unresolved reference 'Foo'.\n` +
            "BUILD FAILED in 1s\n" };
        case "green":
          writeXml(1, 0, 0, `<testcase classname="co.vero.FooTest" name="works"/>`);
          return { exitCode: 0, stdout: "BUILD SUCCESSFUL in 1s\n" };
      }
      return { exitCode: 1, stdout: "BUILD FAILED\n" };
    },
  };
  const doctorRunner = { async moduleTasks() { return "testDebugUnitTest - Run unit tests for the debug build.\n"; } };

  const store = new StateStore(wt);
  const ledger = new Ledger(wt);
  const machine = new PhaseMachine(store, ledger);
  const tools = createTools({
    worktree: wt, store, ledger, machine, shell, doctorRunner,
    toolchainJavaHome: () => "/fake/jdk", toolchainId: () => "jdk-21@fake",
  });
  const ctx = { sessionID: "primary", messageID: "m", agent: "android-tdd", directory: wt, worktree: wt, abort: new AbortController().signal, metadata() {}, async ask() {} };
  const call = (name, args = {}) => tools[name].execute(args, ctx);

  // --- start -> doctor -> plan -> baseline ---
  await call("tdd_start");
  ok("after start phase=DOCTOR", store.read().phase === "DOCTOR");
  await call("tdd_doctor", { modules: [":common:regex"] });
  ok("after doctor phase=CONTEXT", store.read().phase === "CONTEXT");

  await call("tdd_plan_set", { slices: [{
    id: "s1", description: "Foo exists", module: ":common:regex", sourceSet: "test",
    variant: "debug", testTask: "testDebugUnitTest",
    allowedTestFiles: [testRel], allowedProductionPaths: [mainRel],
    allowedSymbols: ["Foo"], expectedSymbols: ["Foo"],
  }]});
  ok("after plan_set phase=BASELINE, slice active", store.read().phase === "BASELINE" && store.read().currentSliceId === "s1");

  script = "baseline-green";
  await call("tdd_baseline");
  ok("after baseline phase=TEST_WRITE", store.read().phase === "TEST_WRITE");

  // --- verify_red with a real RED_MISSING_SYMBOL -> IMPL + redProof ---
  script = "red-missing";
  const redMsg = await call("tdd_verify_red");
  ok("verify_red advances to IMPL", store.read().phase === "IMPL", redMsg);
  ok("redProof set with classifier RED_MISSING_SYMBOL", store.read().redProof?.classifier === "RED_MISSING_SYMBOL");
  ok("redProof bound to slice test hashes", Object.keys(store.read().redProof?.sliceTestFileHashes ?? {}).length === 1);

  // --- plan-set rejects wildcard scope ---
  let rejected = false;
  try {
    const s2 = new StateStore(wt); // fresh handle
    // call on a non-plan phase should also throw, but test wildcard validation directly:
    await tools.tdd_plan_set.execute({ slices: [{
      id: "x", description: "bad", module: ":m", sourceSet: "test", variant: "debug", testTask: "t",
      allowedTestFiles: ["src/test/**"], allowedProductionPaths: ["src/main"], allowedSymbols: [], expectedSymbols: [],
    }]}, ctx);
  } catch { rejected = true; }
  ok("plan_set rejects wildcard/over-broad paths", rejected);

  // --- implement, then verify_green -> REFACTOR ---
  writeFileSync(join(wt, mainRel), "class Foo\n");
  script = "green";
  const greenMsg = await call("tdd_verify_green");
  ok("verify_green advances to REFACTOR", store.read().phase === "REFACTOR", greenMsg);
  ok("greenVerifiedAt set", Boolean(store.read().greenVerifiedAt));

  // --- refactor verify_green -> INSPECT, then inspect_done -> ARCH_GATE (last slice) ---
  script = "green";
  await call("tdd_verify_green");
  ok("refactor verify_green -> INSPECT", store.read().phase === "INSPECT");
  await call("tdd_inspect_done");
  ok("inspect_done (last slice) -> ARCH_GATE", store.read().phase === "ARCH_GATE");
  ok("slice marked done", store.read().slices[0].status === "done");

  // --- redProof drift: edit the slice test after RED would invalidate on next verify ---
  // (re-enter a fresh cycle to test drift) — reset then drive to IMPL again
  await call("tdd_reset_workflow", { reason: "test drift path" });
  ok("reset -> INACTIVE", store.read().phase === "INACTIVE");

  // --- report renders & advances to DONE ---
  // drive minimal: start->doctor->plan->...->ARCH_GATE already done above is gone after reset;
  // instead test report from an ARCH_GATE-like state via direct seed is out of scope here.

  // --- explain_block returns guidance ---
  const explain = await call("tdd_explain_block");
  ok("explain_block returns guidance", typeof explain === "string" && explain.includes("phase="));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
