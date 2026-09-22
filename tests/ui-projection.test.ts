import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import type { HumanGate, PindieState, VerificationCheck } from "../src/state.ts";
import {
  appendUserDelivery,
  classifyToolPresentation,
  createProjection,
  projectSessionHistory,
  rebuildProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjectionInput,
  type UiCompletionSemanticBlock,
  type UiHumanGateSemanticBlock,
  type UiMessageBlock,
  type UiObservationWorkBlock,
  type UiSemanticBlock,
  type UiTaskSemanticBlock,
  type UiToolWorkBlock,
  type UiVerificationSemanticBlock,
  type UiWorkBlock,
} from "../src/ui-projection.ts";

function runtime(
  overrides: Partial<PindieUiProjectionInput["session"]["runtime"]> = {},
) {
  return {
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    pendingMessageCount: 0,
    ...overrides,
  };
}

function state(
  overrides: Record<string, unknown> = {},
): PindiePresentationSnapshot["status"]["state"] {
  return {
    task: {
      goal: "Keep the projection truthful.",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Projection is useful." }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
      ...overrides,
    },
  } as PindiePresentationSnapshot["status"]["state"];
}

function presentation(
  overrides: Partial<PindiePresentationSnapshot> = {},
): PindiePresentationSnapshot {
  return {
    semantic: {
      ok: true,
      snapshot: {
        authority: "coherent",
        taskStatus: "active",
        verificationStatus: "pending",
        hasBlockers: false,
        hasQuestions: false,
        completionReady: false,
        taskRelation: "introduced_during_run",
        completionRelation: "not_completed",
        gateRelation: "none",
      },
    },
    status: {
      consumption: { scope: "run", durationMs: 1_000, cost: 0.01 },
      reasoningMode: "auto",
      activity: "thinking",
      state: state(),
      stateUnavailableReason: null,
      runStale: false,
      quotaResumeWaiting: false,
      subscriptionUsage: null,
    },
    quotaResumeWaiting: null,
    projectRoot: "/project",
    ...overrides,
  };
}

function input(
  overrides: Partial<PindieUiProjectionInput> = {},
): PindieUiProjectionInput {
  return {
    presentation: presentation(),
    session: {
      sessionId: "session-1",
      displayIdentity: "A useful Session",
      model: { provider: "test-provider", modelId: "test-model" },
      thinkingLevel: "high",
      runtime: runtime(),
      branch: [],
    },
    ...overrides,
  };
}

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-21T00:00:00.000Z",
    message,
  } as unknown as SessionEntry;
}

function customMessageEntry(
  id: string,
  customType: string,
  content: string,
  display: boolean,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-09-21T00:00:00.000Z",
    customType,
    content,
    display,
  } as unknown as SessionEntry;
}

function userEntry(id: string, text: string): SessionEntry {
  return messageEntry(id, { role: "user", content: text, timestamp: 1 });
}

function assistantEntry(
  id: string,
  text: string,
  stopReason: string = "stop",
): SessionEntry {
  return messageEntry(id, {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test-provider",
    model: "test-model",
    usage: {},
    stopReason,
    timestamp: 1,
  });
}

function assistantMessage(
  textParts: readonly Record<string, unknown>[],
  stopReason = "pending",
): Record<string, unknown> {
  return {
    role: "assistant",
    content: textParts,
    api: "test",
    provider: "test-provider",
    model: "test-model",
    usage: {},
    stopReason,
    timestamp: 1,
  };
}

function assistantToolEntry(
  id: string,
  calls: readonly Record<string, unknown>[],
  text?: string,
): SessionEntry {
  return messageEntry(id, assistantMessage([
    ...(text === undefined ? [] : [{ type: "text", text }]),
    ...calls.map((call) => ({ type: "toolCall", ...call })),
  ], "toolUse"));
}

function toolResultEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  options: { readonly isError?: boolean; readonly text?: string; readonly details?: unknown } = {},
): SessionEntry {
  return messageEntry(id, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: options.text === undefined
      ? []
      : [{ type: "text", text: options.text }],
    details: options.details,
    isError: options.isError ?? false,
    timestamp: 1,
  });
}

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function messageBlocks(projection: ReturnType<typeof createProjection>): UiMessageBlock[] {
  return projection.timeline.filter(
    (block): block is UiMessageBlock => block.type === "message",
  );
}

function workBlocks(projection: ReturnType<typeof createProjection>): UiWorkBlock[] {
  return projection.timeline.filter(
    (block): block is UiWorkBlock => block.type === "work",
  );
}

function observationBlocks(projection: ReturnType<typeof createProjection>): UiObservationWorkBlock[] {
  return workBlocks(projection).filter(
    (block): block is UiObservationWorkBlock => block.kind === "observation",
  );
}

function toolWorkBlocks(projection: ReturnType<typeof createProjection>): UiToolWorkBlock[] {
  return workBlocks(projection).filter(
    (block): block is UiToolWorkBlock => block.kind !== "observation",
  );
}

function semanticBlocks(projection: ReturnType<typeof createProjection>): UiSemanticBlock[] {
  return projection.timeline.filter(
    (block): block is UiSemanticBlock => block.type === "semantic",
  );
}

function semanticState(options: {
  readonly goal?: string;
  readonly criteriaCount?: number;
  readonly blockers?: readonly string[];
  readonly questions?: readonly string[];
  readonly nextIntent?: string | null;
  readonly checks?: readonly VerificationCheck[];
  readonly stale?: boolean;
  readonly humanGate?: HumanGate | null;
  readonly completed?: boolean;
} = {}): PindieState {
  const criteriaCount = options.criteriaCount ?? 1;
  const checks = options.checks ?? [];
  return {
    task: {
      goal: options.goal ?? "Keep the projection truthful.",
      constraints: [],
      successCriteria: Array.from({ length: criteriaCount }, (_, index) => ({
        id: `c${index + 1}`,
        description: `Criterion ${index + 1}`,
      })),
      openLoops: {
        blockers: [...(options.blockers ?? [])],
        questions: [...(options.questions ?? [])],
        nextIntent: options.nextIntent ?? null,
      },
      verification: { stale: options.stale ?? false, checks: [...checks] },
      humanGate: options.humanGate ?? null,
      completed: options.completed ?? false,
    },
  };
}

function semanticToolResult(
  state: PindieState | undefined,
  options: { readonly isError?: boolean; readonly text?: string } = {},
): Record<string, unknown> {
  return {
    content: options.text === undefined ? [] : [{ type: "text", text: options.text }],
    details: state === undefined ? undefined : { state },
    isError: options.isError ?? false,
  };
}

function applySemanticLive(
  projection: ReturnType<typeof createProjection>,
  toolCallId: string,
  toolName: string,
  args: unknown,
  result: Record<string, unknown>,
): ReturnType<typeof createProjection> {
  let next = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  }));
  next = reduceProjectionEvent(next, event({
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError: result.isError,
  }));
  return next;
}

test("presentation classifier reserves semantic tools without changing execution semantics", () => {
  assert.equal(classifyToolPresentation("read"), "observation");
  assert.equal(classifyToolPresentation("grep"), "observation");
  assert.equal(classifyToolPresentation("edit"), "edit");
  assert.equal(classifyToolPresentation("write"), "edit");
  assert.equal(classifyToolPresentation("bash"), "command");
  assert.equal(classifyToolPresentation("pindie_task_progress"), "semantic");
  assert.equal(classifyToolPresentation("pindie_memory_capture"), "external");
  assert.equal(classifyToolPresentation("browser_navigate"), "external");
  assert.equal(classifyToolPresentation("future_tool"), "generic");
});

