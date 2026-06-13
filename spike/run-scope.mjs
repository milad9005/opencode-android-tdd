import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidTddPlugin } from "../src/index.ts";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "  " + x); } };
async function throwsAsync(fn) { try { await fn(); return false; } catch { return true; } }

const fakeShell = () => ({ cwd() { return this; }, env() { return this; }, quiet() { return this; }, nothrow() { return this; } });

// Isolate the GLOBAL agent install into a throwaway XDG_CONFIG_HOME so the spike
// never touches the real ~/.config/opencode.
const fakeXdg = mkdtempSync(join(tmpdir(), "tdd-scope-xdg-"));
const origXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = fakeXdg;
const globalAgentDir = join(fakeXdg, "opencode", "agent");

// --- agents install GLOBALLY (unconditionally), never into the project ---
const plain = mkdtempSync(join(tmpdir(), "tdd-scope-plain-"));
try {
  await AndroidTddPlugin({ worktree: plain, directory: plain, $: fakeShell });
  ok("plugin load: no project .opencode/agent written", !existsSync(join(plain, ".opencode/agent")));
  ok("plugin load: 4 agents installed globally", existsSync(globalAgentDir) && readdirSync(globalAgentDir).filter((f) => f.endsWith(".md")).length === 4);
} finally { rmSync(plain, { recursive: true, force: true }); }

// --- gate scoping: dormant for unrelated agents, active for the TDD family ---
const gradle = mkdtempSync(join(tmpdir(), "tdd-scope-gradle-"));
try {
  writeFileSync(join(gradle, "settings.gradle.kts"), "rootProject.name = \"x\"\n");
  mkdirSync(join(gradle, "src/main/kotlin"), { recursive: true });
  const mainFile = "src/main/kotlin/Foo.kt";
  writeFileSync(join(gradle, mainFile), "// impl\n");

  const hooks = await AndroidTddPlugin({ worktree: gradle, directory: gradle, $: fakeShell });

  const before = (tool, callID, args, sessionID) => hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
  const setAgent = (sessionID, agent) => hooks["chat.message"]({ sessionID, agent }, { message: {}, parts: [] });
  const sysBanner = async (sessionID) => { const o = { system: [] }; await hooks["experimental.chat.system.transform"]({ sessionID, model: {} }, o); return o.system.join("\n"); };

  // a DIFFERENT agent (e.g. the normal android architect) — gate must be DORMANT
  await setAgent("other", "some-other-agent");
  ok("non-TDD agent: write NOT blocked (gate dormant)", !(await throwsAsync(() => before("write", "c1", { filePath: mainFile }, "other"))));
  ok("non-TDD agent: no banner injected", (await sysBanner("other")) === "");

  // the TDD agent — gate must be ACTIVE (no workflow yet ⇒ write denied)
  await setAgent("tdd", "android-tdd");
  ok("TDD agent: write DENIED (bootstrap, no workflow)", await throwsAsync(() => before("write", "c2", { filePath: mainFile }, "tdd")));
  ok("TDD agent: banner injected", (await sysBanner("tdd")).includes("TDD gate"));

  // a TDD read-only SUBAGENT — gate must be ACTIVE and deny mutation
  await setAgent("sub", "tdd-inspector");
  ok("TDD subagent: write DENIED (subagents read-only)", await throwsAsync(() => before("write", "cs", { filePath: mainFile }, "sub")));
} finally { rmSync(gradle, { recursive: true, force: true }); }

// --- custom agent name via options ---
const g2 = mkdtempSync(join(tmpdir(), "tdd-scope-opt-"));
try {
  writeFileSync(join(g2, "build.gradle.kts"), "// root\n");
  mkdirSync(join(g2, "src/main"), { recursive: true });
  writeFileSync(join(g2, "src/main/Foo.kt"), "// x\n");
  const hooks = await AndroidTddPlugin({ worktree: g2, directory: g2, $: fakeShell }, { agent: "my-tdd" });
  const before = (tool, callID, args, sessionID) => hooks["tool.execute.before"]({ tool, sessionID, callID }, { args });
  await hooks["chat.message"]({ sessionID: "s", agent: "my-tdd" }, { message: {}, parts: [] });
  ok("custom agent name from options: gate active for 'my-tdd'", await throwsAsync(() => before("write", "c3", { filePath: "src/main/Foo.kt" }, "s")));
  await hooks["chat.message"]({ sessionID: "s2", agent: "android-tdd" }, { message: {}, parts: [] });
  ok("custom agent name: default 'android-tdd' now dormant", !(await throwsAsync(() => before("write", "c4", { filePath: "src/main/Foo.kt" }, "s2"))));
} finally { rmSync(g2, { recursive: true, force: true }); }

if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = origXdg;
rmSync(fakeXdg, { recursive: true, force: true });

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
