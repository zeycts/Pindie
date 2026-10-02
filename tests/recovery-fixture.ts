import { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
export const projectId = "a".repeat(64), scope = { kind: "project" as const, projectId }, hash = `sha256:${"b".repeat(64)}`;
const start = "2026-01-01T00:00:01.000Z", end = "2026-01-01T00:00:02.000Z", later = "2026-01-01T00:00:03.000Z";
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });
export function fixture() {
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
import { type StaleConfirmationV1, type ExecutionCessationEvidenceV1 } from "../src/evaluation-stale-confirmation.ts";
export const confirmedAt = "2026-01-01T00:01:00.000Z";
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
export const clone = <T>(v: T): T => JSON.parse(canonicalJson(v));

import { createRecoveryAdmissionBinding, recoveryAdmissionSnapshot, type RecoveryAdmissionV1, type RecoveryReconciliationV1, type RecoveryResourcesV1, type EvaluationRecoveryPolicyV1 } from "../src/recovery-admission.ts";
import { createRecoveryAdmissionCoordinator, FileRecoveryAdmissionStore } from "../src/recovery-admission-store.ts";
export const admittedAt = "2026-01-01T00:02:00.000Z";
export const amount = (n: number) => ({ tokens: n, costMicros: n, durationMs: n });
export async function admissionFixture(t: TestContext, root?: string) {
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
