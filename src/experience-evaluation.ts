import type {
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "./experience-store.ts";
import {
  createStrategyRevisionSelection,
  formatStrategySelectionLabel,
  isSeedStrategySelection,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type PolicySnapshot,
  type PolicyStrategySelection,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  isCanonicalStrategyCandidateId,
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  validateStrategyRevisionCandidateArtifact,
  type StrategyCandidateReader,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  getSeedStrategy,
  SEED_STRATEGIES,
  seedStrategyFingerprint,
  type SeedStrategy,
} from "./strategies.ts";
import {
  parseRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "./run-experience.ts";
import {
  validateStrategyRevisionDecisionArtifact,
  validateStrategyRevisionDecisionBinding,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  hasExactTrustedStrategySemanticDuplicate,
  isCanonicalStrategyDerivationCandidateId,
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import {
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
  type StrategyDerivationDecisionReader,
} from "./strategy-derivation-decisions.ts";
import {
  MAX_PROMOTED_DERIVED_STRATEGIES,
  MAX_TRUSTED_PORTFOLIO_ENTRIES,
  resolveTrustedPortfolioSelection,
  sameTrustedPortfolioSnapshot,
  trustedLogicalStrategyIds,
  trustedPortfolioFingerprint,
  type TrustedPortfolioManifestEntry,
  type TrustedPortfolioResolvedEntry,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import { getProjectId } from "./store.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunEvaluation {
  /** Completed-before-run facts describe a preexisting Task, not this Run's outcome. */
  readonly attributionEligible: boolean;
  readonly source: {
    readonly recordId: string;
    readonly recordedAt: string;
    readonly taskGoal: string;
  };
  readonly policy: {
    readonly finalSnapshot: PolicySnapshot | null;
    readonly declarationCount: number;
    readonly finalPolicyDeclarationCount: number;
    readonly finalPolicyFirstDeclarationProgress: number | null;
    readonly finalPolicyLastActivationProgress: number | null;
    readonly finalPolicyExposureCalls: number | null;
    readonly finalPolicyExposureRatio: number | null;
  };
  readonly execution: {
    readonly toolCalls: number;
    readonly toolErrors: number;
    readonly deniedCalls: number;
    readonly observationRatio: number | null;
    readonly consequentialRatio: number | null;
    readonly toolErrorRatio: number | null;
    readonly deniedCallRatio: number | null;
  };
  readonly outcome: {
    readonly verificationPassed: boolean;
    readonly completedDuringRun: boolean;
    readonly hasBlockers: boolean;
    readonly hasQuestions: boolean;
    readonly humanGateOpen: boolean;
  };
  readonly metrics: {
    readonly durationMs: number | null;
    readonly cost: number | null;
  };
}

export interface NumericSummary {
  readonly count: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
}

export interface PolicyEvidenceProfile {
  readonly profileId: string;
  readonly snapshot: PolicySnapshot | null;
  readonly identity: {
    readonly approachId: string | null;
    readonly modifierIds: readonly string[];
  };
  readonly runCount: number;
  readonly verificationPassedCount: number;
  readonly completedDuringRunCount: number;
  readonly totalToolErrors: number;
  readonly totalDeniedCalls: number;
  readonly declarationCount: NumericSummary;
  readonly finalPolicyDeclarationCount: NumericSummary;
  readonly exposure: {
    readonly calls: NumericSummary;
    readonly ratio: NumericSummary;
    readonly finalPolicyFirstDeclarationProgress: NumericSummary;
    readonly finalPolicyLastActivationProgress: NumericSummary;
  };
  readonly durationMs: NumericSummary;
  readonly cost: NumericSummary;
  readonly sourceRecordIds: readonly string[];
}

export interface ComparableCohort {
  readonly taskGoal: string;
  readonly sourceRecordIds: readonly string[];
  readonly policyProfileIds: readonly string[];
}

export interface ExperienceEvaluation {
  readonly evaluations: readonly RunEvaluation[];
  readonly profiles: readonly PolicyEvidenceProfile[];
  readonly cohorts: readonly ComparableCohort[];
}

export const NO_EXPLICIT_POLICY_PROFILE_ID = "no-explicit-policy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) ||
    denominator <= 0 || numerator < 0 || numerator > denominator) {
    return null;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

function declarationProgress(
  position: RunExperienceExecution | null,
  toolCalls: number,
): number | null {
  if (position === null || toolCalls <= 0) return null;
  return ratio(position.toolCalls, toolCalls);
}

function copyPolicySnapshot(snapshot: PolicySnapshot | null): PolicySnapshot | null {
  if (snapshot === null) return null;
  const modifiers = [...snapshot.modifiers].sort((left, right) => compareText(left.id, right.id));
  return Object.freeze({
    approach: snapshot.approach,
    modifiers: Object.freeze(modifiers),
  });
}

/**
 * Deterministic Evaluation-only identity for one complete Policy Snapshot.
 *
 * Unlike policySnapshotIdentity(), this identity includes the status under
 * which each immutable revision was used in the Run. Status is attribution
 * metadata, not part of stable Strategy revision identity.
 */
export function policyEvidenceProfileId(snapshot: PolicySnapshot | null): string {
  if (snapshot === null) return NO_EXPLICIT_POLICY_PROFILE_ID;
  const selectionIdentity = (selection: PolicyStrategySelection) => ({
    strategyId: strategySelectionId(selection),
    kind: selection.kind,
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
    revisionStatusAtRun: strategySelectionRevisionStatus(selection),
  });
  const modifiers = [...snapshot.modifiers]
    .map(selectionIdentity)
    .sort((left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return compareText(leftText, rightText);
    });
  return `policy:${JSON.stringify({
    approach: selectionIdentity(snapshot.approach),
    modifiers,
  })}`;
}

/** Compatibility name for callers that refer to the Evaluation profile ID. */
export const policyProfileId = policyEvidenceProfileId;

/** Derive bounded measurements from one valid current schema-v4 Experience. */
export function evaluateRunExperience(
  source: RunExperienceSourceRecord,
): RunEvaluation {
  const experience: RunExperience = source.experience;
  const toolCalls = experience.execution.toolCalls;
  const finalSnapshot = experience.policy.finalSnapshot;
  const finalPolicyLastDeclaredAfter = experience.policy.finalPolicyLastDeclaredAfter;
  const finalPolicyExposureCalls = finalSnapshot !== null && finalPolicyLastDeclaredAfter !== null &&
      toolCalls >= finalPolicyLastDeclaredAfter.toolCalls
    ? toolCalls - finalPolicyLastDeclaredAfter.toolCalls
    : null;

  return {
    attributionEligible: experience.outcome.completionRelation !== "completed_before_run",
    source: {
      recordId: source.recordId,
      recordedAt: experience.recordedAt,
      taskGoal: experience.task.goal,
    },
    policy: {
      finalSnapshot,
      declarationCount: experience.policy.declarationCount,
      finalPolicyDeclarationCount: experience.policy.finalPolicyDeclarationCount,
      finalPolicyFirstDeclarationProgress: finalSnapshot === null
        ? null
        : declarationProgress(experience.policy.finalPolicyFirstDeclaredAfter, toolCalls),
      finalPolicyLastActivationProgress: finalSnapshot === null
        ? null
        : declarationProgress(finalPolicyLastDeclaredAfter, toolCalls),
      finalPolicyExposureCalls,
      finalPolicyExposureRatio: finalSnapshot === null || finalPolicyExposureCalls === null
        ? null
        : ratio(finalPolicyExposureCalls, toolCalls),
    },
    execution: {
      toolCalls,
      toolErrors: experience.execution.toolErrors,
      deniedCalls: experience.execution.deniedCalls,
      observationRatio: ratio(experience.execution.observations, toolCalls),
      consequentialRatio: ratio(experience.execution.consequentialCalls, toolCalls),
      toolErrorRatio: ratio(experience.execution.toolErrors, toolCalls),
      deniedCallRatio: ratio(
        experience.execution.deniedCalls,
        toolCalls + experience.execution.deniedCalls,
      ),
    },
    outcome: {
      verificationPassed: experience.outcome.verificationStatus === "passed",
      completedDuringRun: experience.outcome.completionRelation === "completed_during_run",
      hasBlockers: experience.outcome.hasBlockers,
      hasQuestions: experience.outcome.hasQuestions,
      humanGateOpen: experience.outcome.humanGateOpen,
    },
    metrics: {
      durationMs: experience.metrics.durationMs,
      cost: experience.metrics.cost,
    },
  };
}

export function deriveRunEvaluations(
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const current = records.flatMap((record) => {
    let parsed: RunExperience | null;
    try {
      parsed = parseRunExperience(record.experience);
    } catch {
      parsed = null;
    }
    return parsed === null
      ? []
      : [Object.freeze({ recordId: record.recordId, experience: parsed })];
  });
  return Object.freeze(current.map(evaluateRunExperience));
}

function summarize(values: readonly (number | null)[]): NumericSummary {
  const present = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (present.length === 0) {
    return { count: 0, min: null, median: null, max: null };
  }
  const middle = Math.floor(present.length / 2);
  const median = present.length % 2 === 1
    ? present[middle]!
    : present[middle - 1]! + (present[middle]! - present[middle - 1]!) / 2;
  return {
    count: present.length,
    min: present[0]!,
    median: Number.isFinite(median) ? median : null,
    max: present.at(-1)!,
  };
}

interface MutableProfile {
  readonly profileId: string;
  readonly snapshot: PolicySnapshot | null;
  readonly identity: {
    readonly approachId: string | null;
    readonly modifierIds: readonly string[];
  };
  runCount: number;
  verificationPassedCount: number;
  completedDuringRunCount: number;
  totalToolErrors: number;
  totalDeniedCalls: number;
  readonly declarationCounts: number[];
  readonly finalPolicyDeclarationCounts: number[];
  readonly exposureCalls: number[];
  readonly exposureRatios: number[];
  readonly finalPolicyFirstDeclarationProgress: number[];
  readonly finalPolicyLastActivationProgress: number[];
  readonly durations: number[];
  readonly costs: number[];
  readonly sourceRecordIds: string[];
}

function addOptional(target: number[], value: number | null): void {
  if (value !== null && Number.isFinite(value)) target.push(value);
}

function createMutableProfile(evaluation: RunEvaluation): MutableProfile {
  const snapshot = copyPolicySnapshot(evaluation.policy.finalSnapshot);
  const modifierIds = snapshot?.modifiers.map((modifier) => modifier.id) ?? [];
  return {
    profileId: policyEvidenceProfileId(snapshot),
    snapshot,
    identity: {
      approachId: snapshot?.approach.id ?? null,
      modifierIds: Object.freeze([...modifierIds]),
    },
    runCount: 0,
    verificationPassedCount: 0,
    completedDuringRunCount: 0,
    totalToolErrors: 0,
    totalDeniedCalls: 0,
    declarationCounts: [],
    finalPolicyDeclarationCounts: [],
    exposureCalls: [],
    exposureRatios: [],
    finalPolicyFirstDeclarationProgress: [],
    finalPolicyLastActivationProgress: [],
    durations: [],
    costs: [],
    sourceRecordIds: [],
  };
}

/** Aggregate evaluations by complete normalized revision-aware Policy identity. */
export function derivePolicyEvidenceProfiles(
  evaluations: readonly RunEvaluation[],
): readonly PolicyEvidenceProfile[] {
  const profiles = new Map<string, MutableProfile>();
  for (const evaluation of evaluations) {
    if (!evaluation.attributionEligible) continue;
    const id = policyEvidenceProfileId(evaluation.policy.finalSnapshot);
    let profile = profiles.get(id);
    if (!profile) {
      profile = createMutableProfile(evaluation);
      profiles.set(id, profile);
    }
    profile.runCount += 1;
    profile.verificationPassedCount += evaluation.outcome.verificationPassed ? 1 : 0;
    profile.completedDuringRunCount += evaluation.outcome.completedDuringRun ? 1 : 0;
    profile.totalToolErrors += evaluation.execution.toolErrors;
    profile.totalDeniedCalls += evaluation.execution.deniedCalls;
    addOptional(profile.declarationCounts, evaluation.policy.declarationCount);
    addOptional(profile.finalPolicyDeclarationCounts, evaluation.policy.finalPolicyDeclarationCount);
    addOptional(profile.exposureCalls, evaluation.policy.finalPolicyExposureCalls);
    addOptional(profile.exposureRatios, evaluation.policy.finalPolicyExposureRatio);
    addOptional(profile.finalPolicyFirstDeclarationProgress, evaluation.policy.finalPolicyFirstDeclarationProgress);
    addOptional(profile.finalPolicyLastActivationProgress, evaluation.policy.finalPolicyLastActivationProgress);
    addOptional(profile.durations, evaluation.metrics.durationMs);
    addOptional(profile.costs, evaluation.metrics.cost);
    profile.sourceRecordIds.push(evaluation.source.recordId);
  }

  return Object.freeze([...profiles.values()]
    .sort((left, right) => compareText(left.profileId, right.profileId))
    .map((profile) => Object.freeze({
      profileId: profile.profileId,
      snapshot: profile.snapshot,
      identity: profile.identity,
      runCount: profile.runCount,
      verificationPassedCount: profile.verificationPassedCount,
      completedDuringRunCount: profile.completedDuringRunCount,
      totalToolErrors: profile.totalToolErrors,
      totalDeniedCalls: profile.totalDeniedCalls,
      declarationCount: summarize(profile.declarationCounts),
      finalPolicyDeclarationCount: summarize(profile.finalPolicyDeclarationCounts),
      exposure: Object.freeze({
        calls: summarize(profile.exposureCalls),
        ratio: summarize(profile.exposureRatios),
        finalPolicyFirstDeclarationProgress: summarize(profile.finalPolicyFirstDeclarationProgress),
        finalPolicyLastActivationProgress: summarize(profile.finalPolicyLastActivationProgress),
      }),
      durationMs: summarize(profile.durations),
      cost: summarize(profile.costs),
      sourceRecordIds: Object.freeze([...profile.sourceRecordIds].sort((left, right) => compareText(left, right))),
    })));
}

/** Group only exact settlement task goals with at least two evaluations. */
export function deriveComparableCohorts(
  evaluations: readonly RunEvaluation[],
): readonly ComparableCohort[] {
  const grouped = new Map<string, RunEvaluation[]>();
  for (const evaluation of evaluations) {
    if (!evaluation.attributionEligible) continue;
    const cohort = grouped.get(evaluation.source.taskGoal) ?? [];
    cohort.push(evaluation);
    grouped.set(evaluation.source.taskGoal, cohort);
  }
  return Object.freeze([...grouped.entries()]
    .filter(([, cohort]) => cohort.length >= 2)
    .sort(([left], [right]) => compareText(left, right))
    .map(([taskGoal, cohort]) => Object.freeze({
      taskGoal,
      sourceRecordIds: Object.freeze(
        cohort.map((evaluation) => evaluation.source.recordId)
          .sort((left, right) => compareText(left, right)),
      ),
      policyProfileIds: Object.freeze(
        [...new Set(cohort.map((evaluation) => policyEvidenceProfileId(evaluation.policy.finalSnapshot)))]
          .sort((left, right) => compareText(left, right)),
      ),
    })));
}

export function deriveExperienceEvaluation(
  records: readonly RunExperienceSourceRecord[],
): ExperienceEvaluation {
  const evaluations = deriveRunEvaluations(records);
  return Object.freeze({
    evaluations,
    profiles: derivePolicyEvidenceProfiles(evaluations),
    cohorts: deriveComparableCohorts(evaluations),
  });
}

function formatSummary(summary: NumericSummary, percent = false): string {
  if (summary.count === 0) return "n/a";
  const format = (value: number): string => percent
    ? `${(value * 100).toFixed(1)}%`
    : value.toFixed(2).replace(/\.00$/, "");
  return `n=${summary.count}, min=${format(summary.min!)}, median=${format(summary.median!)}, max=${format(summary.max!)}`;
}

function profileLabel(profile: PolicyEvidenceProfile): string {
  if (profile.snapshot === null) return "no-explicit-policy";
  const modifiers = profile.snapshot.modifiers.length === 0
    ? ""
    : ` + ${profile.snapshot.modifiers.map((selection) =>
      formatStrategySelectionLabel(selection)).join(", ")}`;
  return `${formatStrategySelectionLabel(profile.snapshot.approach)}${modifiers}`;
}

const MAX_RENDERED_PROFILE_RECORD_IDS = 5;
const MAX_RENDERED_PROFILES = 10;

function formatProfileRecordIds(profile: PolicyEvidenceProfile): string {
  const visible = profile.sourceRecordIds.slice(0, MAX_RENDERED_PROFILE_RECORD_IDS);
  const omitted = profile.sourceRecordIds.length - visible.length;
  return `${visible.join(", ")}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

/** Format a bounded human-readable report without making policy claims. */
export function formatExperienceReport(
  read: RunExperienceReadResult,
  evaluation: ExperienceEvaluation = deriveExperienceEvaluation(read.records),
): string {
  const explicitCount = evaluation.evaluations
    .filter((run) => run.policy.finalSnapshot !== null).length;
  const noPolicyCount = evaluation.evaluations.length - explicitCount;
  const attributableCount = evaluation.evaluations
    .filter((run) => run.attributionEligible).length;
  const profileLines = evaluation.profiles.length === 0
    ? ["  (none)"]
    : evaluation.profiles.slice(0, MAX_RENDERED_PROFILES).map((profile) => [
      `  - ${profileLabel(profile)} · runs ${profile.runCount} · verification passed ${profile.verificationPassedCount} · completed during Run ${profile.completedDuringRunCount} · tool errors ${profile.totalToolErrors} · denied ${profile.totalDeniedCalls}`,
      `    declarations: ${formatSummary(profile.declarationCount)} · final-Policy declarations: ${formatSummary(profile.finalPolicyDeclarationCount)}`,
      `    first final-Policy declaration progress: ${formatSummary(profile.exposure.finalPolicyFirstDeclarationProgress, true)} · last activation progress: ${formatSummary(profile.exposure.finalPolicyLastActivationProgress, true)}`,
      `    continuous final-Policy exposure calls: ${formatSummary(profile.exposure.calls)} · ratio: ${formatSummary(profile.exposure.ratio, true)}`,
      `    durationMs: ${formatSummary(profile.durationMs)} · cost: ${formatSummary(profile.cost)}`,
      `    records: ${formatProfileRecordIds(profile)}`,
    ].join("\n"));
  if (evaluation.profiles.length > MAX_RENDERED_PROFILES) {
    profileLines.push(`... +${evaluation.profiles.length - MAX_RENDERED_PROFILES} more profiles`);
  }

  return [
    "Experience Evaluation",
    "",
    `Loaded current Experience records: ${read.loadedRecords}`,
    `Unsupported-schema records: ${read.unsupportedSchema}`,
    `Invalid/unreadable records: ${read.invalid}`,
    `Evaluated Runs: ${evaluation.evaluations.length}`,
    `Attributable Runs: ${attributableCount}`,
    `Non-attributable Runs: ${evaluation.evaluations.length - attributableCount}`,
    `Explicit-Policy Runs: ${explicitCount}`,
    `No-explicit-Policy Runs: ${noPolicyCount}`,
    "",
    "Policy Evidence Profiles:",
    "Attributable Runs only; comparable exact-goal cohorts use attributable Runs only.",
    ...profileLines,
    "",
    `Comparable exact-goal cohorts: ${evaluation.cohorts.length}`,
    "Evidence inventory only; contains no Strategy score, ranking, or causal claim.",
  ].join("\n");
}

/**
 * The bounded factual inventory used when reviewing one Candidate Trial. It
 * intentionally mirrors the SI v0.4 Policy Evidence Profile measurements
 * without turning them into a score or judgment.
 */
export interface RevisionEvidenceProfile {
  readonly runCount: number;
  readonly verificationPassedCount: number;
  readonly completedDuringRunCount: number;
  readonly totalToolErrors: number;
  readonly totalDeniedCalls: number;
  readonly declarationCount: NumericSummary;
  readonly finalPolicyDeclarationCount: NumericSummary;
  readonly exposure: {
    readonly calls: NumericSummary;
    readonly ratio: NumericSummary;
    readonly finalPolicyFirstDeclarationProgress: NumericSummary;
    readonly finalPolicyLastActivationProgress: NumericSummary;
  };
  readonly durationMs: NumericSummary;
  readonly cost: NumericSummary;
  readonly sourceRecordIds: readonly string[];
}

export interface CandidateTrialTarget {
  readonly strategyId: string;
  readonly kind: "approach" | "modifier";
  readonly baseFingerprint: string;
}

export interface CandidateTrialProfile extends RevisionEvidenceProfile {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly target: CandidateTrialTarget;
}

export interface SeedBaselineProfile extends RevisionEvidenceProfile {
  readonly target: CandidateTrialTarget;
}

/** Descriptive aliases for callers that use the longer contract terminology. */
export type CandidateTrialEvidenceProfile = CandidateTrialProfile;
export type SeedBaselineEvidenceProfile = SeedBaselineProfile;

/** Exact-goal evidence kept separate by revision kind for human inspection. */
export interface CandidateSeedComparableCohort {
  readonly taskGoal: string;
  readonly candidateSourceRecordIds: readonly string[];
  readonly seedSourceRecordIds: readonly string[];
}

export interface PromotionEligibilityInput {
  readonly eligibleTrialRunCount: number;
  readonly candidateBindingValid: boolean;
  readonly currentProjectMatch: boolean;
  readonly priorTerminalDecision: boolean;
  readonly seedBaselineRunCount: number;
}

export interface PromotionEligibility {
  /** True means only that enough auditable evidence exists for human review. */
  readonly eligible: boolean;
  readonly requiredTrialRunCount: 2;
  readonly eligibleTrialRunCount: number;
  readonly candidateBindingValid: boolean;
  readonly currentProjectMatch: boolean;
  readonly noPriorTerminalDecision: boolean;
  readonly seedBaselineAvailable: boolean;
  readonly reasons: readonly string[];
}

export interface CandidateTrialReviewOptions {
  /** Records supplied to the review came from the Candidate's current project. */
  readonly currentProjectMatch?: boolean;
  /** Runtime/read-only observation supplied by a future decision owner. */
  readonly priorTerminalDecision?: boolean;
}

export interface CandidateTrialReview {
  readonly candidate: StrategyRevisionCandidate;
  readonly trialEvaluations: readonly RunEvaluation[];
  readonly seedEvaluations: readonly RunEvaluation[];
  readonly candidateProfile: CandidateTrialProfile;
  readonly seedBaselineProfile: SeedBaselineProfile;
  readonly comparableCohorts: readonly CandidateSeedComparableCohort[];
  readonly promotionEligibility: PromotionEligibility;
}

export function deriveRevisionEvidenceProfile(
  evaluations: readonly RunEvaluation[],
): RevisionEvidenceProfile {
  const declarationCounts: number[] = [];
  const finalPolicyDeclarationCounts: number[] = [];
  const exposureCalls: number[] = [];
  const exposureRatios: number[] = [];
  const firstDeclarationProgress: number[] = [];
  const lastActivationProgress: number[] = [];
  const durations: number[] = [];
  const costs: number[] = [];
  let verificationPassedCount = 0;
  let completedDuringRunCount = 0;
  let totalToolErrors = 0;
  let totalDeniedCalls = 0;

  for (const evaluation of evaluations) {
    verificationPassedCount += evaluation.outcome.verificationPassed ? 1 : 0;
    completedDuringRunCount += evaluation.outcome.completedDuringRun ? 1 : 0;
    totalToolErrors += evaluation.execution.toolErrors;
    totalDeniedCalls += evaluation.execution.deniedCalls;
    addOptional(declarationCounts, evaluation.policy.declarationCount);
    addOptional(finalPolicyDeclarationCounts, evaluation.policy.finalPolicyDeclarationCount);
    addOptional(exposureCalls, evaluation.policy.finalPolicyExposureCalls);
    addOptional(exposureRatios, evaluation.policy.finalPolicyExposureRatio);
    addOptional(firstDeclarationProgress, evaluation.policy.finalPolicyFirstDeclarationProgress);
    addOptional(lastActivationProgress, evaluation.policy.finalPolicyLastActivationProgress);
    addOptional(durations, evaluation.metrics.durationMs);
    addOptional(costs, evaluation.metrics.cost);
  }

  return Object.freeze({
    runCount: evaluations.length,
    verificationPassedCount,
    completedDuringRunCount,
    totalToolErrors,
    totalDeniedCalls,
    declarationCount: summarize(declarationCounts),
    finalPolicyDeclarationCount: summarize(finalPolicyDeclarationCounts),
    exposure: Object.freeze({
      calls: summarize(exposureCalls),
      ratio: summarize(exposureRatios),
      finalPolicyFirstDeclarationProgress: summarize(firstDeclarationProgress),
      finalPolicyLastActivationProgress: summarize(lastActivationProgress),
    }),
    durationMs: summarize(durations),
    cost: summarize(costs),
    sourceRecordIds: Object.freeze(
      [...new Set(evaluations.map((evaluation) => evaluation.source.recordId))]
        .sort(compareText),
    ),
  });
}

function candidateTarget(candidate: StrategyRevisionCandidate): CandidateTrialTarget {
  return Object.freeze({
    strategyId: candidate.target.strategyId,
    kind: candidate.target.kind,
    baseFingerprint: candidate.target.baseFingerprint,
  });
}

/** Aggregate already-derived eligible Candidate Trial evaluations. */
export function deriveCandidateTrialProfile(
  candidate: StrategyRevisionCandidate,
  evaluations: readonly RunEvaluation[],
): CandidateTrialProfile {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const fingerprint = strategyCandidateSemanticFingerprint(validated);
  return Object.freeze({
    candidateId: validated.candidateId,
    candidateFingerprint: fingerprint,
    target: candidateTarget(validated),
    ...deriveRevisionEvidenceProfile(evaluations),
  });
}

/** Aggregate already-derived eligible exact-Seed baseline evaluations. */
export function deriveSeedBaselineProfile(
  candidate: StrategyRevisionCandidate,
  evaluations: readonly RunEvaluation[],
): SeedBaselineProfile {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  return Object.freeze({
    target: candidateTarget(validated),
    ...deriveRevisionEvidenceProfile(evaluations),
  });
}

interface RawExperienceSource {
  readonly recordId: string;
  readonly experience: unknown;
}

/** Re-parse the immutable reader boundary before specialized evaluation. */
function validExperienceSources(
  records: readonly RunExperienceSourceRecord[],
): readonly RunExperienceSourceRecord[] {
  const raw: RawExperienceSource[] = [];
  for (const record of records) {
    if (!isRecord(record) || typeof record.recordId !== "string" || record.recordId.trim() === "") {
      continue;
    }
    raw.push({ recordId: record.recordId, experience: record.experience });
  }
  const counts = new Map<string, number>();
  for (const record of raw) counts.set(record.recordId, (counts.get(record.recordId) ?? 0) + 1);

  const valid: RunExperienceSourceRecord[] = [];
  for (const record of raw
    .filter((item) => counts.get(item.recordId) === 1)
    .sort((left, right) => compareText(left.recordId, right.recordId))) {
    let parsed: RunExperience | null;
    try {
      parsed = parseRunExperience(record.experience);
    } catch {
      parsed = null;
    }
    if (parsed === null) continue;
    valid.push(Object.freeze({ recordId: record.recordId, experience: parsed }));
  }
  return Object.freeze(valid);
}

function candidateSelectionMatches(
  selection: PolicyStrategySelection,
  candidate: StrategyRevisionCandidate,
  candidateFingerprint: string,
): boolean {
  if (
    selection.kind !== candidate.target.kind ||
    strategySelectionId(selection) !== candidate.target.strategyId ||
    strategySelectionRevisionIdentity(selection) !== candidate.candidateId ||
    strategySelectionRevisionFingerprint(selection) !== candidateFingerprint ||
    strategySelectionRevisionStatus(selection) !== "trial"
  ) return false;
  const semantics = (selection as Partial<StrategyRevisionSelection>).semantics;
  if (semantics === undefined) return false;
  return JSON.stringify(semantics) === JSON.stringify({
    summary: candidate.proposal.summary,
    useWhen: [...candidate.proposal.useWhen],
    avoidWhen: [...candidate.proposal.avoidWhen],
    principles: [...candidate.proposal.principles],
  });
}

function candidateSelectionInFinalPolicy(
  evaluation: RunEvaluation,
  candidate: StrategyRevisionCandidate,
  candidateFingerprint: string,
): StrategyRevisionSelection | null {
  const snapshot = evaluation.policy.finalSnapshot;
  if (snapshot === null) return null;
  if (candidate.target.kind === "approach") {
    return candidateSelectionMatches(snapshot.approach, candidate, candidateFingerprint)
      ? snapshot.approach as StrategyRevisionSelection
      : null;
  }
  const selection = snapshot.modifiers.find((modifier) =>
    candidateSelectionMatches(modifier, candidate, candidateFingerprint));
  return selection === undefined ? null : selection as StrategyRevisionSelection;
}

function seedSelectionInFinalPolicy(
  evaluation: RunEvaluation,
  target: SeedStrategy,
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (snapshot === null) return false;
  const selections = target.kind === "approach"
    ? [snapshot.approach]
    : snapshot.modifiers;
  return selections.some((selection) =>
    selection.kind === target.kind &&
    strategySelectionId(selection) === target.id &&
    isSeedStrategySelection(selection));
}

/**
 * Select only valid current-project schema-v4 Runs whose final Policy
 * contains the exact immutable Candidate revision and real final-Policy
 * execution exposure.
 */
export function selectCandidateTrialEvidence(
  candidate: StrategyRevisionCandidate,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const fingerprint = strategyCandidateSemanticFingerprint(validated);
  const evaluations = deriveRunEvaluations(validExperienceSources(records));
  return Object.freeze(evaluations.filter((evaluation) =>
    evaluation.attributionEligible &&
    candidateSelectionInFinalPolicy(evaluation, validated, fingerprint) !== null &&
    evaluation.policy.finalPolicyExposureCalls !== null &&
    evaluation.policy.finalPolicyExposureCalls > 0));
}

/** Select exact immutable Seed evidence from current schema-v4 history. */
export function selectSeedBaselineEvidence(
  candidate: StrategyRevisionCandidate,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const target = getSeedStrategy(validated.target.strategyId);
  if (target === null || target.kind !== validated.target.kind) {
    throw new Error("Cannot derive Seed baseline: Candidate target is not an immutable Seed Strategy.");
  }
  const evaluations = deriveRunEvaluations(validExperienceSources(records));
  return Object.freeze(evaluations.filter((evaluation) =>
    evaluation.attributionEligible && seedSelectionInFinalPolicy(evaluation, target)));
}

/** Derive only exact-goal cohorts containing both Candidate and Seed evidence. */
export function deriveCandidateSeedComparableCohorts(
  candidateEvaluations: readonly RunEvaluation[],
  seedEvaluations: readonly RunEvaluation[],
): readonly CandidateSeedComparableCohort[] {
  const grouped = new Map<string, {
    readonly candidate: string[];
    readonly seed: string[];
  }>();
  const add = (evaluation: RunEvaluation, kind: "candidate" | "seed"): void => {
    const entry = grouped.get(evaluation.source.taskGoal) ?? { candidate: [], seed: [] };
    entry[kind].push(evaluation.source.recordId);
    grouped.set(evaluation.source.taskGoal, entry);
  };
  for (const evaluation of candidateEvaluations) add(evaluation, "candidate");
  for (const evaluation of seedEvaluations) add(evaluation, "seed");

  return Object.freeze([...grouped.entries()]
    .filter(([, entry]) => entry.candidate.length > 0 && entry.seed.length > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([taskGoal, entry]) => Object.freeze({
      taskGoal,
      candidateSourceRecordIds: Object.freeze([...new Set(entry.candidate)].sort(compareText)),
      seedSourceRecordIds: Object.freeze([...new Set(entry.seed)].sort(compareText)),
    })));
}

function validCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Derive the auditable human-review gate without making a trust judgment. */
export function derivePromotionEligibility(
  input: PromotionEligibilityInput,
): PromotionEligibility {
  const eligibleTrialRunCount = validCount(input.eligibleTrialRunCount);
  const seedBaselineRunCount = validCount(input.seedBaselineRunCount);
  const candidateBindingValid = input.candidateBindingValid === true;
  const currentProjectMatch = input.currentProjectMatch === true;
  const noPriorTerminalDecision = input.priorTerminalDecision !== true;
  const seedBaselineAvailable = seedBaselineRunCount > 0;
  const reasons: string[] = [];
  if (eligibleTrialRunCount < 2) {
    reasons.push("at least 2 eligible Candidate Trial Runs are required");
  }
  if (!candidateBindingValid) reasons.push("Candidate/Seed fingerprint binding is not valid");
  if (!currentProjectMatch) reasons.push("current project match is not established");
  if (!noPriorTerminalDecision) reasons.push("a terminal decision already exists for this Candidate");
  if (!seedBaselineAvailable) reasons.push("Seed baseline provenance is unavailable");
  return Object.freeze({
    eligible: reasons.length === 0,
    requiredTrialRunCount: 2,
    eligibleTrialRunCount,
    candidateBindingValid,
    currentProjectMatch,
    noPriorTerminalDecision,
    seedBaselineAvailable,
    reasons: Object.freeze(reasons),
  });
}

/** Derive the complete recomputable review for one immutable project Candidate. */
export function deriveCandidateTrialReview(
  candidate: StrategyRevisionCandidate,
  records: readonly RunExperienceSourceRecord[],
  options: CandidateTrialReviewOptions = {},
): CandidateTrialReview {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const trialEvaluations = selectCandidateTrialEvidence(validated, records);
  const seedEvaluations = selectSeedBaselineEvidence(validated, records);
  const candidateProfile = deriveCandidateTrialProfile(validated, trialEvaluations);
  const seedBaselineProfile = deriveSeedBaselineProfile(validated, seedEvaluations);
  const comparableCohorts = deriveCandidateSeedComparableCohorts(
    trialEvaluations,
    seedEvaluations,
  );
  const promotionEligibility = derivePromotionEligibility({
    eligibleTrialRunCount: candidateProfile.runCount,
    candidateBindingValid: true,
    currentProjectMatch: options.currentProjectMatch ?? true,
    priorTerminalDecision: options.priorTerminalDecision ?? false,
    seedBaselineRunCount: seedBaselineProfile.runCount,
  });
  return Object.freeze({
    candidate: validated,
    trialEvaluations,
    seedEvaluations,
    candidateProfile,
    seedBaselineProfile,
    comparableCohorts,
    promotionEligibility,
  });
}

/** Descriptive aliases for callers that use evaluation rather than derivation. */
export const evaluateCandidateTrial = deriveCandidateTrialReview;
export const buildCandidateTrialReview = deriveCandidateTrialReview;

const MAX_RENDERED_REVIEW_RECORD_IDS = 5;
const MAX_RENDERED_REVIEW_COHORTS = 10;
const MAX_REVIEW_TASK_GOAL_LENGTH = 512;

function boundedReviewText(value: string): string {
  return value.length <= MAX_REVIEW_TASK_GOAL_LENGTH
    ? value
    : `${value.slice(0, MAX_REVIEW_TASK_GOAL_LENGTH - 14)} [truncated]`;
}

function formatReviewRecordIds(recordIds: readonly string[]): string {
  const visible = recordIds.slice(0, MAX_RENDERED_REVIEW_RECORD_IDS);
  const omitted = recordIds.length - visible.length;
  return `${visible.length > 0 ? visible.join(", ") : "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function formatRevisionEvidenceProfile(
  profile: RevisionEvidenceProfile,
  label: string,
): string[] {
  return [
    `${label}:`,
    `  Eligible Runs: ${profile.runCount}`,
    `  Verification passed: ${profile.verificationPassedCount} · not passed: ${Math.max(0, profile.runCount - profile.verificationPassedCount)}`,
    `  Completed during Run: ${profile.completedDuringRunCount} · not completed during Run: ${Math.max(0, profile.runCount - profile.completedDuringRunCount)}`,
    `  Tool errors: ${profile.totalToolErrors} · denied calls: ${profile.totalDeniedCalls}`,
    `  Declarations: ${formatSummary(profile.declarationCount)} · final-Policy declarations: ${formatSummary(profile.finalPolicyDeclarationCount)}`,
    `  First final-Policy declaration progress: ${formatSummary(profile.exposure.finalPolicyFirstDeclarationProgress, true)}`,
    `  Last final-Policy activation progress: ${formatSummary(profile.exposure.finalPolicyLastActivationProgress, true)}`,
    `  Continuous final-Policy exposure calls: ${formatSummary(profile.exposure.calls)} · ratio: ${formatSummary(profile.exposure.ratio, true)}`,
    `  DurationMs: ${formatSummary(profile.durationMs)} · cost: ${formatSummary(profile.cost)}`,
    `  Source Experience IDs: ${formatReviewRecordIds(profile.sourceRecordIds)}`,
  ];
}

/** Format a bounded, non-causal Candidate/Seed review for human inspection. */
export function formatCandidateTrialReview(
  read: RunExperienceReadResult,
  review: CandidateTrialReview,
): string {
  const eligibility = review.promotionEligibility;
  const lines = [
    "Candidate Trial Review",
    "",
    `Candidate ID: ${review.candidate.candidateId}`,
    `Candidate fingerprint: ${strategyCandidateSemanticFingerprint(review.candidate)}`,
    `Target Seed Strategy: ${review.candidate.target.strategyId} (${review.candidate.target.kind})`,
    `Seed base fingerprint: ${review.candidate.target.baseFingerprint}`,
    "",
    `Loaded current Experience records: ${read.loadedRecords}`,
    `Unsupported-schema records: ${read.unsupportedSchema}`,
    `Invalid/unreadable records: ${read.invalid}`,
    "",
    ...formatRevisionEvidenceProfile(review.candidateProfile, "Candidate Trial Evidence"),
    "",
    ...formatRevisionEvidenceProfile(review.seedBaselineProfile, "Seed Baseline Evidence"),
    "",
    `Exact-goal comparable Candidate/Seed cohorts: ${review.comparableCohorts.length}`,
  ];
  if (review.comparableCohorts.length === 0) {
    lines.push(
      "  (none)",
      "  Candidate and Seed evidence inventories remain separate outside exact-goal cohorts.",
    );
  } else {
    for (const cohort of review.comparableCohorts.slice(0, MAX_RENDERED_REVIEW_COHORTS)) {
      lines.push(
        `  - Goal: ${boundedReviewText(cohort.taskGoal)}`,
        `    Candidate records: ${formatReviewRecordIds(cohort.candidateSourceRecordIds)}`,
        `    Seed records: ${formatReviewRecordIds(cohort.seedSourceRecordIds)}`,
      );
    }
    if (review.comparableCohorts.length > MAX_RENDERED_REVIEW_COHORTS) {
      lines.push(`  ... +${review.comparableCohorts.length - MAX_RENDERED_REVIEW_COHORTS} more cohorts`);
    }
  }

  lines.push(
    "",
    `Promotion Eligibility: ${eligibility.eligible ? "eligible for human review" : "not eligible"}`,
    "Eligibility means only that enough auditable evidence exists for a human trust decision; it does not prove Candidate superiority.",
    `- Eligible Trial Runs: ${eligibility.eligibleTrialRunCount} / ${eligibility.requiredTrialRunCount} required`,
    `- Candidate/Seed binding valid: ${eligibility.candidateBindingValid}`,
    `- Current project match: ${eligibility.currentProjectMatch}`,
    `- No prior terminal decision: ${eligibility.noPriorTerminalDecision}`,
    `- Seed baseline provenance available: ${eligibility.seedBaselineAvailable}`,
  );
  if (eligibility.reasons.length > 0) {
    lines.push("- Gate reasons:", ...eligibility.reasons.map((reason) => `  - ${reason}`));
  }
  lines.push(
    "Evidence inventory only; no Candidate score, ranking, reward, superiority, or causal claim is derived.",
  );
  return lines.join("\n");
}

/*
 * SI v0.7 Slice C deliberately keeps Derivation review beside, rather than
 * inside, the frozen v0.6 Candidate/Seed review above. The shared facts are
 * RunEvaluation and its deterministic profile aggregation; the inventories,
 * provenance rules, and eligibility gate below are new-identity semantics.
 */

export const MAX_DERIVATION_REVIEW_COHORTS = 10;
export const MAX_DERIVATION_REVIEW_RECORDS = 8;

export interface DerivationEvidenceProfile extends RevisionEvidenceProfile {
  readonly distinctExactGoalCount: number;
  readonly exactTaskGoals: readonly string[];
  readonly distinctPolicyProfileCount: number;
  readonly policyProfileIds: readonly string[];
}

export interface DerivationEvidenceRecord {
  readonly recordId: string;
  readonly eligible: boolean;
  readonly taskGoal: string | null;
  readonly policyProfileId: string | null;
  readonly evaluation: RunEvaluation | null;
  readonly reasons: readonly string[];
}

export interface DerivationSourceSufficiency {
  readonly distinctEligibleRecordCount: number;
  readonly distinctEligibleExactGoalCount: number;
  readonly distinctEligiblePolicyProfileCount: number;
  readonly sufficient: boolean;
}

export interface DerivationSourceEvidence {
  /** The exact immutable source ID set retained by the Candidate. */
  readonly citedSourceRecordIds: readonly string[];
  /** Every cited ID remains visible, including missing/ineligible records. */
  readonly records: readonly DerivationEvidenceRecord[];
  readonly eligibleEvaluations: readonly RunEvaluation[];
  readonly profile: DerivationEvidenceProfile;
  readonly sufficiency: DerivationSourceSufficiency;
  readonly provenanceValid: boolean;
  readonly capturedBasePortfolioValid: boolean;
  readonly invalidSourceRecordIds: readonly string[];
  readonly provenanceReasons: readonly string[];
}

export interface DerivationCandidateTrialEvidence {
  /** Exact-Candidate records are retained even when exposure/attribution fails. */
  readonly records: readonly DerivationEvidenceRecord[];
  readonly eligibleEvaluations: readonly RunEvaluation[];
  readonly profile: DerivationEvidenceProfile;
  readonly ineligibleTrialRecordIds: readonly string[];
}

export interface DerivationComparableCohort {
  readonly taskGoal: string;
  readonly sourceRecordIds: readonly string[];
  readonly trialRecordIds: readonly string[];
}

export interface DerivationTrialReviewOptions {
  /** Current project root used to revalidate the Candidate project binding. */
  readonly projectRoot?: string;
  /** Test/read-only seam when a project root is not available. */
  readonly currentProjectMatch?: boolean;
  /** Fresh current trusted portfolio. Omission is fail-closed. */
  readonly currentPortfolio?: TrustedStrategyPortfolio | null;
  /** Needed only to revalidate promoted Seed entries in the captured manifest. */
  readonly revisionCandidateReader?: StrategyCandidateReader;
  /** Needed only to revalidate promoted Seed entries in the captured manifest. */
  readonly revisionDecisionReader?: StrategyRevisionDecisionReader;
  /** Needed only to revalidate promoted Derived entries in the captured manifest. */
  readonly derivationCandidateReader?: StrategyDerivationCandidateReader;
  /** Needed only to revalidate promoted Derived entries in the captured manifest. */
  readonly derivationDecisionReader?: StrategyDerivationDecisionReader;
  /** A terminal Derivation Decision is read-only review input. */
  readonly priorTerminalDecision?: boolean;
}

export interface DerivationPromotionEligibility {
  /** True means only that auditable evidence is ready for Human review. */
  readonly eligible: boolean;
  readonly requiredTrialRunCount: 2;
  readonly eligibleTrialRunCount: number;
  readonly candidateBindingValid: boolean;
  readonly derivationSourceProvenanceValid: boolean;
  readonly sourceSufficiencyValid: boolean;
  readonly currentProjectMatch: boolean;
  readonly currentPortfolioMatch: boolean;
  readonly logicalStrategyIdAvailable: boolean;
  readonly noExactTrustedSemanticDuplicate: boolean;
  readonly derivedStrategyCapacityAvailable: boolean;
  readonly noPriorTerminalDecision: boolean;
  readonly reasons: readonly string[];
}

export interface StrategyDerivationTrialReview {
  readonly candidate: StrategyDerivationCandidateV1;
  readonly candidateFingerprint: string;
  readonly sourceEvidence: DerivationSourceEvidence;
  readonly candidateTrialEvidence: DerivationCandidateTrialEvidence;
  readonly comparableCohorts: readonly DerivationComparableCohort[];
  readonly promotionEligibility: DerivationPromotionEligibility;
}

/** Descriptive alias used by callers that name the artifact first. */
export type DerivationCandidateTrialReview = StrategyDerivationTrialReview;
export type DerivationTrialProfile = DerivationEvidenceProfile;
export type DerivationCandidateTrialProfile = DerivationEvidenceProfile;

interface IndexedReviewRecord {
  readonly recordId: string;
  readonly experience: RunExperience | null;
  readonly reason: string | null;
}

interface CapturedBasePortfolioResult {
  readonly portfolio: TrustedStrategyPortfolio | null;
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

function freezeStringList(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function indexReviewRecords(
  records: readonly RunExperienceSourceRecord[],
): ReadonlyMap<string, IndexedReviewRecord> {
  const grouped = new Map<string, unknown[]>();
  for (const raw of records as readonly unknown[]) {
    if (!isRecord(raw) || typeof raw.recordId !== "string" || raw.recordId.trim() === "") continue;
    const values = grouped.get(raw.recordId) ?? [];
    values.push(raw.experience);
    grouped.set(raw.recordId, values);
  }

  const indexed = new Map<string, IndexedReviewRecord>();
  for (const [recordId, values] of [...grouped.entries()].sort(([left], [right]) =>
    compareText(left, right))) {
    if (values.length !== 1) {
      indexed.set(recordId, Object.freeze({
        recordId,
        experience: null,
        reason: "duplicate Experience record ID",
      }));
      continue;
    }
    let parsed: RunExperience | null;
    try {
      parsed = parseRunExperience(values[0]);
    } catch {
      parsed = null;
    }
    indexed.set(recordId, Object.freeze({
      recordId,
      experience: parsed,
      reason: parsed === null ? "missing or malformed schema-v4 Experience" : null,
    }));
  }
  return indexed;
}

function derivationEvidenceProfile(
  evaluations: readonly RunEvaluation[],
): DerivationEvidenceProfile {
  const profile = deriveRevisionEvidenceProfile(evaluations);
  const exactTaskGoals = [...new Set(evaluations.map((evaluation) => evaluation.source.taskGoal))]
    .sort(compareText);
  const policyProfileIds = [...new Set(evaluations.map((evaluation) =>
    policyEvidenceProfileId(evaluation.policy.finalSnapshot)))]
    .sort(compareText);
  return Object.freeze({
    ...profile,
    distinctExactGoalCount: exactTaskGoals.length,
    exactTaskGoals: freezeStringList(exactTaskGoals),
    distinctPolicyProfileCount: policyProfileIds.length,
    policyProfileIds: freezeStringList(policyProfileIds),
  });
}

function derivationSourceSufficiency(
  evaluations: readonly RunEvaluation[],
): DerivationSourceSufficiency {
  const records = new Set(evaluations.map((evaluation) => evaluation.source.recordId));
  const goals = new Set(evaluations.map((evaluation) => evaluation.source.taskGoal));
  const profiles = new Set(evaluations.map((evaluation) =>
    policyEvidenceProfileId(evaluation.policy.finalSnapshot)));
  return Object.freeze({
    distinctEligibleRecordCount: records.size,
    distinctEligibleExactGoalCount: goals.size,
    distinctEligiblePolicyProfileCount: profiles.size,
    sufficient: records.size >= 3 && goals.size >= 2 && profiles.size >= 2,
  });
}

function selectionSemanticsEqual(
  selection: StrategyRevisionSelection,
  candidate: StrategyDerivationCandidateV1,
): boolean {
  const semantics = (selection as Partial<StrategyRevisionSelection>).semantics;
  return semantics !== undefined && JSON.stringify(semantics) === JSON.stringify({
    summary: candidate.proposal.summary,
    useWhen: [...candidate.proposal.useWhen],
    avoidWhen: [...candidate.proposal.avoidWhen],
    principles: [...candidate.proposal.principles],
  });
}

function derivationSelectionMatches(
  selection: PolicyStrategySelection,
  candidate: StrategyDerivationCandidateV1,
  candidateFingerprint: string,
): boolean {
  return selection.kind === candidate.proposal.kind &&
    strategySelectionId(selection) === candidate.proposal.strategyId &&
    strategySelectionRevisionIdentity(selection) === candidate.candidateId &&
    strategySelectionRevisionFingerprint(selection) === candidateFingerprint &&
    strategySelectionRevisionStatus(selection) === "trial" &&
    selectionSemanticsEqual(selection as StrategyRevisionSelection, candidate);
}

function derivationSelectionInFinalPolicy(
  evaluation: RunEvaluation,
  candidate: StrategyDerivationCandidateV1,
  candidateFingerprint: string,
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (snapshot === null) return false;
  const selections = candidate.proposal.kind === "approach"
    ? [snapshot.approach]
    : snapshot.modifiers;
  return selections.some((selection) =>
    derivationSelectionMatches(selection, candidate, candidateFingerprint));
}

function finalPolicyUsesCapturedPortfolio(
  evaluation: RunEvaluation,
  captured: TrustedStrategyPortfolio | null,
): boolean {
  const snapshot = evaluation.policy.finalSnapshot;
  if (captured === null || snapshot === null) return false;
  const selections = [snapshot.approach, ...snapshot.modifiers];
  // A complete source Policy containing any Trial selection is never source
  // evidence, even when trusted selections occur beside it.
  if (selections.some((selection) =>
    strategySelectionRevisionStatus(selection) === "trial")) return false;
  return selections.every((selection) =>
    resolveTrustedPortfolioSelection(selection as StrategyRevisionSelection, captured) !== null);
}

function sourceRecordReasons(
  evaluation: RunEvaluation | null,
  captured: TrustedStrategyPortfolio | null,
): string[] {
  if (evaluation === null) return ["Experience record is unavailable or malformed"];
  const reasons: string[] = [];
  if (!evaluation.attributionEligible) {
    reasons.push("RunEvaluation.attributionEligible is false");
  }
  if (evaluation.policy.finalSnapshot === null) {
    reasons.push("final Policy is absent");
  }
  if (
    evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0
  ) {
    reasons.push("final Policy has no continuous execution exposure");
  }
  if (captured === null) {
    reasons.push("Candidate captured base portfolio could not be revalidated");
  } else if (!finalPolicyUsesCapturedPortfolio(evaluation, captured)) {
    reasons.push("complete final Policy is not exact trusted Seed/promoted evidence from the captured portfolio");
  }
  return reasons;
}

function trialRecordReasons(
  evaluation: RunEvaluation,
): string[] {
  const reasons: string[] = [];
  if (!evaluation.attributionEligible) {
    reasons.push("RunEvaluation.attributionEligible is false");
  }
  if (
    evaluation.policy.finalPolicyExposureCalls === null ||
    evaluation.policy.finalPolicyExposureCalls <= 0
  ) {
    reasons.push("Candidate was not followed by a non-policy execution call");
  }
  return reasons;
}

function manifestEntrySemantics(
  strategy: SeedStrategy,
): TrustedPortfolioResolvedEntry["semantics"] {
  return Object.freeze({
    summary: strategy.summary,
    useWhen: Object.freeze([...strategy.useWhen]),
    avoidWhen: Object.freeze([...(strategy.avoidWhen ?? [])]),
    principles: Object.freeze([...strategy.principles]),
  });
}

function manifestMatchesSelection(
  manifest: TrustedPortfolioManifestEntry,
  selection: StrategyRevisionSelection,
): boolean {
  return manifest.strategyId === strategySelectionId(selection) &&
    manifest.kind === selection.kind &&
    manifest.revisionIdentity === strategySelectionRevisionIdentity(selection) &&
    manifest.revisionFingerprint === strategySelectionRevisionFingerprint(selection);
}

/**
 * Revalidate the historical base manifest against immutable trust artifacts.
 * The current portfolio is intentionally not used here: a changed current
 * portfolio makes promotion ineligible, but must not erase historical source
 * provenance.
 */
export async function revalidateDerivationBasePortfolio(
  candidate: StrategyDerivationCandidateV1,
  projectRoot?: string,
  revisionCandidateReader?: StrategyCandidateReader,
  revisionDecisionReader?: StrategyRevisionDecisionReader,
  derivationCandidateReader?: StrategyDerivationCandidateReader,
  derivationDecisionReader?: StrategyDerivationDecisionReader,
  seenDerivedCandidateIds: ReadonlySet<string> = new Set(),
): Promise<CapturedBasePortfolioResult> {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const reasons: string[] = [];
  if (projectRoot !== undefined && validated.projectId !== getProjectId(projectRoot)) {
    reasons.push("Candidate projectId does not match the current project root");
  }
  const entries = validated.basePortfolio.entries;
  const seedEntries = entries.filter((entry) => entry.origin === "seed");
  const expectedSeedKeys = new Set(SEED_STRATEGIES.map((strategy) =>
    `${strategy.id}\0${strategy.kind}\0seed\0${seedStrategyFingerprint(strategy)}`));
  const actualSeedKeys = new Set(seedEntries.map((entry) =>
    `${entry.strategyId}\0${entry.kind}\0${entry.revisionIdentity}\0${entry.revisionFingerprint}`));
  if (
    seedEntries.length !== SEED_STRATEGIES.length ||
    actualSeedKeys.size !== expectedSeedKeys.size ||
    [...expectedSeedKeys].some((key) => !actualSeedKeys.has(key))
  ) {
    reasons.push("captured base portfolio does not contain the complete immutable Seed manifest");
  }

  const resolvedEntries: TrustedPortfolioResolvedEntry[] = [];
  const promotedSeedRevisionIdentities = new Set<string>();
  const promotedSeedTargets = new Set<string>();
  const promotedDerivedCandidateIdentities = new Set<string>();
  for (const entry of entries) {
    const manifest = Object.freeze({ ...entry });
    if (entry.origin === "seed") {
      const seed = getSeedStrategy(entry.strategyId);
      if (
        seed === null ||
        seed.kind !== entry.kind ||
        entry.revisionIdentity !== "seed" ||
        entry.revisionFingerprint !== seedStrategyFingerprint(seed)
      ) {
        reasons.push(`captured Seed manifest entry '${entry.strategyId}' is not exact`);
        continue;
      }
      resolvedEntries.push(Object.freeze({
        manifest,
        semantics: manifestEntrySemantics(seed),
      }));
      continue;
    }

    if (entry.origin === "promoted-derived") {
      if (promotedSeedRevisionIdentities.has(entry.revisionIdentity) ||
        promotedDerivedCandidateIdentities.has(entry.revisionIdentity)) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' reuses another Candidate identity`);
        continue;
      }
      if (seenDerivedCandidateIds.has(entry.revisionIdentity)) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' contains a cyclic Candidate binding`);
        continue;
      }
      promotedDerivedCandidateIdentities.add(entry.revisionIdentity);
      if (projectRoot === undefined || derivationCandidateReader === undefined || derivationDecisionReader === undefined) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' cannot be revalidated without Derivation trust readers`);
        continue;
      }
      let rawCandidate: unknown;
      let rawDecision: unknown;
      try {
        rawCandidate = await derivationCandidateReader.read(projectRoot, entry.revisionIdentity);
        rawDecision = await derivationDecisionReader.read(projectRoot, entry.revisionIdentity);
      } catch (error) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' could not be read: ${errorMessage(error)}`);
        continue;
      }
      if (rawCandidate === null) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' is missing its Candidate artifact`);
        continue;
      }
      if (rawDecision === null) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' is missing its terminal Decision`);
        continue;
      }
      try {
        const promotedCandidate = validateStrategyDerivationCandidateArtifact(
          rawCandidate,
          entry.revisionIdentity,
        );
        if (promotedCandidate.projectId !== validated.projectId) {
          throw new Error("Candidate project binding does not match the captured project");
        }
        const decision = validateStrategyDerivationDecisionArtifact(
          rawDecision,
          entry.revisionIdentity,
        );
        const boundDecision = validateStrategyDerivationDecisionBinding(decision, promotedCandidate);
        if (boundDecision.decision !== "promoted") {
          throw new Error("Candidate is not backed by a promoted Derivation Decision");
        }
        const selection = createStrategyRevisionSelection({
          strategyId: promotedCandidate.proposal.strategyId,
          kind: promotedCandidate.proposal.kind,
          revisionIdentity: promotedCandidate.candidateId,
          revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(promotedCandidate),
          revisionStatusAtRun: "promoted",
          semantics: {
            summary: promotedCandidate.proposal.summary,
            useWhen: [...promotedCandidate.proposal.useWhen],
            avoidWhen: [...promotedCandidate.proposal.avoidWhen],
            principles: [...promotedCandidate.proposal.principles],
          },
        });
        if (!manifestMatchesSelection(manifest, selection)) {
          throw new Error("manifest does not match the immutable promoted Candidate");
        }
        const nested = await revalidateDerivationBasePortfolio(
          promotedCandidate,
          projectRoot,
          revisionCandidateReader,
          revisionDecisionReader,
          derivationCandidateReader,
          derivationDecisionReader,
          new Set([...seenDerivedCandidateIds, entry.revisionIdentity]),
        );
        if (!nested.valid) {
          throw new Error(nested.reasons.join("; "));
        }
        resolvedEntries.push(Object.freeze({
          manifest,
          semantics: Object.freeze({
            summary: promotedCandidate.proposal.summary,
            useWhen: Object.freeze([...promotedCandidate.proposal.useWhen]),
            avoidWhen: Object.freeze([...promotedCandidate.proposal.avoidWhen]),
            principles: Object.freeze([...promotedCandidate.proposal.principles]),
          }),
        }));
      } catch (error) {
        reasons.push(`captured promoted-derived entry '${entry.strategyId}' has invalid trust binding: ${errorMessage(error)}`);
      }
      continue;
    }

    if (promotedSeedRevisionIdentities.has(entry.revisionIdentity)) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' duplicates another Candidate identity`);
      continue;
    }
    promotedSeedRevisionIdentities.add(entry.revisionIdentity);
    const promotedSeedTarget = `${entry.strategyId}\0${entry.kind}`;
    if (promotedSeedTargets.has(promotedSeedTarget)) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' duplicates another promoted revision target`);
      continue;
    }
    promotedSeedTargets.add(promotedSeedTarget);
    if (!isCanonicalStrategyDerivationCandidateId(entry.revisionIdentity)) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' has a malformed Candidate ID`);
      continue;
    }
    if (projectRoot === undefined || revisionCandidateReader === undefined || revisionDecisionReader === undefined) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' cannot be revalidated without v0.6 trust readers`);
      continue;
    }
    let rawCandidate: unknown;
    let rawDecision: unknown;
    try {
      rawCandidate = await revisionCandidateReader.read(projectRoot, entry.revisionIdentity);
      rawDecision = await revisionDecisionReader.read(projectRoot, entry.revisionIdentity);
    } catch (error) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' could not be read: ${errorMessage(error)}`);
      continue;
    }
    if (rawCandidate === null) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' is missing its Candidate artifact`);
      continue;
    }
    if (rawDecision === null) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' is missing its terminal Decision`);
      continue;
    }
    try {
      const promotedCandidate = validateStrategyRevisionCandidateArtifact(
        rawCandidate,
        entry.revisionIdentity,
      );
      const decision = validateStrategyRevisionDecisionArtifact(
        rawDecision,
        entry.revisionIdentity,
      );
      const boundDecision = validateStrategyRevisionDecisionBinding(decision, promotedCandidate);
      if (boundDecision.decision !== "promoted") {
        reasons.push(`captured promoted Seed entry '${entry.strategyId}' is not backed by a promoted Decision`);
        continue;
      }
      const selection = strategyRevisionSelectionFromCandidate(promotedCandidate, "promoted");
      if (!manifestMatchesSelection(manifest, selection)) {
        reasons.push(`captured promoted Seed entry '${entry.strategyId}' does not match its immutable Candidate`);
        continue;
      }
      resolvedEntries.push(Object.freeze({
        manifest,
        semantics: Object.freeze({
          summary: promotedCandidate.proposal.summary,
          useWhen: Object.freeze([...promotedCandidate.proposal.useWhen]),
          avoidWhen: Object.freeze([...promotedCandidate.proposal.avoidWhen]),
          principles: Object.freeze([...promotedCandidate.proposal.principles]),
        }),
      }));
    } catch (error) {
      reasons.push(`captured promoted Seed entry '${entry.strategyId}' has invalid trust binding: ${errorMessage(error)}`);
    }
  }

  const computedFingerprint = trustedPortfolioFingerprint(
    validated.projectId,
    entries,
  );
  if (computedFingerprint !== validated.basePortfolio.fingerprint) {
    reasons.push("captured base portfolio fingerprint is not reproducible");
  }
  if (reasons.length > 0) {
    return Object.freeze({
      portfolio: null,
      valid: false,
      reasons: freezeStringList(reasons),
    });
  }
  const portfolio: TrustedStrategyPortfolio = Object.freeze({
    projectId: validated.projectId,
    fingerprintVersion: validated.basePortfolio.fingerprintVersion,
    fingerprint: validated.basePortfolio.fingerprint,
    entries: Object.freeze(resolvedEntries.map((entry) => entry.manifest)),
    resolvedEntries: Object.freeze(resolvedEntries),
  });
  return Object.freeze({
    portfolio,
    valid: true,
    reasons: Object.freeze([]),
  });
}

