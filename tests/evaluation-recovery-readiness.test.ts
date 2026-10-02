import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { learningFingerprint } from "../src/learning-v1-contract.ts";
import { admissionFixture } from "./recovery-fixture.ts";
import { createRecoverySuccessorBinding, recoverySuccessorCreatedRun } from "../src/recovery-successor-binding.ts";
import { EVALUATION_PUBLICATION_SURFACES, deriveFrozenLogicalEvaluationKey, projectRecoveryExecutionReadiness,
  validateEvaluationPublicationManifest, validateEvaluationRecoveryExecutionProfile, validateExecutionIsolationFact,
  recoveryReadinessLineageFingerprint, validateLogicalEvaluationBinding, validatePublicationFrontierFact, validateRecoveryAccountingFact, validateRuntimeCessationFact,
  type RecoveryReadinessReaders } from "../src/evaluation-recovery-readiness.ts";

const at = "2026-01-01T00:05:00.000Z";
const fp = (v: string) => learningFingerprint(v);

async function readinessFixture(t: Parameters<typeof admissionFixture>[0]) {
  const f = await admissionFixture(t), binding = createRecoverySuccessorBinding(f.admission, randomUUID(), at), run = recoverySuccessorCreatedRun(binding);
  const profileFingerprint = binding.executionContractFingerprint;
  const profileIdentity = { schemaVersion: 1 as const, profileId: "offline-test", profileVersion: "1", evaluator: binding.evaluator,
    providerMode: "offline" as const, isolationClass: "isolated-worker-v1", publicationManifestId: "manifest-test" };
  const profile = { ...profileIdentity, fingerprint: learningFingerprint(profileIdentity) };
  const surfaces = EVALUATION_PUBLICATION_SURFACES.map(surfaceId => ({ surfaceId, version: 1 as const, applicability: "known-absent" as const,
    writerClass: "none", destinationIdentity: `absent:${surfaceId}`, fenceRequired: false, frontierReaderIdentity: `reader:${surfaceId}`, externalEffectCapability: false }));
  const manifestIdentity = { schemaVersion: 1 as const, manifestId: "manifest-test", surfaces };
  const manifest = { ...manifestIdentity, fingerprint: learningFingerprint(manifestIdentity) };
  const frontier = { schemaVersion: 1 as const, state: "CLOSED" as const, manifestFingerprint: manifest.fingerprint, logicalEvaluationKey: binding.logicalEvaluationKey,
    predecessorAttemptRef: binding.parentRunningRef, observedAt: at, frontierIdentity: "frontier-1", evidenceFingerprint: fp("frontier") };
  const query = { targetRunRef: (await import("../src/evaluation-run.ts")).evaluationRunRef(run), admissionRef: (await import("../src/recovery-admission.ts")).recoveryAdmissionSnapshot(f.admission).ref,
    successorBindingRef: (await import("../src/recovery-successor-binding.ts")).recoverySuccessorBindingSnapshot(binding).ref, logicalEvaluationKey: binding.logicalEvaluationKey,
    opportunityKey: binding.opportunityKey, predecessorRunningRef: binding.parentRunningRef, rootCreatedRef: binding.rootCreatedRef, packetRef: binding.packetRef,
    evaluator: binding.evaluator, profileFingerprint, generation: binding.recoveryGeneration };
  const facts = {
    binding: { schemaVersion: 1 as const, projectId: binding.projectId, evaluationRequestKey: "request-1", requestFingerprint: fp("request"), logicalEvaluationKey: binding.logicalEvaluationKey,
      rootCreatedRef: binding.rootCreatedRef, packetRef: binding.packetRef, packetFingerprint: binding.packetFingerprint, evaluator: binding.evaluator,
      executionProfileFingerprint: profileFingerprint, requestProvenance: { source: "test-request", fingerprint: fp("request-source") },
      policyProvenance: { policyFingerprint: f.admission.policyFingerprint, authorizationFingerprint: f.admission.controller.authorizationFingerprint } },
    cessation: { schemaVersion: 1 as const, state: "CEASED" as const, predecessorRunningRef: binding.parentRunningRef, claimId: f.admission.reconciliation.cessation.claimId, authorityFingerprint: f.admission.originAuthorityRef.fingerprint,
      runtimeHandleId: "handle-1", runtimeIncarnation: "incarnation-1", predecessorFence: "FENCED" as const, observedAt: at, frontierFingerprint: fp("runtime-frontier"),
      coverage: { children: "complete" as const, providers: "complete" as const, publications: "complete" as const }, evidenceFingerprint: fp("cessation") },
    isolation: { schemaVersion: 1 as const, state: "VERIFIED" as const, profileFingerprint, targetRunRef: query.targetRunRef, evaluator: binding.evaluator, evidenceFingerprint: fp("isolation") },
    authorization: { schemaVersion: 1 as const, authorization: "VALID" as const, policy: "PERMITS" as const, registration: "MATCHED" as const,
      providerRuntime: "AVAILABLE" as const, targetRunRef: query.targetRunRef, profileFingerprint, observedAt: at, evidenceFingerprint: fp("authorization") },
    accounting: { schemaVersion: 1 as const, logicalEvaluationKey: binding.logicalEvaluationKey, opportunityKey: binding.opportunityKey, artifactCapacity: "SUFFICIENT" as const,
      providerSpending: "SUFFICIENT" as const, usageAccounting: "CONSERVATIVE" as const, observedAt: at, frontierFingerprint: fp("accounting-frontier"), evidenceFingerprint: fp("accounting") },
  };
  const readers: RecoveryReadinessReaders = {
    binding: { read: async () => facts.binding }, cessation: { inspect: async () => facts.cessation }, isolation: { inspect: async () => facts.isolation },
    publication: { inspect: async () => ({ manifest, frontier, authorization: facts.authorization }) },
    provenance: { read: async q => ({ schemaVersion: 1, state: "NONE", logicalEvaluationKey: binding.logicalEvaluationKey, runLineageFingerprint: recoveryReadinessLineageFingerprint(q),
      packetRef: binding.packetRef, evaluator: binding.evaluator, frontierFingerprint: frontier.evidenceFingerprint, evidenceFingerprint: fp("provenance") }) },
    accounting: { read: async () => facts.accounting },
  };
  return { f, binding, run, readers, facts, profile, manifest, frontier };
}

