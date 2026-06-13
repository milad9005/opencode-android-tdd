/**
 * JUnit XML parser: read Gradle's build/test-results/<task>/TEST-*.xml into the
 * JUnitSuite[] shape the classifier consumes. mtime is captured per file so the
 * classifier can reject stale reports (a real masking risk proven in the spike).
 *
 * Regex-based on purpose: the surefire/JUnit XML shape is stable and small, and
 * this avoids an XML-parser dependency for a plugin meant to install cleanly.
 */
import type { JUnitSuite } from "./classifier.js";
export declare function parseSuiteXml(xml: string, fileMtimeMs?: number): JUnitSuite;
/**
 * Collect all TEST-*.xml under a module's build/test-results/<task> directory.
 * Returns [] when the directory doesn't exist (no tests ran / compile failed
 * before the test phase) — the classifier treats that distinctly.
 */
export declare function collectSuites(moduleAbsDir: string, testTask: string): JUnitSuite[];