test("live semantic calls use one identity from running preview through result", () => {
  const task = semanticState({ goal: "Keep semantic execution visible" });
  let projection = createProjection(input({ presentation: null }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "running-task",
    toolName: "pindie_task_start",
    args: { goal: task.task!.goal, successCriteria: ["one"] },
  }));
  const running = semanticBlocks(projection)[0] as UiTaskSemanticBlock;
  assert.equal(running.id, "semantic:task:running-task");
  assert.equal(running.lifecycle, "running");
  assert.equal(running.defaultDisplayMode, "preview");
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "running-task",
    toolName: "pindie_task_start",
    args: { goal: task.task!.goal, successCriteria: ["one"] },
    partialResult: { content: [{ type: "text", text: "Current task started." }] },
  }));
  assert.equal(semanticBlocks(projection).length, 1);
  assert.equal(semanticBlocks(projection)[0]?.id, running.id);
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "running-task",
    toolName: "pindie_task_start",
    result: semanticToolResult(task),
    isError: false,
  }));
  const complete = semanticBlocks(projection)[0] as UiTaskSemanticBlock;
  assert.equal(complete.id, running.id);
  assert.equal(complete.lifecycle, "complete");
});

test("collapses live Task updates into one phase and starts a new replacement phase", () => {
  const startState = semanticState({ goal: "Implement Pindie Semantic Timeline", criteriaCount: 3 });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "task-start", "pindie_task_start", {
    goal: startState.task!.goal,
    successCriteria: ["one", "two", "three"],
  }, semanticToolResult(startState));

  const refineState = semanticState({ goal: "Implement the semantic timeline", criteriaCount: 3 });
  projection = applySemanticLive(projection, "task-refine", "pindie_task_refine", {
    goal: refineState.task!.goal,
  }, semanticToolResult(refineState));
  projection = applySemanticLive(projection, "task-progress-a", "pindie_task_progress", {
    blockers: [],
    questions: [],
    nextIntent: "Record verification",
  }, semanticToolResult(semanticState({
    goal: refineState.task!.goal,
    criteriaCount: 3,
    nextIntent: "Record verification",
  })));
  projection = applySemanticLive(projection, "task-progress-b", "pindie_task_progress", {
    blockers: [],
    questions: ["Should completion include metrics?"],
  }, semanticToolResult(semanticState({
    goal: refineState.task!.goal,
    criteriaCount: 3,
    questions: ["Should completion include metrics?"],
  })));

  const tasks = semanticBlocks(projection).filter(
    (block): block is UiTaskSemanticBlock => block.category === "task",
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, "semantic:task:task-start");
  assert.equal(projection.semanticTimeline.currentTaskBlockId, "semantic:task:task-start");
  assert.equal(tasks[0]?.goal, "Implement the semantic timeline");
  assert.equal(tasks[0]?.questions[0], "Should completion include metrics?");
  assert.equal(tasks[0]?.successCriterionCount, 3);

  const replacement = semanticState({ goal: "Replace with the final semantic timeline", criteriaCount: 2 });
  projection = applySemanticLive(projection, "task-replace", "pindie_task_replace", {
    goal: replacement.task!.goal,
    successCriteria: ["new one", "new two"],
  }, semanticToolResult(replacement));
  const replacementTasks = semanticBlocks(projection).filter(
    (block): block is UiTaskSemanticBlock => block.category === "task",
  );
  assert.deepEqual(replacementTasks.map((block) => block.id), [
    "semantic:task:task-start",
    "semantic:task:task-replace",
  ]);
  assert.equal(projection.semanticTimeline.currentTaskBlockId, "semantic:task:task-replace");
});

test("projects a blocked Task from resulting State without creating Attention", () => {
  const active = semanticState({ goal: "Recover a blocked Task" });
  let projection = createProjection(input({
    presentation: presentation({
      status: { ...presentation().status, state: active },
    }),
  }));
  projection = applySemanticLive(projection, "task-start-blocked", "pindie_task_start", {
    goal: active.task!.goal,
    successCriteria: ["recover"],
  }, semanticToolResult(active));
  const blocked = semanticState({
    goal: active.task!.goal,
    blockers: ["missing staging token"],
  });
  projection = applySemanticLive(projection, "task-progress-blocked", "pindie_task_progress", {
    blockers: ["missing staging token"],
    questions: [],
  }, semanticToolResult(blocked));

  const task = semanticBlocks(projection).find(
    (block): block is UiTaskSemanticBlock => block.category === "task",
  );
  assert.equal(task?.taskStatus, "blocked");
  assert.deepEqual(task?.blockers, ["missing staging token"]);
  assert.equal(projection.attention, null);
  const refreshed = refreshProjectionFacts(projection, input({
    presentation: presentation({
      semantic: {
        ...presentation().semantic,
        snapshot: { ...presentation().semantic.snapshot, taskStatus: "blocked", hasBlockers: true },
      },
      status: { ...presentation().status, state: blocked },
    }),
  }));
  assert.equal(refreshed.attention, null);
});

test("keeps a blocker beyond the former presentation bound in semantic truth", () => {
  const blockers = Array.from({ length: 65 }, (_, index) => `blocker-${index + 1}`);
  const blocked = semanticState({ blockers });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "blocked-tail", "pindie_task_progress", {
    blockers,
    questions: [],
  }, semanticToolResult(blocked));

  const task = semanticBlocks(projection).find(
    (block): block is UiTaskSemanticBlock => block.category === "task",
  );
  assert.equal(task?.taskStatus, "blocked");
  assert.equal(task?.blockers[64], "blocker-65");
});

test("keeps verification pending for 65 criteria when only the first 64 are covered", () => {
  const covered = Array.from({ length: 64 }, (_, index) => `c${index + 1}`);
  const verified = semanticState({
    criteriaCount: 65,
    checks: [{
      name: "first-64",
      status: "passed",
      covers: covered,
      evidence: "The first 64 criteria passed.",
    }],
  });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "verify-tail", "pindie_verification_record", {
    check: {
      name: "first-64",
      status: "passed",
      covers: covered,
      evidenceRefs: ["evidence-first-64"],
    },
  }, semanticToolResult(verified));

  const verification = semanticBlocks(projection).find(
    (block): block is UiVerificationSemanticBlock => block.category === "verification",
  );
  assert.equal(verification?.verificationStatus, "pending");
  assert.equal(verification?.totalCriteria, 65);
  assert.equal(verification?.coveredCriteria.length, 64);
  assert.notEqual(verification?.verificationStatus, "passed");
});

test("does not create successful Completion from a truncated uncovered criterion tail", () => {
  const covered = Array.from({ length: 64 }, (_, index) => `c${index + 1}`);
  const incomplete = semanticState({
    criteriaCount: 65,
    checks: [{
      name: "first-64",
      status: "passed",
      covers: covered,
      evidence: "The first 64 criteria passed.",
    }],
    completed: true,
  });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "completion-tail", "pindie_task_complete", {
    summary: "Should not complete",
  }, semanticToolResult(incomplete));

  const completion = semanticBlocks(projection).find(
    (block): block is UiCompletionSemanticBlock => block.category === "completion",
  );
  assert.equal(completion?.lifecycle, "failed");
  assert.match(completion?.error ?? "", /invalid Pindie State/);
  assert.notEqual(completion?.lifecycle, "complete");
});

test("fails closed on malformed semantic data after the former presentation bound", () => {
  const malformed = semanticState({
    checks: Array.from({ length: 65 }, (_, index) => ({
      name: `check-${index + 1}`,
      status: "passed" as const,
      covers: ["c1"],
      evidence: "valid",
    })),
  });
  (malformed.task!.verification.checks as unknown[])[64] = {
    name: "check-65",
    status: "passed",
    covers: ["c1"],
  };
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "malformed-tail", "pindie_verification_record", {
    check: {
      name: "check-65",
      status: "passed",
      covers: ["c1"],
      evidenceRefs: ["evidence-malformed-tail"],
    },
  }, semanticToolResult(malformed));

  const verification = semanticBlocks(projection).find(
    (block): block is UiVerificationSemanticBlock => block.category === "verification",
  );
  assert.equal(verification?.lifecycle, "failed");
  assert.match(verification?.error ?? "", /malformed Task State/);
  assert.notEqual(verification?.verificationStatus, "passed");
});

