# Build-Edit Hatch, Scope Tools & Agent Install (Steps 7-8)

## Step 7 — constrained build-edit hatch + scope tools (SPEC-v2 §5, §2.4)

### `src/gradle/buildedit.ts` — diff validator
Build files (`build.gradle*`, settings, version catalog, `buildSrc`/`build-logic`)
are denied by the gate. `validateBuildEdit()` is the only path that may permit one,
and it **fails closed**: it reasons over the ADDED lines and only allows narrow
categories.

| Allowed | Forbidden (rejects the whole edit) |
|---|---|
| add test dependency (`testImplementation` etc.) | `enabled = false` |
| enable a known test plugin (junit/robolectric/kotlin.test) | `exclude`, test filters |
| create a test source set | `ignoreFailures = true` |
| | source-set redirection (`srcDirs`/`sourceSets`) |
| | `ksp`/`kapt`/`annotationProcessor`/generated rewiring |
| | compiler suppression (`-Xsuppress`, `freeCompilerArgs`) |
| | task-graph (`dependsOn`/`finalizedBy`/`onlyIf`/`tasks.*`) |
| | `testOptions`/`unitTests` manipulation |
| | anything unrecognized |

### Tools
- **`tdd_allow_build_edit`** — validates the proposed content; FORBIDDEN throws
  (file untouched); ALLOWED writes the file itself under the lock and **invalidates
  all proofs** (§5), returning to TEST_WRITE if mid-IMPL/REFACTOR.
- **`tdd_expand_scope`** — widens the active slice's production paths/symbols
  (rejects wildcards), clears the redProof, and forces RED re-verification.

**Verified:** `spike/run-buildedit.mjs` — **23/23** (11 validator cases incl. every
forbidden lever, plus end-to-end forbidden-throws / allowed-writes-and-voids-proofs
/ scope-expansion-clears-proof).

## Step 8 — agents + copy-on-init (SPEC-v2 §9)

### Bundled agents (`src/agents/*.md`)
- **`android-tdd`** (primary) — drives the cycle via `tdd_*` tools; `bash: deny`;
  holds no hardcoded architecture doctrine (reads detected conventions).
- **`tdd-context`** (subagent, `edit: deny`) — read-only project survey before
  planning.
- **`tdd-inspector`** (subagent, `edit: deny`) — read-only post-GREEN review.
- **`tdd-regression`** (subagent, `edit: deny`) — read-only impact analysis.

### `src/install.ts` — copy-on-init
Plugins cannot register agents, so the plugin writes these into `.opencode/agent/`
on init. Provenance is tracked in `.opencode/android-tdd/agents.manifest.json`
(hash of what we last wrote). Per agent:
- absent → **write**
- on disk == bundled → **kept-current**
- on disk == our last-written hash but bundled changed → **refresh** (version bump)
- on disk differs from both → **kept-user-modified** (never overwritten)

Build copies `src/agents/*.md` → `dist/agents/` (`script/copy-agents.mjs`);
`resolveBundledAgentsDir()` finds them in dev or published layouts. Install failure
never blocks plugin load.

**Verified:** `spike/run-install.mjs` — **9/9** (fresh install, idempotent re-run,
user-modified preserved, plugin-owned refresh on bundle change).

## Full regression
`tsc` clean; all 8 spikes green: classifier 7/7, doctor 5/5, machine 15/15,
gate 24/24, plugin 13/13, tools 15/15, buildedit 23/23, install 9/9.
Run via `npm run spike`.
