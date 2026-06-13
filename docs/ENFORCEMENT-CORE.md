# Enforcement Core — Ledger + Versioned/Locked State + Phase Machine

Implements SPEC-v2 §2.3, §3, §8 — the foundation the gate and all `tdd_*` tools
build on. Resolves **Blockers #3** (state races) and **#4** (decision↔execution
TOCTOU), and provides the audit trail for Major #43.

## Modules

| File | Role |
|---|---|
| `src/state/types.ts` | `WorkflowState`, `Phase`, `Slice`, `RedProof`, `GateLease`. Keyed by worktree+workflowId, **never sessionID** (subagents get child sessions). |
| `src/state/store.ts` | Atomic versioned store: temp→`fsync`→`rename`; `stateVersion` compare-and-swap; per-worktree lock with stale-lease + explicit takeover. |
| `src/state/ledger.ts` | Append-only JSONL audit (transitions, blocks, runs, lease events, recovery). Distinct from `state.json` (current state only). |
| `src/machine.ts` | Phase machine: allowed-transitions table + CAS-guarded `advance()` + lease acquire/release. Refuses transitions while a mutator lease is held. |

## Guarantees enforced (all fail closed)

- **Atomic writes** — no torn JSON on crash/race (temp-file + fsync + rename).
- **CAS on every mutation** — `commit(expectedVersion, next)` throws
  `CasConflictError` if the on-disk version moved; the caller must re-read, never
  blindly overwrite.
- **Per-worktree lock** — a second concurrent writer throws `LockHeldError`;
  stale-lease takeover is explicit and refused while the lock is fresh.
- **Gate lease blocks transitions** — while a mutator lease is held, `advance()`
  and a second `acquireLease()` both throw `LeaseHeldError`, closing the window
  between the gate approving a write and the edit actually landing.
- **Illegal transitions rejected** — `advance()` validates against the table;
  state is left untouched on rejection.
- **Everything audited** — every transition/lease event appended to the ledger.

## Allowed transitions

```
INACTIVE→DOCTOR→CONTEXT→CLARIFY→PLAN→BASELINE→TEST_WRITE→VERIFY_RED
VERIFY_RED→{IMPL | TEST_WRITE}        (RED_* unlocks IMPL; else re-write test)
IMPL→VERIFY_GREEN→{REFACTOR | IMPL}   (green advances; still-red returns)
REFACTOR→{VERIFY_GREEN | INSPECT | TEST_WRITE}
INSPECT→{BASELINE | ARCH_GATE}        (next slice, or finish)
ARCH_GATE→REGRESSION_GATE→REPORT→DONE
```

## Verification

`spike/run-machine.mjs` exercises the **real compiled modules** against the real
filesystem — **15/15 pass**: happy-path transitions, illegal-transition rejection,
CAS-conflict fail-closed, lock contention + stale takeover, lease-blocks-transition,
and append-only ledger capture. `tsc --noEmit` clean.
