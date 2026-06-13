// Validates the plugin entry (src/index.ts) by invoking the REAL exported hooks
// against the real filesystem. Simulates opencode's PluginInput and the
// tool.execute.before / .after / chat.message / system.transform hook calls.
//
// Asserts the end-to-end wiring of the tested modules:
//   - bootstrap deny: write throws when no workflow / not activated
//   - read-only + tdd_* never throw
//   - subagent mutation throws even in a mutating phase
//   - ALLOW path acquires a gate lease; .after releases it
//   - a held lease blocks a second mutator (throws)
//   - system.transform banner reflects the current phase

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AndroidTddPlugin } from "../dist/index.js";
import { StateStore } from "../dist/state/store.js";
import { initialState } from "../dist/state/types.js";
import { hashFiles } from "../dist/gate/hash.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};
async function throwsAsync(fn) {
  try { await fn(); return false; } catch { return true; }
}

const wt = mkdtempSync(join(tmpdir(), "tdd-plugin-"));
try {
  const testFile = "common/regex/src/test/java/co/vero/FooTest.kt";
  const mainFile = "common/regex/src/main/kotlin/co/vero/Foo.kt";
  mkdirSync(join(wt, "common/regex/src/test/java/co/vero"), { recursive: true });
  mkdirSync(join(wt, "common/regex/src/main/kotlin/co/vero"), { recursive: true });
  writeFileSync(join(wt, testFile), "// test\n");
  writeFileSync(join(wt, mainFile), "// impl\n");

  // boot the plugin like opencode would
  const hooks = await AndroidTddPlugin({ worktree: wt, directory: wt });

  // Register the primary session as the TDD agent — the gate is intentionally
  // dormant for any session whose agent wasn't recorded via chat.message, so
  // without this every gate assertion below would no-op (read as "allowed").
  await hooks["chat.message"]({ sessionID: "primary", agent: "android-tdd" }, { message: {}, parts: [] });

  const before = (tool, callID, args, sessionID = "primary") =>
    hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
  const after = (tool, callID, args, sessionID = "primary") =>
    hooks["tool.execute.after"]({ tool, sessionID, callID, args }, { title: "", output: "", metadata: {} });
  const sysBanner = async () => {
    const out = { system: [] };
    await hooks["experimental.chat.system.transform"]({ model: {} }, out);
    return out.system.join("\n");
  };

  // --- bootstrap deny (no workflow) ---
  ok("write throws with no workflow", await throwsAsync(() => before("write", "c0", { filePath: testFile })));
  ok("read never throws", !(await throwsAsync(() => before("read", "c0", { filePath: testFile }))));
  ok("tdd_* never throws", !(await throwsAsync(() => before("tdd_run", "c0", {}))));
  ok("banner shows INACTIVE", (await sysBanner()).includes("INACTIVE"));

  // --- seed an activated workflow in TEST_WRITE with a slice ---
  const slice = {
    id: "s1", description: "foo validation", module: ":common:regex", sourceSet: "test",
    variant: "debug", testTask: "testDebugUnitTest",
    allowedTestFiles: [testFile], allowedProductionPaths: [mainFile],
    allowedSymbols: ["Foo"], expectedSymbols: ["Foo"], status: "active",
  };
  const seed = (mut) => {
    const store = new StateStore(wt);
    store.acquireLock();
    let s = store.exists() ? store.read() : store.init(initialState(wt, "wf1"));
    const draft = structuredClone(s);
    draft.activated = true; draft.slices = [slice]; draft.currentSliceId = "s1";
    mut(draft);
    store.commit(s.stateVersion, draft);
    store.releaseLock();
  };
  seed((d) => { d.phase = "TEST_WRITE"; });

  ok("banner reflects TEST_WRITE", (await sysBanner()).includes("phase TEST_WRITE"));

  // --- subagent mutation denied even in a mutating phase ---
  await hooks["chat.message"]({ sessionID: "sub1", agent: "tdd-inspector" }, { message: {}, parts: [] });
  ok("subagent write throws in TEST_WRITE", await throwsAsync(() => before("write", "cs", { filePath: testFile }, "sub1")));

  // --- ALLOW path acquires a lease; .after releases it ---
  ok("primary slice test write allowed (no throw)", !(await throwsAsync(() => before("write", "c1", { filePath: testFile }))));
  ok("lease acquired after ALLOW", Boolean(new StateStore(wt).read().activeLease));
  ok("second mutator blocked while lease held", await throwsAsync(() => before("edit", "c2", { filePath: testFile })));
  await after("write", "c1", { filePath: testFile });
  ok("lease released after .after", !new StateStore(wt).read().activeLease);

  // --- IMPL banner reflects redProof state ---
  seed((d) => {
    d.phase = "IMPL";
    d.redProof = {
      workflowId: "wf1", sliceId: "s1", runId: "r1", module: ":common:regex", variant: "debug",
      testTask: "testDebugUnitTest", testSelectors: [], expectedSymbols: ["Foo"],
      classifier: "RED_MISSING_SYMBOL", failingTestIdentity: [],
      sliceTestFileHashes: hashFiles(wt, [testFile]), productionPreHashes: {},
      buildConfigHash: "x", toolchainId: "jdk-21", timestamp: Date.now(),
    };
  });
  ok("IMPL prod write allowed with valid redProof", !(await throwsAsync(() => before("write", "c3", { filePath: mainFile }))));
  await after("write", "c3", { filePath: mainFile });
  ok("IMPL test edit denied (anti-cheat)", await throwsAsync(() => before("write", "c4", { filePath: testFile })));
  ok("banner mentions verified RED in IMPL", (await sysBanner()).includes("Verified RED"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
