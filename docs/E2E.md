# End-to-End Validation — live plugin against real VeroAndroid Gradle

The one thing every other spike could not prove: the **whole plugin driving a
real TDD slice against real Gradle**, not fakes or fixtures. `spike/run-e2e-vero.mjs`
does exactly that.

## What it ran

Target: real `VeroAndroid :common:regex` (AGP + Hilt + KSP, Robolectric, Kotlin K2,
Gradle 8.14.3), JBR 21 toolchain. One slice introducing a new production symbol
`EmailRegexProvider`, driven through the **live `createTools()` surface** with a
real `execFileSync`-backed shell:

```
tdd_start → tdd_doctor(:common:regex)=READY → tdd_plan_set(email slice)
  → tdd_baseline                (real gradle)
  → [write failing test referencing EmailRegexProvider]
  → tdd_verify_red              (real gradle compile) ⇒ RED_MISSING_SYMBOL → IMPL
  → [write minimal EmailRegexProvider]
  → tdd_verify_green            (real gradle test)    ⇒ GREEN → REFACTOR
```

## Result — 7/7

```
PASS  toolchain resolved (real JDK)
PASS  doctor READY
PASS  plan set, phase BASELINE
PASS  baseline done, phase TEST_WRITE
PASS  verify_red => RED_MISSING_SYMBOL, phase IMPL
PASS  verify_green => GREEN, phase REFACTOR
PASS  ledger has RED_VERIFIED + GREEN_VERIFIED
VERO tree clean (no tracked changes from E2E).
```

The real Kotlin compiler emitted
`Unresolved reference 'EmailRegexProvider'` on the failing task
`compileDebugUnitTestKotlin` → the classifier returned `RED_MISSING_SYMBOL` and the
machine advanced to IMPL with a hash-bound redProof. After the minimal
implementation, the real test ran GREEN and the machine advanced to REFACTOR. The
ledger captured the real RED→GREEN cycle.

## Safety

All slice files (temp test + impl) and the temp state dir were removed in `finally`;
`git status common/regex` confirmed **no tracked changes**. VeroAndroid was driven,
never modified.

## Significance

This closes the last validation gap. Every layer — toolchain discovery, support
matrix, the RED classifier, the phase machine + CAS state, the fail-closed gate,
the `tdd_*` tools — has now executed together against a real multi-module Android
project with real Gradle, end to end.