function makeEvidenceRecord(
  recordId: string,
  evaluation: RunEvaluation | null,
  reasons: readonly string[],
): DerivationEvidenceRecord {
  return Object.freeze({
    recordId,
    eligible: reasons.length === 0 && evaluation !== null,
    taskGoal: evaluation?.source.taskGoal ?? null,
    policyProfileId: evaluation?.policy.finalSnapshot === null || evaluation === null
      ? null
      : policyEvidenceProfileId(evaluation.policy.finalSnapshot),
    evaluation,
    reasons: freezeStringList(reasons),
  });
}

/** Revalidate exactly the source IDs retained by one Derivation Candidate. */
export async function deriveDerivationSourceEvidence(
  candidate: StrategyDerivationCandidateV1,
  records: readonly RunExperienceSourceRecord[],
  options: Pick<DerivationTrialReviewOptions, "projectRoot" | "revisionCandidateReader" | "revisionDecisionReader" | "derivationCandidateReader" | "derivationDecisionReader"> = {},
): Promise<DerivationSourceEvidence> {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const captured = await revalidateDerivationBasePortfolio(
    validated,
    options.projectRoot,
    options.revisionCandidateReader,
    options.revisionDecisionReader,
    options.derivationCandidateReader,
    options.derivationDecisionReader,
  );
  const indexed = indexReviewRecords(records);
  const citedSourceRecordIds = [...validated.evidence.sourceRecordIds].sort(compareText);
  const evidenceRecords = citedSourceRecordIds.map((recordId) => {
    const indexedRecord = indexed.get(recordId);
    if (indexedRecord === undefined) {
      return makeEvidenceRecord(recordId, null, ["cited source Experience record is missing"]);
    }
    const evaluation = indexedRecord.experience === null
      ? null
      : evaluateRunExperience({ recordId, experience: indexedRecord.experience });
    const reasons = indexedRecord.reason === null
      ? sourceRecordReasons(evaluation, captured.portfolio)
      : [indexedRecord.reason, ...(
        evaluation === null ? [] : sourceRecordReasons(evaluation, captured.portfolio)
      )];
    return makeEvidenceRecord(recordId, evaluation, reasons);
  });
  const eligibleEvaluations = Object.freeze(evidenceRecords
    .filter((record) => record.eligible && record.evaluation !== null)
    .map((record) => record.evaluation!));
  const sufficiency = derivationSourceSufficiency(eligibleEvaluations);
  const invalidSourceRecordIds = Object.freeze(evidenceRecords
    .filter((record) => !record.eligible)
    .map((record) => record.recordId));
  const provenanceReasons: string[] = [...captured.reasons];
  if (invalidSourceRecordIds.length > 0) {
    provenanceReasons.push("one or more cited source Experience records failed fresh eligibility validation");
  }
  if (!sufficiency.sufficient) {
    provenanceReasons.push("eligible source evidence does not satisfy 3 records, 2 exact goals, and 2 Policy profiles");
  }
  const profile = derivationEvidenceProfile(eligibleEvaluations);
  return Object.freeze({
    citedSourceRecordIds: Object.freeze(citedSourceRecordIds),
    records: Object.freeze(evidenceRecords),
    eligibleEvaluations,
    profile,
    sufficiency,
    provenanceValid: captured.valid && invalidSourceRecordIds.length === 0,
    capturedBasePortfolioValid: captured.valid,
    invalidSourceRecordIds,
    provenanceReasons: freezeStringList(provenanceReasons),
  });
}

