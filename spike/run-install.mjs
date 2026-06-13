// Validates agent copy-on-init (src/install.ts) against the real filesystem using
// the compiled dist/ module. Covers SPEC-v2 §9 safety guarantees:
//   - writes all bundled agents when absent
//   - idempotent: a second run keeps them current (no churn)
//   - never overwrites a user-modified agent file
//   - refreshes a plugin-owned (unchanged-by-user) file when the bundle changes

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installAgents, resolveBundledAgentsDir } from "../dist/install.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};

const AGENTS = ["android-tdd", "tdd-context", "tdd-inspector", "tdd-regression"];

// resolve the REAL bundled agents dir from the compiled install module
const bundled = resolveBundledAgentsDir(new URL("../dist/install.js", import.meta.url).href);
ok("resolved bundled agents dir", Boolean(bundled), String(bundled));

const wt = mkdtempSync(join(tmpdir(), "tdd-install-"));
try {
  const agentDir = join(wt, ".opencode", "agent");

  // 1) fresh install writes all four
  const r1 = installAgents(wt, bundled);
  ok("fresh install wrote all 4", r1.filter((r) => r.action === "written").length === 4);
  ok("all agent files exist", AGENTS.every((a) => existsSync(join(agentDir, `${a}.md`))));

  // 2) idempotent: second run keeps current, no rewrite churn
  const r2 = installAgents(wt, bundled);
  ok("second run keeps all current", r2.every((r) => r.action === "kept-current"));

  // 3) user modifies one agent -> never overwritten
  const userPath = join(agentDir, "android-tdd.md");
  writeFileSync(userPath, "# my custom orchestrator\n");
  const r3 = installAgents(wt, bundled);
  const orchestrator = r3.find((r) => r.agent === "android-tdd");
  ok("user-modified agent kept", orchestrator?.action === "kept-user-modified");
  ok("user content preserved", readFileSync(userPath, "utf8") === "# my custom orchestrator\n");
  ok("other agents still current", r3.filter((r) => r.agent !== "android-tdd").every((r) => r.action === "kept-current"));

  // 4) plugin-owned (unchanged-by-user) refresh when bundle "changes":
  //    simulate a version bump by editing the manifest hash for one untouched
  //    agent so it no longer matches the on-disk file's recorded hash... instead,
  //    we simulate the inverse: edit the on-disk file back to a DIFFERENT content
  //    but record it as plugin-written via a clean reinstall, then bump bundle.
  // Simpler real check: a clean dir, install, then overwrite an agent with stale
  // plugin-written content recorded in manifest, then reinstall -> refreshed.
  const wt2 = mkdtempSync(join(tmpdir(), "tdd-install2-"));
  try {
    const agentDir2 = join(wt2, ".opencode", "agent");
    const stateDir2 = join(wt2, ".opencode", "android-tdd");
    mkdirSync(agentDir2, { recursive: true });
    mkdirSync(stateDir2, { recursive: true });
    // pretend we previously wrote an OLD version of tdd-context whose hash we record
    const oldContent = "# old plugin version\n";
    writeFileSync(join(agentDir2, "tdd-context.md"), oldContent);
    // compute its hash the same way install.ts does (sha256 prefix)
    const { createHash } = await import("node:crypto");
    const oldHash = "sha256:" + createHash("sha256").update(oldContent).digest("hex");
    writeFileSync(join(stateDir2, "agents.manifest.json"), JSON.stringify({ written: { "tdd-context": oldHash } }, null, 2));

    const r4 = installAgents(wt2, bundled);
    const ctx = r4.find((r) => r.agent === "tdd-context");
    ok("plugin-owned unchanged file refreshed on bundle change", ctx?.action === "refreshed");
    ok("refreshed content matches bundle", readFileSync(join(agentDir2, "tdd-context.md"), "utf8") === readFileSync(join(bundled, "tdd-context.md"), "utf8"));
  } finally {
    rmSync(wt2, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
