import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPindieHost } from "../src/host.ts";
import { getProjectId, FileStateStore } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { assembleRunExperience } from "../src/run-experience.ts";
import { FileRunExperienceStore, FileRunExperienceReader } from "../src/experience-store.ts";
import { FileRunExperienceMaintenance, MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT } from "../src/experience-lifecycle.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
import { FileDiscoveryReceiptStore } from "../src/discovery-receipts.ts";
import { FileDiscoveryPacketStore } from "../src/discovery-packets.ts";
import { FileDiscoveryHypothesisStore, hypothesisRef, mintHypothesis, MAX_OPEN_HYPOTHESES, MAX_DISCOVERY_COMMITS } from "../src/discovery-hypotheses.ts";
import { createProjectDiscoveryHandler, parseDiscoveryResult } from "../src/project-discovery-handler.ts";
import { LearningSupervisor } from "../src/learning-supervisor.ts";
import { FileLearningBudgetLedger } from "../src/learning-budget-store.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { buildProjectDiscoveryPacket, enqueueProjectDiscovery } from "../src/project-discovery.ts";
import { discoveryOpenEntry, validateDiscoveryPacket, MAX_DISCOVERY_PACKET_CHARS_V3, DEFAULT_PROJECT_DISCOVERY_POLICY, type DiscoveryPacketV3, type DiscoveryPacketV4 } from "../src/discovery-contract.ts";
import { hypothesisLeaves } from "../src/hypothesis-lineage.ts";
import { FileV1HypothesisExperienceProtectionReader } from "../src/v1-experience-protection.ts";
import { matchesLearningJobOutput, matchesLearningArtifactRef, hypothesisFingerprint, learningFingerprint, canonicalJson, type StrategyHypothesisV1, type LearningModelProvenance } from "../src/learning-v1-contract.ts";

const MODEL: LearningModelProvenance = { provider: "test", modelId: "test-learning-model", thinkingLevel: "low" };
const MODEL_B: LearningModelProvenance = { provider: "test", modelId: "other-learning-model", thinkingLevel: "off" };

