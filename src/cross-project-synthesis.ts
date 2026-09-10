import { createHash } from "node:crypto";

import {
  createCrossProjectExperienceRef,
  isCanonicalCrossProjectExperienceFingerprint,
  isCanonicalCrossProjectExperienceRecordId,
  isCanonicalCrossProjectProjectId,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "./cross-project-experience.ts";
import {
  evaluateRunExperience,
  policyEvidenceProfileId,
  type RunEvaluation,
} from "./experience-evaluation.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
} from "./experience-store.ts";
import {
  policySnapshotIdentity,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type PolicySnapshot,
  type PolicyStrategySelection,
} from "./policy.ts";
import { finalPolicyUsesOnlyTrustedRevisions } from "./strategy-derivation.ts";
import {
  MAX_TRUSTED_PORTFOLIO_ENTRIES,
  trustedPortfolioFingerprint,
  type TrustedPortfolioResolvedEntry,
  type TrustedPortfolioTrustOrigin,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import { parseRunExperience } from "./run-experience.ts";

export const CROSS_PROJECT_SYNTHESIS_PACKET_VERSION = 1 as const;
export const CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION = 1 as const;
export const CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION = 1 as const;
export const MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS = 8;
export const MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT = 2;
export const MIN_CROSS_PROJECT_SYNTHESIS_SOURCE_RECORDS = 3;
export const MIN_CROSS_PROJECT_SYNTHESIS_PROJECTS = 2;
export const MIN_CROSS_PROJECT_SYNTHESIS_GOALS = 2;
export const MIN_CROSS_PROJECT_SYNTHESIS_POLICY_PROFILES = 2;
export const MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH = 512;
export const MAX_CROSS_PROJECT_SYNTHESIS_DIAGNOSTIC_LENGTH = 256;
export const MAX_CROSS_PROJECT_SYNTHESIS_COMPARISON_PROJECTS =
  MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS;
export const MAX_CROSS_PROJECT_SYNTHESIS_COMPARISON_ENTRIES =
  MAX_CROSS_PROJECT_SYNTHESIS_COMPARISON_PROJECTS * MAX_TRUSTED_PORTFOLIO_ENTRIES;

const CANONICAL_TIMESTAMP_LENGTH = 64;
const ORDERING_DESCRIPTION =
  "recordedAt descending, exact recordedAt text descending, projectId ascending, recordId ascending, recordFingerprint ascending";
const DISCOVERY_BOUNDARY_TEXT =
  "This evidence permits only an optional missing-abstraction hypothesis. It does not establish novelty, usefulness, superiority, causality, quality, score, reward, ranking, or similarity.";

export interface CrossProjectSynthesisEligibleRun {
  readonly ref: CrossProjectExperienceRefV1;
  readonly evaluation: RunEvaluation;
}

export interface CrossProjectSynthesisProjectInventory {
  readonly projectId: string;
  readonly loadedRecordCount: number;
  readonly unsupportedSchemaCount: number;
  readonly invalidRecordCount: number;
  readonly duplicateRecordLocatorCount: number;
  readonly validUniqueRecordCount: number;
  readonly eligibleRunCount: number;
  readonly ineligibleRunCount: number;
  readonly trustAvailable: boolean;
  readonly trustFailure: string | null;
}

export interface CrossProjectSynthesisInventory {
  readonly projectCount: number;
  readonly loadedRecordCount: number;
  readonly unsupportedSchemaCount: number;
  readonly invalidRecordCount: number;
  readonly duplicateRecordLocatorCount: number;
  readonly validUniqueRecordCount: number;
  readonly eligibleRunCount: number;
  readonly ineligibleRunCount: number;
  readonly projects: readonly CrossProjectSynthesisProjectInventory[];
}

export interface CrossProjectSynthesisProjectTrust {
  readonly projectId: string;
  readonly portfolio: TrustedStrategyPortfolio;
}

export interface CrossProjectSynthesisEvidenceScan {
  readonly projectIds: readonly string[];
  readonly eligible: readonly CrossProjectSynthesisEligibleRun[];
  readonly inventory: CrossProjectSynthesisInventory;
  /** Complete trust reads that can supply comparison context for shown projects. */
  readonly projectTrust: readonly CrossProjectSynthesisProjectTrust[];
}

export interface CrossProjectSynthesisSufficiency {
  readonly version: typeof CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION;
  readonly distinctQualifiedExperienceRefCount: number;
  readonly distinctProjectIdCount: number;
  readonly distinctExactTaskGoalCount: number;
  readonly distinctPolicyEvidenceProfileCount: number;
  readonly sufficient: boolean;
}

export interface CrossProjectSynthesisSelection {
  readonly version: typeof CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION;
  readonly maxRuns: number;
  readonly maxRunsPerProject: number;
  readonly ordering: string;
  readonly poolSufficiency: CrossProjectSynthesisSufficiency;
  readonly shownSufficiency: CrossProjectSynthesisSufficiency;
  readonly eligible: readonly CrossProjectSynthesisEligibleRun[];
  readonly shown: readonly CrossProjectSynthesisEligibleRun[];
}

export interface CrossProjectSynthesisSelectionRun {
  readonly sourceRef: CrossProjectExperienceRefV1;
  readonly recordedAt: string;
  /** Bounded presentation; exact identity is bound by exactTaskGoalDigest. */
  readonly taskGoal: string;
  readonly exactTaskGoalDigest: string;
  readonly finalPolicy: {
    readonly policyIdentity: string;
    readonly policyProfileId: string;
    readonly approach: CrossProjectSynthesisPolicySelection;
    readonly modifiers: readonly CrossProjectSynthesisPolicySelection[];
  };
  readonly declarationCount: number;
  readonly finalPolicyDeclarationCount: number;
  readonly finalPolicyFirstDeclarationProgress: number | null;
  readonly finalPolicyLastActivationProgress: number | null;
  readonly finalPolicyExposureCalls: number;
  readonly finalPolicyExposureRatio: number | null;
  readonly verificationPassed: boolean;
  readonly completedDuringRun: boolean;
  readonly hasBlockers: boolean;
  readonly hasQuestions: boolean;
  readonly humanGateOpen: boolean;
  readonly toolErrors: number;
  readonly deniedCalls: number;
  readonly durationMs: number | null;
  readonly cost: number | null;
}

export interface CrossProjectSynthesisPolicySelection {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
  readonly revisionStatusAtRun: "seed" | "trial" | "promoted";
}

export interface CrossProjectSynthesisTrustedStrategy {
  readonly projectId: string;
  readonly origin: "seed" | "promoted-seed-revision" | "promoted-derived";
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
  readonly trustOrigins: readonly TrustedPortfolioTrustOrigin[];
  readonly sourceProjectIds: readonly string[];
  readonly semantics: {
    readonly summary: string;
    readonly useWhen: readonly string[];
    readonly avoidWhen: readonly string[];
    readonly principles: readonly string[];
  };
}

export interface CrossProjectSynthesisTrustedProjectContext {
  readonly projectId: string;
  readonly portfolioFingerprintVersion: 1;
  readonly portfolioFingerprint: string;
  readonly trustedStrategies: readonly CrossProjectSynthesisTrustedStrategy[];
}

export interface CrossProjectSynthesisPacket {
  readonly packetVersion: typeof CROSS_PROJECT_SYNTHESIS_PACKET_VERSION;
  readonly selectionVersion: typeof CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION;
  readonly sufficiencyVersion: typeof CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION;
  readonly capturedAt: string;
  readonly selection: {
    readonly version: typeof CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION;
    readonly maxRuns: number;
    readonly maxRunsPerProject: number;
    readonly ordering: string;
  };
  readonly sourceRefs: readonly CrossProjectExperienceRefV1[];
  readonly evidence: {
    readonly eligibleRunCount: number;
    readonly shownRunCount: number;
    readonly omittedRunCount: number;
    readonly poolSufficiency: CrossProjectSynthesisSufficiency;
    readonly runs: readonly CrossProjectSynthesisSelectionRun[];
  };
  readonly sufficiency: CrossProjectSynthesisSufficiency;
  readonly inventory: CrossProjectSynthesisInventory;
  readonly trustedStrategyComparison: readonly CrossProjectSynthesisTrustedProjectContext[];
  readonly boundaryText: string;
  readonly packetFingerprint: string;
}

/** Slice B's durable receipt name for the already-built Slice A packet. */
export type CrossProjectDerivationPacketV1 = CrossProjectSynthesisPacket;

export interface CrossProjectSynthesisScanInput {
  readonly experienceReader: RunExperienceProjectReader;
  readonly trustedPortfolioReader: ProjectTrustedStrategyPortfolioReader;
}

export interface BuildCrossProjectSynthesisPacketInput {
  readonly scan: CrossProjectSynthesisEvidenceScan;
  /** Harness-owned capture fact; callers should supply one stable value per scan. */
  readonly capturedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function refKey(ref: CrossProjectExperienceRefV1): string {
  return `${ref.projectId}\0${ref.recordId}\0${ref.recordFingerprint}`;
}

function locatorKey(ref: CrossProjectExperienceRefV1): string {
  return `${ref.projectId}\0${ref.recordId}`;
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareStableRuns(
  left: CrossProjectSynthesisEligibleRun,
  right: CrossProjectSynthesisEligibleRun,
): number {
  const leftTime = parseTimestamp(left.evaluation.source.recordedAt);
  const rightTime = parseTimestamp(right.evaluation.source.recordedAt);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const recordedAt = compareText(
    right.evaluation.source.recordedAt,
    left.evaluation.source.recordedAt,
  );
  if (recordedAt !== 0) return recordedAt;
  const projectId = compareText(left.ref.projectId, right.ref.projectId);
  if (projectId !== 0) return projectId;
  const recordId = compareText(left.ref.recordId, right.ref.recordId);
  if (recordId !== 0) return recordId;
  return compareText(left.ref.recordFingerprint, right.ref.recordFingerprint);
}

function policyProfile(run: CrossProjectSynthesisEligibleRun): string {
  return policyEvidenceProfileId(run.evaluation.policy.finalSnapshot);
}

function outcomeSignature(run: CrossProjectSynthesisEligibleRun): string {
  const evaluation = run.evaluation;
  return [
    evaluation.outcome.verificationPassed,
    evaluation.outcome.completedDuringRun,
    evaluation.outcome.hasBlockers,
    evaluation.outcome.hasQuestions,
    evaluation.outcome.humanGateOpen,
    evaluation.execution.toolErrors > 0,
    evaluation.execution.deniedCalls > 0,
  ].map((value) => value ? "1" : "0").join("\0");
}

function exactStringDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function boundedTaskGoal(goal: string): string {
  return goal.length <= MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH
    ? goal
    : `${goal.slice(0, MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH - 14)} [truncated]`;
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length <= MAX_CROSS_PROJECT_SYNTHESIS_DIAGNOSTIC_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_CROSS_PROJECT_SYNTHESIS_DIAGNOSTIC_LENGTH - 1)}…`;
}

function validateCapturedAt(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > CANONICAL_TIMESTAMP_LENGTH ||
    !Number.isFinite(Date.parse(value))
  ) throw new Error("Cross-project synthesis packet capturedAt must be a valid bounded timestamp.");
  return value;
}

function validateReadResult(value: RunExperienceReadResult): RunExperienceReadResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.records) ||
    !Number.isSafeInteger(value.loadedRecords) || value.loadedRecords < 0 ||
    !Number.isSafeInteger(value.unsupportedSchema) || value.unsupportedSchema < 0 ||
    !Number.isSafeInteger(value.invalid) || value.invalid < 0
  ) throw new Error("Cross-project Experience reader returned an invalid read result.");
  return value;
}

function validatePortfolioForProject(
  portfolio: TrustedStrategyPortfolio,
  projectId: string,
): TrustedStrategyPortfolio {
  if (!isRecord(portfolio) || !isCanonicalCrossProjectProjectId(projectId) ||
    portfolio.projectId !== projectId ||
    portfolio.fingerprintVersion !== 1 ||
    !isCanonicalCrossProjectExperienceFingerprint(portfolio.fingerprint) ||
    !Array.isArray(portfolio.entries) ||
    !Array.isArray(portfolio.resolvedEntries) ||
    portfolio.entries.length !== portfolio.resolvedEntries.length ||
    portfolio.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES ||
    trustedPortfolioFingerprint(projectId, portfolio.entries) !== portfolio.fingerprint ||
    portfolio.resolvedEntries.some((entry, index) => {
      const manifest = entry?.manifest;
      const expected = portfolio.entries[index];
      return !isRecord(entry) || !isRecord(manifest) ||
        !isRecord(expected) ||
        manifest.origin !== expected.origin ||
        manifest.strategyId !== expected.strategyId ||
        manifest.kind !== expected.kind ||
        manifest.revisionIdentity !== expected.revisionIdentity ||
        manifest.revisionFingerprint !== expected.revisionFingerprint;
    })) {
    throw new Error("Project trust reader returned an invalid or wrongly bound portfolio.");
  }
  return portfolio;
}

function freezePolicySelection(
  selection: PolicyStrategySelection,
): CrossProjectSynthesisPolicySelection {
  return Object.freeze({
    strategyId: strategySelectionId(selection),
    kind: selection.kind,
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
    revisionStatusAtRun: strategySelectionRevisionStatus(selection),
  });
}

function finalPolicySelections(
  snapshot: NonNullable<RunEvaluation["policy"]["finalSnapshot"]>,
): readonly PolicyStrategySelection[] {
  return [snapshot.approach, ...snapshot.modifiers];
}

function projectRun(
  run: CrossProjectSynthesisEligibleRun,
): CrossProjectSynthesisSelectionRun {
  const snapshot = run.evaluation.policy.finalSnapshot;
  const exposure = run.evaluation.policy.finalPolicyExposureCalls;
  if (snapshot === null || exposure === null || exposure <= 0) {
    throw new Error("Cannot project a non-eligible Run into a cross-project synthesis packet.");
  }
  const selections = finalPolicySelections(snapshot);
  const approach = selections[0]!;
  if (approach.kind !== "approach") throw new Error("Final Policy approach has the wrong Strategy kind.");
  return Object.freeze({
    sourceRef: Object.freeze({ ...run.ref }),
    recordedAt: run.evaluation.source.recordedAt,
    taskGoal: boundedTaskGoal(run.evaluation.source.taskGoal),
    exactTaskGoalDigest: exactStringDigest(run.evaluation.source.taskGoal),
    finalPolicy: Object.freeze({
      policyIdentity: policySnapshotIdentity(snapshot),
      policyProfileId: policyProfile(run),
      approach: freezePolicySelection(approach),
      modifiers: Object.freeze(snapshot.modifiers.map(freezePolicySelection)),
    }),
    declarationCount: run.evaluation.policy.declarationCount,
    finalPolicyDeclarationCount: run.evaluation.policy.finalPolicyDeclarationCount,
    finalPolicyFirstDeclarationProgress: run.evaluation.policy.finalPolicyFirstDeclarationProgress,
    finalPolicyLastActivationProgress: run.evaluation.policy.finalPolicyLastActivationProgress,
    finalPolicyExposureCalls: exposure,
    finalPolicyExposureRatio: run.evaluation.policy.finalPolicyExposureRatio,
    verificationPassed: run.evaluation.outcome.verificationPassed,
    completedDuringRun: run.evaluation.outcome.completedDuringRun,
    hasBlockers: run.evaluation.outcome.hasBlockers,
    hasQuestions: run.evaluation.outcome.hasQuestions,
    humanGateOpen: run.evaluation.outcome.humanGateOpen,
    toolErrors: run.evaluation.execution.toolErrors,
    deniedCalls: run.evaluation.execution.deniedCalls,
    durationMs: run.evaluation.metrics.durationMs,
    cost: run.evaluation.metrics.cost,
  });
}

function emptySufficiency(): CrossProjectSynthesisSufficiency {
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    distinctQualifiedExperienceRefCount: 0,
    distinctProjectIdCount: 0,
    distinctExactTaskGoalCount: 0,
    distinctPolicyEvidenceProfileCount: 0,
    sufficient: false,
  });
}

function createSufficiency(
  runs: readonly CrossProjectSynthesisEligibleRun[],
): CrossProjectSynthesisSufficiency {
  const refs = new Set<string>();
  const projects = new Set<string>();
  const goals = new Set<string>();
  const profiles = new Set<string>();
  for (const run of runs) {
    refs.add(refKey(run.ref));
    projects.add(run.ref.projectId);
    goals.add(run.evaluation.source.taskGoal);
    profiles.add(policyProfile(run));
  }
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    distinctQualifiedExperienceRefCount: refs.size,
    distinctProjectIdCount: projects.size,
    distinctExactTaskGoalCount: goals.size,
    distinctPolicyEvidenceProfileCount: profiles.size,
    sufficient: refs.size >= MIN_CROSS_PROJECT_SYNTHESIS_SOURCE_RECORDS &&
      projects.size >= MIN_CROSS_PROJECT_SYNTHESIS_PROJECTS &&
      goals.size >= MIN_CROSS_PROJECT_SYNTHESIS_GOALS &&
      profiles.size >= MIN_CROSS_PROJECT_SYNTHESIS_POLICY_PROFILES,
  });
}

function normalizeEligibleRuns(
  eligible: readonly CrossProjectSynthesisEligibleRun[],
): readonly CrossProjectSynthesisEligibleRun[] {
  const locatorCounts = new Map<string, number>();
  for (const run of eligible) {
    const locator = locatorKey(run.ref);
    locatorCounts.set(locator, (locatorCounts.get(locator) ?? 0) + 1);
  }
  return Object.freeze([...eligible]
    .filter((run) => locatorCounts.get(locatorKey(run.ref)) === 1)
    .sort(compareStableRuns));
}

function runProjectCounts(runs: readonly CrossProjectSynthesisEligibleRun[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.ref.projectId, (counts.get(run.ref.projectId) ?? 0) + 1);
  return counts;
}

function witnessFromCandidates(
  candidates: readonly CrossProjectSynthesisEligibleRun[],
): readonly CrossProjectSynthesisEligibleRun[] | null {
  for (let left = 0; left < candidates.length - 2; left += 1) {
    for (let middle = left + 1; middle < candidates.length - 1; middle += 1) {
      for (let right = middle + 1; right < candidates.length; right += 1) {
        const witness = [candidates[left]!, candidates[middle]!, candidates[right]!];
        const counts = runProjectCounts(witness);
        if ([...counts.values()].some((count) => count > MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT)) {
          continue;
        }
        if (createSufficiency(witness).sufficient) return Object.freeze(witness);
      }
    }
  }
  return null;
}

function findSufficientWitness(
  ordered: readonly CrossProjectSynthesisEligibleRun[],
): readonly CrossProjectSynthesisEligibleRun[] | null {
  // Sufficiency is intentionally searched before recency fill. A pair that
  // differs in both goal and Policy profile is not guaranteed to exist even
  // when the pool has both dimensions (for example, the three corners of a
  // two-by-two grid). Start with a small deterministic diversity reservoir so
  // large historical pools do not require a cubic search in the usual case.
  const anchor = ordered[0]!;
  const reservoir = new Map<string, CrossProjectSynthesisEligibleRun>();
  const add = (run: CrossProjectSynthesisEligibleRun): void => {
    reservoir.set(refKey(run.ref), run);
  };
  add(anchor);
  add(ordered.at(-1)!);
  const dimensions: readonly ((run: CrossProjectSynthesisEligibleRun) => string)[] = [
    (run) => run.ref.projectId,
    (run) => run.evaluation.source.taskGoal,
    policyProfile,
  ];
  for (const dimension of dimensions) {
    const anchorValue = dimension(anchor);
    const values = new Set<string>([anchorValue]);
    for (const run of ordered) {
      const value = dimension(run);
      if (values.has(value)) continue;
      values.add(value);
      add(run);
      if (values.size >= 3) break;
    }
  }
  const fastWitness = witnessFromCandidates([...reservoir.values()]);
  if (fastWitness !== null) return fastWitness;

  // The fallback preserves the guarantee for adversarial distributions that
  // place the only valid witness outside the small reservoir.
  return witnessFromCandidates(ordered);
}

/** Compute the four deterministic factual discovery-gate counts. */
export function deriveCrossProjectSynthesisSufficiency(
  runs: readonly CrossProjectSynthesisEligibleRun[],
): CrossProjectSynthesisSufficiency {
  return createSufficiency(runs);
}

export const deriveCrossProjectSynthesisEvidenceSufficiency = deriveCrossProjectSynthesisSufficiency;

/**
 * Select a deterministic sufficient witness before applying packet capacity.
 * Duplicate qualified locators are excluded rather than resolved by order.
 */
export function selectBoundedCrossProjectSynthesisEvidence(
  eligible: readonly CrossProjectSynthesisEligibleRun[],
): CrossProjectSynthesisSelection {
  const ordered = normalizeEligibleRuns(eligible);
  const poolSufficiency = createSufficiency(ordered);
  if (!poolSufficiency.sufficient) {
    return Object.freeze({
      version: CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION,
      maxRuns: MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS,
      maxRunsPerProject: MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT,
      ordering: ORDERING_DESCRIPTION,
      poolSufficiency,
      shownSufficiency: emptySufficiency(),
      eligible: ordered,
      shown: Object.freeze([]),
    });
  }

  const shown: CrossProjectSynthesisEligibleRun[] = [];
  const selected = new Set<string>();
  const add = (run: CrossProjectSynthesisEligibleRun): void => {
    if (shown.length >= MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS) return;
    if (selected.has(refKey(run.ref))) return;
    if ((runProjectCounts(shown).get(run.ref.projectId) ?? 0) >= MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT) return;
    shown.push(run);
    selected.add(refKey(run.ref));
  };

  const witness = findSufficientWitness(ordered);
  if (witness === null) {
    throw new Error("Cross-project synthesis implementation error: a sufficient pool has no bounded witness.");
  }
  for (const run of witness) add(run);

  if (!createSufficiency(shown).sufficient) {
    throw new Error("Cross-project synthesis implementation error: the bounded witness is insufficient.");
  }

  const outcomeSignatures = new Set(shown.map(outcomeSignature));
  const goals = new Set(shown.map((run) => run.evaluation.source.taskGoal));
  const profiles = new Set(shown.map(policyProfile));
  while (shown.length < MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS) {
    const counts = runProjectCounts(shown);
    const candidate = ordered
      .filter((run) => !selected.has(refKey(run.ref)))
      .filter((run) => (counts.get(run.ref.projectId) ?? 0) < MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT)
      .sort((left, right) => {
        const leftCount = counts.get(left.ref.projectId) ?? 0;
        const rightCount = counts.get(right.ref.projectId) ?? 0;
        if (leftCount !== rightCount) return leftCount - rightCount;
        const leftOutcome = outcomeSignatures.has(outcomeSignature(left)) ? 1 : 0;
        const rightOutcome = outcomeSignatures.has(outcomeSignature(right)) ? 1 : 0;
        if (leftOutcome !== rightOutcome) return leftOutcome - rightOutcome;
        const leftGoal = goals.has(left.evaluation.source.taskGoal) ? 1 : 0;
        const rightGoal = goals.has(right.evaluation.source.taskGoal) ? 1 : 0;
        if (leftGoal !== rightGoal) return leftGoal - rightGoal;
        const leftProfile = profiles.has(policyProfile(left)) ? 1 : 0;
        const rightProfile = profiles.has(policyProfile(right)) ? 1 : 0;
        if (leftProfile !== rightProfile) return leftProfile - rightProfile;
        return compareStableRuns(left, right);
      })[0];
    if (candidate === undefined) break;
    add(candidate);
    outcomeSignatures.add(outcomeSignature(candidate));
    goals.add(candidate.evaluation.source.taskGoal);
    profiles.add(policyProfile(candidate));
  }

  const shownFrozen = Object.freeze([...shown]);
  const shownSufficiency = createSufficiency(shownFrozen);
  if (!shownSufficiency.sufficient) {
    throw new Error("Cross-project synthesis implementation error: selected evidence became insufficient.");
  }
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION,
    maxRuns: MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS,
    maxRunsPerProject: MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT,
    ordering: ORDERING_DESCRIPTION,
    poolSufficiency,
    shownSufficiency,
    eligible: ordered,
    shown: shownFrozen,
  });
}

export const selectCrossProjectSynthesisEvidence = selectBoundedCrossProjectSynthesisEvidence;
export const selectCrossProjectSynthesisRuns = selectBoundedCrossProjectSynthesisEvidence;

function validateProjectIds(projectIds: readonly string[]): readonly string[] {
  const validated = projectIds.map((projectId) => {
    if (!isCanonicalCrossProjectProjectId(projectId)) {
      throw new Error("Cross-project Experience namespace enumeration returned a non-canonical project identity.");
    }
    return projectId;
  });
  if (new Set(validated).size !== validated.length) {
    throw new Error("Cross-project Experience namespace enumeration returned a duplicate project identity.");
  }
  return Object.freeze([...validated].sort(compareText));
}

/**
 * Scan live project-local Experience and owning-project trust facts without
 * writing any artifact or inferring a foreign repository root.
 */
export async function scanCrossProjectSynthesisEvidence(
  input: CrossProjectSynthesisScanInput,
): Promise<CrossProjectSynthesisEvidenceScan> {
  const projectIds = validateProjectIds(await input.experienceReader.listProjectIds());
  const eligible: CrossProjectSynthesisEligibleRun[] = [];
  const projectTrust: CrossProjectSynthesisProjectTrust[] = [];
  const inventories: CrossProjectSynthesisProjectInventory[] = [];

  for (const projectId of projectIds) {
    let read: RunExperienceReadResult;
    try {
      read = validateReadResult(await input.experienceReader.readProjectId(projectId));
    } catch (error) {
      throw new Error(`Cross-project synthesis Experience scan failed for project '${projectId}': ${boundedDiagnostic(error)}`);
    }

    let portfolio: TrustedStrategyPortfolio | null = null;
    let trustFailure: string | null = null;
    try {
      portfolio = validatePortfolioForProject(
        await input.trustedPortfolioReader.readProjectId(projectId),
        projectId,
      );
      projectTrust.push(Object.freeze({ projectId, portfolio }));
    } catch (error) {
      trustFailure = boundedDiagnostic(error);
    }

    const rawRecords = [...read.records] as readonly unknown[];
    const locatorCounts = new Map<string, number>();
    for (const raw of rawRecords) {
      if (!isRecord(raw) || typeof raw.recordId !== "string") continue;
      locatorCounts.set(raw.recordId, (locatorCounts.get(raw.recordId) ?? 0) + 1);
    }
    const duplicateRecordLocatorCount = [...locatorCounts.values()].filter((count) => count > 1).length;
    let localInvalid = 0;
    let validUniqueRecordCount = 0;
    let projectEligibleCount = 0;
    for (const raw of rawRecords) {
      if (!isRecord(raw) || typeof raw.recordId !== "string" ||
        !isCanonicalCrossProjectExperienceRecordId(raw.recordId)) {
        localInvalid += 1;
        continue;
      }
      // Ambiguous locators are reported separately and never enter either
      // the valid or invalid record count; neither duplicate can become a
      // source ref by order of appearance.
      if ((locatorCounts.get(raw.recordId) ?? 0) !== 1) continue;
      const experience = parseRunExperience(raw.experience);
      if (experience === null) {
        localInvalid += 1;
        continue;
      }
      validUniqueRecordCount += 1;
      if (portfolio === null) continue;
      const ref = createCrossProjectExperienceRef({
        projectId,
        recordId: raw.recordId,
        experience,
      });
      const evaluation = evaluateRunExperience({ recordId: raw.recordId, experience });
      let qualifies = false;
      try {
        qualifies = finalPolicyUsesOnlyTrustedRevisions(evaluation, portfolio);
      } catch {
        qualifies = false;
      }
      if (!qualifies) continue;
      projectEligibleCount += 1;
      eligible.push(Object.freeze({ ref, evaluation }));
    }
    const invalidRecordCount = read.invalid + localInvalid;
    const ineligibleRunCount = Math.max(0, validUniqueRecordCount - projectEligibleCount);
    inventories.push(Object.freeze({
      projectId,
      loadedRecordCount: read.loadedRecords,
      unsupportedSchemaCount: read.unsupportedSchema,
      invalidRecordCount,
      duplicateRecordLocatorCount,
      validUniqueRecordCount,
      eligibleRunCount: projectEligibleCount,
      ineligibleRunCount,
      trustAvailable: portfolio !== null,
      trustFailure,
    }));
  }

  const sortedEligible = normalizeEligibleRuns(eligible);
  const inventory = Object.freeze({
    projectCount: inventories.length,
    loadedRecordCount: inventories.reduce((sum, value) => sum + value.loadedRecordCount, 0),
    unsupportedSchemaCount: inventories.reduce((sum, value) => sum + value.unsupportedSchemaCount, 0),
    invalidRecordCount: inventories.reduce((sum, value) => sum + value.invalidRecordCount, 0),
    duplicateRecordLocatorCount: inventories.reduce((sum, value) => sum + value.duplicateRecordLocatorCount, 0),
    validUniqueRecordCount: inventories.reduce((sum, value) => sum + value.validUniqueRecordCount, 0),
    eligibleRunCount: sortedEligible.length,
    ineligibleRunCount: inventories.reduce((sum, value) => sum + value.ineligibleRunCount, 0),
    projects: Object.freeze([...inventories].sort((left, right) => compareText(left.projectId, right.projectId))),
  });
  return Object.freeze({
    projectIds,
    eligible: sortedEligible,
    inventory,
    projectTrust: Object.freeze([...projectTrust].sort((left, right) => compareText(left.projectId, right.projectId))),
  });
}

export const discoverCrossProjectSynthesisEvidence = scanCrossProjectSynthesisEvidence;
export const scanCrossProjectSynthesis = scanCrossProjectSynthesisEvidence;

function copyTrustedEntry(
  projectId: string,
  entry: TrustedPortfolioResolvedEntry,
): CrossProjectSynthesisTrustedStrategy {
  const defaultOrigins: readonly TrustedPortfolioTrustOrigin[] = entry.manifest.origin === "seed"
    ? ["seed"]
    : ["project-local"];
  const trustOrigins = entry.trust?.origins ?? defaultOrigins;
  const sourceProjectIds = entry.trust?.sourceProjectIds ?? [];
  return Object.freeze({
    projectId,
    origin: entry.manifest.origin,
    strategyId: entry.manifest.strategyId,
    kind: entry.manifest.kind,
    revisionIdentity: entry.manifest.revisionIdentity,
    revisionFingerprint: entry.manifest.revisionFingerprint,
    trustOrigins: Object.freeze([...trustOrigins]),
    sourceProjectIds: Object.freeze([...sourceProjectIds]),
    semantics: Object.freeze({
      summary: entry.semantics.summary,
      useWhen: Object.freeze([...entry.semantics.useWhen]),
      avoidWhen: Object.freeze([...entry.semantics.avoidWhen]),
      principles: Object.freeze([...entry.semantics.principles]),
    }),
  });
}

function manifestComparisonKey(entry: CrossProjectSynthesisTrustedStrategy): string {
  return [
    entry.origin,
    entry.strategyId,
    entry.kind,
    entry.revisionIdentity,
    entry.revisionFingerprint,
  ].join("\0");
}

function buildTrustedComparisonContext(
  selection: CrossProjectSynthesisSelection,
  scan: CrossProjectSynthesisEvidenceScan,
): readonly CrossProjectSynthesisTrustedProjectContext[] {
  const represented = new Set(selection.shown.map((run) => run.ref.projectId));
  const contexts = scan.projectTrust
    .filter((item) => represented.has(item.projectId))
    .sort((left, right) => compareText(left.projectId, right.projectId))
    .map((item) => {
      const trustedStrategies = item.portfolio.resolvedEntries
        .map((entry) => copyTrustedEntry(item.projectId, entry))
        .sort((left, right) => compareText(manifestComparisonKey(left), manifestComparisonKey(right)));
      return Object.freeze({
        projectId: item.projectId,
        portfolioFingerprintVersion: 1 as const,
        portfolioFingerprint: item.portfolio.fingerprint,
        trustedStrategies: Object.freeze(trustedStrategies),
      });
    });
  if (contexts.length !== represented.size) {
    throw new Error("Cross-project synthesis implementation error: shown evidence lacks complete trust comparison context.");
  }
  const totalEntries = contexts.reduce((sum, context) => sum + context.trustedStrategies.length, 0);
  if (contexts.length > MAX_CROSS_PROJECT_SYNTHESIS_COMPARISON_PROJECTS ||
    totalEntries > MAX_CROSS_PROJECT_SYNTHESIS_COMPARISON_ENTRIES) {
    throw new Error("Cross-project synthesis trusted comparison context exceeds its bounded packet.");
  }
  return Object.freeze(contexts);
}

function copySufficiency(
  value: CrossProjectSynthesisSufficiency,
): CrossProjectSynthesisSufficiency {
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    distinctQualifiedExperienceRefCount: value.distinctQualifiedExperienceRefCount,
    distinctProjectIdCount: value.distinctProjectIdCount,
    distinctExactTaskGoalCount: value.distinctExactTaskGoalCount,
    distinctPolicyEvidenceProfileCount: value.distinctPolicyEvidenceProfileCount,
    sufficient: value.sufficient,
  });
}

function copyInventory(
  inventory: CrossProjectSynthesisInventory,
): CrossProjectSynthesisInventory {
  return Object.freeze({
    projectCount: inventory.projectCount,
    loadedRecordCount: inventory.loadedRecordCount,
    unsupportedSchemaCount: inventory.unsupportedSchemaCount,
    invalidRecordCount: inventory.invalidRecordCount,
    duplicateRecordLocatorCount: inventory.duplicateRecordLocatorCount,
    validUniqueRecordCount: inventory.validUniqueRecordCount,
    eligibleRunCount: inventory.eligibleRunCount,
    ineligibleRunCount: inventory.ineligibleRunCount,
    projects: Object.freeze(inventory.projects.map((project) => Object.freeze({
      projectId: project.projectId,
      loadedRecordCount: project.loadedRecordCount,
      unsupportedSchemaCount: project.unsupportedSchemaCount,
      invalidRecordCount: project.invalidRecordCount,
      duplicateRecordLocatorCount: project.duplicateRecordLocatorCount,
      validUniqueRecordCount: project.validUniqueRecordCount,
      eligibleRunCount: project.eligibleRunCount,
      ineligibleRunCount: project.ineligibleRunCount,
      trustAvailable: project.trustAvailable,
      trustFailure: project.trustFailure,
    }))),
  });
}

function packetFingerprintProjection(
  packet: Omit<CrossProjectSynthesisPacket, "packetFingerprint">,
): Record<string, unknown> {
  return {
    packetVersion: packet.packetVersion,
    selectionVersion: packet.selectionVersion,
    sufficiencyVersion: packet.sufficiencyVersion,
    capturedAt: packet.capturedAt,
    selection: packet.selection,
    sourceRefs: packet.sourceRefs,
    evidence: packet.evidence,
    sufficiency: packet.sufficiency,
    inventory: packet.inventory,
    trustedStrategyComparison: packet.trustedStrategyComparison,
    boundaryText: packet.boundaryText,
  };
}

/** Compute the deterministic fingerprint of the complete immutable packet. */
export function crossProjectSynthesisPacketFingerprint(
  packet: CrossProjectSynthesisPacket | Omit<CrossProjectSynthesisPacket, "packetFingerprint">,
): string {
  const { packetFingerprint: _ignored, ...withoutFingerprint } = packet as CrossProjectSynthesisPacket;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(packetFingerprintProjection(withoutFingerprint)))
    .digest("hex")}`;
}

export const computeCrossProjectSynthesisPacketFingerprint = crossProjectSynthesisPacketFingerprint;

/** Recompute the shown-set gate from the bounded packet projection. */
export function recomputeCrossProjectSynthesisPacketSufficiency(
  packet: CrossProjectSynthesisPacket,
): CrossProjectSynthesisSufficiency {
  const refs = new Set<string>();
  const projects = new Set<string>();
  const goals = new Set<string>();
  const profiles = new Set<string>();
  for (const run of packet.evidence.runs) {
    refs.add(refKey(run.sourceRef));
    projects.add(run.sourceRef.projectId);
    goals.add(run.exactTaskGoalDigest);
    profiles.add(run.finalPolicy.policyProfileId);
  }
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    distinctQualifiedExperienceRefCount: refs.size,
    distinctProjectIdCount: projects.size,
    distinctExactTaskGoalCount: goals.size,
    distinctPolicyEvidenceProfileCount: profiles.size,
    sufficient: refs.size >= MIN_CROSS_PROJECT_SYNTHESIS_SOURCE_RECORDS &&
      projects.size >= MIN_CROSS_PROJECT_SYNTHESIS_PROJECTS &&
      goals.size >= MIN_CROSS_PROJECT_SYNTHESIS_GOALS &&
      profiles.size >= MIN_CROSS_PROJECT_SYNTHESIS_POLICY_PROFILES,
  });
}

