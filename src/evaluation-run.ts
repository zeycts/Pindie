import { canonicalJson, learningFingerprint, UUID_V4, FINGERPRINT, PROJECT_ID } from "./learning-v1-contract.ts";
import { validateRecoveryAdmissionRef, type RecoveryAdmissionRef } from "./recovery-admission.ts";
import { validateEvaluationRef, type EvaluationRef } from "./evaluation-contract.ts";

export type EvaluationPacketRef = EvaluationRef & { readonly family: "evaluation-packet" };
/** Operational attempt only: completion is not an evaluation conclusion or trust decision. */
export interface EvaluationRunV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly packetRef: EvaluationPacketRef;
  readonly packetFingerprint: string;
  readonly evaluator: { readonly name: string; readonly version: string };
  readonly status: "created" | "running" | "completed" | "failed";
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failure?: { readonly code: string; readonly message: string };
}
/** Explicit immutable recovery lineage; v1 bytes and ref envelopes remain unchanged. */
export interface EvaluationRunV2 extends Omit<EvaluationRunV1, "schemaVersion"> {
  readonly schemaVersion: 2;
  readonly logicalEvaluationKey: string;
  readonly recoveryGeneration: number;
  readonly recovery: {
    readonly rootCreatedRef: EvaluationRunRef;
    readonly parentRunningRef: EvaluationRunRef;
    readonly admissionRef: RecoveryAdmissionRef;
  };
}
export type EvaluationRun = EvaluationRunV1 | EvaluationRunV2;
/** Dedicated exact snapshot ref, deliberately outside LearningArtifactRef and EvaluationRef. */
export interface EvaluationRunRef {
  readonly schemaVersion: 1; readonly family: "evaluation-run";
  readonly projectId: string; readonly runId: string;
  readonly status: EvaluationRunV1["status"]; readonly fingerprint: string;
}
export const MAX_EVALUATION_RUN_BYTES = 8192;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected.split(",").sort().join();
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;
export function validateEvaluationRun(v: unknown): v is EvaluationRun {
  try {
    if (!object(v) || (v.schemaVersion !== 1 && v.schemaVersion !== 2) || typeof v.runId !== "string" || !UUID_V4.test(v.runId) ||
      !validateEvaluationRef(v.packetRef, "evaluation-packet") || v.packetFingerprint !== v.packetRef.fingerprint ||
      !object(v.evaluator) || !keys(v.evaluator, "name,version") || !text(v.evaluator.name, 128) || !text(v.evaluator.version, 128) ||
      !time(v.createdAt) || Buffer.byteLength(canonicalJson(v)) > MAX_EVALUATION_RUN_BYTES) return false;
    let base = "createdAt,evaluator,packetFingerprint,packetRef,runId,schemaVersion,status";
    if (v.schemaVersion === 2) {
      if (!object(v.recovery) || !keys(v.recovery, "rootCreatedRef,parentRunningRef,admissionRef")) return false;
      const { rootCreatedRef: root, parentRunningRef: parent, admissionRef: admission } = v.recovery;
      if (!validateEvaluationRunRef(root) || root.status !== "created" || !validateEvaluationRunRef(parent) || parent.status !== "running" ||
        !validateRecoveryAdmissionRef(admission) || root.projectId !== v.packetRef.scope.projectId || parent.projectId !== root.projectId || admission.projectId !== root.projectId ||
        v.logicalEvaluationKey !== admission.logicalEvaluationKey || v.recoveryGeneration !== admission.generation ||
        v.runId === root.runId || v.runId === parent.runId || (admission.generation === 1 ? parent.runId !== root.runId : parent.runId === root.runId) ||
        v.logicalEvaluationKey !== learningFingerprint({ identityVersion: 1, projectId: root.projectId, rootCreatedRef: root, packetRef: v.packetRef, packetFingerprint: v.packetFingerprint, evaluator: v.evaluator })) return false;
      base += ",logicalEvaluationKey,recoveryGeneration,recovery";
    }
    if (v.status === "created") return keys(v, base);
    if (!time(v.startedAt) || Date.parse(v.startedAt) < Date.parse(v.createdAt)) return false;
    if (v.status === "running") return keys(v, `${base},startedAt`);
    if (!time(v.completedAt) || Date.parse(v.completedAt) < Date.parse(v.startedAt)) return false;
    if (v.status === "completed") return keys(v, `completedAt,${base},startedAt`);
    return v.status === "failed" && keys(v, `${base},completedAt,failure,startedAt`) &&
      object(v.failure) && keys(v.failure, "code,message") && text(v.failure.code, 128) && text(v.failure.message, 2048);
  } catch { return false; }
}
/** Version-specific guards preserve strict historical v1 interpretation. */
export function validateEvaluationRunV1(v: unknown): v is EvaluationRunV1 {
  return validateEvaluationRun(v) && v.schemaVersion === 1;
}
export function validateEvaluationRunV2(v: unknown): v is EvaluationRunV2 {
  return validateEvaluationRun(v) && v.schemaVersion === 2;
}
export function evaluationRunRef(run: EvaluationRun): EvaluationRunRef {
  return { schemaVersion: 1, family: "evaluation-run", projectId: run.packetRef.scope.projectId, runId: run.runId, status: run.status, fingerprint: learningFingerprint(run) };
}
export function validateEvaluationRunRef(v: unknown): v is EvaluationRunRef {
  return object(v) && keys(v, "family,fingerprint,projectId,runId,schemaVersion,status") && v.schemaVersion === 1 && v.family === "evaluation-run" &&
    typeof v.projectId === "string" && PROJECT_ID.test(v.projectId) && typeof v.runId === "string" && UUID_V4.test(v.runId) &&
    typeof v.fingerprint === "string" && FINGERPRINT.test(v.fingerprint) && ["created", "running", "completed", "failed"].includes(v.status as string);
}
/** Identity, evaluator and preceding timestamps are immutable across the legal edge. */
export function isEvaluationRunTransition(previous: EvaluationRun, next: EvaluationRun): boolean {
  if (!validateEvaluationRun(previous) || !validateEvaluationRun(next)) return false;
  const legal = previous.status === "created" ? next.status === "running" : previous.status === "running" && (next.status === "completed" || next.status === "failed");
  const { status: _s, startedAt: _a, completedAt: _b, failure: _f, ...identity } = next;
  const { status: _p, startedAt, completedAt: _c, failure: _d, ...priorIdentity } = previous;
  return legal && canonicalJson(identity) === canonicalJson(priorIdentity) && (previous.status === "created" || startedAt === next.startedAt);
}
export function transitionEvaluationRun(previous: EvaluationRunV1, status: EvaluationRunV1["status"], at: string, failure?: EvaluationRunV1["failure"]): EvaluationRunV1;
export function transitionEvaluationRun(previous: EvaluationRunV2, status: EvaluationRunV1["status"], at: string, failure?: EvaluationRunV1["failure"]): EvaluationRunV2;
export function transitionEvaluationRun(previous: EvaluationRun, status: EvaluationRunV1["status"], at: string, failure?: EvaluationRunV1["failure"]): EvaluationRun;
export function transitionEvaluationRun(previous: EvaluationRun, status: EvaluationRunV1["status"], at: string, failure?: EvaluationRunV1["failure"]): EvaluationRun {
  const next = { ...previous, status, ...(status === "running" ? { startedAt: at } : { completedAt: at }), ...(failure === undefined ? {} : { failure }) };
  if (!isEvaluationRunTransition(previous, next)) throw new Error("Invalid EvaluationRun transition.");
  return next;
}
