// Validates the build-edit escape hatch (SPEC-v2 §5) and tdd_expand_scope using
// the REAL validator + createTools() surface against the real filesystem.
//   - validator: allowed categories vs each forbidden lever
//   - tdd_allow_build_edit: forbidden throws; allowed writes file + voids proofs
//   - tdd_expand_scope: widens slice, clears redProof, returns to TEST_WRITE

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateBuildEdit } from "../dist/gradle/buildedit.js";
import { StateStore } from "../dist/state/store.js";
import { Ledger } from "../dist/state/ledger.js";
import { PhaseMachine } from "../dist/machine.js";
import { createTools } from "../dist/tools.js";
import { hashFiles } from "../dist/gate/hash.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};
async function throwsAsync(fn) { try { await fn(); return false; } catch { return true; } }

// ---- validator unit cases ----
const V = (proposed, current = "") => validateBuildEdit({ filePath: "build.gradle.kts", current, proposed });
ok("allow: add test dependency", V(`dependencies {\n  testImplementation(libs.junit)\n}`).verdict === "ALLOWED");
ok("allow: enable robolectric test plugin", V(`plugins { id("org.robolectric") }`).verdict === "ALLOWED");
ok("forbid: enabled = false", V(`tasks.test { enabled = false }`).verdict === "FORBIDDEN");
ok("forbid: exclude", V(`testImplementation(libs.junit)\ntasks.test { exclude("**/*Slow*") }`).verdict === "FORBIDDEN");
ok("forbid: test filter", V(`tasks.test { filter { excludeTestsMatching("*") } }`).verdict === "FORBIDDEN");
ok("forbid: ignoreFailures", V(`tasks.test { ignoreFailures = true }`).verdict === "FORBIDDEN");
ok("forbid: sourceSets redirection", V(`sourceSets { test { java.srcDirs("nowhere") } }`).verdict === "FORBIDDEN");
ok("forbid: ksp/codegen rewiring", V(`dependencies { ksp(libs.hilt.compiler) }`).verdict === "FORBIDDEN");
ok("forbid: compiler suppression", V(`kotlin { freeCompilerArgs.add("-Xsuppress") }`).verdict === "FORBIDDEN");
ok("forbid: task-graph dependsOn", V(`tasks.test { dependsOn("somethingElse") }`).verdict === "FORBIDDEN");
ok("forbid: unrecognized change", V(`android { namespace = "x" }`).verdict === "FORBIDDEN");

