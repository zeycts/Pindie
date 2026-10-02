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
async function setup(t: TestContext, f = fixture(), existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "recovery-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { startedAt: _, ...base } = f.run;
  const created: EvaluationRunV1 = { ...base, status: "created" };
  const runs = new FileEvaluationRunStore({ projectsBaseDir: root, packets: { get: async () => f.packet } });
  await runs.publish(created);
  const claim = await runs.claimExecution(created, start);
  const options = { projectsBaseDir: root }, store = new FileExecutionLeaseStore(options);
  const dir = join(root, projectId, "learning-v1", "execution-leases-v1");
  return { root, created, claim, runs, store, dir, options, packet: f.packet };
}

import { FileExecutionAuthorityStore, createRecoveryCoordinator } from "../src/evaluation-execution-authority-store.ts";
import { validateStaleConfirmation, executionAuthoritySnapshot, type StaleConfirmationV1, type ExecutionCessationEvidenceV1 } from "../src/evaluation-stale-confirmation.ts";
const confirmedAt = "2026-01-01T00:01:00.000Z";
const policy = { schemaVersion: 1 as const, staleAfterMs: 1000, maxClockUncertaintyMs: 0 };
const clock = { schemaVersion: 1 as const, observedAt: confirmedAt, comparison: { kind: "bounded" as const, uncertaintyMs: 0 } };
const confirmer = { id: "recovery-controller", incarnation: "controller-boot-1" };
async function confirmationFixture(t: TestContext, root?: string) {
  const f = await setup(t, fixture(), root), lease = await f.store.createLease(f.claim, "worker-1");
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

import { createRecoveryAdmissionBinding, recoveryAdmissionSnapshot, validateRecoveryAdmission, validateRecoveryAdmissionBinding,
  type RecoveryAdmissionV1, type RecoveryReconciliationV1, type RecoveryResourcesV1, type EvaluationRecoveryPolicyV1 } from "../src/recovery-admission.ts";
import { createRecoveryAdmissionCoordinator, FileRecoveryAdmissionStore } from "../src/recovery-admission-store.ts";
const admittedAt = "2026-01-01T00:02:00.000Z";
const amount = (n: number) => ({ tokens: n, costMicros: n, durationMs: n });
async function admissionFixture(t: TestContext, root?: string) {
  const f = await confirmationFixture(t, root), revoked = await f.coordinator.confirm(f.record);
  const binding = createRecoveryAdmissionBinding({ identityVersion: 1, projectId, rootCreatedRef: evaluationRunRef(f.created),
    oldRunningRef: evaluationRunRef(f.claim.running), confirmationRef: revoked.ref, fencingEpoch: 1,
    packetRef: f.created.packetRef, packetFingerprint: f.created.packetFingerprint, evaluator: f.created.evaluator,
    executionContractFingerprint: hash, generation: 1, previousAdmissionRef: null });
  const controller = { id: "admission-controller", incarnation: "admission-boot", authorizationFingerprint: hash };
  const recoveryPolicy: EvaluationRecoveryPolicyV1 = { schemaVersion: 1, maxRecoveryAdmissions: 3, allowedClass: "fenced-owner-cessation-no-output",
    retryableEvaluators: [{ ...binding.evaluator, executionContractFingerprint: hash }], perAdmission: amount(200), perEvaluation: amount(500), global: amount(1000) };
  const reconciliation: RecoveryReconciliationV1 = { schemaVersion: 1, opportunityKey: binding.opportunityKey, observedAt: admittedAt,
    state: "SAFE_NO_COMMITTED_OUTPUT", rootBinding: "exact-standalone-root", publicationManifestFingerprint: hash,
    publication: "closed-and-quiescent", outputs: "none-committed", effects: "none", ambiguities: "none",
    cessation: { confirmationRef: revoked.ref, claimId: f.evidence.claimId, incarnation: f.evidence.incarnation, handleId: f.evidence.handleId,
      coverage: "all-local-and-external-execution", status: "ceased" }, runtime: { executionContractFingerprint: hash, isolation: "verified", readiness: "ready" } };
  const resources: RecoveryResourcesV1 = { schemaVersion: 1, opportunityKey: binding.opportunityKey, observedAt: admittedAt,
    usageAccounting: "conservative", oldAttemptUsage: amount(10), evaluationBaseUsage: amount(10), globalBaseUsage: amount(10), reservation: amount(100),
    capacity: { runSlots: 100, authoritySlots: 100, leaseSlots: 100 } };
  const admission: RecoveryAdmissionV1 = { schemaVersion: 1, binding, originAuthorityRef: f.origin.ref, controller, policy: recoveryPolicy,
    policyFingerprint: learningFingerprint(recoveryPolicy), admittedAt, reason: "fenced-owner-cessation-no-output", reconciliation, resources };
  const admissionOptions = { projectsBaseDir: f.root, controller, policy: recoveryPolicy, runs: f.runs, leases: f.store,
    packets: { get: async () => f.packet }, reconciliation: { inspect: async () => reconciliation }, resources: { inspect: async () => resources },
    now: () => admittedAt, isAuthorized: () => true };
  const admissionCoordinator = createRecoveryAdmissionCoordinator(admissionOptions), admissions = new FileRecoveryAdmissionStore(f.options);
  return { ...f, revoked, admission, admissionOptions, admissionCoordinator, admissions,
    admissionDir: join(f.root, projectId, "learning-v1", "recovery-admissions-v1") };
}
function rebind(a: RecoveryAdmissionV1, patch: object): RecoveryAdmissionV1 {
  const { logicalEvaluationKey: _, opportunityKey: __, ...input } = a.binding;
  const binding = createRecoveryAdmissionBinding({ ...input, ...patch });
  return { ...a, binding, reconciliation: { ...a.reconciliation, opportunityKey: binding.opportunityKey,
    cessation: { ...a.reconciliation.cessation, confirmationRef: binding.confirmationRef }, runtime: { ...a.reconciliation.runtime, executionContractFingerprint: binding.executionContractFingerprint } },
    resources: { ...a.resources, opportunityKey: binding.opportunityKey } };
}
function register(f: Awaited<ReturnType<typeof admissionFixture>>, a: RecoveryAdmissionV1, overrides = {}) {
  return createRecoveryAdmissionCoordinator({ ...f.admissionOptions, controller: a.controller, policy: a.policy,
    reconciliation: { inspect: async () => a.reconciliation }, resources: { inspect: async () => a.resources }, ...overrides });
}
async function files(path: string) { try { return (await readdir(path)).filter(n => n !== "writer.lock"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } }

test("C7-A publishes canonical immutable admission, exact lookup and identical acknowledgment replay", async t => {
  const f = await admissionFixture(t);
  assert.ok(validateRecoveryAdmission(f.admission));
  const committed = await f.admissionCoordinator.admit(f.admission);
  assert.deepEqual(committed, recoveryAdmissionSnapshot(f.admission));
  assert.ok(Object.isFrozen(committed.admission.resources.reservation));
  assert.deepEqual(await new FileRecoveryAdmissionStore(f.options).get(committed.ref), committed);
  assert.deepEqual(await createRecoveryAdmissionCoordinator(f.admissionOptions).admit(clone(f.admission)), committed);
  assert.equal((await files(f.admissionDir)).length, 1);
  const bytes = await readFile(join(f.admissionDir, (await files(f.admissionDir))[0]), "utf8");
  assert.equal(bytes, canonicalJson({ schemaVersion: 1, admission: f.admission, fingerprint: committed.ref.fingerprint }));
  for (const patch of [{ fingerprint: hash }, { opportunityKey: hash }, { generation: 2 }, { extra: true }])
    await assert.rejects(f.admissions.get({ ...committed.ref, ...patch }));
  // A replay acknowledges existing metadata, without issuing a fresh resource reservation or execution permission.
  assert.deepEqual(await register(f, f.admission, { reconciliation: { inspect: async () => { throw new Error("no new reconciliation"); } } }).admit(f.admission), committed);
});

test("C7-A deterministic identity ignores field order and changes with each immutable source fact", async t => {
  const f = await admissionFixture(t), b = f.admission.binding;
  assert.ok(validateRecoveryAdmissionBinding(b));
  assert.deepEqual(rebind(f.admission, {}).binding, b);
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.ok(validateRecoveryAdmissionBinding(reordered));
  for (const patch of [{ confirmationRef: { ...b.confirmationRef, fingerprint: hash } },
    { evaluator: { ...b.evaluator, version: "2" } }, { executionContractFingerprint: learningFingerprint("different contract") },
    { packetRef: { ...b.packetRef, fingerprint: hash }, packetFingerprint: hash }]) {
    assert.notEqual(rebind(f.admission, patch).binding.opportunityKey, b.opportunityKey);
  }
  assert.equal(recoveryAdmissionSnapshot({ ...f.admission, controller: { ...f.admission.controller, incarnation: "other" } }).ref.opportunityKey, b.opportunityKey);
  assert.equal(validateRecoveryAdmissionBinding({ ...b, opportunityKey: hash }), false);
});

test("C7-A strict nested schemas reject unknown fields, oversized strings, invalid integers and timestamps", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ extra: true }, { newAttemptSpec: { runId: randomUUID() } }, { admittedAt: "invalid" },
    { controller: { ...f.admission.controller, id: "x".repeat(129) } },
    { resources: { ...f.admission.resources, capacity: { ...f.admission.resources.capacity, extra: true } } },
    { resources: { ...f.admission.resources, reservation: amount(Number.MAX_SAFE_INTEGER + 1) } },
    { reconciliation: { ...f.admission.reconciliation, cessation: { ...f.admission.reconciliation.cessation, claimId: "not-a-claim" } } }]) {
    assert.equal(validateRecoveryAdmission({ ...f.admission, ...patch }), false);
    await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, ...patch } as RecoveryAdmissionV1));
  }
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A competing admission decisions conflict even with independent coordinators", async t => {
  const f = await admissionFixture(t), changed = { ...f.admission, controller: { ...f.admission.controller, incarnation: "competitor" } };
  const settled = await Promise.allSettled([f.admissionCoordinator.admit(f.admission), register(f, changed).admit(changed)]);
  assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(settled.filter(r => r.status === "rejected").length, 1);
  assert.match((settled.find(r => r.status === "rejected") as PromiseRejectedResult).reason.message, /Conflicting/);
  assert.equal((await files(f.admissionDir)).length, 1);
  const g = await admissionFixture(t);
  const same = await Promise.all([g.admissionCoordinator.admit(g.admission), createRecoveryAdmissionCoordinator(g.admissionOptions).admit(clone(g.admission))]);
  assert.deepEqual(same[0], same[1]);
});

