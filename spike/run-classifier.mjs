// Spike harness — validates the RED classifier against the 6 REAL Gradle
// fixtures captured from VeroAndroid :common:regex. Node 20, no TS build.
// Inlines a JS port of src/gradle/classifier.ts (kept in sync by hand for the spike).

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// ---- minimal JUnit XML parser (regex-based; spike-grade) -------------------
function parseSuite(xml, mtimeMs) {
  const susp = xml.match(/<testsuite\b[^>]*>/);
  const attr = (n) => {
    const m = susp?.[0].match(new RegExp(`${n}="([^"]*)"`));
    return m ? m[1] : undefined;
  };
  const cases = [];
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = caseRe.exec(xml))) {
    const head = m[1];
    const body = m[3] ?? "";
    const cn = (head.match(/classname="([^"]*)"/) || [])[1] ?? "";
    const nm = (head.match(/name="([^"]*)"/) || [])[1] ?? "";
    let outcome = "passed";
    let failureType;
    if (/<failure\b/.test(body)) {
      outcome = "failure";
      failureType = (body.match(/<failure\b[^>]*type="([^"]*)"/) || [])[1];
    } else if (/<error\b/.test(body)) {
      outcome = "error";
      failureType = (body.match(/<error\b[^>]*type="([^"]*)"/) || [])[1];
    } else if (/<skipped\b/.test(body)) {
      outcome = "skipped";
    }
    cases.push({ classname: cn, name: nm, outcome, failureType });
  }
  return {
    name: attr("name") ?? "",
    tests: Number(attr("tests") ?? 0),
    failures: Number(attr("failures") ?? 0),
    errors: Number(attr("errors") ?? 0),
    skipped: Number(attr("skipped") ?? 0),
    cases,
    fileMtimeMs: mtimeMs,
  };
}

// ---- JS port of classifier (mirror of classifier.ts) -----------------------
const RE_BUILD_SUCCESS = /BUILD SUCCESSFUL/;
const RE_BUILD_FAILED = /BUILD FAILED/;
const RE_FAILING_TESTS = /There were failing tests/;
const RE_COMPILE_TASK_FAILED = /> Task (:[^\s]*compile[^\s]*Kotlin) FAILED/i;
const RE_PROCESSOR_TASK_FAILED = /> Task (:[^\s]*(?:ksp|kapt)[^\s]*) FAILED/i;
const RE_PROCESSOR_ERROR = /KSP failed with exit code|PROCESSING_ERROR|annotation processor|\[ksp\]|\[kapt\]/i;
const RE_DIAG = /^e:\s+(?:file:\/\/)?([^\s:]+(?:\.kt|\.java)):(\d+):(\d+)\s+(.*)$/;
const RE_UNRESOLVED = /Unresolved reference '([^']+)'/;
const RE_TYPE_MISMATCH = /type mismatch|Initializer type mismatch|expected '.*', actual '.*'/i;
const RE_SYNTAX = /Syntax error|Expecting/i;
const RE_ENV = [
  /does not provide the required capabilities/i,
  /Could not resolve all (files|dependencies)/i,
  /Could not (download|GET|connect)/i,
  /Toolchain installation .* not found/i,
  /Timeout|timed out/i,
  /OutOfMemoryError|Metaspace/i,
  /daemon disappeared|daemon was stopped|daemon stopped unexpectedly/i,
];

function parseDiagnostics(stdout) {
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(RE_DIAG);
    if (!m) continue;
    const [, file, line, col, msg] = m;
    let kind = "other";
    let symbol;
    const ur = msg.match(RE_UNRESOLVED);
    if (ur) { kind = "unresolved_reference"; symbol = ur[1]; }
    else if (RE_TYPE_MISMATCH.test(msg)) kind = "type_mismatch";
    else if (RE_SYNTAX.test(msg)) kind = "syntax";
    out.push({ file, line: +line, col: +col, symbol, message: msg, kind });
  }
  return out;
}
const isAssertionFailure = (c) =>
  c.outcome === "failure" ||
  /assertion|comparisonfailure|assertionfailederror|opentest4j/.test((c.failureType ?? "").toLowerCase());
const pathEndsWithAny = (file, cands) => {
  const norm = file.replace(/\\/g, "/");
  return cands.some((c) => {
    const cn = c.replace(/\\/g, "/");
    return norm.endsWith(cn) || cn.endsWith(norm.split("/").slice(-3).join("/"));
  });
};

