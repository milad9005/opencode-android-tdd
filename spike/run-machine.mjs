// Validates the enforcement core (store + ledger + phase machine) against the
// REAL filesystem using the actual compiled modules from dist/. Exercises:
//   - happy-path phase transitions
//   - illegal transition rejected
//   - CAS conflict fails closed
//   - worktree lock contention fails closed; stale-lease takeover works
//   - gate lease blocks phase transitions until released
//   - ledger records every event append-only

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStore, CasConflictError, LockHeldError } from "../dist/state/store.js";
import { Ledger } from "../dist/state/ledger.js";
import { PhaseMachine, IllegalTransitionError, LeaseHeldError } from "../dist/machine.js";
import { initialState } from "../dist/state/types.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${extra}`); }
};
const threw = (fn, Ctor) => {
  try { fn(); return false; } catch (e) { return e instanceof Ctor; }
};

const wt = mkdtempSync(join(tmpdir(), "tdd-machine-"));
try {
  // --- init under lock ---
  const store = new StateStore(wt);
  const ledger = new Ledger(wt);
  store.acquireLock();
  let s = store.init(initialState(wt, "wf1"));
  ok("init sets version 1", s.stateVersion === 1 && s.phase === "INACTIVE");
  ledger.append({ workflowId: "wf1", stateVersion: s.stateVersion, type: "WORKFLOW_INIT", phase: s.phase, detail: {} });

  const machine = new PhaseMachine(store, ledger);

  // --- happy-path transitions ---
  s = machine.advance({ to: "DOCTOR" });
  s = machine.advance({ to: "CONTEXT" });
  s = machine.advance({ to: "CLARIFY" });
  ok("happy-path advances to CLARIFY", s.phase === "CLARIFY" && s.stateVersion === 4);

  // --- illegal transition rejected ---
  ok("illegal transition throws", threw(() => machine.advance({ to: "DONE" }), IllegalTransitionError));
  ok("state unchanged after illegal transition", store.read().phase === "CLARIFY" && store.read().stateVersion === 4);

  // --- CAS conflict fails closed ---
  // simulate a stale writer holding version 4 while disk moves to 5
  const staleVersion = store.read().stateVersion;
  s = machine.advance({ to: "PLAN" }); // disk now v5
  ok("CAS conflict throws on stale expected version",
    threw(() => store.commit(staleVersion, { ...store.read(), phase: "BASELINE" }), CasConflictError));

  // --- lease blocks transitions ---
  s = machine.advance({ to: "BASELINE" });
  s = machine.advance({ to: "TEST_WRITE" });
  s = machine.acquireLease({ callID: "c1", tool: "write", filePath: `${wt}/Foo.kt`, phase: "TEST_WRITE" });
  ok("lease recorded", Boolean(store.read().activeLease));
  ok("transition blocked while lease held",
    threw(() => machine.advance({ to: "VERIFY_RED" }), LeaseHeldError));
  ok("second lease blocked while lease held",
    threw(() => machine.acquireLease({ callID: "c2", tool: "edit", filePath: `${wt}/Bar.kt`, phase: "TEST_WRITE" }), LeaseHeldError));
  s = machine.releaseLease("c1");
  ok("lease released", !store.read().activeLease);
  s = machine.advance({ to: "VERIFY_RED" });
  ok("transition works after lease release", store.read().phase === "VERIFY_RED");

  store.releaseLock();

  // --- lock contention: a second owner fails closed ---
  const storeA = new StateStore(wt, "ownerA");
  const storeB = new StateStore(wt, "ownerB");
  storeA.acquireLock();
  ok("second owner blocked by live lock", threw(() => storeB.acquireLock(), LockHeldError));
  ok("stale takeover refused when lock is fresh",
    threw(() => storeB.acquireLock({ takeoverStale: true }), LockHeldError));
  storeA.releaseLock();
  storeB.acquireLock();
  ok("owner B acquires after release", storeB.holdsLock());
  storeB.releaseLock();

  // --- ledger is append-only and captured every event ---
  const entries = ledger.readAll();
  const types = entries.map((e) => e.type);
  ok("ledger captured init + transitions + lease events",
    types.includes("WORKFLOW_INIT") && types.includes("PHASE_TRANSITION") &&
    types.includes("LEASE_ACQUIRED") && types.includes("LEASE_RELEASED"),
    JSON.stringify(types));
  ok("ledger monotonic by ts", entries.every((e, i) => i === 0 || e.ts >= entries[i - 1].ts));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  rmSync(wt, { recursive: true, force: true });
}
