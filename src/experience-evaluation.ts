import type {
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "./experience-store.ts";
import {
  formatStrategySelectionLabel,
  isSeedStrategySelection,
  policySnapshotIdentity,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type PolicySnapshot,
  type PolicyStrategySelection,
  type StrategyRevisionSelection,
} from "./policy.ts";
import {
  strategyCandidateSemanticFingerprint,
  validateStrategyRevisionCandidateArtifact,
  type StrategyRevisionCandidate,
} from "./strategy-candidates.ts";
import {
  getSeedStrategy,
  type SeedStrategy,
} from "./strategies.ts";
import {
  normalizeRunExperience,
  parseRunExperience,
  type RunExperienceExecution,
  type SupportedRunExperience,
} from "./run-experience.ts";

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

/** Deterministic revision-aware identity for a complete explicit Policy Snapshot. */
export function policyProfileId(snapshot: PolicySnapshot | null): string {
  if (snapshot === null) return NO_EXPLICIT_POLICY_PROFILE_ID;
  return `policy:${policySnapshotIdentity(snapshot)}`;
}

/** Derive bounded measurements from one valid supported Run Experience. */
export function evaluateRunExperience(
  source: RunExperienceSourceRecord,
): RunEvaluation {
  const experience: SupportedRunExperience = normalizeRunExperience(source.experience);
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
  return Object.freeze(records.map(evaluateRunExperience));
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
    profileId: policyProfileId(snapshot),
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
    const id = policyProfileId(evaluation.policy.finalSnapshot);
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
        [...new Set(cohort.map((evaluation) => policyProfileId(evaluation.policy.finalSnapshot)))]
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
    `Loaded schema-v3 records: ${read.loadedSchemaV3}`,
    `Loaded schema-v4 records: ${read.loadedSchemaV4 ?? 0}`,
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

function deriveRevisionEvidenceProfile(
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
  allowedSchemas: readonly (3 | 4)[],
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
    let parsed: SupportedRunExperience | null;
    try {
      parsed = parseRunExperience(record.experience);
    } catch {
      parsed = null;
    }
    if (parsed === null || !allowedSchemas.includes(parsed.schemaVersion)) continue;
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
 * Select only valid, current-project schema-v4 Runs whose final Policy
 * contains the exact immutable Candidate revision and real final-Policy
 * execution exposure.
 */
export function selectCandidateTrialEvidence(
  candidate: StrategyRevisionCandidate,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const fingerprint = strategyCandidateSemanticFingerprint(validated);
  const evaluations = deriveRunEvaluations(validExperienceSources(records, [4]));
  return Object.freeze(evaluations.filter((evaluation) =>
    evaluation.attributionEligible &&
    candidateSelectionInFinalPolicy(evaluation, validated, fingerprint) !== null &&
    evaluation.policy.finalPolicyExposureCalls !== null &&
    evaluation.policy.finalPolicyExposureCalls > 0));
}

/**
 * Select exact immutable Seed evidence from supported schema-v3/v4 history.
 * Candidate/promoted revisions cannot satisfy the exact Seed selection check.
 */
export function selectSeedBaselineEvidence(
  candidate: StrategyRevisionCandidate,
  records: readonly RunExperienceSourceRecord[],
): readonly RunEvaluation[] {
  const validated = validateStrategyRevisionCandidateArtifact(candidate, candidate.candidateId);
  const target = getSeedStrategy(validated.target.strategyId);
  if (target === null || target.kind !== validated.target.kind) {
    throw new Error("Cannot derive Seed baseline: Candidate target is not an immutable Seed Strategy.");
  }
  const evaluations = deriveRunEvaluations(validExperienceSources(records, [3, 4]));
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
    `Loaded schema-v3 records: ${read.loadedSchemaV3}`,
    `Loaded schema-v4 records: ${read.loadedSchemaV4 ?? 0}`,
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
