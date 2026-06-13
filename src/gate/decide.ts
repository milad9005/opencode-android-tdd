/**
 * The fail-closed gate decision (SPEC-v2 §2.1-2.4 / Blockers #1, #2, #5, #6, #7).
 *
 * A PURE function: given the workflow state, the tool call, and an injected
 * drift-check, it returns ALLOW or DENY with a prescriptive next-action message.
 * The hook wrapper (tool.execute.before) does the I/O (read state, run this,
 * throw on DENY, acquire lease on ALLOW). Keeping the decision pure makes the
 * security boundary fully testable against fixtures.
 *
 * Order of checks is deliberate and fails closed at every step.
 */

import type { WorkflowState, Phase, Slice } from "../state/types.js";
import { classifyTool, isKnownDenied, type ToolBucket } from "./buckets.js";
import { classifyPath, isBucketEscape, type PathBucket } from "./paths.js";
import { detectDrift } from "./hash.js";

export type GateDecision = "ALLOW" | "DENY";

export interface GateResult {
  decision: GateDecision;
  bucket: ToolBucket;
  pathBucket?: PathBucket;
  reason: string;
  message: string;
}

export interface GateInput {
  tool: string;
  callID: string;
  /** write/edit target; absent for non-file tools */
  filePath?: string;
  worktree: string;
  state: WorkflowState | undefined;
  /** true when the call originates from a delegated subagent (read-only always) */
  isSubagent: boolean;
}

function deny(bucket: ToolBucket, reason: string, message: string, pathBucket?: PathBucket): GateResult {
  return { decision: "DENY", bucket, pathBucket, reason, message };
}
function allow(bucket: ToolBucket, reason: string, pathBucket?: PathBucket): GateResult {
  return { decision: "ALLOW", bucket, pathBucket, reason, message: "" };
}

function activeSlice(state: WorkflowState): Slice | undefined {
  return state.slices.find((s) => s.id === state.currentSliceId);
}

function pathInList(filePath: string, worktree: string, list: string[]): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const target = norm(filePath);
  return list.some((p) => {
    const n = norm(p);
    return target === n || target.endsWith("/" + n) || n.endsWith("/" + target) || target.includes(n);
  });
}

const MUTATING_PHASES: Phase[] = ["TEST_WRITE", "IMPL", "REFACTOR", "REPORT"];