test("C7-A wrong confirmation, nonrevoked authority and changed exact bindings reject", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ confirmationRef: f.origin.ref }, { confirmationRef: { ...f.revoked.ref, fingerprint: hash } },
    { evaluator: { name: "another", version: "1" } }, { evaluator: { ...f.admission.binding.evaluator, version: "2" } },
    { packetRef: { ...f.admission.binding.packetRef, fingerprint: hash }, packetFingerprint: hash }]) {
    const a = rebind(f.admission, patch);
    await assert.rejects(register(f, a).admit(a));
  }
  await assert.rejects(register(f, f.admission, { packets: { get: async () => fixture().packet } }).admit(f.admission), /Packet/);
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, originAuthorityRef: { ...f.origin.ref, fingerprint: hash } }));
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, reconciliation: { ...f.admission.reconciliation,
    cessation: { ...f.admission.reconciliation.cessation, claimId: randomUUID() } } }), /provenance/);
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A requires separate current authorization and rechecks revocation at publication", async t => {
  const f = await admissionFixture(t);
  assert.throws(() => createRecoveryAdmissionCoordinator({ ...f.admissionOptions, projectsBaseDir: join(f.root, "wrong") }));
  await assert.rejects(f.admissionCoordinator.admit({ ...f.admission, controller: { ...f.admission.controller, id: "forged" } }), /Unauthorized/);
  await assert.rejects(register(f, f.admission, { isAuthorized: () => false }).admit(f.admission), /Unauthorized/);
  let allowed = true;
  await assert.rejects(register(f, f.admission, { isAuthorized: () => allowed, beforePublish: async () => { allowed = false; } }).admit(f.admission), /Unauthorized/);
  const revocationPath = join(f.authorityDir, `${f.revoked.ref.runId}.${f.revoked.ref.fingerprint.slice(7)}.json`);
  await assert.rejects(register(f, f.admission, { beforePublish: async () => { await rm(revocationPath); } }).admit(f.admission));
  assert.deepEqual(await files(f.admissionDir), []);
  assert.equal("admit" in f.coordinator, false);
  for (const name of ["confirm", "claimExecution", "execute", "retry", "publish", "publishTerminal", "promote", "setPolicy", "saveExperience"])
    assert.equal(name in f.admissionCoordinator, false);
  assert.equal("admit" in f.admissions, false);
});