export const recomputeCrossProjectSynthesisShownSufficiency = recomputeCrossProjectSynthesisPacketSufficiency;

/** Build the frozen, bounded, read-only packet for a later synthesis Run. */
export function buildCrossProjectSynthesisPacket(
  input: BuildCrossProjectSynthesisPacketInput,
): CrossProjectSynthesisPacket {
  const capturedAt = validateCapturedAt(input.capturedAt);
  const selection = selectBoundedCrossProjectSynthesisEvidence(input.scan.eligible);
  if (!selection.poolSufficiency.sufficient || !selection.shownSufficiency.sufficient) {
    throw new Error("Cross-project synthesis evidence is insufficient for a bounded packet.");
  }
  const runs = Object.freeze(selection.shown.map(projectRun));
  const poolSufficiency = copySufficiency(selection.poolSufficiency);
  const shownSufficiency = copySufficiency(selection.shownSufficiency);
  const trustedStrategyComparison = buildTrustedComparisonContext(selection, input.scan);
  const packetWithoutFingerprint: Omit<CrossProjectSynthesisPacket, "packetFingerprint"> = Object.freeze({
    packetVersion: CROSS_PROJECT_SYNTHESIS_PACKET_VERSION,
    selectionVersion: CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION,
    sufficiencyVersion: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    capturedAt,
    selection: Object.freeze({
      version: CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION,
      maxRuns: MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS,
      maxRunsPerProject: MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT,
      ordering: ORDERING_DESCRIPTION,
    }),
    sourceRefs: Object.freeze(runs.map((run) => Object.freeze({ ...run.sourceRef }))),
    evidence: Object.freeze({
      eligibleRunCount: selection.eligible.length,
      shownRunCount: runs.length,
      omittedRunCount: selection.eligible.length - runs.length,
      poolSufficiency,
      runs,
    }),
    sufficiency: shownSufficiency,
    inventory: copyInventory(input.scan.inventory),
    trustedStrategyComparison,
    boundaryText: DISCOVERY_BOUNDARY_TEXT,
  });
  const recomputed = recomputeCrossProjectSynthesisPacketSufficiency({
    ...packetWithoutFingerprint,
    packetFingerprint: "sha256:" + "0".repeat(64),
  });
  if (JSON.stringify(recomputed) !== JSON.stringify(shownSufficiency)) {
    throw new Error("Cross-project synthesis implementation error: packet shown sufficiency changed during projection.");
  }
  const packet = Object.freeze({
    ...packetWithoutFingerprint,
    packetFingerprint: crossProjectSynthesisPacketFingerprint(packetWithoutFingerprint),
  });
  return packet;
}

