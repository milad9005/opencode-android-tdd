# Android TDD Orchestrator — Architecture Spec v2 (Hardened)

> **Status:** Implementation-ready design. Supersedes the v1 spec in `/tmp/opencode`.
> Resolves all 10 blockers from the gap report and folds in the RED-classifier
> spike findings (proven 6/6 against real `VeroAndroid` Gradle output).
>
> **Platform facts are source-verified** against opencode commit `45e4606` /
> SDK v1.17.4. **Classifier behavior is spike-verified** against real Gradle output.
>
> Companion docs: `SPIKE-red-classifier.md` (proof), gap report (rationale).

---

## 0. Thesis

A single npm-distributed OpenCode plugin (`opencode-android-tdd`) that makes an
Android/Kotlin Gradle project obey strict Red→Green→Refactor. The TDD invariant is
enforced **in code as a security boundary** — fail-closed, with every write
permission bound to a specific *worktree + workflow + slice + file-hash + verified
run*. The model coordinates; it cannot talk its way past the gate, and it cannot
mutate production code through any path the plugin does not own.

**Design stance:** treat the agent as an adversary that will take any loophole,
accidentally or not. If a rule isn't enforced in code, it doesn't exist.

---

## 1. v1 Support Matrix (explicit scope — detect-and-refuse outside it)

| Supported in v1 | Refused in v1 (detected → `UNSUPPORTED`, never silently mishandled) |
|---|---|
| Single & multi-module Gradle | KMP multiplatform source sets (`commonMain`/`androidMain`/`commonTest`) |
| JVM library modules (`test`) | Instrumented tests (`androidTest`, `connected*AndroidTest`) |
| Android library/app **unit** tests (`testDebugUnitTest`) | Build flavors beyond the default debug variant |
| JUnit4/JUnit5 + Robolectric, MockK, Turbine | Dynamic feature modules, included-build production code |
| Kotlin K1/K2, AGP + KSP/Hilt codegen (as noise to reject) | Non-Gradle build systems |

Refusal is a first-class outcome: `tdd_doctor` reports an unsupported project
**before** any workflow starts, with the exact reason. No partial enforcement.

---

## 2. Enforcement model (the security boundary)

### 2.1 Fail-CLOSED tool policy — resolves **Blocker #1**

Every tool call is classified into exactly one bucket; the default is **DENY**.

| Bucket | Tools | Policy |
|---|---|---|
| **Read-only** | `read`, `grep`, `glob`, `list`, `lsp_*`, `webfetch`, `task` (→ read-only subagents) | always allow |
| **Plugin-owned** | `tdd_*` custom tools | allow; these are the *only* path to Gradle + phase transitions |
| **Guarded mutators** | `write`, `edit` | allow **only** if phase + slice-scope + redProof checks pass (§2.4) |
| **Hard-denied in TDD mode** | `bash`, `patch`, `apply`, `move`/`rename`, `delete`, any MCP/custom FS tool, any unknown tool | **DENY by default** |

- **Raw `bash` is denied** while a workflow is active. All Gradle/test/quality
  execution goes exclusively through `tdd_run`/`tdd_quality` so the plugin's
  classifier is the *only* arbiter of pass/fail. A narrow read-only shell allowlist
  (e.g. `git status`, `./gradlew --version`) may be permitted via config, executed
  by the plugin itself, never as a model-issued `bash`.
- **Unknown tool ⇒ deny.** New/MCP tools are blocked until explicitly allowlisted.
  The gate enumerates buckets by allow-list, not block-list — anything unrecognized
  with filesystem capability fails closed.

### 2.2 Turn-1 coverage — resolves **Blocker #2**