test("projects one Verification episode from resulting State and keeps success visible", () => {
  const task = semanticState({ goal: "Verify the timeline", criteriaCount: 3 });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "verify-task-start", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one", "two", "three"],
  }, semanticToolResult(task));
  const checks: VerificationCheck[] = [];
  for (const [id, name] of [["c1", "projection tests"], ["c2", "TUI tests"], ["c3", "full check"]] as const) {
    checks.push({ name, status: "passed", covers: [id], evidence: `${name} passed` });
    projection = applySemanticLive(projection, `verify-${id}`, "pindie_verification_record", {
      check: { name, status: "passed", covers: [id], evidenceRefs: [`evidence-${id}`] },
    }, semanticToolResult(semanticState({
      goal: task.task!.goal,
      criteriaCount: 3,
      checks,
    })));
    const verification = semanticBlocks(projection).filter(
      (block): block is UiVerificationSemanticBlock => block.category === "verification",
    );
    assert.equal(verification.length, 1);
    assert.equal(verification[0]?.id, "semantic:verification:verify-c1");
    assert.equal(verification[0]?.coveredCriteria.length, checks.length);
    assert.equal(verification[0]?.totalCriteria, 3);
  }

  const verification = semanticBlocks(projection).find(
    (block): block is UiVerificationSemanticBlock => block.category === "verification",
  );
  assert.equal(verification?.verificationStatus, "passed");
  assert.equal(verification?.defaultDisplayMode, "full");
  assert.deepEqual(verification?.checks.map((check) => check.evidence), [
    "projection tests passed",
    "TUI tests passed",
    "full check passed",
  ]);
});

test("failed verification remains visible without treating its input as State", () => {
  const task = semanticState({ goal: "Show verification failure", criteriaCount: 2 });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "failure-task", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one", "two"],
  }, semanticToolResult(task));
  const passed = semanticState({
    goal: task.task!.goal,
    criteriaCount: 2,
    checks: [{ name: "one", status: "passed", covers: ["c1"], evidence: "one passed" }],
  });
  projection = applySemanticLive(projection, "verify-pass", "pindie_verification_record", {
    check: { name: "one", status: "passed", covers: ["c1"], evidenceRefs: ["pass"] },
  }, semanticToolResult(passed));
  projection = applySemanticLive(projection, "verify-fail", "pindie_verification_record", {
    check: { name: "two", status: "failed", covers: ["c2"], evidenceRefs: ["fail"] },
  }, semanticToolResult(undefined, { isError: true, text: "check rejected" }));

  const verification = semanticBlocks(projection).find(
    (block): block is UiVerificationSemanticBlock => block.category === "verification",
  );
  assert.equal(verification?.lifecycle, "failed");
  assert.equal(verification?.defaultDisplayMode, "full");
  assert.equal(verification?.verificationStatus, "pending");
  assert.equal(projection.semanticTimeline.currentVerificationBlockId, "semantic:verification:verify-pass");
  assert.match(verification?.error ?? "", /check rejected/);
});

test("projects and resolves a Human Gate while keeping Attention separate", () => {
  const active = semanticState({ goal: "Ask for deployment approval" });
  let projection = createProjection(input({
    presentation: presentation({ status: { ...presentation().status, state: active } }),
  }));
  projection = applySemanticLive(projection, "gate-task", "pindie_task_start", {
    goal: active.task!.goal,
    successCriteria: ["approval"],
  }, semanticToolResult(active));
  const opened = semanticState({
    goal: active.task!.goal,
    humanGate: { kind: "decision", question: "Deploy migration to production?", options: ["Deploy", "Hold"] },
  });
  projection = applySemanticLive(projection, "gate-open", "pindie_gate_open", {
    kind: "decision",
    question: "Deploy migration to production?",
    options: ["Deploy", "Hold"],
  }, semanticToolResult(opened));

  const openGate = semanticBlocks(projection).find(
    (block): block is UiHumanGateSemanticBlock => block.category === "human-gate",
  );
  assert.equal(openGate?.state, "open");
  assert.equal(openGate?.question, "Deploy migration to production?");
  assert.deepEqual(openGate?.options, ["Deploy", "Hold"]);
  assert.equal(projection.attention, null);
  const attentionProjection = refreshProjectionFacts(projection, input({
    presentation: presentation({
      semantic: { ...presentation().semantic, snapshot: { ...presentation().semantic.snapshot, taskStatus: "waiting_human" } },
      status: { ...presentation().status, state: opened },
    }),
  }));
  assert.deepEqual(attentionProjection.attention, {
    kind: "human-gate",
    gateKind: "decision",
    question: "Deploy migration to production?",
    options: ["Deploy", "Hold"],
  });

  const resolved = semanticState({ goal: active.task!.goal });
  projection = applySemanticLive(projection, "gate-resolve", "pindie_gate_resolve", {}, semanticToolResult(resolved));
  const resolvedGate = semanticBlocks(projection).find(
    (block): block is UiHumanGateSemanticBlock => block.category === "human-gate",
  );
  assert.equal(resolvedGate?.state, "resolved");
  assert.equal(resolvedGate?.question, "Deploy migration to production?");
  assert.equal(projection.semanticTimeline.openHumanGateBlockId, null);
  assert.equal(semanticBlocks(projection).some((block) => JSON.stringify(block).includes("pindie_gate_resolve")), false);
});

test("completion uses argument summary and completed resulting State", () => {
  const task = semanticState({ goal: "Implement Semantic Timeline", criteriaCount: 2 });
  const completed = semanticState({
    goal: task.task!.goal,
    criteriaCount: 2,
    checks: [
      { name: "projection tests", status: "passed", covers: ["c1", "c2"], evidence: "all tests passed" },
    ],
    completed: true,
  });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "complete-task", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one", "two"],
  }, semanticToolResult(task));
  projection = applySemanticLive(projection, "complete-verify", "pindie_verification_record", {
    check: { name: "projection tests", status: "passed", covers: ["c1", "c2"], evidenceRefs: ["evidence"] },
  }, semanticToolResult(completed));
  projection = applySemanticLive(projection, "complete-call", "pindie_task_complete", {
    summary: "Semantic Timeline implemented",
  }, semanticToolResult(completed, { text: "Summary:\nWRONG PROSE" }));

  const completion = semanticBlocks(projection).find(
    (block): block is UiCompletionSemanticBlock => block.category === "completion",
  );
  assert.equal(completion?.lifecycle, "complete");
  assert.equal(completion?.summary, "Semantic Timeline implemented");
  assert.equal(completion?.defaultDisplayMode, "full");
  assert.equal(completion?.checks[0]?.evidence, "all tests passed");
  assert.equal(projection.semanticTimeline.currentTaskBlockId, null);
  assert.equal(projection.semanticTimeline.currentVerificationBlockId, null);
  assert.equal(JSON.stringify(completion).includes("pindie_task_complete"), false);

  let inconsistent = createProjection(input({ presentation: null }));
  inconsistent = applySemanticLive(inconsistent, "inconsistent", "pindie_task_complete", {
    summary: "Should not be completed",
  }, semanticToolResult(task));
  const degraded = semanticBlocks(inconsistent).find(
    (block): block is UiCompletionSemanticBlock => block.category === "completion",
  );
  assert.equal(degraded?.lifecycle, "failed");
  assert.equal(degraded?.defaultDisplayMode, "full");
  assert.match(degraded?.error ?? "", /did not mark/);
});

