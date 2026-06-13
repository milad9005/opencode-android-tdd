# opencode-android-tdd

A code-enforced Test-Driven Development gate for Android/Kotlin Gradle projects,
packaged as an [OpenCode](https://opencode.ai) plugin.

It does not *ask* the model to follow TDD — it **makes** it. A plugin hook blocks
every production-code write until a *correctly failing* test has been verified by
running real Gradle. The model coordinates the workflow; it cannot talk its way past
the gate, and it cannot mutate production code through any path the plugin does not own.

> Status: v0.1 — functionally complete and validated end-to-end against a real
> multi-module Android project. See the support matrix before using.

---

## The idea in one picture

The model never touches your code directly. Every action passes through a gate that
is **code, not a prompt** — so it cannot be argued with.

```
            ┌───────────────────────────────────────────────┐
            │                  LLM (model)                    │
            │   "add an email validator to :feature:register" │
            └───────────────────────┬───────────────────────┘
                                    │ every tool call
                                    ▼
        ╔═══════════════════════════════════════════════════════╗
        ║                  THE GATE  (tool.execute.before)        ║
        ║                                                         ║
        ║      read / tdd_*     write / edit        bash, patch,  ║
        ║          │                 │              move, …       ║
        ║          ▼                 ▼                 │          ║
        ║      ✅ allow      ◇ phase + slice +         ▼          ║
        ║                      redProof check       ⛔ DENY       ║
        ║                          │                              ║
        ║                  ┌───────┴────────┐                     ║
        ║                  ▼                ▼                      ║
        ║              ✅ allow          ⛔ DENY                  ║
        ╚═══════════════════╪════════════════════════════════════╝
                            │ only verified, in-scope writes survive
                            ▼
                ┌───────────────────────┐
                │   your Gradle project  │
                └───────────────────────┘
```

Legend: `▭` actor · `╔═╗` security boundary · `◇` decision · `✅/⛔` allow/deny.

---

## Why

LLMs told "write the test first" will skip it under pressure. This plugin removes the
choice: the TDD invariant is enforced as a **security boundary** in code, not in a prompt.

- **No production code before a verified RED.** A failing test must exist *and fail for
  the right reason* (the plugin classifies real Gradle/Kotlin output) before any
  `src/main` write is permitted.
- **Slice-scoped.** A verified RED unlocks only the files and symbols that slice declared.
- **Anti-cheat.** Baseline-new failures only; assertion fingerprints frozen at RED;
  build edits validated and proof-invalidating; immediate-GREEN flagged, not accepted.

---

## The TDD cycle (the state machine)

The plugin owns the phase. The model can only move between phases by calling `tdd_*`
tools that **produce their own evidence** (by running Gradle) — it can never just
declare "this is green".

```
   ┌──────────┐   tdd_start   ┌────────┐  tdd_doctor  ┌─────────┐
   │ INACTIVE │ ────────────▶ │ DOCTOR │ ───READY───▶ │ CONTEXT │
   └──────────┘               └────────┘              └────┬────┘
   writes DENIED              JDK + support                │ survey + clarify
                              matrix check                 ▼
                                                      ┌─────────┐  tdd_plan_set
                                                      │  PLAN   │ ─────────────┐
                                                      └─────────┘  small slices │
                                                                                ▼
   ╭──────────────────────── per slice ────────────────────────────────────────╮
   │                                                                            │
   │  ┌──────────┐         ┌────────────┐  write test   ┌────────────┐         │
   │  │ BASELINE │ ──────▶ │ TEST_WRITE │ ◀───────────  │ (test only)│         │
   │  └──────────┘         └─────┬──────┘               └────────────┘         │
   │  record pre-existing        │ tdd_verify_red                              │
   │  failures                   ▼                                             │
   │                       ◇ classifier ──── not a valid RED ──┐               │
   │                          │  (RED_*)                       │ fix test      │
   │                          ▼                                └──▶ TEST_WRITE  │
   │                    [ redProof set ]                                       │
   │                          │                                                │
   │                          ▼  write prod (slice paths only)                 │
   │                     ┌─────────┐  tdd_verify_green  ◇ ──not green──┐       │
   │                     │  IMPL   │ ───────────────────│              │       │
   │                     └─────────┘                    └─▶ keep IMPL  │       │
   │                          │ GREEN                                  │       │
   │                          ▼                                        │       │
   │                    ┌──────────┐  tdd_verify_green  ┌─────────┐    │       │
   │                    │ REFACTOR │ ─────GREEN───────▶ │ INSPECT │    │       │
   │                    └──────────┘                    └────┬────┘    │       │
   │                                              tdd_inspect_done      │       │
   ╰──────────────────────────────────────────────────┬───────────────╯       │
                       more slices? ◀──────────────────┘                       │
                            │ none left                                        │
                            ▼                                                  │
         ┌───────────┐  ┌──────────────────┐  ┌────────┐  ┌──────┐            │
         │ ARCH_GATE │─▶│ REGRESSION_GATE   │─▶│ REPORT │─▶│ DONE │            │
         └───────────┘  └──────────────────┘  └────────┘  └──────┘            │
```

Each arrow is a tool call that must pass a real check. You **cannot** reach `IMPL`
without a `redProof`, and you cannot get a `redProof` without a real failing test.

---

## How a RED is judged (the classifier)

The hardest part of real TDD tooling: telling a *legitimately failing* test apart from
a *broken* one. On Kotlin, a missing class is a **compile error**, not an assertion
failure — so exit codes alone lie. The classifier reads real Gradle/Kotlin output and
the JUnit XML, and **fails closed**:

```
                         ./gradlew :mod:testDebugUnitTest  (real run)
                                          │
                                          ▼
                                 ◇ what happened?
        ┌──────────────┬──────────────────┼───────────────────┬──────────────┐
        ▼              ▼                   ▼                   ▼              ▼
  BUILD SUCCESS   assertion fails    compile: missing     compile: other   ksp/kapt
   + tests>0      (slice test)       TARGET symbol        / type / syntax   codegen err
        │              │             (slice test)         / wrong symbol        │
        ▼              ▼                   ▼                   ▼              ▼
     ✅ GREEN    ✅ RED_ASSERTION   ✅ RED_MISSING_     ⛔ BROKEN_TEST   ⛔ BROKEN_TEST
                                       SYMBOL
        │              └────────┬─────────┘                   │              │
        │            unlock IMPL │  (redProof set)            └──── fix the test ───┘
        ▼                        ▼
   advance to              advance to IMPL
   REFACTOR

   wrong JDK / no javac / daemon died / timeout  ───▶  ⛔ ENV_FAILURE  (never a RED)
   0 tests ran / all @Ignore                      ───▶  ⛔ NO_TESTS_RUN (never GREEN)
```

Only the two `✅ RED_*` outcomes unlock production code. Everything ambiguous is
treated as broken — the gate would rather block you than let a fake RED through.

---

## What a verified RED actually unlocks (redProof)

A RED is not a boolean. It is a **hash-bound proof** scoped to one slice. It unlocks
*only* that slice's declared files, and **any drift voids it**.

```
        redProof  ────────────────────────────────────────────────┐
        │  slice: "email-validator"                                │
        │  module: :feature:register   variant: debug              │
        │  classifier: RED_MISSING_SYMBOL                           │
        │  expectedSymbols: [ EmailValidator ]                      │
        │  sliceTestFileHashes: { EmailValidatorTest.kt → a1b2… }   │  ← drift here
        │  allowedProductionPaths: [ EmailValidator.kt ]            │     ⇒ proof VOID
        └───────────────────────────┬──────────────────────────────┘     ⇒ back to
                                    │                                       TEST_WRITE
              IMPL write request    ▼
            ┌──────────────────────────────────────────────┐
            │  is target ∈ allowedProductionPaths?          │
            │      yes ──▶ are test-file hashes unchanged?  │
            │                 yes ──▶ ✅ ALLOW              │
            │                 no  ──▶ ⛔ proof drifted      │
            │      no  ──▶ ⛔ out of slice scope            │
            └──────────────────────────────────────────────┘
```

So one verified failing test for `EmailValidator` lets you write `EmailValidator.kt` —
and nothing else. Editing an unrelated file, or changing the test after RED, drops you
straight back to writing a test.

---

## Install

Requires OpenCode and a JDK with `javac` on the machine (a JRE-only `JAVA_HOME` fails;
the plugin auto-detects a real JDK, including Android Studio's bundled JBR).

```jsonc
// opencode.json  — from the registry…
{ "plugin": ["opencode-android-tdd"] }

// …or straight from GitHub (no npm needed)
{ "plugin": ["github:milad9005/opencode-android-tdd"] }
```

On first load the plugin installs four agents into `.opencode/agent/` (idempotent;
never overwrites your edits). Then drive work with the `android-tdd` agent:

```
opencode --agent android-tdd
> Add an email validator to :feature:register
```

---

## Support matrix (v1)

| Supported | Not yet (detected and refused, never mishandled) |
|---|---|
| Single & multi-module Gradle | Kotlin Multiplatform source sets |
| JVM library modules (`test`) | Instrumented tests (`androidTest`) |
| Android unit tests (`testDebugUnitTest`) | Build flavors beyond the default debug variant |
| JUnit4/5, Robolectric, MockK, Turbine, Kotlin K1/K2 | Non-Gradle builds |

`tdd_doctor` reports `UNSUPPORTED` with the reason before any work starts.

---

## How the gate works (detail)

```
  tool call ──▶ ◇ which bucket?
                 ├─ read / grep / lsp / tdd_*   ─────────────▶ ✅ always allow
                 ├─ subagent + any mutation     ─────────────▶ ⛔ subagents read-only
                 ├─ bash / patch / move / delete / unknown ───▶ ⛔ denied (allow-list)
                 └─ write / edit ──▶ ◇ phase? slice? redProof? hash drift? scope?
                                        └─ all pass ─▶ ✅ + take a gate lease
                                        └─ any fail ─▶ ⛔ + prescriptive message
```

- **Allow-list, not block-list.** Unknown / new / MCP tools fail closed. All builds and
  tests run through `tdd_*`, so the plugin's classifier is the only arbiter of pass/fail.
- **Gate lease** taken in `tool.execute.before`, released in `tool.execute.after` —
  closes the window between approving a write and the edit landing (no other mutator or
  phase change can slip in).
- **`experimental.chat.system.transform`** injects the current phase + what's editable
  into the system prompt *every turn* (covers OpenCode's first-message hook gap).
- State keyed by **worktree + workflow** (not session, so subagents stay read-only),
  persisted atomically with compare-and-swap versioning and a per-worktree lock.

---

## Tools

`tdd_start` · `tdd_doctor` · `tdd_status` · `tdd_plan_set` · `tdd_baseline` · `tdd_run`
· `tdd_verify_red` · `tdd_verify_green` · `tdd_inspect_done` · `tdd_quality`
· `tdd_arch_check` · `tdd_allow_build_edit` · `tdd_expand_scope` · `tdd_abort_slice`
· `tdd_reset_workflow` · `tdd_takeover_stale_lock` · `tdd_explain_block` · `tdd_report`

---

## Agents

```
        ┌────────────────────────────────────────────────────┐
        │  android-tdd  (primary, drives the cycle)           │
        │  edit: allow*   bash: deny     *but the gate decides │
        └───────────┬───────────────┬───────────────┬────────┘
        delegates (read-only) │     │               │
                    ▼          ▼     ▼               ▼
            ┌───────────┐ ┌────────────┐  ┌───────────────┐
            │tdd-context│ │tdd-inspector│  │tdd-regression │
            │ survey    │ │ review      │  │ impact        │
            │ edit:deny │ │ edit:deny   │  │ edit:deny     │
            └───────────┘ └────────────┘  └───────────────┘
```

- **`android-tdd`** (primary) — drives the cycle; holds no hardcoded architecture
  doctrine (reads your project's conventions).
- **`tdd-context`**, **`tdd-inspector`**, **`tdd-regression`** — read-only subagents
  for project survey, post-GREEN review, and impact analysis.

---

## Development

```bash
npm install
npm run build      # tsc + copy agent .md into dist/
npm run spike      # build + run all validation harnesses
```

The implementation is itself developed against real Gradle output captured from a
production Android app. Design and validation notes live in [`docs/`](./docs):
`SPEC-v2`, `SPIKE-red-classifier`, `DOCTOR`, `ENFORCEMENT-CORE`, `GATE`, `TOOLS`,
`HATCH-AND-AGENTS`, `E2E`.

## License

MIT
