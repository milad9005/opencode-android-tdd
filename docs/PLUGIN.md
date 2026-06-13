# Plugin Entry — `src/index.ts`

Wires the tested modules into the real `@opencode-ai/plugin` hooks. This is the
loadable plugin; everything before it was pure logic + spikes.

## Hooks wired (signatures source-verified against SDK v1.17.4)

| Hook | Role |
|---|---|
| `tool.execute.before` | Calls `decideGate()`. **DENY → throw** (opencode surfaces it to the model as a tool error, `prompt.ts:421-455`). On ALLOW of a guarded mutator, acquires a gate lease under the worktree lock. Logs WRITE_BLOCKED / WRITE_ALLOWED. |
| `tool.execute.after` | Releases the gate lease iff `callID` matches — closes the decision↔execution window (Blocker #4). |
| `chat.message` | Records `sessionID → agent`. The before-hook has no agent field, so this is how subagents are identified. |
| `experimental.chat.system.transform` | Pushes the phase banner into the system prompt **every turn** — the reliable turn-1 channel given the tool-hook gap (issue #6862). |

## Turn-1 / bootstrap (Blocker #2)

A fresh project has no workflow → `decideGate` denies all mutators and the banner
says INACTIVE. Even if `tool.execute.before` does not fire on the very first
message, the worst case is the model attempting a write that the *bootstrap deny*
(no-workflow / not-activated state) rejects. The banner is injected on turn 1 via
`system.transform`, which is confirmed to fire every turn.

## Subagent read-only (Blocker #5)

`chat.message` carries the agent name; the plugin maps each session to its agent.
Any session whose agent ≠ `android-tdd` (the primary orchestrator) is treated as a
subagent and held to the read-only bucket regardless of phase — so the inspector /
context / regression agents can never mutate.

## Lease lifecycle

`before` (ALLOW + guarded mutator) → `acquireLease(callID, tool, filePath, phase)`
under the lock → … the edit runs … → `after` → `releaseLease(callID)`. While held,
`decideGate` denies any other mutator and the phase machine refuses transitions.

## Verification

`spike/run-plugin.mjs` invokes the **real exported hooks** against the real
filesystem — **13/13**:

- bootstrap deny (write throws with no workflow); read / `tdd_*` never throw
- banner reflects INACTIVE → TEST_WRITE → IMPL (incl. "Verified RED")
- subagent write throws even in TEST_WRITE
- ALLOW acquires a lease; a second mutator throws while held; `after` releases it
- IMPL prod write allowed with valid redProof; IMPL test edit denied (anti-cheat)

`tsc` clean. Full regression green: classifier 7/7, doctor 5/5, machine 15/15,
gate 24/24, plugin 13/13. Run all via `npm run spike`.

## Install (once published)

```jsonc
// opencode.json
{ "plugin": ["opencode-android-tdd"] }   // or "github:you/opencode-android-tdd"
```

`package.json` `main`/`types` → `dist/index.js` / `dist/index.d.ts`;
default export + named `AndroidTddPlugin`.