test("strict readiness contracts preserve the frozen logical key and reject malformed or oversized facts", async t => {
  const x = await readinessFixture(t), b = x.binding;
  assert.equal(deriveFrozenLogicalEvaluationKey({ projectId: b.projectId, rootCreatedRef: b.rootCreatedRef, packetRef: b.packetRef,
    packetFingerprint: b.packetFingerprint, evaluator: b.evaluator }), b.logicalEvaluationKey);
  const logical = x.facts.binding;
  assert.ok(validateLogicalEvaluationBinding(logical));
  assert.equal(validateLogicalEvaluationBinding({ ...logical, extra: true }), false);
  assert.equal(validateLogicalEvaluationBinding({ ...logical, logicalEvaluationKey: fp("profile cannot redefine key") }), false);
  assert.ok(validateLogicalEvaluationBinding({ ...logical, executionProfileFingerprint: fp("different profile") }));
  assert.equal(deriveFrozenLogicalEvaluationKey({ projectId: b.projectId, rootCreatedRef: b.rootCreatedRef, packetRef: b.packetRef,
    packetFingerprint: b.packetFingerprint, evaluator: b.evaluator }), b.logicalEvaluationKey);
  assert.ok(validateEvaluationRecoveryExecutionProfile(x.profile));
  assert.equal(validateEvaluationRecoveryExecutionProfile({ ...x.profile, extra: 1 }), false);
  assert.ok(validateRuntimeCessationFact(x.facts.cessation));
  assert.equal(validateRuntimeCessationFact({ ...x.facts.cessation, state: "CEASED", coverage: { children: "unknown", providers: "complete", publications: "complete" } }), false);
  assert.ok(validateExecutionIsolationFact(x.facts.isolation));
  assert.equal(validateExecutionIsolationFact({ ...x.facts.isolation, extra: true }), false);
  assert.ok(validateEvaluationPublicationManifest(x.manifest));
  assert.equal(validateEvaluationPublicationManifest({ ...x.manifest, surfaces: x.manifest.surfaces.slice(1) }), false);
  assert.equal(validateEvaluationPublicationManifest({ ...x.manifest, surfaces: [{ ...x.manifest.surfaces[0], surfaceId: "unknown" }] }), false);
  assert.ok(validatePublicationFrontierFact(x.frontier));
  assert.equal(validatePublicationFrontierFact({ ...x.frontier, extra: true }), false);
  assert.ok(validateRecoveryAccountingFact(x.facts.accounting));
  assert.equal(validateRecoveryAccountingFact({ ...x.facts.accounting, artifactCapacity: "zero" }), false);
});

