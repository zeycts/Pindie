import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvaluationRunStore } from "../src/evaluation-run-store.ts";
import { FileExecutionLeaseStore, validateExecutionLeaseRef } from "../src/evaluation-execution-lease-store.ts";
import { evaluationRunRef, transitionEvaluationRun, type EvaluationRunV1, type EvaluationPacketRef } from "../src/evaluation-run.ts";
import { canonicalJson, learningFingerprint, hypothesisFingerprint, learningArtifactFingerprint, type StrategyHypothesisV2 } from "../src/learning-v1-contract.ts";
import { trialEvidenceRef, type TrialEvidenceV2 } from "../src/trial-evidence-v2.ts";
import { evaluationPacketRef, type EvaluationPacket } from "../src/evaluation-contract.ts";
import { prepareEvaluationInput, type EvaluationOutputV1 } from "../src/evaluator-contract.ts";
import { heartbeatExecutionLease } from "../src/evaluation-execution-lease.ts";
const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const start = "2026-01-01T00:00:01.000Z", end = "2026-01-01T00:00:02.000Z", later = "2026-01-01T00:00:03.000Z";
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
function fixture() {
  const semantics = { schemaVersion: 2 as const, scope, logicalId: "focused-check", kind: "approach" as const, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Run focused tests"], expectedEffect: "Fewer missed checks", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: hash }], discoveryPacketFingerprint: hash };
  const h: StrategyHypothesisV2 = { ...semantics, id: randomUUID(), fingerprint: hypothesisFingerprint(semantics) };
  const hypothesis = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope, id: h.id, fingerprint: h.fingerprint }, id = randomUUID();
  const e: TrialEvidenceV2 = seal({ schemaVersion: 2 as const, id, projectId, hypothesis,
    assignment: { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id: randomUUID(), fingerprint: hash },
    source: { projectId, recordId: `${id}.json`, fingerprint: hash }, workEpisodeId: randomUUID(), recordedAt: start,
    selection: { strategyId: h.logicalId, kind: h.kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint },
    postDeclaration: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active" as const, verificationStatus: "pending" as const, completionRelation: "not_completed" as const, hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { cost: null, durationMs: 100 }, comparison: [] });
  const packet: EvaluationPacket = seal({ schemaVersion: 1 as const, id: randomUUID(), scope, gateVersion: 1 as const, analysisMode: "observational" as const, hypothesis, hypothesisSnapshot: h,
    trials: [{ handle: "T1", ref: trialEvidenceRef(e), snapshot: e, disposition: "included" as const }], diversity: { projectCount: 1 as const, workEpisodeCount: 1 }, comparisonStatus: "unavailable" as const });
  const run: EvaluationRunV1 = { schemaVersion: 1, runId: randomUUID(), packetRef: evaluationPacketRef(packet) as EvaluationPacketRef, packetFingerprint: packet.fingerprint,
    evaluator: { name: "observation", version: "1" }, status: "running", createdAt: start, startedAt: start };
  const { context } = prepareEvaluationInput(packet, run);
  const output: EvaluationOutputV1 = { ...context, execution: { startedAt: start, completedAt: end }, observations: ["One work episode is represented."], diagnostics: [{ code: "NO_COMPARISON", message: "Comparison is unavailable." }] };
  return { packet, run, context, output };
}
async function setup(t: TestContext, f = fixture()) {
  const root = await mkdtemp(join(tmpdir(), "execution-lease-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { startedAt: _, ...base } = f.run;
  const created: EvaluationRunV1 = { ...base, status: "created" };
  const runs = new FileEvaluationRunStore({ projectsBaseDir: root, packets: { get: async () => f.packet } });
  await runs.publish(created);
  const claim = await runs.claimExecution(created, start);
  const options = { projectsBaseDir: root }, store = new FileExecutionLeaseStore(options);
  const dir = join(root, projectId, "learning-v1", "execution-leases-v1");
  return { root, created, claim, runs, store, dir, options };
}
test("C2 equivalent claims serialize identically in independent project histories", async (t) => {
  const data = fixture(), a = await setup(t, data), b = await setup(t, data);
  const initialA = await a.store.createLease(a.claim, "worker-1"), initialB = await b.store.createLease(b.claim, "worker-1");
  assert.deepEqual(initialA, initialB);
  const nextA = await a.store.heartbeat(initialA.ref, heartbeatExecutionLease(initialA.lease, end));
  const nextB = await b.store.heartbeat(initialB.ref, heartbeatExecutionLease(initialB.lease, end));
  assert.deepEqual(nextA, nextB);
  for (const name of await readdir(a.dir)) assert.equal(await readFile(join(a.dir, name), "utf8"), await readFile(join(b.dir, name), "utf8"));
});
test("C2 genuine claim publishes immutable canonical lease with exact restart lookup", async (t) => {
  const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
  assert.ok(validateExecutionLeaseRef(initial.ref));
  assert.deepEqual(initial.runningRef, evaluationRunRef(f.claim.running));
  assert.equal(initial.lease.acquiredAt, start); assert.equal(initial.previousFingerprint, null);
  const names = await readdir(f.dir), bytes = await readFile(join(f.dir, names[0]), "utf8");
  const { ref, ...content } = initial;
  assert.equal(bytes, canonicalJson({ ...content, fingerprint: ref.fingerprint }));
  assert.equal(ref.fingerprint, learningFingerprint(content));
  const restarted = new FileExecutionLeaseStore(f.options);
  assert.deepEqual(await restarted.get(ref), initial);
  assert.deepEqual(await restarted.getCurrent(projectId, f.created.runId), initial);
  assert.ok(Object.isFrozen(initial.lease)); assert.ok(Object.isFrozen(initial.runningRef)); assert.ok(Object.isFrozen(initial.ref));
  assert.deepEqual(await restarted.createLease(f.claim, "worker-1"), initial);
  assert.equal((await readdir(f.dir)).length, 1);
  await assert.rejects(f.store.get({ ...ref, fingerprint: hash }));
  await assert.rejects(f.store.get({ ...ref, projectId: "b".repeat(64) }));
  await assert.rejects(f.store.get({ ...ref, family: "evaluation-run" } as typeof ref));
});

test("C2 copied running data cannot create ownership metadata or execution authority", async (t) => {
  const f = await setup(t);
  const read = await f.runs.get(evaluationRunRef(f.claim.running));
  await assert.rejects(f.store.createLease({ running: read as typeof f.claim.running, publishTerminal: f.claim.publishTerminal }, "worker-1"));
  await assert.rejects(f.store.createLease({ ...f.claim }, "worker-1"));
  const foreign = new FileExecutionLeaseStore({ projectsBaseDir: join(f.root, "other") });
  await assert.rejects(foreign.createLease(f.claim, "worker-1"));
  await assert.rejects(f.runs.claimExecution(f.created, start));
  await assert.rejects(f.store.createLease(f.claim, ""));
  await assert.rejects(readdir(f.dir), { code: "ENOENT" });
});

test("C2 strict heartbeat persists linked history and preserves initial exact lookup", async (t) => {
  const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
  const originalBytes = await readFile(join(f.dir, (await readdir(f.dir))[0]), "utf8");
  const next = await f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end));
  assert.equal(next.previousFingerprint, initial.ref.fingerprint);
  assert.equal(next.lease.ownerId, initial.lease.ownerId); assert.equal(next.lease.acquiredAt, start);
  assert.deepEqual(await f.store.get(initial.ref), initial);
  assert.deepEqual(await f.store.getCurrent(projectId, initial.lease.runId), next);
  assert.equal(await readFile(join(f.dir, `${initial.ref.runId}.${initial.ref.fingerprint.slice(7)}.json`), "utf8"), originalBytes);
  for (const at of [start, end]) await assert.rejects(f.store.heartbeat(next.ref, { ...next.lease, heartbeatAt: at }));
  await assert.rejects(f.store.heartbeat(initial.ref, { ...initial.lease, heartbeatAt: later }));
  for (const patch of [{ runId: randomUUID() }, { ownerId: "worker-2" }, { acquiredAt: end }, { schemaVersion: 2 }]) {
    await assert.rejects(f.store.heartbeat(next.ref, { ...next.lease, heartbeatAt: later, ...patch } as typeof next.lease));
  }
  await assert.rejects(f.store.createLease(f.claim, "worker-2"));
  assert.equal((await readdir(f.dir)).length, 2);
  assert.deepEqual(await f.store.createLease(f.claim, "worker-1"), initial);
});

test("C2 independent writers converge on creation and serialize competing heartbeats", async (t) => {
  const f = await setup(t), other = new FileExecutionLeaseStore(f.options);
  const created = await Promise.all([f.store.createLease(f.claim, "worker-1"), other.createLease(f.claim, "worker-1")]);
  assert.deepEqual(created[0], created[1]);
  const initial = created[0];
  const results = await Promise.allSettled([
    f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end)),
    other.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, later)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await readdir(f.dir)).length, 2);
});
test("C2 competing owner identities cannot create two lease origins", async (t) => {
  const f = await setup(t), other = new FileExecutionLeaseStore(f.options);
  const results = await Promise.allSettled([f.store.createLease(f.claim, "worker-1"), other.createLease(f.claim, "worker-2")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal((await readdir(f.dir)).length, 1);
});

for (const kind of ["json", "version", "lease-version", "invalid-lease", "noncanonical", "fingerprint", "binding", "origin", "oversize", "filename"]) {
  test(`C2 corruption fails closed on read and write: ${kind}`, async (t) => {
    const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
    const name = (await readdir(f.dir))[0], path = join(f.dir, name), value = JSON.parse(await readFile(path, "utf8"));
    if (kind === "version") value.schemaVersion = 2;
    if (kind === "lease-version") value.lease.schemaVersion = 2;
    if (kind === "invalid-lease") value.lease.ownerId = "";
    if (kind === "fingerprint") value.fingerprint = hash;
    if (kind === "binding") value.runningRef.runId = randomUUID();
    if (kind === "origin") {
      value.previousFingerprint = hash;
      const { fingerprint: _, ...content } = value; value.fingerprint = learningFingerprint(content);
      await rm(path);
    }
    const target = kind === "origin" ? join(f.dir, `${initial.lease.runId}.${value.fingerprint.slice(7)}.json`) : path;
    await writeFile(target, kind === "json" ? "{" : kind === "oversize" ? "x".repeat(4097) : kind === "noncanonical" ? JSON.stringify(value, null, 2) : canonicalJson(value));
    if (kind === "filename") await writeFile(join(f.dir, "unexpected.json"), "{}");
    await assert.rejects(f.store.get(initial.ref));
    await assert.rejects(f.store.getCurrent(projectId, initial.lease.runId));
    await assert.rejects(f.store.createLease(f.claim, "worker-1"));
    await assert.rejects(f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end)));
  });
}