test("semantic failures stay visible and do not advance phase metadata", () => {
  const task = semanticState({ goal: "Preserve failed transitions" });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "failed-start", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one"],
  }, semanticToolResult(undefined, { isError: true, text: "start rejected" }));
  assert.equal(projection.semanticTimeline.currentTaskBlockId, null);
  const failedStart = semanticBlocks(projection)[0] as UiTaskSemanticBlock;
  assert.equal(failedStart.lifecycle, "failed");
  assert.equal(failedStart.defaultDisplayMode, "full");

  projection = applySemanticLive(projection, "successful-start", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one"],
  }, semanticToolResult(task));
  const currentTaskId = projection.semanticTimeline.currentTaskBlockId;
  projection = applySemanticLive(projection, "failed-complete", "pindie_task_complete", {
    summary: "Rejected completion",
  }, semanticToolResult(undefined, { isError: true, text: "completion rejected" }));
  assert.equal(projection.semanticTimeline.currentTaskBlockId, currentTaskId);
  const failedCompletion = semanticBlocks(projection).find(
    (block): block is UiCompletionSemanticBlock => block.category === "completion",
  );
  assert.equal(failedCompletion?.lifecycle, "failed");
  assert.match(failedCompletion?.error ?? "", /completion rejected/);

  projection = applySemanticLive(projection, "failed-gate", "pindie_gate_open", {
    kind: "decision",
    question: "Open?",
  }, semanticToolResult(undefined, { isError: true, text: "gate rejected" }));
  assert.equal(projection.attention, null);
  assert.equal(projection.semanticTimeline.openHumanGateBlockId, null);
});

test("projects task handoff as a restrained Task milestone", () => {
  const task = semanticState({ goal: "Stage a continuation", nextIntent: "Resume in a new Session" });
  let projection = createProjection(input({ presentation: null }));
  projection = applySemanticLive(projection, "handoff-task", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["handoff"],
  }, semanticToolResult(task));
  projection = applySemanticLive(projection, "handoff-call", "pindie_task_handoff", {
    progressSummary: "Implementation is ready for continuation.",
    decisions: ["Keep the projection renderer-independent."],
    nextIntent: "Resume in a new Session",
  }, semanticToolResult(task));
  const tasks = semanticBlocks(projection).filter(
    (block): block is UiTaskSemanticBlock => block.category === "task",
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.handoff?.progressSummary, "Implementation is ready for continuation.");
  assert.equal(tasks[0]?.nextIntent, "Resume in a new Session");
});

test("projects header and ambient status from Presentation and active Session facts", () => {
  const projection = createProjection(input({
    presentation: presentation({
      status: {
        ...presentation().status,
        consumption: { scope: "task", durationMs: 2_000, cost: 0.25 },
        activity: "running",
        reasoningMode: "manual",
      },
      projectRoot: "/workspace/pindie",
    }),
    session: {
      ...input().session,
      sessionId: "session-header",
      displayIdentity: "Pindie work",
      model: { provider: "openai", modelId: "gpt-test" },
      thinkingLevel: "low",
      runtime: runtime({
        sessionId: "session-header",
        isStreaming: true,
        isCompacting: true,
        isIdle: false,
        pendingMessageCount: 2,
      }),
    },
  }));

  assert.deepEqual(projection.header, {
    projectRoot: "/workspace/pindie",
    displayIdentity: "Pindie work",
    sessionId: "session-header",
    model: { provider: "openai", modelId: "gpt-test" },
    thinkingLevel: "low",
    taskStatus: "active",
    semanticAuthority: "coherent",
  });
  assert.equal(projection.status.isStreaming, true);
  assert.equal(projection.status.isCompacting, true);
  assert.equal(projection.status.pendingMessageCount, 2);
  assert.equal(projection.status.activity, "running");
  assert.equal(projection.status.consumption?.scope, "task");
  assert.equal(projection.status.reasoningMode, "manual");
  assert.equal(projection.status.semanticAuthority, "coherent");
});

test("semantic authority and task facts come from presentation.semantic", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "stale",
          taskStatus: "active",
          verificationStatus: "failed",
          hasBlockers: false,
          hasQuestions: true,
          completionReady: false,
        },
      },
      status: {
        ...presentation().status,
        state: state({
          openLoops: { blockers: ["source state says blocked"], questions: [], nextIntent: null },
        }),
      },
    }),
  }));

  assert.equal(projection.header.semanticAuthority, "stale");
  assert.equal(projection.header.taskStatus, "active");
  assert.equal(projection.status.verificationStatus, "failed");
  assert.equal(projection.status.hasBlockers, false);
  assert.equal(projection.status.hasQuestions, true);
});

test("presentation=null is safe, visibly unavailable, and creates no false attention", () => {
  const projection = createProjection(input({ presentation: null }));

  assert.equal(projection.status.presentationAvailability, "unavailable");
  assert.equal(projection.status.semanticAuthority, "presentation-unavailable");
  assert.equal(projection.header.semanticAuthority, "presentation-unavailable");
  assert.equal(projection.attention, null);
});

test("current Human Gate becomes detached structured attention", () => {
  const gate = { kind: "decision", question: "Ship this change?", options: ["yes", "no"] } as const;
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "coherent",
          taskStatus: "waiting_human",
          verificationStatus: "pending",
          hasBlockers: false,
          hasQuestions: false,
          completionReady: false,
          taskRelation: "introduced_during_run",
          completionRelation: "not_completed",
          gateRelation: "opened_during_run",
        },
      },
      status: { ...presentation().status, state: state({ humanGate: gate }) },
    }),
  }));

  assert.deepEqual(projection.attention, {
    kind: "human-gate",
    gateKind: "decision",
    question: "Ship this change?",
    options: ["yes", "no"],
  });
});

test("blocked Task does not automatically become Attention", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: {
        ok: true,
        snapshot: {
          authority: "coherent",
          taskStatus: "blocked",
          verificationStatus: "pending",
          hasBlockers: true,
          hasQuestions: false,
          completionReady: false,
          taskRelation: "introduced_during_run",
          completionRelation: "not_completed",
          gateRelation: "none",
        },
      },
      status: {
        ...presentation().status,
        state: state({
          openLoops: { blockers: ["waiting on a recoverable fact"], questions: [], nextIntent: null },
        }),
      },
    }),
  }));

  assert.equal(projection.header.taskStatus, "blocked");
  assert.equal(projection.status.hasBlockers, true);
  assert.equal(projection.attention, null);
});

test("unavailable semantic authority becomes structured degraded Attention", () => {
  const projection = createProjection(input({
    presentation: presentation({
      semantic: { ok: true, snapshot: { authority: "unavailable" } },
    }),
  }));

  assert.deepEqual(projection.attention, {
    kind: "authority-unavailable",
    reason: "Pindie semantic authority is unavailable.",
  });
  assert.equal(projection.status.semanticAuthority, "unavailable");

  const failed = createProjection(input({
    presentation: presentation({ semantic: { ok: false, error: "derivation failed safely" } }),
  }));
  assert.deepEqual(failed.attention, {
    kind: "authority-unavailable",
    reason: "derivation failed safely",
  });
});

test("history rebuild uses Session entry IDs and excludes aborted content", () => {
  const timeline = projectSessionHistory([
    userEntry("entry-user", "human intent"),
    assistantEntry("entry-assistant", "visible answer"),
    assistantEntry("entry-aborted", "misleading partial answer", "aborted"),
  ]);

  assert.deepEqual(timeline.map((block) => [block.type, block.id]), [
    ["message", "entry-user"],
    ["message", "entry-assistant"],
  ]);
  assert.equal((timeline[0] as UiMessageBlock).text, "human intent");
  assert.equal((timeline[1] as UiMessageBlock).text, "visible answer");
});