test("complete exact positive facts project READY and return detached deeply frozen output", async t => {
  const x = await readinessFixture(t), input = { admission: x.f.admission, binding: x.binding, run: x.run, readers: x.readers, observedAt: at };
  const bindingFactFingerprint = learningFingerprint(x.facts.binding);
  const projection = await projectRecoveryExecutionReadiness(input);
  assert.equal(projection.state, "READY", JSON.stringify(projection)); assert.deepEqual(projection.reasons, []);
  const again = await projectRecoveryExecutionReadiness(input); assert.deepEqual(projection, again);
  assert.ok(Object.isFrozen(projection)); assert.ok(Object.isFrozen(projection.facts)); assert.ok(Object.isFrozen(projection.facts.guards));
  assert.deepEqual(await projectRecoveryExecutionReadiness({ ...input, readers: { ...x.readers, accounting: { read: async () => ({ ...x.facts.accounting }) } } }), projection);
  (x.facts.binding as any).evaluationRequestKey = "mutated";
  assert.equal(projection.facts.binding, bindingFactFingerprint);
});

test("known prohibitions dominate unknowns; absent facts and reader failures stay UNKNOWN", async t => {
  const x = await readinessFixture(t), input = { admission: x.f.admission, binding: x.binding, run: x.run, readers: x.readers, observedAt: at };
  const disallowed: RecoveryReadinessReaders = { ...x.readers, publication: { inspect: async () => ({ manifest: x.manifest, frontier: x.frontier,
    authorization: { ...x.facts.authorization, policy: "DISALLOWS" } }) }, accounting: { read: async () => { throw new Error("private raw failure"); } } };
  const blocked = await projectRecoveryExecutionReadiness({ ...input, readers: disallowed });
  assert.equal(blocked.state, "BLOCKED"); assert.ok(blocked.reasons.includes("POLICY_DISALLOWS")); assert.ok(!JSON.stringify(blocked).includes("private raw failure"));
  const committed: RecoveryReadinessReaders = { ...x.readers, provenance: { read: async q => ({ schemaVersion: 1, state: "COMMITTED_RESULT", logicalEvaluationKey: x.binding.logicalEvaluationKey,
    runLineageFingerprint: recoveryReadinessLineageFingerprint(q), packetRef: x.binding.packetRef, evaluator: x.binding.evaluator, frontierFingerprint: x.frontier.evidenceFingerprint, evidenceFingerprint: fp("result") }) } };
  const committedProjection = await projectRecoveryExecutionReadiness({ ...input, readers: committed });
  assert.equal(committedProjection.state, "BLOCKED"); assert.ok(committedProjection.reasons.includes("RESULT_COMMITTED"));
  const unknown = await projectRecoveryExecutionReadiness({ ...input, readers: { ...x.readers, binding: { read: async () => { throw new Error("no reader"); } } } });
  assert.equal(unknown.state, "UNKNOWN"); assert.ok(unknown.reasons.includes("REQUEST_BINDING_UNKNOWN"));
  const noProductionFacts = await projectRecoveryExecutionReadiness({ ...input, readers: { binding: { read: async () => null }, cessation: { inspect: async () => null }, isolation: { inspect: async () => null }, publication: { inspect: async () => null }, provenance: { read: async () => null }, accounting: { read: async () => null } } });
  assert.equal(noProductionFacts.state, "UNKNOWN");
});

