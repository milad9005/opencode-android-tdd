/**
 * Agent copy-on-init (SPEC-v2 §9 / Major #39).
 *
 * Plugins cannot register agents, so the package bundles four agent `.md` files
 * and the plugin writes them into `.opencode/agent/` on init. This MUST be safe:
 *  - idempotent: re-running never thrashes,
 *  - never overwrites a user's edits,
 *  - refreshes only files this plugin wrote and the user has not since changed.
 *
 * Provenance is tracked by a manifest of content hashes we last wrote. On init,
 * for each bundled agent:
 *   - absent on disk          -> write it,
 *   - on disk == our manifest -> plugin-owned & unchanged -> refresh if bundled
 *                                content changed (version bump), else leave,
 *   - on disk != our manifest -> user-modified -> LEAVE IT, log a notice.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the plugin's agent identities. The gate (index.ts)
// activates for this whole family — primary + read-only subagents — so its
// subagent-read-only invariant is reachable as defense-in-depth, while staying
// dormant for every unrelated agent. install + gate share this list.
export const TDD_PRIMARY_AGENT = "android-tdd";
export const TDD_READONLY_SUBAGENTS = ["tdd-context", "tdd-inspector", "tdd-regression"] as const;
const AGENT_NAMES = [TDD_PRIMARY_AGENT, ...TDD_READONLY_SUBAGENTS];

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config"), "opencode");
}

function sha256(s: string): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

/**
 * Locate the bundled agent `.md` directory. Works in dev (src/agents next to
 * src/install.ts) and when published (dist/agents next to dist/install.js).
 */
export function resolveBundledAgentsDir(moduleUrl: string): string | undefined {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(here, "agents"),
    join(here, "..", "agents"),
    join(here, "..", "src", "agents"),
    join(here, "..", "dist", "agents"),
  ];
  return candidates.find((c) => existsSync(c) && readdirSync(c).some((f) => f.endsWith(".md")));
}

export type InstallAction = "written" | "refreshed" | "kept-user-modified" | "kept-current";

export interface InstallResult {
  agent: string;
  action: InstallAction;
}

interface Manifest {
  // agent name -> hash of the content we last wrote
  written: Record<string, string>;
}

export function installAgents(
  agentDir: string,
  manifestPath: string,
  bundledDir: string,
): InstallResult[] {
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  if (!existsSync(dirname(manifestPath))) mkdirSync(dirname(manifestPath), { recursive: true });

  const manifest: Manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest)
    : { written: {} };

  const results: InstallResult[] = [];

  for (const name of AGENT_NAMES) {
    const bundledPath = join(bundledDir, `${name}.md`);
    if (!existsSync(bundledPath)) continue;
    const bundled = readFileSync(bundledPath, "utf8");
    const bundledHash = sha256(bundled);
    const destPath = join(agentDir, `${name}.md`);
    const lastWritten = manifest.written[name];

    if (!existsSync(destPath)) {
      writeFileSync(destPath, bundled);
      manifest.written[name] = bundledHash;
      results.push({ agent: name, action: "written" });
      continue;
    }

    const onDisk = readFileSync(destPath, "utf8");
    const onDiskHash = sha256(onDisk);

    if (onDiskHash === bundledHash) {
      manifest.written[name] = bundledHash;
      results.push({ agent: name, action: "kept-current" });
      continue;
    }

    // on disk differs from bundled. Was it our last write (plugin-owned)?
    if (lastWritten !== undefined && onDiskHash === lastWritten) {
      // plugin-owned and unchanged by the user, but the bundled version moved
      // (version bump) -> safe to refresh.
      writeFileSync(destPath, bundled);
      manifest.written[name] = bundledHash;
      results.push({ agent: name, action: "refreshed" });
      continue;
    }

    // user-modified (or pre-existing, not written by us) -> never overwrite.
    results.push({ agent: name, action: "kept-user-modified" });
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return results;
}

export function installAgentsGlobal(
  bundledDir: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallResult[] {
  const cfg = globalConfigDir(env);
  return installAgents(
    join(cfg, "agent"),
    join(cfg, "android-tdd-agents.manifest.json"),
    bundledDir,
  );
}