test("hidden/internal messages and thinking do not leak into normal Timeline", () => {
  const timeline = projectSessionHistory([
    userEntry("visible-user", "visible"),
    customMessageEntry("hidden-custom", "pindie-state-checkpoint", "secret state", false),
    customMessageEntry("hidden-probe", "pindie-active-task-continuation", "probe", true),
    messageEntry("thinking-only", assistantMessage([{ type: "thinking", thinking: "private chain" }])),
    messageEntry("mixed", assistantMessage([
      { type: "thinking", thinking: "private chain" },
      { type: "text", text: "visible answer" },
    ], "stop")),
  ]);

  assert.deepEqual(timeline.map((block) => block.id), ["visible-user", "mixed"]);
  assert.equal((timeline[1] as UiMessageBlock).text, "visible answer");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("private chain")), false);

  const thinkingOnly = reduceProjectionEvent(
    createProjection(input()),
    event({
      type: "message_start",
      message: assistantMessage([{ type: "thinking", thinking: "private live chain" }]),
    }),
  );
  assert.equal(thinkingOnly.timeline.length, 0);
});

test("rebuilds persisted assistant toolCall plus toolResult into one observation WorkBlock", () => {
  const timeline = projectSessionHistory([
    userEntry("history-user", "inspect the project"),
    assistantToolEntry("history-assistant", [
      { id: "read-1", name: "read", arguments: { path: "src/runtime.ts" } },
    ], "I will inspect that."),
    toolResultEntry("history-result", "read-1", "read", { text: "file contents" }),
  ]);

  assert.deepEqual(timeline.map((block) => [block.type, block.id]), [
    ["message", "history-user"],
    ["message", "history-assistant"],
    ["work", "observe:read-1"],
  ]);
  const observation = timeline[2] as UiObservationWorkBlock;
  assert.equal(observation.kind, "observation");
  assert.equal(observation.lifecycle, "complete");
  assert.equal(observation.defaultDisplayMode, "compact");
  assert.equal(observation.items[0]?.toolCallId, "read-1");
  assert.equal(observation.items[0]?.lifecycle, "complete");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes('"role":"toolResult"')), false);
});

test("groups consecutive historical read, grep, and ls calls into one observation burst", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("assistant-observe", [
      { id: "read-1", name: "read", arguments: { path: "a.ts" } },
      { id: "grep-1", name: "grep", arguments: { pattern: "quotaResume", path: "src" } },
      { id: "ls-1", name: "ls", arguments: { path: "src" } },
    ]),
    toolResultEntry("result-read", "read-1", "read"),
    toolResultEntry("result-grep", "grep-1", "grep"),
    toolResultEntry("result-ls", "ls-1", "ls"),
  ]);

  const observations = timeline.filter(
    (block): block is UiObservationWorkBlock => block.type === "work" && block.kind === "observation",
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), [
    "read-1",
    "grep-1",
    "ls-1",
  ]);
  assert.equal(observations[0]?.lifecycle, "complete");
  assert.equal(observations[0]?.defaultDisplayMode, "compact");
});

test("reconstructs edit, command, unknown, and reserved semantic history without chat leaks", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("assistant-work", [
      { id: "edit-1", name: "edit", arguments: { path: "src/runtime.ts", oldText: "a", newText: "b" } },
    ]),
    toolResultEntry("result-edit", "edit-1", "edit"),
    assistantToolEntry("assistant-command", [
      { id: "bash-1", name: "bash", arguments: { command: "pnpm test" } },
    ]),
    toolResultEntry("result-bash", "bash-1", "bash", { text: "ok" }),
    assistantToolEntry("assistant-unknown", [
      { id: "unknown-1", name: "future_tool", arguments: { value: "kept" } },
      { id: "semantic-1", name: "pindie_task_progress", arguments: { nextIntent: "continue" } },
    ]),
    toolResultEntry("result-unknown", "unknown-1", "future_tool", { text: "future result" }),
    toolResultEntry("result-semantic", "semantic-1", "pindie_task_progress"),
  ]);

  const work = timeline.filter((block): block is UiWorkBlock => block.type === "work");
  assert.deepEqual(work.map((block) => block.kind), ["edit", "command", "generic"]);
  assert.equal((work[0] as UiToolWorkBlock).toolCallId, "edit-1");
  assert.equal((work[1] as UiToolWorkBlock).toolCallId, "bash-1");
  assert.equal((work[2] as UiToolWorkBlock).toolCallId, "unknown-1");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("pindie_task_progress")), false);
  assert.equal(timeline.some((block) => JSON.stringify(block).includes('"role":"toolResult"')), false);
});

test("reconstructs historical semantic blocks chronologically from toolCall args and details.state", () => {
  const task = semanticState({ goal: "Historical semantic work", criteriaCount: 2 });
  const progress = semanticState({ goal: task.task!.goal, criteriaCount: 2, nextIntent: "Verify" });
  const verified = semanticState({
    goal: task.task!.goal,
    criteriaCount: 2,
    checks: [{ name: "tests", status: "passed", covers: ["c1", "c2"], evidence: "tests passed" }],
  });
  const completed = semanticState({
    goal: task.task!.goal,
    criteriaCount: 2,
    checks: verified.task!.verification.checks,
    completed: true,
  });
  const timeline = projectSessionHistory([
    userEntry("history-intent", "Implement the historical semantic work"),
    assistantToolEntry("history-start-call", [{
      id: "history-start",
      name: "pindie_task_start",
      arguments: { goal: task.task!.goal, successCriteria: ["one", "two"] },
    }]),
    toolResultEntry("history-start-result", "history-start", "pindie_task_start", {
      details: { state: task },
      text: "Current task started.",
    }),
    assistantToolEntry("history-read-call", [{
      id: "history-read",
      name: "read",
      arguments: { path: "src/ui-projection.ts" },
    }]),
    toolResultEntry("history-read-result", "history-read", "read"),
    assistantToolEntry("history-progress-call", [{
      id: "history-progress",
      name: "pindie_task_progress",
      arguments: { blockers: [], questions: [], nextIntent: "Verify" },
    }]),
    toolResultEntry("history-progress-result", "history-progress", "pindie_task_progress", {
      details: { state: progress },
    }),
    assistantToolEntry("history-verify-call", [{
      id: "history-verify",
      name: "pindie_verification_record",
      arguments: { check: { name: "tests", status: "passed", covers: ["c1", "c2"], evidenceRefs: ["e1"] } },
    }]),
    toolResultEntry("history-verify-result", "history-verify", "pindie_verification_record", {
      details: { state: verified },
    }),
    assistantToolEntry("history-complete-call", [{
      id: "history-complete",
      name: "pindie_task_complete",
      arguments: { summary: "Historical completion summary" },
    }]),
    toolResultEntry("history-complete-result", "history-complete", "pindie_task_complete", {
      details: { state: completed },
      text: "Summary:\nWRONG RESULT PROSE",
    }),
  ]);

  assert.deepEqual(timeline.map((block) => block.type), [
    "message",
    "semantic",
    "work",
    "semantic",
    "semantic",
  ]);
  const semantic = timeline.filter((block): block is UiSemanticBlock => block.type === "semantic");
  assert.deepEqual(semantic.map((block) => block.category), ["task", "verification", "completion"]);
  const taskBlock = semantic[0] as UiTaskSemanticBlock;
  const verification = semantic[1] as UiVerificationSemanticBlock;
  const completion = semantic[2] as UiCompletionSemanticBlock;
  assert.equal(taskBlock.id, "semantic:task:history-start");
  assert.equal(taskBlock.nextIntent, "Verify");
  assert.equal(verification.id, "semantic:verification:history-verify");
  assert.equal(verification.verificationStatus, "passed");
  assert.equal(completion.summary, "Historical completion summary");
  assert.equal(completion.checks[0]?.evidence, "tests passed");
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("pindie_task_")), false);
  assert.equal(timeline.some((block) => JSON.stringify(block).includes('"role":"toolResult"')), false);
});

