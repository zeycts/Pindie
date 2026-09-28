import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { FileLearningBudgetLedger } from "../src/learning-budget-store.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { createLearningSessionRunner } from "../src/learning-session-runner.ts";
import { LearningSupervisor, type LearningJobHandler } from "../src/learning-supervisor.ts";
import { DEFAULT_LEARNING_BUDGET_POLICY, type LearningJob, type LearningArtifactRef } from "../src/learning-v1-contract.ts";

const fingerprint = `sha256:${"a".repeat(64)}`;
const scope = { kind: "project" as const, projectId: "c".repeat(64) };
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pindie-f2-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function ref(job: LearningJob): LearningArtifactRef {
  return { schemaVersion: 1, family: "discovery-receipt", scope: job.scope,
    id: "00000000-0000-4000-8000-000000000001", fingerprint };
}
function harness(root: string, handler?: LearningJobHandler, opts: { idle?: () => boolean; generation?: () => number; now?: () => number; policy?: typeof DEFAULT_LEARNING_BUDGET_POLICY } = {}) {
  const ledger = new FileLearningJobLedger({ globalBaseDir: root });
  const budget = new FileLearningBudgetLedger({ globalBaseDir: root });
  const supervisor = new LearningSupervisor({ ledger, budget, handlers: handler ? [handler] : [],
    authority: { idle: opts.idle ?? (() => true), generation: opts.generation ?? (() => 0) },
    now: opts.now ?? (() => 10_000), policy: opts.policy });
  return { ledger, budget, supervisor };
}
function handler(execute: LearningJobHandler["execute"]): LearningJobHandler {
  return { kind: "project-discovery", isCurrent: async () => true, resolveCommitted: async () => null,
    matchesOutput: async (job, receipt) => JSON.stringify(receipt) === JSON.stringify(ref(job)), execute };
}
test("F2 empty and unhandled ledgers never invoke a handler or claim", async () => fixture(async (root) => {
  const { ledger, supervisor } = harness(root);
  await supervisor.kick();
  const job = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  await supervisor.kick();
  assert.equal((await ledger.read())[0]?.state, "pending");
  assert.equal((await ledger.read())[0]?.attempt, 0);
  await supervisor.dispose();
  assert.equal(job.key, (await ledger.read())[0]?.key);
}));
test("F2 one claim, exact committed output, duplicate kick, and budget persist across restart", async () => fixture(async (root) => {
  let count = 0;
  const h = handler(async (job, current) => {
    assert.equal(await current(), true);
    count++;
    return { receiptRef: ref(job), usage: { tokens: 12, timeMs: 100 } };
  });
  const { ledger, supervisor } = harness(root, h);
  const job = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  await Promise.all([supervisor.kick(), supervisor.kick()]);
  assert.equal(count, 1);
  assert.deepEqual((await ledger.read())[0]?.terminalReceiptRef, ref(job));
  await supervisor.kick();
  assert.equal(count, 1);
  assert.equal((await new FileLearningBudgetLedger({ globalBaseDir: root }).read()).reservations.length, 1);
  await supervisor.dispose();
}));
test("F2 per-job usage above reservation fails closed, without refund", async () => fixture(async (root) => {
  const budget = new FileLearningBudgetLedger({ globalBaseDir: root });
  const reservation = await budget.reserve(10_000, DEFAULT_LEARNING_BUDGET_POLICY);
  assert.ok(reservation);
  assert.throws(() => budget.account(reservation!, { tokens: reservation!.tokens + 1, timeMs: 1 }), /exceeds/);
  assert.equal((await budget.read()).reservations.length, 1);
}));
test("F2 expiry restores same key; two process-like supervisors have a fenced winner", async () => fixture(async (root) => {
  const ledger = new FileLearningJobLedger({ globalBaseDir: root });
  const original = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  const first = await ledger.claim(original.key, "dead", 10_000, 100, 1, 1);
  assert.ok(first);
  const a = harness(root, handler(async (job) => ({ receiptRef: ref(job) })), { now: () => 10_200 });
  const b = harness(root, handler(async (job) => ({ receiptRef: ref(job) })), { now: () => 10_200 });
  await Promise.all([a.supervisor.kick(), b.supervisor.kick()]);
  assert.equal((await ledger.read())[0]?.state, "completed");
  assert.equal((await ledger.read())[0]?.key, original.key);
  await assert.rejects(ledger.complete(original.key, first!.leaseToken!, ref(original)), /Stale/);
  await a.supervisor.dispose(); await b.supervisor.dispose();
}));
test("F2 preemption is synchronous and releases with human-work; generation blocks a late uncommitted result", async () => fixture(async (root) => {
  let generation = 0;
  let idle = true;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { ledger, supervisor } = harness(root, handler(async (job, authority, signal) => {
    entered();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    assert.equal(await authority(), false);
    throw new Error("aborted");
  }), { generation: () => generation, idle: () => idle });
  await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  const work = supervisor.kick();
  await started;
  generation++; idle = false;
  supervisor.preempt("human-work");
  // No wait on learning cleanup in the Human start path.
  assert.equal(idle, false);
  await work;
  assert.equal((await ledger.read())[0]?.stopReason, "human-work");
  assert.equal((await ledger.read())[0]?.state, "pending");
  await supervisor.dispose();
}));
test("F2 daily caps survive restart and fail closed before execution", async () => fixture(async (root) => {
  const policy = { ...DEFAULT_LEARNING_BUDGET_POLICY, dailyTokenCeiling: 4, perJobTokenCap: 4,
    dailyTimeMsCeiling: 100, perJobTimeMsCap: 100 };
  let count = 0;
  const h = handler(async (job) => { count++; return { receiptRef: ref(job) }; });
  const a = harness(root, h, { policy });
  await a.ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  await a.supervisor.kick();
  await a.ledger.enqueue("project-discovery", scope, `sha256:${"b".repeat(64)}`, 1, 10_000);
  const b = harness(root, h, { policy });
  await b.supervisor.kick();
  assert.equal(count, 1);
  assert.equal((await b.ledger.read()).filter((j) => j.state === "pending").length, 1);
  await a.supervisor.dispose(); await b.supervisor.dispose();
}));
test("F2 timeout backs off with same key, stops at max attempts and disposal settles", async () => fixture(async (root) => {
  let now = 10_000;
  let count = 0;
  const policy = { ...DEFAULT_LEARNING_BUDGET_POLICY, perJobTimeMsCap: 10, retryBaseMs: 20,
    retryMaxMs: 80, maxAttempts: 2 };
  const h = handler(async (_job, _authority, signal) => {
    count++;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("timeout");
  });
  const { ledger, supervisor } = harness(root, h, { policy, now: () => now });
  const job = await ledger.enqueue("project-discovery", scope, fingerprint, 1, now);
  await supervisor.kick();
  assert.equal((await ledger.read())[0]?.eligibleAfter, 10_020);
  now = 10_020;
  await supervisor.kick();
  assert.equal((await ledger.read())[0]?.attempt, 2);
  assert.equal((await ledger.read())[0]?.key, job.key);
  now = 10_100;
  await supervisor.kick();
  assert.equal(count, 2);
  await supervisor.dispose();
  assert.equal((await ledger.read())[0]?.state, "pending");
}));
test("F2 shutdown aborts and settles an active attempt under its lease", async () => fixture(async (root) => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const { ledger, supervisor } = harness(root, handler(async (_job, _authority, signal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("disposed");
  }));
  await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  const work = supervisor.kick();
  await entered;
  await supervisor.dispose();
  await work;
  assert.equal((await ledger.read())[0]?.state, "pending");
  assert.equal((await ledger.read())[0]?.stopReason, "explicit-cancel");
}));
test("F2 stale input is terminal only with handler proof; recovered committed output never reruns", async () => fixture(async (root) => {
  const stale = harness(root, { ...handler(async () => { throw new Error("must not run"); }), isCurrent: async () => false });
  await stale.ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  await stale.supervisor.kick();
  assert.equal((await stale.ledger.read())[0]?.state, "cancelled");
  await stale.supervisor.dispose();
  const recovered = harness(root, { ...handler(async () => { throw new Error("must not rerun"); }),
    resolveCommitted: async (job) => ref(job) });
  const job = await recovered.ledger.enqueue("project-discovery", scope, `sha256:${"d".repeat(64)}`, 1, 10_000);
  await recovered.supervisor.kick();
  assert.deepEqual((await recovered.ledger.read()).find((j) => j.key === job.key)?.terminalReceiptRef, ref(job));
  await recovered.supervisor.dispose();
}));
test("F2 real Pi factory isolates SessionManager, transcript, resources and tools", async () => {
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const humanManager = SessionManager.inMemory();
  humanManager.appendMessage({ role: "user", content: "secret human transcript", timestamp: Date.now() });
  let inspected = false;
  const runner = createLearningSessionRunner({ cwd: process.cwd(), model: model!, createSession: createAgentSession,
    onCreated(session) {
      inspected = true;
      assert.notEqual(session.sessionManager, humanManager);
      assert.notEqual(session.sessionId, humanManager.getSessionId());
      assert.deepEqual(session.getActiveToolNames(), []);
      assert.deepEqual(session.resourceLoader.getSkills().skills, []);
      assert.deepEqual(session.resourceLoader.getExtensions().extensions, []);
      assert.ok(!JSON.stringify(session.messages).includes("secret human transcript"));
      throw new Error("inspection complete before any model request");
    } });
  await assert.rejects(runner.run("frozen packet", new AbortController().signal), /inspection complete/);
  assert.equal(inspected, true);
  assert.equal(humanManager.getEntries().length, 1);
});
