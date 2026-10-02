import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileEvaluationRunStore } from "../src/evaluation-run-store.ts";
import { FileExecutionLeaseStore } from "../src/evaluation-execution-lease-store.ts";
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

import { FileExecutionAuthorityStore, createRecoveryCoordinator } from "../src/evaluation-execution-authority-store.ts";
import { validateStaleConfirmation, executionAuthoritySnapshot, type StaleConfirmationV1, type ExecutionCessationEvidenceV1 } from "../src/evaluation-stale-confirmation.ts";
const confirmedAt = "2026-01-01T00:01:00.000Z";
const policy = { schemaVersion: 1 as const, staleAfterMs: 1000, maxClockUncertaintyMs: 0 };
const clock = { schemaVersion: 1 as const, observedAt: confirmedAt, comparison: { kind: "bounded" as const, uncertaintyMs: 0 } };
const confirmer = { id: "recovery-controller", incarnation: "controller-boot-1" };
async function confirmationFixture(t: TestContext) {
  const f = await setup(t), lease = await f.store.createLease(f.claim, "worker-1");
  const authorities = new FileExecutionAuthorityStore(f.options), origin = await authorities.getCurrent(projectId, f.created.runId);
  if (origin.record.kind !== "owned") throw new Error("Missing origin");
  const evidence: ExecutionCessationEvidenceV1 = { schemaVersion: 1, kind: "joined", authorityRef: origin.ref,
    claimId: origin.record.claimId, incarnation: origin.record.incarnation, handleId: "handle-1", observedAt: confirmedAt, coverage: "all-publication-capable-actors" };
  const record: StaleConfirmationV1 = { schemaVersion: 1, kind: "stale-confirmation", runId: f.created.runId, runningRef: origin.record.runningRef,
    previousAuthorityRef: origin.ref, previousLeaseRef: lease.ref, previousOwnerId: lease.lease.ownerId, previousLeaseEpoch: 0, newFencingEpoch: 1,
    confirmer, confirmedAt, reason: "owner-cessation", evidence, policy, clock };
  const options = { projectsBaseDir: f.root, confirmer, runs: f.runs, leases: f.store,
    ownerMonitor: { inspect: async () => evidence }, clock: { now: () => clock }, policy, isAuthorized: () => true };
  const coordinator = createRecoveryCoordinator(options);
  return { ...f, lease, origin, evidence, record, authorities, coordinator, coordinatorOptions: options,
    authorityDir: join(f.root, projectId, "learning-v1", "execution-authorities-v1") };
}
const clone = <T>(v: T): T => JSON.parse(canonicalJson(v));

test("C6 coordinator publishes immutable canonical confirmation with exact restart lookup", async t => {
  const f = await confirmationFixture(t), originNames = await readdir(f.authorityDir);
  const before = await readFile(join(f.authorityDir, originNames[0]), "utf8");
  assert.ok(validateStaleConfirmation(f.record));
  const result = await f.coordinator.confirm(f.record);
  assert.deepEqual(result, executionAuthoritySnapshot(f.record));
  assert.ok(Object.isFrozen(result.record)); assert.ok(Object.isFrozen(result.ref));
  assert.ok(Object.isFrozen((result.record as StaleConfirmationV1).evidence));
  const restarted = new FileExecutionAuthorityStore(f.options);
  assert.deepEqual(await restarted.get(result.ref), result);
  assert.deepEqual(await restarted.get(f.origin.ref), f.origin);
  assert.deepEqual(await restarted.getCurrent(projectId, f.created.runId), result);
  const bytes = await readFile(join(f.authorityDir, `${result.ref.runId}.${result.ref.fingerprint.slice(7)}.json`), "utf8");
  assert.equal(bytes, canonicalJson({ schemaVersion: 1, record: f.record, fingerprint: result.ref.fingerprint }));
  assert.equal(await readFile(join(f.authorityDir, originNames[0]), "utf8"), before);
  assert.deepEqual(await f.coordinator.confirm(clone(f.record)), result);
  assert.equal((await readdir(f.authorityDir)).length, 2);
  await assert.rejects(restarted.get({ ...result.ref, fingerprint: hash }));
  await assert.rejects(restarted.get({ ...result.ref, projectId: "b".repeat(64) }));
  assert.equal((await f.runs.getCurrent(projectId, f.created.runId)).status, "running");
});