/**
 * Select exact Derivation Candidate Trial evidence from valid schema-v4
 * records. The returned set contains no source-policy or Seed baseline data.
 */
export function selectDerivationCandidateTrialEvidence(
  candidate: StrategyDerivationCandidateV1,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const fingerprint = strategyDerivationCandidateSemanticFingerprint(validated);
  const indexed = indexReviewRecords(records);
  const selected: RunEvaluation[] = [];
  for (const record of [...indexed.values()].sort((left, right) =>
    compareText(left.recordId, right.recordId))) {
    if (record.experience === null) continue;
    const evaluation = evaluateRunExperience({
      recordId: record.recordId,
      experience: record.experience,
    });
    if (
      evaluation.attributionEligible &&
      derivationSelectionInFinalPolicy(evaluation, validated, fingerprint) &&
      evaluation.policy.finalPolicyExposureCalls !== null &&
      evaluation.policy.finalPolicyExposureCalls > 0
    ) selected.push(evaluation);
  }
  return Object.freeze(selected);
}

export const selectEligibleDerivationCandidateTrialEvidence = selectDerivationCandidateTrialEvidence;

function deriveCandidateTrialEvidence(
  candidate: StrategyDerivationCandidateV1,
  records: readonly RunExperienceSourceRecord[],
): DerivationCandidateTrialEvidence {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const fingerprint = strategyDerivationCandidateSemanticFingerprint(validated);
  const indexed = indexReviewRecords(records);
  const evidenceRecords: DerivationEvidenceRecord[] = [];
  for (const record of [...indexed.values()].sort((left, right) =>
    compareText(left.recordId, right.recordId))) {
    if (record.experience === null) continue;
    const evaluation = evaluateRunExperience({
      recordId: record.recordId,
      experience: record.experience,
    });
    if (!derivationSelectionInFinalPolicy(evaluation, validated, fingerprint)) continue;
    evidenceRecords.push(makeEvidenceRecord(
      record.recordId,
      evaluation,
      trialRecordReasons(evaluation),
    ));
  }
  const eligibleEvaluations = Object.freeze(evidenceRecords
    .filter((record) => record.eligible && record.evaluation !== null)
    .map((record) => record.evaluation!));
  return Object.freeze({
    records: Object.freeze(evidenceRecords),
    eligibleEvaluations,
    profile: derivationEvidenceProfile(eligibleEvaluations),
    ineligibleTrialRecordIds: Object.freeze(
      evidenceRecords.filter((record) => !record.eligible).map((record) => record.recordId),
    ),
  });
}