test("live and historical semantic projections preserve meaningful fields", () => {
  const task = semanticState({ goal: "Equivalent semantic history", criteriaCount: 2 });
  const progress = semanticState({ goal: task.task!.goal, criteriaCount: 2, nextIntent: "Verify" });
  const verified = semanticState({
    goal: task.task!.goal,
    criteriaCount: 2,
    checks: [{ name: "tests", status: "passed", covers: ["c1", "c2"], evidence: "tests passed" }],
  });
  let live = createProjection(input({ presentation: null }));
  live = applySemanticLive(live, "equiv-start", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["one", "two"],
  }, semanticToolResult(task));
  live = applySemanticLive(live, "equiv-progress", "pindie_task_progress", {
    blockers: [],
    questions: [],
    nextIntent: "Verify",
  }, semanticToolResult(progress));
  live = applySemanticLive(live, "equiv-verify", "pindie_verification_record", {
    check: { name: "tests", status: "passed", covers: ["c1", "c2"], evidenceRefs: ["evidence"] },
  }, semanticToolResult(verified));

  const history = projectSessionHistory([
    assistantToolEntry("equiv-start-call", [{
      id: "equiv-start",
      name: "pindie_task_start",
      arguments: { goal: task.task!.goal, successCriteria: ["one", "two"] },
    }]),
    toolResultEntry("equiv-start-result", "equiv-start", "pindie_task_start", { details: { state: task } }),
    assistantToolEntry("equiv-progress-call", [{
      id: "equiv-progress",
      name: "pindie_task_progress",
      arguments: { blockers: [], questions: [], nextIntent: "Verify" },
    }]),
    toolResultEntry("equiv-progress-result", "equiv-progress", "pindie_task_progress", { details: { state: progress } }),
    assistantToolEntry("equiv-verify-call", [{
      id: "equiv-verify",
      name: "pindie_verification_record",
      arguments: { check: { name: "tests", status: "passed", covers: ["c1", "c2"], evidenceRefs: ["evidence"] } },
    }]),
    toolResultEntry("equiv-verify-result", "equiv-verify", "pindie_verification_record", { details: { state: verified } }),
  ]);
  const liveSemantic = semanticBlocks(live);
  const historySemantic = history.filter((block): block is UiSemanticBlock => block.type === "semantic");
  assert.deepEqual(liveSemantic.map((block) => block.category), historySemantic.map((block) => block.category));
  assert.deepEqual(
    liveSemantic.map((block) => block.category === "task"
      ? { category: block.category, goal: block.goal, status: block.taskStatus, density: block.defaultDisplayMode }
      : block.category === "verification"
        ? { category: block.category, status: block.verificationStatus, covered: block.coveredCriteria, checks: block.checks, density: block.defaultDisplayMode }
        : { category: block.category }),
    historySemantic.map((block) => block.category === "task"
      ? { category: block.category, goal: block.goal, status: block.taskStatus, density: block.defaultDisplayMode }
      : block.category === "verification"
        ? { category: block.category, status: block.verificationStatus, covered: block.coveredCriteria, checks: block.checks, density: block.defaultDisplayMode }
        : { category: block.category }),
  );
});

test("semantic boundaries close observation bursts without reconnecting them", () => {
  let projection = createProjection(input({ presentation: null }));
  const reduce = (value: Record<string, unknown>) => {
    projection = reduceProjectionEvent(projection, event(value));
  };
  reduce({ type: "tool_execution_start", toolCallId: "before-semantic", toolName: "read", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "before-semantic", toolName: "read", result: { content: [] }, isError: false });
  const task = semanticState({ goal: "Close the observation boundary" });
  projection = applySemanticLive(projection, "boundary-task", "pindie_task_start", {
    goal: task.task!.goal,
    successCriteria: ["boundary"],
  }, semanticToolResult(task));
  reduce({ type: "tool_execution_start", toolCallId: "after-semantic", toolName: "read", args: { path: "b.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "after-semantic", toolName: "read", result: { content: [] }, isError: false });
  assert.deepEqual(observationBlocks(projection).map((block) => block.id), [
    "observe:before-semantic",
    "observe:after-semantic",
  ]);
});

test("historical semantic calls without results remain visible as failed semantic blocks", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("missing-semantic", [{
      id: "missing-complete",
      name: "pindie_task_complete",
      arguments: { summary: "Interrupted completion" },
    }]),
  ]);
  const completion = timeline[0] as UiCompletionSemanticBlock;
  assert.equal(completion.category, "completion");
  assert.equal(completion.lifecycle, "failed");
  assert.equal(completion.defaultDisplayMode, "full");
  assert.match(completion.error ?? "", /not persisted/);
});

test("historical tool calls without results remain visible as non-success work", () => {
  const timeline = projectSessionHistory([
    assistantToolEntry("interrupted", [
      { id: "unfinished", name: "bash", arguments: { command: "pnpm test" } },
    ]),
  ]);
  const work = timeline[0] as UiToolWorkBlock;
  assert.equal(work.kind, "command");
  assert.equal(work.lifecycle, "failed");
  assert.equal(work.defaultDisplayMode, "full");
  assert.match(work.result?.summary ?? "", /not persisted/);
});

test("assistant tool history keeps thinking absent", () => {
  const timeline = projectSessionHistory([
    messageEntry("thinking-and-tool", assistantMessage([
      { type: "thinking", thinking: "private chain" },
      { type: "toolCall", id: "read-thinking", name: "read", arguments: { path: "a.ts" } },
    ])),
    toolResultEntry("read-thinking-result", "read-thinking", "read"),
  ]);
  assert.equal(timeline.some((block) => JSON.stringify(block).includes("private chain")), false);
  assert.equal(timeline.some((block) => block.type === "message" && block.text.length === 0), false);
});

test("assistant streaming updates one session-local live MessageBlock", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "first" }, { type: "thinking", thinking: "hidden" }]),
    assistantMessageEvent: {},
  }));
  const firstBlock = messageBlocks(projection)[0];
  assert.equal(firstBlock?.id, "live:session-1:assistant:1");
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "latest" }]),
    assistantMessageEvent: {},
  }));
  assert.equal(messageBlocks(projection).length, 1);
  assert.equal(messageBlocks(projection)[0]?.id, firstBlock?.id);

  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "latest" }], "stop"),
  }));

  assert.equal(projection.timeline.length, 1);
  const block = projection.timeline[0] as UiMessageBlock;
  assert.equal(block.type, "message");
  assert.equal(block.source, "live");
  assert.equal(block.id, firstBlock?.id);
  assert.equal(block.lifecycle, "complete");
  assert.equal(block.text, "latest");
});

test("sequential assistant messages remain distinct completed live blocks", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [
    { id: "live:session-1:assistant:1", text: "answer A", lifecycle: "complete" },
    { id: "live:session-1:assistant:2", text: "answer B", lifecycle: "complete" },
  ]);
});

test("aborting the current assistant removes only that live block", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B partial" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_update",
    message: assistantMessage([{ type: "text", text: "answer B latest" }]),
    assistantMessageEvent: {},
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B latest" }], "aborted"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [{
    id: "live:session-1:assistant:1",
    text: "answer A",
    lifecycle: "complete",
  }]);
});

test("assistant error history remains visible after the stream ends", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "failed answer" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "failed answer" }], "error"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    text: block.text,
    lifecycle: block.lifecycle,
  })), [{
    id: "live:session-1:assistant:1",
    text: "failed answer",
    lifecycle: "error",
  }]);
});

test("entry_appended reconciles only the matching latest live assistant", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: assistantEntry("persisted-assistant-b", "answer B"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "live:session-1:assistant:1", source: "live", text: "answer A" },
    { id: "persisted-assistant-b", source: "session", text: "answer B" },
  ]);
});