test("C6 confirmation fences old terminal, ordinary publication, lease origin and heartbeat across store instances", async t => {
  const f = await confirmationFixture(t);
  await f.coordinator.confirm(f.record);
  const terminal = transitionEvaluationRun(f.claim.running, "completed", confirmedAt);
  await assert.rejects(f.claim.publishTerminal(terminal), /epoch/);
  const runs = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: { get: async () => fixture().packet } });
  await assert.rejects(runs.publish(terminal), /epoch/);
  await assert.rejects(runs.publish(f.claim.running), /epoch/);
  await assert.rejects(f.store.createLease(f.claim, "worker-1"), /epoch/);
  const leases = new FileExecutionLeaseStore(f.options);
  await assert.rejects(leases.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, confirmedAt)), /epoch/);
  assert.deepEqual(await leases.get(f.lease.ref), f.lease);
  await assert.rejects(runs.claimExecution(f.created, start));
});

test("C6 conflicting decisions, stale predecessor and nonmonotonic epochs reject", async t => {
  const f = await confirmationFixture(t);
  for (const patch of [{ previousLeaseEpoch: -1 }, { newFencingEpoch: 0 }, { newFencingEpoch: 2 },
    { previousLeaseEpoch: Number.MAX_SAFE_INTEGER, newFencingEpoch: Number.MAX_SAFE_INTEGER + 1 }, { extra: true }]) {
    await assert.rejects(f.coordinator.confirm({ ...f.record, ...patch }));
  }
  // A structurally increasing epoch cannot replace the exact owned epoch zero.
  const next = { ...f.record, previousLeaseEpoch: 1, newFencingEpoch: 2 };
  assert.ok(validateStaleConfirmation(next));
  await assert.rejects(f.coordinator.confirm(next), /epoch/);
  await assert.rejects(f.coordinator.confirm({ ...f.record, previousAuthorityRef: { ...f.origin.ref, fingerprint: hash },
    evidence: { ...f.evidence, authorityRef: { ...f.origin.ref, fingerprint: hash } } }), /predecessor/);
  const result = await f.coordinator.confirm(f.record);
  await assert.rejects(f.coordinator.confirm({ ...f.record, reason: "timeout" } as unknown as StaleConfirmationV1));
  await assert.rejects(f.coordinator.confirm({ ...f.record, previousOwnerId: "another-owner" }), /Conflicting/);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), result);
});

test("C6 independent coordinators converge on identical requests and reject competing confirmation", async t => {
  const f = await confirmationFixture(t), other = createRecoveryCoordinator(f.coordinatorOptions);
  const results = await Promise.all([f.coordinator.confirm(f.record), other.confirm(clone(f.record))]);
  assert.deepEqual(results[0], results[1]);
  const g = await confirmationFixture(t);
  const changed = { ...g.record, evidence: { ...g.evidence, kind: "terminated" as const } };
  const competitor = createRecoveryCoordinator({ ...g.coordinatorOptions, ownerMonitor: { inspect: async () => changed.evidence } });
  const raced = await Promise.allSettled([g.coordinator.confirm(g.record), competitor.confirm(changed)]);
  assert.equal(raced.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(raced.filter(r => r.status === "rejected").length, 1);
  assert.equal((await readdir(g.authorityDir)).length, 2);
});

test("C6 changed lease invalidates confirmation and terminal first prevents revocation", async t => {
  const f = await confirmationFixture(t);
  await f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, end));
  await assert.rejects(f.coordinator.confirm(f.record), /predecessor/);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.origin);
  const g = await confirmationFixture(t);
  await g.claim.publishTerminal(transitionEvaluationRun(g.claim.running, "completed", end));
  await assert.rejects(g.coordinator.confirm(g.record), /predecessor/);
});

