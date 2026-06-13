/**
 * Append-only audit ledger (SPEC-v2 §8 / Major #43). Records every security-
 * relevant event so a gate decision is always explainable after the fact:
 * phase transitions, blocked writes, build escapes, run evidence, hashes, and
 * recovery actions. Distinct from state.json (current state only); the ledger
 * is the history. Append-only: never rewritten, only appended (atomic appends).
 */
import type { Phase } from "./types.js";
export type LedgerEventType = "WORKFLOW_INIT" | "PHASE_TRANSITION" | "WRITE_ALLOWED" | "WRITE_BLOCKED" | "RUN" | "RED_VERIFIED" | "GREEN_VERIFIED" | "PROOF_INVALIDATED" | "BUILD_EDIT_ALLOWED" | "SCOPE_EXPANDED" | "LEASE_ACQUIRED" | "LEASE_RELEASED" | "RECOVERY" | "LOCK_TAKEOVER";
export interface LedgerEntry {
    ts: number;
    workflowId: string;
    stateVersion: number;
    type: LedgerEventType;
    phase: Phase;
    sliceId?: string;
    detail: Record<string, unknown>;
}
export declare class Ledger {
    private readonly path;
    constructor(worktree: string);
    append(entry: Omit<LedgerEntry, "ts">): void;
    readAll(): LedgerEntry[];
    /** Most recent entries, newest last. */
    tail(n: number): LedgerEntry[];
}
