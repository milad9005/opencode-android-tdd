# Spike: RED Classifier — Go/No-Go on Blocker #8

**Verdict: GO.** The make-or-break problem — deterministically
telling a *valid failing test* apart from a *broken test / environment failure*
on real Android/Kotlin Gradle output — is solvable. A pure, deterministic
classifier scored **7/7** against real fixtures captured from `VeroAndroid`,
including three adversarial cases that protect the gate's integrity (unrelated
compile errors, missing-symbol-without-declared-target, and a real Hilt/KSP
annotation-processor break).

## What was actually run

- **Target:** `VeroAndroid :common:regex` (real module: AGP + Hilt + KSP convention
  plugins, Robolectric, Kotlin K2, Gradle 8.14.3).
- **Toolchain:** project needs a real JDK; the machine's `java-21-openjdk` is a
  **JRE without `javac`**. Used Android Studio's bundled JBR 21
  (`/usr/local/android-studio-panda4-patch1-linux/android-studio/jbr`) as `JAVA_HOME`.
- **No tracked files were modified.** Spike tests were written into the module's
  test source root, run, then deleted; `git status` confirmed the tree clean.

## Fixtures (all captured from real `./gradlew` output)

| Fixture | How produced | Classifier result | Unlocks IMPL |
|---|---|---|---|
| GREEN | existing `DomainRegexProviderTest` (16 tests) | `GREEN` | no |
| RED_ASSERTION | temp test, deliberate `assertEquals` mismatch | `RED_ASSERTION` | **yes** |
| RED_MISSING_SYMBOL | temp test referencing non-existent `EmailRegexProvider` | `RED_MISSING_SYMBOL` | **yes** |
| BROKEN_TEST | temp test: bad import + type mismatch + syntax error | `BROKEN_TEST` | no |
| ENV_FAILURE | wrong JDK (JRE-only toolchain) | `ENV_FAILURE` | no |
| MISSING_unexpected (adversarial) | missing-symbol output but **no declared target** | `BROKEN_TEST` | no |
| CODEGEN_BREAK (adversarial) | real Hilt/KSP `@Binds` graph error (temp test) | `BROKEN_TEST` | no |

## What the real output proved (and the spec did not anticipate)

1. **Exit code is useless alone.** GREEN, RED_ASSERTION, RED_MISSING_SYMBOL,
   BROKEN_TEST, and ENV_FAILURE all exit non-zero except GREEN — and the wrong-JDK
   ENV_FAILURE *also* exits 1. A naive "exit 1 = RED" gate would unlock IMPL on a
   misconfigured toolchain. Confirmed in the wild on turn one.
2. **Compile failure ≠ test failure.** The decisive signal is the Gradle task
   identity: `> Task :mod:compileDebugUnitTestKotlin FAILED` means we never reached
   the test phase. RED_MISSING_SYMBOL and BROKEN_TEST both live here; RED_ASSERTION
   lives in `There were failing tests`.
3. **Stale JUnit XML is a real masking risk.** After the compile-failure run, the
   *previous* run's `TEST-*.xml` was still on disk. The classifier must filter by
   report mtime ≥ run start (implemented) and use `--rerun-tasks`.
4. **"Any unresolved reference = RED" is exploitable.** The BROKEN_TEST fixture
   emitted `Unresolved reference 'totally'` and `'someUndeclaredHelper'` alongside
   type/syntax errors. RED_MISSING_SYMBOL is granted **only when every blocking
   diagnostic is an unresolved reference to a pre-declared expected target symbol,
   in a slice test file.** The adversarial MISSING_unexpected case (same output,
   no declared target) correctly stays BROKEN_TEST.
5. **Two classifier bugs were caught only because fixtures were real:**
   - benign `"Starting a Gradle Daemon, 1 incompatible Daemon could not be reused"`
     on a *successful* build matched a greedy env regex → false ENV_FAILURE. Fixed
     by gating env detection on actual build failure + tightening patterns.
   - JUnit `classname` is fully-qualified (`co.vero...ZzSpikeAssertionTest`); the
     slice-file matcher compared in the wrong direction. Fixed.
6. **Codegen failures use a different task + diagnostic shape.** A real Hilt/KSP
   `@Binds` graph error fails the task `:mod:kspDebugUnitTestKotlin` (not
   `compile*Kotlin`) and emits `e: [ksp] /path.kt:17: ...` (line, **no column**) +
   `KSP failed with exit code: PROCESSING_ERROR` — and **zero** "Unresolved
   reference" lines. The classifier now detects KSP/kapt task failure + processor
   errors explicitly and returns `BROKEN_TEST` *by design* (not by fail-closed
   fall-through), so a broken DI graph can never masquerade as a slice RED.

## Conditions on the GO

- **First run cost ~60-70s** with `--rerun-tasks` on one small module (daemon warm).
  Targeted runs are mandatory; full-suite runs per slice are not viable. Timeout +
  `ENV_FAILURE` retry policy required.
- **Toolchain discovery is a prerequisite, not a detail.** The plugin MUST locate a
  real JDK (`javac` present) — JRE-only `JAVA_HOME` fails before compilation. Detect
  and surface this as `ENV_FAILURE`, never as RED.
- **`RED_ASSERTION` vs `error`:** only JUnit `<failure>` / known assertion types
  unlock; unexpected exceptions (`<error>`, NPE, classloader) are BROKEN_TEST.
- **Expected-symbol declaration is required** for RED_MISSING_SYMBOL — the
  orchestrator must pass the slice's target symbol(s) into `tdd_run`. Without it,
  missing-symbol output fails closed to BROKEN_TEST (by design).
- Generated-code (Hilt/KSP/Room) failures now empirically covered: a real Hilt
  `@Binds` graph break was captured (`codegen_break.stdout.txt`) and is classified
  `BROKEN_TEST` by design via explicit KSP/kapt task + processor-error detection.

## Artifacts

- Classifier: `src/gradle/classifier.ts` (type-checks clean; pure function).
- Spike harness + JS port: `spike/run-classifier.mjs` (**7/7**).
- Real fixtures: `spike/fixtures/*.stdout.txt`, `*.TEST.xml`, `*.exit.txt`
  (green, red_assertion, red_missing, broken_test, env_failure, codegen_break).

## Recommended next step

Proceed to spec v2 (resolve the 10 blockers), carrying these spike-proven
requirements into the design: task-identity-based phase detection, mtime-fresh XML,
expected-symbol-gated missing-symbol, JDK/toolchain discovery as `ENV_FAILURE`, and
targeted-run-only cost model.