test("C6 missing proof, conflicting owner provenance, fresh metadata and untrusted clock fail closed", async t => {
  const f = await confirmationFixture(t);
  for (const evidence of [null, { ...f.evidence, coverage: "callback-only" }, { ...f.evidence, claimId: randomUUID() },
    { ...f.evidence, incarnation: "different-boot" }]) {
    const coordinator = createRecoveryCoordinator({ ...f.coordinatorOptions, ownerMonitor: { inspect: async () => evidence as ExecutionCessationEvidenceV1 } });
    await assert.rejects(coordinator.confirm(f.record), /proof/);
  }
  const freshClock = { ...clock, observedAt: start };
  const fresh = createRecoveryCoordinator({ ...f.coordinatorOptions, clock: { now: () => freshClock } });
  await assert.rejects(fresh.confirm({ ...f.record, confirmedAt: start, clock: freshClock, evidence: { ...f.evidence, observedAt: start } }));
  const untrusted = { ...clock, comparison: { kind: "untrusted" as const } };
  const uncertain = createRecoveryCoordinator({ ...f.coordinatorOptions, clock: { now: () => untrusted } });
  await assert.rejects(uncertain.confirm({ ...f.record, clock: untrusted }), /candidate/);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.origin);
});

test("C6 coordinator identity, root and explicit authorization are required and checked at link", async t => {
  const f = await confirmationFixture(t);
  assert.throws(() => createRecoveryCoordinator({ ...f.coordinatorOptions, projectsBaseDir: join(f.root, "foreign") }));
  await assert.rejects(f.coordinator.confirm({ ...f.record, confirmer: { ...confirmer, id: "forged" } }), /Unauthorized/);
  await assert.rejects(f.coordinator.confirm({ ...f.record, policy: { ...policy, staleAfterMs: 1 } }), /Unauthorized/);
  let allowed = true;
  const coordinator = createRecoveryCoordinator({ ...f.coordinatorOptions, isAuthorized: () => allowed,
    beforePublish: async () => { allowed = false; } });
  await assert.rejects(coordinator.confirm(f.record), /Unauthorized/);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.origin);
  assert.equal("publish" in f.authorities, false);
  for (const name of ["claimExecution", "execute", "retry", "cancel", "publishTerminal", "promote", "setPolicy", "saveExperience"]) assert.equal(name in coordinator, false);
});

for (const corruption of ["json", "noncanonical", "digest", "version", "epoch", "predecessor", "missing-origin", "oversize"]) {
  test(`C6 corruption fails closed on authority lookup, confirmation and old writes: ${corruption}`, async t => {
    const f = await confirmationFixture(t), result = await f.coordinator.confirm(f.record);
    const path = join(f.authorityDir, `${result.ref.runId}.${result.ref.fingerprint.slice(7)}.json`);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (corruption === "version") value.schemaVersion = 2;
    if (corruption === "digest") value.fingerprint = hash;
    if (corruption === "epoch") { value.record.previousLeaseEpoch = 1; value.record.newFencingEpoch = 2; }
    if (corruption === "predecessor") { value.record.previousAuthorityRef.fingerprint = hash; value.record.evidence.authorityRef.fingerprint = hash; }
    if (["epoch", "predecessor"].includes(corruption)) {
      value.fingerprint = learningFingerprint(value.record); await rm(path);
      await writeFile(join(f.authorityDir, `${result.ref.runId}.${value.fingerprint.slice(7)}.json`), canonicalJson(value));
    } else if (corruption === "missing-origin") await rm(join(f.authorityDir, `${f.origin.ref.runId}.${f.origin.ref.fingerprint.slice(7)}.json`));
    else await writeFile(path, corruption === "json" ? "{" : corruption === "noncanonical" ? JSON.stringify(value, null, 2) : corruption === "oversize" ? "x".repeat(9000) : canonicalJson(value));
    await assert.rejects(f.authorities.get(result.ref));
    await assert.rejects(f.authorities.getCurrent(projectId, f.created.runId));
    await assert.rejects(f.coordinator.confirm(f.record));
    await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", confirmedAt)));
    await assert.rejects(f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, confirmedAt)));
  });
}