export const buildCrossProjectSynthesisEvidencePacket = buildCrossProjectSynthesisPacket;
export const buildCrossProjectSynthesisDiscoveryPacket = buildCrossProjectSynthesisPacket;

/** Deterministic model-facing handle for one shown packet Run. */
export function crossProjectSynthesisEvidenceHandle(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS) {
    throw new Error("Cross-project synthesis evidence handle index is out of bounds.");
  }
  return `E${index + 1}`;
}

/** Resolve a canonical model-facing packet evidence handle without I/O. */
export function crossProjectSynthesisEvidenceHandleIndex(value: unknown): number | null {
  if (typeof value !== "string" || !/^E[1-9][0-9]*$/u.test(value)) return null;
  const index = Number(value.slice(1)) - 1;
  return Number.isSafeInteger(index) && index >= 0 && index < MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS
    ? index
    : null;
}

/** Return the exact qualified ref addressed by a shown packet Run index. */
export function crossProjectSynthesisPacketEvidenceRef(
  packet: CrossProjectSynthesisPacket,
  index: number,
): CrossProjectExperienceRefV1 {
  validateCrossProjectSynthesisPacket(packet);
  const run = packet.evidence.runs[index];
  if (run === undefined) throw new Error("Cross-project synthesis packet evidence handle is not present.");
  return Object.freeze({ ...run.sourceRef });
}