/** Only exact task.goal equality can form a source/Trial cohort. */
export function deriveDerivationComparableCohorts(
  sourceEvaluations: readonly RunEvaluation[],
  trialEvaluations: readonly RunEvaluation[],
): readonly DerivationComparableCohort[] {
  const grouped = new Map<string, { source: string[]; trial: string[] }>();
  for (const evaluation of sourceEvaluations) {
    const entry = grouped.get(evaluation.source.taskGoal) ?? { source: [], trial: [] };
    entry.source.push(evaluation.source.recordId);
    grouped.set(evaluation.source.taskGoal, entry);
  }
  for (const evaluation of trialEvaluations) {
    const entry = grouped.get(evaluation.source.taskGoal) ?? { source: [], trial: [] };
    entry.trial.push(evaluation.source.recordId);
    grouped.set(evaluation.source.taskGoal, entry);
  }
  return Object.freeze([...grouped.entries()]
    .filter(([, entry]) => entry.source.length > 0 && entry.trial.length > 0)
    .sort(([left], [right]) => compareText(left, right))
    .map(([taskGoal, entry]) => Object.freeze({
      taskGoal,
      sourceRecordIds: freezeStringList([...new Set(entry.source)].sort(compareText)),
      trialRecordIds: freezeStringList([...new Set(entry.trial)].sort(compareText)),
    })));
}

