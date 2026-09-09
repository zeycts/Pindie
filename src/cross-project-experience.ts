import { createHash } from "node:crypto";

import {
  parseRunExperience,
  type RunExperience,
} from "./run-experience.ts";
import type { RunExperienceProjectReader } from "./experience-store.ts";

export const CROSS_PROJECT_EXPERIENCE_REF_SCHEMA_VERSION = 1 as const;
export const MAX_CROSS_PROJECT_EXPERIENCE_REFS = 1024;
export const MAX_CROSS_PROJECT_EXPERIENCE_RECORD_ID_LENGTH = 41;

const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
const CANONICAL_RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const CANONICAL_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const REF_FIELDS = ["projectId", "recordId", "recordFingerprint"] as const;

export interface CrossProjectExperienceRefV1 {
  readonly projectId: string;
  readonly recordId: string;
  readonly recordFingerprint: string;
}

export type CrossProjectExperienceRef = CrossProjectExperienceRefV1;

export interface CreateCrossProjectExperienceRefInput {
  readonly projectId: string;
  readonly recordId: string;
  readonly experience: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  return actual.length === fields.length &&
    actual.every((field, index) => field === fields[index]);
}

function invalid(message: string): never {
  throw new Error(`Invalid Cross-Project Experience reference: ${message}`);
}

function validateProjectId(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_PROJECT_ID.test(value)) {
    return invalid("projectId must be a canonical lowercase project identity.");
  }
  return value;
}

function validateRecordId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_CROSS_PROJECT_EXPERIENCE_RECORD_ID_LENGTH ||
    !CANONICAL_RECORD_ID.test(value)
  ) return invalid("recordId must be a canonical lowercase UUID-v4 .json filename.");
  return value;
}

function validateFingerprint(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_FINGERPRINT.test(value)) {
    return invalid("recordFingerprint must be a lowercase SHA-256 fingerprint.");
  }
  return value;
}

function canonicalSelection(selection: RunExperience["policy"]["finalSnapshot"] extends infer T
  ? T extends null ? never : T extends { approach: infer A; modifiers: infer M }
    ? { approach: A; modifiers: M }
    : never
  : never): Record<string, unknown> {
  const canonical = (value: any): Record<string, unknown> => ({
    strategyId: value.strategyId,
    kind: value.kind,
    revisionIdentity: value.revisionIdentity,
    revisionFingerprint: value.revisionFingerprint,
    revisionStatusAtRun: value.revisionStatusAtRun,
    semantics: {
      summary: value.semantics.summary,
      useWhen: [...value.semantics.useWhen],
      avoidWhen: [...value.semantics.avoidWhen],
      principles: [...value.semantics.principles],
    },
  });
  return {
    approach: canonical(selection.approach),
    modifiers: selection.modifiers.map(canonical),
  };
}

function canonicalRunExperience(record: RunExperience): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    recordedAt: record.recordedAt,
    runStart: {
      taskStatus: record.runStart.taskStatus,
      taskGoal: record.runStart.taskGoal,
    },
    task: {
      goal: record.task.goal,
      taskRelation: record.task.taskRelation,
    },
    policy: {
      finalSnapshot: record.policy.finalSnapshot === null
        ? null
        : canonicalSelection(record.policy.finalSnapshot),
      declarationCount: record.policy.declarationCount,
      finalPolicyDeclarationCount: record.policy.finalPolicyDeclarationCount,
      finalPolicyFirstDeclaredAfter: record.policy.finalPolicyFirstDeclaredAfter === null
        ? null
        : { ...record.policy.finalPolicyFirstDeclaredAfter },
      finalPolicyLastDeclaredAfter: record.policy.finalPolicyLastDeclaredAfter === null
        ? null
        : { ...record.policy.finalPolicyLastDeclaredAfter },
    },
    execution: {
      toolCalls: record.execution.toolCalls,
      observations: record.execution.observations,
      consequentialCalls: record.execution.consequentialCalls,
      projectMutationEffectCalls: record.execution.projectMutationEffectCalls,
      verificationCalls: record.execution.verificationCalls,
      toolErrors: record.execution.toolErrors,
      deniedCalls: record.execution.deniedCalls,
    },
    outcome: {
      taskStatus: record.outcome.taskStatus,
      verificationStatus: record.outcome.verificationStatus,
      completionRelation: record.outcome.completionRelation,
      hasBlockers: record.outcome.hasBlockers,
      hasQuestions: record.outcome.hasQuestions,
      humanGateOpen: record.outcome.humanGateOpen,
    },
    metrics: {
      durationMs: record.metrics.durationMs,
      cost: record.metrics.cost,
    },
  };
}