/** Derive a citation-only discovery gate from the frozen packet projections. */
export function deriveCrossProjectSynthesisCitationSufficiency(
  packet: CrossProjectSynthesisPacket,
  refs: readonly CrossProjectExperienceRefV1[],
): CrossProjectSynthesisSufficiency {
  validateCrossProjectSynthesisPacket(packet);
  const citedKeys = new Set(refs.map((ref) => refKey(validateCrossProjectExperienceRefArtifact(ref))));
  const runs = packet.evidence.runs.filter((run) => citedKeys.has(refKey(run.sourceRef)));
  const matchedKeys = new Set(runs.map((run) => refKey(run.sourceRef)));
  const projects = new Set(runs.map((run) => run.sourceRef.projectId));
  const goals = new Set(runs.map((run) => run.exactTaskGoalDigest));
  const profiles = new Set(runs.map((run) => run.finalPolicy.policyProfileId));
  return Object.freeze({
    version: CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION,
    distinctQualifiedExperienceRefCount: matchedKeys.size,
    distinctProjectIdCount: projects.size,
    distinctExactTaskGoalCount: goals.size,
    distinctPolicyEvidenceProfileCount: profiles.size,
    sufficient: matchedKeys.size >= MIN_CROSS_PROJECT_SYNTHESIS_SOURCE_RECORDS &&
      projects.size >= MIN_CROSS_PROJECT_SYNTHESIS_PROJECTS &&
      goals.size >= MIN_CROSS_PROJECT_SYNTHESIS_GOALS &&
      profiles.size >= MIN_CROSS_PROJECT_SYNTHESIS_POLICY_PROFILES,
  });
}

