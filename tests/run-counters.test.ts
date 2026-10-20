import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolEffect } from "../src/execution-semantics.ts";
import { RunCounters } from "../src/run-counters.ts";

test("Core counters derive bounded execution facts from real Tool Effects and reset each Run", () => {
  const tracker = new RunCounters();
  for (const [id, name, error] of [["read", "read", false], ["git", "pindie_git_observe", false], ["edit", "edit", true], ["verify", "pindie_verification_record", false]] as const) {
    tracker.recordAuthorizedCall(id, classifyToolEffect(name));
    assert.equal(tracker.recordToolResult(id, error), "execution");
  }
  tracker.recordDeniedCall(classifyToolEffect("edit"));
  assert.deepEqual(tracker.execution, { toolCalls: 4, observations: 2, consequentialCalls: 2,
    projectMutationEffectCalls: 1, verificationCalls: 1, toolErrors: 1, deniedCalls: 1 });
  const frozen = tracker.execution;
  assert.equal(Object.isFrozen(frozen), true);
  tracker.reset();
  assert.equal(tracker.execution.toolCalls, 0);
  assert.equal(frozen.toolCalls, 4);
  tracker.recordAuthorizedCall("pending", classifyToolEffect("edit"));
  tracker.reset();
  assert.equal(tracker.recordToolResult("pending", true), null);
  assert.equal(tracker.execution.toolErrors, 0);
});

test("Core Work Memory calls stay outside ordinary execution telemetry on success, error and denial", () => {
  const tracker = new RunCounters(), before = tracker.execution;
  const memory = classifyToolEffect("pindie_memory_capture");
  for (const error of [false, true]) {
    tracker.recordAuthorizedCall("memory", memory);
    assert.equal(tracker.recordToolResult("memory", error), "memory");
    assert.deepEqual(tracker.execution, before);
  }
  tracker.recordDeniedCall(memory);
  assert.deepEqual(tracker.execution, before);
});

test("Core counters ignore all retired Policy and adaptation calls, even stale authorized-call bookkeeping", () => {
  const tracker = new RunCounters(), before = tracker.execution;
  for (const name of ["pindie_policy_set", "pindie_strategy_candidate_create", "pindie_strategy_derivation_candidate_create", "pindie_strategy_synthesis_candidate_create"]) {
    const effect = classifyToolEffect(name);
    assert.match(effect.requiredCapability, /^policy\./);
    tracker.recordAuthorizedCall(name, effect);
    tracker.recordDeniedCall(effect);
    assert.equal(tracker.recordToolResult(name, true), null);
    assert.deepEqual(tracker.execution, before);
  }
});