test("C6 pre-link storage failure changes no authority; post-link failure preserves fence and reconciles exactly", async t => {
  const f = await confirmationFixture(t);
  const before = createRecoveryCoordinator({ ...f.coordinatorOptions, beforePublish: async () => { throw new Error("storage unavailable"); } });
  await assert.rejects(before.confirm(f.record));
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.origin);
  const after = createRecoveryCoordinator({ ...f.coordinatorOptions, afterPublish: async () => { throw new Error("lost acknowledgment"); } });
  await assert.rejects(after.confirm(f.record));
  const committed = await f.authorities.getCurrent(projectId, f.created.runId);
  assert.equal(committed.record.kind, "stale-confirmation");
  await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", confirmedAt)));
  assert.deepEqual(await f.coordinator.confirm(f.record), committed);
  assert.equal((await readdir(f.authorityDir)).length, 2);
});

test("C6 confirmation freezes input and leaves run, lease and semantic namespaces unchanged", async t => {
  const f = await confirmationFixture(t), learning = join(f.root, projectId, "learning-v1");
  const sentinels = ["strategy", "policy", "trust", "decision", "experience", "evaluation-results-v1"];
  for (const name of sentinels) { await mkdir(join(learning, name)); await writeFile(join(learning, name, "sentinel"), name); }
  const runBefore = await f.runs.getCurrent(projectId, f.created.runId), leaseBefore = await f.store.getCurrent(projectId, f.created.runId);
  const input = clone(f.record), pending = f.coordinator.confirm(input);
  (input as { previousOwnerId: string }).previousOwnerId = "changed";
  (input.evidence as { handleId: string }).handleId = "changed";
  const result = await pending;
  assert.deepEqual(result.record, f.record);
  assert.deepEqual(await f.runs.getCurrent(projectId, f.created.runId), runBefore);
  assert.deepEqual(await f.store.getCurrent(projectId, f.created.runId), leaseBefore);
  for (const name of sentinels) assert.equal(await readFile(join(learning, name, "sentinel"), "utf8"), name);
});

test("C6 confirmation frontier serializes waiting heartbeat and terminal publication", async t => {
  const f = await confirmationFixture(t);
  let release!: () => void, entered!: () => void;
  const atFrontier = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const coordinator = createRecoveryCoordinator({ ...f.coordinatorOptions, beforePublish: async () => { entered(); await gate; } });
  const confirming = coordinator.confirm(f.record);
  await atFrontier;
  const heartbeat = f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, confirmedAt));
  const terminal = f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", confirmedAt));
  const writes = Promise.allSettled([heartbeat, terminal]);
  release(); await confirming;
  assert.ok((await writes).every(r => r.status === "rejected"));
  assert.equal((await f.runs.getCurrent(projectId, f.created.runId)).status, "running");
});

