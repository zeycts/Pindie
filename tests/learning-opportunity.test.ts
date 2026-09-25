import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyToolEffect } from "../src/execution-semantics.ts";
import { LearningSignalHolder, createPindieLearningSignalTool } from "../src/learning-signal.ts";
import {
  assessLearningOpportunity,
  FileLearningAssessmentReceiptReader,
  type LearningAssessmentReceiptReader,
} from "../src/learning-opportunity.ts";
import type { SelfImprovementIntegration } from "../src/self-improvement-integration.ts";
import type { CrossProjectLearningIntegration } from "../src/cross-project-learning-integration.ts";
import { RunExperienceTracker } from "../src/run-experience.ts";

const signalEffect = classifyToolEffect("pindie_learning_signal");

test("learning signal is a non-mutating semantic effect and excluded from execution counters", () => {
  assert.deepEqual(signalEffect, { requiredCapability: "learning.signal", projectMutation: "none" });
  const run = new RunExperienceTracker();
  run.recordAuthorizedCall("signal", signalEffect);
  run.recordToolResult("signal", true);
  run.recordDeniedCall(signalEffect);
  assert.equal(run.execution.toolCalls, 0);
  assert.equal(run.execution.consequentialCalls, 0);
  assert.equal(run.execution.projectMutationEffectCalls, 0);
  assert.equal(run.execution.verificationCalls, 0);
  assert.equal(run.execution.toolErrors, 0);
  assert.equal(run.execution.deniedCalls, 0);
});

test("strict target semantics, one successful signal and lifecycle replacement", async () => {
  const holder = new LearningSignalHolder();
  let ordinary = true;
  let generation = 1;
  holder.begin(generation);
  const tool = createPindieLearningSignalTool({ holder, getGeneration: () => generation, isOrdinary: () => ordinary });
  const invoke = (params: object) => tool.execute("call", params as never, undefined, undefined, {} as never);
  for (const intent of ["revise-existing", "derive-local", "derive-global"]) {
    holder.begin(++generation);
    const params = intent === "revise-existing"
      ? { intent, targetStrategyId: "direct-action", reason: "A reusable choice" }
      : { intent, reason: "A reusable choice" };
    assert.notEqual((await invoke(params)).isError, true);
    assert.equal((await invoke(params)).isError, true);
    assert.deepEqual(holder.take(generation), params);
  }
  holder.begin(++generation);
  assert.equal((await invoke({ intent: "revise-existing", reason: "Reason" })).isError, true);
  assert.equal((await invoke({ intent: "derive-local", targetStrategyId: "direct-action", reason: "Reason" })).isError, true);
  assert.equal((await invoke({ intent: "derive-global", targetStrategyId: "direct-action", reason: "Reason" })).isError, true);
  ordinary = false;
  assert.equal((await invoke({ intent: "derive-local", reason: "Reason" })).isError, true);
  ordinary = true;
  assert.notEqual((await invoke({ intent: "derive-local", reason: "Reason" })).isError, true);
  holder.begin(null);
  assert.equal(holder.take(generation), null);
});

function fixture() {
  const calls: string[] = [];
  const evidence = ["a", "b", "c"];
  const portfolio = {
    fingerprint: "portfolio-A",
    resolvedEntries: [],
  };
  const si = {
    get hasConflictingLearningPath() { return false; },
    async prepareTrustedLearningPortfolio() { calls.push("trust"); return portfolio; },
    async prepareAdaptationEvidence(_root: string, target: string) {
      calls.push("adapt");
      if (target !== "direct-action") throw new Error("Not a Seed");
      return { packet: { target: { strategyId: target, baseFingerprint: "seed" }, evidence: { runs: [{ sourceRecordId: "a" }, { sourceRecordId: "b" }] } } };
    },
    async prepareDerivationEvidence() {
      calls.push("derive");
      return { portfolio, packet: { projectId: "project", sourceRecordIds: evidence, evidence: { runs: evidence.map((sourceRecordId) => ({ sourceRecordId })) } } };
    },
  } as unknown as SelfImprovementIntegration;
  const cpl = {
    async prepareGlobalDerivationEvidence() {
      calls.push("synthesis");
      return { sourceRefs: ["a", "b", "c"], evidence: { runs: ["a", "b", "c"] }, trustedStrategyComparison: [], selection: { version: 1 } };
    },
  } as unknown as CrossProjectLearningIntegration;
  return { si, cpl, calls, portfolio, evidence };
}

test("Gate uses intent-specific read-only primitive, deterministic identity, dedupe and fail-closed facts", async () => {
  const { si, cpl, calls, portfolio, evidence } = fixture();
  const settled = new Set<string>();
  const receipts: LearningAssessmentReceiptReader = { hasTerminal: async (id) => settled.has(id) };
  let current = true;
  const assess = (intent: "revise-existing" | "derive-local" | "derive-global", reason: string) =>
    assessLearningOpportunity({ signal: { intent, ...(intent === "revise-existing" ? { targetStrategyId: "direct-action" } : {}), reason },
      projectRoot: "/repo", selfImprovement: si, crossProjectLearning: cpl, receipts, isCurrent: () => current, now: () => Date.parse("2026-01-01") });
  for (const [intent, primitive] of [["revise-existing", "adapt"], ["derive-local", "derive"], ["derive-global", "synthesis"]] as const) {
    const first = await assess(intent, "first wording");
    const second = await assess(intent, "another wording");
    assert.equal(first.status, "admitted");
    assert.deepEqual(first, second);
    assert.ok(calls.includes(primitive));
    if (first.status !== "admitted") continue;
    settled.add(first.identity);
    assert.match((await assess(intent, "other reason") as { reason: string }).reason, /already settled/);
  }
  portfolio.fingerprint = "portfolio-B";
  assert.equal((await assess("derive-local", "same intuition")).status, "admitted");
  portfolio.fingerprint = "portfolio-A";
  evidence[2] = "new-record";
  assert.equal((await assess("derive-local", "same intuition")).status, "admitted");
  current = false;
  assert.equal((await assess("derive-global", "same intuition")).status, "rejected");
});

test("receipt reader accepts only bounded terminal outcomes and no admission writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pindie-learning-receipt-"));
  const reader = new FileLearningAssessmentReceiptReader(dir);
  const identity = `sha256:${"a".repeat(64)}`;
  assert.equal(await reader.hasTerminal(identity), false);
  await writeFile(join(dir, "learning-assessment-receipts-v1.json"), JSON.stringify([{ identity, outcome: "no-candidate" }]));
  assert.equal(await reader.hasTerminal(identity), true);
  assert.equal(await reader.hasTerminal(`sha256:${"b".repeat(64)}`), false);
  await writeFile(join(dir, "learning-assessment-receipts-v1.json"), JSON.stringify([{ identity, outcome: "admitted" }]));
  await assert.rejects(reader.hasTerminal(identity), /Invalid/);
});
