import { canonicalJson, FINGERPRINT, PROJECT_ID, UUID_V4, learningFingerprint } from "./learning-v1-contract.ts";
import { validateEvaluationRunRef, type EvaluationRunRef } from "./evaluation-run.ts";
import { validateExecutionLeaseRef, type ExecutionLeaseRef } from "./evaluation-execution-lease.ts";
import { validateExecutionLeaseStalePolicy, validateExecutionLeaseClockSample, type ExecutionLeaseStalePolicyV1, type ExecutionLeaseClockSampleV1 } from "./evaluation-execution-lease-assessment.ts";

export interface ExecutionAuthorityRef {
  readonly schemaVersion: 1; readonly family: "execution-authority";
  readonly projectId: string; readonly runId: string; readonly fingerprint: string;
}
export interface ExecutionAuthorityOriginV1 {
  readonly schemaVersion: 1; readonly kind: "owned"; readonly epoch: 0;
  readonly runningRef: EvaluationRunRef; readonly claimId: string; readonly incarnation: string;
}
/** Trusted monitor assertion covering all publication-capable actors, not a timeout. */
export interface ExecutionCessationEvidenceV1 {
  readonly schemaVersion: 1; readonly kind: "joined" | "terminated";
  readonly authorityRef: ExecutionAuthorityRef; readonly claimId: string; readonly incarnation: string;
  readonly handleId: string; readonly observedAt: string; readonly coverage: "all-publication-capable-actors";
}
export interface StaleConfirmationV1 {
  readonly schemaVersion: 1; readonly kind: "stale-confirmation"; readonly runId: string;
  readonly runningRef: EvaluationRunRef; readonly previousAuthorityRef: ExecutionAuthorityRef;
  readonly previousLeaseRef: ExecutionLeaseRef; readonly previousOwnerId: string;
  readonly previousLeaseEpoch: number; readonly newFencingEpoch: number;
  readonly confirmer: { readonly id: string; readonly incarnation: string };
  readonly confirmedAt: string; readonly reason: "owner-cessation";
  readonly evidence: ExecutionCessationEvidenceV1;
  readonly policy: ExecutionLeaseStalePolicyV1; readonly clock: ExecutionLeaseClockSampleV1;
}
export type ExecutionAuthorityRecordV1 = ExecutionAuthorityOriginV1 | StaleConfirmationV1;
export interface ExecutionAuthoritySnapshot { readonly record: ExecutionAuthorityRecordV1; readonly ref: ExecutionAuthorityRef }
export const MAX_EXECUTION_AUTHORITY_BYTES = 8192;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected.split(",").sort().join();
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 128;
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function validateExecutionAuthorityRef(v: unknown): v is ExecutionAuthorityRef {
  return object(v) && keys(v, "schemaVersion,family,projectId,runId,fingerprint") && v.schemaVersion === 1 && v.family === "execution-authority" &&
    typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && typeof v.runId === "string" && UUID_V4.test(v.runId) &&
    typeof v.fingerprint === "string" && FINGERPRINT.test(v.fingerprint);
}
export function validateExecutionCessationEvidence(v: unknown): v is ExecutionCessationEvidenceV1 {
  try {
    return object(v) && keys(v, "schemaVersion,kind,authorityRef,claimId,incarnation,handleId,observedAt,coverage") && v.schemaVersion === 1 &&
      (v.kind === "joined" || v.kind === "terminated") && validateExecutionAuthorityRef(v.authorityRef) &&
      typeof v.claimId === "string" && UUID_V4.test(v.claimId) && text(v.incarnation) && text(v.handleId) && time(v.observedAt) &&
      v.coverage === "all-publication-capable-actors";
  } catch { return false; }
}
export function validateStaleConfirmation(v: unknown): v is StaleConfirmationV1 {
  try {
    return object(v) && keys(v, "schemaVersion,kind,runId,runningRef,previousAuthorityRef,previousLeaseRef,previousOwnerId,previousLeaseEpoch,newFencingEpoch,confirmer,confirmedAt,reason,evidence,policy,clock") &&
      v.schemaVersion === 1 && v.kind === "stale-confirmation" && validateEvaluationRunRef(v.runningRef) && v.runningRef.status === "running" && v.runId === v.runningRef.runId &&
      validateExecutionAuthorityRef(v.previousAuthorityRef) && v.previousAuthorityRef.projectId === v.runningRef.projectId && v.previousAuthorityRef.runId === v.runId &&
      validateExecutionLeaseRef(v.previousLeaseRef) && v.previousLeaseRef.projectId === v.runningRef.projectId && v.previousLeaseRef.runId === v.runId && text(v.previousOwnerId) &&
      Number.isSafeInteger(v.previousLeaseEpoch) && (v.previousLeaseEpoch as number) >= 0 && Number.isSafeInteger(v.newFencingEpoch) &&
      v.newFencingEpoch === (v.previousLeaseEpoch as number) + 1 && object(v.confirmer) && keys(v.confirmer, "id,incarnation") && text(v.confirmer.id) && text(v.confirmer.incarnation) &&
      time(v.confirmedAt) && v.reason === "owner-cessation" && validateExecutionCessationEvidence(v.evidence) && same(v.evidence.authorityRef, v.previousAuthorityRef) &&
      Date.parse(v.evidence.observedAt) <= Date.parse(v.confirmedAt) && validateExecutionLeaseStalePolicy(v.policy) && validateExecutionLeaseClockSample(v.clock) &&
      v.clock.observedAt === v.confirmedAt && Buffer.byteLength(canonicalJson(v)) <= MAX_EXECUTION_AUTHORITY_BYTES;
  } catch { return false; }
}
export function validateExecutionAuthorityRecord(v: unknown): v is ExecutionAuthorityRecordV1 {
  return validateStaleConfirmation(v) || object(v) && keys(v, "schemaVersion,kind,epoch,runningRef,claimId,incarnation") &&
    v.schemaVersion === 1 && v.kind === "owned" && v.epoch === 0 && validateEvaluationRunRef(v.runningRef) && v.runningRef.status === "running" &&
    typeof v.claimId === "string" && UUID_V4.test(v.claimId) && text(v.incarnation);
}
export function freezeExecutionAuthority<T>(v: T): T {
  if (v && typeof v === "object") { for (const child of Object.values(v)) freezeExecutionAuthority(child); Object.freeze(v); }
  return v;
}
export function executionAuthoritySnapshot(record: ExecutionAuthorityRecordV1): ExecutionAuthoritySnapshot {
  if (!validateExecutionAuthorityRecord(record)) throw new Error("Invalid execution authority record.");
  const copy = JSON.parse(canonicalJson(record));
  if (!validateExecutionAuthorityRecord(copy)) throw new Error("Invalid detached execution authority record.");
  return freezeExecutionAuthority({ record: copy, ref: { schemaVersion: 1, family: "execution-authority", projectId: copy.runningRef.projectId,
    runId: copy.runningRef.runId, fingerprint: learningFingerprint(copy) } });
}
