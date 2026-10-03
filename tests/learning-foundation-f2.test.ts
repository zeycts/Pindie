import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPindieHost } from "../src/host.ts";
import { FileLearningBudgetLedger } from "../src/learning-budget-store.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { createLearningSessionRunner, resolveLearningModel, DEFAULT_LEARNING_THINKING_LEVEL, type LearningModelPolicy } from "../src/learning-session-runner.ts";
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
test("F2 exhausted daily budget after claim releases an unreserved lease without execution", async () => fixture(async (root) => {
  const policy = { ...DEFAULT_LEARNING_BUDGET_POLICY, dailyTokenCeiling: 4, perJobTokenCap: 4,
    dailyTimeMsCeiling: 100, perJobTimeMsCap: 100 };
  let executions = 0;
  const { ledger, budget, supervisor } = harness(root, handler(async (job) => {
    executions++;
    return { receiptRef: ref(job) };
  }), { policy });
  await budget.reserve(10_000, policy);
  const job = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  await supervisor.kick();
  const pending = (await ledger.read())[0]!;
  assert.equal(pending.key, job.key);
  assert.equal(pending.state, "pending");
  assert.equal(pending.stopReason, "budget");
  assert.equal(pending.reservedTokens, 0);
  assert.equal(pending.reservedTimeMs, 0);
  assert.equal(pending.attempt, 1);
  assert.equal(executions, 0);
  assert.equal((await budget.read()).reservations.length, 1);
  await supervisor.dispose();
}));
test("F2 reservation attachment requires the current lease token and happens only once", async () => fixture(async (root) => {
  const ledger = new FileLearningJobLedger({ globalBaseDir: root });
  const pending = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
  const claimed = await ledger.claim(pending.key, "owner", 10_000, 1_000, 0, 0);
  assert.ok(claimed?.leaseToken);
  await assert.rejects(ledger.attachReservation(pending.key, "wrong", 4, 100), /Stale/);
  const attached = await ledger.attachReservation(pending.key, claimed!.leaseToken!, 4, 100);
  assert.equal(attached.reservedTokens, 4);
  assert.equal(attached.reservedTimeMs, 100);
  await assert.rejects(ledger.attachReservation(pending.key, claimed!.leaseToken!, 4, 100), /already attached/);
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
  assert.equal((await new FileLearningBudgetLedger({ globalBaseDir: root }).read()).reservations.length, 1);
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
  const policy = { ...DEFAULT_LEARNING_BUDGET_POLICY, perJobTimeMsCap: 250, retryBaseMs: 20,
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
  assert.equal((await ledger.read())[0]?.state, "cancelled");
  assert.equal((await ledger.read())[0]?.stopReason, "retry-exhausted");
  assert.equal((await ledger.read())[0]?.attempt, 2);
  assert.equal((await new FileLearningBudgetLedger({ globalBaseDir: root }).read()).reservations.length, 2);
  await supervisor.kick();
  assert.equal(count, 2);
  assert.equal((await new FileLearningBudgetLedger({ globalBaseDir: root }).read()).reservations.length, 2);
  await supervisor.dispose();
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
    resolveCommitted: async (job) => ref(job) }, { policy: { ...DEFAULT_LEARNING_BUDGET_POLICY, maxAttempts: 1 } });
  const job = await recovered.ledger.enqueue("project-discovery", scope, `sha256:${"d".repeat(64)}`, 1, 9_900);
  await recovered.ledger.claim(job.key, "crashed", 9_900, 100, 4, 100);
  await recovered.supervisor.kick();
  const completed = (await recovered.ledger.read()).find((j) => j.key === job.key);
  assert.deepEqual(completed?.terminalReceiptRef, ref(job));
  assert.equal(completed?.reservedTokens, 0);
  assert.equal(completed?.reservedTimeMs, 0);
  assert.deepEqual((await recovered.budget.read()).reservations, []);
  await recovered.supervisor.dispose();
}));
test("F2 Host kicks only after the replacement Session is bound, without another Human Run", async () => fixture(async (root) => {
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  let calls = 0;
  let entering!: () => void;
  const started = new Promise<void>((resolve) => { entering = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let executed!: () => void;
  const execution = new Promise<void>((resolve) => { executed = resolve; });
  const ledger = new FileLearningJobLedger({ globalBaseDir: join(root, "global") });
  const jobHandler = handler(async (job) => { executed(); return { receiptRef: ref(job) }; });
  const host = await createPindieHost({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd),
    storageRoots: { globalBaseDir: join(root, "global"), projectsBaseDir: join(root, "projects") },
    env: { PINDIE_BROWSER_ENABLED: "false", PINDIE_AUTONOMOUS_LEARNING_ENABLED: "true" }, learningHandlers: [jobHandler],
    dependencies: {
      createInteractiveMode: () => ({ run: async () => {} }),
      createAgentSessionServices: async (options) => {
        if (++calls === 2) { entering(); await gate; }
        return createAgentSessionServices(options);
      },
    },
  });
  try {
    // Let initial startup settle, then enqueue without a kick; replacement
    // must provide the next safe-idle opportunity itself.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await ledger.enqueue("project-discovery", scope, fingerprint, 1, Date.now());
    const old = host.runtime.activeSession;
    const replacement = host.runtime.replaceWithFreshSession();
    await started;
    assert.equal((await ledger.read())[0]?.state, "pending");
    release();
    await replacement;
    assert.notEqual(host.runtime.activeSession, old);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([execution, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("No post-bind learning kick.")), 3000);
      })]);
    } finally { clearTimeout(deadline); }
    // The handler may have signalled before completing the terminal write.
    for (let i = 0; i < 50 && (await ledger.read())[0]?.state !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await ledger.read())[0]?.state, "completed");
  } finally { release(); await host.dispose(); }
}));
test("F2 real Pi factory isolates SessionManager, transcript, resources and tools", async () => {
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(model);
  const humanManager = SessionManager.inMemory();
  humanManager.appendMessage({ role: "user", content: "secret human transcript", timestamp: Date.now() });
  let inspected = false;
  const policy: LearningModelPolicy = { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: DEFAULT_LEARNING_THINKING_LEVEL };
  const runner = createLearningSessionRunner({ cwd: process.cwd(), model: model!, policy, createSession: createAgentSession,
    onCreated(session) {
      inspected = true;
      assert.notEqual(session.sessionManager, humanManager);
      assert.notEqual(session.sessionId, humanManager.getSessionId());
      assert.deepEqual(session.getActiveToolNames(), []);
      assert.equal(session.model.provider, policy.provider);
      assert.equal(session.model.id, policy.modelId);
      assert.equal(session.thinkingLevel, "low");
      assert.deepEqual(session.resourceLoader.getSkills().skills, []);
      assert.deepEqual(session.resourceLoader.getExtensions().extensions, []);
      assert.ok(!JSON.stringify(session.messages).includes("secret human transcript"));
      throw new Error("inspection complete before any model request");
    } });
  await assert.rejects(runner.run("frozen packet", new AbortController().signal), /inspection complete/);
  assert.equal(inspected, true);
  assert.equal(humanManager.getEntries().length, 1);
  assert.deepEqual(runner.modelIdentity, policy);
});
test("F2 learning runner freezes an explicit model independent of any Human model value", async () => {
  const frozen = getModel("anthropic", "claude-sonnet-4-5");
  assert.ok(frozen);
  const policy: LearningModelPolicy = { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "off" };
  let createdWith: unknown;
  const runner = createLearningSessionRunner({ cwd: process.cwd(), model: frozen!, policy, createSession: createAgentSession,
    onCreated(session) { createdWith = session.model; throw new Error("stop before request"); } });
  await assert.rejects(runner.run("frozen packet", new AbortController().signal), /stop before request/);
  assert.equal(createdWith, frozen);
  assert.deepEqual(runner.modelIdentity, policy);
  assert.throws(() => createLearningSessionRunner({ cwd: process.cwd(), model: frozen!,
    policy: { ...policy, modelId: "claude-opus-4-5" } }), /Invalid isolated learning model policy/);
});
test("F2 learning model resolution honors explicit config and refuses an automatic fallback baseline", () => {
  const baseline = { provider: "provider-a", id: "model-a" } as never;
  const explicit = { provider: "provider-b", id: "model-b" } as never;
  const resolve = (provider: string, modelId: string) =>
    provider === "provider-b" && modelId === "model-b" ? explicit :
      provider === "provider-a" && modelId === "model-a" ? baseline : undefined;
  assert.deepEqual(resolveLearningModel({ requested: { provider: "provider-b", modelId: "model-b", thinkingLevel: "off" },
    baseline, startupFellBack: true, resolve }), { policy: { provider: "provider-b", modelId: "model-b", thinkingLevel: "off" }, model: explicit });
  assert.deepEqual(resolveLearningModel({ baseline, startupFellBack: false, resolve }),
    { policy: { provider: "provider-a", modelId: "model-a", thinkingLevel: DEFAULT_LEARNING_THINKING_LEVEL }, model: baseline });
  assert.equal(resolveLearningModel({ baseline, startupFellBack: true, resolve }), null); // fallback is not a baseline
  assert.equal(resolveLearningModel({ requested: { provider: "provider-x", modelId: "missing" }, baseline, startupFellBack: false, resolve }), null);
  assert.equal(resolveLearningModel({ baseline: undefined, startupFellBack: false, resolve }), null);
});
test("F2 absent learning runner never invokes a model and leaves the job recoverable", async () => {
  await fixture(async (root) => {
    let invoked = false;
    const h = handler(async (job, _authority, _signal, runner) => {
      if (!runner) throw new Error("No configured Pi learning model.");
      invoked = true;
      return { receiptRef: ref(job) };
    });
    const { ledger, supervisor } = harness(root, h); // no runner supplied
    const enqueued = await ledger.enqueue("project-discovery", scope, fingerprint, 1, 10_000);
    await supervisor.kick();
    const job = (await ledger.read())[0]!;
    assert.equal(invoked, false);
    assert.equal(job.key, enqueued.key);
    assert.equal(job.state, "pending");
    assert.ok(job.attempt >= 1);
    assert.equal(job.terminalReceiptRef, null);
    await supervisor.dispose();
  });
});
