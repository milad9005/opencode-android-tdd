/**
 * Build-edit diff validator (SPEC-v2 §5 / Majors #11, #34).
 *
 * Build edits are denied by default; this validator is the ONLY path that may
 * permit one, and it allows only narrow, safe categories. Logging a build edit
 * is not enough — an unvalidated build edit can disable tests, exclude files,
 * redirect source sets, or weaken the whole invariant. So we validate the actual
 * proposed change and FAIL CLOSED on anything not explicitly recognized as safe.
 *
 * Input is the proposed new content of a build file plus its current content;
 * we reason over the ADDED lines (a coarse but conservative diff: any added line
 * matching a forbidden pattern rejects the whole edit).
 *
 * Any accepted build edit invalidates all redProof/greenProof for the workflow
 * (enforced by the caller — tdd_allow_build_edit).
 */
export type BuildEditVerdict = "ALLOWED" | "FORBIDDEN";
export interface BuildEditResult {
    verdict: BuildEditVerdict;
    category?: "add_test_dependency" | "create_test_sourceset" | "enable_test_plugin";
    violations: string[];
    addedLines: string[];
}
export interface BuildEditInput {
    filePath: string;
    /** current on-disk content ("" if the file is being created) */
    current: string;
    /** proposed new content */
    proposed: string;
}
export declare function validateBuildEdit(input: BuildEditInput): BuildEditResult;