const DERIVATION_REVIEW_LOGICAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DERIVATION_REVIEW_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const DERIVATION_REVIEW_PROJECT_ID = /^[0-9a-f]{64}$/;
const DERIVATION_REVIEW_MANIFEST_FIELDS = [
  "origin",
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
] as const;
const DERIVATION_REVIEW_RESOLVED_FIELDS = ["manifest", "semantics"] as const;
const DERIVATION_REVIEW_SEMANTICS_FIELDS = [
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
] as const;

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function reviewManifestSortKey(
  entry: TrustedPortfolioManifestEntry,
): string {
  return [
    entry.origin,
    entry.strategyId,
    entry.kind,
    entry.revisionIdentity,
    entry.revisionFingerprint,
  ].join("\0");
}

function reviewSemanticsEqual(
  left: Record<string, unknown>,
  right: TrustedPortfolioResolvedEntry["semantics"],
): boolean {
  return JSON.stringify(left) === JSON.stringify({
    summary: right.summary,
    useWhen: [...right.useWhen],
    avoidWhen: [...right.avoidWhen],
    principles: [...right.principles],
  });
}

function isBoundedReviewSemantics(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, DERIVATION_REVIEW_SEMANTICS_FIELDS)) return false;
  const summary = value.summary;
  const useWhen = value.useWhen;
  const avoidWhen = value.avoidWhen;
  const principles = value.principles;
  if (
    typeof summary !== "string" || summary.trim() === "" || summary.length > 512 ||
    !Array.isArray(useWhen) || useWhen.length < 1 || useWhen.length > 8 ||
    !Array.isArray(avoidWhen) || avoidWhen.length > 8 ||
    !Array.isArray(principles) || principles.length < 1 || principles.length > 8
  ) return false;
  return [useWhen, avoidWhen, principles].every((items) =>
    items.every((item) =>
      typeof item === "string" && item.trim() !== "" && item.length <= 256));
}

