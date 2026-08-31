import assert from "node:assert/strict";
import test from "node:test";

import { deriveCapabilities, deriveSemanticSnapshot, type SemanticRunFacts } from "../src/semantics.ts";
import { EMPTY_STATE, type PindieState, type PindieTask } from "../src/state.ts";
import { deriveEffectiveToolNames } from "../src/tool-surface.ts";

const BASELINE = [
  "read",
  "edit",
  "pindie_git_observe",
  "write",
  "bash",
  "custom_tool",
  "pindie_task_start",
  "pindie_task_replace",
  "pindie_task_refine",
  "pindie_task_progress",
  "pindie_verification_record",
  "pindie_task_complete",
  "pindie_gate_open",
  "pindie_gate_resolve",
] as const;

type CoherentFacts = Extract<SemanticRunFacts, { runCoherent: true }>;

function facts(overrides: Partial<CoherentFacts> = {}): CoherentFacts {
  return {
    stateAvailable: true,
    runCoherent: true,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  };
}

function task(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Implement M3",
    constraints: [],
    successCriteria: [{ id: "c1", description: "M3 works" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function surface(
  state: PindieState | null,
  runFacts: SemanticRunFacts,
  baseline: readonly string[] = BASELINE,
): string[] {
  const derivation = deriveSemanticSnapshot(state, runFacts);
  if (!derivation.ok) assert.fail(derivation.error);
  return deriveEffectiveToolNames(baseline, deriveCapabilities(derivation.snapshot));
}

test("S01 baseline order is preserved", () => {
  assert.deepEqual(surface(EMPTY_STATE, facts({ taskRelation: "none" })), [
    "read", "pindie_git_observe", "pindie_task_start",
  ]);
});

test("S02 no tool absent from baseline is ever added", () => {
  assert.deepEqual(surface(EMPTY_STATE, facts({ taskRelation: "none" }), ["read"]), ["read"]);
});

test("S03 idle capabilities remove baseline mutation tools", () => {
  assert.deepEqual(surface(EMPTY_STATE, facts({ taskRelation: "none" }), ["edit", "write", "bash", "custom_tool"]), []);
});

test("S04 idle exposes baseline-active pindie_task_start", () => {
  assert.deepEqual(surface(EMPTY_STATE, facts({ taskRelation: "none" }), ["pindie_task_start"]), ["pindie_task_start"]);
});

test("S05 active project.mutate keeps baseline edit/write/bash", () => {
  assert.deepEqual(surface({ task: task() }, facts(), ["edit", "write", "bash"]), ["edit", "write", "bash"]);
});

test("S06 blocked retains baseline edit/write/bash/unknown custom", () => {
  const blocked = task({ openLoops: { blockers: ["Blocked"], questions: [], nextIntent: null } });
  assert.deepEqual(surface({ task: blocked }, facts(), ["read", "edit", "write", "bash", "custom_tool"]), ["read", "edit", "write", "bash", "custom_tool"]);
});

test("S07 active preexisting untouched keeps pindie_task_replace", () => {
  assert.deepEqual(surface({ task: task() }, facts(), ["pindie_task_replace"]), ["pindie_task_replace"]);
});

test("S08 introduced/changed removes pindie_task_replace", () => {
  assert.deepEqual(surface({ task: task() }, facts({ taskRelation: "introduced_during_run" }), ["pindie_task_replace"]), []);
  assert.deepEqual(surface({ task: task() }, facts({ taskRelation: "preexisting_changed" }), ["pindie_task_replace"]), []);
});

test("S09 pending verification removes pindie_task_complete", () => {
  assert.deepEqual(surface({ task: task() }, facts(), ["pindie_task_complete"]), []);
});

test("S10 completionReady includes baseline-active pindie_task_complete", () => {
  const ready = task({ verification: { stale: false, checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "ok" }] } });
  assert.deepEqual(surface({ task: ready }, facts(), ["pindie_task_complete"]), ["pindie_task_complete"]);
});

test("S11 same-Run Gate leaves baseline observations only", () => {
  const gated = task({ humanGate: { kind: "approval", question: "Approve?" } });
  assert.deepEqual(surface(
    { task: gated },
    facts({ taskRelation: "preexisting_changed", gateRelation: "opened_during_run" }),
  ), ["read", "pindie_git_observe"]);
});

test("S12 pre-existing Gate includes resolve/refine/eligible replace", () => {
  const gated = task({ humanGate: { kind: "approval", question: "Approve?" } });
  assert.deepEqual(surface({ task: gated }, facts({ gateRelation: "existed_before_run" })), [
    "read", "pindie_git_observe", "pindie_task_replace", "pindie_task_refine", "pindie_gate_resolve",
  ]);
});

test("S13 stale authority yields baseline observation subset only", () => {
  assert.deepEqual(surface({ task: task() }, { stateAvailable: true, runCoherent: false }), ["read", "pindie_git_observe"]);
});

test("S14 unavailable authority yields baseline observation subset only", () => {
  assert.deepEqual(surface(null, { stateAvailable: false }), ["read", "pindie_git_observe"]);
});

test("S15 user-disabled/bash-absent baseline never gains bash under an active Task", () => {
  assert.deepEqual(surface({ task: task() }, facts(), ["read", "edit"]), ["read", "edit"]);
});

test("S16 custom unknown baseline tool follows project.mutate capability", () => {
  assert.deepEqual(surface({ task: task() }, facts(), ["custom_tool"]), ["custom_tool"]);
  assert.deepEqual(surface(EMPTY_STATE, facts({ taskRelation: "none" }), ["custom_tool"]), []);
});
