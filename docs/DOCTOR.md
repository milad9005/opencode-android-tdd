# tdd_doctor — Toolchain + Discovery + Support-Matrix Gate

Resolves **Blocker #9** (hardcoded `testDebugUnitTest`) and the spike's toolchain
prerequisite. `tdd_doctor` runs once at workflow start; an unsupported project is
refused **before** any TDD work begins — no partial enforcement.

## What it does

1. **Toolchain discovery** (`src/gradle/toolchain.ts`) — finds a real JDK
   (`javac` present), rejecting a JRE-only `JAVA_HOME`. Returns a `toolchainId`
   bound into `redProof`. Verdict `NO_TOOLCHAIN` if none found.
2. **Module discovery** (`src/gradle/discover.ts`) — pure parser over real
   `./gradlew :module:tasks --all` output. Classifies module kind, picks the v1
   unit-test task, and refuses out-of-scope projects.
3. **Orchestration** (`src/doctor.ts`) — combines both into one verdict:
   `READY | UNSUPPORTED | NO_TOOLCHAIN`. Gradle execution is injected
   (`GradleRunner`) so decision logic stays pure/testable.

## Support matrix (v1) — verified against real VeroAndroid output

| Module | Real signal | Verdict | Chosen task |
|---|---|---|---|
| `:common:regex` (android library) | `testDebugUnitTest` (+ feature/qa/release variants) | SUPPORTED | `testDebugUnitTest` |
| `:core:logger:jvm` (jvm library) | single `test` task | SUPPORTED | `test` |
| flavored android | `testFreeDebugUnitTest` (flavor segment) | UNSUPPORTED `PRODUCT_FLAVORS` | — |
| instrumented-only | only `connectedAndroidTest` | UNSUPPORTED `INSTRUMENTED_ONLY` | — |
| KMP module | `compileKotlinAndroidUnitTest`, `commonTestClasses` | UNSUPPORTED `KMP_SOURCE_SETS` | — |

## Findings that shaped the parser (from real output)

- **VeroAndroid has 4 build types** (debug/feature/qa/release), each with its own
  `test<Variant>UnitTest`. v1 deterministically selects the **debug** unit-test
  task; the presence of extra plain build types does not make a module unsupported.
- **Product flavors are detected by variant decomposition:** a `test<Variant>UnitTest`
  whose `<Variant>` is not a known plain build type (e.g. `FreeDebug`) ⇒
  `PRODUCT_FLAVORS`. Plain build types alone are fine.
- **KMP detection cannot use `\b` source-set names** — KMP signals appear embedded
  in camelCase task names (`compileKotlinAndroidUnitTest`, `commonTestClasses`), so
  detection matches KMP-distinctive task-name substrings instead.
- **JVM vs Android split is unambiguous from tasks:** Android exposes
  `test<Variant>UnitTest`; a pure-JVM (`vero.jvm.library`) module exposes only
  `test`. Both map to source set `test`.

## Verification

- `spike/run-doctor.mjs` — **5/5** against real + synthetic cases.
- **Live end-to-end** against VeroAndroid: real toolchain discovery resolved
  JBR 21.0.10; real `./gradlew :module:tasks` confirmed `testDebugUnitTest` for
  `:common:regex` and `test` for `:core:logger:jvm`.
- `tsc --noEmit` clean (with `@types/node`).

## Artifacts

- `src/gradle/toolchain.ts`, `src/gradle/discover.ts`, `src/doctor.ts`
- `spike/run-doctor.mjs`, `spike/fixtures/discover_modules.txt`,
  `spike/fixtures/discover_tasks_regex.txt`