function classify(input) {
  const { stdout, suites, expectedSymbols, sliceTestFiles, runStartedMs } = input;
  const compileTaskFailed = stdout.match(RE_COMPILE_TASK_FAILED);
  const processorTaskFailed = stdout.match(RE_PROCESSOR_TASK_FAILED);
  const processorError = RE_PROCESSOR_ERROR.test(stdout);
  const diagnostics = parseDiagnostics(stdout);
  const envHit = RE_ENV.find((re) => re.test(stdout));
  const fresh = suites.filter((s) => s.fileMtimeMs === undefined || s.fileMtimeMs >= runStartedMs);
  const mk = (cls, reason) => ({
    cls, reason,
    unlocksImpl: cls === "RED_ASSERTION" || cls === "RED_MISSING_SYMBOL",
  });

  if (envHit && !compileTaskFailed && !processorTaskFailed && diagnostics.length === 0)
    return mk("ENV_FAILURE", `infra: ${envHit.source}`);

  if (processorTaskFailed || processorError)
    return mk("BROKEN_TEST", `annotation processor failure (${processorTaskFailed?.[1] ?? "ksp/kapt"})`);

  if (compileTaskFailed) {
    if (diagnostics.length === 0) return mk("BROKEN_TEST", "compile failed, no parseable diagnostics");
    const allExpected = diagnostics.every(
      (d) => d.kind === "unresolved_reference" && d.symbol && expectedSymbols.includes(d.symbol) &&
        (sliceTestFiles.length === 0 || pathEndsWithAny(d.file, sliceTestFiles)),
    );
    return allExpected
      ? mk("RED_MISSING_SYMBOL", `only expected-target unresolved refs: ${expectedSymbols.join(",")}`)
      : mk("BROKEN_TEST", "compile failure has non-target/type/syntax diagnostics");
  }

  if (RE_BUILD_SUCCESS.test(stdout)) {
    const total = fresh.reduce((n, s) => n + s.tests, 0);
    const skip = fresh.reduce((n, s) => n + s.skipped, 0);
    if (total === 0) return mk("NO_TESTS_RUN", "0 tests executed");
    if (total === skip) return mk("NO_TESTS_RUN", "all skipped");
    return mk("GREEN", `${total} passed`);
  }
  if (RE_BUILD_FAILED.test(stdout) && RE_FAILING_TESTS.test(stdout)) {
    const failing = fresh.flatMap((s) => s.cases.filter((c) => c.outcome === "failure" || c.outcome === "error"));
    if (failing.length === 0) return mk("BROKEN_TEST", "failing tests but no fresh failing case (stale/missing XML)");
    const inSlice = (c) => {
      if (sliceTestFiles.length === 0) return true;
      const simpleName = c.classname.split(".").pop() ?? c.classname;
      const classAsPath = c.classname.replace(/\./g, "/");
      return sliceTestFiles.some((f) => {
        const nf = f.replace(/\\/g, "/").replace(/\.(kt|java)$/, "");
        return nf.includes(classAsPath) || nf.endsWith(simpleName) || nf === simpleName;
      });
    };
    const a = failing.filter((c) => isAssertionFailure(c) && inSlice(c));
    return a.length ? mk("RED_ASSERTION", `${a.length} slice assertion failure(s)`)
                    : mk("BROKEN_TEST", "failure is exception/non-slice, not slice assertion");
  }
  if (envHit) return mk("ENV_FAILURE", `infra: ${envHit.source}`);
  return mk("BROKEN_TEST", "unrecognized outcome — fail closed");
}

// ---- fixtures + expectations ------------------------------------------------
const read = (f) => (existsSync(join(FX, f)) ? readFileSync(join(FX, f), "utf8") : "");
const mtime = (f) => (existsSync(join(FX, f)) ? statSync(join(FX, f)).mtimeMs : undefined);

const SLICE_TEST = ["co/vero/common/regex/domain/Zz"]; // spike slice test path fragment
const cases = [
  { name: "GREEN",             stdout: "green.stdout.txt",         xml: "green.TEST.xml",         expect: "GREEN",             symbols: [],                      slice: ["DomainRegexProviderTest"] },
  { name: "RED_ASSERTION",     stdout: "red_assertion.stdout.txt", xml: "red_assertion.TEST.xml", expect: "RED_ASSERTION",     symbols: [],                      slice: ["ZzSpikeAssertionTest"] },
  { name: "RED_MISSING_SYMBOL",stdout: "red_missing.stdout.txt",   xml: null,                     expect: "RED_MISSING_SYMBOL",symbols: ["EmailRegexProvider"],  slice: ["ZzSpikeMissingTest.kt"] },
  { name: "BROKEN_TEST",       stdout: "broken_test.stdout.txt",   xml: null,                     expect: "BROKEN_TEST",       symbols: ["EmailRegexProvider"],  slice: ["ZzSpikeBrokenTest.kt"] },
  { name: "ENV_FAILURE",       stdout: "env_failure.stdout.txt",   xml: null,                     expect: "ENV_FAILURE",       symbols: [],                      slice: [] },
  // adversarial: same missing-symbol output but the target was NOT declared -> must NOT unlock
  { name: "MISSING_unexpected",stdout: "red_missing.stdout.txt",   xml: null,                     expect: "BROKEN_TEST",       symbols: [],                      slice: ["ZzSpikeMissingTest.kt"] },
  // codegen break: KSP/Hilt @Binds error -> annotation-processor failure, must be BROKEN_TEST even with target declared
  { name: "CODEGEN_BREAK",     stdout: "codegen_break.stdout.txt", xml: null,                     expect: "BROKEN_TEST",       symbols: ["DomainRegexProvider"], slice: ["ZzSpikeHiltBreakTest.kt"] },
];

let pass = 0;
const rows = [];
for (const c of cases) {
  const stdout = read(c.stdout);
  const suites = c.xml ? [parseSuite(read(c.xml), mtime(c.xml))] : [];
  const r = classify({
    exitCode: 1, stdout, suites,
    runStartedMs: 0, // fixtures predate "now"; accept all as fresh for spike
    expectedSymbols: c.symbols, sliceTestFiles: c.slice,
  });
  const ok = r.cls === c.expect;
  if (ok) pass++;
  rows.push({ case: c.name, expected: c.expect, got: r.cls, unlocksImpl: r.unlocksImpl, ok, reason: r.reason });
}

console.log("\n=== RED CLASSIFIER SPIKE — real VeroAndroid fixtures ===\n");
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.case.padEnd(20)} expected=${r.expected.padEnd(18)} got=${r.got.padEnd(18)} unlocksImpl=${r.unlocksImpl}`);
  console.log(`        reason: ${r.reason}`);
}
console.log(`\n${pass}/${rows.length} correct\n`);
process.exit(pass === rows.length ? 0 : 1);
