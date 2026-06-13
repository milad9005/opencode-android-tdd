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
import { realpathSync } from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
const BUILD_LOGIC_SEGMENTS = ["buildSrc", "build-logic"];
const BUILD_FILE_NAMES = [
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "libs.versions.toml",
];
function toAbs(filePath, worktree) {
    return isAbsolute(filePath) ? filePath : resolve(worktree, filePath);
}
/**
 * Resolve realpath where possible. A not-yet-created file (new test/impl) has no
 * realpath, so resolve its existing parent and re-append the basename — this
 * still defends against a symlinked *parent* directory crossing buckets.
 */
function safeRealpath(absPath) {
    try {
        return realpathSync(absPath);
    }
    catch {
        const parts = absPath.split(sep);
        for (let i = parts.length - 1; i > 1; i--) {
            const ancestor = parts.slice(0, i).join(sep) || sep;
            try {
                const real = realpathSync(ancestor);
                return [real, ...parts.slice(i)].join(sep);
            }
            catch {
                continue;
            }
        }
        return absPath;
    }
}
function underAnyRoot(realPath, roots) {
    return roots.some((root) => {
        const r = safeRealpath(toAbs(root, root));
        const rel = relative(r, realPath);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
}
function hasSegment(normalized, segment) {
    return normalized.split("/").includes(segment);
}
export function classifyPath(input) {
    const abs = toAbs(input.filePath, input.worktree);
    const real = safeRealpath(abs);
    const normalized = real.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? "";
    // Authoritative source-set resolution wins when available.
    if (input.sourceSetRoots) {
        if (underAnyRoot(real, input.sourceSetRoots.testRoots))
            return "test";
        if (underAnyRoot(real, input.sourceSetRoots.mainRoots))
            return "main";
    }
    // Build-logic (stronger gate than ordinary build files): buildSrc, build-logic,
    // convention plugins, included builds.
    if (BUILD_LOGIC_SEGMENTS.some((s) => hasSegment(normalized, s)))
        return "build-logic";
    // Build config files.
    if (BUILD_FILE_NAMES.includes(base))
        return "build";
    // Heuristic test detection (used when no source-set roots provided).
    const isTestPath = hasSegment(normalized, "test") ||
        hasSegment(normalized, "androidTest") ||
        hasSegment(normalized, "commonTest") ||
        hasSegment(normalized, "testFixtures") ||
        /[A-Za-z0-9]+(Test|Spec)\.(kt|java)$/.test(base);
    if (isTestPath)
        return "test";
    // Production source.
    if (hasSegment(normalized, "main") || hasSegment(normalized, "src"))
        return "main";
    // Generated-source roots wired into production compilation => production.
    if (hasSegment(normalized, "generated") || hasSegment(normalized, "ksp") || hasSegment(normalized, "kapt")) {
        return "main";
    }
    // Ambiguous => fail closed as production.
    return "main";
}
/**
 * Detect a bucket-crossing symlink/`..` escape: the declared path looks like a
 * test path textually, but its realpath resolves outside the worktree or into a
 * production/build location. The gate treats this as a hard deny.
 */
export function isBucketEscape(input) {
    const abs = toAbs(input.filePath, input.worktree);
    const real = safeRealpath(abs);
    const wtReal = safeRealpath(input.worktree);
    const rel = relative(wtReal, real);
    // escapes the worktree entirely
    if (rel.startsWith("..") || isAbsolute(rel))
        return true;
    // textual bucket differs from realpath bucket (symlink redirection)
    const textual = abs.replace(/\\/g, "/");
    const looksTest = textual.split("/").includes("test") || /[A-Za-z0-9]+(Test|Spec)\.(kt|java)$/.test(textual.split("/").pop() ?? "");
    if (looksTest && classifyPath(input) === "main")
        return true;
    return false;
}
