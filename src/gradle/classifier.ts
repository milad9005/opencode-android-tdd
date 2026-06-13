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

export type RedClass =
  | "GREEN"
  | "RED_ASSERTION"
  | "RED_MISSING_SYMBOL"
  | "BROKEN_TEST"
  | "NO_TESTS_RUN"
  | "ENV_FAILURE";

export interface JUnitCase {
  classname: string;
  name: string;
  /** failure = assertion-style; error = unexpected exception/infra */
  outcome: "passed" | "failure" | "error" | "skipped";
  failureType?: string; // e.g. "org.junit.ComparisonFailure", "java.lang.NullPointerException"
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
  file: string; // absolute or project-relative path
  line: number;
  col: number;
  symbol?: string; // extracted unresolved-reference symbol, if any
  message: string;
  kind:
    | "unresolved_reference"
    | "type_mismatch"
    | "syntax"
    | "other";
}

export interface ClassifierInput {
  exitCode: number;
  stdout: string; // combined stdout+stderr (Gradle --console=plain)
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

// --- regexes grounded in captured real output -------------------------------

const RE_BUILD_SUCCESS = /BUILD SUCCESSFUL/;
const RE_BUILD_FAILED = /BUILD FAILED/;
const RE_FAILING_TESTS = /There were failing tests/;
// "> Task :mod:compileDebugUnitTestKotlin FAILED"  (compile phase failed)
const RE_COMPILE_TASK_FAILED =
  /> Task (:[^\s]*compile[^\s]*Kotlin) FAILED/i;
// Annotation-processor failures (KSP/kapt). Observed real form:
//   "> Task :mod:kspDebugUnitTestKotlin FAILED" + "KSP failed with exit code: PROCESSING_ERROR"
// Generated/processed-code errors are NEVER a slice's missing-symbol RED.
const RE_PROCESSOR_TASK_FAILED =
  /> Task (:[^\s]*(?:ksp|kapt)[^\s]*) FAILED/i;
const RE_PROCESSOR_ERROR =
  /KSP failed with exit code|PROCESSING_ERROR|annotation processor|\[ksp\]|\[kapt\]/i;
// Kotlin K2 diagnostic line: "e: file:///abs/Path.kt:15:24 Unresolved reference 'EmailRegexProvider'."
const RE_DIAG =
  /^e:\s+(?:file:\/\/)?([^\s:]+(?:\.kt|\.java)):(\d+):(\d+)\s+(.*)$/;
const RE_UNRESOLVED = /Unresolved reference '([^']+)'/;
const RE_TYPE_MISMATCH = /type mismatch|Initializer type mismatch|expected '.*', actual '.*'/i;
const RE_SYNTAX = /Syntax error|Expecting/i;
// Infra-failure signatures. Only consulted on a FAILED build: benign daemon
// startup lines appear on SUCCESSFUL builds, so patterns must match real
// failures ("daemon disappeared") not generic mentions ("Starting a Daemon").
const RE_ENV = [
  /does not provide the required capabilities/i, // wrong JDK / JRE-only toolchain
  /Could not resolve all (files|dependencies)/i,
  /Could not (download|GET|connect)/i,
  /Toolchain installation .* not found/i,
  /Timeout|timed out/i,
  /OutOfMemoryError|Metaspace/i,
  /daemon disappeared|daemon was stopped|daemon stopped unexpectedly/i,
];

function parseDiagnostics(stdout: string): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(RE_DIAG);
    if (!m) continue;
    const [, file, line, col, msg] = m;
    let kind: CompileDiagnostic["kind"] = "other";
    let symbol: string | undefined;
    const ur = msg.match(RE_UNRESOLVED);
    if (ur) {
      kind = "unresolved_reference";
      symbol = ur[1];
    } else if (RE_TYPE_MISMATCH.test(msg)) {
      kind = "type_mismatch";
    } else if (RE_SYNTAX.test(msg)) {
      kind = "syntax";
    }
    out.push({ file, line: Number(line), col: Number(col), symbol, message: msg, kind });
  }
  return out;
}

function isAssertionFailure(c: JUnitCase): boolean {
  if (c.outcome === "failure") return true; // JUnit <failure> = assertion-style
  // <error> with a known assertion type still counts; everything else is infra
  const t = (c.failureType ?? "").toLowerCase();
  return /assertion|comparisonfailure|assertionfailederror|opentest4j/.test(t);
}

function pathEndsWithAny(file: string, candidates: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return candidates.some((c) => {
    const cn = c.replace(/\\/g, "/");
    return norm.endsWith(cn) || cn.endsWith(norm.split("/").slice(-3).join("/"));
  });
}

