# opencode-android-tdd

A code-enforced Test-Driven Development gate for Android/Kotlin Gradle projects,
packaged as an [OpenCode](https://opencode.ai) plugin.

It does not *ask* the model to follow TDD — it **makes** it. A plugin hook blocks
every production-code write until a *correctly failing* test has been verified by
running real Gradle. The model coordinates the workflow; it cannot talk its way past
the gate, and it cannot mutate production code through any path the plugin does not own.

> Status: v0.1 — functionally complete and validated end-to-end against a real
> multi-module Android project. See the support matrix before using.

## Why

LLMs told "write the test first" will skip it under pressure. This plugin removes the
choice: the TDD invariant is enforced as a **security boundary** in code, not in a prompt.

- **No production code before a verified RED.** A failing test must exist *and fail for
  the right reason* (the plugin classifies real Gradle/Kotlin output) before any
  `src/main` write is permitted.
- **Slice-scoped.** A verified RED unlocks only the files and symbols that slice declared.
- **Anti-cheat.** Baseline-new failures only; assertion fingerprints frozen at RED;
  build edits validated and proof-invalidating; immediate-GREEN flagged, not accepted.

## Install

Requires OpenCode and a JDK with `javac` on the machine (a JRE-only `JAVA_HOME` fails;
the plugin auto-detects a real JDK, including Android Studio's bundled JBR).

```jsonc
// opencode.json
{
  "plugin": ["opencode-android-tdd"]
}
```

On first load the plugin installs four agents into `.opencode/agent/` (idempotent;
never overwrites your edits). Then drive work with the `android-tdd` agent:

```
opencode --agent android-tdd
> Add an email validator to :feature:register
```

## The cycle

The `android-tdd` orchestrator runs every change through:

```
Understand → Plan (small slices) → Baseline → Write failing test
  → Verify RED → Implement minimum → Verify GREEN → Refactor → Inspect → Report
```

Each step is a `tdd_*` tool that produces its own evidence by running Gradle. The
phase machine and gate enforce the order; you cannot reach IMPL without a verified RED.

## Support matrix (v1)

| Supported | Not yet (detected and refused, never mishandled) |
|---|---|
| Single & multi-module Gradle | Kotlin Multiplatform source sets |
| JVM library modules (`test`) | Instrumented tests (`androidTest`) |
| Android unit tests (`testDebugUnitTest`) | Build flavors beyond the default debug variant |
| JUnit4/5, Robolectric, MockK, Turbine, Kotlin K1/K2 | Non-Gradle builds |

`tdd_doctor` reports `UNSUPPORTED` with the reason before any work starts.

## How the gate works

- **`tool.execute.before`** classifies every tool into an allow-list bucket
  (read-only / plugin-owned `tdd_*` / guarded `write`+`edit` / **denied**). `bash`,
  `patch`, `move`, `delete`, and unknown tools are denied — all builds/tests run
  through `tdd_*`, so the plugin's classifier is the only arbiter of pass/fail.
- A **gate lease** taken in `before` and released in `after` closes the window between
  approving a write and the edit landing.
- **`experimental.chat.system.transform`** injects the current phase + what's editable
  into the system prompt every turn (covers the first-message hook gap).
- State is keyed by **worktree + workflow** (not session, so subagents stay read-only),
  persisted atomically with compare-and-swap versioning and a per-worktree lock.

## Tools

`tdd_start` · `tdd_doctor` · `tdd_status` · `tdd_plan_set` · `tdd_baseline` · `tdd_run`
· `tdd_verify_red` · `tdd_verify_green` · `tdd_inspect_done` · `tdd_quality`
· `tdd_arch_check` · `tdd_allow_build_edit` · `tdd_expand_scope` · `tdd_abort_slice`
· `tdd_reset_workflow` · `tdd_takeover_stale_lock` · `tdd_explain_block` · `tdd_report`

## Agents

- **`android-tdd`** (primary) — drives the cycle; holds no hardcoded architecture
  doctrine (reads your project's conventions).
- **`tdd-context`**, **`tdd-inspector`**, **`tdd-regression`** — read-only subagents
  for project survey, post-GREEN review, and impact analysis.

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
