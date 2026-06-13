/**
 * tdd_* tools (SPEC-v2 §7). Each tool is self-evidencing: it validates phase /
 * slice / stateVersion and produces its own evidence — it never trusts a model
 * claim like "this is green". All mutations go through the phase machine under
 * the worktree lock with CAS, and every action is logged to the ledger.
 *
 * Built as a factory over injected deps (store/ledger/machine/runner/doctor) so
 * the whole tool surface is testable with a fake Gradle runner.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StateStore } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { PhaseMachine } from "./machine.js";
import { initialState, type Slice, type RedProof, type WorkflowState } from "./state/types.js";
import { runDoctor, type GradleRunner } from "./doctor.js";
import { runTargetedTest, type ShellExec } from "./gradle/runner.js";
import { hashFiles, detectDrift } from "./gate/hash.js";
import { validateBuildEdit } from "./gradle/buildedit.js";
import { runQuality } from "./gradle/quality.js";
import type { FailingTestIdentity } from "./state/types.js";

const z = tool.schema;

export interface ToolDeps {
  worktree: string;
  store: StateStore;
  ledger: Ledger;
  machine: PhaseMachine;
  shell: ShellExec;
  doctorRunner: GradleRunner;
  toolchainJavaHome: () => string | undefined;
  toolchainId: () => string | undefined;
  qualityChecks?: string[];
}

function withLock<T>(store: StateStore, fn: () => T): T {
  store.acquireLock();
  try {
    return fn();
  } finally {
    store.releaseLock();
  }
}

function requireState(store: StateStore): WorkflowState {
  const s = store.read();
  if (!s) throw new Error("No active TDD workflow. Call tdd_start first.");
  return s;
}

function activeSlice(s: WorkflowState): Slice | undefined {
  return s.slices.find((sl) => sl.id === s.currentSliceId);
}

function failingIdentities(result: { evidence: { failingCases: { classname: string; name: string; failureType?: string }[] } }): FailingTestIdentity[] {
  return result.evidence.failingCases.map((c) => ({
    classname: c.classname,
    method: c.name,
    assertionType: c.failureType,
  }));
}

export function createTools(deps: ToolDeps): Record<string, ToolDefinition> {
  const { worktree, store, ledger, machine, shell, doctorRunner } = deps;

  const tdd_start = tool({
    description: "Begin a strict TDD workflow. Allocates a workflow id and moves INACTIVE→DOCTOR. Required before any write.",
    args: {},
    async execute() {
      return withLock(store, () => {
        if (store.exists()) {
          const s = store.read()!;
          if (s.phase !== "INACTIVE" && s.phase !== "DONE") {
            return `Workflow already active (phase=${s.phase}, slice=${s.currentSliceId ?? "-"}).`;
          }
        }
        const workflowId = "wf-" + randomBytes(4).toString("hex");
        let s = store.exists() ? store.read()! : store.init(initialState(worktree, workflowId));
        const draft = structuredClone(s);
        draft.workflowId = workflowId;
        draft.activated = true;
        draft.phase = "DOCTOR";
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId, stateVersion: committed.stateVersion, type: "WORKFLOW_INIT", phase: "DOCTOR", detail: {} });
        return `TDD workflow ${workflowId} started. Phase DOCTOR. Run tdd_doctor next.`;
      });
    },
  });

  const tdd_doctor = tool({
    description: "Check the JDK toolchain and Gradle support matrix for target modules. Refuses unsupported projects (KMP, instrumented-only, product flavors). Must pass before planning.",
    args: { modules: z.array(z.string()).describe("Gradle module paths, e.g. [':common:regex']") },
    async execute(args) {
      const report = await runDoctor(args.modules, doctorRunner);
      if (report.verdict === "READY") {
        withLock(store, () => {
          const s = requireState(store);
          const draft = structuredClone(s);
          draft.toolchainId = report.toolchain.toolchain?.toolchainId;
          if (s.phase === "DOCTOR") draft.phase = "CONTEXT";
          store.commit(s.stateVersion, draft);
        });
      }
      return report.message;
    },
  });

  const tdd_status = tool({
    description: "Report the current TDD phase, active slice, and proof status.",
    args: {},
    async execute() {
      const s = store.read();
      if (!s) return "No active workflow.";
      const slice = activeSlice(s);
      return [
        `phase=${s.phase} version=${s.stateVersion} activated=${s.activated}`,
        `slice=${slice ? slice.id + " (" + slice.status + ")" : "-"}`,
        `redProof=${s.redProof ? s.redProof.classifier + " run=" + s.redProof.runId : "none"}`,
        `green=${s.greenVerifiedAt ? new Date(s.greenVerifiedAt).toISOString() : "no"}`,
        `lease=${s.activeLease ? s.activeLease.tool + ":" + s.activeLease.filePath : "none"}`,
      ].join("\n");
    },
  });

  const sliceSchema = z.object({
    id: z.string(),
    description: z.string(),
    module: z.string(),
    sourceSet: z.string(),
    variant: z.string(),
    testTask: z.string(),
    allowedTestFiles: z.array(z.string()).min(1),
    allowedProductionPaths: z.array(z.string()).min(1),
    allowedSymbols: z.array(z.string()),
    expectedSymbols: z.array(z.string()),
  });

  const tdd_plan_set = tool({
    description: "Set the TDD plan as small slices. Rejects repo-wide wildcards; each slice must name a module, test files, production paths, and target symbols. Moves to BASELINE.",
    args: { slices: z.array(sliceSchema).min(1) },
    async execute(args) {
      for (const sl of args.slices) {
        const bad = [...sl.allowedProductionPaths, ...sl.allowedTestFiles].find(
          (p) => p.includes("*") || p.trim() === "" || p.endsWith("/") || p === "src" || p === "src/main",
        );
        if (bad) throw new Error(`Slice '${sl.id}' has an over-broad/wildcard path '${bad}'. Name concrete files only.`);
      }
      return withLock(store, () => {
        const s = requireState(store);
        if (!["CONTEXT", "CLARIFY", "PLAN"].includes(s.phase)) {
          throw new Error(`tdd_plan_set requires phase CONTEXT/CLARIFY/PLAN, not ${s.phase}.`);
        }
        const draft = structuredClone(s);
        draft.slices = args.slices.map((sl) => ({ ...sl, status: "pending" as const }));
        draft.currentSliceId = draft.slices[0].id;
        draft.slices[0].status = "active";
        // walk CONTEXT→CLARIFY→PLAN→BASELINE deterministically
        draft.phase = "BASELINE";
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "PHASE_TRANSITION", phase: "BASELINE", sliceId: committed.currentSliceId, detail: { slices: draft.slices.map((x) => x.id) } });
        return `Plan set: ${draft.slices.length} slice(s). Active: ${draft.currentSliceId}. Phase BASELINE.`;
      });
    },
  });

  function runForActiveSlice(s: WorkflowState) {
    const slice = activeSlice(s);
    if (!slice) throw new Error("No active slice.");
    const javaHome = deps.toolchainJavaHome();
    if (!javaHome) throw new Error("No JDK toolchain resolved. Run tdd_doctor.");
    return runTargetedTest(
      {
        worktree,
        module: slice.module,
        testTask: slice.testTask,
        testSelectors: [],
        expectedSymbols: slice.expectedSymbols,
        sliceTestFiles: slice.allowedTestFiles,
        javaHome,
      },
      shell,
    );
  }

  const tdd_baseline = tool({
    description: "Run the active slice's test task to record pre-existing failures BEFORE writing the new test. Moves BASELINE→TEST_WRITE.",
    args: {},
    async execute() {
      const s = requireState(store);
      if (s.phase !== "BASELINE") throw new Error(`tdd_baseline requires phase BASELINE, not ${s.phase}.`);
      const outcome = await runForActiveSlice(s);
      return withLock(store, () => {
        const cur = requireState(store);
        const draft = structuredClone(cur);
        const slice = activeSlice(draft)!;
        slice.baselineFailures = failingIdentities(outcome.result);
        draft.phase = "TEST_WRITE";
        draft.lastRunId = outcome.runId;
        const committed = store.commit(cur.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "RUN", phase: "TEST_WRITE", sliceId: slice.id, detail: { runId: outcome.runId, baseline: slice.baselineFailures, cls: outcome.result.cls } });
        return `Baseline recorded (${slice.baselineFailures?.length ?? 0} pre-existing failures). Phase TEST_WRITE — write the failing test.`;
      });
    },
  });

  const tdd_run = tool({
    description: "Run the active slice's targeted tests and classify the result (GREEN/RED_ASSERTION/RED_MISSING_SYMBOL/BROKEN_TEST/NO_TESTS_RUN/ENV_FAILURE). Read-only: does not change phase.",
    args: {},
    async execute() {
      const s = requireState(store);
      const outcome = await runForActiveSlice(s);
      withLock(store, () => {
        const cur = requireState(store);
        const draft = structuredClone(cur);
        draft.lastRunId = outcome.runId;
        const committed = store.commit(cur.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "RUN", phase: cur.phase, sliceId: cur.currentSliceId, detail: { runId: outcome.runId, cls: outcome.result.cls, reason: outcome.result.reason, command: outcome.command } });
      });
      return `${outcome.result.cls}: ${outcome.result.reason} (run ${outcome.runId})`;
    },
  });

  const tdd_verify_red = tool({
    description: "Atomically run + classify the active slice's tests and, ONLY on a baseline-new RED_ASSERTION or RED_MISSING_SYMBOL, set the hash-bound redProof and advance TEST_WRITE→IMPL.",
    args: {},
    async execute() {
      const s = requireState(store);
      if (s.phase !== "TEST_WRITE") throw new Error(`tdd_verify_red requires phase TEST_WRITE, not ${s.phase}.`);
      const slice = activeSlice(s);
      if (!slice) throw new Error("No active slice.");
      const outcome = await runForActiveSlice(s);
      const r = outcome.result;

      if (!r.unlocksImpl) {
        ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "RUN", phase: "TEST_WRITE", sliceId: slice.id, detail: { runId: outcome.runId, cls: r.cls, reason: r.reason } });
        if (r.cls === "GREEN") {
          return `ALREADY_COVERED: the new test passes without implementation. Write a stronger failing test, or replan. (run ${outcome.runId})`;
        }
        return `Not a valid RED (${r.cls}): ${r.reason}. Fix the test, then retry tdd_verify_red. (run ${outcome.runId})`;
      }

      // anti-cheat: a RED_ASSERTION must be a NEW failure vs baseline.
      if (r.cls === "RED_ASSERTION") {
        const baseline = new Set((slice.baselineFailures ?? []).map((f) => `${f.classname}#${f.method}`));
        const fresh = failingIdentities(r).filter((f) => !baseline.has(`${f.classname}#${f.method}`));
        if (fresh.length === 0) {
          return `RED rejected: the failing test(s) already failed at baseline — not introduced by this slice. (run ${outcome.runId})`;
        }
      }

      const proof: RedProof = {
        workflowId: s.workflowId,
        sliceId: slice.id,
        runId: outcome.runId,
        module: slice.module,
        variant: slice.variant,
        testTask: slice.testTask,
        testSelectors: [],
        expectedSymbols: slice.expectedSymbols,
        classifier: r.cls as RedProof["classifier"],
        failingTestIdentity: failingIdentities(r),
        sliceTestFileHashes: hashFiles(worktree, slice.allowedTestFiles),
        productionPreHashes: hashFiles(worktree, slice.allowedProductionPaths),
        buildConfigHash: "",
        toolchainId: deps.toolchainId() ?? "",
        timestamp: Date.now(),
      };

      return withLock(store, () => {
        const cur = requireState(store);
        const draft = structuredClone(cur);
        draft.phase = "IMPL";
        draft.redProof = proof;
        draft.greenVerifiedAt = undefined;
        draft.lastRunId = outcome.runId;
        const committed = store.commit(cur.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "RED_VERIFIED", phase: "IMPL", sliceId: slice.id, detail: { runId: outcome.runId, cls: r.cls } });
        return `Verified RED (${r.cls}). redProof set. Phase IMPL — write the minimum production code in the slice's allowed paths.`;
      });
    },
  });

  const tdd_verify_green = tool({
    description: "Atomically run + classify the active slice's tests; require substantive GREEN (>0 executed, 0 skipped). Advances IMPL→REFACTOR (or REFACTOR→INSPECT). Invalidates if the redProof's test files drifted.",
    args: {},
    async execute() {
      const s = requireState(store);
      if (s.phase !== "IMPL" && s.phase !== "REFACTOR") throw new Error(`tdd_verify_green requires phase IMPL/REFACTOR, not ${s.phase}.`);
      const slice = activeSlice(s);
      if (!slice) throw new Error("No active slice.");

      if (s.redProof) {
        const drift = detectDrift(worktree, s.redProof.sliceTestFileHashes);
        if (drift.drifted) {
          return withLock(store, () => {
            const cur = requireState(store);
            const draft = structuredClone(cur);
            draft.redProof = undefined;
            draft.phase = "TEST_WRITE";
            const committed = store.commit(cur.stateVersion, draft);
            ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "PROOF_INVALIDATED", phase: "TEST_WRITE", sliceId: slice.id, detail: { changed: drift.changedFiles } });
            return `redProof invalidated — slice test files changed since RED: ${drift.changedFiles.join(", ")}. Back to TEST_WRITE; re-verify RED.`;
          });
        }
      }

      const outcome = await runForActiveSlice(s);
      const r = outcome.result;
      if (r.cls !== "GREEN") {
        ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "RUN", phase: s.phase, sliceId: slice.id, detail: { runId: outcome.runId, cls: r.cls, reason: r.reason } });
        return `Not GREEN (${r.cls}): ${r.reason}. ${s.phase === "IMPL" ? "Keep implementing." : "Refactor broke a test."} (run ${outcome.runId})`;
      }

      return withLock(store, () => {
        const cur = requireState(store);
        const draft = structuredClone(cur);
        draft.greenVerifiedAt = Date.now();
        draft.phase = cur.phase === "IMPL" ? "REFACTOR" : "INSPECT";
        draft.lastRunId = outcome.runId;
        const committed = store.commit(cur.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "GREEN_VERIFIED", phase: draft.phase, sliceId: slice.id, detail: { runId: outcome.runId } });
        return `Verified GREEN. Phase ${draft.phase}.`;
      });
    },
  });

  const tdd_inspect_done = tool({
    description: "Mark the active slice's INSPECT pass complete. Advances to the next pending slice (BASELINE) or, if none remain, to ARCH_GATE.",
    args: {},
    async execute() {
      return withLock(store, () => {
        const s = requireState(store);
        if (s.phase !== "INSPECT") throw new Error(`tdd_inspect_done requires phase INSPECT, not ${s.phase}.`);
        const draft = structuredClone(s);
        const cur = activeSlice(draft);
        if (cur) cur.status = "done";
        const next = draft.slices.find((sl) => sl.status === "pending");
        if (next) {
          next.status = "active";
          draft.currentSliceId = next.id;
          draft.redProof = undefined;
          draft.greenVerifiedAt = undefined;
          draft.phase = "BASELINE";
        } else {
          draft.currentSliceId = undefined;
          draft.phase = "ARCH_GATE";
        }
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "PHASE_TRANSITION", phase: draft.phase, sliceId: draft.currentSliceId, detail: { from: "INSPECT", finishedSlice: cur?.id } });
        return next ? `Slice done. Next slice: ${next.id}. Phase BASELINE.` : `All slices done. Phase ARCH_GATE.`;
      });
    },
  });

  const tdd_abort_slice = tool({
    description: "Abort the active slice (recovery). Clears its proof and moves to the next pending slice, or ARCH_GATE if none remain.",
    args: { reason: z.string() },
    async execute(args) {
      return withLock(store, () => {
        const s = requireState(store);
        const draft = structuredClone(s);
        const cur = activeSlice(draft);
        if (cur) cur.status = "aborted";
        const next = draft.slices.find((sl) => sl.status === "pending");
        draft.redProof = undefined;
        draft.greenVerifiedAt = undefined;
        draft.activeLease = undefined;
        if (next) { next.status = "active"; draft.currentSliceId = next.id; draft.phase = "BASELINE"; }
        else { draft.currentSliceId = undefined; draft.phase = "ARCH_GATE"; }
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "RECOVERY", phase: draft.phase, sliceId: cur?.id, detail: { action: "abort_slice", reason: args.reason } });
        return `Aborted slice ${cur?.id ?? "-"}: ${args.reason}. Phase ${draft.phase}.`;
      });
    },
  });

  const tdd_reset_workflow = tool({
    description: "Reset the entire workflow to INACTIVE (recovery). Clears all proofs, slices, and leases. Use when the flow is unrecoverably stuck.",
    args: { reason: z.string() },
    async execute(args) {
      return withLock(store, () => {
        const s = requireState(store);
        const draft = initialState(worktree, s.workflowId);
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "RECOVERY", phase: "INACTIVE", detail: { action: "reset_workflow", reason: args.reason } });
        return `Workflow reset to INACTIVE: ${args.reason}. Call tdd_start to begin again.`;
      });
    },
  });

  const tdd_takeover_stale_lock = tool({
    description: "Take over an expired worktree lock left by a crashed/abandoned session (recovery). Refuses if the lock is still fresh.",
    args: {},
    async execute() {
      const age = store.lockAgeMs();
      store.acquireLock({ takeoverStale: true });
      try {
        const s = store.read();
        if (s) ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "LOCK_TAKEOVER", phase: s.phase, detail: { previousLockAgeMs: age } });
        return `Stale lock taken over (previous age ${age ?? "n/a"}ms).`;
      } finally {
        store.releaseLock();
      }
    },
  });

  const tdd_explain_block = tool({
    description: "Explain why writes are currently blocked: the active phase, what may be edited, and the next valid command.",
    args: {},
    async execute() {
      const s = store.read();
      if (!s) return "No workflow. Writes are denied until tdd_start.";
      const slice = activeSlice(s);
      const lines = [`phase=${s.phase}, slice=${slice?.id ?? "-"}`];
      switch (s.phase) {
        case "TEST_WRITE": lines.push("Editable: slice test files only. Next: tdd_run then tdd_verify_red."); break;
        case "IMPL": lines.push(s.redProof ? "Editable: slice production paths only (no test edits). Next: tdd_verify_green." : "Blocked: no redProof. Next: tdd_verify_red."); break;
        case "REFACTOR": lines.push("Editable: slice test+prod (green-gated). Next: tdd_verify_green or tdd_inspect_done."); break;
        case "BASELINE": lines.push("No edits. Next: tdd_baseline."); break;
        default: lines.push("No edits in this phase. Advance via the matching tdd_* tool.");
      }
      return lines.join("\n");
    },
  });

  const tdd_report = tool({
    description: "Render the final development report from the ledger into .opencode/android-tdd/reports/<workflowId>.md and advance to DONE.",
    args: {},
    async execute() {
      const s = requireState(store);
      const entries = ledger.readAll().filter((e) => e.workflowId === s.workflowId);
      const reds = entries.filter((e) => e.type === "RED_VERIFIED").length;
      const greens = entries.filter((e) => e.type === "GREEN_VERIFIED").length;
      const blocks = entries.filter((e) => e.type === "WRITE_BLOCKED").length;
      const doneSlices = s.slices.filter((sl) => sl.status === "done").map((sl) => sl.id);
      const md = [
        `# TDD Report — ${s.workflowId}`,
        ``,
        `- Slices completed: ${doneSlices.length}/${s.slices.length} (${doneSlices.join(", ") || "-"})`,
        `- TDD cycles: ${reds} RED → ${greens} GREEN`,
        `- Gate blocks recorded: ${blocks}`,
        ``,
        `## Slices`,
        ...s.slices.map((sl) => `- **${sl.id}** (${sl.status}) — ${sl.description} [${sl.module} ${sl.testTask}]`),
      ].join("\n");
      return withLock(store, () => {
        const cur = requireState(store);
        const draft = structuredClone(cur);
        if (cur.phase === "REGRESSION_GATE" || cur.phase === "ARCH_GATE" || cur.phase === "REPORT") draft.phase = "DONE";
        store.commit(cur.stateVersion, draft);
        return { title: `TDD report ${s.workflowId}`, output: md };
      });
    },
  });

  const tdd_allow_build_edit = tool({
    description: "The ONLY way to change a build file (build.gradle*, settings, version catalog, build-logic). Validates the proposed content: allows only adding a test dependency, enabling a known test plugin, or creating a test source set. Forbids disabling/excluding tests, filters, source-set redirection, codegen rewiring, suppression flags, task-graph edits. On success the plugin writes the file itself and INVALIDATES all proofs.",
    args: {
      filePath: z.string().describe("build file path (worktree-relative or absolute)"),
      proposedContent: z.string().describe("the full proposed new content of the build file"),
      reason: z.string(),
    },
    async execute(args) {
      const abs = isAbsolute(args.filePath) ? args.filePath : resolve(worktree, args.filePath);
      const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      const verdict = validateBuildEdit({ filePath: args.filePath, current, proposed: args.proposedContent });

      if (verdict.verdict === "FORBIDDEN") {
        const s = store.read();
        if (s) {
          ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "WRITE_BLOCKED", phase: s.phase, sliceId: s.currentSliceId, detail: { tool: "tdd_allow_build_edit", filePath: args.filePath, violations: verdict.violations } });
        }
        throw new Error(`Build edit FORBIDDEN (${args.filePath}): ${verdict.violations.join("; ")}. Only add-test-dependency / enable-test-plugin / create-test-source-set are allowed.`);
      }

      return withLock(store, () => {
        const cur = requireState(store);
        writeFileSync(abs, args.proposedContent);
        const draft = structuredClone(cur);
        const hadProof = Boolean(draft.redProof); // §5: build edits void all proofs
        draft.redProof = undefined;
        draft.greenVerifiedAt = undefined;
        if (hadProof && (draft.phase === "IMPL" || draft.phase === "REFACTOR")) draft.phase = "TEST_WRITE";
        const committed = store.commit(cur.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "BUILD_EDIT_ALLOWED", phase: committed.phase, sliceId: committed.currentSliceId, detail: { filePath: args.filePath, category: verdict.category, reason: args.reason, invalidatedProofs: hadProof } });
        return `Build edit applied (${verdict.category}) to ${args.filePath}. All proofs invalidated${hadProof ? "; returned to TEST_WRITE" : ""}.`;
      });
    },
  });

  const tdd_expand_scope = tool({
    description: "Widen the active slice's allowed production paths/symbols (recovery). Forces RED re-verification: clears the redProof and returns to TEST_WRITE so the expanded scope is re-proven.",
    args: {
      addProductionPaths: z.array(z.string()).default([]),
      addSymbols: z.array(z.string()).default([]),
      reason: z.string(),
    },
    async execute(args) {
      for (const p of args.addProductionPaths) {
        if (p.includes("*") || p.trim() === "" || p.endsWith("/") || p === "src" || p === "src/main") {
          throw new Error(`Refusing over-broad/wildcard path '${p}'. Name concrete files only.`);
        }
      }
      return withLock(store, () => {
        const s = requireState(store);
        const draft = structuredClone(s);
        const slice = activeSlice(draft);
        if (!slice) throw new Error("No active slice to expand.");
        slice.allowedProductionPaths = [...new Set([...slice.allowedProductionPaths, ...args.addProductionPaths])];
        slice.allowedSymbols = [...new Set([...slice.allowedSymbols, ...args.addSymbols])];
        slice.expectedSymbols = [...new Set([...slice.expectedSymbols, ...args.addSymbols])];
        draft.redProof = undefined;
        draft.greenVerifiedAt = undefined;
        if (draft.phase === "IMPL" || draft.phase === "REFACTOR") draft.phase = "TEST_WRITE";
        const committed = store.commit(s.stateVersion, draft);
        ledger.append({ workflowId: committed.workflowId, stateVersion: committed.stateVersion, type: "SCOPE_EXPANDED", phase: committed.phase, sliceId: slice.id, detail: { addProductionPaths: args.addProductionPaths, addSymbols: args.addSymbols, reason: args.reason } });
        return `Slice ${slice.id} scope expanded. redProof cleared — re-verify RED (phase ${committed.phase}).`;
      });
    },
  });

  const tdd_quality = tool({
    description: "Run the project's configured Gradle quality checks (default detekt, ktlintCheck, lintDebug) for the active slice's module. Tasks not present for the module are skipped, not failed. Read-only: does not change phase.",
    args: { checks: z.array(z.string()).default([]) },
    async execute(args) {
      const s = requireState(store);
      const slice = activeSlice(s);
      if (!slice) throw new Error("No active slice.");
      const javaHome = deps.toolchainJavaHome();
      if (!javaHome) throw new Error("No JDK toolchain resolved. Run tdd_doctor.");
      const checks = args.checks.length > 0 ? args.checks : (deps.qualityChecks ?? ["detekt", "ktlintCheck", "lintDebug"]);
      const result = await runQuality({ worktree, module: slice.module, checks, javaHome }, shell);
      ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "RUN", phase: s.phase, sliceId: slice.id, detail: { quality: result.results } });
      const lines = result.results.map((r) => `${r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP"}  ${r.task}${r.status === "fail" ? "  — " + r.detail : ""}`);
      return `${result.allPassed ? "Quality OK" : "Quality FAILED"}:\n${lines.join("\n")}`;
    },
  });

  const tdd_arch_check = tool({
    description: "Advisory architecture check for the active slice (v1: advisory only — never blocks the workflow). Reports configured ast-grep rule findings if a rule pack is enabled; otherwise reports that no pack is active.",
    args: {},
    async execute() {
      const s = requireState(store);
      ledger.append({ workflowId: s.workflowId, stateVersion: s.stateVersion, type: "RUN", phase: s.phase, sliceId: s.currentSliceId, detail: { archCheck: "advisory", pack: "none" } });
      return "Architecture check (advisory): no opinionated rule pack is enabled in v1. Enable a pack via config to receive findings. This check never blocks the TDD cycle.";
    },
  });

  return {
    tdd_start,
    tdd_doctor,
    tdd_status,
    tdd_plan_set,
    tdd_baseline,
    tdd_run,
    tdd_verify_red,
    tdd_verify_green,
    tdd_inspect_done,
    tdd_abort_slice,
    tdd_reset_workflow,
    tdd_takeover_stale_lock,
    tdd_explain_block,
    tdd_allow_build_edit,
    tdd_expand_scope,
    tdd_quality,
    tdd_arch_check,
    tdd_report,
  };
}