function isCoherentReviewManifestEntry(
  value: unknown,
): value is TrustedPortfolioManifestEntry {
  if (!isRecord(value) || !hasExactKeys(value, DERIVATION_REVIEW_MANIFEST_FIELDS)) return false;
  if (
    value.origin !== "seed" &&
    value.origin !== "promoted-seed-revision" &&
    value.origin !== "promoted-derived"
  ) return false;
  if (
    typeof value.strategyId !== "string" ||
    value.strategyId.length < 1 ||
    value.strategyId.length > 64 ||
    value.strategyId.trim() !== value.strategyId ||
    !DERIVATION_REVIEW_LOGICAL_ID.test(value.strategyId) ||
    (value.kind !== "approach" && value.kind !== "modifier") ||
    typeof value.revisionIdentity !== "string" ||
    typeof value.revisionFingerprint !== "string" ||
    !DERIVATION_REVIEW_FINGERPRINT.test(value.revisionFingerprint)
  ) return false;
  return value.origin === "seed"
    ? value.revisionIdentity === "seed"
    : isCanonicalStrategyCandidateId(value.revisionIdentity);
}

function isCurrentPortfolioCoherent(
  portfolio: TrustedStrategyPortfolio | null,
  projectRoot?: string,
): boolean {
  if (portfolio === null) return false;
  try {
    if (
      typeof portfolio.projectId !== "string" ||
      !DERIVATION_REVIEW_PROJECT_ID.test(portfolio.projectId) ||
      portfolio.fingerprintVersion !== 1
    ) return false;
    if (
      projectRoot !== undefined &&
      portfolio.projectId !== getProjectId(projectRoot)
    ) return false;
    if (
      !Array.isArray(portfolio.entries) ||
      portfolio.entries.length < SEED_STRATEGIES.length ||
      portfolio.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES ||
      !Array.isArray(portfolio.resolvedEntries) ||
      portfolio.entries.length !== portfolio.resolvedEntries.length
    ) return false;

    const seenEntries = new Set<string>();
    const seenRevisionIdentities = new Set<string>();
    const seenPromotedTargets = new Set<string>();
    const seenDerivedLogicalIds = new Set<string>();
    let seedCount = 0;
    for (let index = 0; index < portfolio.entries.length; index += 1) {
      const entry = portfolio.entries[index];
      if (!isCoherentReviewManifestEntry(entry)) return false;
      if (index > 0 && reviewManifestSortKey(portfolio.entries[index - 1]!) >= reviewManifestSortKey(entry)) {
        return false;
      }
      const entryKey = reviewManifestSortKey(entry);
      if (seenEntries.has(entryKey)) return false;
      seenEntries.add(entryKey);

      const seed = getSeedStrategy(entry.strategyId);
      if (entry.origin === "promoted-derived") {
        // A TrustedStrategyPortfolio is already the runtime projection of its
        // immutable trust artifacts. Slice C does not reconstruct a Derived
        // catalog, but it can still count a structurally coherent entry for
        // the bounded current-portfolio facts.
        if (seenRevisionIdentities.has(entry.revisionIdentity) ||
          seenDerivedLogicalIds.has(entry.strategyId)) return false;
        seenRevisionIdentities.add(entry.revisionIdentity);
        seenDerivedLogicalIds.add(entry.strategyId);
      } else if (entry.origin === "seed") {
        if (
          seed === null ||
          seed.kind !== entry.kind ||
          entry.revisionFingerprint !== seedStrategyFingerprint(seed)
        ) return false;
        seedCount += 1;
      } else {
        if (seed === null || seed.kind !== entry.kind) return false;
        if (seenRevisionIdentities.has(entry.revisionIdentity)) return false;
        seenRevisionIdentities.add(entry.revisionIdentity);
        const targetKey = `${entry.strategyId}\0${entry.kind}`;
        if (seenPromotedTargets.has(targetKey)) return false;
        seenPromotedTargets.add(targetKey);
      }

      const resolved = portfolio.resolvedEntries[index];
      if (
        !isRecord(resolved) ||
        (!hasExactKeys(resolved, DERIVATION_REVIEW_RESOLVED_FIELDS) &&
          !hasExactKeys(resolved, [...DERIVATION_REVIEW_RESOLVED_FIELDS, "trust"])) ||
        !isCoherentReviewManifestEntry(resolved.manifest) ||
        JSON.stringify(entry) !== JSON.stringify(resolved.manifest) ||
        !isBoundedReviewSemantics(resolved.semantics)
      ) return false;
      if (entry.origin === "seed" && !reviewSemanticsEqual(resolved.semantics, manifestEntrySemantics(seed!))) {
        return false;
      }
    }
    if (seedCount !== SEED_STRATEGIES.length ||
      [...seenDerivedLogicalIds].some((strategyId) =>
        SEED_STRATEGIES.some((strategy) => strategy.id === strategyId))) return false;
    if (trustedPortfolioFingerprint(portfolio.projectId, portfolio.entries) !== portfolio.fingerprint) return false;
    return true;
  } catch {
    return false;
  }
}