test("readiness distinguishes known prohibitions from missing or ambiguous required facts", async t => {
  const x = await readinessFixture(t), input = { admission: x.f.admission, binding: x.binding, run: x.run, readers: x.readers, observedAt: at };
  const cases: Array<{ name: string; readers: RecoveryReadinessReaders; state: "BLOCKED" | "UNKNOWN"; reason: string }> = [
    { name: "revoked authorization", readers: { ...x.readers, publication: { inspect: async () => ({ manifest: x.manifest, frontier: x.frontier, authorization: { ...x.facts.authorization, authorization: "REVOKED" } }) } }, state: "BLOCKED", reason: "AUTHORIZATION_REVOKED" },
    { name: "exhausted artifact capacity", readers: { ...x.readers, accounting: { read: async () => ({ ...x.facts.accounting, artifactCapacity: "EXHAUSTED" }) } }, state: "BLOCKED", reason: "CAPACITY_EXHAUSTED" },
    { name: "known insufficient spending", readers: { ...x.readers, accounting: { read: async () => ({ ...x.facts.accounting, providerSpending: "INSUFFICIENT" }) } }, state: "BLOCKED", reason: "ACCOUNTING_INSUFFICIENT" },
    { name: "unfenced predecessor", readers: { ...x.readers, cessation: { inspect: async () => ({ ...x.facts.cessation, predecessorFence: "OPEN" }) } }, state: "BLOCKED", reason: "PREDECESSOR_UNFENCED" },
    { name: "runtime cessation unknown", readers: { ...x.readers, cessation: { inspect: async () => ({ ...x.facts.cessation, state: "UNKNOWN", coverage: { children: "unknown", providers: "unknown", publications: "unknown" } }) } }, state: "UNKNOWN", reason: "RUNTIME_CESSATION_UNKNOWN" },
    { name: "isolation unknown", readers: { ...x.readers, isolation: { inspect: async () => ({ ...x.facts.isolation, state: "UNKNOWN" }) } }, state: "UNKNOWN", reason: "ISOLATION_UNKNOWN" },
    { name: "ambiguous publication", readers: { ...x.readers, publication: { inspect: async () => ({ manifest: x.manifest, frontier: { ...x.frontier, state: "AMBIGUOUS" }, authorization: x.facts.authorization }) } }, state: "UNKNOWN", reason: "PUBLICATION_AMBIGUOUS" },
    { name: "provider status unknown", readers: { ...x.readers, publication: { inspect: async () => ({ manifest: x.manifest, frontier: x.frontier, authorization: { ...x.facts.authorization, providerRuntime: "UNKNOWN" } }) } }, state: "UNKNOWN", reason: "PROVIDER_STATUS_UNKNOWN" },
    { name: "accounting unavailable", readers: { ...x.readers, accounting: { read: async () => { throw new Error("accounting offline"); } } }, state: "UNKNOWN", reason: "ACCOUNTING_UNKNOWN" },
  ];
  for (const c of cases) { const projected = await projectRecoveryExecutionReadiness({ ...input, readers: c.readers }); assert.equal(projected.state, c.state, c.name); assert.ok(projected.reasons.includes(c.reason as any), c.name); }
});

test("lineage mismatch fails before any production fact reader is consulted", async t => {
  const x = await readinessFixture(t); let reads = 0;
  const readers = Object.fromEntries(Object.entries(x.readers).map(([name, reader]) => [name, Object.fromEntries(Object.entries(reader).map(([method]) => [method, async () => { reads++; throw new Error("unexpected read"); }]))])) as unknown as RecoveryReadinessReaders;
  const bad = { ...x.run, logicalEvaluationKey: fp("wrong key") };
  await assert.rejects(projectRecoveryExecutionReadiness({ admission: x.f.admission, binding: x.binding, run: bad, readers, observedAt: at }), /Invalid readiness projection input/);
  assert.equal(reads, 0);
});