export const deriveCrossProjectSynthesisCandidateSufficiency = deriveCrossProjectSynthesisCitationSufficiency;

function validatePacketSufficiency(
  value: unknown,
  label: string,
): CrossProjectSynthesisSufficiency {
  if (!isRecord(value)) {
    throw new Error(`Cross-project synthesis packet ${label} sufficiency is malformed.`);
  }
  const distinctQualifiedExperienceRefCount = value.distinctQualifiedExperienceRefCount;
  const distinctProjectIdCount = value.distinctProjectIdCount;
  const distinctExactTaskGoalCount = value.distinctExactTaskGoalCount;
  const distinctPolicyEvidenceProfileCount = value.distinctPolicyEvidenceProfileCount;
  if (value.version !== CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION ||
    typeof distinctQualifiedExperienceRefCount !== "number" ||
    !Number.isSafeInteger(distinctQualifiedExperienceRefCount) ||
    distinctQualifiedExperienceRefCount < 0 ||
    typeof distinctProjectIdCount !== "number" ||
    !Number.isSafeInteger(distinctProjectIdCount) ||
    distinctProjectIdCount < 0 ||
    typeof distinctExactTaskGoalCount !== "number" ||
    !Number.isSafeInteger(distinctExactTaskGoalCount) ||
    distinctExactTaskGoalCount < 0 ||
    typeof distinctPolicyEvidenceProfileCount !== "number" ||
    !Number.isSafeInteger(distinctPolicyEvidenceProfileCount) ||
    distinctPolicyEvidenceProfileCount < 0 ||
    typeof value.sufficient !== "boolean") {
    throw new Error(`Cross-project synthesis packet ${label} sufficiency is malformed.`);
  }
  return value as unknown as CrossProjectSynthesisSufficiency;
}

