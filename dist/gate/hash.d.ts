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
export declare function hashFile(absPath: string): string;
/** Hash a set of files into a path->hash map (paths kept as given for stability). */
export declare function hashFiles(worktree: string, paths: string[]): Record<string, string>;
/**
 * A single combined hash over the build configuration that, if changed,
 * invalidates all proofs (SPEC-v2 §5): root + module build files, settings, and
 * the version catalog. Order-stable.
 */
export declare function buildConfigHash(worktree: string, buildFiles: string[]): string;
export interface DriftResult {
    drifted: boolean;
    changedFiles: string[];
}
/** Compare a recorded hash map against current on-disk hashes. */
export declare function detectDrift(worktree: string, recorded: Record<string, string>): DriftResult;
