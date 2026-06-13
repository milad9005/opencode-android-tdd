/**
 * Path classification for the gate (SPEC-v2 §6 / Majors #14, #15).
 *
 * Classifies a write target into a bucket the gate reasons about. Two hard
 * rules from the spec:
 *  - Resolve realpaths first; reject writes that cross a bucket boundary via
 *    symlink / `..` / case games. A symlink under src/test pointing at src/main
 *    must classify as production, not test.
 *  - Anything ambiguous => production (fail closed). Generated-source roots
 *    wired into production compilation count as production.
 *
 * v1 uses path heuristics as a fast pre-filter; the doctor's source-set
 * resolution is authoritative and overrides on disagreement (passed in via
 * `sourceSetRoots`).
 */
export type PathBucket = "test" | "main" | "build" | "build-logic" | "other";
export interface PathClassifyInput {
    /** absolute or worktree-relative path the tool wants to write */
    filePath: string;
    worktree: string;
    /**
     * Optional authoritative source-set roots from Gradle discovery. When
     * provided, a realpath under a test root => test, under a main root => main.
     */
    sourceSetRoots?: {
        testRoots: string[];
        mainRoots: string[];
    };
}
export declare function classifyPath(input: PathClassifyInput): PathBucket;
/**
 * Detect a bucket-crossing symlink/`..` escape: the declared path looks like a
 * test path textually, but its realpath resolves outside the worktree or into a
 * production/build location. The gate treats this as a hard deny.
 */
export declare function isBucketEscape(input: PathClassifyInput): boolean;
