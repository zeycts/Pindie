import { createHash, randomUUID } from "node:crypto";

import type { PindieTask } from "./state.ts";

export const TASK_CONTINUITY_SCHEMA_VERSION = 1;
export const MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH = 4_000;
export const MAX_CONTINUITY_DECISIONS = 12;
export const MAX_CONTINUITY_DECISION_LENGTH = 1_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

export interface TaskContinuityV1 {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly taskFingerprint: string;
  readonly sourceSessionId: string;
  readonly progressSummary: string;
  readonly decisions: readonly string[];
}

export interface TaskContinuityContent {
  readonly progressSummary: string;
  readonly decisions: readonly string[];
}

export type TaskContinuityValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateContent(content: TaskContinuityContent): string[] {
  const errors: string[] = [];
  if (typeof content.progressSummary !== "string" || content.progressSummary.trim() === "") {
    errors.push("progressSummary must be a non-empty string.");
  } else if (content.progressSummary.length > MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH) {
    errors.push(`progressSummary must be at most ${MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH} characters.`);
  }

  if (!Array.isArray(content.decisions)) {
    errors.push("decisions must be an array.");
  } else {
    if (content.decisions.length > MAX_CONTINUITY_DECISIONS) {
      errors.push(`decisions must contain at most ${MAX_CONTINUITY_DECISIONS} items.`);
    }
    content.decisions.forEach((decision, index) => {
      if (typeof decision !== "string" || decision.trim() === "") {
        errors.push(`decisions[${index}] must be a non-empty string.`);
      } else if (decision.length > MAX_CONTINUITY_DECISION_LENGTH) {
        errors.push(`decisions[${index}] must be at most ${MAX_CONTINUITY_DECISION_LENGTH} characters.`);
      }
    });
  }
  return errors;
}

export function validateTaskContinuity(
  value: unknown,
): TaskContinuityValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ["Task continuity must be an object."] };
  }

  const errors: string[] = [];
  if (value.schemaVersion !== TASK_CONTINUITY_SCHEMA_VERSION) {
    errors.push("schemaVersion must be 1.");
  }
  if (typeof value.checkpointId !== "string" || !UUID_V4.test(value.checkpointId)) {
    errors.push("checkpointId must be a UUID-v4.");
  }
  if (!isCanonicalIsoTimestamp(value.createdAt)) {
    errors.push("createdAt must be a canonical ISO timestamp.");
  }
  if (typeof value.taskFingerprint !== "string" || !SHA256_FINGERPRINT.test(value.taskFingerprint)) {
    errors.push("taskFingerprint must be a sha256 fingerprint.");
  }
  if (typeof value.sourceSessionId !== "string" || value.sourceSessionId.trim() === "") {
    errors.push("sourceSessionId must be a non-empty string.");
  }

  errors.push(...validateContent({
    progressSummary: value.progressSummary as string,
    decisions: value.decisions as string[],
  }));
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function assertTaskContinuityContent(
  content: TaskContinuityContent,
): void {
  const errors = validateContent(content);
  if (errors.length > 0) {
    throw new Error(`Invalid Task continuity content: ${errors.join(" ")}`);
  }
}

export function createTaskContinuity(
  input: TaskContinuityContent & {
    readonly taskFingerprint: string;
    readonly sourceSessionId: string;
    readonly createdAt: string;
  },
): TaskContinuityV1 {
  const checkpoint: TaskContinuityV1 = {
    schemaVersion: TASK_CONTINUITY_SCHEMA_VERSION,
    checkpointId: randomUUID(),
    createdAt: input.createdAt,
    taskFingerprint: input.taskFingerprint,
    sourceSessionId: input.sourceSessionId,
    progressSummary: input.progressSummary,
    decisions: [...input.decisions],
  };
  const validation = validateTaskContinuity(checkpoint);
  if (!validation.ok) {
    throw new Error(`Invalid Task continuity checkpoint: ${validation.errors.join(" ")}`);
  }
  return Object.freeze({
    ...checkpoint,
    decisions: Object.freeze([...checkpoint.decisions]),
  });
}

/** Hash only the durable Task Contract, never mutable execution fields. */
export function taskContractFingerprint(task: PindieTask): string {
  const canonicalContract = {
    goal: task.goal,
    constraints: [...task.constraints],
    successCriteria: task.successCriteria.map(({ id, description }) => ({ id, description })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalContract), "utf8").digest("hex")}`;
}