function sameExperienceRef(
  left: CrossProjectExperienceRefV1,
  right: CrossProjectExperienceRefV1,
): boolean {
  return left.projectId === right.projectId &&
    left.recordId === right.recordId &&
    left.recordFingerprint === right.recordFingerprint;
}

/** Validate packet binding facts without resolving live Experience or trust. */
export function validateCrossProjectSynthesisPacket(
  packet: CrossProjectSynthesisPacket,
): CrossProjectSynthesisPacket {
  if (!isRecord(packet) ||
    packet.packetVersion !== CROSS_PROJECT_SYNTHESIS_PACKET_VERSION ||
    packet.selectionVersion !== CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION ||
    packet.sufficiencyVersion !== CROSS_PROJECT_SYNTHESIS_SUFFICIENCY_VERSION ||
    !isRecord(packet.selection) ||
    packet.selection.version !== CROSS_PROJECT_SYNTHESIS_SELECTION_VERSION ||
    packet.selection.maxRuns !== MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS ||
    packet.selection.maxRunsPerProject !== MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT ||
    packet.selection.ordering !== ORDERING_DESCRIPTION ||
    !isRecord(packet.evidence) ||
    !Array.isArray(packet.sourceRefs) ||
    !Array.isArray(packet.evidence.runs) ||
    !Array.isArray(packet.trustedStrategyComparison) ||
    packet.boundaryText !== DISCOVERY_BOUNDARY_TEXT ||
    !isCanonicalCrossProjectExperienceFingerprint(packet.packetFingerprint)) {
    throw new Error("Cross-project synthesis packet structure or binding is invalid.");
  }
  validateCapturedAt(packet.capturedAt);
  const poolSufficiency = validatePacketSufficiency(packet.evidence.poolSufficiency, "pool");
  validatePacketSufficiency(packet.sufficiency, "shown");
  if (packet.evidence.runs.length > MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS ||
    packet.sourceRefs.length !== packet.evidence.runs.length ||
    packet.evidence.shownRunCount !== packet.evidence.runs.length ||
    !Number.isSafeInteger(packet.evidence.eligibleRunCount) ||
    packet.evidence.eligibleRunCount < packet.evidence.runs.length ||
    packet.evidence.omittedRunCount !== packet.evidence.eligibleRunCount - packet.evidence.runs.length ||
    !poolSufficiency.sufficient) {
    throw new Error("Cross-project synthesis packet evidence bounds are invalid.");
  }
  const perProject = new Map<string, number>();
  const locators = new Set<string>();
  for (const [index, run] of packet.evidence.runs.entries()) {
    if (!isRecord(run) || !isRecord(run.sourceRef)) {
      throw new Error("Cross-project synthesis packet contains a malformed Run projection.");
    }
    const ref = validateCrossProjectExperienceRefArtifact(run.sourceRef);
    const sourceRef = validateCrossProjectExperienceRefArtifact(packet.sourceRefs[index]);
    if (!sameExperienceRef(ref, sourceRef) ||
      typeof run.exactTaskGoalDigest !== "string" ||
      !isCanonicalCrossProjectExperienceFingerprint(run.exactTaskGoalDigest)) {
      throw new Error("Cross-project synthesis packet Run binding is invalid.");
    }
    const locator = locatorKey(ref);
    if (locators.has(locator)) throw new Error("Cross-project synthesis packet contains duplicate Experience locators.");
    locators.add(locator);
    perProject.set(ref.projectId, (perProject.get(ref.projectId) ?? 0) + 1);
    if ((perProject.get(ref.projectId) ?? 0) > MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT) {
      throw new Error("Cross-project synthesis packet exceeds its per-project Run bound.");
    }
  }
  const recomputed = recomputeCrossProjectSynthesisPacketSufficiency(packet);
  if (JSON.stringify(recomputed) !== JSON.stringify(packet.sufficiency) ||
    !packet.sufficiency.sufficient) {
    throw new Error("Cross-project synthesis packet shown-set sufficiency is invalid.");
  }
  if (crossProjectSynthesisPacketFingerprint(packet) !== packet.packetFingerprint) {
    throw new Error("Cross-project synthesis packet fingerprint does not match its immutable contents.");
  }
  return packet;
}

function formatRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "n/a" : String(value);
}

function formatSelection(selection: CrossProjectSynthesisPolicySelection): string {
  return `${selection.strategyId} (${selection.kind}; revision ${selection.revisionIdentity}; fingerprint ${selection.revisionFingerprint}; status ${selection.revisionStatusAtRun})`;
}

/** Render only the bounded frozen packet; no live project evidence is read. */
export function formatCrossProjectSynthesisPacket(
  packet: CrossProjectSynthesisPacket,
): string {
  validateCrossProjectSynthesisPacket(packet);
  const lines = [
    "<PINDIE_CROSS_PROJECT_SYNTHESIS_PACKET>",
    "This is a frozen, read-only cross-project discovery packet. It is not a project implementation Task.",
    "Inspect only this bounded factual evidence and optionally propose one inactive missing-abstraction hypothesis in a later explicit synthesis Run.",
    "",
    "Packet binding:",
    `- Packet version: ${packet.packetVersion}`,
    `- Selection version: ${packet.selectionVersion}`,
    `- Sufficiency version: ${packet.sufficiencyVersion}`,
    `- Captured at: ${packet.capturedAt}`,
    `- Packet fingerprint: ${packet.packetFingerprint}`,
    `- Selection ordering: ${packet.selection.ordering}`,
    "",
    "Trust comparison context:",
  ];
  for (const context of packet.trustedStrategyComparison) {
    lines.push(
      `- Project namespace: ${context.projectId}`,
      `  Portfolio fingerprint version: ${context.portfolioFingerprintVersion}`,
      `  Portfolio fingerprint: ${context.portfolioFingerprint}`,
    );
    for (const entry of context.trustedStrategies) {
      lines.push(
        `  - ${entry.strategyId} (${entry.kind}; ${entry.origin})`,
        `    Revision identity: ${entry.revisionIdentity}`,
        `    Revision fingerprint: ${entry.revisionFingerprint}`,
        `    Trust origins: ${entry.trustOrigins.join(" + ")}`,
        `    Trusted project namespace: ${entry.projectId}`,
        ...(entry.sourceProjectIds.length === 0
          ? []
          : [`    Source project namespaces: ${entry.sourceProjectIds.join(", ")}`]),
        `    Summary: ${entry.semantics.summary}`,
        "    Use when:",
        ...entry.semantics.useWhen.map((value) => `      - ${value}`),
        "    Avoid when:",
        ...(entry.semantics.avoidWhen.length === 0
          ? ["      - none"]
          : entry.semantics.avoidWhen.map((value) => `      - ${value}`)),
        "    Principles:",
        ...entry.semantics.principles.map((value) => `      - ${value}`),
      );
    }
  }
  lines.push(
    "",
    "Discovery inventory:",
    `- Project namespaces scanned: ${packet.inventory.projectCount}`,
    `- Loaded schema-v4 Runs: ${packet.inventory.loadedRecordCount}`,
    `- Unsupported-schema records: ${packet.inventory.unsupportedSchemaCount}`,
    `- Malformed/invalid records: ${packet.inventory.invalidRecordCount}`,
    `- Ambiguous duplicate locators excluded: ${packet.inventory.duplicateRecordLocatorCount}`,
    `- Eligible Runs: ${packet.evidence.eligibleRunCount}`,
    `- Shown Runs: ${packet.evidence.shownRunCount}`,
    `- Omitted eligible Runs: ${packet.evidence.omittedRunCount}`,
    "",
    "Shown qualified Experience Runs:",
  );
  for (const [index, run] of packet.evidence.runs.entries()) {
    lines.push(
      `- Evidence handle: ${crossProjectSynthesisEvidenceHandle(index)}`,
      `  Source: ${run.sourceRef.projectId}/${run.sourceRef.recordId}`,
      `  Record fingerprint: ${run.sourceRef.recordFingerprint}`,
      `  Recorded at: ${run.recordedAt}`,
      `  Task goal: ${run.taskGoal}`,
      `  Exact Task goal digest: ${run.exactTaskGoalDigest}`,
      `  Policy identity: ${run.finalPolicy.policyIdentity}`,
      `  Policy Evidence Profile identity: ${run.finalPolicy.policyProfileId}`,
      `  Final approach: ${formatSelection(run.finalPolicy.approach)}`,
      `  Final modifiers: ${run.finalPolicy.modifiers.length === 0
        ? "none"
        : run.finalPolicy.modifiers.map(formatSelection).join("; ")}`,
      `  Policy declarations: ${run.declarationCount}`,
      `  Final-Policy declarations: ${run.finalPolicyDeclarationCount}`,
      `  First final-Policy declaration progress: ${formatRatio(run.finalPolicyFirstDeclarationProgress)}`,
      `  Last final-Policy activation progress: ${formatRatio(run.finalPolicyLastActivationProgress)}`,
      `  Continuous final-Policy exposure calls: ${run.finalPolicyExposureCalls}`,
      `  Continuous final-Policy exposure ratio: ${formatRatio(run.finalPolicyExposureRatio)}`,
      `  Verification passed: ${run.verificationPassed}`,
      `  Completed during Run: ${run.completedDuringRun}`,
      `  Blockers: ${run.hasBlockers}`,
      `  Questions: ${run.hasQuestions}`,
      `  Human Gate open: ${run.humanGateOpen}`,
      `  Tool errors: ${run.toolErrors}`,
      `  Denied calls: ${run.deniedCalls}`,
      `  Duration: ${formatNumber(run.durationMs)}`,
      `  Cost: ${formatNumber(run.cost)}`,
    );
  }
  lines.push(
    "",
    "Full eligible-pool sufficiency facts:",
    `- Distinct qualified Experience refs: ${packet.evidence.poolSufficiency.distinctQualifiedExperienceRefCount}`,
    `- Distinct project IDs: ${packet.evidence.poolSufficiency.distinctProjectIdCount}`,
    `- Distinct exact Task goals: ${packet.evidence.poolSufficiency.distinctExactTaskGoalCount}`,
    `- Distinct Policy Evidence Profiles: ${packet.evidence.poolSufficiency.distinctPolicyEvidenceProfileCount}`,
    `- Full pool gate satisfied: ${packet.evidence.poolSufficiency.sufficient}`,
    "",
    "Shown-packet sufficiency facts:",
    `- Distinct qualified Experience refs: ${packet.sufficiency.distinctQualifiedExperienceRefCount}`,
    `- Distinct project IDs: ${packet.sufficiency.distinctProjectIdCount}`,
    `- Distinct exact Task goals: ${packet.sufficiency.distinctExactTaskGoalCount}`,
    `- Distinct Policy Evidence Profiles: ${packet.sufficiency.distinctPolicyEvidenceProfileCount}`,
    `- Shown gate satisfied: ${packet.sufficiency.sufficient}`,
    "",
    "Boundary:",
    `- ${packet.boundaryText}`,
    "- Negative, blocked, incomplete, errorful, and denied-call outcomes remain factual evidence; none is ranked as better or worse.",
    "- This packet is the complete bounded project evidence supplied to a later synthesis Run; it contains no transcript, tool-result body, source file, Skill content, or unbounded Experience history.",
    "</PINDIE_CROSS_PROJECT_SYNTHESIS_PACKET>",
  );
  return lines.join("\n");
}

export const renderCrossProjectSynthesisPacket = formatCrossProjectSynthesisPacket;