// ---- tools end-to-end ----
const wt = mkdtempSync(join(tmpdir(), "tdd-be-"));
try {
  const testRel = "common/regex/src/test/java/co/vero/FooTest.kt";
  const mainRel = "common/regex/src/main/kotlin/co/vero/Foo.kt";
  const buildRel = "common/regex/build.gradle.kts";
  mkdirSync(join(wt, "common/regex/src/test/java/co/vero"), { recursive: true });
  mkdirSync(join(wt, "common/regex/src/main/kotlin/co/vero"), { recursive: true });
  writeFileSync(join(wt, testRel), "// test\n");
  writeFileSync(join(wt, mainRel), "// impl\n");
  writeFileSync(join(wt, buildRel), "plugins {\n}\n");

  const slice = {
    id: "s1", description: "foo", module: ":common:regex", sourceSet: "test", variant: "debug",
    testTask: "testDebugUnitTest", allowedTestFiles: [testRel], allowedProductionPaths: [mainRel],
    allowedSymbols: ["Foo"], expectedSymbols: ["Foo"], status: "active",
  };

  const store = new StateStore(wt);
  const ledger = new Ledger(wt);
  const machine = new PhaseMachine(store, ledger);
  const tools = createTools({
    worktree: wt, store, ledger, machine,
    shell: { async run() { return { exitCode: 0, stdout: "" }; } },
    doctorRunner: { async moduleTasks() { return ""; } },
    toolchainJavaHome: () => "/fake", toolchainId: () => "jdk-21",
  });
  const ctx = { sessionID: "p", messageID: "m", agent: "android-tdd", directory: wt, worktree: wt, abort: new AbortController().signal, metadata() {}, async ask() {} };

  // seed IMPL with a redProof
  store.acquireLock();
  let s = store.init({
    schemaVersion: 1, worktree: wt, workflowId: "wf1", stateVersion: 0, phase: "IMPL",
    slices: [slice], currentSliceId: "s1", activated: true, updatedAt: Date.now(),
    redProof: {
      workflowId: "wf1", sliceId: "s1", runId: "r1", module: ":common:regex", variant: "debug",
      testTask: "testDebugUnitTest", testSelectors: [], expectedSymbols: ["Foo"],
      classifier: "RED_MISSING_SYMBOL", failingTestIdentity: [],
      sliceTestFileHashes: hashFiles(wt, [testRel]), productionPreHashes: {}, buildConfigHash: "", toolchainId: "jdk-21", timestamp: Date.now(),
    },
  });
  store.releaseLock();
  ok("seeded IMPL with redProof", store.read().phase === "IMPL" && Boolean(store.read().redProof));

  // forbidden build edit throws, file unchanged
  ok("tdd_allow_build_edit FORBIDDEN throws", await throwsAsync(() =>
    tools.tdd_allow_build_edit.execute({ filePath: buildRel, proposedContent: "tasks.test { enabled = false }", reason: "cheat" }, ctx)));
  ok("forbidden edit did not write file", readFileSync(join(wt, buildRel), "utf8") === "plugins {\n}\n");
  ok("forbidden edit kept redProof", Boolean(store.read().redProof));

  // allowed build edit writes file + voids proofs + returns to TEST_WRITE
  const msg = await tools.tdd_allow_build_edit.execute({
    filePath: buildRel, proposedContent: "plugins {\n}\ndependencies {\n  testImplementation(libs.turbine)\n}\n", reason: "add turbine",
  }, ctx);
  ok("allowed edit wrote file", readFileSync(join(wt, buildRel), "utf8").includes("testImplementation(libs.turbine)"));
  ok("allowed edit voided redProof", !store.read().redProof, msg);
  ok("allowed edit returned to TEST_WRITE", store.read().phase === "TEST_WRITE");

  // expand_scope: re-seed IMPL, expand, expect cleared proof + TEST_WRITE
  store.acquireLock();
  let s2 = store.read();
  const d = structuredClone(s2);
  d.phase = "IMPL";
  d.redProof = { ...s2, ...{
    workflowId: "wf1", sliceId: "s1", runId: "r2", module: ":common:regex", variant: "debug",
    testTask: "testDebugUnitTest", testSelectors: [], expectedSymbols: ["Foo"], classifier: "RED_MISSING_SYMBOL",
    failingTestIdentity: [], sliceTestFileHashes: hashFiles(wt, [testRel]), productionPreHashes: {}, buildConfigHash: "", toolchainId: "jdk-21", timestamp: Date.now(),
  } };
  store.commit(s2.stateVersion, d);
  store.releaseLock();

  await tools.tdd_expand_scope.execute({ addProductionPaths: ["common/regex/src/main/kotlin/co/vero/Bar.kt"], addSymbols: ["Bar"], reason: "need Bar too" }, ctx);
  const after = store.read();
  ok("expand_scope added production path", after.slices[0].allowedProductionPaths.some((p) => p.includes("Bar.kt")));
  ok("expand_scope added symbol", after.slices[0].expectedSymbols.includes("Bar"));
  ok("expand_scope cleared redProof", !after.redProof);
  ok("expand_scope returned to TEST_WRITE", after.phase === "TEST_WRITE");
  ok("expand_scope rejects wildcard", await throwsAsync(() =>
    tools.tdd_expand_scope.execute({ addProductionPaths: ["src/main/**"], addSymbols: [], reason: "bad" }, ctx)));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
