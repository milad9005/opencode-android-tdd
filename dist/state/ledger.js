/**
 * Append-only audit ledger (SPEC-v2 §8 / Major #43). Records every security-
 * relevant event so a gate decision is always explainable after the fact:
 * phase transitions, blocked writes, build escapes, run evidence, hashes, and
 * recovery actions. Distinct from state.json (current state only); the ledger
 * is the history. Append-only: never rewritten, only appended (atomic appends).
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
export class Ledger {
    path;
    constructor(worktree) {
        const dir = join(worktree, ".opencode", "android-tdd");
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        this.path = join(dir, "ledger.jsonl");
    }
    append(entry) {
        const full = { ts: Date.now(), ...entry };
        appendFileSync(this.path, JSON.stringify(full) + "\n");
    }
    readAll() {
        if (!existsSync(this.path))
            return [];
        return readFileSync(this.path, "utf8")
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => JSON.parse(l));
    }
    /** Most recent entries, newest last. */
    tail(n) {
        const all = this.readAll();
        return all.slice(Math.max(0, all.length - n));
    }
}
