/**
 * Append-only audit ledger (SPEC-v2 §8 / Major #43). Records every security-
 * relevant event so a gate decision is always explainable after the fact:
 * phase transitions, blocked writes, build escapes, run evidence, hashes, and
 * recovery actions. Distinct from state.json (current state only); the ledger
 * is the history. Append-only: never rewritten, only appended (atomic appends).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "./types.js";

export type LedgerEventType =
  | "WORKFLOW_INIT"
  | "PHASE_TRANSITION"
  | "WRITE_ALLOWED"
  | "WRITE_BLOCKED"
  | "RUN"
  | "RED_VERIFIED"
  | "GREEN_VERIFIED"
  | "PROOF_INVALIDATED"
  | "BUILD_EDIT_ALLOWED"
  | "SCOPE_EXPANDED"
  | "LEASE_ACQUIRED"
  | "LEASE_RELEASED"
  | "RECOVERY"
  | "LOCK_TAKEOVER";

export interface LedgerEntry {
  ts: number;
  workflowId: string;
  stateVersion: number;
  type: LedgerEventType;
  phase: Phase;
  sliceId?: string;
  detail: Record<string, unknown>;
}

export class Ledger {
  private readonly path: string;

  constructor(worktree: string) {
    const dir = join(worktree, ".opencode", "android-tdd");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.path = join(dir, "ledger.jsonl");
  }

  append(entry: Omit<LedgerEntry, "ts">): void {
    const full: LedgerEntry = { ts: Date.now(), ...entry };
    appendFileSync(this.path, JSON.stringify(full) + "\n");
  }

  readAll(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  /** Most recent entries, newest last. */
  tail(n: number): LedgerEntry[] {
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - n));
  }
}
