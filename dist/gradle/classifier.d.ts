/**
 * RED classifier — the make-or-break core of the TDD gate (spec blocker #8).
 *
 * Pure, deterministic. Takes the raw Gradle stdout/stderr, exit code, and the
 * parsed JUnit XML test suites, plus the slice's expected target symbols and
 * the set of test files that belong to the current slice. Returns exactly one
 * classification. It MUST fail closed: anything ambiguous or unrelated is
 * BROKEN_TEST or ENV_FAILURE, never a RED that unlocks IMPL.
 *
 * Signals were derived from REAL Gradle output captured against
 * VeroAndroid :common:regex (Gradle 8.14.3, AGP, Kotlin K2, Robolectric).
 */
export type RedClass = "GREEN" | "RED_ASSERTION" | "RED_MISSING_SYMBOL" | "BROKEN_TEST" | "NO_TESTS_RUN" | "ENV_FAILURE";
export interface JUnitCase {
    classname: string;
    name: string;
    /** failure = assertion-style; error = unexpected exception/infra */
    outcome: "passed" | "failure" | "error" | "skipped";
    failureType?: string;
}
export interface JUnitSuite {
    name: string;
    tests: number;
    failures: number;
    errors: number;
    skipped: number;
    cases: JUnitCase[];
    /** mtime of the XML file, for stale-report detection */
    fileMtimeMs?: number;
}
export interface CompileDiagnostic {
    file: string;
    line: number;
    col: number;
    symbol?: string;
    message: string;
    kind: "unresolved_reference" | "type_mismatch" | "syntax" | "other";
}
export interface ClassifierInput {
    exitCode: number;
    stdout: string;
    /** JUnit suites parsed from build/test-results, filtered to this run */
    suites: JUnitSuite[];
    /** When the run started (ms). XML older than this => stale, ignore. */
    runStartedMs: number;
    /** Symbols the slice's new test legitimately references but hasn't impl'd yet */
    expectedSymbols: string[];
    /** Test files that belong to the current slice (project-relative or absolute) */
    sliceTestFiles: string[];
}
export interface ClassifierResult {
    cls: RedClass;
    reason: string;
    /** evidence retained for the audit ledger */
    evidence: {
        compileFailed: boolean;
        diagnostics: CompileDiagnostic[];
        failingCases: JUnitCase[];
        staleXmlIgnored: boolean;
        matchedTaskFailure?: string;
    };
    /** true only for RED_ASSERTION / RED_MISSING_SYMBOL */
    unlocksImpl: boolean;
}
export declare function classify(input: ClassifierInput): ClassifierResult;
