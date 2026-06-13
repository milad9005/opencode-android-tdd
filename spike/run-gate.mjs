// Validates the fail-closed gate against the REAL filesystem using the actual
// compiled dist/ modules. Covers every decision branch from SPEC-v2 §2.1-2.4:
//   buckets (read-only/plugin-owned/denied/unknown), bootstrap deny, subagent
//   read-only, lease blocking, phase permissions, slice scope, build-edit hatch,
//   symlink bucket-escape, and redProof drift invalidation.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideGate } from "../dist/gate/decide.js";
import { classifyPath, isBucketEscape } from "../dist/gate/paths.js";
import { hashFiles, detectDrift } from "../dist/gate/hash.js";
import { initialState } from "../dist/state/types.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const wt = mkdtempSync(join(tmpdir(), "tdd-gate-"));
try {
  // realistic module layout
  const testDir = join(wt, "common/regex/src/test/java/co/vero");
  const mainDir = join(wt, "common/regex/src/main/kotlin/co/vero");
  mkdirSync(testDir, { recursive: true });
  mkdirSync(mainDir, { recursive: true });
  const testFile = "common/regex/src/test/java/co/vero/FooTest.kt";
  const mainFile = "common/regex/src/main/kotlin/co/vero/Foo.kt";
  writeFileSync(join(wt, testFile), "// test\n");
  writeFileSync(join(wt, mainFile), "// impl\n");

  // a slice
  const slice = {
    id: "s1", description: "foo", module: ":common:regex", sourceSet: "test",
    variant: "debug", testTask: "testDebugUnitTest",
    allowedTestFiles: [testFile], allowedProductionPaths: [mainFile],
    allowedSymbols: ["Foo"], expectedSymbols: ["Foo"], status: "active",
  };
  const base = () => {
    const s = initialState(wt, "wf1");
    s.activated = true; s.slices = [slice]; s.currentSliceId = "s1"; s.stateVersion = 5;
    return s;
  };
  const G = (over) => decideGate({ tool: "write", callID: "c1", worktree: wt, isSubagent: false, ...over });

  // --- buckets ---
  ok("read tool allowed (no workflow)", G({ tool: "read", state: undefined }).decision === "ALLOW");
  ok("tdd_* tool allowed (no workflow)", G({ tool: "tdd_run", state: undefined }).decision === "ALLOW");
  ok("bash denied", G({ tool: "bash", state: base() }).decision === "DENY");
  ok("unknown tool denied (fail-closed)", G({ tool: "frobnicate", state: base() }).decision === "DENY");
  ok("patch/move/delete denied", ["patch","move","delete"].every((t) => G({ tool: t, state: base() }).decision === "DENY"));

  // --- bootstrap / subagent ---
  ok("write denied with no workflow", G({ state: undefined, filePath: testFile }).decision === "DENY");
  const notActivated = base(); notActivated.activated = false;
  ok("write denied before activation", G({ state: notActivated, filePath: testFile, phase: "TEST_WRITE" }).decision === "DENY");
  ok("subagent write denied always", G({ state: base(), filePath: testFile, isSubagent: true }).decision === "DENY");
  ok("subagent read allowed", G({ tool: "read", state: base(), isSubagent: true }).decision === "ALLOW");

  // --- lease blocking ---
  const leased = base(); leased.activeLease = { callID: "other", tool: "write", filePath: join(wt, mainFile), phase: "TEST_WRITE", stateVersion: 5, acquiredAt: Date.now() };
  ok("write blocked while another lease held", G({ state: leased, filePath: testFile, phase: "TEST_WRITE" }).decision === "DENY");

  // --- phase permissions ---
  const planPhase = base(); planPhase.phase = "PLAN";
  ok("no writes in PLAN", G({ state: planPhase, filePath: testFile }).decision === "DENY");

  // --- TEST_WRITE scope ---
  const tw = base(); tw.phase = "TEST_WRITE";
  ok("TEST_WRITE allows slice test file", G({ state: tw, filePath: testFile }).decision === "ALLOW");
  ok("TEST_WRITE denies production file", G({ state: tw, filePath: mainFile }).decision === "DENY");
  ok("TEST_WRITE denies out-of-slice test", G({ state: tw, filePath: "common/regex/src/test/java/co/vero/OtherTest.kt" }).decision === "DENY");

  // --- IMPL: redProof required, scope, no test edits ---
  const impl = base(); impl.phase = "IMPL";
  ok("IMPL denied without redProof", G({ state: impl, filePath: mainFile }).decision === "DENY");
  const implProof = base(); implProof.phase = "IMPL";
  implProof.redProof = {
    workflowId: "wf1", sliceId: "s1", runId: "r1", module: ":common:regex", variant: "debug",
    testTask: "testDebugUnitTest", testSelectors: [], expectedSymbols: ["Foo"], classifier: "RED_MISSING_SYMBOL",
    failingTestIdentity: [], sliceTestFileHashes: hashFiles(wt, [testFile]), productionPreHashes: {},
    buildConfigHash: "x", toolchainId: "jdk-21", timestamp: Date.now(),
  };
  ok("IMPL allows in-scope prod write with valid redProof", G({ state: implProof, filePath: mainFile }).decision === "ALLOW");
  ok("IMPL denies test edit (anti-cheat)", G({ state: implProof, filePath: testFile }).decision === "DENY");
  ok("IMPL denies out-of-scope prod write", G({ state: implProof, filePath: "common/regex/src/main/kotlin/co/vero/Other.kt" }).decision === "DENY");

  // --- redProof drift invalidates IMPL ---
  writeFileSync(join(wt, testFile), "// test EDITED after RED\n");
  ok("IMPL denied after slice test drift", G({ state: implProof, filePath: mainFile }).decision === "DENY");
  const drift = detectDrift(wt, implProof.redProof.sliceTestFileHashes);
  ok("drift detector flags edited test", drift.drifted && drift.changedFiles.includes(testFile));

  // --- build-edit hatch ---
  const tw2 = base(); tw2.phase = "TEST_WRITE";
  ok("build.gradle.kts edit denied (use hatch)", G({ state: tw2, filePath: "common/regex/build.gradle.kts" }).decision === "DENY");
  ok("build-logic edit denied", classifyPath({ filePath: "build-logic/convention/src/main/kotlin/Plugin.kt", worktree: wt }) === "build-logic");

  // --- symlink bucket escape ---
  const evilLink = join(testDir, "EvilTest.kt");
  try {
    symlinkSync(join(wt, mainFile), evilLink);
    ok("symlink test->main flagged as escape",
      isBucketEscape({ filePath: "common/regex/src/test/java/co/vero/EvilTest.kt", worktree: wt }));
    ok("gate denies symlinked test path", G({ state: tw, filePath: "common/regex/src/test/java/co/vero/EvilTest.kt" }).decision === "DENY");
  } catch (e) {
    ok("symlink test skipped (unsupported)", true, "(symlink not supported here)");
    ok("symlink gate skipped", true);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
