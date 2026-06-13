/**
 * Atomic, versioned, locked state store (SPEC-v2 §2.3 / Blockers #3, #4).
 *
 * Guarantees:
 *  - writes are atomic: temp-file → fsync → rename (no torn JSON on crash/race).
 *  - every mutation is compare-and-swap on a monotonic `stateVersion`; a stale
 *    CAS fails closed (the caller must re-read and retry, never blindly write).
 *  - a per-worktree lock with a stale-lease timeout serializes writers; a second
 *    concurrent writer fails closed unless it explicitly takes over an expired
 *    lease.
 */
import type { WorkflowState } from "./types.js";
export declare class CasConflictError extends Error {
    expected: number;
    actual: number;
    constructor(expected: number, actual: number);
}
export declare class LockHeldError extends Error {
    holder: LockInfo;
    constructor(holder: LockInfo);
}
interface LockInfo {
    owner: string;
    acquiredAt: number;
}
export declare class StateStore {
    private readonly dir;
    private readonly statePath;
    private readonly lockPath;
    private readonly token;
    constructor(worktree: string, ownerToken?: string);
    get ownerToken(): string;
    exists(): boolean;
    read(): WorkflowState | undefined;
    private atomicWrite;
    private readLock;
    private lockIsStale;
    /** Acquire the worktree lock. Fails closed if held by another live owner. */
    acquireLock(opts?: {
        takeoverStale?: boolean;
    }): void;
    releaseLock(): void;
    holdsLock(): boolean;
    /**
     * Compare-and-swap commit: write `next` only if the on-disk stateVersion still
     * equals `expectedVersion`. Bumps stateVersion. Requires the lock be held.
     */
    commit(expectedVersion: number, next: WorkflowState): WorkflowState;
    /** Initialize a brand-new workflow (version 0 → 1) under the lock. */
    init(state: WorkflowState): WorkflowState;
    lockAgeMs(): number | undefined;
}
export {};