function basePortfolioSnapshot(
  candidate: StrategyDerivationCandidateV1,
): Pick<TrustedStrategyPortfolio, "projectId" | "fingerprintVersion" | "fingerprint" | "entries"> {
  return {
    projectId: candidate.projectId,
    fingerprintVersion: candidate.basePortfolio.fingerprintVersion,
    fingerprint: candidate.basePortfolio.fingerprint,
    entries: candidate.basePortfolio.entries,
  };
}

/** Derive read-only Promotion Eligibility facts for a Derivation Candidate. */
export function deriveDerivationPromotionEligibility(
  candidate: StrategyDerivationCandidateV1,
  sourceEvidence: DerivationSourceEvidence,
  trialEvidence: DerivationCandidateTrialEvidence,
  options: Pick<DerivationTrialReviewOptions, "projectRoot" | "currentProjectMatch" | "currentPortfolio" | "priorTerminalDecision"> = {},
): DerivationPromotionEligibility {
  const currentProjectMatch = options.projectRoot === undefined
    ? options.currentProjectMatch !== false
    : candidate.projectId === getProjectId(options.projectRoot);
  const currentPortfolio = options.currentPortfolio ?? null;
  const currentPortfolioAvailable = isCurrentPortfolioCoherent(currentPortfolio, options.projectRoot);
  const currentPortfolioMatch = currentProjectMatch && currentPortfolioAvailable &&
    currentPortfolio !== null &&
    sameTrustedPortfolioSnapshot(basePortfolioSnapshot(candidate), currentPortfolio);
  const logicalStrategyIdAvailable = currentPortfolioAvailable && currentProjectMatch &&
    currentPortfolio !== null &&
    !trustedLogicalStrategyIds(currentPortfolio).includes(candidate.proposal.strategyId);
  const noExactTrustedSemanticDuplicate = currentPortfolioAvailable &&
    currentPortfolio !== null &&
    !hasExactTrustedStrategySemanticDuplicate(candidate.proposal, currentPortfolio);
  const promotedDerivedCount = currentPortfolioAvailable && currentPortfolio !== null
    ? currentPortfolio.entries.filter((entry) => entry.origin === "promoted-derived").length
    : MAX_PROMOTED_DERIVED_STRATEGIES;
  const derivedStrategyCapacityAvailable = currentPortfolioAvailable &&
    promotedDerivedCount < MAX_PROMOTED_DERIVED_STRATEGIES;
  const noPriorTerminalDecision = options.priorTerminalDecision !== true;
  const eligibleTrialRunCount = new Set(trialEvidence.profile.sourceRecordIds).size;
  const reasons: string[] = [];
  if (eligibleTrialRunCount < 2) reasons.push("at least 2 eligible Candidate Trial Runs are required");
  if (!sourceEvidence.capturedBasePortfolioValid) reasons.push("immutable Candidate binding is not valid");
  if (!sourceEvidence.provenanceValid) reasons.push("Derivation source provenance is not valid");
  if (!sourceEvidence.sufficiency.sufficient) reasons.push("Derivation source sufficiency is not valid");
  if (!currentProjectMatch) reasons.push("current project match is not established");
  if (!currentPortfolioMatch) reasons.push("Candidate base portfolio does not match the current trusted portfolio");
  if (!logicalStrategyIdAvailable) reasons.push("proposed logical Strategy ID is already trusted or unavailable");
  if (!noExactTrustedSemanticDuplicate) reasons.push("proposal is an exact semantic duplicate of a trusted Strategy");
  if (!derivedStrategyCapacityAvailable) reasons.push("promoted Derived Strategy capacity is full or unavailable");
  if (!noPriorTerminalDecision) reasons.push("a terminal Derivation Decision already exists for this Candidate");
  return Object.freeze({
    eligible: reasons.length === 0,
    requiredTrialRunCount: 2,
    eligibleTrialRunCount,
    candidateBindingValid: sourceEvidence.capturedBasePortfolioValid,
    derivationSourceProvenanceValid: sourceEvidence.provenanceValid,
    sourceSufficiencyValid: sourceEvidence.sufficiency.sufficient,
    currentProjectMatch,
    currentPortfolioMatch,
    logicalStrategyIdAvailable,
    noExactTrustedSemanticDuplicate,
    derivedStrategyCapacityAvailable,
    noPriorTerminalDecision,
    reasons: freezeStringList(reasons),
  });
}

