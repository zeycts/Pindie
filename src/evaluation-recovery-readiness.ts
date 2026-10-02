import { canonicalJson, learningFingerprint, FINGERPRINT, PROJECT_ID, UUID_V4 } from "./learning-v1-contract.ts";
import { validateEvaluationRun, validateEvaluationRunRef, evaluationRunRef, type EvaluationRunV2, type EvaluationRunRef } from "./evaluation-run.ts";
import { validateEvaluationRef } from "./evaluation-contract.ts";
import { validateRecoveryAdmission, validateRecoveryAdmissionRef, recoveryAdmissionSnapshot, sameRecoveryValue, detachedRecoveryValue, type RecoveryAdmissionV1, type RecoveryAdmissionRef } from "./recovery-admission.ts";
import { validateRecoverySuccessorBinding, validateRecoverySuccessorBindingRef, recoverySuccessorBindingSnapshot, recoverySuccessorCreatedRun, assertRecoverySuccessorAdmission, type RecoverySuccessorBindingV1, type RecoverySuccessorBindingRef } from "./recovery-successor-binding.ts";

export const MAX_LOGICAL_EVALUATION_BINDING_BYTES = 8192;
export const MAX_EVALUATION_RECOVERY_PROFILE_BYTES = 4096;
export const MAX_EVALUATION_PUBLICATION_MANIFEST_BYTES = 16384;
export const MAX_RECOVERY_READINESS_BYTES = 16384;
export const MAX_RECOVERY_READINESS_FACT_BYTES = 8192;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, fields: string) => Object.keys(v).sort().join() === fields.split(",").sort().join();
const text = (v: unknown, max = 128): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const fp = (v: unknown): v is string => typeof v === "string" && FINGERPRINT.test(v);
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const freeze = <T>(v: T): T => { if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function detachReaderFact(v: unknown): unknown { try { return JSON.parse(canonicalJson(v)); } catch { return null; } }

/** Frozen C7-A/B identity derivation. Request/profile/policy facts are intentionally absent. */
export function deriveFrozenLogicalEvaluationKey(input: { projectId: string; rootCreatedRef: EvaluationRunRef; packetRef: RecoveryAdmissionV1["binding"]["packetRef"]; packetFingerprint: string; evaluator: { name: string; version: string } }): string {
  return learningFingerprint({ identityVersion: 1, projectId: input.projectId, rootCreatedRef: input.rootCreatedRef,
    packetRef: input.packetRef, packetFingerprint: input.packetFingerprint, evaluator: input.evaluator });
}

export interface LogicalEvaluationBindingV1 {
  readonly schemaVersion: 1; readonly projectId: string; readonly evaluationRequestKey: string; readonly requestFingerprint: string;
  readonly logicalEvaluationKey: string; readonly rootCreatedRef: EvaluationRunRef; readonly packetRef: RecoveryAdmissionV1["binding"]["packetRef"];
  readonly packetFingerprint: string; readonly evaluator: { readonly name: string; readonly version: string };
  readonly executionProfileFingerprint: string; readonly requestProvenance: { readonly source: string; readonly fingerprint: string };
  readonly policyProvenance: { readonly policyFingerprint: string; readonly authorizationFingerprint: string };
}
export function validateLogicalEvaluationBinding(v: unknown): v is LogicalEvaluationBindingV1 {
  try { return obj(v) && keys(v, "schemaVersion,projectId,evaluationRequestKey,requestFingerprint,logicalEvaluationKey,rootCreatedRef,packetRef,packetFingerprint,evaluator,executionProfileFingerprint,requestProvenance,policyProvenance") &&
    v.schemaVersion === 1 && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && text(v.evaluationRequestKey, 256) && fp(v.requestFingerprint) && fp(v.logicalEvaluationKey) &&
    validateEvaluationRunRef(v.rootCreatedRef) && v.rootCreatedRef.status === "created" && v.rootCreatedRef.projectId === v.projectId &&
    validateEvaluationRef(v.packetRef, "evaluation-packet") && v.packetRef.scope.projectId === v.projectId && fp(v.packetFingerprint) && v.packetFingerprint === v.packetRef.fingerprint &&
    obj(v.evaluator) && keys(v.evaluator, "name,version") && text(v.evaluator.name) && text(v.evaluator.version) && fp(v.executionProfileFingerprint) &&
    obj(v.requestProvenance) && keys(v.requestProvenance, "source,fingerprint") && text(v.requestProvenance.source, 64) && fp(v.requestProvenance.fingerprint) &&
    obj(v.policyProvenance) && keys(v.policyProvenance, "policyFingerprint,authorizationFingerprint") && fp(v.policyProvenance.policyFingerprint) && fp(v.policyProvenance.authorizationFingerprint) &&
    v.logicalEvaluationKey === deriveFrozenLogicalEvaluationKey(v as LogicalEvaluationBindingV1) && Buffer.byteLength(canonicalJson(v)) <= MAX_LOGICAL_EVALUATION_BINDING_BYTES;
  } catch { return false; }
}

export interface EvaluationRecoveryExecutionProfileV1 {
  readonly schemaVersion: 1; readonly profileId: string; readonly profileVersion: string; readonly fingerprint: string;
  /** Frozen C7-B operational contract identity, distinct from this profile fingerprint. */
  readonly executionContractFingerprint: string;
  readonly evaluator: { readonly name: string; readonly version: string }; readonly providerMode: "offline" | "controlled-provider-broker";
  readonly isolationClass: string; readonly publicationManifestId: string;
}
export function validateEvaluationRecoveryExecutionProfile(v: unknown): v is EvaluationRecoveryExecutionProfileV1 {
  try { if (!obj(v) || !keys(v, "schemaVersion,profileId,profileVersion,fingerprint,executionContractFingerprint,evaluator,providerMode,isolationClass,publicationManifestId") || v.schemaVersion !== 1 ||
    !text(v.profileId, 96) || !text(v.profileVersion, 32) || !fp(v.fingerprint) || !fp(v.executionContractFingerprint) || !obj(v.evaluator) || !keys(v.evaluator, "name,version") || !text(v.evaluator.name) || !text(v.evaluator.version) ||
    !["offline", "controlled-provider-broker"].includes(v.providerMode) || !text(v.isolationClass, 96) || !text(v.publicationManifestId, 96) || Buffer.byteLength(canonicalJson(v)) > MAX_EVALUATION_RECOVERY_PROFILE_BYTES) return false;
    const { fingerprint: _f, ...identity } = v; return v.fingerprint === learningFingerprint(identity);
  } catch { return false; }
}

export type RuntimeCessationState = "CEASED" | "ACTIVE" | "UNKNOWN";
export interface RuntimeCessationFactV1 {
  readonly schemaVersion: 1; readonly state: RuntimeCessationState; readonly predecessorRunningRef: EvaluationRunRef;
  readonly claimId: string; readonly authorityFingerprint: string; readonly runtimeHandleId: string; readonly runtimeIncarnation: string;
  readonly predecessorFence: "FENCED" | "OPEN" | "UNKNOWN";
  readonly observedAt: string; readonly frontierFingerprint: string;
  readonly coverage: { readonly children: "complete" | "incomplete" | "unknown"; readonly providers: "complete" | "incomplete" | "unknown"; readonly publications: "complete" | "incomplete" | "unknown" };
  readonly evidenceFingerprint: string;
}
export function validateRuntimeCessationFact(v: unknown): v is RuntimeCessationFactV1 {
  return obj(v) && keys(v, "schemaVersion,state,predecessorRunningRef,claimId,authorityFingerprint,runtimeHandleId,runtimeIncarnation,predecessorFence,observedAt,frontierFingerprint,coverage,evidenceFingerprint") && v.schemaVersion === 1 &&
    ["CEASED", "ACTIVE", "UNKNOWN"].includes(v.state) && validateEvaluationRunRef(v.predecessorRunningRef) && v.predecessorRunningRef.status === "running" &&
    typeof v.claimId === "string" && UUID_V4.test(v.claimId) && fp(v.authorityFingerprint) && text(v.runtimeHandleId) && text(v.runtimeIncarnation) && ["FENCED", "OPEN", "UNKNOWN"].includes(v.predecessorFence) && time(v.observedAt) && fp(v.frontierFingerprint) &&
    obj(v.coverage) && keys(v.coverage, "children,providers,publications") && [v.coverage.children, v.coverage.providers, v.coverage.publications].every(x => ["complete", "incomplete", "unknown"].includes(x)) && fp(v.evidenceFingerprint) &&
    (v.state !== "CEASED" || Object.values(v.coverage).every(x => x === "complete")) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES;
}
/** Current runtime inspection, not immutable profile proof. Must match each projection's observation time. */
export interface ExecutionIsolationFactV1 { readonly schemaVersion: 1; readonly state: "VERIFIED" | "UNAVAILABLE" | "UNKNOWN"; readonly profileFingerprint: string; readonly targetRunRef: EvaluationRunRef; readonly evaluator: { readonly name: string; readonly version: string }; readonly observedAt: string; readonly evidenceFingerprint: string }
export function validateExecutionIsolationFact(v: unknown): v is ExecutionIsolationFactV1 {
  try { return obj(v) && keys(v, "schemaVersion,state,profileFingerprint,targetRunRef,evaluator,observedAt,evidenceFingerprint") && v.schemaVersion === 1 && ["VERIFIED", "UNAVAILABLE", "UNKNOWN"].includes(v.state) && fp(v.profileFingerprint) &&
    validateEvaluationRunRef(v.targetRunRef) && obj(v.evaluator) && keys(v.evaluator, "name,version") && text(v.evaluator.name) && text(v.evaluator.version) && time(v.observedAt) && fp(v.evidenceFingerprint) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES; } catch { return false; }
}

export const EVALUATION_PUBLICATION_SURFACES = ["evaluation-run", "evaluation-output", "evaluation-result", "temporary-staging", "project-mutation", "semantic-learning-stores", "operational-receipts-logs", "provider-model-requests", "external-tools-apis"] as const;
export interface EvaluationPublicationSurfaceV1 { readonly surfaceId: typeof EVALUATION_PUBLICATION_SURFACES[number]; readonly version: 1; readonly applicability: "applicable" | "known-absent"; readonly writerClass: string; readonly destinationIdentity: string; readonly fenceRequired: boolean; readonly frontierReaderIdentity: string; readonly externalEffectCapability: boolean }
export interface EvaluationPublicationManifestV1 { readonly schemaVersion: 1; readonly manifestId: string; readonly surfaces: readonly EvaluationPublicationSurfaceV1[]; readonly fingerprint: string }
export function validateEvaluationPublicationManifest(v: unknown): v is EvaluationPublicationManifestV1 {
  try { if (!obj(v) || !keys(v, "schemaVersion,manifestId,surfaces,fingerprint") || v.schemaVersion !== 1 || !text(v.manifestId, 96) || !fp(v.fingerprint) || !Array.isArray(v.surfaces) || v.surfaces.length !== EVALUATION_PUBLICATION_SURFACES.length) return false;
    const seen = new Set<string>(); for (const s of v.surfaces) { if (!obj(s) || !keys(s, "surfaceId,version,applicability,writerClass,destinationIdentity,fenceRequired,frontierReaderIdentity,externalEffectCapability") || !EVALUATION_PUBLICATION_SURFACES.includes(s.surfaceId) || s.version !== 1 || !["applicable", "known-absent"].includes(s.applicability) || !text(s.writerClass, 64) || !text(s.destinationIdentity, 128) || typeof s.fenceRequired !== "boolean" || !text(s.frontierReaderIdentity, 128) || typeof s.externalEffectCapability !== "boolean" || seen.has(s.surfaceId)) return false; seen.add(s.surfaceId); }
    if (seen.size !== EVALUATION_PUBLICATION_SURFACES.length || Buffer.byteLength(canonicalJson(v)) > MAX_EVALUATION_PUBLICATION_MANIFEST_BYTES) return false;
    const { fingerprint, ...identity } = v; return fingerprint === learningFingerprint(identity);
  } catch { return false; }
}
export type PublicationFrontierState = "CLOSED" | "COMMITTED_OUTPUT" | "COMMITTED_RESULT" | "AMBIGUOUS" | "UNKNOWN";
export interface PublicationFrontierFactV1 { readonly schemaVersion: 1; readonly state: PublicationFrontierState; readonly manifestFingerprint: string; readonly logicalEvaluationKey: string; readonly predecessorAttemptRef: EvaluationRunRef; readonly observedAt: string; readonly frontierIdentity: string; readonly evidenceFingerprint: string }
export function validatePublicationFrontierFact(v: unknown): v is PublicationFrontierFactV1 { try { return obj(v) && keys(v, "schemaVersion,state,manifestFingerprint,logicalEvaluationKey,predecessorAttemptRef,observedAt,frontierIdentity,evidenceFingerprint") && v.schemaVersion === 1 && ["CLOSED", "COMMITTED_OUTPUT", "COMMITTED_RESULT", "AMBIGUOUS", "UNKNOWN"].includes(v.state) && fp(v.manifestFingerprint) && fp(v.logicalEvaluationKey) && validateEvaluationRunRef(v.predecessorAttemptRef) && time(v.observedAt) && text(v.frontierIdentity, 128) && fp(v.evidenceFingerprint) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES; } catch { return false; } }

export interface ResultProvenanceFactV1 { readonly schemaVersion: 1; readonly state: "NONE" | "COMMITTED_OUTPUT" | "COMMITTED_RESULT" | "AMBIGUOUS" | "UNKNOWN"; readonly logicalEvaluationKey: string; readonly runLineageFingerprint: string; readonly packetRef: RecoveryAdmissionV1["binding"]["packetRef"]; readonly evaluator: { readonly name: string; readonly version: string }; readonly frontierFingerprint: string; readonly evidenceFingerprint: string }
export function validateResultProvenanceFact(v: unknown): v is ResultProvenanceFactV1 { try { return obj(v) && keys(v, "schemaVersion,state,logicalEvaluationKey,runLineageFingerprint,packetRef,evaluator,frontierFingerprint,evidenceFingerprint") && v.schemaVersion === 1 && ["NONE", "COMMITTED_OUTPUT", "COMMITTED_RESULT", "AMBIGUOUS", "UNKNOWN"].includes(v.state) && fp(v.logicalEvaluationKey) && fp(v.runLineageFingerprint) && validateEvaluationRef(v.packetRef, "evaluation-packet") && obj(v.evaluator) && keys(v.evaluator, "name,version") && text(v.evaluator.name) && text(v.evaluator.version) && fp(v.frontierFingerprint) && fp(v.evidenceFingerprint) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES; } catch { return false; } }
export function recoveryReadinessLineageFingerprint(query: ReadinessQueryV1): string { return learningFingerprint({ schemaVersion: 1, targetRunRef: query.targetRunRef, admissionRef: query.admissionRef,
  successorBindingRef: query.successorBindingRef, logicalEvaluationKey: query.logicalEvaluationKey, opportunityKey: query.opportunityKey, predecessorRunningRef: query.predecessorRunningRef,
  rootCreatedRef: query.rootCreatedRef, packetRef: query.packetRef, evaluator: query.evaluator, executionContractFingerprint: query.executionContractFingerprint,
  executionProfileFingerprint: query.executionProfileFingerprint, generation: query.generation }); }

export interface RecoveryAuthorizationFactV1 { readonly schemaVersion: 1; readonly authorization: "VALID" | "REVOKED" | "UNKNOWN"; readonly policy: "PERMITS" | "DISALLOWS" | "UNKNOWN"; readonly registration: "MATCHED" | "UNSUPPORTED" | "UNKNOWN"; readonly providerRuntime: "AVAILABLE" | "NOT_REQUIRED" | "UNAVAILABLE" | "UNKNOWN"; readonly targetRunRef: EvaluationRunRef; readonly profileFingerprint: string; readonly observedAt: string; readonly evidenceFingerprint: string }
export function validateRecoveryAuthorizationFact(v: unknown): v is RecoveryAuthorizationFactV1 { try { return obj(v) && keys(v, "schemaVersion,authorization,policy,registration,providerRuntime,targetRunRef,profileFingerprint,observedAt,evidenceFingerprint") && v.schemaVersion === 1 && ["VALID", "REVOKED", "UNKNOWN"].includes(v.authorization) && ["PERMITS", "DISALLOWS", "UNKNOWN"].includes(v.policy) && ["MATCHED", "UNSUPPORTED", "UNKNOWN"].includes(v.registration) && ["AVAILABLE", "NOT_REQUIRED", "UNAVAILABLE", "UNKNOWN"].includes(v.providerRuntime) && validateEvaluationRunRef(v.targetRunRef) && fp(v.profileFingerprint) && time(v.observedAt) && fp(v.evidenceFingerprint) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES; } catch { return false; } }

export interface RecoveryAccountingFactV1 { readonly schemaVersion: 1; readonly logicalEvaluationKey: string; readonly opportunityKey: string; readonly artifactCapacity: "SUFFICIENT" | "EXHAUSTED" | "UNKNOWN"; readonly providerSpending: "SUFFICIENT" | "INSUFFICIENT" | "UNKNOWN"; readonly usageAccounting: "KNOWN" | "CONSERVATIVE" | "UNKNOWN"; readonly observedAt: string; readonly frontierFingerprint: string; readonly evidenceFingerprint: string }
export function validateRecoveryAccountingFact(v: unknown): v is RecoveryAccountingFactV1 { return obj(v) && keys(v, "schemaVersion,logicalEvaluationKey,opportunityKey,artifactCapacity,providerSpending,usageAccounting,observedAt,frontierFingerprint,evidenceFingerprint") && v.schemaVersion === 1 && fp(v.logicalEvaluationKey) && fp(v.opportunityKey) && ["SUFFICIENT", "EXHAUSTED", "UNKNOWN"].includes(v.artifactCapacity) && ["SUFFICIENT", "INSUFFICIENT", "UNKNOWN"].includes(v.providerSpending) && ["KNOWN", "CONSERVATIVE", "UNKNOWN"].includes(v.usageAccounting) && time(v.observedAt) && fp(v.frontierFingerprint) && fp(v.evidenceFingerprint) && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_READINESS_FACT_BYTES; }

export interface ReadinessLineageQueryV1 { readonly targetRunRef: EvaluationRunRef; readonly admissionRef: RecoveryAdmissionRef; readonly successorBindingRef: RecoverySuccessorBindingRef; readonly logicalEvaluationKey: string; readonly opportunityKey: string; readonly predecessorRunningRef: EvaluationRunRef; readonly rootCreatedRef: EvaluationRunRef; readonly packetRef: RecoveryAdmissionV1["binding"]["packetRef"]; readonly evaluator: { readonly name: string; readonly version: string }; readonly executionContractFingerprint: string; readonly generation: number }
export interface ReadinessQueryV1 extends ReadinessLineageQueryV1 { readonly executionProfileFingerprint: string }
export interface LogicalEvaluationBindingReader { read(query: ReadinessLineageQueryV1): Promise<unknown> }
export interface EvaluationRecoveryExecutionProfileReader { read(query: ReadinessQueryV1): Promise<unknown> }
export interface RuntimeCessationInspector { inspect(query: ReadinessQueryV1): Promise<unknown> }
export interface ExecutionIsolationInspector { inspect(query: ReadinessQueryV1): Promise<unknown> }
export interface PublicationSurfaceInspector { inspect(query: ReadinessQueryV1): Promise<unknown> }
export interface ResultProvenanceReader { read(query: ReadinessQueryV1, frontier: unknown): Promise<unknown> }
export interface RecoveryAccountingReader { read(query: ReadinessQueryV1): Promise<unknown> }
export interface RecoveryReadinessReaders { readonly binding: LogicalEvaluationBindingReader; readonly profile: EvaluationRecoveryExecutionProfileReader; readonly cessation: RuntimeCessationInspector; readonly isolation: ExecutionIsolationInspector; readonly publication: PublicationSurfaceInspector; readonly provenance: ResultProvenanceReader; readonly accounting: RecoveryAccountingReader }

export type RecoveryReadinessReason = "INVALID_LINEAGE" | "REQUEST_BINDING_UNKNOWN" | "EXECUTION_PROFILE_UNKNOWN" | "RUNTIME_CESSATION_UNKNOWN" | "RUNTIME_ACTIVE" | "PREDECESSOR_UNFENCED" | "ISOLATION_UNKNOWN" | "ISOLATION_UNAVAILABLE" | "PUBLICATION_MANIFEST_UNKNOWN" | "PUBLICATION_FRONTIER_UNKNOWN" | "PUBLICATION_AMBIGUOUS" | "OUTPUT_COMMITTED" | "RESULT_COMMITTED" | "PROVENANCE_UNKNOWN" | "AUTHORIZATION_REVOKED" | "AUTHORIZATION_UNKNOWN" | "POLICY_DISALLOWS" | "POLICY_UNKNOWN" | "PROFILE_UNSUPPORTED" | "REGISTRATION_UNKNOWN" | "PROVIDER_UNAVAILABLE" | "PROVIDER_STATUS_UNKNOWN" | "CAPACITY_EXHAUSTED" | "ACCOUNTING_INSUFFICIENT" | "ACCOUNTING_UNKNOWN";
export interface RecoveryExecutionReadinessV1 { readonly schemaVersion: 1; readonly state: "READY" | "BLOCKED" | "UNKNOWN"; readonly targetRunRef: EvaluationRunRef; readonly admissionRef: RecoveryAdmissionRef; readonly successorBindingRef: RecoverySuccessorBindingRef; readonly logicalEvaluationKey: string; readonly observedAt: string; readonly facts: { readonly binding: string | null; readonly profile: string | null; readonly cessation: string | null; readonly isolation: string | null; readonly manifest: string | null; readonly frontier: string | null; readonly provenance: string | null; readonly authorization: string | null; readonly accounting: string | null; readonly guards: Readonly<Record<string, "PASS" | "BLOCKED" | "UNKNOWN">> }; readonly reasons: readonly RecoveryReadinessReason[] }

function emptyResult(query: ReadinessLineageQueryV1, observedAt: string, reason: RecoveryReadinessReason): RecoveryExecutionReadinessV1 {
  return freeze({ schemaVersion: 1, state: "UNKNOWN", targetRunRef: query.targetRunRef, admissionRef: query.admissionRef, successorBindingRef: query.successorBindingRef, logicalEvaluationKey: query.logicalEvaluationKey, observedAt,
    facts: { binding: null, profile: null, cessation: null, isolation: null, manifest: null, frontier: null, provenance: null, authorization: null, accounting: null, guards: {} }, reasons: [reason] });
}
/** Deterministic read-only projection. This function has no publication, claim, or execution capability. */
export async function projectRecoveryExecutionReadiness(input: { admission: RecoveryAdmissionV1; binding: RecoverySuccessorBindingV1; run: EvaluationRunV2; readers: RecoveryReadinessReaders; observedAt: string }): Promise<RecoveryExecutionReadinessV1> {
  if (!time(input.observedAt) || !validateRecoveryAdmission(input.admission) || !validateRecoverySuccessorBinding(input.binding) || !validateEvaluationRun(input.run) || input.run.schemaVersion !== 2 || input.run.status !== "created") throw new Error("Invalid readiness projection input.");
  const admission = detachedRecoveryValue(input.admission), binding = detachedRecoveryValue(input.binding), run = detachedRecoveryValue(input.run);
  const ar = recoveryAdmissionSnapshot(admission).ref, br = recoverySuccessorBindingSnapshot(binding).ref, rr = evaluationRunRef(run);
  const lineageQuery: ReadinessLineageQueryV1 = freeze({ targetRunRef: rr, admissionRef: ar, successorBindingRef: br, logicalEvaluationKey: binding.logicalEvaluationKey, opportunityKey: binding.opportunityKey, predecessorRunningRef: binding.parentRunningRef, rootCreatedRef: binding.rootCreatedRef, packetRef: binding.packetRef, evaluator: binding.evaluator, executionContractFingerprint: binding.executionContractFingerprint, generation: binding.recoveryGeneration });
  let exactBinding = true; try { assertRecoverySuccessorAdmission(binding, admission); } catch { exactBinding = false; }
  if (!exactBinding || !sameRecoveryValue(binding.admissionRef, ar) || !sameRecoveryValue(run.recovery.admissionRef, ar) || !same(run, recoverySuccessorCreatedRun(binding))) return emptyResult(lineageQuery, input.observedAt, "INVALID_LINEAGE");
  const readers = input.readers;
  if (!readers || !readers.binding || !readers.profile || !readers.cessation || !readers.isolation || !readers.publication || !readers.provenance || !readers.accounting) throw new Error("Invalid readiness readers.");
  let bind: unknown = null; try { bind = detachReaderFact(await readers.binding.read(lineageQuery)); } catch { bind = null; }
  const validB = validateLogicalEvaluationBinding(bind) && bind.projectId === binding.projectId && bind.evaluationRequestKey.length > 0 && bind.logicalEvaluationKey === binding.logicalEvaluationKey && same(bind.rootCreatedRef, binding.rootCreatedRef) && same(bind.packetRef, binding.packetRef) && bind.packetFingerprint === binding.packetFingerprint && same(bind.evaluator, binding.evaluator);
  if (!validB) return emptyResult(lineageQuery, input.observedAt, "REQUEST_BINDING_UNKNOWN");
  const logicalBinding = bind as LogicalEvaluationBindingV1;
  const query: ReadinessQueryV1 = freeze({ ...lineageQuery, executionProfileFingerprint: logicalBinding.executionProfileFingerprint });
  const outcomes = await Promise.allSettled([Promise.resolve().then(() => readers.profile.read(query)), Promise.resolve().then(() => readers.cessation.inspect(query)), Promise.resolve().then(() => readers.isolation.inspect(query)), Promise.resolve().then(() => readers.publication.inspect(query)), Promise.resolve().then(() => readers.accounting.read(query))]);
  const get = (i: number) => outcomes[i].status === "fulfilled" ? detachReaderFact(outcomes[i].value) : null;
  const profile = get(0), cessation = get(1), isolation = get(2), publicationRaw = get(3), accounting = get(4);
  const publicationFacts = obj(publicationRaw) ? publicationRaw : null;
  const manifest = publicationFacts ? publicationFacts.manifest : null, frontier = publicationFacts ? publicationFacts.frontier : null;
  let provenance: unknown = null;
  if (validatePublicationFrontierFact(frontier)) { try { provenance = detachReaderFact(await readers.provenance.read(query, frontier)); } catch { provenance = null; } }
  const validProfile = validateEvaluationRecoveryExecutionProfile(profile) && profile.fingerprint === logicalBinding.executionProfileFingerprint && profile.executionContractFingerprint === binding.executionContractFingerprint && same(profile.evaluator, run.evaluator);
  const validC = validateRuntimeCessationFact(cessation) && cessation.observedAt === input.observedAt && same(cessation.predecessorRunningRef, binding.parentRunningRef) && cessation.claimId === admission.reconciliation.cessation.claimId && cessation.authorityFingerprint === admission.originAuthorityRef.fingerprint;
  const validI = validateExecutionIsolationFact(isolation) && isolation.observedAt === input.observedAt && isolation.profileFingerprint === (validProfile ? profile.fingerprint : "") && same(isolation.targetRunRef, rr) && same(isolation.evaluator, binding.evaluator);
  const validM = validateEvaluationPublicationManifest(manifest) && validProfile && manifest.manifestId === profile.publicationManifestId;
  const validF = validatePublicationFrontierFact(frontier) && frontier.observedAt === input.observedAt && frontier.manifestFingerprint === manifest?.fingerprint && frontier.logicalEvaluationKey === binding.logicalEvaluationKey && same(frontier.predecessorAttemptRef, binding.parentRunningRef);
  const validP = validateResultProvenanceFact(provenance) && provenance.logicalEvaluationKey === binding.logicalEvaluationKey && provenance.runLineageFingerprint === recoveryReadinessLineageFingerprint(query) && same(provenance.packetRef, binding.packetRef) && same(provenance.evaluator, binding.evaluator) && validF && provenance.frontierFingerprint === frontier.evidenceFingerprint;
  const validA = validateRecoveryAuthorizationFact(publicationFacts?.authorization) && validProfile && publicationFacts.authorization.observedAt === input.observedAt && same(publicationFacts.authorization.targetRunRef, rr) && publicationFacts.authorization.profileFingerprint === profile.fingerprint;
  const validR = validateRecoveryAccountingFact(accounting) && accounting.observedAt === input.observedAt && accounting.logicalEvaluationKey === binding.logicalEvaluationKey && accounting.opportunityKey === binding.opportunityKey;
  const reasons = new Set<RecoveryReadinessReason>(); const guards: Record<string, "PASS" | "BLOCKED" | "UNKNOWN"> = {};
  const add = (name: string, condition: boolean, reason: RecoveryReadinessReason) => { if (condition) guards[name] = "PASS"; else { guards[name] = "UNKNOWN"; reasons.add(reason); } };
  add("requestBinding", validB, "REQUEST_BINDING_UNKNOWN");
  add("executionProfile", validProfile, "EXECUTION_PROFILE_UNKNOWN");
  if (!validC) add("runtimeCessation", false, "RUNTIME_CESSATION_UNKNOWN"); else if (cessation.state === "ACTIVE") { guards.runtimeCessation = "BLOCKED"; reasons.add("RUNTIME_ACTIVE"); } else if (cessation.predecessorFence === "OPEN") { guards.runtimeCessation = "BLOCKED"; reasons.add("PREDECESSOR_UNFENCED"); } else if (cessation.state !== "CEASED" || cessation.predecessorFence !== "FENCED") add("runtimeCessation", false, "RUNTIME_CESSATION_UNKNOWN"); else add("runtimeCessation", true, "RUNTIME_CESSATION_UNKNOWN");
  if (!validI) add("isolation", false, "ISOLATION_UNKNOWN"); else if (isolation.state === "UNAVAILABLE") { guards.isolation = "BLOCKED"; reasons.add("ISOLATION_UNAVAILABLE"); } else if (isolation.state !== "VERIFIED") add("isolation", false, "ISOLATION_UNKNOWN"); else add("isolation", true, "ISOLATION_UNKNOWN");
  add("publicationManifest", validM, "PUBLICATION_MANIFEST_UNKNOWN");
  if (!validF) add("publicationFrontier", false, "PUBLICATION_FRONTIER_UNKNOWN"); else if (frontier.state === "AMBIGUOUS" || frontier.state === "UNKNOWN") { guards.publicationFrontier = "UNKNOWN"; reasons.add(frontier.state === "AMBIGUOUS" ? "PUBLICATION_AMBIGUOUS" : "PUBLICATION_FRONTIER_UNKNOWN"); } else if (frontier.state !== "CLOSED") { guards.publicationFrontier = "BLOCKED"; reasons.add(frontier.state === "COMMITTED_RESULT" ? "RESULT_COMMITTED" : "OUTPUT_COMMITTED"); } else add("publicationFrontier", true, "PUBLICATION_FRONTIER_UNKNOWN");
  const checkedProvenance = provenance as ResultProvenanceFactV1;
  if (!validP) add("provenance", false, "PROVENANCE_UNKNOWN"); else if (checkedProvenance.state === "COMMITTED_RESULT") { guards.provenance = "BLOCKED"; reasons.add("RESULT_COMMITTED"); } else if (checkedProvenance.state === "COMMITTED_OUTPUT") { guards.provenance = "BLOCKED"; reasons.add("OUTPUT_COMMITTED"); } else if (checkedProvenance.state !== "NONE") add("provenance", false, "PROVENANCE_UNKNOWN"); else add("provenance", true, "PROVENANCE_UNKNOWN");
  if (!validA) add("authorizationPolicy", false, "AUTHORIZATION_UNKNOWN"); else {
    const a = publicationFacts!.authorization as RecoveryAuthorizationFactV1; guards.authorizationPolicy = "PASS";
    if (a.authorization === "REVOKED") { guards.authorizationPolicy = "BLOCKED"; reasons.add("AUTHORIZATION_REVOKED"); }
    else if (a.policy === "DISALLOWS") { guards.authorizationPolicy = "BLOCKED"; reasons.add("POLICY_DISALLOWS"); }
    else if (a.registration === "UNSUPPORTED") { guards.authorizationPolicy = "BLOCKED"; reasons.add("PROFILE_UNSUPPORTED"); }
    else if (profile.providerMode === "controlled-provider-broker" && a.providerRuntime === "UNAVAILABLE") { guards.authorizationPolicy = "BLOCKED"; reasons.add("PROVIDER_UNAVAILABLE"); }
    else { if (a.authorization !== "VALID") { guards.authorizationPolicy = "UNKNOWN"; reasons.add("AUTHORIZATION_UNKNOWN"); } if (a.policy !== "PERMITS") { guards.authorizationPolicy = "UNKNOWN"; reasons.add("POLICY_UNKNOWN"); } if (a.registration !== "MATCHED") { guards.authorizationPolicy = "UNKNOWN"; reasons.add("REGISTRATION_UNKNOWN"); }
      const providerCoherent = profile.providerMode === "offline" ? a.providerRuntime === "NOT_REQUIRED" : a.providerRuntime === "AVAILABLE";
      if (!providerCoherent) { guards.authorizationPolicy = "UNKNOWN"; reasons.add("PROVIDER_STATUS_UNKNOWN"); } }
  }
  if (!validR) add("accounting", false, "ACCOUNTING_UNKNOWN"); else {
    const a = accounting; guards.accounting = "PASS";
    if (a.artifactCapacity === "EXHAUSTED") { guards.accounting = "BLOCKED"; reasons.add("CAPACITY_EXHAUSTED"); }
    else if (a.providerSpending === "INSUFFICIENT") { guards.accounting = "BLOCKED"; reasons.add("ACCOUNTING_INSUFFICIENT"); }
    else if (a.artifactCapacity !== "SUFFICIENT" || a.providerSpending !== "SUFFICIENT" || a.usageAccounting === "UNKNOWN") { guards.accounting = "UNKNOWN"; reasons.add("ACCOUNTING_UNKNOWN"); }
  }
  const orderedReasons = [...reasons].sort(); const state = Object.values(guards).includes("BLOCKED") ? "BLOCKED" : orderedReasons.length ? "UNKNOWN" : "READY";
  const result = freeze({ schemaVersion: 1 as const, state, targetRunRef: rr, admissionRef: ar, successorBindingRef: br, logicalEvaluationKey: binding.logicalEvaluationKey, observedAt: input.observedAt,
    facts: { binding: validB ? learningFingerprint(bind) : null, profile: validProfile ? learningFingerprint(profile) : null, cessation: validC ? learningFingerprint(cessation) : null, isolation: validI ? learningFingerprint(isolation) : null, manifest: validM ? manifest.fingerprint : null, frontier: validF ? learningFingerprint(frontier) : null, provenance: validP ? learningFingerprint(provenance) : null, authorization: validA ? learningFingerprint(publicationFacts!.authorization) : null, accounting: validR ? learningFingerprint(accounting) : null, guards }, reasons: orderedReasons });
  if (!validateRecoveryExecutionReadiness(result)) throw new Error("Invalid readiness projection result.");
  return result;
}
export function validateRecoveryExecutionReadiness(v: unknown): v is RecoveryExecutionReadinessV1 {
  try {
    const reasonCodes = ["INVALID_LINEAGE","REQUEST_BINDING_UNKNOWN","EXECUTION_PROFILE_UNKNOWN","RUNTIME_CESSATION_UNKNOWN","RUNTIME_ACTIVE","PREDECESSOR_UNFENCED","ISOLATION_UNKNOWN","ISOLATION_UNAVAILABLE","PUBLICATION_MANIFEST_UNKNOWN","PUBLICATION_FRONTIER_UNKNOWN","PUBLICATION_AMBIGUOUS","OUTPUT_COMMITTED","RESULT_COMMITTED","PROVENANCE_UNKNOWN","AUTHORIZATION_REVOKED","AUTHORIZATION_UNKNOWN","POLICY_DISALLOWS","POLICY_UNKNOWN","PROFILE_UNSUPPORTED","REGISTRATION_UNKNOWN","PROVIDER_UNAVAILABLE","PROVIDER_STATUS_UNKNOWN","CAPACITY_EXHAUSTED","ACCOUNTING_INSUFFICIENT","ACCOUNTING_UNKNOWN"];
    if (!obj(v) || !keys(v, "schemaVersion,state,targetRunRef,admissionRef,successorBindingRef,logicalEvaluationKey,observedAt,facts,reasons") || v.schemaVersion !== 1 || !["READY", "BLOCKED", "UNKNOWN"].includes(v.state) || !validateEvaluationRunRef(v.targetRunRef) || v.targetRunRef.status !== "created" || !validateRecoveryAdmissionRef(v.admissionRef) || !validateRecoverySuccessorBindingRef(v.successorBindingRef) || !fp(v.logicalEvaluationKey) || !time(v.observedAt) || !obj(v.facts) || !keys(v.facts, "binding,profile,cessation,isolation,manifest,frontier,provenance,authorization,accounting,guards") || !obj(v.facts.guards) || Object.keys(v.facts.guards).length > 16 || Object.values(v.facts.guards).some(x => !["PASS", "BLOCKED", "UNKNOWN"].includes(x as string)) || !Array.isArray(v.reasons) || v.reasons.length > 32 || v.reasons.some(x => typeof x !== "string" || !reasonCodes.includes(x)) || new Set(v.reasons).size !== v.reasons.length || Buffer.byteLength(canonicalJson(v)) > MAX_RECOVERY_READINESS_BYTES) return false;
    const classifications = Object.values(v.facts.guards);
    if (v.state === "READY") return v.reasons.length === 0 && classifications.length > 0 && classifications.every(x => x === "PASS") && [v.facts.binding, v.facts.profile, v.facts.cessation, v.facts.isolation, v.facts.manifest, v.facts.frontier, v.facts.provenance, v.facts.authorization, v.facts.accounting].every(x => fp(x));
    if (v.state === "BLOCKED") return v.reasons.length > 0 && classifications.includes("BLOCKED");
    return v.reasons.length > 0 && (classifications.includes("UNKNOWN") || v.reasons.includes("INVALID_LINEAGE"));
  } catch { return false; }
}