test("mismatched persisted assistant reconciliation preserves older live history", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: assistantEntry("persisted-assistant-b", "persisted B wording"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "live:session-1:assistant:1", source: "live", text: "answer A" },
    { id: "persisted-assistant-b", source: "session", text: "persisted B wording" },
  ]);
});

test("tool calls remain separate and repeated updates replace one WorkBlock", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "tool-b",
    toolName: "bash",
    args: { command: "pwd" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
    partialResult: { content: [{ type: "text", text: "first preview" }] },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "a.ts" },
    partialResult: { content: [{ type: "text", text: "latest preview" }] },
  }));

  assert.deepEqual(workBlocks(projection).map((block) => block.kind), ["observation", "command"]);
  const observed = workBlocks(projection)[0] as UiObservationWorkBlock;
  assert.deepEqual(observed.items.map((item) => item.toolCallId), ["tool-a"]);
  assert.equal(observed.items[0]?.result?.summary, "latest preview");

  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "tool-a",
    toolName: "read",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "tool-b",
    toolName: "bash",
    result: { content: [{ type: "text", text: "failed" }] },
    isError: true,
  }));

  const finalA = workBlocks(projection).find(
    (block): block is UiObservationWorkBlock => block.kind === "observation",
  );
  const finalB = workBlocks(projection).find(
    (block): block is UiToolWorkBlock => block.kind === "command",
  );
  assert.equal(finalA?.lifecycle, "complete");
  assert.equal(finalA?.items[0]?.result?.summary, "done");
  assert.equal(finalB?.lifecycle, "failed");
  assert.equal(finalB?.result?.isError, true);
});

test("live consecutive observations share one deterministic group and compact on success", () => {
  let projection = createProjection(input());
  for (const [toolCallId, toolName, args] of [
    ["read-live-1", "read", { path: "a.ts" }],
    ["read-live-2", "read", { path: "b.ts" }],
    ["grep-live-1", "grep", { pattern: "quotaResume", path: "src" }],
    ["ls-live-1", "ls", { path: "src" }],
  ] as const) {
    projection = reduceProjectionEvent(projection, event({
      type: "tool_execution_start",
      toolCallId,
      toolName,
      args,
    }));
    projection = reduceProjectionEvent(projection, event({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [] },
      isError: false,
    }));
  }

  const observations = observationBlocks(projection);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.id, "observe:read-live-1");
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), [
    "read-live-1",
    "read-live-2",
    "grep-live-1",
    "ls-live-1",
  ]);
  assert.equal(observations[0]?.lifecycle, "complete");
  assert.equal(observations[0]?.defaultDisplayMode, "compact");
});

test("visible user and assistant messages close live observation bursts", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "before-user",
    toolName: "read",
    args: { path: "a.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "before-user",
    toolName: "read",
    result: { content: [] },
    isError: false,
  }));
  projection = appendUserDelivery(projection, {
    id: "live:user-boundary",
    text: "continue",
    delivery: "prompt",
  });
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "after-user",
    toolName: "read",
    args: { path: "b.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "after-user",
    toolName: "read",
    result: { content: [] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "done" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "done" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "after-assistant",
    toolName: "read",
    args: { path: "c.ts" },
  }));

  assert.deepEqual(observationBlocks(projection).map((block) => block.id), [
    "observe:before-user",
    "observe:after-user",
    "observe:after-assistant",
  ]);
});

test("live observation grouping closes around edits", () => {
  let projection = createProjection(input());
  const reduce = (value: Record<string, unknown>) => {
    projection = reduceProjectionEvent(projection, event(value));
  };
  reduce({ type: "tool_execution_start", toolCallId: "read-a", toolName: "read", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-a", toolName: "read", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "edit-a", toolName: "edit", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "edit-a", toolName: "edit", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "grep-b", toolName: "grep", args: { pattern: "next" } });
  reduce({ type: "tool_execution_end", toolCallId: "grep-b", toolName: "grep", result: { content: [] }, isError: false });

  assert.deepEqual(workBlocks(projection).map((block) => block.kind), ["observation", "edit", "observation"]);
  assert.equal((workBlocks(projection)[0] as UiObservationWorkBlock).id, "observe:read-a");
  assert.equal((workBlocks(projection)[2] as UiObservationWorkBlock).id, "observe:grep-b");
});

test("observation failure seals its group and leaves the next observation separate", () => {
  let projection = createProjection(input());
  const reduce = (value: Record<string, unknown>) => {
    projection = reduceProjectionEvent(projection, event(value));
  };
  reduce({ type: "tool_execution_start", toolCallId: "read-ok", toolName: "read", args: { path: "a.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-ok", toolName: "read", result: { content: [] }, isError: false });
  reduce({ type: "tool_execution_start", toolCallId: "grep-fail", toolName: "grep", args: { pattern: "missing" } });
  reduce({ type: "tool_execution_end", toolCallId: "grep-fail", toolName: "grep", result: { content: [{ type: "text", text: "not found" }] }, isError: true });
  reduce({ type: "tool_execution_start", toolCallId: "read-next", toolName: "read", args: { path: "b.ts" } });
  reduce({ type: "tool_execution_end", toolCallId: "read-next", toolName: "read", result: { content: [] }, isError: false });

  const observations = observationBlocks(projection);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[0]?.items.map((item) => item.toolCallId), ["read-ok", "grep-fail"]);
  assert.equal(observations[0]?.lifecycle, "failed");
  assert.equal(observations[0]?.defaultDisplayMode, "full");
  assert.deepEqual(observations[1]?.items.map((item) => item.toolCallId), ["read-next"]);
});

test("live edit and command updates retain one block identity and bounded command output", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "edit-live",
    toolName: "edit",
    args: { path: "src/runtime.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "edit-live",
    toolName: "edit",
    args: { path: "src/runtime.ts" },
    partialResult: { content: [{ type: "text", text: "preview" }] },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "edit-live",
    toolName: "edit",
    result: { content: [] },
    isError: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "bash-live",
    toolName: "bash",
    args: { command: "pnpm test" },
  }));
  const huge = Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n");
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "bash-live",
    toolName: "bash",
    args: { command: "pnpm test" },
    partialResult: { content: [{ type: "text", text: huge }] },
  }));

  assert.equal(toolWorkBlocks(projection).length, 2);
  const edit = toolWorkBlocks(projection).find((block) => block.toolCallId === "edit-live");
  const command = toolWorkBlocks(projection).find((block) => block.toolCallId === "bash-live");
  assert.equal(edit?.lifecycle, "complete");
  assert.equal(edit?.defaultDisplayMode, "compact");
  assert.equal(command?.lifecycle, "running");
  assert.equal(command?.defaultDisplayMode, "preview");
  assert.ok((command?.result?.summary.length ?? 0) <= 3_000);
  assert.match(command?.result?.summary ?? "", /line 79/);
});

test("entry_appended tool history reconciles by toolCallId without duplicating unrelated work", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "live-read",
    toolName: "read",
    args: { path: "live.ts" },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "unrelated-edit",
    toolName: "edit",
    args: { path: "other.ts" },
  }));
  const persistedAssistant = assistantToolEntry("persisted-assistant", [
    { id: "live-read", name: "read", arguments: { path: "live.ts" } },
  ]);
  projection = reduceProjectionEvent(projection, event({ type: "entry_appended", entry: persistedAssistant }));
  projection = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: toolResultEntry("persisted-result", "live-read", "read", { text: "done" }),
  }));

  assert.equal(workBlocks(projection).filter((block) =>
    block.kind === "observation" && block.items.some((item) => item.toolCallId === "live-read")).length, 1);
  assert.equal(workBlocks(projection).some((block) =>
    block.kind !== "observation" && block.toolCallId === "unrelated-edit"), true);
  const readGroup = observationBlocks(projection).find((block) =>
    block.items.some((item) => item.toolCallId === "live-read"));
  assert.equal(readGroup?.items.find((item) => item.toolCallId === "live-read")?.lifecycle, "complete");
});