/**
 * Recompute a Derivation review from immutable Candidate/Experience/trust
 * facts. It never writes a Candidate, Decision, Experience, State, or Policy.
 */
export async function deriveStrategyDerivationTrialReview(
  candidate: StrategyDerivationCandidateV1,
  records: readonly RunExperienceSourceRecord[],
  options: DerivationTrialReviewOptions = {},
): Promise<StrategyDerivationTrialReview> {
  const validated = validateStrategyDerivationCandidateArtifact(
    candidate,
    candidate.candidateId,
  );
  const sourceEvidence = await deriveDerivationSourceEvidence(
    validated,
    records,
    options,
  );
  const candidateTrialEvidence = deriveCandidateTrialEvidence(validated, records);
  const comparableCohorts = deriveDerivationComparableCohorts(
    sourceEvidence.eligibleEvaluations,
    candidateTrialEvidence.eligibleEvaluations,
  );
  const promotionEligibility = deriveDerivationPromotionEligibility(
    validated,
    sourceEvidence,
    candidateTrialEvidence,
    options,
  );
  return Object.freeze({
    candidate: validated,
    candidateFingerprint: strategyDerivationCandidateSemanticFingerprint(validated),
    sourceEvidence,
    candidateTrialEvidence,
    comparableCohorts,
    promotionEligibility,
  });
}

export const deriveDerivationCandidateTrialReview = deriveStrategyDerivationTrialReview;
export const deriveDerivationTrialReview = deriveStrategyDerivationTrialReview;
export const evaluateDerivationCandidateTrial = deriveStrategyDerivationTrialReview;
export const buildStrategyDerivationTrialReview = deriveStrategyDerivationTrialReview;
export const buildDerivationTrialReview = deriveStrategyDerivationTrialReview;
export const selectDerivationTrialEvidence = selectDerivationCandidateTrialEvidence;

const MAX_DERIVATION_REVIEW_IDENTIFIER_LENGTH = 256;
const MAX_DERIVATION_REVIEW_GOALS = 10;
const MAX_DERIVATION_REVIEW_SOURCE_IDS = 8;

function escapeDerivationReviewText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

function boundedDerivationReviewIdentifier(value: string): string {
  const escaped = escapeDerivationReviewText(value);
  if (escaped.length <= MAX_DERIVATION_REVIEW_IDENTIFIER_LENGTH) return escaped;
  return `${escaped.slice(0, MAX_DERIVATION_REVIEW_IDENTIFIER_LENGTH - 12)} [truncated]`;
}

function boundedDerivationReviewText(value: string): string {
  return boundedReviewText(escapeDerivationReviewText(value));
}

function boundedDerivationReviewGoal(value: string): string {
  return boundedDerivationReviewText(value);
}

function formatDerivationRecordIds(
  recordIds: readonly string[],
  maxVisible = MAX_RENDERED_REVIEW_RECORD_IDS,
): string {
  const visible = recordIds.slice(0, maxVisible)
    .map(boundedDerivationReviewIdentifier);
  const omitted = recordIds.length - visible.length;
  return `${visible.length > 0 ? visible.join(", ") : "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function formatDerivationGoals(goals: readonly string[]): string {
  const visible = goals.slice(0, MAX_DERIVATION_REVIEW_GOALS)
    .map(boundedDerivationReviewGoal);
  const omitted = goals.length - visible.length;
  return `${visible.length > 0 ? visible.join(" | ") : "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`;
}

function formatDerivationProfile(
  profile: DerivationEvidenceProfile,
  label: string,
): string[] {
  return [
    `${label}:`,
    `  Eligible Runs: ${profile.runCount}`,
    `  Distinct exact Task goals: ${profile.distinctExactGoalCount}`,
    `  Distinct Policy profiles: ${profile.distinctPolicyProfileCount}`,
    `  Verification passed: ${profile.verificationPassedCount} · not passed: ${Math.max(0, profile.runCount - profile.verificationPassedCount)}`,
    `  Completed during Run: ${profile.completedDuringRunCount} · not completed during Run: ${Math.max(0, profile.runCount - profile.completedDuringRunCount)}`,
    `  Tool errors: ${profile.totalToolErrors} · denied calls: ${profile.totalDeniedCalls}`,
    `  Declarations: ${formatSummary(profile.declarationCount)} · final-Policy declarations: ${formatSummary(profile.finalPolicyDeclarationCount)}`,
    `  First final-Policy declaration progress: ${formatSummary(profile.exposure.finalPolicyFirstDeclarationProgress, true)}`,
    `  Last final-Policy activation progress: ${formatSummary(profile.exposure.finalPolicyLastActivationProgress, true)}`,
    `  Continuous final-Policy exposure calls: ${formatSummary(profile.exposure.calls)} · ratio: ${formatSummary(profile.exposure.ratio, true)}`,
    `  DurationMs: ${formatSummary(profile.durationMs)} · cost: ${formatSummary(profile.cost)}`,
    `  Exact Task goals: ${formatDerivationGoals(profile.exactTaskGoals)}`,
    `  Exact Policy profile IDs: ${formatDerivationRecordIds(profile.policyProfileIds)}`,
    `  Eligible source Experience IDs: ${formatDerivationRecordIds(profile.sourceRecordIds)}`,
  ];
}

function formatDerivationRecordIssues(
  records: readonly DerivationEvidenceRecord[],
  label: string,
): string[] {
  const invalid = records.filter((record) => !record.eligible);
  if (invalid.length === 0) return [`${label}: none`];
  const lines = [`${label}:`];
  for (const record of invalid.slice(0, MAX_DERIVATION_REVIEW_RECORDS)) {
    lines.push(`  - ${boundedDerivationReviewIdentifier(record.recordId)}: ${record.reasons
      .map(boundedDerivationReviewText)
      .join("; ")}`);
  }
  if (invalid.length > MAX_DERIVATION_REVIEW_RECORDS) {
    lines.push(`  ... +${invalid.length - MAX_DERIVATION_REVIEW_RECORDS} more`);
  }
  return lines;
}

/** Format a bounded, evidence-only Derivation review with no Seed baseline. */
export function formatStrategyDerivationTrialReview(
  read: RunExperienceReadResult,
  review: StrategyDerivationTrialReview,
): string {
  const eligibility = review.promotionEligibility;
  const source = review.sourceEvidence;
  const trial = review.candidateTrialEvidence;
  const lines = [
    "Strategy Derivation Trial Review",
    "",
    "Candidate:",
    `  ${review.candidate.proposal.strategyId} · ${review.candidate.proposal.kind}`,
    `  Candidate ID: ${review.candidate.candidateId}`,
    `  Candidate fingerprint: ${review.candidateFingerprint}`,
    "",
    `Loaded current Experience records: ${read.loadedRecords}`,
    `Unsupported-schema records: ${read.unsupportedSchema}`,
    `Invalid/unreadable records: ${read.invalid}`,
    "",
    "Derivation Source Evidence:",
    `  Cited source Experience IDs: ${formatDerivationRecordIds(source.citedSourceRecordIds, MAX_DERIVATION_REVIEW_SOURCE_IDS)}`,
    `  Eligible source Runs: ${source.profile.runCount}`,
    `  Distinct exact goals: ${source.profile.distinctExactGoalCount}`,
    `  Distinct Policy profiles: ${source.profile.distinctPolicyProfileCount}`,
    `  Source provenance valid: ${source.provenanceValid}`,
    `  Source sufficiency valid: ${source.sufficiency.sufficient}`,
    ...formatDerivationProfile(source.profile, "  Source evidence profile"),
    ...formatDerivationRecordIssues(source.records, "  Cited source records not eligible"),
    ...(source.provenanceReasons.length > 0
      ? ["  Source gate facts:", ...source.provenanceReasons
        .slice(0, MAX_DERIVATION_REVIEW_RECORDS)
        .map((reason) => `    - ${boundedDerivationReviewText(reason)}`)]
      : []),
    "",
    "Candidate Trial Evidence:",
    `  Eligible Trial Runs: ${trial.profile.runCount}`,
    `  Verification passed: ${trial.profile.verificationPassedCount} · not passed: ${Math.max(0, trial.profile.runCount - trial.profile.verificationPassedCount)}`,
    ...formatDerivationProfile(trial.profile, "  Candidate Trial evidence profile"),
    ...formatDerivationRecordIssues(trial.records, "  Exact-Candidate Trial records not eligible"),
    "",
    "Exact-goal comparable cohorts:",
  ];
  if (review.comparableCohorts.length === 0) {
    lines.push(
      "  (none)",
      "  Source and Candidate Trial inventories remain separate because no exact Task goal occurs in both.",
    );
  } else {
    for (const cohort of review.comparableCohorts.slice(0, MAX_DERIVATION_REVIEW_COHORTS)) {
      lines.push(
        `  - Goal: ${boundedDerivationReviewGoal(cohort.taskGoal)}`,
        `    Source records: ${formatDerivationRecordIds(cohort.sourceRecordIds, MAX_DERIVATION_REVIEW_SOURCE_IDS)}`,
        `    Candidate Trial records: ${formatDerivationRecordIds(cohort.trialRecordIds)}`,
      );
    }
    if (review.comparableCohorts.length > MAX_DERIVATION_REVIEW_COHORTS) {
      lines.push(`  ... +${review.comparableCohorts.length - MAX_DERIVATION_REVIEW_COHORTS} more cohorts`);
    }
  }

  lines.push(
    "",
    `Promotion Eligibility: ${eligibility.eligible ? "eligible for human review" : "not eligible"}`,
    "Eligibility means only that enough auditable evidence exists for a Human trust decision; it does not prove novelty, usefulness, superiority, or causal improvement.",
    "Gate facts:",
    `  Eligible Trial Runs: ${eligibility.eligibleTrialRunCount} / ${eligibility.requiredTrialRunCount} required`,
    `  Immutable Candidate binding valid: ${eligibility.candidateBindingValid}`,
    `  Derivation source provenance valid: ${eligibility.derivationSourceProvenanceValid}`,
    `  Source sufficiency valid: ${eligibility.sourceSufficiencyValid}`,
    `  Current project match: ${eligibility.currentProjectMatch}`,
    `  Current portfolio match: ${eligibility.currentPortfolioMatch}`,
    `  Logical Strategy ID available: ${eligibility.logicalStrategyIdAvailable}`,
    `  Exact trusted semantic duplicate absent: ${eligibility.noExactTrustedSemanticDuplicate}`,
    `  Derived Strategy capacity available: ${eligibility.derivedStrategyCapacityAvailable}`,
    `  No prior terminal Decision: ${eligibility.noPriorTerminalDecision}`,
  );
  if (eligibility.reasons.length > 0) {
    lines.push("Gate reasons:", ...eligibility.reasons.map((reason) => `  - ${reason}`));
  }
  lines.push(
    "Evidence inventory only; no Strategy score, ranking, reward, superiority, novelty, usefulness, or causal claim is derived.",
  );
  return lines.join("\n");
}

export const formatDerivationCandidateTrialReview = formatStrategyDerivationTrialReview;
export const formatDerivationTrialReview = formatStrategyDerivationTrialReview;