`tool.execute.before` does **not** fire on the first message of a session (open
issue #6862). Therefore:

1. **Bootstrap = DENY-ALL-WRITES.** A fresh workflow starts in `INACTIVE`. No
   guarded mutator is permitted until the plugin has (a) observed at least one
   `tool.execute.before` *or* (b) the model has called `tdd_start`. Until then,
   any write throws.
2. **`experimental.chat.system.transform`** (confirmed fires every turn incl. the
   first, `request.ts:56`) injects the current phase banner + the deny rule into
   the system prompt every turn. This is the only reliable turn-1 channel.
3. The combination means the *worst case* on turn 1 is: the model tries a write,
   which is denied by bootstrap state regardless of whether the hook fired.

### 2.3 State scoping, atomicity, leases — resolves **Blockers #3, #4, #5**

- **Key by `worktree + workflowId`, never `sessionID`.** Subagents get a distinct
  child sessionID (`task.ts:148`), so session-keyed state would split or leak.
  `workflowId` is allocated by `tdd_start` and stored in the ledger.
- **Subagents are read-only, always.** The gate detects subagent context and
  permits only the read-only bucket regardless of phase. The inspector/context/
  regression agents never mutate.
- **Atomic state writes:** temp-file write → `fsync` → `rename`. A monotonic
  `stateVersion` guards every transition with compare-and-swap: "advance from vN to
  vN+1 only if phase/slice/hashes still match." A stale CAS fails closed.
- **Per-worktree lock** with a stale-lease timeout. A second concurrent writer
  session fails closed unless it explicitly takes over an expired lease
  (`tdd_takeover_stale_lock`, logged).
- **Gate lease (decision↔execution atomicity):** `tool.execute.before` acquires a
  lease for the specific file+phase+stateVersion; `tool.execute.after` releases it.
  While a mutator lease is held, phase transitions and other mutators for the same
  worktree are blocked. This closes the TOCTOU window between approval and the
  edit actually landing.

### 2.4 `redProof` — resolves **Blockers #6, #7**

`hasVerifiedRed: boolean` is replaced by a structured, hash-bound proof:

```
redProof = {
  workflowId, sliceId, runId,
  module, variant, testTask, testSelectors[],
  expectedSymbols[],
  classifier: "RED_ASSERTION" | "RED_MISSING_SYMBOL",
  failingTestIdentity[],          // class#method + assertion type
  sliceTestFileHashes{},          // SHA-256 of each slice test file at RED
  productionPreHashes{},          // SHA-256 of allowed prod targets at RED
  buildConfigHash,                // settings + version catalog + module build files
  toolchainId,                    // resolved JDK (see §4)
  timestamp
}
```

- **IMPL is scoped to the slice.** A redProof unlocks writes **only** to the slice's
  declared `allowedProductionPaths` / `allowedSymbols`. It does **not** unlock the
  rest of `src/main`. Editing anything else throws.
- **Any drift invalidates the proof.** Before approving an IMPL write or any phase
  transition, the gate recomputes the relevant hashes; if a slice test file, build
  config, branch, or out-of-band file changed (IDE/formatter/git/other session),
  `redProof` is voided and the slice returns to `TEST_WRITE`.
- **Scope expansion is explicit:** `tdd_expand_scope` logs the reason and forces RED
  re-verification.

### 2.5 Anti-cheat integrity — resolves **Blocker #10**

- **Baseline before TEST_WRITE.** `tdd_baseline` runs the slice's target test task
  and records the set of pre-existing failures. Only failures **introduced by
  current-slice test changes** count as RED — a pre-existing red test cannot be
  hijacked as the slice's RED.
- **Assertion fingerprints frozen at RED.** Any test edit after RED clears
  `redProof` (back to `TEST_WRITE`); test edits are denied during IMPL. During
  REFACTOR, test edits require a fresh RED cycle by default (config-gated).
- **GREEN requires substance:** nonzero executed tests, **zero skipped/ignored**
  unless explicitly allowed; `@Ignore`/all-skipped/empty-parameterized ⇒
  `NO_TESTS_RUN`, never GREEN.
- **Immediate-GREEN policy:** a new slice test that passes on first run does **not**
  unlock IMPL — it's flagged `ALREADY_COVERED`, requiring a stronger test, a
  user-confirmed no-op, or replan.
- **Build edits invalidate all proofs** (see §5).

---

## 3. Phase machine (orchestrator spine)

The plugin owns the canonical phase. The model advances it **only** via `tdd_*`
tools that produce their own evidence — never by asserting "this is green."

```
INACTIVE → tdd_start → DOCTOR → CONTEXT → CLARIFY → PLAN ─┐
                                                          ▼
            ┌──────────────────── slice loop ─────────────────────┐
            │ BASELINE → TEST_WRITE → tdd_run → VERIFY_RED         │
            │     ▲ (BROKEN/NO_TESTS/ENV: stay)  │ (RED_*)         │
            │     └──────────────── fix test ◀───┘                 │
            │ IMPL → tdd_run → VERIFY_GREEN                         │
            │     ▲ (still red: stay)  │ (GREEN)                    │
            │     └────────────────────┘                           │
            │ REFACTOR → tdd_run → VERIFY_GREEN → INSPECT           │
            └──────────────────────┬──────────────────────────────┘
                                   ▼ (more slices? → BASELINE)
                          ARCH_GATE → REGRESSION_GATE → REPORT → DONE
```

Per-phase guarded-mutator permissions (everything not listed = DENY):

| Phase | test files | prod files (slice-scoped) | build/build-logic |
|---|---|---|---|
| INACTIVE/DOCTOR/CONTEXT/CLARIFY/PLAN | ✗ | ✗ | ✗ |
| BASELINE | ✗ | ✗ | ✗ |
| TEST_WRITE | ✅ slice test files only | ✗ | ✗ |
| VERIFY_RED / VERIFY_GREEN | ✗ (run only) | ✗ | ✗ |
| IMPL | ✗ | ✅ only `allowedProductionPaths` after valid redProof | escape-hatch only |
| REFACTOR | ✅ (clears RED) | ✅ slice-scoped (green-gated) | escape-hatch only |
| INSPECT / ARCH_GATE / REGRESSION_GATE | ✗ | ✗ | ✗ |
| REPORT | only `.opencode/android-tdd/reports/<workflowId>.md` | ✗ | ✗ |

Recovery tools (all logged to the audit ledger): `tdd_abort_slice`, `tdd_replan`,
`tdd_reset_workflow`, `tdd_takeover_stale_lock`, `tdd_explain_block`.

---

## 4. RED classifier — spike-proven, resolves **Blockers #8, #9**

**Proven 6/6 against real `VeroAndroid :common:regex` output** (see
`SPIKE-red-classifier.md`). Pure, deterministic, fail-closed. Classes:
`GREEN | RED_ASSERTION | RED_MISSING_SYMBOL | BROKEN_TEST | NO_TESTS_RUN |
ENV_FAILURE` (+ `FLAKY_RED` from the retry policy).

Spike-derived hard rules now part of the contract:

1. **Exit code is never trusted alone.** Wrong-JDK ENV_FAILURE exits 1 just like a
   real RED. Classification is driven by Gradle **task identity** + diagnostics +
   fresh JUnit XML, not the exit code.
2. **Compile failure ≠ test failure.** `> Task :mod:compile*Kotlin FAILED` means the
   test phase was never reached → `RED_MISSING_SYMBOL` or `BROKEN_TEST` only.
   `There were failing tests` → `RED_ASSERTION` path.
3. **`RED_MISSING_SYMBOL` is granted only when *every* blocking `e:` diagnostic is an
   unresolved reference to a pre-declared `expectedSymbol` in a slice test file.**
   Any unrelated symbol, type mismatch, syntax error, or generated-dir (Hilt/KSP/
   Room) diagnostic ⇒ `BROKEN_TEST`. The adversarial "same output, no declared
   target" case correctly stays `BROKEN_TEST`.
4. **`RED_ASSERTION` only for assertion-style failures** (JUnit `<failure>` / known
   assertion types) in a slice test. Unexpected exceptions (`<error>`, NPE,
   classloader) ⇒ `BROKEN_TEST`.
5. **Stale XML defense:** filter JUnit reports by `mtime ≥ runStart`; always run
   `--rerun-tasks --console=plain`; missing XML after a "successful" test task ⇒
   `NO_TESTS_RUN`/`ENV_FAILURE`, never inferred GREEN.
6. **Toolchain discovery is a prerequisite.** `tdd_doctor` resolves a real JDK
   (`javac` present — a JRE-only `JAVA_HOME` fails before compilation, observed live)
   and records `toolchainId`. A toolchain problem is `ENV_FAILURE`, never RED.
7. **Task/source-set discovery before planning** (Blocker #9): query Gradle for the
   real test task + source set per module; each slice carries
   `module + sourceSet + variant + concrete testTask`. No hardcoded
   `testDebugUnitTest`; KMP/instrumented/flavor → `UNSUPPORTED`.
8. **Flaky/timeout:** never unlock IMPL. A timeout is a distinct diagnostic state;
   repeatable failure identity is required, else `FLAKY_RED`/`BROKEN_TEST` with a
   retry-once policy. ENV_FAILURE retried once before surfacing.

Only `RED_ASSERTION` and `RED_MISSING_SYMBOL` set `redProof`.

---

## 5. Build-edit escape hatch (constrained) — resolves Major #11/#34

Build edits are **denied by default**. When needed (e.g. add a test dependency,
create a missing test source set), `tdd_allow_build_edit` requires:

- A **validator** on the proposed diff. Allowed: add test dependency, create test
  source set, enable an existing test plugin. **Forbidden** (require explicit human
  override): `enabled = false`, `exclude`, test filters, source-set redirection,
  generated-source rewiring, compiler-suppression flags, task-graph manipulation.
- `buildSrc` / `build-logic` / convention plugins / included builds are classified
  as **build-logic** (stronger gate than ordinary module build files).
- **Any accepted build edit invalidates all redProof/greenProof** for the workflow.

---

## 6. Path classification (resolves Majors #14/#15)

Classify by **Gradle source-set ownership**, not string heuristics:

- Resolve realpaths first; reject writes that cross a bucket boundary via symlink /
  `../` / case / hardlink.
- Production = compiled into the module's main artifact (incl. generated-source
  roots wired into production compilation).
- Test = the resolved unit-test source set for the slice's variant.
- Anything ambiguous ⇒ treated as production (fail closed).

A fast heuristic pre-filter (`src/main`, `*Test.kt`, etc.) is allowed only as an
*optimization* that must agree with the source-set resolution; on disagreement, the
authoritative source-set answer wins.

---

## 7. Plugin tools (deterministic, self-evidencing) — resolves Major #40

Custom tools never trust model claims; each validates phase/slice/stateVersion/
hashes and produces its own evidence.

| Tool | Role |
|---|---|
| `tdd_doctor` | toolchain + support-matrix check; refuse unsupported projects |
| `tdd_start` | allocate `workflowId`, leave INACTIVE→DOCTOR |
| `tdd_status` | current phase/slice/proof summary (read ledger) |
| `tdd_plan_set` | validate + store slices (reject repo-wide wildcards; require module+sourceSet+symbols+test files) |
| `tdd_baseline` | record pre-existing failures for a slice's test task |
| `tdd_run` | targeted Gradle run + classify (the §4 classifier); writes `runId` evidence |
| `tdd_verify_red` | atomically run+classify; set `redProof` only on RED_* |
| `tdd_verify_green` | atomically run+classify the *slice* tests; require GREEN substance |
| `tdd_quality` | detekt/ktlint/lint per config |
| `tdd_arch_check` | ast-grep packs (advisory in v1) |
| `tdd_allow_build_edit` | validated build-edit escape hatch (§5) |
| `tdd_expand_scope` | widen slice scope; forces RED re-verification |
| `tdd_abort_slice` / `tdd_replan` / `tdd_reset_workflow` / `tdd_takeover_stale_lock` / `tdd_explain_block` | recovery |
| `tdd_report` | render report into the plugin-owned report path |

`tdd_verify_*` **internally execute and classify** rather than trusting a prior
`lastRun`, binding verification to the latest run for the same slice + stateVersion +
hashes (resolves Major #10).

---

## 8. State, memory, audit (resolves Majors #38/#43)

- `.opencode/android-tdd/state.json` — current state only (gitignored); atomic +
  versioned + locked (§2.3).
- `.opencode/android-tdd/ledger.jsonl` — **append-only audit**: every transition,
  blocked write, build escape, run command, classifier evidence, hashes, recovery.
- `.opencode/android-tdd/memory.md` — durable project facts (arch, module graph, DI,
  UI tech, test stack, conventions, fakes, gradle commands), plugin-owned. **Never
  auto-edits tracked `AGENTS.md`.** Staleness: hash `settings.gradle*` +
  `libs.versions.toml` + module-build files; drift ⇒ re-run CONTEXT.

---

## 9. Agents (resolves Platform #5, Major #39)

Plugins **cannot** register agents. The package bundles four `.md` agents and the
plugin **copies them into `.opencode/agent/` on init** — idempotent, checksum-based,
never overwriting user edits (writes only if absent or plugin-owned-and-unchanged).

1. **`android-tdd`** (primary orchestrator) — runs the phase machine via `tdd_*`
   tools; holds **no** hardcoded architecture law (reads detected conventions).
2. **`tdd-context`** (read-only) — project analysis → writes `memory.md` (plugin-
   owned metadata write, not arbitrary repo files).
3. **`tdd-inspector`** (read-only) — final review.
4. **`tdd-regression`** (read-only, optional) — impact analysis.

Architecture rule packs are **opt-in / disabled by default**; opinionated Clean/MVI
rules are never universal law.

---

## 10. Hooks used (source-verified signatures)

- `tool.execute.before` — the gate (§2.1–2.4); throws to deny (surfaces to model as
  a prescriptive tool error per §11).
- `tool.execute.after` — release gate lease; capture `tdd_run` evidence.
- `experimental.chat.system.transform` — inject phase banner + deny rule every turn
  (turn-1 coverage, §2.2).
- `event` — session idle/end: flush ledger, release stale leases.

---

## 11. Block-message UX (resolves Major #32)

Every denial returns a prescriptive message, not a bare error:

```
TDD gate: write to `app/src/main/.../Foo.kt` denied.
  phase   = TEST_WRITE  (production edits not allowed yet)
  reason  = no verified failing test for slice "email-validation"
  allowed = edit slice test files; then call tdd_run, then tdd_verify_red
  next    = tdd_verify_red(sliceId="email-validation")
```

---

## 12. Build order (de-risked)

1. ✅ **RED classifier + fixtures** — DONE (spike, 6/6). Port `.mjs` learnings into
   `src/gradle/classifier.ts` (already mirrored) + unit tests from the fixtures.
2. **Gradle discovery** (`tdd_doctor`): toolchain (JDK w/ `javac`), module/source-set/
   test-task graph, support-matrix refusal.
3. **Ledger + versioned/locked state + phase machine** (§2.3, §3, §8).
4. **Fail-closed gate** (`tool.execute.before`) with bucket allowlist + lease +
   slice-scoped redProof (§2.1, §2.4).
5. **`system.transform` banner + bootstrap deny** (§2.2).
6. **`tdd_*` tools** wired to classifier + CAS transitions (§7).
7. **Anti-cheat**: baseline, fingerprints, immediate-GREEN, build-edit validator
   (§2.5, §5).
8. **Agent copy-on-init + the 4 agents** (§9).
9. **Quality + arch packs (advisory)**, **regression gate**, **report**.
10. **Dogfood**: the plugin's own classifier is TDD'd against the fixtures.

---

## 13. Blocker resolution map

| Blocker | Resolved in |
|---|---|
| #1 fail-open mutation | §2.1 fail-closed allowlist |
| #2 turn-1 gap | §2.2 bootstrap deny + system.transform |
| #3 state races | §2.3 atomic + versioned + locked |
| #4 decision↔exec TOCTOU | §2.3 gate lease |
| #5 sessionID scoping | §2.3 worktree+workflowId, subagents read-only |
| #6 coarse redProof | §2.4 hash-bound structured proof |
| #7 IMPL unlocks whole tree | §2.4 slice-scoped paths/symbols |
| #8 classifier wrong-reason | §4 spike-proven rules |
| #9 hardcoded test task | §4.7 Gradle discovery + support matrix §1 |
| #10 anti-cheat | §2.5 baseline + fingerprints + substance |