for (const state of ["COMMITTED_OUTPUT_EXISTS", "COMMITTED_RESULT_EXISTS", "TERMINAL_EXISTS", "PUBLICATION_AMBIGUOUS", "EXTERNAL_EXECUTION_UNKNOWN", "HISTORY_UNKNOWN"] as const) {
  test(`C7-A reconciliation fails closed: ${state}`, async t => {
    const f = await admissionFixture(t), report = { ...f.admission.reconciliation, state };
    await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => report } }).admit(f.admission), /reconciliation/);
    assert.equal(validateRecoveryAdmission({ ...f.admission, reconciliation: report }), false);
  });
}

test("C7-A cessation, isolation, closed publication and inspector freshness are required", async t => {
  const f = await admissionFixture(t), r = f.admission.reconciliation;
  for (const patch of [{ publication: "unknown" }, { effects: "unknown" }, { ambiguities: "unknown" }, { rootBinding: "unknown" },
    { cessation: { ...r.cessation, coverage: "unknown" } }, { cessation: { ...r.cessation, status: "unknown" } },
    { runtime: { ...r.runtime, isolation: "unknown" } }, { runtime: { ...r.runtime, readiness: "unavailable" } },
    { publicationManifestFingerprint: learningFingerprint("changed") }]) {
    await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => ({ ...r, ...patch }) } }).admit(f.admission));
  }
  await assert.rejects(register(f, f.admission, { now: () => confirmedAt }).admit(f.admission), /clock/);
  let inspections = 0;
  await assert.rejects(register(f, f.admission, { reconciliation: { inspect: async () => ++inspections === 1 ? r : { ...r, state: "PUBLICATION_AMBIGUOUS" } } }).admit(f.admission));
  assert.deepEqual(await files(f.admissionDir), []);
});