export function decideGate(input: GateInput): GateResult {
  const bucket = classifyTool(input.tool);

  // 1) Read-only is always allowed (incl. all subagent work).
  if (bucket === "read-only") return allow(bucket, "read-only tool");

  // 2) Subagents are read-only ALWAYS, regardless of phase (Blocker #5).
  if (input.isSubagent) {
    return deny(
      bucket,
      "subagent-mutation",
      `TDD gate: subagents are read-only. The '${input.tool}' tool cannot mutate state from a delegated subagent. Run mutations from the primary android-tdd agent.`,
    );
  }

  // 3) Plugin-owned tools are the only path to Gradle + transitions.
  if (bucket === "plugin-owned") return allow(bucket, "plugin-owned tdd_* tool");

  // 4) No workflow / bootstrap deny: until activated, all mutators are denied
  //    (turn-1 hook gap — Blocker #2).
  if (!input.state) {
    return deny(bucket, "no-workflow", "TDD gate: no active workflow. Call tdd_start before any write/edit.");
  }
  if (!input.state.activated) {
    return deny(bucket, "not-activated", "TDD gate: workflow not activated yet. Call tdd_start to begin the TDD cycle.");
  }

  // 5) A held gate lease blocks any other mutator (Blocker #4).
  if (input.state.activeLease && input.state.activeLease.callID !== input.callID) {
    const l = input.state.activeLease;
    return deny(bucket, "lease-held", `TDD gate: another write is in flight (tool=${l.tool}, file=${l.filePath}). Retry after it completes.`);
  }

  // 6) Anything not a guarded mutator at this point is denied (allow-list).
  if (bucket !== "guarded-mutator") {
    const hint = isKnownDenied(input.tool)
      ? input.tool === "bash"
        ? "Raw shell is disabled in TDD mode; run tests/builds via tdd_run / tdd_quality."
        : `The '${input.tool}' tool can mutate files outside the gate and is disabled in TDD mode.`
      : `Unknown tool '${input.tool}' with possible filesystem access is denied by default (fail-closed allow-list).`;
    return deny(bucket, "denied-bucket", `TDD gate: ${hint}`);
  }

  // --- guarded mutator (write/edit) from here on ---
  if (!input.filePath) {
    return deny(bucket, "no-path", `TDD gate: '${input.tool}' without a file path is denied.`);
  }

  const phase = input.state.phase;
  const slice = activeSlice(input.state);
  const ctx = { filePath: input.filePath, worktree: input.worktree };

  // 7) Symlink / `..` bucket-escape => hard deny (Major #15).
  if (isBucketEscape(ctx)) {
    return deny(bucket, "bucket-escape", `TDD gate: path '${input.filePath}' resolves outside its apparent bucket (symlink/.. escape). Denied.`);
  }

  const pb = classifyPath(ctx);

  // 8) build / build-logic edits go only through the validated escape hatch.
  if (pb === "build" || pb === "build-logic") {
    return deny(bucket, "build-edit", `TDD gate: ${pb} edits are denied by default. Use tdd_allow_build_edit with a validated diff (it invalidates current proofs).`, pb);
  }

  // 9) Phase must permit mutation at all.
  if (!MUTATING_PHASES.includes(phase)) {
    return deny(bucket, "phase-no-writes", `TDD gate: phase ${phase} permits no writes. ${nextActionFor(phase)}`, pb);
  }

  // 10) REPORT: only the plugin-owned report path.
  if (phase === "REPORT") {
    const ok = input.filePath.replace(/\\/g, "/").includes(".opencode/android-tdd/reports/");
    return ok
      ? allow(bucket, "report-write", pb)
      : deny(bucket, "report-scope", "TDD gate: in REPORT phase only the report file under .opencode/android-tdd/reports/ may be written.", pb);
  }

  if (!slice) {
    return deny(bucket, "no-slice", "TDD gate: no active slice. Set the plan/slice before writing.", pb);
  }

  // 11) TEST_WRITE: only the slice's declared test files.
  if (phase === "TEST_WRITE") {
    if (pb !== "test") {
      return deny(bucket, "testwrite-nontest", `TDD gate: phase TEST_WRITE allows test files only; '${input.filePath}' is ${pb}. Write the failing test first.`, pb);
    }
    if (!pathInList(input.filePath, input.worktree, slice.allowedTestFiles)) {
      return deny(bucket, "testwrite-out-of-slice", `TDD gate: '${input.filePath}' is not in slice '${slice.id}' allowed test files. Editing unrelated tests is blocked.`, pb);
    }
    return allow(bucket, "slice test write", pb);
  }

  // 12) IMPL: requires a non-drifted redProof; production writes restricted to
  //     the slice's allowed paths; test edits denied (anti-cheat, Blocker #7/#10).
  if (phase === "IMPL") {
    if (pb === "test") {
      return deny(bucket, "impl-test-edit", "TDD gate: test edits are blocked during IMPL (anti-cheat). Edit production code only.", pb);
    }
    if (!input.state.redProof) {
      return deny(bucket, "impl-no-redproof", "TDD gate: no verified failing test. Run tdd_verify_red before writing production code.", pb);
    }
    const drift = detectDrift(input.worktree, {
      ...input.state.redProof.sliceTestFileHashes,
    });
    if (drift.drifted) {
      return deny(bucket, "impl-redproof-drift", `TDD gate: redProof invalidated — changed since RED: ${drift.changedFiles.join(", ")}. Re-verify with tdd_verify_red.`, pb);
    }
    if (!pathInList(input.filePath, input.worktree, slice.allowedProductionPaths)) {
      return deny(bucket, "impl-out-of-scope", `TDD gate: '${input.filePath}' is outside slice '${slice.id}' allowed production paths. Use tdd_expand_scope (forces RED re-verification).`, pb);
    }
    return allow(bucket, "slice impl write", pb);
  }

  // 13) REFACTOR: green-gated, slice-scoped; test edits clear RED (handled by tools).
  if (phase === "REFACTOR") {
    if (!input.state.greenVerifiedAt) {
      return deny(bucket, "refactor-not-green", "TDD gate: REFACTOR requires a verified GREEN. Run tdd_verify_green first.", pb);
    }
    const inScope =
      (pb === "test" && pathInList(input.filePath, input.worktree, slice.allowedTestFiles)) ||
      (pb === "main" && pathInList(input.filePath, input.worktree, slice.allowedProductionPaths));
    if (!inScope) {
      return deny(bucket, "refactor-out-of-scope", `TDD gate: '${input.filePath}' is outside slice '${slice.id}' scope for REFACTOR.`, pb);
    }
    return allow(bucket, "slice refactor write", pb);
  }

  // Default: fail closed.
  return deny(bucket, "fallthrough", "TDD gate: write denied (fail-closed default).", pb);
}

function nextActionFor(phase: Phase): string {
  switch (phase) {
    case "BASELINE":
      return "Run tdd_baseline, then move to TEST_WRITE.";
    case "VERIFY_RED":
      return "Call tdd_verify_red.";
    case "VERIFY_GREEN":
      return "Call tdd_verify_green.";
    case "PLAN":
      return "Set the plan with tdd_plan_set.";
    default:
      return "Advance the workflow via the appropriate tdd_* tool.";
  }
}