/**
 * Fingerprint the strict, fully materialized schema-v4 record. The explicit
 * projection fixes field order so source-file whitespace or object-key order
 * cannot alter the reference binding.
 */
export function crossProjectExperienceRecordFingerprint(value: unknown): string {
  const record = parseRunExperience(value);
  if (record === null) return invalid("record must be a valid schema-v4 Experience artifact.");
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalRunExperience(record)))
    .digest("hex")}`;
}

export const crossProjectExperienceFingerprint = crossProjectExperienceRecordFingerprint;
export const runExperienceRecordFingerprint = crossProjectExperienceRecordFingerprint;

/** Validate one strict qualified reference without resolving its source file. */
export function validateCrossProjectExperienceRefArtifact(
  value: unknown,
): CrossProjectExperienceRefV1 {
  if (!isRecord(value) || !hasExactFields(value, REF_FIELDS)) {
    return invalid("fields are invalid.");
  }
  return Object.freeze({
    projectId: validateProjectId(value.projectId),
    recordId: validateRecordId(value.recordId),
    recordFingerprint: validateFingerprint(value.recordFingerprint),
  });
}

export const parseCrossProjectExperienceRef = validateCrossProjectExperienceRefArtifact;
export const validateCrossProjectExperienceRef = validateCrossProjectExperienceRefArtifact;

/** Construct a qualified ref from an already validated schema-v4 record. */
export function createCrossProjectExperienceRef(
  input: CreateCrossProjectExperienceRefInput,
): CrossProjectExperienceRefV1 {
  const projectId = validateProjectId(input.projectId);
  const recordId = validateRecordId(input.recordId);
  const recordFingerprint = crossProjectExperienceRecordFingerprint(input.experience);
  return Object.freeze({ projectId, recordId, recordFingerprint });
}

export function isCanonicalCrossProjectExperienceRecordId(value: string): boolean {
  return CANONICAL_RECORD_ID.test(value);
}

export function isCanonicalCrossProjectProjectId(value: string): boolean {
  return CANONICAL_PROJECT_ID.test(value);
}

export function isCanonicalCrossProjectExperienceFingerprint(value: string): boolean {
  return CANONICAL_FINGERPRINT.test(value);
}

export function compareCrossProjectExperienceRefs(
  left: CrossProjectExperienceRefV1,
  right: CrossProjectExperienceRefV1,
): number {
  const leftKey = `${left.projectId}\0${left.recordId}\0${left.recordFingerprint}`;
  const rightKey = `${right.projectId}\0${right.recordId}\0${right.recordFingerprint}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function canonicalizeCrossProjectExperienceRefs(
  refs: readonly CrossProjectExperienceRefV1[],
): readonly CrossProjectExperienceRefV1[] {
  const validated = refs.map((ref) => validateCrossProjectExperienceRefArtifact(ref));
  const sorted = [...validated].sort(compareCrossProjectExperienceRefs);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareCrossProjectExperienceRefs(sorted[index - 1]!, sorted[index]!) === 0) {
      return invalid("evidence refs must be unique.");
    }
  }
  return Object.freeze(sorted);
}

export function isSortedCrossProjectExperienceRefs(
  refs: readonly CrossProjectExperienceRefV1[],
): boolean {
  for (let index = 1; index < refs.length; index += 1) {
    if (compareCrossProjectExperienceRefs(refs[index - 1]!, refs[index]!) >= 0) return false;
  }
  return true;
}

/**
 * Resolve one qualified locator directly against its owning live namespace.
 * A missing, duplicated, malformed, or fingerprint-mismatched record never
 * falls back to a bare UUID or another project.
 */
export async function resolveCrossProjectExperienceRef(
  value: CrossProjectExperienceRefV1,
  reader: RunExperienceProjectReader,
): Promise<RunExperience | null> {
  const ref = validateCrossProjectExperienceRefArtifact(value);
  let result: unknown;
  try {
    result = await reader.readProjectId(ref.projectId);
  } catch {
    return null;
  }
  if (
    typeof result !== "object" || result === null || Array.isArray(result) ||
    !Array.isArray((result as { records?: unknown }).records)
  ) return null;
  const matches = (result as { records: readonly unknown[] }).records.filter((record) =>
    typeof record === "object" && record !== null && !Array.isArray(record) &&
    (record as { recordId?: unknown }).recordId === ref.recordId);
  if (matches.length !== 1) return null;
  const experience = parseRunExperience(
    (matches[0] as { experience?: unknown }).experience,
  );
  if (experience === null) return null;
  try {
    return crossProjectExperienceRecordFingerprint(experience) === ref.recordFingerprint
      ? experience
      : null;
  } catch {
    return null;
  }
}
