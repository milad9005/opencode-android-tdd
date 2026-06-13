# tdd_* Tools — driving the Red→Green→Refactor cycle

Implements SPEC-v2 §7. These are the custom tools registered via the plugin's
`tool` hook — the only way the model advances the workflow. Each tool is
**self-evidencing**: it runs Gradle + classifies, validates phase/slice/version,
mutates via the phase machine under CAS, and logs to the ledger. None trust a
model claim like "this is green" (resolves Major #40).

## Modules

| File | Role |
|---|---|
| `src/gradle/junit.ts` | Parse `build/test-results/<task>/TEST-*.xml` → `JUnitSuite[]` with per-file mtime (stale-XML defense). |
| `src/gradle/runner.ts` | `runTargetedTest()`: `--rerun-tasks --console=plain` from the resolved JAVA_HOME, capture `runStartedMs` before launch, collect suites, feed the classifier. Execution injected via `ShellExec` (fake in spikes). |
| `src/tools.ts` | `createTools(deps)` → the `tdd_*` ToolDefinition map. |
| `src/index.ts` | `$`-backed `ShellExec` (nothrow + combined stdout/stderr), `GradleRunner`, toolchain resolution; registers tools in the `tool` hook. |

## Tool surface

| Tool | Transition / effect |
|---|---|
| `tdd_start` | INACTIVE→DOCTOR; allocate workflowId; activate. |
| `tdd_doctor` | toolchain + support matrix; READY → DOCTOR→CONTEXT. |
| `tdd_plan_set` | validate slices (reject wildcards/over-broad paths); →BASELINE. |
| `tdd_baseline` | record pre-existing failures; BASELINE→TEST_WRITE. |
| `tdd_run` | run + classify; **read-only** (no transition). |
| `tdd_verify_red` | run+classify; set hash-bound `redProof` only on baseline-new RED_*; TEST_WRITE→IMPL. |
| `tdd_verify_green` | drift-check `redProof`; require substantive GREEN; IMPL→REFACTOR or REFACTOR→INSPECT. |
| `tdd_inspect_done` | INSPECT→next slice BASELINE, or ARCH_GATE if none. |
| `tdd_abort_slice` / `tdd_reset_workflow` / `tdd_takeover_stale_lock` / `tdd_explain_block` | recovery. |
| `tdd_report` | render report → DONE. |

## Anti-cheat enforced by the tools (Blocker #10)

- **Baseline-new RED only:** `tdd_verify_red` rejects a RED_ASSERTION whose
  failing test already failed at baseline.
- **Immediate-GREEN → ALREADY_COVERED:** a new test passing without impl does not
  unlock IMPL.
- **redProof drift:** `tdd_verify_green` voids the proof and returns to TEST_WRITE
  if slice test files changed since RED.
- **Self-evidencing:** `tdd_verify_*` run+classify internally; they never accept a
  prior `lastRun` or a caller claim.

## Verification

`spike/run-tools.mjs` drives a **full slice cycle** through the real
`createTools()` with a fake Gradle runner (scripted stdout + JUnit XML; the real
classifier decides) — **15/15**:

- start→doctor→plan→baseline→TEST_WRITE
- `tdd_verify_red` with a real RED_MISSING_SYMBOL → IMPL + hash-bound redProof
- `tdd_plan_set` rejects wildcard/over-broad scope
- implement → `tdd_verify_green` → REFACTOR → (green) → INSPECT
- `tdd_inspect_done` (last slice) → ARCH_GATE; slice marked done
- `tdd_reset_workflow` → INACTIVE; `tdd_explain_block` guidance

`tsc` clean. Full regression green: classifier 7/7, doctor 5/5, machine 15/15,
gate 24/24, plugin 13/13, tools 15/15. Run all via `npm run spike`.

> Spike note: the fake shell waits ~12ms before writing JUnit XML so the file
> mtime lands after `runStartedMs` — real Gradle takes seconds, so this only
> matters for the instantaneous fake (the freshness filter is a real defense).
