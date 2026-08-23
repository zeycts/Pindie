import assert from "node:assert/strict";
import test from "node:test";

import { ReasoningController } from "../src/reasoning.ts";
import type { PindieState } from "../src/state.ts";

const active: PindieState = {
  task: {
    goal: "Task", constraints: [], successCriteria: [{ id: "c1", description: "Works" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] }, humanGate: null, completed: false,
  },
};
const passed: PindieState = {
  task: { ...active.task!, verification: { stale: false, checks: [{ name: "test", status: "passed", covers: ["c1"], evidence: "passed" }] } },
};
const failed: PindieState = {
  task: { ...active.task!, verification: { stale: false, checks: [{ name: "test", status: "failed", covers: ["c1"], evidence: "failed" }] } },
};
const result = (toolName: string, isError = false) => ({ toolName, isError });

function controller() { return new ReasoningController("medium"); }

test("AR01-AR03 reset and Agent Runs initialize Auto medium while Fixed is preserved", () => {
  const reasoning = controller();
  assert.deepEqual(reasoning.snapshot, { mode: "auto", requestedLevel: "medium", effectiveLevel: "medium" });
  reasoning.decideNext(active, [result("edit")]);
  reasoning.beforeAgentStart();
  assert.equal(reasoning.snapshot.requestedLevel, "medium");
  reasoning.setFixed("high");
  reasoning.beforeAgentStart();
  assert.equal(reasoning.snapshot.requestedLevel, "high");
});

test("AR04-AR14 Auto policy uses its specified priority and hysteresis", () => {
  const reasoning = controller();
  reasoning.decideNext(active, [result("bash", true)]);
  assert.equal(reasoning.snapshot.requestedLevel, "high");
  reasoning.decideNext(failed, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "high");
  reasoning.decideNext(passed, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "low");
  reasoning.setAuto(); reasoning.decideNext(active, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "low");
  reasoning.setAuto(); reasoning.decideNext(active, [result("write")]);
  assert.equal(reasoning.snapshot.requestedLevel, "low");
  reasoning.setAuto(); reasoning.decideNext(active, [result("bash")]);
  assert.equal(reasoning.snapshot.requestedLevel, "medium");
  reasoning.decideNext(active, [result("bash", true), result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "high");
  reasoning.decideNext(active, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "medium");
  reasoning.decideNext(passed, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "low");
});

test("AR15-AR19 Fixed ignores adaptation, Auto restores medium, and effective synchronization preserves mode", () => {
  const reasoning = controller();
  reasoning.setFixed("low");
  reasoning.decideNext(failed, [result("bash", true)]);
  assert.equal(reasoning.snapshot.requestedLevel, "low");
  reasoning.setFixed("high");
  reasoning.decideNext(active, [result("edit")]);
  assert.equal(reasoning.snapshot.requestedLevel, "high");
  reasoning.setAuto();
  assert.equal(reasoning.snapshot.requestedLevel, "medium");
  reasoning.synchronizeEffective("low");
  assert.deepEqual(reasoning.snapshot, { mode: "auto", requestedLevel: "medium", effectiveLevel: "low" });
  reasoning.setFixed("high"); reasoning.synchronizeEffective("medium");
  assert.equal(reasoning.snapshot.mode, "fixed");
});
