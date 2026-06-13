// END-TO-END: drive ONE real TDD slice through the live plugin tools against the
// REAL VeroAndroid :common:regex module with REAL Gradle (JBR toolchain).
//
// Slice: introduce `EmailRegexProvider` (a new production symbol).
//   1. write a failing test that references it     -> tdd_verify_red => RED_MISSING_SYMBOL
//   2. implement the minimum class                 -> tdd_verify_green => GREEN
//
// SAFETY: all writes go into temp files under the module's test/main source sets
// and are deleted in `finally`; we assert the git tree is unchanged at the end.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { StateStore } from "../dist/state/store.js";
import { Ledger } from "../dist/state/ledger.js";
import { PhaseMachine } from "../dist/machine.js";
import { createTools } from "../dist/tools.js";
import { discoverToolchain } from "../dist/gradle/toolchain.js";

const VERO = "/home/milad/StudioProjects/VeroAndroid";
const TEST_REL = "common/regex/src/test/java/co/vero/common/regex/domain/ZzE2EEmailTest.kt";
const MAIN_REL = "common/regex/src/main/kotlin/co/vero/common/regex/domain/EmailRegexProvider.kt";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const tc = discoverToolchain(process.env);
ok("toolchain resolved (real JDK)", tc.ok, tc.reason ?? "");
if (!tc.ok) { console.log("\nABORT: no JDK\n"); process.exit(1); }
const javaHome = tc.toolchain.javaHome;

// real $-style shell over execFileSync; nothrow; combined stdout+stderr
const shell = {
  async run(cwd, argv, env) {
    const [cmd, ...rest] = argv;
    try {
      const out = execFileSync(cmd, rest, {
        cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env }, timeout: 900000,
      });
      return { exitCode: 0, stdout: out };
    } catch (e) {
      return { exitCode: e.status ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  },
};
const doctorRunner = {
  async moduleTasks(modulePath) {
    const r = await shell.run(VERO, ["./gradlew", `${modulePath}:tasks`, "--all", "--console=plain"],
      { JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH}` });
    return r.stdout;
  },
};

// state under a temp .opencode inside VERO that we fully remove afterward
const stateRoot = join(VERO, ".opencode-e2e-tmp");
const store = new StateStore(stateRoot);
const ledger = new Ledger(stateRoot);
const machine = new PhaseMachine(store, ledger);
const tools = createTools({
  worktree: VERO, store, ledger, machine, shell, doctorRunner,
  toolchainJavaHome: () => javaHome, toolchainId: () => tc.toolchain.toolchainId,
});
const ctx = { sessionID: "e2e", messageID: "m", agent: "android-tdd", directory: VERO, worktree: VERO, abort: new AbortController().signal, metadata() {}, async ask() {} };
const call = (n, a = {}) => tools[n].execute(a, ctx);

const cleanup = () => {
  for (const rel of [TEST_REL, MAIN_REL]) rmSync(join(VERO, rel), { force: true });
  rmSync(stateRoot, { recursive: true, force: true });
};

try {
  await call("tdd_start");
  const doc = await call("tdd_doctor", { modules: [":common:regex"] });
  ok("doctor READY", store.read().phase === "CONTEXT", doc);

  await call("tdd_plan_set", { slices: [{
    id: "email", description: "EmailRegexProvider exists with emailRegex",
    module: ":common:regex", sourceSet: "test", variant: "debug", testTask: "testDebugUnitTest",
    allowedTestFiles: [TEST_REL], allowedProductionPaths: [MAIN_REL],
    allowedSymbols: ["EmailRegexProvider"], expectedSymbols: ["EmailRegexProvider"],
  }]});
  ok("plan set, phase BASELINE", store.read().phase === "BASELINE");

  console.log("  … running real baseline (gradle)…");
  await call("tdd_baseline");
  ok("baseline done, phase TEST_WRITE", store.read().phase === "TEST_WRITE");

  // write the failing test (references the not-yet-existing target)
  mkdirSync(join(VERO, TEST_REL, ".."), { recursive: true });
  writeFileSync(join(VERO, TEST_REL),
`package co.vero.common.regex.domain

import org.junit.Assert.assertTrue
import org.junit.Test

class ZzE2EEmailTest {
    @Test
    fun \`email regex matches a basic address\`() {
        val provider = EmailRegexProvider()
        assertTrue(provider.emailRegex.matches("a@b.com"))
    }
}
`);

  console.log("  … running real verify_red (gradle compile expected to fail)…");
  const redMsg = await call("tdd_verify_red");
  ok("verify_red => RED_MISSING_SYMBOL, phase IMPL", store.read().phase === "IMPL" && store.read().redProof?.classifier === "RED_MISSING_SYMBOL", redMsg);

  // implement the minimum production code
  writeFileSync(join(VERO, MAIN_REL),
`package co.vero.common.regex.domain

class EmailRegexProvider {
    val emailRegex: Regex = Regex("^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$")
}
`);

  console.log("  … running real verify_green (gradle test expected to pass)…");
  const greenMsg = await call("tdd_verify_green");
  ok("verify_green => GREEN, phase REFACTOR", store.read().phase === "REFACTOR" && Boolean(store.read().greenVerifiedAt), greenMsg);

  // ledger captured the real cycle
  const types = ledger.readAll().map((e) => e.type);
  ok("ledger has RED_VERIFIED + GREEN_VERIFIED", types.includes("RED_VERIFIED") && types.includes("GREEN_VERIFIED"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
} finally {
  cleanup();
  // assert VeroAndroid tracked tree is unchanged (ignore untracked noise)
  const status = execFileSync("git", ["status", "--porcelain", "common/regex"], { cwd: VERO, encoding: "utf8" })
    .split("\n").filter((l) => l && !l.startsWith("??"));
  if (status.length === 0) console.log("VERO tree clean (no tracked changes from E2E).");
  else { console.log("WARNING — residual tracked changes:\n" + status.join("\n")); }
}
process.exit(fail === 0 ? 0 : 1);
