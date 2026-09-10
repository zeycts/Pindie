import { isDeepStrictEqual } from "node:util";

import {
  compareCrossProjectExperienceRefs,
  createCrossProjectExperienceRef,
  isCanonicalCrossProjectExperienceRecordId,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "./experience-store.ts";
import {
  evaluateRunExperience,
  type RunEvaluation,
} from "./experience-evaluation.ts";
import {
  parseRunExperience,
  type RunExperience,
} from "./run-experience.ts";
import {
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type PolicyStrategySelection,
} from "./policy.ts";

export const MIN_CROSS_PROJECT_TRIAL_RUNS = 2 as const;
export const MIN_CROSS_PROJECT_TRIAL_PROJECTS = 2 as const;
export const DEFAULT_CROSS_PROJECT_TRIAL_DETAIL_LIMIT = 8 as const;

export interface CrossProjectTrialStrategy {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
  readonly semantics: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
}

/** Runtime-only subject; no Candidate or universal registry is persisted. */
export interface CrossProjectTrialSubject {
  readonly origin: "transfer" | "synthesis";
  readonly subjectId: string;
  readonly strategy: CrossProjectTrialStrategy;
  readonly excludedTrialProjectIds: readonly string[];
  /** Synthesis Candidates may not use discovery records as Trial evidence. */
  readonly minimumTrialRecordedAt?: string;
}

export interface CrossProjectTrialEvidenceRecord {
  readonly ref: CrossProjectExperienceRefV1;
  readonly evaluation: RunEvaluation;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

export interface CrossProjectTrialOutcomeSummary {
  readonly verificationPassedCount: number;
  readonly verificationNotPassedCount: number;
  readonly completedDuringRunCount: number;
  readonly notCompletedDuringRunCount: number;
  readonly runsWithBlockers: number;
  readonly runsWithQuestions: number;
  readonly totalToolErrors: number;
  readonly totalDeniedCalls: number;
}

export interface CrossProjectTrialProjectInventory {
  readonly projectId: string;
  readonly excludedTrialProject: boolean;
  readonly matchingRecordCount: number;
  readonly eligibleRunCount: number;
  readonly ineligibleRunCount: number;
  readonly detailRecords: readonly CrossProjectTrialEvidenceRecord[];
  readonly omittedDetailRecordCount: number;
  readonly outcomes: CrossProjectTrialOutcomeSummary;
}

export interface CrossProjectTrialEvidenceProjection {
  readonly subject: CrossProjectTrialSubject;
  readonly inventories: readonly CrossProjectTrialProjectInventory[];
  readonly matchingRecordCount: number;
  readonly ineligibleMatchingRunCount: number;
  readonly eligibleTrialRunCount: number;
  readonly distinctEligibleTrialProjectCount: number;
  readonly eligibleTrialProjectIds: readonly string[];
  readonly selectedEvidenceRefs: readonly CrossProjectExperienceRefV1[];
  readonly omittedEligibleRefCount: number;
  readonly evidenceScanComplete: boolean;
  readonly selectedEvidenceRefsValid: boolean;
  readonly reasons: readonly string[];
}

export interface CrossProjectTrialRecordContext {
  readonly subject: CrossProjectTrialSubject;
  readonly projectId: string;
  readonly ref: CrossProjectExperienceRefV1;
  readonly experience: RunExperience;
  readonly refResolved?: boolean;
}

export type CrossProjectTrialAdditionalEligibility = (
  context: CrossProjectTrialRecordContext,
) => readonly string[];

export interface EvaluateCrossProjectTrialRecordInput extends CrossProjectTrialRecordContext {
  readonly additionalReasons?: CrossProjectTrialAdditionalEligibility;
}

export interface ScanCrossProjectTrialEvidenceInput {
  readonly subject: CrossProjectTrialSubject;
  readonly experienceReader: RunExperienceProjectReader;
  readonly additionalEligibility?: CrossProjectTrialAdditionalEligibility;
  readonly maxSelectedRefs?: number;
  readonly maxDetailRecords?: number;
}

interface PreparedProjectExperience {
  readonly projectId: string;
  readonly matching: readonly {
    readonly ref: CrossProjectExperienceRefV1;
    readonly experience: RunExperience;
  }[];
  readonly matchingDigest: string;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

interface MutableInventory {
  readonly projectId: string;
  readonly excludedTrialProject: boolean;
  matchingRecordCount: number;
  eligibleRunCount: number;
  ineligibleRunCount: number;
  readonly detailRecords: CrossProjectTrialEvidenceRecord[];
  verificationPassedCount: number;
  completedDuringRunCount: number;
  runsWithBlockers: number;
  runsWithQuestions: number;
  totalToolErrors: number;
  totalDeniedCalls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalProjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("cross-project Trial evidence contains a non-canonical project identity");
  }
  return value;
}

function validateProjectIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Experience project namespace reader returned an invalid collection.");
  const ids = value.map(canonicalProjectId);
  if (new Set(ids).size !== ids.length) throw new Error("Experience project namespace reader returned duplicate project IDs.");
  return Object.freeze([...ids].sort(compareText));
}

function validateSubject(subject: CrossProjectTrialSubject): CrossProjectTrialSubject {
  if (!isRecord(subject) || (subject.origin !== "transfer" && subject.origin !== "synthesis")) {
    throw new Error("cross-project Trial subject origin is invalid");
  }
  if (typeof subject.subjectId !== "string" || subject.subjectId.trim() === "") {
    throw new Error("cross-project Trial subject identity is invalid");
  }
  const strategy = subject.strategy;
  if (!isRecord(strategy) ||
    typeof strategy.strategyId !== "string" || strategy.strategyId.trim() === "" ||
    (strategy.kind !== "approach" && strategy.kind !== "modifier") ||
    typeof strategy.revisionIdentity !== "string" || strategy.revisionIdentity.trim() === "" ||
    typeof strategy.revisionFingerprint !== "string" || strategy.revisionFingerprint.trim() === "") {
    throw new Error("cross-project Trial subject Strategy identity is invalid");
  }
  if (!isRecord(strategy.semantics) ||
    typeof strategy.semantics.summary !== "string" ||
    !Array.isArray(strategy.semantics.useWhen) ||
    !Array.isArray(strategy.semantics.avoidWhen) ||
    !Array.isArray(strategy.semantics.principles)) {
    throw new Error("cross-project Trial subject Strategy semantics are invalid");
  }
  const excluded = subject.excludedTrialProjectIds ?? [];
  if (!Array.isArray(excluded)) throw new Error("cross-project Trial excluded project identities are invalid");
  const excludedIds = excluded.map(canonicalProjectId);
  if (new Set(excludedIds).size !== excludedIds.length) {
    throw new Error("cross-project Trial excluded project identities contain duplicates");
  }
  let minimumTrialRecordedAt: string | undefined;
  if (subject.minimumTrialRecordedAt !== undefined) {
    if (typeof subject.minimumTrialRecordedAt !== "string" || !Number.isFinite(Date.parse(subject.minimumTrialRecordedAt))) {
      throw new Error("cross-project Trial minimum timestamp is invalid");
    }
    minimumTrialRecordedAt = subject.minimumTrialRecordedAt;
  }
  return Object.freeze({
    origin: subject.origin,
    subjectId: subject.subjectId,
    strategy: Object.freeze({
      strategyId: strategy.strategyId,
      kind: strategy.kind,
      revisionIdentity: strategy.revisionIdentity,
      revisionFingerprint: strategy.revisionFingerprint,
      semantics: Object.freeze({
        summary: strategy.semantics.summary,
        useWhen: Object.freeze([...strategy.semantics.useWhen]),
        avoidWhen: Object.freeze([...strategy.semantics.avoidWhen]),
        principles: Object.freeze([...strategy.semantics.principles]),
      }),
    }),
    excludedTrialProjectIds: Object.freeze([...new Set(excludedIds)].sort(compareText)),
    ...(minimumTrialRecordedAt === undefined ? {} : { minimumTrialRecordedAt }),
  });
}

function strategySemantics(value: PolicyStrategySelection): CrossProjectTrialStrategy["semantics"] {
  return {
    summary: value.summary,
    useWhen: [...value.useWhen],
    avoidWhen: [...(value.avoidWhen ?? [])],
    principles: [...value.principles],
  };
}

function selectedSemanticsEqual(
  selection: PolicyStrategySelection,
  subject: CrossProjectTrialSubject,
): boolean {
  return isDeepStrictEqual(strategySemantics(selection), subject.strategy.semantics);
}

/** Exact final-Policy identity is the only common attribution match. */
export function matchesCrossProjectTrialStrategy(
  experience: RunExperience,
  subjectInput: CrossProjectTrialSubject,
): boolean {
  const subject = validateSubject(subjectInput);
  const snapshot = experience.policy.finalSnapshot;
  if (snapshot === null) return false;
  const selections = subject.strategy.kind === "approach"
    ? [snapshot.approach]
    : snapshot.modifiers;
  return selections.some((selection) =>
    strategySelectionId(selection) === subject.strategy.strategyId &&
    selection.kind === subject.strategy.kind &&
    strategySelectionRevisionIdentity(selection) === subject.strategy.revisionIdentity &&
    strategySelectionRevisionFingerprint(selection) === subject.strategy.revisionFingerprint);
}

function matchingSelection(
  experience: RunExperience,
  subject: CrossProjectTrialSubject,
 ): PolicyStrategySelection | null {
  const snapshot = experience.policy.finalSnapshot;
  if (snapshot === null) return null;
  const selections = subject.strategy.kind === "approach"
    ? [snapshot.approach]
    : snapshot.modifiers;
  return selections.find((selection) =>
    strategySelectionId(selection) === subject.strategy.strategyId &&
    selection.kind === subject.strategy.kind &&
    strategySelectionRevisionIdentity(selection) === subject.strategy.revisionIdentity &&
    strategySelectionRevisionFingerprint(selection) === subject.strategy.revisionFingerprint) ?? null;
}

/** Evaluate common Trial attribution facts plus one origin-specific callback. */
export function evaluateCrossProjectTrialRecord(
  input: EvaluateCrossProjectTrialRecordInput,
): CrossProjectTrialEvidenceRecord {
  const subject = validateSubject(input.subject);
  const evaluation = evaluateRunExperience({ recordId: input.ref.recordId, experience: input.experience });
  const reasons: string[] = [];
  if (input.refResolved === false) reasons.push("qualified Experience reference did not freshly resolve");
  if (subject.excludedTrialProjectIds.includes(input.projectId)) {
    reasons.push("this project is excluded from cross-project Trial evidence for the origin");
  }
  if (!evaluation.attributionEligible) reasons.push("RunEvaluation.attributionEligible is false");
  if (
    evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0
  ) reasons.push("final Policy has no continuous non-policy execution exposure");
  const selection = matchingSelection(input.experience, subject);
  if (selection === null) {
    reasons.push("final Policy does not contain the exact Trial Strategy identity in the correct role");
  } else {
    if (strategySelectionRevisionStatus(selection) !== "trial") {
      reasons.push("revisionStatusAtRun is not trial");
    }
    if (!selectedSemanticsEqual(selection, subject)) {
      reasons.push("recorded Strategy semantics do not exactly match the immutable Trial subject");
    }
  }
  if (subject.minimumTrialRecordedAt !== undefined) {
    const createdAt = Date.parse(subject.minimumTrialRecordedAt);
    const recordedAt = Date.parse(input.experience.recordedAt);
    if (!Number.isFinite(recordedAt) || recordedAt < createdAt) {
      reasons.push("Trial Experience was recorded before the immutable Candidate was created");
    }
  }
  if (input.additionalReasons !== undefined) {
    reasons.push(...input.additionalReasons({ ...input, subject }));
  }
  return Object.freeze({
    ref: validateCrossProjectExperienceRefArtifact(input.ref),
    evaluation,
    eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function validateReadResult(value: RunExperienceReadResult): RunExperienceReadResult {
  if (!isRecord(value) || !Array.isArray(value.records) ||
    !Number.isSafeInteger(value.loadedRecords) || value.loadedRecords < 0 ||
    !Number.isSafeInteger(value.unsupportedSchema) || value.unsupportedSchema < 0 ||
    !Number.isSafeInteger(value.invalid) || value.invalid < 0) {
    throw new Error("Experience reader returned an invalid read result.");
  }
  return value;
}

function matchingDigest(
  refs: readonly CrossProjectExperienceRefV1[],
): string {
  return refs
    .map((ref) => `${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}`)
    .join("\n");
}

function prepareProjectExperience(
  projectId: string,
  rawRead: RunExperienceReadResult,
  subject: CrossProjectTrialSubject,
): PreparedProjectExperience {
  const read = validateReadResult(rawRead);
  const reasons: string[] = [];
  if (read.invalid > 0) reasons.push(`project ${projectId.slice(0, 8)} contains ${read.invalid} malformed live Experience record(s)`);
  if (read.unsupportedSchema > 0) reasons.push(`project ${projectId.slice(0, 8)} contains ${read.unsupportedSchema} unsupported live Experience record(s)`);
  const byRecordId = new Map<string, { readonly ref: CrossProjectExperienceRefV1; readonly experience: RunExperience }>();
  for (const raw of [...read.records].sort((left, right) => compareText(left.recordId, right.recordId))) {
    if (!isRecord(raw) || typeof raw.recordId !== "string" || !isCanonicalCrossProjectExperienceRecordId(raw.recordId)) {
      reasons.push(`project ${projectId.slice(0, 8)} returned a non-canonical Experience record identity`);
      continue;
    }
    const experience = parseRunExperience(raw.experience);
    if (experience === null) {
      reasons.push(`project ${projectId.slice(0, 8)} returned a malformed schema-v4 Experience record`);
      continue;
    }
    let ref: CrossProjectExperienceRefV1;
    try {
      ref = createCrossProjectExperienceRef({ projectId, recordId: raw.recordId, experience });
    } catch (error) {
      reasons.push(`project ${projectId.slice(0, 8)} returned an invalid Experience locator: ${errorMessage(error)}`);
      continue;
    }
    const prior = byRecordId.get(raw.recordId);
    if (prior !== undefined) {
      if (prior.ref.recordFingerprint !== ref.recordFingerprint) {
        reasons.push(`project ${projectId.slice(0, 8)} returned contradictory Experience records for '${raw.recordId.slice(0, 8)}'`);
      }
      continue;
    }
    byRecordId.set(raw.recordId, Object.freeze({ ref, experience }));
  }
  const matching = [...byRecordId.values()]
    .filter((record) => {
      try {
        return matchesCrossProjectTrialStrategy(record.experience, subject);
      } catch (error) {
        reasons.push(`project ${projectId.slice(0, 8)} returned an invalid final Policy projection: ${errorMessage(error)}`);
        return false;
      }
    })
    .sort((left, right) => compareCrossProjectExperienceRefs(left.ref, right.ref));
  const refs = matching.map((record) => record.ref);
  return Object.freeze({
    projectId,
    matching: Object.freeze(matching),
    matchingDigest: matchingDigest(refs),
    complete: reasons.length === 0 && read.loadedRecords >= byRecordId.size,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function createMutableInventory(
  projectId: string,
  subject: CrossProjectTrialSubject,
): MutableInventory {
  return {
    projectId,
    excludedTrialProject: subject.excludedTrialProjectIds.includes(projectId),
    matchingRecordCount: 0,
    eligibleRunCount: 0,
    ineligibleRunCount: 0,
    detailRecords: [],
    verificationPassedCount: 0,
    completedDuringRunCount: 0,
    runsWithBlockers: 0,
    runsWithQuestions: 0,
    totalToolErrors: 0,
    totalDeniedCalls: 0,
  };
}

function addEvidenceToInventory(
  inventory: MutableInventory,
  evidence: CrossProjectTrialEvidenceRecord,
  maxDetailRecords: number,
): void {
  inventory.matchingRecordCount += 1;
  if (evidence.eligible) inventory.eligibleRunCount += 1;
  else inventory.ineligibleRunCount += 1;
  if (inventory.detailRecords.length < maxDetailRecords) inventory.detailRecords.push(evidence);
  inventory.verificationPassedCount += evidence.evaluation.outcome.verificationPassed ? 1 : 0;
  inventory.completedDuringRunCount += evidence.evaluation.outcome.completedDuringRun ? 1 : 0;
  inventory.runsWithBlockers += evidence.evaluation.outcome.hasBlockers ? 1 : 0;
  inventory.runsWithQuestions += evidence.evaluation.outcome.hasQuestions ? 1 : 0;
  inventory.totalToolErrors += evidence.evaluation.execution.toolErrors;
  inventory.totalDeniedCalls += evidence.evaluation.execution.deniedCalls;
}

function finalizeInventory(inventory: MutableInventory): CrossProjectTrialProjectInventory {
  return Object.freeze({
    projectId: inventory.projectId,
    excludedTrialProject: inventory.excludedTrialProject,
    matchingRecordCount: inventory.matchingRecordCount,
    eligibleRunCount: inventory.eligibleRunCount,
    ineligibleRunCount: inventory.ineligibleRunCount,
    detailRecords: Object.freeze([...inventory.detailRecords]),
    omittedDetailRecordCount: Math.max(0, inventory.matchingRecordCount - inventory.detailRecords.length),
    outcomes: Object.freeze({
      verificationPassedCount: inventory.verificationPassedCount,
      verificationNotPassedCount: Math.max(0, inventory.matchingRecordCount - inventory.verificationPassedCount),
      completedDuringRunCount: inventory.completedDuringRunCount,
      notCompletedDuringRunCount: Math.max(0, inventory.matchingRecordCount - inventory.completedDuringRunCount),
      runsWithBlockers: inventory.runsWithBlockers,
      runsWithQuestions: inventory.runsWithQuestions,
      totalToolErrors: inventory.totalToolErrors,
      totalDeniedCalls: inventory.totalDeniedCalls,
    }),
  });
}

function samePreparedSnapshot(left: PreparedProjectExperience, right: PreparedProjectExperience): boolean {
  return left.matching.length === right.matching.length &&
    left.matchingDigest === right.matchingDigest &&
    right.complete;
}

async function freshSelectedRefs(
  selectedRefs: readonly CrossProjectExperienceRefV1[],
  freshReads: ReadonlyMap<string, PreparedProjectExperience>,
  subject: CrossProjectTrialSubject,
  additionalEligibility: CrossProjectTrialAdditionalEligibility | undefined,
): Promise<{ readonly valid: boolean; readonly reasons: readonly string[] }> {
  const reasons: string[] = [];
  for (const rawRef of selectedRefs) {
    const ref = validateCrossProjectExperienceRefArtifact(rawRef);
    const project = freshReads.get(ref.projectId);
    const record = project?.matching.find((item) => item.ref.recordId === ref.recordId);
    if (project === undefined || record === undefined || record.ref.recordFingerprint !== ref.recordFingerprint) {
      reasons.push(`selected evidence ref '${ref.recordId.slice(0, 8)}' is missing or fingerprint-mismatched on fresh resolution`);
      continue;
    }
    const evidence = evaluateCrossProjectTrialRecord({
      subject,
      projectId: ref.projectId,
      ref,
      experience: record.experience,
      refResolved: true,
      additionalReasons: additionalEligibility,
    });
    if (!evidence.eligible) {
      reasons.push(`selected evidence ref '${ref.recordId.slice(0, 8)}' is no longer eligible: ${evidence.reasons.join("; ")}`);
    }
  }
  return Object.freeze({ valid: reasons.length === 0, reasons: Object.freeze([...new Set(reasons)]) });
}

/**
 * Deterministically scan and freshly re-resolve one origin-specific Trial
 * subject. The callbacks add only origin-specific authority facts; identity,
 * timestamps, eligibility, ref ordering, and freshness stay shared.
 */
export async function scanCrossProjectTrialEvidence(
  input: ScanCrossProjectTrialEvidenceInput,
): Promise<CrossProjectTrialEvidenceProjection> {
  const subject = validateSubject(input.subject);
  const maxSelectedRefs = input.maxSelectedRefs ?? 1024;
  const maxDetailRecords = input.maxDetailRecords ?? DEFAULT_CROSS_PROJECT_TRIAL_DETAIL_LIMIT;
  if (!Number.isSafeInteger(maxSelectedRefs) || maxSelectedRefs < 1) throw new Error("cross-project Trial selected-ref bound is invalid");
  if (!Number.isSafeInteger(maxDetailRecords) || maxDetailRecords < 0) throw new Error("cross-project Trial detail bound is invalid");
  const reasons: string[] = [];
  let projectIds: readonly string[];
  try {
    projectIds = validateProjectIds(await input.experienceReader.listProjectIds());
  } catch (error) {
    return Object.freeze({
      subject,
      inventories: Object.freeze([]),
      matchingRecordCount: 0,
      ineligibleMatchingRunCount: 0,
      eligibleTrialRunCount: 0,
      distinctEligibleTrialProjectCount: 0,
      eligibleTrialProjectIds: Object.freeze([]),
      selectedEvidenceRefs: Object.freeze([]),
      omittedEligibleRefCount: 0,
      evidenceScanComplete: false,
      selectedEvidenceRefsValid: false,
      reasons: Object.freeze([`cross-project Experience namespace scan could not be completed: ${errorMessage(error)}`]),
    });
  }

  const firstReads = new Map<string, PreparedProjectExperience>();
  const inventories = new Map<string, MutableInventory>();
  const selectedFirstByProject = new Map<string, CrossProjectExperienceRefV1>();
  const eligibleRefs: CrossProjectExperienceRefV1[] = [];
  let evidenceScanComplete = true;
  for (const projectId of projectIds) {
    let prepared: PreparedProjectExperience;
    try {
      prepared = prepareProjectExperience(
        projectId,
        await input.experienceReader.readProjectId(projectId),
        subject,
      );
    } catch (error) {
      evidenceScanComplete = false;
      reasons.push(`project ${projectId.slice(0, 8)} Experience scan failed: ${errorMessage(error)}`);
      continue;
    }
    firstReads.set(projectId, prepared);
    if (!prepared.complete) {
      evidenceScanComplete = false;
      reasons.push(...prepared.reasons);
    }
    const inventory = createMutableInventory(projectId, subject);
    inventories.set(projectId, inventory);
    for (const matching of prepared.matching) {
      const evidence = evaluateCrossProjectTrialRecord({
        subject,
        projectId,
        ref: matching.ref,
        experience: matching.experience,
        refResolved: true,
        additionalReasons: input.additionalEligibility,
      });
      addEvidenceToInventory(inventory, evidence, maxDetailRecords);
      if (evidence.eligible) {
        eligibleRefs.push(evidence.ref);
        if (!selectedFirstByProject.has(projectId) && !inventory.excludedTrialProject) {
          selectedFirstByProject.set(projectId, evidence.ref);
        }
      }
    }
  }

  const selectedProjectRefs = [...selectedFirstByProject.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, ref]) => ref);
  const selectedRefSet = new Set(selectedProjectRefs.map((ref) => `${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}`));
  const extraRefs = [...eligibleRefs]
    .sort(compareCrossProjectExperienceRefs)
    .filter((ref) => !selectedRefSet.has(`${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}`));
  const selectedEvidenceRefs = Object.freeze(
    [...selectedProjectRefs, ...extraRefs].sort(compareCrossProjectExperienceRefs).slice(0, maxSelectedRefs),
  );

  const freshReads = new Map<string, PreparedProjectExperience>();
  try {
    const secondProjectIds = validateProjectIds(await input.experienceReader.listProjectIds());
    if (!isDeepStrictEqual(secondProjectIds, projectIds)) {
      evidenceScanComplete = false;
      reasons.push("cross-project project namespace set changed during the deterministic Trial scan");
    }
    for (const projectId of secondProjectIds) {
      try {
        const prepared = prepareProjectExperience(
          projectId,
          await input.experienceReader.readProjectId(projectId),
          subject,
        );
        freshReads.set(projectId, prepared);
        const first = firstReads.get(projectId);
        if (first === undefined || !samePreparedSnapshot(first, prepared)) {
          evidenceScanComplete = false;
          reasons.push(`project ${projectId.slice(0, 8)} matching Trial Experience changed or is incomplete during review`);
        }
      } catch (error) {
        evidenceScanComplete = false;
        reasons.push(`project ${projectId.slice(0, 8)} fresh Experience resolution failed: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    evidenceScanComplete = false;
    reasons.push(`cross-project fresh namespace scan could not be completed: ${errorMessage(error)}`);
  }

  const selectedFresh = await freshSelectedRefs(
    selectedEvidenceRefs,
    freshReads,
    subject,
    input.additionalEligibility,
  );
  if (!selectedFresh.valid) reasons.push(...selectedFresh.reasons);

  // A final selected-project reread is the boundary check used by promotion.
  // It remains part of this read-only projection, so callers cannot forget a
  // direct ref/fingerprint re-resolution before writing a terminal Decision.
  const boundaryReads = new Map<string, PreparedProjectExperience>();
  const boundaryReasons: string[] = [];
  for (const projectId of [...new Set(selectedEvidenceRefs.map((ref) => ref.projectId))].sort(compareText)) {
    try {
      const prepared = prepareProjectExperience(
        projectId,
        await input.experienceReader.readProjectId(projectId),
        subject,
      );
      boundaryReads.set(projectId, prepared);
      const prior = freshReads.get(projectId);
      if (prior === undefined || !samePreparedSnapshot(prior, prepared)) {
        evidenceScanComplete = false;
        boundaryReasons.push(`selected project ${projectId.slice(0, 8)} matching Trial Experience changed or is incomplete at the promotion boundary`);
      }
    } catch (error) {
      evidenceScanComplete = false;
      boundaryReasons.push(`selected project ${projectId.slice(0, 8)} fresh Experience resolution failed at the promotion boundary: ${errorMessage(error)}`);
    }
  }
  const selectedBoundary = await freshSelectedRefs(
    selectedEvidenceRefs,
    boundaryReads,
    subject,
    input.additionalEligibility,
  );
  if (!selectedBoundary.valid) boundaryReasons.push(...selectedBoundary.reasons);
  if (boundaryReasons.length > 0) reasons.push(...boundaryReasons);

  const inventoriesFinal = Object.freeze([...inventories.values()]
    .sort((left, right) => compareText(left.projectId, right.projectId))
    .map(finalizeInventory));
  const matchingRecordCount = inventoriesFinal.reduce((total, inventory) => total + inventory.matchingRecordCount, 0);
  const eligibleTrialRunCount = inventoriesFinal.reduce((total, inventory) => total + inventory.eligibleRunCount, 0);
  const ineligibleMatchingRunCount = inventoriesFinal.reduce((total, inventory) => total + inventory.ineligibleRunCount, 0);
  const eligibleTrialProjectIds = Object.freeze(inventoriesFinal
    .filter((inventory) => !inventory.excludedTrialProject && inventory.eligibleRunCount > 0)
    .map((inventory) => inventory.projectId));
  if (eligibleTrialRunCount < MIN_CROSS_PROJECT_TRIAL_RUNS) reasons.push(`at least ${MIN_CROSS_PROJECT_TRIAL_RUNS} eligible cross-project Trial Runs are required`);
  if (eligibleTrialProjectIds.length < MIN_CROSS_PROJECT_TRIAL_PROJECTS) reasons.push(`at least ${MIN_CROSS_PROJECT_TRIAL_PROJECTS} distinct eligible Trial projects are required`);
  if (!evidenceScanComplete) reasons.push("evidence completeness cannot be established from a complete deterministic authority scan");
  const selectedEvidenceRefsValid = selectedFresh.valid && selectedBoundary.valid && evidenceScanComplete;
  if (!selectedEvidenceRefsValid) reasons.push("the selected evidence reference set is not fully resolvable and eligible");

  return Object.freeze({
    subject,
    inventories: inventoriesFinal,
    matchingRecordCount,
    ineligibleMatchingRunCount,
    eligibleTrialRunCount,
    distinctEligibleTrialProjectCount: eligibleTrialProjectIds.length,
    eligibleTrialProjectIds,
    selectedEvidenceRefs,
    omittedEligibleRefCount: Math.max(0, eligibleTrialRunCount - selectedEvidenceRefs.length),
    evidenceScanComplete,
    selectedEvidenceRefsValid,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export const deriveCrossProjectTrialEvidence = scanCrossProjectTrialEvidence;
export const validateCrossProjectTrialRecord = evaluateCrossProjectTrialRecord;