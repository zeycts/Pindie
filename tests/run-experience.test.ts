import assert from "node:assert/strict";
import test from "node:test";

import { classifyToolEffect } from "../src/execution-semantics.ts";
import {
  assembleRunExperience,
  RunExperienceTracker,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
import { createPolicySnapshot } from "../src/policy.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function task(): NonNullable<PindieState["task"]> {
  return {
    goal: "Record the settled Run",
    constraints: [],
    successCriteria: [{ id: "c1", description: "The record is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: "Continue" },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function snapshot(overrides: Partial<Extract<SemanticSnapshot, { authority: "coherent" }>> = {}) {
  return {
    authority: "coherent" as const,
    taskStatus: "active" as const,
    verificationStatus: "pending" as const,
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched" as const,
    completionRelation: "not_completed" as const,
    gateRelation: "none" as const,
    ...overrides,
  };
}

function zeroExecution(): RunExperienceExecution {
  return {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
}

test("Run Experience telemetry derives bounded counters from Tool Effects", () => {
  const tracker = new RunExperienceTracker();
  const read = classifyToolEffect("read");
  const git = classifyToolEffect("pindie_git_observe");
  const edit = classifyToolEffect("edit");
  const verification = classifyToolEffect("pindie_verification_record");
  const policy = classifyToolEffect("pindie_policy_set");

  tracker.recordAuthorizedCall("read", read);
  tracker.recordToolResult("read", false);
  tracker.recordAuthorizedCall("git", git);
  tracker.recordToolResult("git", false);

  const firstPolicy = createPolicySnapshot({ approach: "architecture-first" });
  tracker.setPolicySnapshot(firstPolicy);
  tracker.recordAuthorizedCall("policy-one", policy);
  assert.equal(tracker.recordToolResult("policy-one", false), "policy");
  tracker.recordSuccessfulPolicyDeclaration();

  tracker.recordAuthorizedCall("edit", edit);
  tracker.recordToolResult("edit", true);
  tracker.recordAuthorizedCall("verify", verification);
  tracker.recordToolResult("verify", false);

  const secondPolicy = createPolicySnapshot({
    approach: "explore-first",
    modifiers: ["minimal-change"],
  });
  tracker.setPolicySnapshot(secondPolicy);
  tracker.recordAuthorizedCall("policy-two", policy);
  tracker.recordToolResult("policy-two", false);
  tracker.recordSuccessfulPolicyDeclaration();
  tracker.recordDeniedCall(edit);

  assert.deepEqual(tracker.policy, {
    finalSnapshot: secondPolicy,
    declarationCount: 2,
    firstDeclarationAfter: {
      toolCalls: 2,
      observations: 2,
      consequentialCalls: 0,
      projectMutationCalls: 0,
      verificationCalls: 0,
      toolErrors: 0,
      deniedCalls: 0,
    },
    finalDeclarationAfter: {
      toolCalls: 4,
      observations: 2,
      consequentialCalls: 2,
      projectMutationCalls: 1,
      verificationCalls: 1,
      toolErrors: 1,
      deniedCalls: 0,
    },
  });
  assert.deepEqual(tracker.execution, {
    toolCalls: 4,
    observations: 2,
    consequentialCalls: 2,
    projectMutationCalls: 1,
    verificationCalls: 1,
    toolErrors: 1,
    deniedCalls: 1,
  });
});

test("failed Policy declarations do not become final attribution", () => {
  const tracker = new RunExperienceTracker();
  const policy = classifyToolEffect("pindie_policy_set");
  const first = createPolicySnapshot({ approach: "direct-action" });
  const replacement = createPolicySnapshot({ approach: "explore-first" });

  tracker.setPolicySnapshot(first);
  tracker.recordAuthorizedCall("policy-one", policy);
  tracker.recordToolResult("policy-one", false);
  tracker.recordSuccessfulPolicyDeclaration();
  tracker.setPolicySnapshot(replacement);
  tracker.recordAuthorizedCall("policy-two", policy);
  tracker.recordToolResult("policy-two", true);
  assert.equal(tracker.recordFailedPolicyDeclaration(), first);
  assert.equal(tracker.policy.finalSnapshot?.approach.id, "direct-action");
  assert.equal(tracker.policy.declarationCount, 1);
});

test("policy calls do not count as execution and tracker state resets at the Run boundary", () => {
  const tracker = new RunExperienceTracker();
  const policy = classifyToolEffect("pindie_policy_set");
  const read = classifyToolEffect("read");
  tracker.setPolicySnapshot(createPolicySnapshot({ approach: "direct-action" }));
  tracker.recordAuthorizedCall("policy", policy);
  tracker.recordToolResult("policy", false);
  tracker.recordSuccessfulPolicyDeclaration();
  tracker.recordAuthorizedCall("read", read);
  tracker.recordToolResult("read", false);

  tracker.reset();
  assert.deepEqual(tracker.execution, zeroExecution());
  assert.deepEqual(tracker.policy, {
    finalSnapshot: null,
    declarationCount: 0,
    firstDeclarationAfter: null,
    finalDeclarationAfter: null,
  });
});

test("Run Experience assembly preserves factual task/outcome/metrics and no transcript fields", () => {
  const record = assembleRunExperience({
    task: { ...task(), humanGate: { kind: "approval", question: "Approve?" } },
    statusAtStart: "idle",
    snapshot: snapshot({
      taskRelation: "introduced_during_run",
      taskStatus: "waiting_human",
      verificationStatus: "stale",
      hasQuestions: true,
    }),
    policy: {
      finalSnapshot: null,
      declarationCount: 0,
      firstDeclarationAfter: null,
      finalDeclarationAfter: null,
    },
    execution: {
      ...zeroExecution(),
      toolCalls: 1,
      observations: 1,
    },
    durationMs: 1234,
    cost: 0.42,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(record, {
    schemaVersion: 1,
    recordedAt: "2026-01-01T00:00:00.000Z",
    task: {
      goal: "Record the settled Run",
      taskRelation: "introduced_during_run",
      statusAtStart: "idle",
    },
    policy: {
      finalSnapshot: null,
      declarationCount: 0,
      firstDeclarationAfter: null,
      finalDeclarationAfter: null,
    },
    execution: {
      toolCalls: 1,
      observations: 1,
      consequentialCalls: 0,
      projectMutationCalls: 0,
      verificationCalls: 0,
      toolErrors: 0,
      deniedCalls: 0,
    },
    outcome: {
      taskStatus: "waiting_human",
      verificationStatus: "stale",
      completionRelation: "not_completed",
      hasBlockers: false,
      hasQuestions: true,
      humanGateOpen: true,
    },
    metrics: { durationMs: 1234, cost: 0.42 },
  });
  const serialized = JSON.stringify(record);
  for (const forbidden of ["transcript", "reasoning", "reflection", "evidence", "success", "quality", "reward"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
