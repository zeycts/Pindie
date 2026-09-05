import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeToolEffect,
  classifyToolEffect,
  type ToolEffect,
} from "../src/execution-semantics.ts";
import {
  deriveCapabilities,
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticRunFacts,
} from "../src/semantics.ts";
import { EMPTY_STATE, type PindieState, type PindieTask } from "../src/state.ts";

function assertEffect(
  toolName: string,
  requiredCapability: PindieCapability,
  projectMutation: ToolEffect["projectMutation"],
): void {
  assert.deepEqual(classifyToolEffect(toolName), {
    requiredCapability,
    projectMutation,
  });
}

const exactCases = [
  ["read", "observe.project", "none"],
  ["grep", "observe.project", "none"],
  ["find", "observe.project", "none"],
  ["ls", "observe.project", "none"],
  ["web_search", "observe.project", "none"],
  ["url_context", "observe.project", "none"],
  ["pindie_git_observe", "observe.git", "none"],
  ["edit", "project.mutate", "known"],
  ["write", "project.mutate", "known"],
  ["bash", "project.mutate", "ambiguous"],
  ["pindie_policy_set", "policy.declare", "none"],
  ["pindie_strategy_derivation_candidate_create", "policy.derive", "none"],
  ["pindie_task_start", "task.start", "none"],
  ["pindie_task_replace", "task.replace", "none"],
  ["pindie_task_refine", "task.refine", "none"],
  ["pindie_task_progress", "task.progress", "none"],
  ["pindie_verification_record", "verification.record", "none"],
  ["pindie_task_complete", "task.complete", "none"],
  ["pindie_gate_open", "gate.open", "none"],
  ["pindie_gate_resolve", "gate.resolve", "none"],
] as const satisfies ReadonlyArray<
  readonly [string, PindieCapability, ToolEffect["projectMutation"]]
>;

for (const [toolName, requiredCapability, projectMutation] of exactCases) {
  test(`classifies ${toolName} exactly`, () => {
    assertEffect(toolName, requiredCapability, projectMutation);
  });
}

test("unknown tools always fail safe to ambiguous project mutation", () => {
  for (const toolName of ["custom_observer", "read_database", "future.pindie.tool"]) {
    assertEffect(toolName, "project.mutate", "ambiguous");
  }
});

test("authorization allowed is exactly required-capability membership", () => {
  const effects: readonly ToolEffect[] = [
    { requiredCapability: "observe.project", projectMutation: "none" },
    { requiredCapability: "project.mutate", projectMutation: "ambiguous" },
    { requiredCapability: "task.complete", projectMutation: "none" },
    { requiredCapability: "gate.resolve", projectMutation: "none" },
  ];
  const capabilitySets: ReadonlyArray<ReadonlySet<PindieCapability>> = [
    new Set(),
    new Set(["observe.project"]),
    new Set(["project.mutate", "gate.resolve"]),
    new Set(["observe.project", "project.mutate", "task.complete", "gate.resolve"]),
  ];

  for (const effect of effects) {
    for (const capabilities of capabilitySets) {
      assert.equal(
        authorizeToolEffect(capabilities, effect).allowed,
        capabilities.has(effect.requiredCapability),
      );
    }
  }
});

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

function composed(
  state: PindieState | null,
  runFacts: SemanticRunFacts,
  toolName: string,
) {
  const derivation = deriveSemanticSnapshot(state, runFacts);
  if (!derivation.ok) assert.fail(derivation.error);
  return authorizeToolEffect(
    deriveCapabilities(derivation.snapshot),
    classifyToolEffect(toolName),
  );
}

test("M0 and execution semantics compose for idle, active, and blocked mutation", () => {
  assert.equal(composed(EMPTY_STATE, facts({ taskRelation: "none" }), "edit").allowed, false);
  assert.equal(composed(EMPTY_STATE, facts({ taskRelation: "none" }), "web_search").allowed, true);
  assert.equal(composed(EMPTY_STATE, facts({ taskRelation: "none" }), "url_context").allowed, true);
  assert.equal(composed(EMPTY_STATE, facts({ taskRelation: "none" }), "pindie_task_start").allowed, true);
  assert.equal(composed({ task: task() }, facts(), "edit").allowed, true);
  assert.equal(composed({
    task: task({
      openLoops: { blockers: ["Blocked"], questions: [], nextIntent: null },
    }),
  }, facts(), "edit").allowed, true);
});

test("M0 and execution semantics compose for completion and Gates", () => {
  const ready = task({
    verification: {
      stale: false,
      checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "ok" }],
    },
  });
  assert.equal(composed({ task: task() }, facts(), "pindie_task_complete").allowed, false);
  assert.equal(composed({ task: ready }, facts(), "pindie_task_complete").allowed, true);

  const gated = task({ humanGate: { kind: "approval", question: "Approve?" } });
  assert.equal(composed(
    { task: gated },
    facts({ taskRelation: "preexisting_changed", gateRelation: "opened_during_run" }),
    "pindie_gate_resolve",
  ).allowed, false);
  assert.equal(composed(
    { task: gated },
    facts({ gateRelation: "existed_before_run" }),
    "pindie_gate_resolve",
  ).allowed, true);
});

test("stale and unavailable authority preserve observation and deny consequences", () => {
  assert.equal(composed({ task: task() }, { stateAvailable: true, runCoherent: false }, "read").allowed, true);
  assert.equal(composed({ task: task() }, { stateAvailable: true, runCoherent: false }, "web_search").allowed, true);
  assert.equal(composed({ task: task() }, { stateAvailable: true, runCoherent: false }, "edit").allowed, false);
  assert.equal(composed(null, { stateAvailable: false }, "custom_tool").allowed, false);
});

test("policy declaration uses only the fixed non-mutating capability", () => {
  assert.equal(composed(EMPTY_STATE, facts({ taskRelation: "none" }), "pindie_policy_set").allowed, true);
  assert.equal(composed({ task: task() }, facts(), "pindie_policy_set").allowed, true);
  assert.equal(composed(null, { stateAvailable: false }, "pindie_policy_set").allowed, true);
  assert.deepEqual(classifyToolEffect("pindie_policy_set"), {
    requiredCapability: "policy.declare",
    projectMutation: "none",
  });
});
