/**
 * Content hashing for redProof drift detection (SPEC-v2 §2.4).
 *
 * A redProof is bound to SHA-256 hashes of the slice's test files, the allowed
 * production targets, and the build config. Before approving an IMPL write or a
 * phase transition, the gate recomputes these; any drift (test edit, build edit,
 * out-of-band IDE/formatter/git change) voids the proof and forces the slice back
 * to TEST_WRITE. A missing file hashes to a stable sentinel so deletion is itself
 * detectable drift.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const MISSING = "missing:0";

export function hashFile(absPath: string): string {
  if (!existsSync(absPath)) return MISSING;
  try {
    const buf = readFileSync(absPath);
    return "sha256:" + createHash("sha256").update(buf).digest("hex");
  } catch {
    return MISSING;
  }
}

function abs(worktree: string, p: string): string {
  return isAbsolute(p) ? p : resolve(worktree, p);
}

/** Hash a set of files into a path->hash map (paths kept as given for stability). */
export function hashFiles(worktree: string, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) out[p] = hashFile(abs(worktree, p));
  return out;
}

/**
 * A single combined hash over the build configuration that, if changed,
 * invalidates all proofs (SPEC-v2 §5): root + module build files, settings, and
 * the version catalog. Order-stable.
 */
export function buildConfigHash(worktree: string, buildFiles: string[]): string {
  const h = createHash("sha256");
  for (const f of [...buildFiles].sort()) {
    h.update(f).update("\0").update(hashFile(abs(worktree, f))).update("\0");
  }
  return "sha256:" + h.digest("hex");
}

export interface DriftResult {
  drifted: boolean;
  changedFiles: string[];
}

/** Compare a recorded hash map against current on-disk hashes. */
export function detectDrift(
  worktree: string,
  recorded: Record<string, string>,
): DriftResult {
  const changed: string[] = [];
  for (const [p, recordedHash] of Object.entries(recorded)) {
    if (hashFile(abs(worktree, p)) !== recordedHash) changed.push(p);
  }
  return { drifted: changed.length > 0, changedFiles: changed };
}
