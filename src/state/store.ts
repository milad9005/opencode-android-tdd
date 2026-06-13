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

import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WorkflowState } from "./types.js";

const STALE_LOCK_MS = 5 * 60 * 1000;

export class CasConflictError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`State version conflict: expected v${expected}, found v${actual}. Re-read and retry.`);
    this.name = "CasConflictError";
  }
}

export class LockHeldError extends Error {
  constructor(public holder: LockInfo) {
    super(`Worktree lock held by ${holder.owner} since ${new Date(holder.acquiredAt).toISOString()}.`);
    this.name = "LockHeldError";
  }
}

interface LockInfo {
  owner: string; // lock token
  acquiredAt: number;
}

export class StateStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly token: string;

  constructor(worktree: string, ownerToken?: string) {
    this.dir = join(worktree, ".opencode", "android-tdd");
    this.statePath = join(this.dir, "state.json");
    this.lockPath = join(this.dir, "state.lock");
    this.token = ownerToken ?? randomBytes(8).toString("hex");
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  get ownerToken(): string {
    return this.token;
  }

  exists(): boolean {
    return existsSync(this.statePath);
  }

  read(): WorkflowState | undefined {
    if (!existsSync(this.statePath)) return undefined;
    return JSON.parse(readFileSync(this.statePath, "utf8")) as WorkflowState;
  }

  private atomicWrite(state: WorkflowState): void {
    const tmp = `${this.statePath}.${this.token}.${randomBytes(4).toString("hex")}.tmp`;
    const json = JSON.stringify(state, null, 2);
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.statePath);
  }

  private readLock(): LockInfo | undefined {
    if (!existsSync(this.lockPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8")) as LockInfo;
    } catch {
      return undefined;
    }
  }

  private lockIsStale(lock: LockInfo, now: number): boolean {
    return now - lock.acquiredAt > STALE_LOCK_MS;
  }

  /** Acquire the worktree lock. Fails closed if held by another live owner. */
  acquireLock(opts: { takeoverStale?: boolean } = {}): void {
    const now = Date.now();
    const existing = this.readLock();
    if (existing && existing.owner !== this.token) {
      if (!this.lockIsStale(existing, now) || !opts.takeoverStale) {
        throw new LockHeldError(existing);
      }
    }
    const info: LockInfo = { owner: this.token, acquiredAt: now };
    const tmp = `${this.lockPath}.${this.token}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSync(tmp, this.lockPath);
  }

  releaseLock(): void {
    const existing = this.readLock();
    if (existing && existing.owner === this.token && existsSync(this.lockPath)) {
      rmSync(this.lockPath, { force: true });
    }
  }

  holdsLock(): boolean {
    const l = this.readLock();
    return Boolean(l && l.owner === this.token);
  }

  /**
   * Compare-and-swap commit: write `next` only if the on-disk stateVersion still
   * equals `expectedVersion`. Bumps stateVersion. Requires the lock be held.
   */
  commit(expectedVersion: number, next: WorkflowState): WorkflowState {
    if (!this.holdsLock()) {
      throw new Error("commit() requires the worktree lock; call acquireLock() first.");
    }
    const current = this.read();
    const onDisk = current?.stateVersion ?? 0;
    if (onDisk !== expectedVersion) {
      throw new CasConflictError(expectedVersion, onDisk);
    }
    const committed: WorkflowState = {
      ...next,
      stateVersion: expectedVersion + 1,
      updatedAt: Date.now(),
    };
    this.atomicWrite(committed);
    return committed;
  }

  /** Initialize a brand-new workflow (version 0 → 1) under the lock. */
  init(state: WorkflowState): WorkflowState {
    if (!this.holdsLock()) {
      throw new Error("init() requires the worktree lock; call acquireLock() first.");
    }
    if (this.exists()) {
      throw new Error("State already exists; refusing to overwrite. Use commit() with CAS.");
    }
    const committed: WorkflowState = { ...state, stateVersion: 1, updatedAt: Date.now() };
    this.atomicWrite(committed);
    return committed;
  }

  lockAgeMs(): number | undefined {
    const l = this.readLock();
    if (!l) return undefined;
    return Date.now() - l.acquiredAt;
  }
}