test("C7-A policy generation, evaluator allowlist, budget and capacity limits fail closed", async t => {
  const f = await admissionFixture(t);
  for (const patch of [{ maxRecoveryAdmissions: 0 }, { retryableEvaluators: [] }, { perAdmission: amount(50) }, { perEvaluation: amount(50) }, { global: amount(50) }]) {
    const p = { ...f.admission.policy, ...patch }, a = { ...f.admission, policy: p, policyFingerprint: learningFingerprint(p) };
    await assert.rejects(register(f, a).admit(a));
  }
  const prev = recoveryAdmissionSnapshot(f.admission).ref;
  const childId = randomUUID();
  const next = rebind(f.admission, { generation: 2, previousAdmissionRef: prev, oldRunningRef: { ...f.admission.binding.oldRunningRef, runId: childId },
    confirmationRef: { ...f.revoked.ref, runId: childId } });
  await assert.rejects(register(f, { ...next, originAuthorityRef: { ...next.originAuthorityRef, runId: childId } }).admit({ ...next, originAuthorityRef: { ...next.originAuthorityRef, runId: childId } }), /generation/);
  for (const patch of [{ capacity: { runSlots: 0, authoritySlots: 1, leaseSlots: 1 } }, { evaluationBaseUsage: amount(0) }, { reservation: amount(201) }]) {
    const a = { ...f.admission, resources: { ...f.admission.resources, ...patch } };
    await assert.rejects(register(f, a).admit(a));
  }
});

test("C7-A counts immutable reservations across roots and rejects aggregate budget exhaustion", async t => {
  const f = await admissionFixture(t), g = await admissionFixture(t, f.root);
  const p = { ...f.admission.policy, global: amount(150) };
  const a = { ...f.admission, policy: p, policyFingerprint: learningFingerprint(p) };
  const b = { ...g.admission, policy: p, policyFingerprint: learningFingerprint(p) };
  await register(f, a).admit(a);
  await assert.rejects(register(g, b).admit(b), /budget/);
  assert.equal((await files(f.admissionDir)).length, 1);
});

