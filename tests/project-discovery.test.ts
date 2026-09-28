import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPindieHost } from "../src/host.ts";
import { getProjectId, FileStateStore } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { assembleRunExperience } from "../src/run-experience.ts";
import { FileRunExperienceStore, FileRunExperienceReader } from "../src/experience-store.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
import { FileDiscoveryReceiptStore } from "../src/discovery-receipts.ts";
import { FileDiscoveryPacketStore } from "../src/discovery-packets.ts";
import { FileDiscoveryHypothesisStore, hypothesisRef } from "../src/discovery-hypotheses.ts";
import { createProjectDiscoveryHandler, parseDiscoveryResult } from "../src/project-discovery-handler.ts";
import { LearningSupervisor } from "../src/learning-supervisor.ts";
import { FileLearningBudgetLedger } from "../src/learning-budget-store.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { buildProjectDiscoveryPacket, enqueueProjectDiscovery } from "../src/project-discovery.ts";
import { validateDiscoveryPacket, DEFAULT_PROJECT_DISCOVERY_POLICY } from "../src/discovery-contract.ts";
import { matchesLearningJobOutput, learningFingerprint } from "../src/learning-v1-contract.ts";

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
  const add = async (index: number, schema: 4 | 5 = 5, episode = randomUUID(), successful = false) => {
    const record = assembleRunExperience({ task: runtime.state.task!, runStart: { taskStatus: "active", taskGoal: "goal" },
      snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false,
        hasQuestions: false, completionReady: false, taskRelation: "preexisting_untouched", completionRelation: "not_completed", gateRelation: "none" },
      policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
      execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: index % 2, deniedCalls: 0 },
      durationMs: 1, cost: 0, recordedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
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
  await f.deps.receipts.publish(first, "none", []);
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
  await restarted.receipts.publish(second, "none", []);
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
  const receipt = await f.deps.receipts.publish(packet, "none", []);
  assert.deepEqual(await f.deps.receipts.publish(packet, "none", []), receipt);
  await assert.rejects(f.deps.receipts.publish(packet, "covered", []));
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
  summary: "Focus on the immediate evidence", useWhen: ["Evidence is available"], avoidWhen: [],
  expectedEffect: "Fewer failed verification checks on similar Tasks", failureSignals: ["More failed checks"],
  trialHints: ["Compare verified results"], sourceHandles: [packet.sources[0]!.ref.recordId], ...overrides,
});
async function prepared(t: import("node:test").TestContext) {
  const f = await setup(t);
  for (let i = 0; i < 6; i++) await f.add(i);
  const key = (await enqueueProjectDiscovery(id, f.deps))!;
  const job = (await f.deps.jobs.read()).find((j) => j.key === key)!;
  const packet = (await f.deps.packets.read(id, job.inputFingerprint))!;
  const handler = createProjectDiscoveryHandler(f.deps);
  return { ...f, key, job, packet, handler };
}
test("D2 frozen packet isolated runner none -> exact receipt -> completed job, no cognition", async (t) => {
  const f = await prepared(t);
  let calls = 0;
  const supervisor = new LearningSupervisor({ ledger: f.deps.jobs,
    budget: new FileLearningBudgetLedger({ globalBaseDir: f.global }), handlers: [f.handler],
    authority: { idle: () => true, generation: () => 0 },
    runner: { run: async (prompt) => { calls++; assert.ok(prompt.includes(f.packet.fingerprint)); return { text: '{"outcome":"none"}' }; } },
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
  const runner = { run: async () => { calls++; return { text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }; } };
  const output = await f.handler.execute(f.job, async () => true, new AbortController().signal, runner);
  const [hypothesis] = await f.deps.hypotheses.list(id);
  assert.ok(hypothesis);
  assert.equal(hypothesis.discoveryPacketFingerprint, f.packet.fingerprint);
  assert.ok(hypothesis.id !== f.job.key);
  assert.equal((await f.deps.receipts.read(id))[0]?.outcome, "published");
  assert.equal(await f.handler.matchesOutput(f.job, output.receiptRef), true);
  assert.deepEqual(await f.handler.resolveCommitted(f.job), output.receiptRef);
  assert.equal(calls, 1);
  await assert.rejects(f.deps.hypotheses.publish(f.packet, "published", [hypothesisRef(hypothesis)], [{ ...hypothesis, id: randomUUID() }]));
});
test("D2 crash after hypothesis commit recovers without a second model invocation", async (t) => {
  const f = await prepared(t);
  // Narrow failure injection preserves the real store's read/find/resolve methods.
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  let calls = 0;
  const runner = { run: async () => { calls++; return { text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }; } };
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
    runner: { run: async () => { throw new Error("A second model call is forbidden."); } },
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
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet, { capability: "task.complete" })] }),
    JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet), proposal(f.packet), proposal(f.packet)] })];
  for (const raw of invalid) await assert.rejects(f.handler.execute(f.job, async () => true, new AbortController().signal,
    { run: async () => ({ text: raw }) }));
  assert.deepEqual(await f.deps.receipts.read(id), []);
  assert.deepEqual(await f.deps.hypotheses.list(id), []);
  assert.equal(await f.handler.isCurrent(f.job), true);
});
test("D2 duplicate open hypothesis is covered and revision needs the exact frozen parent", async (t) => {
  const f = await prepared(t);
  const first = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  assert.equal(await f.handler.matchesOutput(f.job, first.receiptRef), true);
  // Another packet with the same exact sources, but changed open comparison, retains semantic dedupe identity.
  const existing = (await f.deps.hypotheses.list(id))[0]!;
  const openEntries = [{ ref: hypothesisRef(existing), logicalId: existing.logicalId, kind: existing.kind, baseRevisionFingerprint: existing.baseRevisionFingerprint,
    summary: existing.summary, expectedEffect: existing.expectedEffect,
    useWhen: existing.useWhen, avoidWhen: existing.avoidWhen, failureSignals: existing.failureSignals }];
  const content = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(openEntries), entries: openEntries } };
  const { fingerprint: _old, ...unsigned } = content;
  const next = { ...unsigned, fingerprint: learningFingerprint(unsigned) };
  await f.deps.packets.publish(next);
  const nextJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, next.fingerprint, 2, Date.now());
  assert.equal(await f.handler.isCurrent(nextJob), true);
  // The original job is recoverable, but a frozen packet without a commit is stale on this open catalog.
  const stalePacket = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 7 } };
  const { fingerprint: _stale, ...staleContent } = stalePacket;
  const stale = { ...staleContent, fingerprint: learningFingerprint(staleContent) };
  await f.deps.packets.publish(stale);
  const staleJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, stale.fingerprint, 2, Date.now());
  assert.equal(await f.handler.isCurrent(staleJob), false);
  const covered = await f.handler.execute(nextJob, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(next)] }) }) });
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
  const thirdJob = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, third.fingerprint, 2, Date.now());
  await assert.rejects(f.handler.execute(thirdJob, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [wrongLogical] }) }) }));
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
  const revised = proposal(third, { intent: "revise", revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(existing) },
    expectedEffect: "Fewer tool errors on similar Tasks" });
  const output = await f.handler.execute(thirdJob, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [revised] }) }) });
  assert.equal((await f.deps.receipts.resolve(output.receiptRef, thirdJob.key, third.fingerprint))?.outcome, "published");
  const children = await f.deps.hypotheses.list(id);
  assert.equal(children.length, 2);
  assert.deepEqual(children.find((h) => h.lineage === "revise")?.parent, hypothesisRef(existing));
  assert.equal(children.find((h) => h.lineage === "revise")?.baseRevisionFingerprint, null);
});
test("D2 covered batch recovers exact receipt after interrupted publication without model rerun", async (t) => {
  const f = await prepared(t);
  await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const h = (await f.deps.hypotheses.list(id))[0]!;
  const entries = [{ ref: hypothesisRef(h), logicalId: h.logicalId, kind: h.kind,
    baseRevisionFingerprint: h.baseRevisionFingerprint, summary: h.summary, expectedEffect: h.expectedEffect,
    useWhen: h.useWhen, avoidWhen: h.avoidWhen, failureSignals: h.failureSignals }];
  const { fingerprint: _prior, ...content } = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
  const packet = { ...content, fingerprint: learningFingerprint(content) };
  await f.deps.packets.publish(packet);
  const job = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, 2, Date.now());
  const original = f.deps.receipts.publish.bind(f.deps.receipts);
  f.deps.receipts.publish = async () => { throw new Error("crash"); };
  try {
    await assert.rejects(f.handler.execute(job, async () => true, new AbortController().signal,
      { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(packet)] }) }) }));
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
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [result] }) }) });
  assert.equal((await f.deps.receipts.resolve(first.receiptRef, f.job.key, f.packet.fingerprint))?.outcome, "published");
  const base = (await f.deps.hypotheses.list(id))[0]!;
  assert.equal(base.parent, null);
  assert.equal(base.baseRevisionFingerprint, trusted.revisionFingerprint);
  assert.equal(base.logicalId, trusted.strategyId);
  const entries = [{ ref: hypothesisRef(base), logicalId: base.logicalId, kind: base.kind,
    baseRevisionFingerprint: base.baseRevisionFingerprint, summary: base.summary, expectedEffect: base.expectedEffect,
    useWhen: base.useWhen, avoidWhen: base.avoidWhen, failureSignals: base.failureSignals }];
  const unsigned = { ...f.packet, openHypotheses: { fingerprint: learningFingerprint(entries), entries } };
  const { fingerprint: _prior, ...content } = unsigned;
  const packet = { ...content, fingerprint: learningFingerprint(content) };
  await f.deps.packets.publish(packet);
  const job = await f.deps.jobs.enqueue("project-discovery", { kind: "project", projectId: id }, packet.fingerprint, 2, Date.now());
  assert.equal(await f.handler.isCurrent(job), true);
  const second = proposal(packet, { logicalId: trusted.strategyId, kind: trusted.kind, intent: "revise",
    revisionTarget: { kind: "open-hypothesis", ref: hypothesisRef(base) }, expectedEffect: "Fewer failed checks after revisions" });
  await f.handler.execute(job, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [second] }) }) });
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
      { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [invalid] }) }) }));
  }
  const mismatch = proposal(f.packet, { logicalId: "unrelated", kind: trusted.kind, intent: "revise", revisionTarget: valid });
  assert.throws(() => parseDiscoveryResult(JSON.stringify({ outcome: "proposals", proposals: [mismatch] }), f.packet));
  assert.deepEqual(await f.deps.receipts.read(id), []);
  const collision = proposal(f.packet, { logicalId: trusted.strategyId, kind: trusted.kind });
  const outcome = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [collision] }) }) });
  assert.equal((await f.deps.receipts.resolve(outcome.receiptRef, f.job.key, f.packet.fingerprint))?.outcome, "none");
  assert.deepEqual(await f.deps.hypotheses.list(id), []);
});
test("D2 bounded publication rejects conflicting fingerprints and capacity without erasing open cognition", async (t) => {
  const f = await prepared(t);
  const output = await f.handler.execute(f.job, async () => true, new AbortController().signal,
    { run: async () => ({ text: JSON.stringify({ outcome: "proposals", proposals: [proposal(f.packet)] }) }) });
  const [h] = await f.deps.hypotheses.list(id);
  assert.ok(h);
  const commit = (await f.deps.hypotheses.committed(id, f.packet.fingerprint))!;
  assert.deepEqual(await f.deps.hypotheses.publish(f.packet, commit.outcome, commit.refs, commit.newHypotheses), commit);
  await assert.rejects(f.deps.hypotheses.publish(f.packet, "covered", [hypothesisRef(h)], []));
  assert.equal(await f.handler.matchesOutput(f.job, output.receiptRef), true);
  const content = { ...f.packet, eligibleCounts: { ...f.packet.eligibleCounts, new: 7 } };
  const { fingerprint: _old, ...unsigned } = content;
  const next = { ...unsigned, fingerprint: learningFingerprint(unsigned) };
  await assert.rejects(f.deps.hypotheses.publish(next, "published", [hypothesisRef(h)], [h]));
  assert.equal((await f.deps.hypotheses.list(id)).length, 1);
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
    { run: async () => { await waiting; return { text: '{"outcome":"none"}' }; } });
  controller.abort(); release();
  await assert.rejects(run);
  assert.deepEqual(await f.deps.receipts.read(id), []);
});
