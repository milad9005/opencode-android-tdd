/**
 * JUnit XML parser: read Gradle's build/test-results/<task>/TEST-*.xml into the
 * JUnitSuite[] shape the classifier consumes. mtime is captured per file so the
 * classifier can reject stale reports (a real masking risk proven in the spike).
 *
 * Regex-based on purpose: the surefire/JUnit XML shape is stable and small, and
 * this avoids an XML-parser dependency for a plugin meant to install cleanly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const RE_SUITE = /<testsuite\b([^>]*)>/;
const RE_ATTR = (name) => new RegExp(`${name}="([^"]*)"`);
const RE_CASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
function attr(head, name) {
    return head.match(RE_ATTR(name))?.[1];
}
export function parseSuiteXml(xml, fileMtimeMs) {
    const head = xml.match(RE_SUITE)?.[1] ?? "";
    const cases = [];
    let m;
    RE_CASE.lastIndex = 0;
    while ((m = RE_CASE.exec(xml))) {
        const caseHead = m[1];
        const body = m[3] ?? "";
        const classname = attr(caseHead, "classname") ?? "";
        const name = attr(caseHead, "name") ?? "";
        let outcome = "passed";
        let failureType;
        let failureMessage;
        if (/<failure\b/.test(body)) {
            outcome = "failure";
            failureType = body.match(/<failure\b[^>]*\btype="([^"]*)"/)?.[1];
            failureMessage = body.match(/<failure\b[^>]*\bmessage="([^"]*)"/)?.[1];
        }
        else if (/<error\b/.test(body)) {
            outcome = "error";
            failureType = body.match(/<error\b[^>]*\btype="([^"]*)"/)?.[1];
            failureMessage = body.match(/<error\b[^>]*\bmessage="([^"]*)"/)?.[1];
        }
        else if (/<skipped\b/.test(body)) {
            outcome = "skipped";
        }
        cases.push({ classname, name, outcome, failureType, failureMessage });
    }
    return {
        name: attr(head, "name") ?? "",
        tests: Number(attr(head, "tests") ?? 0),
        failures: Number(attr(head, "failures") ?? 0),
        errors: Number(attr(head, "errors") ?? 0),
        skipped: Number(attr(head, "skipped") ?? 0),
        cases,
        fileMtimeMs,
    };
}
/**
 * Collect all TEST-*.xml under a module's build/test-results/<task> directory.
 * Returns [] when the directory doesn't exist (no tests ran / compile failed
 * before the test phase) — the classifier treats that distinctly.
 */
export function collectSuites(moduleAbsDir, testTask) {
    const resultsDir = join(moduleAbsDir, "build", "test-results", testTask);
    if (!existsSync(resultsDir))
        return [];
    const out = [];
    for (const entry of readdirSync(resultsDir)) {
        if (!entry.startsWith("TEST-") || !entry.endsWith(".xml"))
            continue;
        const full = join(resultsDir, entry);
        try {
            const mtime = statSync(full).mtimeMs;
            out.push(parseSuiteXml(readFileSync(full, "utf8"), mtime));
        }
        catch {
            continue;
        }
    }
    return out;
}