const ROOT = "/repo/discovery"; const id = getProjectId(ROOT);
async function setup(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "discovery-d1-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const projects = join(dir, "projects"), global = join(dir, "global");
  const runtime = new PindieRuntime(new FileStateStore({ baseDir: projects }));
  await runtime.load(ROOT);
  await runtime.dispatch({ type: "start_task", goal: "goal", constraints: [], successCriteria: ["done"] });
  const store = new FileRunExperienceStore({ baseDir: projects });
  const reader = new FileRunExperienceReader({ baseDir: projects });
  const portfolio = new FileProjectTrustedStrategyPortfolioReader({ projectsBaseDir: projects, globalBaseDir: global });
  const receipts = new FileDiscoveryReceiptStore({ projectsBaseDir: projects });
  const packets = new FileDiscoveryPacketStore(projects);
  const jobs = new FileLearningJobLedger({ globalBaseDir: global });
  const hypotheses = new FileDiscoveryHypothesisStore({ projectsBaseDir: projects });
  const deps = { reader, portfolio, receipts, packets, hypotheses, jobs };
  const add = async (index: number, schema: 4 | 5 = 5, episode = randomUUID(), successful = false, durationMs: number | null = 1) => {
    const record = assembleRunExperience({ task: runtime.state.task!, runStart: { taskStatus: "active", taskGoal: "goal" },
      snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false,
        hasQuestions: false, completionReady: false, taskRelation: "preexisting_untouched", completionRelation: "not_completed", gateRelation: "none" },
      policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
      execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: index % 2, deniedCalls: 0 },
      durationMs, cost: 0, recordedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ...(schema === 5 ? { workEpisodeId: episode } : {}),
    });
    // Outcome diversity is factual and validated: active/pending vs active/failed verification.
    const experience = successful ? { ...record,
      task: { ...record.task, taskRelation: "preexisting_changed" as const },
      outcome: { ...record.outcome, taskStatus: "done" as const, verificationStatus: "passed" as const,
        completionRelation: "completed_during_run" as const },
    } : index % 2 ? { ...record, outcome: { ...record.outcome, verificationStatus: "failed" as const } } : record;
    await store.save(ROOT, experience);
    return experience;
  };
  return { dir, projects, global, deps, add, store };
}
test("D1 legacy v4-only evidence never triggers, v5 deterministic packet/job survives restart", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 137; i++) await f.add(i, 4);
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  for (let i = 0; i < 6; i++) await f.add(i);
  const packet = await buildProjectDiscoveryPacket(id, f.deps);
  assert.ok(packet && validateDiscoveryPacket(packet));
  const key = await enqueueProjectDiscovery(id, f.deps);
  assert.ok(key);
  assert.equal((await f.deps.jobs.read()).length, 1);
  const restarted = { ...f.deps, reader: new FileRunExperienceReader({ baseDir: f.projects }),
    receipts: new FileDiscoveryReceiptStore({ projectsBaseDir: f.projects }), packets: new FileDiscoveryPacketStore(f.projects),
    jobs: new FileLearningJobLedger({ globalBaseDir: f.global }) };
  assert.deepEqual(await buildProjectDiscoveryPacket(id, restarted), packet);
  assert.equal(await enqueueProjectDiscovery(id, restarted), key);
  assert.deepEqual(await restarted.packets.read(id, packet.fingerprint), packet);
  assert.equal((await restarted.jobs.read()).length, 1);
  await f.add(7);
  assert.notEqual(await enqueueProjectDiscovery(id, restarted), key);
  assert.equal((await restarted.jobs.read()).length, 2);
});
test("D1 preserves finite nonnegative Experience durations including fractional runtime milliseconds", async (t) => {
  const f = await setup(t);
  const durations = [0.125, 1234.56789, 0, null, 1, 1_000_000_000.5];
  for (const [index, duration] of durations.entries()) await f.add(index, 5, randomUUID(), false, duration);
  const packet = await buildProjectDiscoveryPacket(id, f.deps);
  assert.ok(packet && validateDiscoveryPacket(packet));
  assert.deepEqual(packet.sources.map((s) => s.metrics.durationMs), durations);
  assert.ok(await enqueueProjectDiscovery(id, f.deps));
  assert.deepEqual(await f.deps.packets.read(id, packet.fingerprint), packet);
  for (const durationMs of [-1, NaN, Infinity, -Infinity, "1", undefined]) {
    const sources = packet.sources.map((s, i) => i === 0 ? { ...s, metrics: { ...s.metrics, durationMs } } : s);
    const { fingerprint: _, ...content } = { ...packet, sources };
    const fingerprint = typeof durationMs === "number" && Number.isFinite(durationMs) || typeof durationMs === "string"
      ? learningFingerprint(content) : packet.fingerprint;
    assert.equal(validateDiscoveryPacket({ ...content, fingerprint }), false);
  }
});
test("D2 new-only trigger reuses assessed A context alongside B and never counts it as new", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const first = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(first.sources.filter((s) => s.role === "new").length, 6);
  await f.deps.receipts.publish(first, "none", [], MODEL);
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null);
  for (let i = 6; i < 11; i++) await f.add(i);
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null); // five new + six old is NOT eligible
  await f.add(11);
  const second = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(second.eligibleCounts.new, 6);
  assert.equal(second.sources.filter((s) => s.role === "new").length, 6);
  assert.equal(second.sources.filter((s) => s.role === "context").length, 6);
  assert.ok(second.sources.some((s) => s.role === "context" && first.sources.some((a) => a.ref.fingerprint === s.ref.fingerprint)));
  assert.equal((await f.deps.receipts.publish(second, "none", [], MODEL)).sources.length, 12); // full packet binding
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null);
  for (let i = 12; i < 18; i++) await f.add(i);
  const third = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(third.eligibleCounts.new, 6);
  assert.ok(third.sources.some((s) => s.role === "context" && first.sources.some((a) => a.ref.fingerprint === s.ref.fingerprint)));
  assert.equal(third.sources.filter((s) => s.role === "new").length, 6);
});
test("D1 uniform done/passed v5 outcomes satisfy the conservative default", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i, 5, randomUUID(), true);
  const packet = await buildProjectDiscoveryPacket(id, f.deps);
  assert.ok(packet && validateDiscoveryPacket(packet));
  assert.equal(packet.eligibleCounts.episodes, 6);
  assert.equal(packet.eligibleCounts.outcomes, 1);
  assert.equal(packet.sources.length, 6);
  assert.ok(packet.sources.every((s) => s.outcome.taskStatus === "done" && s.outcome.verificationStatus === "passed"));
  assert.ok(await enqueueProjectDiscovery(id, f.deps));
  assert.equal(await buildProjectDiscoveryPacket(id, { ...f.deps, policy: { ...DEFAULT_PROJECT_DISCOVERY_POLICY, minOutcomes: 2 } }), null);
});
test("D1 bounded receipt assesses only selected fingerprints; leftover older evidence survives restart", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 50; i++) await f.add(i);
  const first = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(first.sources.length, 24);
  assert.equal(first.eligibleCounts.new, 50);
  const firstKey = await enqueueProjectDiscovery(id, f.deps);
  assert.ok(firstKey);
  await f.deps.receipts.publish(first, "none", [], MODEL);
  // Even a new file with the same exact payload as an assessed source is not new.
  const assessed = (await f.deps.reader.readProjectId(id)).records.find((r) => r.recordId === first.sources[0]!.ref.recordId)!;
  await f.store.save(ROOT, assessed.experience);
  const second = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(second.eligibleCounts.new, 26);
  assert.equal(second.sources.length, 24);
  assert.ok(second.sources.every((s) => !first.sources.some((prior) => prior.ref.fingerprint === s.ref.fingerprint)));
  const restarted = { ...f.deps, reader: new FileRunExperienceReader({ baseDir: f.projects }),
    receipts: new FileDiscoveryReceiptStore({ projectsBaseDir: f.projects }), packets: new FileDiscoveryPacketStore(f.projects),
    jobs: new FileLearningJobLedger({ globalBaseDir: f.global }) };
  assert.deepEqual(await buildProjectDiscoveryPacket(id, restarted), second);
  const secondKey = await enqueueProjectDiscovery(id, restarted);
  assert.ok(secondKey && secondKey !== firstKey);
  assert.equal((await restarted.jobs.read()).length, 2);
  await restarted.receipts.publish(second, "none", [], MODEL);
  assert.equal(await buildProjectDiscoveryPacket(id, restarted), null); // two unassessed sources, below threshold
});
test("D1 duplicates, terminal receipt and cancellation without receipt", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 5; i++) await f.add(i);
  const duplicate = await f.add(5, 5, "00000000-0000-4000-8000-000000000001");
  await f.store.save(ROOT, duplicate);
  const packet = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(packet.eligibleCounts.new, 6);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const claimed = (await f.deps.jobs.claim(key, "test", Date.now(), 1000, 0, 0))!;
  await f.deps.jobs.cancel(key, claimed.leaseToken, "retry-exhausted");
  assert.equal((await buildProjectDiscoveryPacket(id, f.deps))?.fingerprint, packet.fingerprint);
  assert.equal(await enqueueProjectDiscovery(id, f.deps), key);
  assert.equal((await f.deps.jobs.read()).find((job) => job.key === key)?.state, "cancelled");
  await f.add(6);
  const changed = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(changed.eligibleCounts.new, 7);
  assert.ok(changed.sources.some((source) => source.ref.fingerprint === packet.sources[0]!.ref.fingerprint));
  assert.notEqual(await enqueueProjectDiscovery(id, f.deps), key);
  assert.equal((await f.deps.jobs.read()).length, 2);
  const receipt = await f.deps.receipts.publish(packet, "none", [], MODEL);
  assert.deepEqual(await f.deps.receipts.publish(packet, "none", [], MODEL), receipt);
  await assert.rejects(f.deps.receipts.publish(packet, "covered", [], MODEL));
  const ref = { schemaVersion: 1 as const, family: "discovery-receipt" as const, scope: receipt.scope, id: receipt.id, fingerprint: receipt.fingerprint };
  assert.deepEqual(await f.deps.receipts.resolve(ref, key, packet.fingerprint), receipt);
  assert.equal(matchesLearningJobOutput({ ...claimed, state: "completed", leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminalReceiptRef: ref }, receipt), true);
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null); // one remaining new source
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
});
test("D1 Host startup enqueue does not start a model or change the Human Session surface", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const cwd = join(f.dir, "project"), agentDir = join(f.dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const target = join(f.projects, getProjectId(cwd), "experience");
  await mkdir(target, { recursive: true });
  for (const name of await readdir(join(f.projects, id, "experience")))
    await copyFile(join(f.projects, id, "experience", name), join(target, name));
  const host = await createPindieHost({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd),
    storageRoots: { projectsBaseDir: f.projects, globalBaseDir: f.global },
    learningHandlers: [], // D1 enqueue-only compatibility seam; D2 registers a production handler by default.
    env: { PINDIE_BROWSER_ENABLED: "false" },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  try {
    const before = host.runtime.activeSession.getActiveToolNames();
    for (let attempt = 0; attempt < 20 && (await f.deps.jobs.read()).length === 0; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(host.runtime.activeSession.getActiveToolNames(), before);
    assert.deepEqual(host.runtime.activeSession.messages, []);
    assert.equal((await f.deps.jobs.read()).length, 1);
    assert.equal((await f.deps.jobs.read())[0]?.state, "pending");
  } finally { await host.dispose(); }
});
test("D2 Host freezes the explicit learning model identity, independent of the Human Session model", async (t) => {
  const f = await setup(t);
  const cwd = join(f.dir, "project"), agentDir = join(f.dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const host = await createPindieHost({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd),
    storageRoots: { projectsBaseDir: f.projects, globalBaseDir: f.global },
    learningHandlers: [], // no model invocation; identity resolution is independent of handlers.
    learningModel: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "off" },
    env: { PINDIE_BROWSER_ENABLED: "false" },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  try {
    assert.deepEqual(host.learningModelIdentity, { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "off" });
  } finally { await host.dispose(); }
});
test("D2 Host leaves learning unavailable when the requested learning model cannot be resolved", async (t) => {
  const f = await setup(t);
  const cwd = join(f.dir, "project"), agentDir = join(f.dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const host = await createPindieHost({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd),
    storageRoots: { projectsBaseDir: f.projects, globalBaseDir: f.global },
    learningHandlers: [],
    learningModel: { provider: "pindie-nonexistent", modelId: "no-such-model" },
    env: { PINDIE_BROWSER_ENABLED: "false" },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  try {
    assert.equal(host.learningModelIdentity, null);
  } finally { await host.dispose(); }
});
test("D1 bounds and corrupted evidence/portfolio/receipt fail closed without blocking save",  async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 75; i++) await f.add(i);
  const packet = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(packet.sources.length, DEFAULT_PROJECT_DISCOVERY_POLICY.maxCorpus);
  assert.deepEqual(await buildProjectDiscoveryPacket(id, f.deps), packet);
  const path = join(f.projects, id, "experience");
  await writeFile(join(path, `${randomUUID()}.json`), "{broken");
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  await f.add(76); // normal Experience unaffected
  assert.equal((await f.deps.reader.readProjectId(id)).loadedRecords, 76);
  const corruptPortfolio = { ...f.deps, portfolio: { readProjectId: async () => ({ ...await f.deps.portfolio.readProjectId(id), fingerprint: "sha256:" + "0".repeat(64) }) } };
  assert.equal(await enqueueProjectDiscovery(id, corruptPortfolio), null);
  const receiptsPath = join(f.projects, id, "learning-v1", "discovery-receipts.json");
  await mkdir(join(f.projects, id, "learning-v1"), { recursive: true });
  await writeFile(receiptsPath, "{broken");
  assert.equal(await enqueueProjectDiscovery(id, f.deps), null);
  assert.equal((await f.deps.jobs.read()).length, 0);
});

const proposal = (packet: NonNullable<Awaited<ReturnType<typeof buildProjectDiscoveryPacket>>>, overrides: Record<string, unknown> = {}) => ({
  logicalId: "discovery-focus", kind: "approach", intent: "new", revisionTarget: null,
  summary: "Focus on the immediate evidence", useWhen: ["Evidence is available"], avoidWhen: [], principles: ["Check the immediate evidence before changing code"],
  expectedEffect: "Fewer failed verification checks on similar Tasks", failureSignals: ["More failed checks"],
  trialHints: ["Compare verified results"], sourceHandles: [packet.sources[0]!.ref.recordId], ...overrides,
});
async function prepared(t: import("node:test").TestContext) {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const job = (await f.deps.jobs.read()).find((j) => j.key === key)!;
  const packet = (await f.deps.packets.read(id, job.inputFingerprint))!;
  assert.equal(packet.schemaVersion, 4);
  if (packet.schemaVersion !== 4) assert.fail("Expected current v4 packet");
  const handler = createProjectDiscoveryHandler(f.deps);
  return { ...f, key, job, packet, handler };
}
test("D2 frozen packet isolated runner none -> exact receipt -> completed job, no cognition", async (t) => {
  const f = await prepared(t);
  let calls = 0;
  const supervisor = new LearningSupervisor({ ledger: f.deps.jobs,
    budget: new FileLearningBudgetLedger({ globalBaseDir: f.global }), handlers: [f.handler],
    authority: { idle: () => true, generation: () => 0 },
    runner: { modelIdentity: MODEL, run: async (prompt) => { calls++; assert.ok(prompt.includes(f.packet.fingerprint)); return { text: '{"outcome":"none"}' }; } },
  });
  await supervisor.kick();
  assert.equal(calls, 1);
  assert.equal((await f.deps.jobs.read())[0]?.state, "completed");
  assert.equal((await f.deps.receipts.read(id))[0]?.outcome, "none");
  assert.equal((await f.deps.hypotheses.list(id)).length, 0);
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null);
  await supervisor.dispose();
});
test("D2 proposal is minted, immutable, reconciled and recovered from committed batch and receipt", async (t) => {
  const f = await prepared(t);
  let calls = 0;
  const runner = { modelIdentity: MODEL, run: async () => { calls++; return { text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }; } };
  const output = await f.handler.execute(f.job, async () => true, new AbortController().signal, runner);
  const [hypothesis] = await f.deps.hypotheses.list(id);
  assert.ok(hypothesis);
  assert.equal(hypothesis.schemaVersion, 2);
  assert.equal(f.packet.schemaVersion, 4);
  assert.equal(f.packet.selectionVersion, 4);
  assert.equal(f.packet.policy.selectionVersion, 4);
  assert.equal(hypothesis.discoveryPacketFingerprint, f.packet.fingerprint);
  assert.ok(hypothesis.id !== f.job.key);
  assert.equal((await f.deps.receipts.read(id))[0]?.outcome, "published");
  assert.equal(await f.handler.matchesOutput(f.job, output.receiptRef), true);
  assert.deepEqual(await f.handler.resolveCommitted(f.job), output.receiptRef);
  assert.equal(calls, 1);
  await assert.rejects(f.deps.hypotheses.publish(f.packet, "published", [hypothesisRef(hypothesis)], [{ ...hypothesis, id: randomUUID() }], MODEL));
});
test("D2 crash after hypothesis commit recovers without a second model invocation", async (t) => {
  const f = await prepared(t);
  // Narrow failure injection preserves the real store's read/find/resolve methods.
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  let calls = 0;
  const runner = { modelIdentity: MODEL, run: async () => { calls++; return { text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }; } };
  await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal, runner));
  f.deps.receipts.publish = original;
  const recovered = await createProjectDiscoveryHandler(f.deps).resolveCommitted(f.job);
  assert.ok(recovered);
  assert.equal(calls, 1);
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  assert.equal(await f.handler.matchesOutput(f.job, recovered), true);
  const supervisor = new LearningSupervisor({ ledger: f.deps.jobs,
    budget: new FileLearningBudgetLedger({ globalBaseDir: f.global }), handlers: [f.handler],
    authority: { idle: () => true, generation: () => 0 },
    runner: { modelIdentity: MODEL, run: async () => { throw new Error("A second model call is forbidden."); } },
  });
  await supervisor.kick();
  assert.equal((await f.deps.jobs.read()).find((j) => j.key === f.job.key)?.state, "completed");
  await supervisor.dispose();
});
test("D2 invalid model contract and authority fields cannot create a semantic receipt", async (t) => {
  const f = await prepared(t);
  const invalid = ["not JSON", JSON.stringify({ outcome: "none", id: randomUUID() }),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { artifactId: randomUUID() })] }),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { sourceHandles: [randomUUID()] })] }),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { failureSignals: [] })] }),
    ...[undefined, [], [" "], ["x".repeat(257)], Array(9).fill("p"), ["bypass permission"], ["disable safety"], ["override verification"], ["grant capability"]]
      .map((principles) => JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { principles })] })),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { capability: "task.complete" })] }),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet), proposal(f.packet), proposal(f.packet)] })];
  for (const raw of invalid) await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: raw }) }));
  assert.deepEqual(await f.deps.receipts.read(id), []);
  assert.deepEqual(await f.deps.hypotheses.list(id), []);
  assert.equal(await f.handler.isCurrent(f.job), true);
});
test("D2 duplicate open hypothesis is covered and revision needs the exact frozen parent", async (t) => {
  const f = await prepared(t);
  const first = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  assert.equal(await f.handler.matchesOutput(f.job, first.receiptRef), true);
  // Another packet with the same exact sources, but changed open comparison, retains semantic dedupe identity.
  const existing = (await f.deps.hypotheses.list(id))[0]!;
  const openEntries = [discoveryOpenEntry(existing)];
  const content = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(openEntries), entries: openEntries } };
  const { fingerprint: _old, ...unsigned } = content;
  const next = { ...unsigned, fingerprint: learningFingerprint(unsigned) };
  await f.deps.packets.publish(next);
  const nextJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, next.fingerprint, next.policy.selectionVersion, Date.now());
  assert.equal(await f.handler.isCurrent(nextJob), true);
  // The original job is recoverable, but a frozen packet without a commit is stale on this open catalog.
  const stalePacket = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 7 } };
  const { fingerprint: _stale, ...staleContent } = stalePacket;
  const stale = { ...staleContent, fingerprint: learningFingerprint(staleContent) };
  await f.deps.packets.publish(stale);
  const staleJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, stale.fingerprint, stale.policy.selectionVersion, Date.now());
  assert.equal(await f.handler.isCurrent(staleJob), false);
  const covered = await f.handler.execute(nextJob, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(next)] }) }) });
  assert.equal((await f.deps.receipts.resolve(covered.receiptRef, nextJob.key, next.fingerprint))?.outcome, "covered");
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  const wrongParent = proposal(next, { intent: "revise", revisionTarget: { kind: "open-hypothesis", ref: { ...hypothesisRef(existing), fingerprint: learningFingerprint("wrong") } } });
  assert.throws(() => parseDiscoveryResult(JSON.stringify({ outcome: "proposals", proposals: [wrongParent] }), next));
  const wrongLogical = proposal(next, { intent: "revise", revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(existing) }, logicalId: "unrelated" });
  const { fingerprint: _f, ...otherUnsigned } = next;
  const other = { ...otherUnsigned, fingerprint: learningFingerprint(otherUnsigned) };
  assert.throws(() => parseDiscoveryResult(JSON.stringify({ outcome: "proposals", proposals: [wrongLogical] }), other));
  // Semantic parent mismatch is rejected at reconciliation; no fresh cognition follows.
  const changed = { ...otherUnsigned, eligibleCounts: { ...next.eligibleCounts, new: next.eligibleCounts.new + 1 } };
  const third = { ...changed, fingerprint: learningFingerprint(changed) };
  await f.deps.packets.publish(third);
  const thirdJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, third.fingerprint, third.policy.selectionVersion, Date.now());
  await assert.rejects(f.handler.execute(thirdJob, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [wrongLogical] }) }) }));
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  const revised = proposal(third, { intent: "revise", revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(existing) },
    expectedEffect: "Fewer tool errors on similar Tasks" });
  const output = await f.handler.execute(thirdJob, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [revised] }) }) });
  assert.equal((await f.deps.receipts.resolve(output.receiptRef, thirdJob.key, third.fingerprint))?.outcome, "published");
  const children = await f.deps.hypotheses.list(id);
  assert.equal(children.length, 2);
  assert.deepEqual(children.find((h) => h.lineage === "revise")?.parent, hypothesisRef(existing));
  assert.equal(children.find((h) => h.lineage === "revise")?.baseRevisionFingerprint, null);
});
test("D2 covered batch recovers exact receipt after interrupted publication without model rerun", async (t) => {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const h = (await f.deps.hypotheses.list(id))[0]!;
  const entries = [discoveryOpenEntry(h)];
  const { fingerprint: _prior, ...content } = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
  const packet = { ...content, fingerprint: learningFingerprint(content) };
  await f.deps.packets.publish(packet);
  const job = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, packet.policy.selectionVersion, Date.now());
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  try {
    await assert.rejects(f.handler.execute(job, async () => true, new AbortController().signal,
      { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(packet)] }) }) }));
  } finally { f.deps.receipts.publish = original; }
  const commit = await f.deps.hypotheses.committed(id, packet.fingerprint);
  assert.equal(commit?.outcome, "covered");
  assert.deepEqual(commit?.refs, [hypothesisRef(h)]);
  assert.deepEqual(commit?.newHypotheses, []);
  const recovered = await createProjectDiscoveryHandler(f.deps).resolveCommitted(job);
  assert.ok(recovered);
  assert.equal((await f.deps.receipts.resolve(recovered, job.key, packet.fingerprint))?.outcome, "covered");
  assert.equal(await f.handler.matchesOutput(job, recovered), true);
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
});
test("D2 trusted revision and chained open revision retain the exact trusted base", async (t) => {
  const f = await prepared(t);
  const trusted = f.packet.portfolio.revisions.find((r) => r.strategyId === "direct-action")!;
  assert.ok(trusted);
  const target = { kind: "trusted-revision", logicalId: trusted.strategyId, strategyKind: trusted.kind,
    revisionFingerprint: trusted.revisionFingerprint };
  const result = proposal(f.packet, { logicalId: trusted.strategyId, kind: trusted.kind, intent: "revise", revisionTarget: target });
  assert.equal(await f.handler.isCurrent(f.job), true);
  const first = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [result] }) }) });
  assert.equal((await f.deps.receipts.resolve(first.receiptRef, f.job.key, f.packet.fingerprint))?.outcome, "published");
  const base = (await f.deps.hypotheses.list(id))[0]!;
  assert.equal(base.parent, null);
  assert.equal(base.baseRevisionFingerprint, trusted.revisionFingerprint);
  assert.equal(base.logicalId, trusted.strategyId);
  const entries = [discoveryOpenEntry(base)];
  const unsigned = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
  const { fingerprint: _prior, ...content } = unsigned;
  const packet = { ...content, fingerprint: learningFingerprint(content) };
  await f.deps.packets.publish(packet);
  const job = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, packet.policy.selectionVersion, Date.now());
  assert.equal(await f.handler.isCurrent(job), true);
  const second = proposal(packet, { logicalId: trusted.strategyId, kind: trusted.kind, intent: "revise",
    revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(base) }, expectedEffect: "Fewer failed checks after revisions" });
  await f.handler.execute(job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [second] }) }) });
  const child = (await f.deps.hypotheses.list(id)).find((h) => h.parent !== null)!;
  assert.deepEqual(child.parent, hypothesisRef(base));
  assert.equal(child.baseRevisionFingerprint, trusted.revisionFingerprint);
  assert.equal((await f.deps.hypotheses.list(id)).length, 2);
});
test("D2 trusted targets must resolve exactly; unrelated new collisions are none-equivalent", async (t) => {
  const f = await prepared(t);
  const trusted = f.packet.portfolio.revisions.find((r) => r.strategyId === "direct-action")!;
  const valid = { kind: "trusted-revision", logicalId: trusted.strategyId, strategyKind: trusted.kind,
    revisionFingerprint: trusted.revisionFingerprint };
  for (const bad of [{ ...valid, revisionFingerprint: learningFingerprint("invented") },
    { ...valid, logicalId: "missing" }, { ...valid, strategyKind: trusted.kind === "approach" ? "modifier" : "approach" }]) {
    const invalid = proposal(f.packet, { logicalId: trusted.strategyId, kind: trusted.kind, intent: "revise", revisionTarget: bad });
    await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal,
      { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [invalid] }) }) }));
  }
  const mismatch = proposal(f.packet, { logicalId: "unrelated", kind: trusted.kind, intent: "revise", revisionTarget: valid });
  assert.throws(() => parseDiscoveryResult(JSON.stringify({ outcome: "proposals", proposals: [mismatch] }), f.packet));
  assert.deepEqual(await f.deps.receipts.read(id), []);
  const collision = proposal(f.packet, { logicalId: trusted.strategyId, kind: trusted.kind });
  const outcome = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [collision] }) }) });
  assert.equal((await f.deps.receipts.resolve(outcome.receiptRef, f.job.key, f.packet.fingerprint))?.outcome, "none");
  assert.deepEqual(await f.deps.hypotheses.list(id), []);
});
test("D2 bounded publication rejects conflicting fingerprints and capacity without erasing open cognition", async (t) => {
  const f = await prepared(t);
  const output = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const [h] = await f.deps.hypotheses.list(id);
  assert.ok(h);
  const commit = (await f.deps.hypotheses.committed(id, f.packet.fingerprint))!;
  assert.deepEqual(await f.deps.hypotheses.publish(f.packet, commit.outcome, commit.refs, commit.newHypotheses, commit.modelIdentity), commit);
  await assert.rejects(f.deps.hypotheses.publish(f.packet, "covered", [hypothesisRef(h)], [], MODEL));
  assert.equal(await f.handler.matchesOutput(f.job, output.receiptRef), true);
  const content = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 7 } };
  const { fingerprint: _old, ...unsigned } = content;
  const next = { ...unsigned, fingerprint: learningFingerprint(unsigned) };
  await assert.rejects(f.deps.hypotheses.publish(next, "published", [hypothesisRef(h)], [h], MODEL));
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
});
test("D2 commit history exceeds 64 covered packets without exhausting 64-hypothesis cognition", async (t) => {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const h = (await f.deps.hypotheses.list(id))[0]!;
  const entries = [discoveryOpenEntry(h)];
  for (let i = 0; i < 65; i++) {
    const { fingerprint: _prior, ...content } = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 10 + i },
      openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
    const packet = { ...content, fingerprint: learningFingerprint(content) };
    await f.deps.hypotheses.publish(packet, "covered", [hypothesisRef(h)], [], MODEL);
  }
  assert.deepEqual(await new FileDiscoveryHypothesisStore({ projectsBaseDir: f.projects }).list(id), [h]);
  assert.equal((await readdir(join(f.projects, id, "learning-v1", "hypotheses"))).filter((n) => n.endsWith(".json")).length, 66);
});
test("D2 duplicate Experience exact ref is independent of reader enumeration order", async (t) => {
  const f = await setup(t);
  const first = await f.add(0);
  for (let i = 1; i < 6; i++) await f.add(i);
  await f.store.save(ROOT, first); // same fingerprint in a distinct file
  const normal = (await buildProjectDiscoveryPacket(id, f.deps))!;
  const reverse = { ...f.deps, reader: { readProjectId: async (projectId: string) => {
    const read = await f.deps.reader.readProjectId(projectId);
    return { ...read, records: [...read.records].reverse() };
  } } };
  assert.deepEqual(await buildProjectDiscoveryPacket(id, reverse), normal);
});
test("D2 canonical open ordering survives reversed commit-file insertion and restart", async (t) => {
  const f = await prepared(t);
  const first = mintHypothesis(f.packet, { logicalId: "first-focus", kind: "approach", lineage: "new", parent: null,
    baseRevisionFingerprint: null, summary: "First observation", useWhen: ["Observable work"], avoidWhen: [], principles: ["Check observations"],
    expectedEffect: "Fewer failed checks", failureSignals: ["More failed checks"], trialHints: [], sources: [f.packet.sources[0]!.ref] });
  const { fingerprint: _prior, ...content } = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 7 } };
  const next = { ...content, fingerprint: learningFingerprint(content) };
  const second = mintHypothesis(next, { logicalId: "second-focus", kind: "modifier", lineage: "new", parent: null,
    baseRevisionFingerprint: null, summary: "Second observation", useWhen: ["Observable work"], avoidWhen: [], principles: ["Check observations"],
    expectedEffect: "Fewer tool errors", failureSignals: ["More tool errors"], trialHints: [], sources: [next.sources[1]!.ref] });
  const a = f.deps.hypotheses;
  const otherProjects = join(f.dir, "other-projects");
  const b = new FileDiscoveryHypothesisStore({ projectsBaseDir: otherProjects });
  await a.publish(f.packet, "published", [hypothesisRef(first)], [first], MODEL);
  await a.publish(next, "published", [hypothesisRef(second)], [second], MODEL);
  await b.publish(next, "published", [hypothesisRef(second)], [second], MODEL);
  await b.publish(f.packet, "published", [hypothesisRef(first)], [first], MODEL);
  const sorted = [first, second].sort((x, y) => x.fingerprint.localeCompare(y.fingerprint));
  assert.deepEqual(await a.list(id), sorted);
  assert.deepEqual(await b.list(id), sorted);
  assert.deepEqual(await new FileDiscoveryHypothesisStore({ projectsBaseDir: otherProjects }).list(id), sorted);
  const packetA = (await buildProjectDiscoveryPacket(id, f.deps))!;
  const packetB = (await buildProjectDiscoveryPacket(id, { ...f.deps, hypotheses: b }))!;
  assert.equal(packetA.fingerprint, packetB.fingerprint);
});
test("D2 oversized packet fails validation; builder drops context before new and rejects unfit comparison", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const first = (await buildProjectDiscoveryPacket(id, f.deps))!;
  const { fingerprint: _old, ...oversizedContent } = { ...first, portfolio: { ...first.portfolio,
    revisions: first.portfolio.revisions.map((r) => ({ ...r, summary: "x".repeat(512),
      useWhen: Array(8).fill("u".repeat(256)), avoidWhen: Array(8).fill("a".repeat(256)), principles: Array(8).fill("p".repeat(256)) })) } };
  const oversized = { ...oversizedContent, fingerprint: learningFingerprint(oversizedContent) };
  assert.ok(canonicalJson(oversizedContent).length > MAX_DISCOVERY_PACKET_CHARS_V3);
  assert.equal(validateDiscoveryPacket(oversized), false);
  const original = await f.deps.portfolio.readProjectId(id);
  const largePortfolio = { ...original, resolvedEntries: original.resolvedEntries.map((entry) => ({ ...entry,
    semantics: { ...entry.semantics, summary: "s".repeat(512), useWhen: Array(8).fill("u".repeat(256)),
      avoidWhen: Array(8).fill("a".repeat(256)), principles: Array(8).fill("p".repeat(256)) } })) };
  const large = { ...f.deps, portfolio: { readProjectId: async () => largePortfolio } };
  assert.equal(await enqueueProjectDiscovery(id, large), null);
  assert.deepEqual(await f.deps.jobs.read(), []); // no guaranteed-overflow model job
  await f.deps.receipts.publish(first, "none", [], MODEL);
  for (let i = 6; i < 12; i++) await f.add(i);
  const second = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.equal(second.sources.filter((s) => s.role === "context").length, 6);
  let fitting: typeof largePortfolio | null = null;
  for (let width = 1; width <= 8; width++) {
    const portfolio = { ...original, resolvedEntries: original.resolvedEntries.map((entry) => ({ ...entry,
      semantics: { ...entry.semantics, summary: "s".repeat(512), useWhen: Array(width).fill("u".repeat(256)),
        avoidWhen: Array(width).fill("a".repeat(256)), principles: Array(width).fill("p".repeat(256)) } })) };
    const revisions = portfolio.resolvedEntries.map((e) => ({ strategyId: e.manifest.strategyId, kind: e.manifest.kind,
      revisionIdentity: e.manifest.revisionIdentity, revisionFingerprint: e.manifest.revisionFingerprint,
      summary: e.semantics.summary, useWhen: e.semantics.useWhen, avoidWhen: e.semantics.avoidWhen, principles: e.semantics.principles }));
    const candidate = { ...second, portfolio: { fingerprint: original.fingerprint, revisions } };
    const { fingerprint: _f, ...full } = candidate;
    if (canonicalJson(full).length > MAX_DISCOVERY_PACKET_CHARS_V3 &&
      canonicalJson({ ...full, sources: full.sources.filter((s) => s.role === "new") }).length < MAX_DISCOVERY_PACKET_CHARS_V3) {
      fitting = portfolio; break;
    }
  }
  assert.ok(fitting);
  const trimmed = (await buildProjectDiscoveryPacket(id, { ...f.deps, portfolio: { readProjectId: async () => fitting! } }))!;
  assert.equal(trimmed.sources.filter((s) => s.role === "new").length, 6);
  assert.ok(trimmed.sources.filter((s) => s.role === "context").length < 6);
  const { fingerprint: _digest, ...bounded } = trimmed;
  assert.ok(canonicalJson(bounded).length <= MAX_DISCOVERY_PACKET_CHARS_V3);
  assert.equal(validateDiscoveryPacket(trimmed), true);
});
test("D2 comparison drift makes old job stale; preemption leaves nothing committed", async (t) => {
  const f = await prepared(t);
  assert.equal(await f.handler.isCurrent(f.job), true);
  const changed = { ...f.deps, portfolio: { readProjectId: async () => ({ ...await f.deps.portfolio.readProjectId(id), fingerprint: learningFingerprint("changed") }) } };
  assert.equal(await createProjectDiscoveryHandler(changed).isCurrent(f.job), false);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const run = f.handler.execute(f.job, async () => !controller.signal.aborted, controller.signal,
    { modelIdentity: MODEL, run: async () => { await waiting; return { text: '{"outcome":"none"}' }; } });
  controller.abort(); release();
  await assert.rejects(run);
  assert.deepEqual(await f.deps.receipts.read(id), []);
});
test("D2 unresolved hypothesis source Experience survives pruning and restart", async (t) => {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const [hypothesis] = await f.deps.hypotheses.list(id);
  assert.ok(hypothesis && hypothesis.sources.length > 0);
  const protectedName = hypothesis.sources[0]!.recordId;
  const experienceDir = join(f.projects, id, "experience");
  assert.ok((await readdir(experienceDir)).includes(protectedName));
  for (let i = 6; i < MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT + 15; i++) await f.add(i);
  const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: f.global });
  assert.ok(await maintenance.prune(ROOT) > 0);
  assert.ok((await readdir(experienceDir)).includes(protectedName));
  // Restart rebuilds the same protection from the immutable store alone.
  const restarted = new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: join(f.dir, "global") });
  assert.equal(await restarted.prune(ROOT), 0);
  assert.ok((await readdir(experienceDir)).includes(protectedName));
});
test("D2 corrupt hypothesis store fails closed for pruning without undoing a committed Experience save", async (t) => {
  const f = await prepared(t);
  for (let i = 6; i < MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT + 5; i++) await f.add(i);
  const hypothesesDir = join(f.projects, id, "learning-v1", "hypotheses");
  await mkdir(hypothesesDir, { recursive: true });
  await writeFile(join(hypothesesDir, "not-a-canonical-commit.json"), "{}");
  const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: f.global });
  await assert.rejects(maintenance.prune(ROOT));
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const store = new FileRunExperienceStore({ baseDir: f.projects, onSaved: async (root) => { await maintenance.prune(root); } });
    const existing = (await f.deps.reader.readProjectId(id)).records[0]!.experience;
    const before = (await readdir(join(f.projects, id, "experience"))).length;
    await store.save(ROOT, existing); // a committed save; only its best-effort cleanup fails
    assert.equal(warnings.length, 1);
    assert.equal((await readdir(join(f.projects, id, "experience"))).length, before + 1);
  } finally { console.warn = warn; }
});
test("D2 model proposal needs a new source; context-only is discarded", async (t) => {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  for (let i = 6; i < 12; i++) await f.add(i);
  // Rebuild from the live corpus: six new Experiences plus six assessed context records.
  const packet = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.ok(packet.sources.some((s) => s.role === "new") && packet.sources.some((s) => s.role === "context"));
  const { fingerprint: _alt, ...altUnsigned } = { ...packet, eligibleCounts: { ...packet.eligibleCounts, new: packet.eligibleCounts.new + 1 } };
  const packetAlt = { ...altUnsigned, fingerprint: learningFingerprint(altUnsigned) };
  await f.deps.packets.publish(packet);
  await f.deps.packets.publish(packetAlt);
  const contextHandle = packet.sources.find((s) => s.role === "context")!.ref.recordId;
  const newHandle = packet.sources.find((s) => s.role === "new")!.ref.recordId;
  const contextJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packetAlt.fingerprint, packetAlt.policy.selectionVersion, Date.now());
  const contextOnly = proposal(packetAlt, { logicalId: "context-only-focus", sourceHandles: [contextHandle], expectedEffect: "Context-only effect" });
  await assert.rejects(f.handler.execute(contextJob, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [contextOnly] }) }) }), /new source/);
  assert.equal(await f.deps.receipts.find(id, contextJob.key, packetAlt.fingerprint), null);
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  const newJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, packet.policy.selectionVersion, Date.now() + 1);
  const withNew = proposal(packet, { logicalId: "new-plus-context", sourceHandles: [newHandle, contextHandle], expectedEffect: "New plus context effect" });
  const published = await f.handler.execute(newJob, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [withNew] }) }) });
  assert.equal((await f.deps.receipts.resolve(published.receiptRef, newJob.key, packet.fingerprint))?.outcome, "published");
  const refreshed = await f.deps.hypotheses.list(id);
  assert.equal(refreshed.length, 2);
  const added = refreshed.find((x) => x.logicalId === "new-plus-context")!;
  assert.equal(added.sources.length, 2);
  assert.ok(added.sources.some((s) => s.recordId === newHandle) && added.sources.some((s) => s.recordId === contextHandle));
});
async function coveredPacket(t: import("node:test").TestContext) {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const [h] = await f.deps.hypotheses.list(id);
  for (let i = 6; i < 12; i++) await f.add(i);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const job = (await f.deps.jobs.read()).find((j) => j.key === key)!;
  const packet = (await f.deps.packets.read(id, job.inputFingerprint))!;
  if (packet.schemaVersion !== 4) assert.fail("Expected v4");
  assert.ok(packet.sources.some((s) => s.role === "new"));
  return { ...f, h, job, packet, coveredJson: JSON.stringify({ outcome: "covered", hypotheses: [packet.openHypotheses.entries[0]!.ref] }) };
}
test("D2 semantic covered references exact open hypothesis with new sources, no artifact", async (t) => {
  const f = await coveredPacket(t);
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  const output = await f.handler.execute(f.job, async () => true, new AbortController().signal, { modelIdentity: MODEL, run: async () => ({ text: f.coveredJson }) });
  const receipt = await f.deps.receipts.resolve(output.receiptRef, f.job.key, f.packet.fingerprint);
  assert.equal(receipt?.outcome, "covered");
  assert.deepEqual(receipt?.hypotheses, [hypothesisRef(f.h)]);
  assert.ok((receipt?.sources ?? []).some((s) => s.role === "new"));
  assert.equal((await f.deps.hypotheses.list(id)).length, 1); // no new artifact
  assert.equal(await f.handler.matchesOutput(f.job, output.receiptRef), true);
  assert.deepEqual(await f.handler.resolveCommitted(f.job), output.receiptRef);
  // Invented or non-frozen coverage refs fail the strict parser.
  assert.throws(() => parseDiscoveryResult(JSON.stringify({ outcome: "covered", hypotheses: [{ ...hypothesisRef(f.h), fingerprint: learningFingerprint("invented") }] }), f.packet));
  // Its new sources are assessed, so the same corpus yields no further discovery.
  assert.equal(await buildProjectDiscoveryPacket(id, f.deps), null);
});
test("D2 none and covered are distinct outcomes; covered commit recovers without rerun", async (t) => {
  const f = await coveredPacket(t);
  const { fingerprint: _alt, ...altUnsigned } = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: f.packet.eligibleCounts.new + 1 } };
  const packetAlt = { ...altUnsigned, fingerprint: learningFingerprint(altUnsigned) };
  await f.deps.packets.publish(packetAlt);
  const noneJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packetAlt.fingerprint, packetAlt.policy.selectionVersion, Date.now());
  const noneOut = await f.handler.execute(noneJob, async () => true, new AbortController().signal, { modelIdentity: MODEL, run: async () => ({ text: '{"outcome":"none"}' }) });
  const noneReceipt = await f.deps.receipts.resolve(noneOut.receiptRef, noneJob.key, packetAlt.fingerprint);
  assert.equal(noneReceipt?.outcome, "none");
  assert.deepEqual(noneReceipt?.hypotheses, []);
  // Covered commit then crash before the receipt.
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  try {
    await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal, { modelIdentity: MODEL, run: async () => ({ text: f.coveredJson }) }));
  } finally { f.deps.receipts.publish = original; }
  const commit = await f.deps.hypotheses.committed(id, f.packet.fingerprint);
  assert.equal(commit?.outcome, "covered");
  assert.deepEqual(commit?.refs, [hypothesisRef(f.h)]);
  assert.deepEqual(commit?.newHypotheses, []);
  const recovered = await createProjectDiscoveryHandler(f.deps).resolveCommitted(f.job);
  assert.ok(recovered);
  assert.equal((await f.deps.receipts.resolve(recovered, f.job.key, f.packet.fingerprint))?.outcome, "covered");
  assert.equal(await f.handler.matchesOutput(f.job, recovered), true);
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
});
test("D2 open catalog capacity is separate from immutable commit history", async (t) => {
  const f = await prepared(t);
  let packet = f.packet;
  const source = packet.sources[0]!.ref;
  for (let i = 0; i < MAX_OPEN_HYPOTHESES / 2; i++) {
    const a = mintHypothesis(packet, { logicalId: `open-${i}-a`, kind: "approach", lineage: "new", parent: null, baseRevisionFingerprint: null,
      summary: `Open ${i} a`, useWhen: ["u"], avoidWhen: [], principles: ["p"], expectedEffect: "e", failureSignals: ["f"], trialHints: [], sources: [source] });
    const b = mintHypothesis(packet, { logicalId: `open-${i}-b`, kind: "modifier", lineage: "new", parent: null, baseRevisionFingerprint: null,
      summary: `Open ${i} b`, useWhen: ["u"], avoidWhen: [], principles: ["p"], expectedEffect: "e", failureSignals: ["f"], trialHints: [], sources: [source] });
    await f.deps.hypotheses.publish(packet, "published", [hypothesisRef(a), hypothesisRef(b)], [a, b], MODEL);
    const { fingerprint: _p, ...next } = { ...packet, eligibleCounts: { ...packet.eligibleCounts, new: packet.eligibleCounts.new + 1 } };
    packet = { ...next, fingerprint: learningFingerprint(next) };
  }
  assert.equal((await f.deps.hypotheses.list(id)).length, MAX_OPEN_HYPOTHESES);
  const last = (await f.deps.hypotheses.list(id)).at(-1)!;
  const historyBefore = (await readdir(join(f.projects, id, "learning-v1", "hypotheses"))).filter((n) => n.endsWith(".json")).length;
  assert.equal(historyBefore, MAX_OPEN_HYPOTHESES / 2); // one immutable commit file per two-hypothesis batch
  // At open capacity, a covered receipt may still append history without new cognition.
  const entry = discoveryOpenEntry(last);
  const { fingerprint: _cov, ...cov } = { ...packet, openHypotheses: { fingerprint: learningFingerprint([entry]), entries: [entry] } };
  await f.deps.hypotheses.publish({ ...cov, fingerprint: learningFingerprint(cov) }, "covered", [hypothesisRef(last)], [], MODEL);
  assert.equal((await readdir(join(f.projects, id, "learning-v1", "hypotheses"))).filter((n) => n.endsWith(".json")).length, historyBefore + 1);
  const overflow = mintHypothesis(packet, { logicalId: "open-overflow", kind: "approach", lineage: "new", parent: null, baseRevisionFingerprint: null,
    summary: "Overflow", useWhen: ["u"], avoidWhen: [], principles: ["p"], expectedEffect: "e", failureSignals: ["f"], trialHints: [], sources: [source] });
  await assert.rejects(f.deps.hypotheses.publish(packet, "published", [hypothesisRef(overflow)], [overflow], MODEL), /Open hypothesis capacity/);
  assert.equal((await f.deps.hypotheses.list(id)).length, MAX_OPEN_HYPOTHESES);
  // Replacing a parent at capacity consumes no extra leaf slot, and deletes no history.
  const { fingerprint: _rev, ...revContent } = { ...packet, openHypotheses: { fingerprint: learningFingerprint([entry]), entries: [entry] } };
  const revisionPacket = { ...revContent, fingerprint: learningFingerprint(revContent) };
  const child = mintHypothesis(revisionPacket, { logicalId: last.logicalId, kind: last.kind, lineage: "revise", parent: hypothesisRef(last),
    baseRevisionFingerprint: last.baseRevisionFingerprint, summary: "Revised at capacity", useWhen: ["u"], avoidWhen: [], principles: ["p"],
    expectedEffect: "e", failureSignals: ["f"], trialHints: [], sources: [source] });
  // Use a distinct packet key from the previously committed covered batch.
  const { fingerprint: _cp, ...cp } = { ...revisionPacket, eligibleCounts: { ...revisionPacket.eligibleCounts, new: 100 } };
  const revisedPacket = { ...cp, fingerprint: learningFingerprint(cp) };
  const revisedChild = { ...child, discoveryPacketFingerprint: revisedPacket.fingerprint };
  await f.deps.hypotheses.publish(revisedPacket, "published", [hypothesisRef(revisedChild)], [revisedChild], MODEL);
  const all = await f.deps.hypotheses.list(id);
  assert.equal(all.length, MAX_OPEN_HYPOTHESES + 1);
  assert.equal(hypothesisLeaves(all, id).length, MAX_OPEN_HYPOTHESES);
  assert.ok(all.some((h) => matchesLearningArtifactRef(hypothesisRef(last), h)));
});
test("D2 terminal receipts persist exact model provenance and reject conflicting provenance", async (t) => {
  const f = await prepared(t);
  const noneOut = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: '{"outcome":"none"}' }) });
  assert.deepEqual((await f.deps.receipts.resolve(noneOut.receiptRef, f.job.key, f.packet.fingerprint))?.modelIdentity, MODEL);
  // Conflicting model provenance for the same committed packet fails closed.
  await assert.rejects(f.deps.receipts.publish(f.packet, "none", [], MODEL_B));
});
test("D2 published commit recovers original model provenance without rerunning the model", async (t) => {
  const f = await prepared(t);
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  try {
    await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal,
      { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) }));
  } finally { f.deps.receipts.publish = original; }
  const commit = await f.deps.hypotheses.committed(id, f.packet.fingerprint);
  assert.equal(commit?.outcome, "published");
  assert.deepEqual(commit?.modelIdentity, MODEL);
  // Recovery republishes the receipt from the committed provenance, regardless of any current model.
  const recovered = await createProjectDiscoveryHandler(f.deps).resolveCommitted(f.job);
  assert.deepEqual((await f.deps.receipts.resolve(recovered!, f.job.key, f.packet.fingerprint))?.modelIdentity, MODEL);
  assert.equal(await f.handler.matchesOutput(f.job, recovered!), true);
});
test("D2 covered commit recovers original model provenance across restart", async (t) => {
  const f = await coveredPacket(t);
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  try {
    await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal,
      { modelIdentity: MODEL, run: async () => ({ text: f.coveredJson }) }));
  } finally { f.deps.receipts.publish = original; }
  assert.deepEqual((await f.deps.hypotheses.committed(id, f.packet.fingerprint))?.modelIdentity, MODEL);
  const recovered = await createProjectDiscoveryHandler(f.deps).resolveCommitted(f.job);
  const receipt = await f.deps.receipts.resolve(recovered!, f.job.key, f.packet.fingerprint);
  assert.equal(receipt?.outcome, "covered");
  assert.deepEqual(receipt?.modelIdentity, MODEL);
});