export function classify(input: ClassifierInput): ClassifierResult {
  const { stdout, suites, expectedSymbols, sliceTestFiles, runStartedMs } = input;

  const compileTaskFailed = stdout.match(RE_COMPILE_TASK_FAILED);
  const processorTaskFailed = stdout.match(RE_PROCESSOR_TASK_FAILED);
  const processorError = RE_PROCESSOR_ERROR.test(stdout);
  const diagnostics = parseDiagnostics(stdout);
  const envHit = RE_ENV.find((re) => re.test(stdout));

  // fresh suites only (defend against stale XML — observed real risk)
  const freshSuites = suites.filter(
    (s) => s.fileMtimeMs === undefined || s.fileMtimeMs >= runStartedMs,
  );
  const staleXmlIgnored = freshSuites.length !== suites.length;

  const base = (cls: RedClass, reason: string, extra: Partial<ClassifierResult["evidence"]> = {}) =>
    ({
      cls,
      reason,
      unlocksImpl: cls === "RED_ASSERTION" || cls === "RED_MISSING_SYMBOL",
      evidence: {
        compileFailed: Boolean(compileTaskFailed),
        diagnostics,
        failingCases: freshSuites.flatMap((s) =>
          s.cases.filter((c) => c.outcome === "failure" || c.outcome === "error"),
        ),
        staleXmlIgnored,
        matchedTaskFailure: compileTaskFailed?.[1] ?? processorTaskFailed?.[1],
        ...extra,
      },
    }) satisfies ClassifierResult;

  // ENV first — never let infra failure masquerade as RED.
  if (envHit && !compileTaskFailed && !processorTaskFailed && diagnostics.length === 0) {
    return base("ENV_FAILURE", `Environment/infra failure: ${envHit.source}`);
  }

  // Annotation-processor failures (KSP/kapt) must never unlock IMPL: a broken
  // Dagger-Hilt graph or generated-code error is project breakage, not the
  // slice's test failing because its target is unimplemented. Security gate.
  if (processorTaskFailed || processorError) {
    return base(
      "BROKEN_TEST",
      `Annotation processor failure (${processorTaskFailed?.[1] ?? "ksp/kapt"}) — generated-code/DI error, not a slice failing test`,
    );
  }

  if (compileTaskFailed) {
    if (diagnostics.length === 0) {
      // compile failed but we couldn't parse why -> fail closed
      return base("BROKEN_TEST", "Compile failed with no parseable diagnostics");
    }
    // every blocking diagnostic must be (a) in a slice test file AND
    // (b) an unresolved reference to an EXPECTED target symbol.
    const allAreExpectedMissing = diagnostics.every(
      (d) =>
        d.kind === "unresolved_reference" &&
        d.symbol !== undefined &&
        expectedSymbols.includes(d.symbol) &&
        (sliceTestFiles.length === 0 || pathEndsWithAny(d.file, sliceTestFiles)),
    );
    if (allAreExpectedMissing && diagnostics.length > 0) {
      return base(
        "RED_MISSING_SYMBOL",
        `All compile diagnostics are unresolved references to expected target(s): ${expectedSymbols.join(", ")}`,
      );
    }
    return base(
      "BROKEN_TEST",
      "Compile failure includes diagnostics that are not expected-target unresolved references (unrelated symbols, type mismatch, syntax, generated-code noise, or wrong file)",
    );
  }

  // 3) No compile failure: use test results.
  if (RE_BUILD_SUCCESS.test(stdout)) {
    const totalTests = freshSuites.reduce((n, s) => n + s.tests, 0);
    const totalSkipped = freshSuites.reduce((n, s) => n + s.skipped, 0);
    if (totalTests === 0) return base("NO_TESTS_RUN", "Build succeeded but 0 tests executed");
    if (totalTests > 0 && totalTests === totalSkipped)
      return base("NO_TESTS_RUN", "All matched tests were skipped/ignored");
    return base("GREEN", `${totalTests} test(s) passed`);
  }

  if (RE_BUILD_FAILED.test(stdout) && RE_FAILING_TESTS.test(stdout)) {
    const failing = freshSuites.flatMap((s) => s.cases.filter((c) => c.outcome === "failure" || c.outcome === "error"));
    if (failing.length === 0) {
      return base("BROKEN_TEST", "Tests reported failing but no fresh failing case found in XML (stale or missing report)");
    }
    const inSlice = (c: JUnitCase) => {
      if (sliceTestFiles.length === 0) return true;
      const simpleName = c.classname.split(".").pop() ?? c.classname;
      const classAsPath = c.classname.replace(/\./g, "/");
      return sliceTestFiles.some((f) => {
        const nf = f.replace(/\\/g, "/").replace(/\.(kt|java)$/, "");
        return nf.includes(classAsPath) || nf.endsWith(simpleName) || nf === simpleName;
      });
    };
    const assertionInSlice = failing.filter((c) => isAssertionFailure(c) && inSlice(c));
    if (assertionInSlice.length === 0) {
      return base(
        "BROKEN_TEST",
        "Failure is an unexpected exception/error or comes from a non-slice test, not a slice assertion failure",
      );
    }
    return base("RED_ASSERTION", `${assertionInSlice.length} slice assertion failure(s)`);
  }

  // 4) Anything else: fail closed.
  if (envHit) return base("ENV_FAILURE", `Environment/infra failure: ${envHit.source}`);
  return base("BROKEN_TEST", "Unrecognized Gradle outcome — failing closed");
}