test("C7-A known output/result surface blocks admission rather than salvaging", async t => {
  for (const namespace of ["evaluation-results-v1", "evaluation-outputs-v1"]) {
    const f = await admissionFixture(t), path = join(f.root, projectId, "learning-v1", namespace);
    await mkdir(path); await writeFile(join(path, "unresolved.json"), "{}");
    await assert.rejects(f.admissionCoordinator.admit(f.admission), /output surface/);
    assert.deepEqual(await files(f.admissionDir), []);
  }
});

for (const corruption of ["json", "canonical", "digest", "version", "binding", "unknown", "oversize", "filename", "missing-authority"]) {
  test(`C7-A corrupt/incomplete history fails closed: ${corruption}`, async t => {
    const f = await admissionFixture(t), committed = await f.admissionCoordinator.admit(f.admission);
    const path = join(f.admissionDir, (await files(f.admissionDir))[0]);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (corruption === "digest") value.fingerprint = hash;
    if (corruption === "version") value.schemaVersion = 2;
    if (corruption === "binding") value.admission.binding.opportunityKey = hash;
    if (corruption === "unknown") value.admission.extra = true;
    if (corruption === "filename") await writeFile(join(f.admissionDir, "unexpected.json"), "{}");
    else if (corruption === "missing-authority") await rm(join(f.authorityDir, `${f.origin.ref.runId}.${f.origin.ref.fingerprint.slice(7)}.json`));
    else await writeFile(path, corruption === "json" ? "{" : corruption === "oversize" ? " ".repeat(17000) : corruption === "canonical" ? JSON.stringify(value, null, 2) : canonicalJson(value));
    if (corruption === "missing-authority") assert.deepEqual(await f.admissions.get(committed.ref), committed); // history read is not execution authority
    else await assert.rejects(f.admissions.get(committed.ref));
    await assert.rejects(f.admissionCoordinator.admit(f.admission));
    assert.equal((await f.runs.getCurrent(projectId, f.created.runId)).status, "running");
  });
}

test("C7-A failures before publication and after durable link reconcile without duplicate permission", async t => {
  const f = await admissionFixture(t);
  await assert.rejects(register(f, f.admission, { beforePublish: async () => { throw new Error("before-link"); } }).admit(f.admission), /before-link/);
  assert.deepEqual(await files(f.admissionDir), []);
  await assert.rejects(register(f, f.admission, { afterPublish: async () => { throw new Error("lost-ack"); } }).admit(f.admission), /lost-ack/);
  const exact = recoveryAdmissionSnapshot(f.admission);
  assert.deepEqual(await f.admissions.get(exact.ref), exact);
  assert.deepEqual(await f.admissionCoordinator.admit(f.admission), exact);
  assert.equal((await files(f.admissionDir)).length, 1);
});

test("C7-A admission preserves old fencing, all source history and semantic namespaces; creates no successor", async t => {
  const f = await admissionFixture(t), learning = join(f.root, projectId, "learning-v1");
  const protectedDirs = ["evaluation-runs-v1", "execution-authorities-v1", "execution-leases-v1", "strategies", "policy", "trust", "decisions", "experience"];
  const snapshots = new Map<string, string>();
  for (const name of protectedDirs) {
    const path = join(learning, name); await mkdir(path, { recursive: true });
    if (!name.endsWith("-v1")) await writeFile(join(path, "sentinel.json"), "unchanged");
    for (const n of await files(path)) snapshots.set(join(path, n), await readFile(join(path, n), "utf8"));
  }
  await f.admissionCoordinator.admit(f.admission);
  for (const name of protectedDirs) {
    const path = join(learning, name);
    assert.deepEqual((await files(path)).sort(), [...snapshots.keys()].filter(k => k.startsWith(path + "/")).map(k => k.slice(path.length + 1)).sort());
  }
  for (const [path, bytes] of snapshots) assert.equal(await readFile(path, "utf8"), bytes);
  assert.deepEqual(await f.authorities.getCurrent(projectId, f.created.runId), f.revoked);
  await assert.rejects(f.claim.publishTerminal(transitionEvaluationRun(f.claim.running, "completed", admittedAt)), /epoch/);
  await assert.rejects(f.runs.publish(f.claim.running), /epoch/);
  await assert.rejects(f.store.heartbeat(f.lease.ref, heartbeatExecutionLease(f.lease.lease, admittedAt)), /epoch/);
  await assert.rejects(f.runs.claimExecution(f.created, admittedAt));
  assert.equal((await files(join(learning, "evaluation-runs-v1"))).length, 2);
});