test("C2 missing predecessors fail closed rather than silently choosing a current pointer", async (t) => {
  const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
  const next = await f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end));
  await rm(join(f.dir, `${initial.ref.runId}.${initial.ref.fingerprint.slice(7)}.json`));
  await assert.rejects(f.store.get(next.ref));
});
test("C2 validly rehashed heartbeat with changed ownership still corrupts history", async (t) => {
  const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
  const next = await f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end));
  const path = join(f.dir, `${next.ref.runId}.${next.ref.fingerprint.slice(7)}.json`);
  const { ref: _, ...content } = next;
  const changed = { ...content, lease: { ...content.lease, ownerId: "worker-2" } };
  const fingerprint = learningFingerprint(changed);
  await rm(path);
  await writeFile(join(f.dir, `${next.ref.runId}.${fingerprint.slice(7)}.json`), canonicalJson({ ...changed, fingerprint }));
  await assert.rejects(f.store.getCurrent(projectId, initial.lease.runId));
  await assert.rejects(f.store.get(initial.ref));
});

test("C2 precommit failure exposes nothing; lost acknowledgment preserves exact committed metadata", async (t) => {
  const f = await setup(t);
  const pre = new FileExecutionLeaseStore({ ...f.options, beforePublish: async () => { throw new Error("precommit"); } });
  await assert.rejects(pre.createLease(f.claim, "worker-1"));
  assert.deepEqual(await readdir(f.dir), []);
  const post = new FileExecutionLeaseStore({ ...f.options, afterPublish: async () => { throw new Error("postcommit"); } });
  await assert.rejects(post.createLease(f.claim, "worker-1"));
  const initial = await f.store.createLease(f.claim, "worker-1");
  await assert.rejects(post.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end)));
  const current = await f.store.getCurrent(projectId, initial.lease.runId);
  assert.equal(current.lease.heartbeatAt, end);
  assert.deepEqual(await f.store.get(current.ref), current);
  await assert.rejects(f.store.heartbeat(initial.ref, current.lease));
});

