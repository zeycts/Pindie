import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
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
import { FileGlobalWriterLock } from "../src/store.ts";

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

test("learning signal description admits reusable project-local procedures without claiming evidence authority", () => {
  const tool = createPindieLearningSignalTool({
    holder: new LearningSignalHolder(), getGeneration: () => 1, isOrdinary: () => true,
  });
  assert.match(tool.description, /decision rule or pattern that would change how a future similar task is approached/);
  assert.match(tool.description, /project-local engineering or procedural rule qualifies as Strategy-level when it generalizes across future similar tasks/);
  assert.match(tool.description, /need not be cross-domain or broadly abstract/);
  assert.match(tool.description, /Silence is normal/);
  assert.match(tool.description, /do not wait for recurrence proof or evidence counts/);
  assert.match(tool.description, /Harness independently assesses evidence after the Run settles/);
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

test("terminal writer is bounded, atomic, idempotent, and rejects conflicting or malformed receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pindie-learning-writer-"));
  const reader = new FileLearningAssessmentReceiptReader(dir);
  const id = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
  await reader.writeTerminal(id(0), "no-candidate");
  await reader.writeTerminal(id(0), "no-candidate");
  await assert.rejects(reader.writeTerminal(id(0), "candidate-created"), /Conflicting/);
  for (let i = 1; i <= 130; i++) await reader.writeTerminal(id(i), "candidate-created");
  const entries = JSON.parse(await readFile(join(dir, "learning-assessment-receipts-v1.json"), "utf8"));
  assert.equal(entries.length, 128);
  assert.equal(await reader.hasTerminal(id(0)), false);
  assert.equal(await reader.hasTerminal(id(130)), true);
  await assert.rejects(reader.writeTerminal(id(131), "admitted" as never), /Invalid/);
  await writeFile(join(dir, "learning-assessment-receipts-v1.json"), "not json");
  await assert.rejects(reader.writeTerminal(id(131), "no-candidate"));
  assert.equal(await readFile(join(dir, "learning-assessment-receipts-v1.json"), "utf8"), "not json");
});

test("receipt writers serialize and recover a valid dead-owner global lock without stealing ambiguous ownership", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pindie-learning-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, "writer.lock");
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "dead-owner", pid: 999999, acquiredAt: 1 }));
  const lock = () => new FileGlobalWriterLock({
    baseDir: dir, lockRetryMs: 2, lockTimeoutMs: 500,
    isProcessAlive: (pid) => pid === process.pid,
  });
  const first = new FileLearningAssessmentReceiptReader(dir, lock());
  const second = new FileLearningAssessmentReceiptReader(dir, lock());
  const id = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
  await first.writeTerminal(id(1), "candidate-created");
  assert.equal(await first.hasTerminal(id(1)), true, "dead-owner lock was safely reclaimed");
  await Promise.all([first.writeTerminal(id(2), "no-candidate"), second.writeTerminal(id(3), "candidate-created")]);
  const entries = JSON.parse(await readFile(join(dir, "learning-assessment-receipts-v1.json"), "utf8"));
  assert.deepEqual(entries.sort((a: { identity: string }, b: { identity: string }) => a.identity.localeCompare(b.identity)), [
    { identity: id(1), outcome: "candidate-created" },
    { identity: id(2), outcome: "no-candidate" },
    { identity: id(3), outcome: "candidate-created" },
  ]);
  await mkdir(lockPath);
  await assert.rejects(first.writeTerminal(id(4), "no-candidate"), /writer lock|Retry/i);
  assert.equal(await first.hasTerminal(id(4)), false);
});