const exec = promisify(execFile);
async function child(f: Awaited<ReturnType<typeof admissionFixture>>, a: RecoveryAdmissionV1, mode = "normal") {
  const script = `
    import { FileEvaluationRunStore } from './src/evaluation-run-store.ts';
    import { FileExecutionLeaseStore } from './src/evaluation-execution-lease-store.ts';
    import { createRecoveryAdmissionCoordinator } from './src/recovery-admission-store.ts';
    const a = JSON.parse(process.env.ADMISSION), packet = JSON.parse(process.env.PACKET), root = process.env.ROOT;
    const coordinator = createRecoveryAdmissionCoordinator({ projectsBaseDir: root, controller: a.controller, policy: a.policy,
      runs: new FileEvaluationRunStore({ projectsBaseDir: root, packets: { get: async () => packet } }),
      leases: new FileExecutionLeaseStore({ projectsBaseDir: root }), packets: { get: async () => packet },
      reconciliation: { inspect: async () => a.reconciliation }, resources: { inspect: async () => a.resources }, now: () => a.admittedAt, isAuthorized: () => true,
      ${mode === "pre" ? "beforePublish: async () => process.exit(0)," : mode === "post" ? "afterPublish: async () => process.exit(0)," : ""}
    });
    try { const s = await coordinator.admit(a); console.log(JSON.stringify({ ok: true, ref: s.ref })); }
    catch(e) { console.log(JSON.stringify({ ok: false, message: e.message })); }
  `;
  return exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: process.cwd(), env: { ...process.env, ROOT: f.root, ADMISSION: JSON.stringify(a), PACKET: JSON.stringify(f.packet) } });
}
test("C7-A separate-process identical and conflicting writers share one logical slot", async t => {
  const f = await admissionFixture(t);
  const identical = await Promise.all([child(f, f.admission), child(f, clone(f.admission))]);
  const results = identical.map(r => JSON.parse(r.stdout));
  assert.ok(results.every(r => r.ok)); assert.deepEqual(results[0].ref, results[1].ref);
  const g = await admissionFixture(t), competing = { ...g.admission, controller: { ...g.admission.controller, incarnation: "process-two" } };
  const different = (await Promise.all([child(g, g.admission), child(g, competing)])).map(r => JSON.parse(r.stdout));
  assert.equal(different.filter(r => r.ok).length, 1); assert.match(different.find(r => !r.ok).message, /Conflicting/);
  assert.equal((await files(g.admissionDir)).length, 1);
});
for (const mode of ["pre", "post"]) {
  test(`C7-A process death ${mode}-publication reclaims runtime locks and converges`, async t => {
    const f = await admissionFixture(t); await child(f, f.admission, mode);
    assert.equal((await files(f.admissionDir)).length, mode === "pre" ? 0 : 1);
    const s = await f.admissionCoordinator.admit(f.admission);
    assert.deepEqual(await f.admissions.get(s.ref), s); assert.equal((await files(f.admissionDir)).length, 1);
  });
}

test("C7-A detaches caller records and registration values before asynchronous publication", async t => {
  const f = await admissionFixture(t), input = clone(f.admission), configuredController = clone(input.controller), configuredPolicy = clone(input.policy);
  let release!: () => void, reached!: () => void;
  const paused = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { reached = r; });
  const coordinator = register(f, input, { controller: configuredController, policy: configuredPolicy, reconciliation: f.admissionOptions.reconciliation, resources: f.admissionOptions.resources,
    beforePublish: async () => { reached(); await paused; } });
  const pending = coordinator.admit(input); await ready;
  (input.controller as { id: string }).id = "changed";
  (input.resources.reservation as { tokens: number }).tokens = 0;
  (configuredController as { id: string }).id = "changed-registration";
  (configuredPolicy as { maxRecoveryAdmissions: number }).maxRecoveryAdmissions = 0;
  release();
  assert.deepEqual(await pending, recoveryAdmissionSnapshot(f.admission));
});
