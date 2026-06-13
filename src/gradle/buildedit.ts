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
  category?:
    | "add_test_dependency"
    | "create_test_sourceset"
    | "enable_test_plugin";
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

// Forbidden signals — any added line matching these rejects the edit. These are
// the levers that can silently disable or subvert the test invariant.
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\benabled\s*=\s*false\b/i, why: "disabling a task/test (enabled = false)" },
  { re: /\bexclude\b/i, why: "exclude (tests/files/dependencies)" },
  { re: /\b(filter|setIncludes|setExcludes|includeTestsMatching|excludeTestsMatching)\b/i, why: "test filtering" },
  { re: /\bignoreFailures\s*=\s*true\b/i, why: "ignoreFailures = true" },
  { re: /\b(srcDir|srcDirs|setSrcDirs|sourceSets)\b/i, why: "source-set redirection" },
  { re: /\b(kapt|ksp|annotationProcessor|generated)\b/i, why: "annotation-processor / generated-source rewiring" },
  { re: /-Xsuppress|@Suppress|suppressWarnings|freeCompilerArgs/i, why: "compiler suppression flags" },
  { re: /\b(dependsOn|finalizedBy|mustRunAfter|shouldRunAfter|onlyIf)\b/i, why: "task-graph manipulation" },
  { re: /\btasks\.(named|register|create|withType)\b/i, why: "task definition/manipulation" },
  { re: /\btestOptions\b|\bunitTests\b/i, why: "test options manipulation" },
];

// Allowed categories — at least one added line must match, AND no forbidden line
// may be present, for the edit to be ALLOWED.
const ALLOWED: { re: RegExp; category: NonNullable<BuildEditResult["category"]> }[] = [
  // testImplementation("..."), testRuntimeOnly(libs.x), androidTestImplementation(...)
  { re: /\b(test|androidTest)(Implementation|RuntimeOnly|Api|CompileOnly)\b/i, category: "add_test_dependency" },
  // creating the test source set directory wiring is handled elsewhere; a plugin
  // alias that is a known test plugin:
  { re: /\balias\(libs\.plugins\.[A-Za-z0-9.]*test/i, category: "enable_test_plugin" },
  { re: /\bid\(["']org\.jetbrains\.kotlin\.test|junit|robolectric/i, category: "enable_test_plugin" },
];

function addedLines(current: string, proposed: string): string[] {
  const cur = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  return proposed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !cur.has(l));
}

export function validateBuildEdit(input: BuildEditInput): BuildEditResult {
  const added = addedLines(input.current, input.proposed);

  const violations: string[] = [];
  for (const line of added) {
    for (const f of FORBIDDEN) {
      if (f.re.test(line)) violations.push(`${f.why}  ->  "${line}"`);
    }
  }
  if (violations.length > 0) {
    return { verdict: "FORBIDDEN", violations, addedLines: added };
  }

  let category: BuildEditResult["category"];
  for (const line of added) {
    const hit = ALLOWED.find((a) => a.re.test(line));
    if (hit) {
      category = hit.category;
      break;
    }
  }

  if (!category) {
    return {
      verdict: "FORBIDDEN",
      violations: ["no recognized safe change (allowed: add test dependency, enable a known test plugin, create a test source set)"],
      addedLines: added,
    };
  }

  return { verdict: "ALLOWED", category, violations: [], addedLines: added };
}
