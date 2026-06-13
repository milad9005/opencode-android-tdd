# Fail-Closed Gate — the security boundary

Implements SPEC-v2 §2.1-2.4, §6 — the `tool.execute.before` decision that makes
the TDD invariant real. Resolves **Blockers #1** (fail-open mutation), **#2**
(turn-1 deny via bootstrap), **#5** (subagent read-only), **#6/#7** (redProof
drift + slice-scoping).

## Modules

| File | Role |
|---|---|
| `src/gate/buckets.ts` | Tool → bucket via **allow-list** (read-only / plugin-owned / guarded-mutator / denied). Unknown/MCP/`bash`/`patch`/`move`/`delete` ⇒ denied by default. |
| `src/gate/paths.ts` | Path → bucket (test / main / build / build-logic / other). Realpath resolution + symlink/`..` bucket-escape detection. Ambiguous ⇒ production (fail closed). |
| `src/gate/hash.ts` | SHA-256 file + build-config hashing; `detectDrift()` for redProof invalidation. Missing file ⇒ detectable drift. |
| `src/gate/decide.ts` | Pure `decideGate()` → ALLOW/DENY + prescriptive message. The hook wrapper does I/O; the decision is pure and fully testable. |

## Decision order (fails closed at every step)

1. **read-only** → ALLOW (incl. all subagent work).
2. **subagent + mutator** → DENY (subagents are read-only always).
3. **plugin-owned `tdd_*`** → ALLOW (only path to Gradle/transitions).
4. **no workflow / not activated** → DENY (turn-1 bootstrap deny).
5. **another gate lease held** → DENY (decision↔exec atomicity).
6. **not a guarded mutator** → DENY (allow-list default; `bash`/unknown).
7. **symlink/`..` bucket-escape** → DENY.
8. **build / build-logic** → DENY (use `tdd_allow_build_edit` hatch).
9. **phase permits no writes** → DENY with next-action.
10. **REPORT** → only the report path.
11. **TEST_WRITE** → only the slice's declared test files.
12. **IMPL** → requires non-drifted redProof; production writes restricted to
    slice `allowedProductionPaths`; **test edits denied** (anti-cheat).
13. **REFACTOR** → green-gated, slice-scoped.
14. default → DENY.

## Verification

`spike/run-gate.mjs` — **24/24** against the real filesystem using the compiled
`dist/` modules. Covers every branch incl. the security-critical ones:

- unknown tool denied (fail-closed allow-list)
- bash / patch / move / delete denied
- bootstrap deny (no workflow / not activated)
- subagent mutation denied, subagent read allowed
- lease blocks a second mutator
- TEST_WRITE / IMPL / REFACTOR scope enforcement
- **IMPL test-edit anti-cheat** denied
- **redProof drift** (edited slice test) invalidates IMPL
- **symlink test→main bucket-escape** denied
- build / build-logic edits routed to the hatch

`tsc --noEmit` clean. All four spikes regression-green
(classifier 7/7, doctor 5/5, machine 15/15, gate 24/24).
