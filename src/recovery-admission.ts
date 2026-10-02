import { canonicalJson, learningFingerprint, FINGERPRINT, PROJECT_ID, UUID_V4 } from "./learning-v1-contract.ts";
import { validateEvaluationRunRef, type EvaluationRunRef, type EvaluationPacketRef } from "./evaluation-run.ts";
import { validateEvaluationRef } from "./evaluation-contract.ts";
import { validateExecutionAuthorityRef, type ExecutionAuthorityRef } from "./evaluation-stale-confirmation.ts";

export const MAX_RECOVERY_ADMISSION_BYTES = 16384;
export const MAX_RECOVERY_ADMISSIONS_V1 = 4096;
export interface RecoveryAdmissionRef {
  readonly schemaVersion: 1; readonly family: "recovery-admission"; readonly projectId: string;
  readonly logicalEvaluationKey: string; readonly opportunityKey: string; readonly generation: number; readonly fingerprint: string;
}
export interface RecoveryAdmissionBindingV1 {
  readonly identityVersion: 1; readonly projectId: string;
  readonly rootCreatedRef: EvaluationRunRef; readonly oldRunningRef: EvaluationRunRef;
  readonly confirmationRef: ExecutionAuthorityRef; readonly fencingEpoch: 1;
  readonly packetRef: EvaluationPacketRef; readonly packetFingerprint: string;
  readonly evaluator: { readonly name: string; readonly version: string };
  readonly executionContractFingerprint: string;
  readonly generation: number; readonly previousAdmissionRef: RecoveryAdmissionRef | null;
  readonly logicalEvaluationKey: string; readonly opportunityKey: string;
}
export interface RecoveryUsageV1 {
  readonly tokens: number; readonly costMicros: number; readonly durationMs: number;
}
export interface EvaluationRecoveryPolicyV1 {
  readonly schemaVersion: 1; readonly maxRecoveryAdmissions: number;
  readonly allowedClass: "fenced-owner-cessation-no-output";
  readonly retryableEvaluators: readonly { readonly name: string; readonly version: string; readonly executionContractFingerprint: string }[];
  readonly perAdmission: RecoveryUsageV1; readonly perEvaluation: RecoveryUsageV1; readonly global: RecoveryUsageV1;
}
export interface RecoveryAdmissionControllerV1 {
  readonly id: string; readonly incarnation: string; readonly authorizationFingerprint: string;
}
/** Only a captured trusted inspector can attest these facts; shape validity is not proof. */
export interface RecoveryReconciliationV1 {
  readonly schemaVersion: 1; readonly opportunityKey: string; readonly observedAt: string;
  readonly state: "SAFE_NO_COMMITTED_OUTPUT" | "COMMITTED_OUTPUT_EXISTS" | "COMMITTED_RESULT_EXISTS" | "TERMINAL_EXISTS" |
    "PUBLICATION_AMBIGUOUS" | "EXTERNAL_EXECUTION_UNKNOWN" | "HISTORY_UNKNOWN";
  readonly rootBinding: "exact-standalone-root" | "unknown";
  readonly publicationManifestFingerprint: string;
  readonly publication: "closed-and-quiescent" | "unknown";
  readonly outputs: "none-committed" | "committed" | "unknown";
  readonly effects: "none" | "committed" | "unknown";
  readonly ambiguities: "none" | "unknown";
  readonly cessation: {
    readonly confirmationRef: ExecutionAuthorityRef; readonly claimId: string; readonly incarnation: string; readonly handleId: string;
    readonly coverage: "all-local-and-external-execution" | "unknown"; readonly status: "ceased" | "unknown";
  };
  readonly runtime: { readonly executionContractFingerprint: string; readonly isolation: "verified" | "unknown"; readonly readiness: "ready" | "unavailable" | "unknown" };
}
/** Base usage excludes admission reservations, which the store independently counts under its shared lock. */
export interface RecoveryResourcesV1 {
  readonly schemaVersion: 1; readonly opportunityKey: string; readonly observedAt: string;
  readonly usageAccounting: "known" | "conservative";
  readonly oldAttemptUsage: RecoveryUsageV1; readonly evaluationBaseUsage: RecoveryUsageV1; readonly globalBaseUsage: RecoveryUsageV1;
  readonly reservation: RecoveryUsageV1;
  readonly capacity: { readonly runSlots: number; readonly authoritySlots: number; readonly leaseSlots: number };
}
/** Immutable permission metadata only. No target ID, claim, successor, evaluator or semantic authority. */
export interface RecoveryAdmissionV1 {
  readonly schemaVersion: 1; readonly binding: RecoveryAdmissionBindingV1;
  readonly originAuthorityRef: ExecutionAuthorityRef;
  readonly controller: RecoveryAdmissionControllerV1; readonly policy: EvaluationRecoveryPolicyV1; readonly policyFingerprint: string;
  readonly admittedAt: string; readonly reason: "fenced-owner-cessation-no-output";
  readonly reconciliation: RecoveryReconciliationV1; readonly resources: RecoveryResourcesV1;
}
export interface RecoveryAdmissionSnapshot { readonly admission: RecoveryAdmissionV1; readonly ref: RecoveryAdmissionRef }
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, names: string) => Object.keys(v).sort().join() === names.split(",").sort().join();
const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 128;
const fp = (v: unknown): v is string => typeof v === "string" && FINGERPRINT.test(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
export const sameRecoveryValue = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export function validateRecoveryUsage(v: unknown): v is RecoveryUsageV1 {
  return obj(v) && keys(v, "tokens,costMicros,durationMs") && uint(v.tokens) && uint(v.costMicros) && uint(v.durationMs);
}
export function validateRecoveryAdmissionController(v: unknown): v is RecoveryAdmissionControllerV1 {
  return obj(v) && keys(v, "id,incarnation,authorizationFingerprint") && text(v.id) && text(v.incarnation) && fp(v.authorizationFingerprint);
}
export function validateEvaluationRecoveryPolicy(v: unknown): v is EvaluationRecoveryPolicyV1 {
  return obj(v) && keys(v, "schemaVersion,maxRecoveryAdmissions,allowedClass,retryableEvaluators,perAdmission,perEvaluation,global") && v.schemaVersion === 1 &&
    uint(v.maxRecoveryAdmissions) && v.maxRecoveryAdmissions <= MAX_RECOVERY_ADMISSIONS_V1 && v.allowedClass === "fenced-owner-cessation-no-output" &&
    Array.isArray(v.retryableEvaluators) && v.retryableEvaluators.length <= 16 && v.retryableEvaluators.every(e => obj(e) && keys(e, "name,version,executionContractFingerprint") && text(e.name) && text(e.version) && fp(e.executionContractFingerprint)) &&
    new Set(v.retryableEvaluators.map(e => canonicalJson(e))).size === v.retryableEvaluators.length &&
    [v.perAdmission, v.perEvaluation, v.global].every(x => validateRecoveryUsage(x) && x.tokens > 0 && x.costMicros > 0 && x.durationMs > 0);
}
export function validateRecoveryAdmissionRef(v: unknown): v is RecoveryAdmissionRef {
  return obj(v) && keys(v, "schemaVersion,family,projectId,logicalEvaluationKey,opportunityKey,generation,fingerprint") && v.schemaVersion === 1 && v.family === "recovery-admission" &&
    typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && fp(v.logicalEvaluationKey) && fp(v.opportunityKey) && fp(v.fingerprint) && uint(v.generation) && v.generation > 0 && v.generation <= MAX_RECOVERY_ADMISSIONS_V1;
}
type IdentityInput = Omit<RecoveryAdmissionBindingV1, "logicalEvaluationKey" | "opportunityKey">;
function validIdentityInput(v: unknown): v is IdentityInput {
  if (!obj(v) || !keys(v, "identityVersion,projectId,rootCreatedRef,oldRunningRef,confirmationRef,fencingEpoch,packetRef,packetFingerprint,evaluator,executionContractFingerprint,generation,previousAdmissionRef")) return false;
  return v.identityVersion === 1 && typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) &&
    validateEvaluationRunRef(v.rootCreatedRef) && v.rootCreatedRef.status === "created" && v.rootCreatedRef.projectId === v.projectId &&
    validateEvaluationRunRef(v.oldRunningRef) && v.oldRunningRef.status === "running" && v.oldRunningRef.projectId === v.projectId &&
    validateExecutionAuthorityRef(v.confirmationRef) && v.confirmationRef.projectId === v.projectId && v.confirmationRef.runId === v.oldRunningRef.runId && v.fencingEpoch === 1 &&
    validateEvaluationRef(v.packetRef, "evaluation-packet") && v.packetRef.scope.projectId === v.projectId && v.packetFingerprint === v.packetRef.fingerprint &&
    obj(v.evaluator) && keys(v.evaluator, "name,version") && text(v.evaluator.name) && text(v.evaluator.version) && fp(v.executionContractFingerprint) &&
    uint(v.generation) && v.generation > 0 && v.generation <= MAX_RECOVERY_ADMISSIONS_V1 &&
    (v.generation === 1 ? v.previousAdmissionRef === null && v.oldRunningRef.runId === v.rootCreatedRef.runId :
      validateRecoveryAdmissionRef(v.previousAdmissionRef) && v.previousAdmissionRef.projectId === v.projectId && v.previousAdmissionRef.generation === v.generation - 1 && v.oldRunningRef.runId !== v.rootCreatedRef.runId);
}
/** Canonical immutable facts only; controller, policy, times and future UUIDs do not define this identity. */
export function createRecoveryAdmissionBinding(input: IdentityInput): RecoveryAdmissionBindingV1 {
  if (!validIdentityInput(input)) throw new Error("Invalid recovery identity facts.");
  const v = detachedRecoveryValue(input);
  if (!validIdentityInput(v)) throw new Error("Invalid detached recovery identity.");
  const logicalEvaluationKey = learningFingerprint({ identityVersion: 1, projectId: v.projectId, rootCreatedRef: v.rootCreatedRef,
    packetRef: v.packetRef, packetFingerprint: v.packetFingerprint, evaluator: v.evaluator });
  if (v.previousAdmissionRef && v.previousAdmissionRef.logicalEvaluationKey !== logicalEvaluationKey) throw new Error("Conflicting recovery root identity.");
  const opportunityKey = learningFingerprint({ identityVersion: 1, logicalEvaluationKey, oldRunningRef: v.oldRunningRef, confirmationRef: v.confirmationRef,
    fencingEpoch: v.fencingEpoch, generation: v.generation, previousAdmissionRef: v.previousAdmissionRef, packetRef: v.packetRef,
    packetFingerprint: v.packetFingerprint, evaluator: v.evaluator, executionContractFingerprint: v.executionContractFingerprint });
  return freezeRecoveryValue({ ...v, logicalEvaluationKey, opportunityKey });
}
export function validateRecoveryAdmissionBinding(v: unknown): v is RecoveryAdmissionBindingV1 {
  try {
    if (!obj(v) || !keys(v, "identityVersion,projectId,rootCreatedRef,oldRunningRef,confirmationRef,fencingEpoch,packetRef,packetFingerprint,evaluator,executionContractFingerprint,generation,previousAdmissionRef,logicalEvaluationKey,opportunityKey")) return false;
    const { logicalEvaluationKey, opportunityKey, ...input } = v;
    if (!validIdentityInput(input)) return false;
    const derived = createRecoveryAdmissionBinding(input);
    return derived.logicalEvaluationKey === logicalEvaluationKey && derived.opportunityKey === opportunityKey;
  } catch { return false; }
}
export function validateRecoveryReconciliation(v: unknown): v is RecoveryReconciliationV1 {
  try {
    return obj(v) && keys(v, "schemaVersion,opportunityKey,observedAt,state,rootBinding,publicationManifestFingerprint,publication,outputs,effects,ambiguities,cessation,runtime") && v.schemaVersion === 1 && fp(v.opportunityKey) && time(v.observedAt) &&
      ["SAFE_NO_COMMITTED_OUTPUT", "COMMITTED_OUTPUT_EXISTS", "COMMITTED_RESULT_EXISTS", "TERMINAL_EXISTS", "PUBLICATION_AMBIGUOUS", "EXTERNAL_EXECUTION_UNKNOWN", "HISTORY_UNKNOWN"].includes(v.state as string) &&
      ["exact-standalone-root", "unknown"].includes(v.rootBinding as string) && fp(v.publicationManifestFingerprint) && ["closed-and-quiescent", "unknown"].includes(v.publication as string) &&
      ["none-committed", "committed", "unknown"].includes(v.outputs as string) && ["none", "committed", "unknown"].includes(v.effects as string) && ["none", "unknown"].includes(v.ambiguities as string) &&
      obj(v.cessation) && keys(v.cessation, "confirmationRef,claimId,incarnation,handleId,coverage,status") && validateExecutionAuthorityRef(v.cessation.confirmationRef) &&
      typeof v.cessation.claimId === "string" && UUID_V4.test(v.cessation.claimId) && text(v.cessation.incarnation) && text(v.cessation.handleId) && ["all-local-and-external-execution", "unknown"].includes(v.cessation.coverage as string) && ["ceased", "unknown"].includes(v.cessation.status as string) &&
      obj(v.runtime) && keys(v.runtime, "executionContractFingerprint,isolation,readiness") && fp(v.runtime.executionContractFingerprint) && ["verified", "unknown"].includes(v.runtime.isolation as string) && ["ready", "unavailable", "unknown"].includes(v.runtime.readiness as string);
  } catch { return false; }
}
export function isSafeRecoveryReconciliation(v: RecoveryReconciliationV1): boolean {
  return v.state === "SAFE_NO_COMMITTED_OUTPUT" && v.rootBinding === "exact-standalone-root" && v.publication === "closed-and-quiescent" && v.outputs === "none-committed" &&
    v.effects === "none" && v.ambiguities === "none" && v.cessation.coverage === "all-local-and-external-execution" && v.cessation.status === "ceased" && v.runtime.isolation === "verified" && v.runtime.readiness === "ready";
}
export function validateRecoveryResources(v: unknown): v is RecoveryResourcesV1 {
  try {
    return obj(v) && keys(v, "schemaVersion,opportunityKey,observedAt,usageAccounting,oldAttemptUsage,evaluationBaseUsage,globalBaseUsage,reservation,capacity") && v.schemaVersion === 1 && fp(v.opportunityKey) && time(v.observedAt) &&
      ["known", "conservative"].includes(v.usageAccounting as string) && [v.oldAttemptUsage, v.evaluationBaseUsage, v.globalBaseUsage, v.reservation].every(validateRecoveryUsage) &&
      obj(v.capacity) && keys(v.capacity, "runSlots,authoritySlots,leaseSlots") && uint(v.capacity.runSlots) && uint(v.capacity.authoritySlots) && uint(v.capacity.leaseSlots);
  } catch { return false; }
}
export function recoveryUsageWithin(a: RecoveryUsageV1, b: RecoveryUsageV1): boolean {
  return a.tokens <= b.tokens && a.costMicros <= b.costMicros && a.durationMs <= b.durationMs;
}
export function recoveryPolicyAllows(policy: EvaluationRecoveryPolicyV1, binding: RecoveryAdmissionBindingV1): boolean {
  return binding.generation <= policy.maxRecoveryAdmissions && policy.retryableEvaluators.some(e =>
    e.name === binding.evaluator.name && e.version === binding.evaluator.version && e.executionContractFingerprint === binding.executionContractFingerprint);
}
function coherentResourceDecision(r: RecoveryResourcesV1, p: EvaluationRecoveryPolicyV1): boolean {
  return recoveryUsageWithin(r.oldAttemptUsage, r.evaluationBaseUsage) && recoveryUsageWithin(r.evaluationBaseUsage, r.globalBaseUsage) &&
    recoveryUsageWithin(r.reservation, p.perAdmission) && (["tokens", "costMicros", "durationMs"] as const).every(k =>
      Number.isSafeInteger(r.evaluationBaseUsage[k] + r.reservation[k]) && r.evaluationBaseUsage[k] + r.reservation[k] <= p.perEvaluation[k] &&
      Number.isSafeInteger(r.globalBaseUsage[k] + r.reservation[k]) && r.globalBaseUsage[k] + r.reservation[k] <= p.global[k]) &&
    r.capacity.runSlots > 0 && r.capacity.authoritySlots > 0 && r.capacity.leaseSlots > 0;
}
export function validateRecoveryAdmission(v: unknown): v is RecoveryAdmissionV1 {
  try {
    return obj(v) && keys(v, "schemaVersion,binding,originAuthorityRef,controller,policy,policyFingerprint,admittedAt,reason,reconciliation,resources") && v.schemaVersion === 1 &&
      validateRecoveryAdmissionBinding(v.binding) && validateExecutionAuthorityRef(v.originAuthorityRef) && v.originAuthorityRef.projectId === v.binding.projectId && v.originAuthorityRef.runId === v.binding.oldRunningRef.runId &&
      validateRecoveryAdmissionController(v.controller) && validateEvaluationRecoveryPolicy(v.policy) && recoveryPolicyAllows(v.policy, v.binding) && v.policyFingerprint === learningFingerprint(v.policy) && time(v.admittedAt) && v.reason === "fenced-owner-cessation-no-output" &&
      validateRecoveryReconciliation(v.reconciliation) && isSafeRecoveryReconciliation(v.reconciliation) && v.reconciliation.opportunityKey === v.binding.opportunityKey && v.reconciliation.observedAt === v.admittedAt &&
      sameRecoveryValue(v.reconciliation.cessation.confirmationRef, v.binding.confirmationRef) && v.reconciliation.runtime.executionContractFingerprint === v.binding.executionContractFingerprint &&
      validateRecoveryResources(v.resources) && coherentResourceDecision(v.resources, v.policy) && v.resources.opportunityKey === v.binding.opportunityKey && v.resources.observedAt === v.admittedAt && Buffer.byteLength(canonicalJson(v)) <= MAX_RECOVERY_ADMISSION_BYTES;
  } catch { return false; }
}
export function freezeRecoveryValue<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freezeRecoveryValue(child); Object.freeze(v); }
  return v;
}
export function detachedRecoveryValue<T>(v: T): T { return freezeRecoveryValue(JSON.parse(canonicalJson(v))); }
export function recoveryAdmissionSnapshot(admission: RecoveryAdmissionV1): RecoveryAdmissionSnapshot {
  if (!validateRecoveryAdmission(admission)) throw new Error("Invalid RecoveryAdmission.");
  const copy = detachedRecoveryValue(admission);
  if (!validateRecoveryAdmission(copy)) throw new Error("Invalid detached RecoveryAdmission.");
  const b = copy.binding;
  return freezeRecoveryValue({ admission: copy, ref: { schemaVersion: 1, family: "recovery-admission", projectId: b.projectId,
    logicalEvaluationKey: b.logicalEvaluationKey, opportunityKey: b.opportunityKey, generation: b.generation, fingerprint: learningFingerprint(copy) } });
}