test("queue_update replaces full queue state while preserving steering/followUp provenance", () => {
  let projection = createProjection(input({ session: {
    ...input().session,
    runtime: runtime({ pendingMessageCount: 3 }),
  } }));
  assert.equal(projection.queue.state, "unknown");
  assert.equal(projection.queue.steering, null);
  assert.equal(projection.queue.followUp, null);
  assert.equal(projection.queue.pendingMessageCount, 3);

  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: ["steer one"],
    followUp: ["follow one", "follow two"],
  }));
  assert.deepEqual(projection.queue, {
    state: "authoritative",
    steering: ["steer one"],
    followUp: ["follow one", "follow two"],
    pendingMessageCount: 3,
  });

  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: [],
    followUp: ["replacement"],
  }));
  assert.deepEqual(projection.queue.steering, []);
  assert.deepEqual(projection.queue.followUp, ["replacement"]);
  assert.equal(projection.status.pendingMessageCount, 1);
});

test("rebuilding for a new Session ID discards live blocks and queue observations", () => {
  let oldProjection = createProjection(input());
  oldProjection = reduceProjectionEvent(oldProjection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "old" }]),
  }));
  oldProjection = reduceProjectionEvent(oldProjection, event({
    type: "queue_update",
    steering: ["old steer"],
    followUp: [],
  }));
  assert.equal(oldProjection.queue.state, "authoritative");

  const freshProjection = createProjection(input({
    session: {
      ...input().session,
      sessionId: "session-2",
      displayIdentity: "fresh",
      runtime: runtime({ sessionId: "session-2", pendingMessageCount: 1 }),
      branch: [userEntry("fresh-entry", "new Session")],
    },
  }));

  assert.equal(freshProjection.header.sessionId, "session-2");
  assert.deepEqual(freshProjection.timeline.map((block) => block.id), ["fresh-entry"]);
  assert.equal(freshProjection.queue.state, "unknown");
  assert.equal(freshProjection.queue.steering, null);
  assert.equal(freshProjection.timeline.some((block) => block.id.includes("session-1")), false);
});

test("full rebuild replaces ephemeral assistant identities with Session entry IDs", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer A" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer A" }], "stop"),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "answer B" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "answer B" }], "stop"),
  }));

  assert.deepEqual(messageBlocks(projection).map((block) => block.id), [
    "live:session-1:assistant:1",
    "live:session-1:assistant:2",
  ]);

  const rebuilt = rebuildProjection(input({
    session: {
      ...input().session,
      branch: [
        assistantEntry("entry-a", "answer A"),
        assistantEntry("entry-b", "answer B"),
      ],
    },
  }));

  assert.deepEqual(messageBlocks(rebuilt).map((block) => ({
    id: block.id,
    source: block.source,
    text: block.text,
  })), [
    { id: "entry-a", source: "session", text: "answer A" },
    { id: "entry-b", source: "session", text: "answer B" },
  ]);
  assert.equal(rebuilt.timeline.some((block) => block.id.startsWith("live:")), false);
  assert.deepEqual(rebuilt.liveAssistant, { activeId: null, nextSequence: 1 });
});

test("projection operations isolate source Session entries, messages, and tool results", () => {
  const entry = assistantEntry("entry", "unchanged");
  const eventValue = {
    type: "tool_execution_update",
    toolCallId: "tool-copy",
    toolName: "read",
    args: { nested: { value: "before" } },
    partialResult: {
      content: [{ type: "text", text: "result before" }],
      details: { changed: false },
    },
  };
  const entryBefore = structuredClone(entry);
  const eventBefore = structuredClone(eventValue);

  let projection = createProjection(input({ session: { ...input().session, branch: [entry] } }));
  projection = reduceProjectionEvent(projection, event(eventValue));

  assert.deepEqual(entry, entryBefore);
  assert.deepEqual(eventValue, eventBefore);
  const work = workBlocks(projection)[0];
  assert.notEqual(work.input, (eventValue.args as { nested: unknown }));
  assert.notEqual(work.result?.details, (eventValue.partialResult as { details: unknown }).details);
});

test("runtime churn stays ambient rather than becoming permanent RuntimeBlocks", () => {
  let projection = createProjection(input());
  projection = reduceProjectionEvent(projection, event({ type: "agent_start" }));
  projection = reduceProjectionEvent(projection, event({ type: "compaction_start", reason: "threshold" }));
  projection = reduceProjectionEvent(projection, event({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 2,
    delayMs: 10,
    errorMessage: "temporary",
  }));
  projection = reduceProjectionEvent(projection, event({ type: "agent_settled" }));

  assert.equal(projection.timeline.some((block) => block.type === "runtime"), false);
  assert.equal(projection.status.isIdle, true);
  assert.equal(projection.status.isStreaming, false);
  assert.equal(projection.status.isCompacting, false);
});

test("local user deliveries are disposable, session-local, and provenance-aware", () => {
  const projection = appendUserDelivery(createProjection(input()), {
    id: "live:session-1:user:1",
    text: "steer the current work",
    delivery: "steer",
  });
  const block = projection.timeline[0] as UiMessageBlock;

  assert.deepEqual(block, {
    type: "message",
    id: "live:session-1:user:1",
    source: "live",
    role: "user",
    text: "steer the current work",
    lifecycle: "complete",
    defaultDisplayMode: "full",
    delivery: "steer",
  });

  const rebuilt = rebuildProjection(input({
    session: {
      ...input().session,
      branch: [userEntry("authoritative-user", "steer the current work")],
    },
  }));
  assert.deepEqual(rebuilt.timeline.map((candidate) => candidate.id), ["authoritative-user"]);

  const reconciled = reduceProjectionEvent(projection, event({
    type: "entry_appended",
    entry: userEntry("authoritative-user", "steer the current work"),
  }));
  assert.deepEqual(reconciled.timeline.map((candidate) => candidate.id), ["authoritative-user"]);
  assert.equal((reconciled.timeline[0] as UiMessageBlock).source, "session");
  assert.equal((reconciled.timeline[0] as UiMessageBlock).delivery, "steer");
});

test("same-session fact refresh preserves live timeline identity and authoritative queue", () => {
  let projection = createProjection(input({
    session: {
      ...input().session,
      runtime: runtime({ pendingMessageCount: 1 }),
    },
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "message_start",
    message: assistantMessage([{ type: "text", text: "streaming answer" }]),
  }));
  projection = reduceProjectionEvent(projection, event({
    type: "queue_update",
    steering: ["queued steer"],
    followUp: [],
  }));
  const timelineBefore = projection.timeline;
  const liveBefore = projection.liveAssistant;

  const refreshed = refreshProjectionFacts(projection, input({
    presentation: presentation({
      status: {
        ...presentation().status,
        activity: "running",
        consumption: { scope: "task", durationMs: 3_000, cost: 0.42 },
      },
    }),
    session: {
      ...input().session,
      runtime: runtime({
        isStreaming: true,
        isIdle: false,
        pendingMessageCount: 1,
      }),
    },
  }));

  assert.equal(refreshed.timeline, timelineBefore);
  assert.deepEqual(refreshed.liveAssistant, liveBefore);
  assert.deepEqual(refreshed.queue, {
    state: "authoritative",
    steering: ["queued steer"],
    followUp: [],
    pendingMessageCount: 1,
  });
  assert.equal(refreshed.status.isStreaming, true);
  assert.equal(refreshed.status.isIdle, false);
  assert.equal(refreshed.status.consumption?.cost, 0.42);
  assert.equal(refreshed.status.activity, "running");
});
