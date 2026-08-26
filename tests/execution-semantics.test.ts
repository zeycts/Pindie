import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeToolEffect,
  classifyToolEffect,
  type ToolCallDescriptor,
  type ToolEffect,
} from "../src/execution-semantics.ts";
import {
  deriveCapabilities,
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticRunFacts,
} from "../src/semantics.ts";
import { EMPTY_STATE, type PindieState, type PindieTask } from "../src/state.ts";

function effectFor(call: ToolCallDescriptor): ToolEffect {
  const result = classifyToolEffect(call);
  if (!result.ok) {
    assert.fail(`Unexpected classification failure for ${call.toolName}`);
  }
  return result.effect;
}

function assertEffect(
  call: ToolCallDescriptor,
  requiredCapability: PindieCapability,
  projectMutation: ToolEffect["projectMutation"],
): void {
  assert.deepEqual(effectFor(call), { requiredCapability, projectMutation });
}

const exactCases: ReadonlyArray<
  readonly [string, ToolCallDescriptor, PindieCapability, ToolEffect["projectMutation"]]
> = [
  ["E01 read", { toolName: "read" }, "observe.project", "none"],
  ["E02 grep", { toolName: "grep" }, "observe.project", "none"],
  ["E03 find", { toolName: "find" }, "observe.project", "none"],
  ["E04 ls", { toolName: "ls" }, "observe.project", "none"],
  ["E05 pindie_git_observe", { toolName: "pindie_git_observe" }, "observe.git", "none"],
  ["E06 edit", { toolName: "edit" }, "project.mutate", "known"],
  ["E07 write", { toolName: "write" }, "project.mutate", "known"],
  ["E08 bash", { toolName: "bash", input: { command: "git status" } }, "project.mutate", "ambiguous"],
  ["E09 arbitrary unknown custom tool", { toolName: "custom_observer" }, "project.mutate", "ambiguous"],
  ["E10 pindie_state start_task", { toolName: "pindie_state", input: { action: "start_task" } }, "task.start", "none"],
  ["E11 pindie_state replace_task", { toolName: "pindie_state", input: { action: "replace_task" } }, "task.replace", "none"],
  ["E12 pindie_state refine_task", { toolName: "pindie_state", input: { action: "refine_task" } }, "task.refine", "none"],
  ["E13 pindie_state set_open_loops", { toolName: "pindie_state", input: { action: "set_open_loops" } }, "task.progress", "none"],
  ["E14 pindie_state record_verification", { toolName: "pindie_state", input: { action: "record_verification" } }, "verification.record", "none"],
  ["E15 pindie_state complete_task", { toolName: "pindie_state", input: { action: "complete_task" } }, "task.complete", "none"],
  ["E16 pindie_gate open", { toolName: "pindie_gate", input: { action: "open" } }, "gate.open", "none"],
  ["E17 pindie_gate resolve", { toolName: "pindie_gate", input: { action: "resolve" } }, "gate.resolve", "none"],
];

for (const [name, call, requiredCapability, projectMutation] of exactCases) {
  test(name, () => assertEffect(call, requiredCapability, projectMutation));
}

const malformedCases: ReadonlyArray<
  readonly [string, ToolCallDescriptor, "pindie_state" | "pindie_gate"]
> = [
  ["E18 pindie_state missing action", { toolName: "pindie_state", input: {} }, "pindie_state"],
  ["E19 pindie_state unknown action", { toolName: "pindie_state", input: { action: "banana" } }, "pindie_state"],
  ["E20 pindie_state non-object input", { toolName: "pindie_state", input: "start_task" }, "pindie_state"],
  ["E21 pindie_gate missing action", { toolName: "pindie_gate", input: {} }, "pindie_gate"],
  ["E22 pindie_gate unknown action", { toolName: "pindie_gate", input: { action: "banana" } }, "pindie_gate"],
  ["E23 pindie_gate non-object input", { toolName: "pindie_gate", input: null }, "pindie_gate"],
];

for (const [name, call, toolName] of malformedCases) {
  test(name, () => {
    assert.deepEqual(classifyToolEffect(call), {
      ok: false,
      error: { kind: "invalid_semantic_action", toolName },
    });
  });
}

test("A01 required capability present allows the effect", () => {
  assert.deepEqual(
    authorizeToolEffect(new Set<PindieCapability>(["observe.project"]), {
      requiredCapability: "observe.project",
      projectMutation: "none",
    }),
    { allowed: true, requiredCapability: "observe.project" },
  );
});

test("A02 required capability absent denies with missing_capability", () => {
  assert.deepEqual(
    authorizeToolEffect(new Set<PindieCapability>(), {
      requiredCapability: "project.mutate",
      projectMutation: "known",
    }),
    {
      allowed: false,
      requiredCapability: "project.mutate",
      reason: "missing_capability",
    },
  );
});

test("A03 authorization reports the exact required capability", () => {
  assert.deepEqual(
    authorizeToolEffect(new Set<PindieCapability>(["verification.record"]), {
      requiredCapability: "verification.record",
      projectMutation: "none",
    }),
    { allowed: true, requiredCapability: "verification.record" },
  );
});

test("A04 unrelated extra capabilities do not affect authorization", () => {
  const effect: ToolEffect = {
    requiredCapability: "task.complete",
    projectMutation: "none",
  };
  const withoutExtras = authorizeToolEffect(new Set<PindieCapability>(), effect);
  const withExtras = authorizeToolEffect(
    new Set<PindieCapability>([
      "observe.project",
      "observe.git",
      "project.mutate",
      "gate.open",
    ]),
    effect,
  );

  assert.deepEqual(withExtras, withoutExtras);
});