/** Seed exact pre-upgrade bytes, not a production migration/publication path. */
async function historicalV3(f: Awaited<ReturnType<typeof prepared>>, commit: boolean) {
  const { fingerprint: _fp, ...content } = f.packet;
  const unsigned = { ...content, schemaVersion: 3 as const, selectionVersion: 3 as const,
    policy: { ...content.policy, selectionVersion: 3 as const } };
  const packet: DiscoveryPacketV3 = { ...unsigned, fingerprint: learningFingerprint(unsigned) };
  assert.ok(validateDiscoveryPacket(packet));
  await f.deps.packets.publish(packet);
  const job = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, 3, Date.now());
  const v2 = mintHypothesis(f.packet, { logicalId: "discovery-focus", kind: "approach", lineage: "new", parent: null,
    baseRevisionFingerprint: null, summary: "Historical direction", useWhen: ["Evidence exists"], avoidWhen: [], principles: ["Not copied into v1"],
    expectedEffect: "Fewer regressions", failureSignals: ["More regressions"], trialHints: ["Compare Tasks"], sources: [packet.sources[0]!.ref] });
  const { principles: _p, id: _id, fingerprint: _hfp, ...old } = v2;
  const semantic = { ...old, schemaVersion: 1 as const, discoveryPacketFingerprint: packet.fingerprint };
  const h: StrategyHypothesisV1 = { ...semantic, id: v2.id, fingerprint: hypothesisFingerprint(semantic) };
  if (commit) {
    const batch = { schemaVersion: 2, packetFingerprint: packet.fingerprint, outcome: "published", refs: [hypothesisRef(h)], newHypotheses: [h], modelIdentity: MODEL };
    const dir = join(f.projects, id, "learning-v1", "hypotheses");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${packet.fingerprint.slice(7)}.json`), JSON.stringify({ ...batch, fingerprint: learningFingerprint(batch) }) + "\n");
  }
  return { packet, job, h };
}
for (const hasReceipt of [false, true]) test(`R1 committed v3 restart recovers without model call (receipt=${hasReceipt})`, async (t) => {
  const f = await prepared(t), old = await historicalV3(f, true);
  await f.deps.jobs.cancel(f.key, null, "explicit-cancel"); // isolate the historical pending job
  if (hasReceipt) await f.deps.receipts.publish(old.packet, "published", [hypothesisRef(old.h)], MODEL);
  const packetPath = join(f.projects, id, "learning-v1", "packets", `${old.packet.fingerprint.slice(7)}.json`);
  const before = await readFile(packetPath, "utf8");
  const restarted = createProjectDiscoveryHandler({ ...f.deps, hypotheses: new FileDiscoveryHypothesisStore({ projectsBaseDir: f.projects }) });
  let calls = 0;
  const supervisor = new LearningSupervisor({ ledger: f.deps.jobs, budget: new FileLearningBudgetLedger({ globalBaseDir: f.global }),
    handlers: [restarted], authority: { idle: () => true, generation: () => 0 },
    runner: { modelIdentity: MODEL_B, run: async () => { calls++; throw new Error("No second call"); } } });
  await supervisor.kick(); await supervisor.dispose();
  assert.equal(calls, 0);
  assert.equal((await f.deps.jobs.read()).find((j) => j.key === old.job.key)?.state, "completed");
  const ref = await restarted.resolveCommitted(old.job);
  assert.ok(ref && await restarted.matchesOutput(old.job, ref));
  assert.deepEqual(await f.deps.packets.read(id, old.packet.fingerprint), old.packet);
  assert.equal(await readFile(packetPath, "utf8"), before);
  assert.deepEqual(await f.deps.hypotheses.list(id), [old.h]);
});
test("R1 uncommitted v3 job is stale, cannot invoke model or mint new v1", async (t) => {
  const f = await prepared(t), old = await historicalV3(f, false);
  await f.deps.jobs.cancel(f.key, null, "explicit-cancel");
  assert.equal(await f.handler.isCurrent(old.job), false);
  let calls = 0;
  const runner = { modelIdentity: MODEL, run: async () => { calls++; return { text: '{"outcome":"none"}' }; } };
  await assert.rejects(f.handler.execute(old.job, async () => true, new AbortController().signal, runner));
  await assert.rejects(f.deps.hypotheses.publish(old.packet, "published", [hypothesisRef(old.h)], [old.h], MODEL));
  const supervisor = new LearningSupervisor({ ledger: f.deps.jobs, budget: new FileLearningBudgetLedger({ globalBaseDir: f.global }),
    handlers: [f.handler], authority: { idle: () => true, generation: () => 0 }, runner });
  await supervisor.kick(); await supervisor.dispose();
  const terminal = (await f.deps.jobs.read()).find((j) => j.key === old.job.key)!;
  assert.equal(terminal.state, "cancelled"); assert.equal(terminal.stopReason, "stale-input");
  assert.equal(calls, 0); assert.deepEqual(await f.deps.hypotheses.list(id), []);
  assert.equal((await buildProjectDiscoveryPacket(id, f.deps))?.schemaVersion, 4);
});
test("R1 v1 -> v2 only through normal Discovery with new evidence; history provenance stays protected", async (t) => {
  const f = await prepared(t), old = await historicalV3(f, true);
  const recovered = await f.handler.resolveCommitted(old.job); assert.ok(recovered);
  for (let i = 6; i < 12; i++) await f.add(i);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const job = (await f.deps.jobs.read()).find((j) => j.key === key)!;
  const packet = (await f.deps.packets.read(id, job.inputFingerprint))!;
  if (packet.schemaVersion !== 4) assert.fail("Expected v4");
  assert.equal(packet.openHypotheses.entries.length, 1);
  assert.deepEqual(packet.openHypotheses.entries[0], discoveryOpenEntry(old.h));
  const covered = JSON.stringify({ outcome: "covered", hypotheses: [hypothesisRef(old.h)] });
  assert.throws(() => parseDiscoveryResult(covered, packet), /coverage reference/);
  await assert.rejects(f.deps.hypotheses.publish(packet, "covered", [hypothesisRef(old.h)], [], MODEL));
  const newSource = packet.sources.find((s) => s.role === "new")!.ref;
  const rules = ["Verify the narrow evidence before choosing a change"];
  const revise = proposal(packet, { intent: "revise", revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(old.h) },
    principles: rules, sourceHandles: [newSource.recordId] });
  const contextOnly = { ...revise, sourceHandles: [old.h.sources[0]!.recordId] };
  await assert.rejects(f.handler.execute(job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [contextOnly] }) }) }), /new source/);
  await f.handler.execute(job, async () => true, new AbortController().signal,
    { modelIdentity: MODEL, run: async (prompt) => {
      assert.ok(prompt.includes("never target v1 with covered"));
      return { text: JSON.stringify({ outcome: "proposals", proposals: [revise] }) };
    } });
  const history = await f.deps.hypotheses.list(id);
  const child = history.find((h) => h.schemaVersion === 2)!;
  assert.ok(child && child.schemaVersion === 2);
  assert.deepEqual(child.principles, rules); assert.deepEqual(child.parent, hypothesisRef(old.h));
  assert.equal(child.logicalId, old.h.logicalId); assert.equal(child.kind, old.h.kind);
  assert.equal(child.baseRevisionFingerprint, old.h.baseRevisionFingerprint);
  assert.deepEqual(child.sources, [newSource]); assert.notEqual(child.fingerprint, old.h.fingerprint);
  assert.ok(matchesLearningArtifactRef(hypothesisRef(old.h), history.find((h) => h.id === old.h.id)));
  assert.deepEqual(hypothesisLeaves(history, id), [child]);
  for (let i = 12; i < 18; i++) await f.add(i);
  const next = (await buildProjectDiscoveryPacket(id, f.deps))!;
  assert.deepEqual(next.openHypotheses.entries, [discoveryOpenEntry(child)]);
  const nextKey = (await enqueueProjectDiscovery(id, f.deps))!;
  const nextJob = (await f.deps.jobs.read()).find((j) => j.key === nextKey)!;
  assert.equal(await f.handler.isCurrent(nextJob), true); // shared builder/freshness projection
  const { fingerprint: _pfp, ...changedContent } = { ...next, openHypotheses: { ...next.openHypotheses,
    entries: [{ ...discoveryOpenEntry(child), hypothesisSchemaVersion: 2 as const, principles: ["Changed frozen principle"] }] } };
  assert.equal(validateDiscoveryPacket({ ...changedContent, fingerprint: learningFingerprint(changedContent) }), false); // comparison digest covers rules
  const protectedRefs = await new FileV1HypothesisExperienceProtectionReader({ projectsBaseDir: f.projects }).requiredSourceRefs(id);
  assert.ok(protectedRefs.some((r) => r.recordId === old.h.sources[0]!.recordId));
  assert.ok(protectedRefs.some((r) => r.recordId === newSource.recordId));
  for (let i = 18; i < MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT + 25; i++) await f.add(i);
  const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: f.global });
  await maintenance.prune(ROOT);
  const names = await readdir(join(f.projects, id, "experience"));
  assert.ok(names.includes(old.h.sources[0]!.recordId)); assert.ok(names.includes(newSource.recordId));
});
test("R1 immutable history remains independently commit-bounded", async (t) => {
  const f = await setup(t), dir = join(f.projects, id, "learning-v1", "hypotheses");
  await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: MAX_DISCOVERY_COMMITS + 1 }, (_, i) =>
    writeFile(join(dir, `${i.toString(16).padStart(64, "0")}.json`), "{}")));
  await assert.rejects(f.deps.hypotheses.list(id), /commit history capacity/);
});
test("R1 v3 and v4 comparison entries keep distinct exact versioned shapes", async (t) => {
  const f = await prepared(t), old = await historicalV3(f, false);
  const { hypothesisSchemaVersion: _v, principles: _p, ...v3Entry } = discoveryOpenEntry(old.h);
  const sealPacket = (packet: DiscoveryPacketV3 | DiscoveryPacketV4, entries: unknown[]) => {
    const { fingerprint: _fp, ...content } = { ...packet, openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
    return { ...content, fingerprint: learningFingerprint(content) };
  };
  assert.ok(validateDiscoveryPacket(sealPacket(old.packet, [v3Entry])));
  assert.equal(validateDiscoveryPacket(sealPacket(old.packet, [discoveryOpenEntry(old.h)])), false);
  assert.ok(validateDiscoveryPacket(sealPacket(f.packet, [discoveryOpenEntry(old.h)])));
  for (const entry of [v3Entry, { ...discoveryOpenEntry(old.h), principles: ["Not v1 rules"] },
    { ...discoveryOpenEntry(old.h), hypothesisSchemaVersion: 2, principles: null },
    { ...discoveryOpenEntry(old.h), hypothesisSchemaVersion: 2, principles: [] },
    { ...discoveryOpenEntry(old.h), hypothesisSchemaVersion: 2, principles: ["x".repeat(257)] },
    { ...discoveryOpenEntry(old.h), extra: true }]) assert.equal(validateDiscoveryPacket(sealPacket(f.packet, [entry])), false);
  const first = sealPacket(f.packet, [{ ...discoveryOpenEntry(old.h), hypothesisSchemaVersion: 2, principles: ["First rule"] }]);
  const second = sealPacket(f.packet, [{ ...discoveryOpenEntry(old.h), hypothesisSchemaVersion: 2, principles: ["Other rule"] }]);
  assert.notEqual(first.openHypotheses.fingerprint, second.openHypotheses.fingerprint);
});
test("R1 malformed exact lineage refuses pruning even when individual historical artifacts are valid", async (t) => {
  const f = await prepared(t), old = await historicalV3(f, true);
  const { id: _id, fingerprint: _fp, ...content } = old.h;
  const semantic = { ...content, lineage: "revise" as const, parent: { ...hypothesisRef(old.h), id: randomUUID() } };
  const orphan = { ...semantic, id: old.h.id, fingerprint: hypothesisFingerprint(semantic) };
  const batch = { schemaVersion: 2, packetFingerprint: old.packet.fingerprint, outcome: "published", refs: [hypothesisRef(orphan)],
    newHypotheses: [orphan], modelIdentity: MODEL };
  await writeFile(join(f.projects, id, "learning-v1", "hypotheses", `${old.packet.fingerprint.slice(7)}.json`),
    JSON.stringify({ ...batch, fingerprint: learningFingerprint(batch) }));
  await assert.rejects(f.deps.hypotheses.list(id), /Unresolved hypothesis lineage/);
  await assert.rejects(new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: f.global }).prune(ROOT), /Unresolved/);
  assert.equal((await readdir(join(f.projects, id, "experience"))).length, 6);
});
