import { canonicalJson, learningFingerprint, UUID_V4, FINGERPRINT } from "./learning-v1-contract.ts";
import { validateEvaluationRun, type EvaluationRunV2, type EvaluationRunRef, type EvaluationPacketRef } from "./evaluation-run.ts";
import { validateRecoveryAdmissionRef, recoveryAdmissionSnapshot, sameRecoveryValue, detachedRecoveryValue,
  type RecoveryAdmissionV1, type RecoveryAdmissionRef } from "./recovery-admission.ts";

export const MAX_RECOVERY_SUCCESSOR_BINDING_BYTES = 8192;
/** Target selection only: no execution claim, lease, credential or semantic authority. */
export interface RecoverySuccessorBindingV1 {
  readonly schemaVersion: 1;
  readonly admissionRef: RecoveryAdmissionRef;
  readonly projectId: string;
  readonly logicalEvaluationKey: string;
  readonly opportunityKey: string;
  readonly recoveryGeneration: number;
  readonly rootCreatedRef: EvaluationRunRef;
  readonly parentRunningRef: EvaluationRunRef;
  readonly successorRunId: string;
  readonly packetRef: EvaluationPacketRef;
  readonly packetFingerprint: string;
  readonly evaluator: { readonly name: string; readonly version: string };
  readonly executionContractFingerprint: string;
  /** Fixed creation time of the target, selected at the binding frontier. */
  readonly selectedAt: string;
}
export interface RecoverySuccessorBindingRef {
  readonly schemaVersion: 1; readonly family: "recovery-successor-binding";
  readonly admissionRef: RecoveryAdmissionRef; readonly fingerprint: string;
}
export interface RecoverySuccessorBindingSnapshot {
  readonly binding: RecoverySuccessorBindingV1; readonly ref: RecoverySuccessorBindingRef;
}
export function recoverySuccessorCreatedRun(b: RecoverySuccessorBindingV1): EvaluationRunV2 {
  return { schemaVersion: 2, runId: b.successorRunId, packetRef: b.packetRef, packetFingerprint: b.packetFingerprint,
    evaluator: b.evaluator, status: "created", createdAt: b.selectedAt, logicalEvaluationKey: b.logicalEvaluationKey,
    recoveryGeneration: b.recoveryGeneration, recovery: { rootCreatedRef: b.rootCreatedRef, parentRunningRef: b.parentRunningRef, admissionRef: b.admissionRef } };
}
export function validateRecoverySuccessorBinding(v: unknown): v is RecoverySuccessorBindingV1 {
  try {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !==
      "admissionRef,evaluator,executionContractFingerprint,logicalEvaluationKey,opportunityKey,packetFingerprint,packetRef,parentRunningRef,projectId,recoveryGeneration,rootCreatedRef,schemaVersion,selectedAt,successorRunId") return false;
    const b = v as RecoverySuccessorBindingV1;
    return b.schemaVersion === 1 && validateRecoveryAdmissionRef(b.admissionRef) && b.projectId === b.admissionRef.projectId &&
      b.opportunityKey === b.admissionRef.opportunityKey && typeof b.successorRunId === "string" && UUID_V4.test(b.successorRunId) &&
      typeof b.executionContractFingerprint === "string" && FINGERPRINT.test(b.executionContractFingerprint) &&
      validateEvaluationRun(recoverySuccessorCreatedRun(b)) && Buffer.byteLength(canonicalJson(b)) <= MAX_RECOVERY_SUCCESSOR_BINDING_BYTES;
  } catch { return false; }
}
export function validateRecoverySuccessorBindingRef(v: unknown): v is RecoverySuccessorBindingRef {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "admissionRef,family,fingerprint,schemaVersion") return false;
  const r = v as RecoverySuccessorBindingRef;
  return r.schemaVersion === 1 && r.family === "recovery-successor-binding" && validateRecoveryAdmissionRef(r.admissionRef) && typeof r.fingerprint === "string" && FINGERPRINT.test(r.fingerprint);
}
export function createRecoverySuccessorBinding(a: RecoveryAdmissionV1, successorRunId: string, selectedAt: string): RecoverySuccessorBindingV1 {
  const { ref } = recoveryAdmissionSnapshot(a), b = a.binding;
  const result: RecoverySuccessorBindingV1 = { schemaVersion: 1, admissionRef: ref, projectId: b.projectId, logicalEvaluationKey: b.logicalEvaluationKey,
    opportunityKey: b.opportunityKey, recoveryGeneration: b.generation, rootCreatedRef: b.rootCreatedRef, parentRunningRef: b.oldRunningRef,
    successorRunId, packetRef: b.packetRef, packetFingerprint: b.packetFingerprint, evaluator: b.evaluator,
    executionContractFingerprint: b.executionContractFingerprint, selectedAt };
  if (!validateRecoverySuccessorBinding(result) || Date.parse(selectedAt) < Date.parse(a.admittedAt)) throw new Error("Invalid RecoverySuccessorBinding.");
  return detachedRecoveryValue(result);
}
export function assertRecoverySuccessorAdmission(b: RecoverySuccessorBindingV1, a: RecoveryAdmissionV1): void {
  if (!validateRecoverySuccessorBinding(b) || !sameRecoveryValue(b, createRecoverySuccessorBinding(a, b.successorRunId, b.selectedAt)))
    throw new Error("Mismatched exact successor/admission binding.");
}
export function recoverySuccessorBindingSnapshot(b: RecoverySuccessorBindingV1): RecoverySuccessorBindingSnapshot {
  if (!validateRecoverySuccessorBinding(b)) throw new Error("Invalid RecoverySuccessorBinding.");
  const binding = detachedRecoveryValue(b);
  return detachedRecoveryValue({ binding, ref: { schemaVersion: 1, family: "recovery-successor-binding", admissionRef: binding.admissionRef, fingerprint: learningFingerprint(binding) } });
}
