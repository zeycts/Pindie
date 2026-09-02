import type {
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "./experience-store.ts";
import type { PolicySnapshot } from "./policy.ts";
import type { RunExperienceExecution } from "./run-experience.ts";

export interface RunEvaluation {
  readonly source: {
    readonly recordId: string;
    readonly recordedAt: string;
    readonly taskGoal: string;
  };
  readonly policy: {
    readonly finalSnapshot: PolicySnapshot | null;
    readonly declarationCount: number;
    readonly firstDeclarationProgress: number | null;
    readonly finalDeclarationProgress: number | null;
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
  readonly exposure: {
    readonly calls: NumericSummary;
    readonly ratio: NumericSummary;
    readonly firstDeclarationProgress: NumericSummary;
    readonly finalDeclarationProgress: NumericSummary;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampRatio(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return clampRatio(numerator / denominator);
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

/** Deterministic identity for a complete explicit Policy Snapshot. */
export function policyProfileId(snapshot: PolicySnapshot | null): string {
  if (snapshot === null) return NO_EXPLICIT_POLICY_PROFILE_ID;
  const modifierIds = [...snapshot.modifiers]
    .map((modifier) => modifier.id)
    .sort((left, right) => compareText(left, right));
  return `policy:${JSON.stringify({
    approachId: snapshot.approach.id,
    modifierIds,
  })}`;
}

/** Derive bounded measurements from one valid schema-v2 Run Experience. */
export function evaluateRunExperience(
  source: RunExperienceSourceRecord,
): RunEvaluation {
  const { experience } = source;
  const toolCalls = experience.execution.toolCalls;
  const finalSnapshot = experience.policy.finalSnapshot;
  const finalDeclarationAfter = experience.policy.finalDeclarationAfter;
  const finalPolicyExposureCalls = finalSnapshot !== null && finalDeclarationAfter !== null
    ? Math.max(0, toolCalls - finalDeclarationAfter.toolCalls)
    : null;

  return {
    source: {
      recordId: source.recordId,
      recordedAt: experience.recordedAt,
      taskGoal: experience.task.goal,
    },
    policy: {
      finalSnapshot,
      declarationCount: experience.policy.declarationCount,
      firstDeclarationProgress: finalSnapshot === null
        ? null
        : declarationProgress(experience.policy.firstDeclarationAfter, toolCalls),
      finalDeclarationProgress: finalSnapshot === null
        ? null
        : declarationProgress(finalDeclarationAfter, toolCalls),
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
  readonly exposureCalls: number[];
  readonly exposureRatios: number[];
  readonly firstDeclarationProgress: number[];
  readonly finalDeclarationProgress: number[];
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
    exposureCalls: [],
    exposureRatios: [],
    firstDeclarationProgress: [],
    finalDeclarationProgress: [],
    durations: [],
    costs: [],
    sourceRecordIds: [],
  };
}

/** Aggregate evaluations by complete normalized Policy Snapshot identity. */
export function derivePolicyEvidenceProfiles(
  evaluations: readonly RunEvaluation[],
): readonly PolicyEvidenceProfile[] {
  const profiles = new Map<string, MutableProfile>();
  for (const evaluation of evaluations) {
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
    addOptional(profile.exposureCalls, evaluation.policy.finalPolicyExposureCalls);
    addOptional(profile.exposureRatios, evaluation.policy.finalPolicyExposureRatio);
    addOptional(profile.firstDeclarationProgress, evaluation.policy.firstDeclarationProgress);
    addOptional(profile.finalDeclarationProgress, evaluation.policy.finalDeclarationProgress);
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
      exposure: Object.freeze({
        calls: summarize(profile.exposureCalls),
        ratio: summarize(profile.exposureRatios),
        firstDeclarationProgress: summarize(profile.firstDeclarationProgress),
        finalDeclarationProgress: summarize(profile.finalDeclarationProgress),
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
  const modifiers = profile.identity.modifierIds.length === 0
    ? ""
    : ` + ${profile.identity.modifierIds.join(", ")}`;
  return `${profile.identity.approachId}${modifiers}`;
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
  const profileLines = evaluation.profiles.length === 0
    ? ["  (none)"]
    : evaluation.profiles.slice(0, MAX_RENDERED_PROFILES).map((profile) => [
      `  - ${profileLabel(profile)} · runs ${profile.runCount} · verification passed ${profile.verificationPassedCount} · completed during Run ${profile.completedDuringRunCount} · tool errors ${profile.totalToolErrors} · denied ${profile.totalDeniedCalls}`,
      `    exposure calls: ${formatSummary(profile.exposure.calls)} · ratio: ${formatSummary(profile.exposure.ratio, true)}`,
      `    durationMs: ${formatSummary(profile.durationMs)} · cost: ${formatSummary(profile.cost)}`,
      `    records: ${formatProfileRecordIds(profile)}`,
    ].join("\n"));
  if (evaluation.profiles.length > MAX_RENDERED_PROFILES) {
    profileLines.push(`... +${evaluation.profiles.length - MAX_RENDERED_PROFILES} more profiles`);
  }

  return [
    "Experience Evaluation",
    "",
    `Loaded schema-v2 records: ${read.loadedSchemaV2}`,
    `Unsupported-schema records: ${read.unsupportedSchema}`,
    `Invalid/unreadable records: ${read.invalid}`,
    `Evaluated Runs: ${evaluation.evaluations.length}`,
    `Explicit-Policy Runs: ${explicitCount}`,
    `No-explicit-Policy Runs: ${noPolicyCount}`,
    "",
    "Policy Evidence Profiles:",
    ...profileLines,
    "",
    `Comparable exact-goal cohorts: ${evaluation.cohorts.length}`,
    "Evidence inventory only; contains no Strategy score, ranking, or causal claim.",
  ].join("\n");
}