test("C2 publication detaches heartbeat input before asynchronous commit", async (t) => {
  const f = await setup(t), initial = await f.store.createLease(f.claim, "worker-1");
  const input = { ...initial.lease, heartbeatAt: end };
  const pending = f.store.heartbeat(initial.ref, input); input.ownerId = "changed"; input.heartbeatAt = later;
  const next = await pending;
  assert.equal(next.lease.ownerId, "worker-1"); assert.equal(next.lease.heartbeatAt, end);
});

test("C2 namespace and capability isolation leave runs and semantic state unchanged", async (t) => {
  const f = await setup(t), learning = join(f.root, projectId, "learning-v1");
  const dirs = ["strategies", "policy", "trust", "decisions", "experience", "evaluation-results-v1"];
  for (const name of dirs) { await mkdir(join(learning, name)); await writeFile(join(learning, name, "sentinel"), name); }
  const runDir = join(learning, "evaluation-runs-v1"), names = await readdir(runDir);
  const before = await Promise.all(names.map((n) => readFile(join(runDir, n), "utf8")));
  const initial = await f.store.createLease(f.claim, "worker-1");
  await f.store.heartbeat(initial.ref, heartbeatExecutionLease(initial.lease, end));
  assert.deepEqual(await readdir(runDir), names);
  assert.deepEqual(await Promise.all(names.map((n) => readFile(join(runDir, n), "utf8"))), before);
  for (const name of dirs) assert.equal(await readFile(join(learning, name, "sentinel"), "utf8"), name);
  for (const name of ["publishTerminal", "evaluate", "claimExecution", "promote", "setPolicy", "saveExperience"]) assert.equal(name in f.store, false);
  // Terminal execution authority ends in the run store; historical metadata remains observable.
  await f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", later));
  assert.deepEqual(await f.store.get(initial.ref), initial);
  await assert.rejects(f.runs.claimExecution(f.created, start));
});