function createTask(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Ship the execution semantics foundation",
    constraints: ["Do not change runtime behavior"],
    successCriteria: [
      { id: "c1", description: "Tool effects are classified" },
      { id: "c2", description: "Authorization composes with M0" },
    ],
    openLoops: { blockers: [], questions: [], nextIntent: "Implement M1" },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function passedVerification(): PindieTask["verification"] {
  return {
    stale: false,
    checks: [
      {
        name: "check",
        status: "passed",
        covers: ["c1", "c2"],
        evidence: "M1 checks passed.",
      },
    ],
  };
}

function stateWith(task: PindieTask): PindieState {
  return { task };
}

type CoherentRunFacts = Extract<SemanticRunFacts, { runCoherent: true }>;

function coherentFacts(
  overrides: Partial<CoherentRunFacts> = {},
): CoherentRunFacts {
  return {
    stateAvailable: true,
    runCoherent: true,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  };
}

function composedAuthorization(
  state: PindieState | null,
  facts: SemanticRunFacts,
  call: ToolCallDescriptor,
) {
  const derivation = deriveSemanticSnapshot(state, facts);
  if (!derivation.ok) assert.fail(derivation.error);
  return authorizeToolEffect(
    deriveCapabilities(derivation.snapshot),
    effectFor(call),
  );
}

const editCall = { toolName: "edit" } as const;
const completeCall = {
  toolName: "pindie_state",
  input: { action: "complete_task" },
} as const;
const resolveGateCall = {
  toolName: "pindie_gate",
  input: { action: "resolve" },
} as const;

test("C01 coherent idle plus edit is denied", () => {
  const decision = composedAuthorization(
    EMPTY_STATE,
    coherentFacts({ taskRelation: "none" }),
    editCall,
  );
  assert.equal(decision.allowed, false);
});

test("C02 coherent idle plus start_task is allowed", () => {
  const decision = composedAuthorization(
    EMPTY_STATE,
    coherentFacts({ taskRelation: "none" }),
    { toolName: "pindie_state", input: { action: "start_task" } },
  );
  assert.equal(decision.allowed, true);
});

test("C03 coherent active Task plus edit is allowed", () => {
  const decision = composedAuthorization(
    stateWith(createTask()),
    coherentFacts(),
    editCall,
  );
  assert.equal(decision.allowed, true);
});

test("C04 coherent blocked Task plus edit is denied", () => {
  const blockedTask = createTask({
    openLoops: {
      blockers: ["External system unavailable"],
      questions: [],
      nextIntent: "Wait for the system",
    },
  });
  const decision = composedAuthorization(
    stateWith(blockedTask),
    coherentFacts(),
    editCall,
  );
  assert.equal(decision.allowed, false);
});

test("C05 pending verification plus complete_task is denied", () => {
  const decision = composedAuthorization(
    stateWith(createTask()),
    coherentFacts(),
    completeCall,
  );
  assert.equal(decision.allowed, false);
});

test("C06 completion-ready active Task plus complete_task is allowed", () => {
  const decision = composedAuthorization(
    stateWith(createTask({ verification: passedVerification() })),
    coherentFacts(),
    completeCall,
  );
  assert.equal(decision.allowed, true);
});

test("C07 Gate opened during the current Run plus resolve is denied", () => {
  const gatedTask = createTask({
    humanGate: { kind: "approval", question: "Approve release?" },
  });
  const decision = composedAuthorization(
    stateWith(gatedTask),
    coherentFacts({
      taskRelation: "preexisting_changed",
      gateRelation: "opened_during_run",
    }),
    resolveGateCall,
  );
  assert.equal(decision.allowed, false);
});

test("C08 Gate existing before the current Run plus resolve is allowed", () => {
  const gatedTask = createTask({
    humanGate: { kind: "approval", question: "Approve release?" },
  });
  const decision = composedAuthorization(
    stateWith(gatedTask),
    coherentFacts({ gateRelation: "existed_before_run" }),
    resolveGateCall,
  );
  assert.equal(decision.allowed, true);
});

test("C09 stale authority plus edit is denied", () => {
  const decision = composedAuthorization(
    stateWith(createTask()),
    { stateAvailable: true, runCoherent: false },
    editCall,
  );
  assert.equal(decision.allowed, false);
});

test("C10 stale authority plus read is allowed", () => {
  const decision = composedAuthorization(
    stateWith(createTask()),
    { stateAvailable: true, runCoherent: false },
    { toolName: "read" },
  );
  assert.equal(decision.allowed, true);
});

test("C11 unavailable authority plus unknown custom tool is denied", () => {
  const decision = composedAuthorization(
    null,
    { stateAvailable: false },
    { toolName: "custom_tool" },
  );
  assert.equal(decision.allowed, false);
});

test("C12 active authority plus unknown custom tool is allowed conservatively", () => {
  const decision = composedAuthorization(
    stateWith(createTask()),
    coherentFacts(),
    { toolName: "custom_tool" },
  );
  assert.deepEqual(decision, {
    allowed: true,
    requiredCapability: "project.mutate",
  });
});

test("tool requirement completeness covers every current operation and unknown tools", () => {
  const currentCalls = exactCases.map(([, call]) => call);
  for (const call of [...currentCalls, { toolName: "future_custom_tool" }]) {
    const result = classifyToolEffect(call);
    assert.equal(result.ok, true, call.toolName);
    if (result.ok) assert.ok(result.effect);
  }
});

test("unknown tools always fail safe to ambiguous project mutation", () => {
  for (const toolName of ["custom_observer", "read_database", "future.pindie.tool"]) {
    assertEffect(
      { toolName, input: { readonly: true } },
      "project.mutate",
      "ambiguous",
    );
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
