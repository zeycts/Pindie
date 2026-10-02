import { MAX_LEARNING_LEASE_OWNER_LENGTH, UUID_V4, PROJECT_ID, FINGERPRINT } from "./learning-v1-contract.ts";
import { validateEvaluationRun, type EvaluationRunV1 } from "./evaluation-run.ts";

/** Ownership metadata only. Valid bytes do not acquire or prove an execution claim. */
export interface ExecutionLeaseV1 {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}
export interface ExecutionLeaseRef {
  readonly schemaVersion: 1; readonly family: "execution-lease";
  readonly projectId: string; readonly runId: string; readonly fingerprint: string;
}
export function validateExecutionLeaseRef(v: unknown): v is ExecutionLeaseRef {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).sort().join() === "family,fingerprint,projectId,runId,schemaVersion" && r.schemaVersion === 1 && r.family === "execution-lease" &&
    typeof r.projectId === "string" && PROJECT_ID.test(r.projectId) && typeof r.runId === "string" && UUID_V4.test(r.runId) &&
    typeof r.fingerprint === "string" && FINGERPRINT.test(r.fingerprint);
}
const time = (v: unknown): v is string => typeof v === "string" && new Date(v).toISOString() === v;

export function validateExecutionLease(v: unknown): v is ExecutionLeaseV1 {
  try {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const lease = v as Record<string, unknown>;
    return Object.keys(lease).sort().join() === "acquiredAt,heartbeatAt,ownerId,runId,schemaVersion" &&
      lease.schemaVersion === 1 && typeof lease.runId === "string" && UUID_V4.test(lease.runId) &&
      typeof lease.ownerId === "string" && lease.ownerId.trim().length > 0 && lease.ownerId.length <= MAX_LEARNING_LEASE_OWNER_LENGTH &&
      time(lease.acquiredAt) && time(lease.heartbeatAt) && Date.parse(lease.heartbeatAt) >= Date.parse(lease.acquiredAt);
  } catch { return false; }
}

/** Pure projection intended for the unique claim owner; no I/O or authority acquisition. */
export function createExecutionLease(running: EvaluationRunV1, ownerId: string): ExecutionLeaseV1 {
  if (!validateEvaluationRun(running) || running.schemaVersion !== 1 || running.status !== "running") throw new Error("ExecutionLease requires a valid running EvaluationRun.");
  const lease = { schemaVersion: 1 as const, runId: running.runId, ownerId, acquiredAt: running.startedAt!, heartbeatAt: running.startedAt! };
  if (!validateExecutionLease(lease)) throw new Error("Invalid ExecutionLease.");
  return Object.freeze(lease);
}

/** Heartbeats preserve the original owner and acquisition time, including identical retries. */
export function isExecutionLeaseHeartbeat(previous: ExecutionLeaseV1, next: ExecutionLeaseV1): boolean {
  return validateExecutionLease(previous) && validateExecutionLease(next) &&
    previous.runId === next.runId && previous.ownerId === next.ownerId && previous.acquiredAt === next.acquiredAt &&
    Date.parse(next.heartbeatAt) >= Date.parse(previous.heartbeatAt);
}

/** Returns a new frozen snapshot; never mutates or replaces prior ownership history. */
export function heartbeatExecutionLease(previous: ExecutionLeaseV1, heartbeatAt: string): ExecutionLeaseV1 {
  const next = { ...previous, heartbeatAt };
  if (!isExecutionLeaseHeartbeat(previous, next)) throw new Error("Invalid ExecutionLease heartbeat.");
  return Object.freeze(next);
}
