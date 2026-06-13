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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_NAMES = ["android-tdd", "tdd-context", "tdd-inspector", "tdd-regression"];

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

export function installAgents(worktree: string, bundledDir: string): InstallResult[] {
  const agentDir = join(worktree, ".opencode", "agent");
  const stateDir = join(worktree, ".opencode", "android-tdd");
  const manifestPath = join(stateDir, "agents.manifest.json");
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

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