function processScript(root: string, input: string, frontier?: "beforePublish" | "afterPublish") {
  const authorityModule = new URL("../src/evaluation-execution-authority-store.ts", import.meta.url).href;
  const runModule = new URL("../src/evaluation-run-store.ts", import.meta.url).href;
  const leaseModule = new URL("../src/evaluation-execution-lease-store.ts", import.meta.url).href;
  return `import { readFile } from 'node:fs/promises';
    import { createRecoveryCoordinator } from ${JSON.stringify(authorityModule)};
    import { FileEvaluationRunStore } from ${JSON.stringify(runModule)};
    import { FileExecutionLeaseStore } from ${JSON.stringify(leaseModule)};
    const record=JSON.parse(await readFile(${JSON.stringify(input)},'utf8'));
    const projectsBaseDir=${JSON.stringify(root)};
    const coordinator=createRecoveryCoordinator({projectsBaseDir,confirmer:record.confirmer,policy:record.policy,
      runs:new FileEvaluationRunStore({projectsBaseDir,packets:{get:async()=>{throw new Error('no packet reads')}}}),
      leases:new FileExecutionLeaseStore({projectsBaseDir}),ownerMonitor:{inspect:async()=>record.evidence},
      clock:{now:()=>record.clock},isAuthorized:()=>true${frontier ? `,${frontier}:async()=>process.exit(0)` : ""}});
    await coordinator.confirm(record);`;
}
test("C6 separate processes serialize conflicting confirmations", async t => {
  const f = await confirmationFixture(t), inputA = join(f.root, "a.json"), inputB = join(f.root, "b.json");
  await writeFile(inputA, canonicalJson(f.record));
  await writeFile(inputB, canonicalJson({ ...f.record, evidence: { ...f.evidence, handleId: "handle-2" } }));
  const runProcess = promisify(execFile);
  const results = await Promise.allSettled([inputA, inputB].map(input =>
    runProcess(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", processScript(f.root, input)])));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal((await readdir(f.authorityDir)).length, 2);
});

test("C6 process death before/after revocation preserves immutable authority frontier", async t => {
  for (const frontier of ["beforePublish", "afterPublish"] as const) {
    const f = await confirmationFixture(t), input = join(f.root, "input.json");
    await writeFile(input, canonicalJson(f.record));
    await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", processScript(f.root, input, frontier)]);
    const current = await f.authorities.getCurrent(projectId, f.created.runId);
    assert.equal(current.record.kind, frontier === "beforePublish" ? "owned" : "stale-confirmation");
    const reconciled = await f.coordinator.confirm(f.record);
    assert.deepEqual(reconciled, executionAuthoritySnapshot(f.record));
    await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", confirmedAt)));
    assert.equal((await readdir(f.authorityDir)).length, 2);
  }
});

test("C6 strict confirmation schema rejects malformed identities, times and capability-bearing metadata", async t => {
  const f = await confirmationFixture(t);
  for (const patch of [{ schemaVersion: 2 }, { runId: randomUUID() }, { previousOwnerId: "" }, { confirmedAt: "bad" },
    { confirmer: { ...confirmer, execute: () => {} } }, { evidence: { ...f.evidence, execute: () => {} } },
    { evidence: { ...f.evidence, observedAt: "2027-01-01T00:00:00.000Z" } },
    { previousLeaseRef: { ...f.lease.ref, family: "evaluation-result" } },
    { runningRef: { ...f.record.runningRef, status: "completed" } }]) {
    assert.equal(validateStaleConfirmation({ ...f.record, ...patch }), false);
    await assert.rejects(f.coordinator.confirm({ ...f.record, ...patch } as StaleConfirmationV1));
  }
  assert.equal((await readdir(f.authorityDir)).length, 1);
});

test("C6 consumed claim with interrupted authority initialization grants no replacement or write authority", async t => {
  const f = await setup(t), next = { ...f.created, runId: randomUUID() };
  await f.runs.publish(next);
  const broken = new FileEvaluationRunStore({ projectsBaseDir: f.root, packets: { get: async () => fixture().packet },
    afterPublish: async () => { throw new Error("lost running acknowledgment"); } });
  await assert.rejects(broken.claimExecution(next, start));
  const running = await f.runs.getCurrent(projectId, next.runId);
  assert.equal(running.status, "running");
  await assert.rejects(f.runs.claimExecution(next, start));
  await assert.rejects(f.runs.publish(transitionEvaluationRun(running, "completed", confirmedAt)), /authority/);
});
