import type { ToolEffect } from "./execution-semantics.ts";
import { UUID_V4 } from "./exact-identity.ts";
import { validateTrialAssignment } from "./learning-v1-contract.ts";
import type { TrialRunAttribution } from "./trial-attribution.ts";
import {
  createStrategyRevisionSelection,
  policySnapshotIdentity,
  serializePolicySnapshot,
  type PolicySnapshot,
  type StrategyRevisionSelection,
} from "./policy.ts";
import type {
  CompletionRunRelation,
  SemanticSnapshot,
  TaskRunRelation,
} from "./semantics.ts";
import {
  type PindieTask,
  type TaskStatus,
  type VerificationStatus,
} from "./state.ts";

export const RUN_EXPERIENCE_SCHEMA_VERSION = 5 as const;
export const LEGACY_RUN_EXPERIENCE_SCHEMA_VERSION = 4 as const;
export const TRIAL_RUN_EXPERIENCE_SCHEMA_VERSION = 6 as const;

/** Bounded execution facts collected for one Agent Run. */
export interface RunExperienceExecution {
  readonly toolCalls: number;
  readonly observations: number;
  readonly consequentialCalls: number;
  readonly projectMutationEffectCalls: number;
  readonly verificationCalls: number;
  readonly toolErrors: number;
  readonly deniedCalls: number;
}

export interface RunExperiencePolicy {
  readonly finalSnapshot: PolicySnapshot | null;
  /** All successful Policy declarations in the Run. */
  readonly declarationCount: number;
  /** Successful declarations with the final Policy identity. */
  readonly finalPolicyDeclarationCount: number;
  /** Counters immediately before the first successful final-Policy declaration. */
  readonly finalPolicyFirstDeclaredAfter: RunExperienceExecution | null;
  /** Counters immediately before the last successful final-Policy declaration. */
  readonly finalPolicyLastDeclaredAfter: RunExperienceExecution | null;
}

interface RunExperienceFields {
  readonly recordedAt: string;
  readonly runStart: {
    readonly taskStatus: TaskStatus;
    readonly taskGoal: string | null;
  };
  readonly task: {
    readonly goal: string;
    readonly taskRelation: TaskRunRelation;
  };
  readonly policy: RunExperiencePolicy;
  readonly execution: RunExperienceExecution;
  readonly outcome: {
    readonly taskStatus: TaskStatus;
    readonly verificationStatus: VerificationStatus | "none";
    readonly completionRelation: CompletionRunRelation;
    readonly hasBlockers: boolean;
    readonly hasQuestions: boolean;
    readonly humanGateOpen: boolean;
  };
  readonly metrics: {
    readonly durationMs: number | null;
    readonly cost: number | null;
  };
}

export interface LegacyRunExperience extends RunExperienceFields {
  readonly schemaVersion: typeof LEGACY_RUN_EXPERIENCE_SCHEMA_VERSION;
}
/** v5 records carry exact operational identity when coherently bound. */
export interface EpisodeRunExperience extends RunExperienceFields {
  readonly schemaVersion: typeof RUN_EXPERIENCE_SCHEMA_VERSION;
  readonly workEpisodeId: string;
}
/** v6 adds exact factual experimental attribution only to exposed Runs. */
export interface TrialRunExperience extends RunExperienceFields {
  readonly schemaVersion: typeof TRIAL_RUN_EXPERIENCE_SCHEMA_VERSION;
  readonly workEpisodeId: string;
  readonly trialAttribution: TrialRunAttribution;
}
export type RunExperience = LegacyRunExperience | EpisodeRunExperience | TrialRunExperience;

const ZERO_EXECUTION: RunExperienceExecution = Object.freeze({
  toolCalls: 0,
  observations: 0,
  consequentialCalls: 0,
  projectMutationEffectCalls: 0,
  verificationCalls: 0,
  toolErrors: 0,
  deniedCalls: 0,
});

type AuthorizedCallKind = "execution" | "policy" | "self-improvement" | "memory";

function copyExecution(
  counters: RunExperienceExecution,
): RunExperienceExecution {
  return Object.freeze({
    toolCalls: counters.toolCalls,
    observations: counters.observations,
    consequentialCalls: counters.consequentialCalls,
    projectMutationEffectCalls: counters.projectMutationEffectCalls,
    verificationCalls: counters.verificationCalls,
    toolErrors: counters.toolErrors,
    deniedCalls: counters.deniedCalls,
  });
}

function copyPolicySnapshot(snapshot: PolicySnapshot): PolicySnapshot {
  return Object.freeze({
    approach: snapshot.approach,
    modifiers: Object.freeze([...snapshot.modifiers]),
  });
}

/** Runtime-only bounded telemetry for the current Agent Run. */
export class RunExperienceTracker {
  private counters: RunExperienceExecution = copyExecution(ZERO_EXECUTION);
  private readonly authorizedCalls = new Map<string, AuthorizedCallKind>();
  private currentPolicySnapshot: PolicySnapshot | null = null;
  private lastSuccessfulPolicySnapshot: PolicySnapshot | null = null;
  private pendingPolicyPrevious: PolicySnapshot | null | undefined;
  private declarationCount = 0;
  private readonly policyAttributions = new Map<string, {
    count: number;
    firstDeclaredAfter: RunExperienceExecution;
    lastDeclaredAfter: RunExperienceExecution;
  }>();

  reset(): void {
    this.counters = copyExecution(ZERO_EXECUTION);
    this.authorizedCalls.clear();
    this.currentPolicySnapshot = null;
    this.lastSuccessfulPolicySnapshot = null;
    this.pendingPolicyPrevious = undefined;
    this.declarationCount = 0;
    this.policyAttributions.clear();
  }

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    this.pendingPolicyPrevious = this.currentPolicySnapshot;
    this.currentPolicySnapshot = snapshot;
  }

  /** Record a call admitted by the live Gateway without classifying prose. */
  recordAuthorizedCall(toolCallId: string, effect: ToolEffect): void {
    const isPolicy = effect.requiredCapability === "policy.declare";
    const isSelfImprovement = effect.requiredCapability === "policy.adapt" ||
      effect.requiredCapability === "policy.derive";
    const isMemory = effect.requiredCapability === "memory.capture";
    this.authorizedCalls.set(
      toolCallId,
      isPolicy
        ? "policy"
        : isSelfImprovement
          ? "self-improvement"
          : isMemory
            ? "memory"
            : "execution",
    );
    if (isPolicy || isSelfImprovement || isMemory) return;

    this.counters = {
      ...this.counters,
      toolCalls: this.counters.toolCalls + 1,
      observations: this.counters.observations + (
        effect.requiredCapability === "observe.project" ||
        effect.requiredCapability === "observe.git" ? 1 : 0
      ),
      consequentialCalls: this.counters.consequentialCalls + (
        effect.requiredCapability === "observe.project" ||
        effect.requiredCapability === "observe.git" ? 0 : 1
      ),
      projectMutationEffectCalls: this.counters.projectMutationEffectCalls + (
        effect.projectMutation === "none" ? 0 : 1
      ),
      verificationCalls: this.counters.verificationCalls + (
        effect.requiredCapability === "verification.record" ? 1 : 0
      ),
    };
  }

  /** Record a call the live Gateway rejected; policy declarations are excluded. */
  recordDeniedCall(effect: ToolEffect): void {
    if (
      effect.requiredCapability === "policy.declare" ||
      effect.requiredCapability === "policy.adapt" ||
      effect.requiredCapability === "policy.derive" ||
      effect.requiredCapability === "memory.capture"
    ) return;
    this.counters = {
      ...this.counters,
      deniedCalls: this.counters.deniedCalls + 1,
    };
  }

  /** Record an actual result for an admitted non-policy call. */
  recordToolResult(
    toolCallId: string,
    isError: boolean,
  ): "execution" | "policy" | "self-improvement" | "memory" | null {
    const kind = this.authorizedCalls.get(toolCallId) ?? null;
    if (kind === null) return null;
    this.authorizedCalls.delete(toolCallId);
    if (kind === "execution" && isError) {
      this.counters = {
        ...this.counters,
        toolErrors: this.counters.toolErrors + 1,
      };
    }
    return kind;
  }

  /** Capture the counters at the moment a policy declaration succeeds. */
  recordSuccessfulPolicyDeclaration(): void {
    if (this.currentPolicySnapshot === null) return;
    this.lastSuccessfulPolicySnapshot = this.currentPolicySnapshot;
    this.pendingPolicyPrevious = undefined;
    const position = copyExecution(this.counters);
    const identity = policySnapshotIdentity(this.currentPolicySnapshot);
    const attribution = this.policyAttributions.get(identity);
    if (attribution === undefined) {
      this.policyAttributions.set(identity, {
        count: 1,
        firstDeclaredAfter: position,
        lastDeclaredAfter: position,
      });
    } else {
      attribution.count += 1;
      attribution.lastDeclaredAfter = position;
    }
    this.declarationCount += 1;
  }

  /** Restore the prior current policy when a staged declaration returns an error. */
  recordFailedPolicyDeclaration(): PolicySnapshot | null {
    if (this.pendingPolicyPrevious === undefined) {
      return this.currentPolicySnapshot;
    }
    this.currentPolicySnapshot = this.pendingPolicyPrevious;
    this.pendingPolicyPrevious = undefined;
    return this.currentPolicySnapshot;
  }

  get execution(): RunExperienceExecution {
    return copyExecution(this.counters);
  }

  get policy(): RunExperiencePolicy {
    const finalSnapshot = this.lastSuccessfulPolicySnapshot === null
      ? null
      : copyPolicySnapshot(this.lastSuccessfulPolicySnapshot);
    const finalAttribution = this.lastSuccessfulPolicySnapshot === null
      ? undefined
      : this.policyAttributions.get(
        policySnapshotIdentity(this.lastSuccessfulPolicySnapshot),
      );
    return {
      finalSnapshot,
      declarationCount: this.declarationCount,
      finalPolicyDeclarationCount: finalAttribution?.count ?? 0,
      finalPolicyFirstDeclaredAfter: finalAttribution === undefined
        ? null
        : copyExecution(finalAttribution.firstDeclaredAfter),
      finalPolicyLastDeclaredAfter: finalAttribution === undefined
        ? null
        : copyExecution(finalAttribution.lastDeclaredAfter),
    };
  }
}

export interface AssembleRunExperienceInput {
  readonly task: PindieTask;
  readonly runStart: {
    readonly taskStatus: TaskStatus;
    readonly taskGoal: string | null;
  };
  readonly snapshot: Extract<SemanticSnapshot, { authority: "coherent" }>;
  readonly policy: RunExperiencePolicy;
  readonly execution: RunExperienceExecution;
  readonly durationMs: number | null;
  readonly cost: number | null;
  readonly recordedAt?: string;
  readonly workEpisodeId?: string | null;
  readonly trialAttribution?: TrialRunAttribution | null;
}

function metric(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Assemble only the approved factual fields from one coherent settled Run. */
export function assembleRunExperience(
  input: AssembleRunExperienceInput,
): RunExperience {
  if (input.workEpisodeId != null && !UUID_V4.test(input.workEpisodeId)) throw new Error("Invalid WorkEpisodeId.");
  // Ambiguous learning bookkeeping never drops otherwise valid ordinary facts.
  const trialAttribution = input.workEpisodeId == null ? null
    : parseTrialAttribution(input.trialAttribution, input.workEpisodeId, input.execution);
  const record: RunExperience = {
    ...(input.workEpisodeId == null
      ? { schemaVersion: LEGACY_RUN_EXPERIENCE_SCHEMA_VERSION }
      : trialAttribution === null
        ? { schemaVersion: RUN_EXPERIENCE_SCHEMA_VERSION, workEpisodeId: input.workEpisodeId }
        : { schemaVersion: TRIAL_RUN_EXPERIENCE_SCHEMA_VERSION, workEpisodeId: input.workEpisodeId, trialAttribution }),
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    runStart: Object.freeze({
      taskStatus: input.runStart.taskStatus,
      taskGoal: input.runStart.taskGoal,
    }),
    task: Object.freeze({
      goal: input.task.goal,
      taskRelation: input.snapshot.taskRelation,
    }),
    policy: Object.freeze({
      finalSnapshot: input.policy.finalSnapshot === null
        ? null
        : serializePolicySnapshot(input.policy.finalSnapshot),
      declarationCount: input.policy.declarationCount,
      finalPolicyDeclarationCount: input.policy.finalPolicyDeclarationCount,
      finalPolicyFirstDeclaredAfter: input.policy.finalPolicyFirstDeclaredAfter === null
        ? null
        : copyExecution(input.policy.finalPolicyFirstDeclaredAfter),
      finalPolicyLastDeclaredAfter: input.policy.finalPolicyLastDeclaredAfter === null
        ? null
        : copyExecution(input.policy.finalPolicyLastDeclaredAfter),
    }),
    execution: copyExecution(input.execution),
    outcome: Object.freeze({
      taskStatus: input.snapshot.taskStatus,
      verificationStatus: input.snapshot.verificationStatus,
      completionRelation: input.snapshot.completionRelation,
      hasBlockers: input.snapshot.hasBlockers,
      hasQuestions: input.snapshot.hasQuestions,
      humanGateOpen: input.task.humanGate !== null,
    }),
    metrics: Object.freeze({
      durationMs: metric(input.durationMs),
      cost: metric(input.cost),
    }),
  };

  return Object.freeze(record);
}

export function isEligibleRunExperience(
  projectRoot: string | null,
  snapshot: SemanticSnapshot | null,
  task: PindieTask | null,
  execution: RunExperienceExecution,
): snapshot is Extract<SemanticSnapshot, { authority: "coherent" }> {
  return projectRoot !== null &&
    snapshot !== null &&
    snapshot.authority === "coherent" &&
    task !== null &&
    execution.toolCalls > 0;
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "idle",
  "active",
  "blocked",
  "waiting_human",
  "done",
];
const VERIFICATION_STATUSES: readonly (VerificationStatus | "none")[] = [
  "pending",
  "stale",
  "failed",
  "passed",
  "none",
];
const TASK_RELATIONS: readonly TaskRunRelation[] = [
  "none",
  "preexisting_untouched",
  "preexisting_changed",
  "introduced_during_run",
];
const COMPLETION_RELATIONS: readonly CompletionRunRelation[] = [
  "not_completed",
  "completed_before_run",
  "completed_during_run",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const V4_ROOT_FIELDS = [
  "schemaVersion",
  "recordedAt",
  "runStart",
  "task",
  "policy",
  "execution",
  "outcome",
  "metrics",
] as const;
const V4_RUN_START_FIELDS = ["taskStatus", "taskGoal"] as const;
const V4_TASK_FIELDS = ["goal", "taskRelation"] as const;
const V4_POLICY_FIELDS = [
  "finalSnapshot",
  "declarationCount",
  "finalPolicyDeclarationCount",
  "finalPolicyFirstDeclaredAfter",
  "finalPolicyLastDeclaredAfter",
] as const;
const V4_POLICY_SNAPSHOT_FIELDS = ["approach", "modifiers"] as const;
const V4_REVISION_SELECTION_FIELDS = [
  "strategyId",
  "kind",
  "revisionIdentity",
  "revisionFingerprint",
  "revisionStatusAtRun",
  "semantics",
] as const;
const V4_REVISION_SEMANTICS_FIELDS = [
  "summary",
  "useWhen",
  "avoidWhen",
  "principles",
] as const;
const V4_EXECUTION_FIELDS = [
  "toolCalls",
  "observations",
  "consequentialCalls",
  "projectMutationEffectCalls",
  "verificationCalls",
  "toolErrors",
  "deniedCalls",
] as const;
const V4_OUTCOME_FIELDS = [
  "taskStatus",
  "verificationStatus",
  "completionRelation",
  "hasBlockers",
  "hasQuestions",
  "humanGateOpen",
] as const;
const V4_METRICS_FIELDS = ["durationMs", "cost"] as const;

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length &&
    actual.every((field, index) => field === expected[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function parseRevisionSelection(
  value: unknown,
  kind: "approach" | "modifier",
): StrategyRevisionSelection | null {
  if (!isRecord(value) || value.kind !== kind ||
    !hasExactFields(value, V4_REVISION_SELECTION_FIELDS) ||
    !isRecord(value.semantics) ||
    !hasExactFields(value.semantics, V4_REVISION_SEMANTICS_FIELDS)) return null;
  try {
    const selection = createStrategyRevisionSelection(value);
    return selection.kind === kind ? selection : null;
  } catch {
    return null;
  }
}

function parseRevisionAwarePolicySnapshot(value: unknown): PolicySnapshot | null {
  if (!isRecord(value) || !hasExactFields(value, V4_POLICY_SNAPSHOT_FIELDS)) return null;
  const approach = parseRevisionSelection(value.approach, "approach");
  if (approach === null || !Array.isArray(value.modifiers)) return null;
  const modifiers = value.modifiers.map((modifier) =>
    parseRevisionSelection(modifier, "modifier"),
  );
  if (modifiers.some((modifier) => modifier === null)) return null;
  const parsedModifiers = modifiers as StrategyRevisionSelection[];
  if (new Set(parsedModifiers.map((modifier) => modifier.id)).size !== parsedModifiers.length) {
    return null;
  }
  return Object.freeze({
    approach,
    modifiers: Object.freeze(parsedModifiers),
  });
}

function parseExecution(value: unknown): RunExperienceExecution | null {
  if (!isRecord(value) || !hasExactFields(value, V4_EXECUTION_FIELDS)) return null;
  const fields: (keyof RunExperienceExecution)[] = [
    "toolCalls",
    "observations",
    "consequentialCalls",
    "projectMutationEffectCalls",
    "verificationCalls",
    "toolErrors",
    "deniedCalls",
  ];
  if (!fields.every((field) => isNonNegativeSafeInteger(value[field]))) return null;
  const execution = Object.freeze({
    toolCalls: value.toolCalls as number,
    observations: value.observations as number,
    consequentialCalls: value.consequentialCalls as number,
    projectMutationEffectCalls: value.projectMutationEffectCalls as number,
    verificationCalls: value.verificationCalls as number,
    toolErrors: value.toolErrors as number,
    deniedCalls: value.deniedCalls as number,
  });
  return execution.observations + execution.consequentialCalls === execution.toolCalls &&
    execution.projectMutationEffectCalls <= execution.toolCalls &&
    execution.projectMutationEffectCalls <= execution.consequentialCalls &&
    execution.verificationCalls <= execution.toolCalls &&
    execution.verificationCalls <= execution.consequentialCalls &&
    execution.toolErrors <= execution.toolCalls
    ? execution
    : null;
}

const EXECUTION_COUNTERS: readonly (keyof RunExperienceExecution)[] = [
  "toolCalls",
  "observations",
  "consequentialCalls",
  "projectMutationEffectCalls",
  "verificationCalls",
  "toolErrors",
  "deniedCalls",
];

function countersAtOrBefore(
  earlier: RunExperienceExecution,
  later: RunExperienceExecution,
): boolean {
  return EXECUTION_COUNTERS.every((counter) => earlier[counter] <= later[counter]);
}

function countersEqual(
  left: RunExperienceExecution,
  right: RunExperienceExecution,
): boolean {
  return EXECUTION_COUNTERS.every((counter) => left[counter] === right[counter]);
}

/** Strict factual trial record. Existence means exposure, not offer or causal use. */
function parseTrialAttribution(value: unknown, workEpisodeId: string, execution: RunExperienceExecution): TrialRunAttribution | null {
  if (!isRecord(value) || !hasExactFields(value, ["assignment", "exposure", "declaration", "declaredAt",
    "declarationFrontier", "postSelection", "authorityCurrent"]) ||
    !validateTrialAssignment(value.assignment) || value.assignment.workEpisodeId !== workEpisodeId ||
    typeof value.authorityCurrent !== "boolean" || !isOneOf(value.declaration, ["none", "select", "decline"])) return null;
  const assignment = value.assignment, exposure = value.exposure;
  if (!isRecord(exposure) || !hasExactFields(exposure, ["sessionId", "agentRunGeneration", "occurrenceEpoch", "at", "order"]) ||
    exposure.sessionId !== assignment.sessionId || !isNonNegativeSafeInteger(exposure.agentRunGeneration) ||
    !isNonNegativeSafeInteger(exposure.occurrenceEpoch) || !isNonNegativeSafeInteger(exposure.order) ||
    !isNonNegativeFiniteNumber(exposure.at) || exposure.at < assignment.createdAt || exposure.at >= assignment.expiresAt) return null;
  const postSelection = parseExecution(value.postSelection);
  if (!postSelection || !countersAtOrBefore(postSelection, execution)) return null;
  const declarationFrontier = value.declarationFrontier === null ? null : parseExecution(value.declarationFrontier);
  if (value.declaration === "none") {
    if (value.declaredAt !== null || value.declarationFrontier !== null || !countersEqual(postSelection, ZERO_EXECUTION)) return null;
  } else {
    if (!isNonNegativeFiniteNumber(value.declaredAt) || value.declaredAt < exposure.at || value.declaredAt >= assignment.expiresAt ||
      !declarationFrontier || !countersAtOrBefore(declarationFrontier, execution) ||
      !EXECUTION_COUNTERS.every((counter) => declarationFrontier[counter] + postSelection[counter] <= execution[counter]) ||
      (value.declaration === "decline" && !countersEqual(postSelection, ZERO_EXECUTION))) return null;
  }
  return Object.freeze({
    assignment: Object.freeze(structuredClone(assignment)),
    exposure: Object.freeze({ sessionId: assignment.sessionId, agentRunGeneration: exposure.agentRunGeneration,
      occurrenceEpoch: exposure.occurrenceEpoch, at: exposure.at, order: exposure.order }),
    declaration: value.declaration,
    declaredAt: value.declaredAt as number | null,
    declarationFrontier,
    postSelection,
    authorityCurrent: value.authorityCurrent,
  });
}

/** Validate and defensively copy immutable v4/v5/v6; never rewrite older audited bytes. */
export function parseRunExperience(value: unknown): RunExperience | null {
  if (!isRecord(value) ||
    (value.schemaVersion !== RUN_EXPERIENCE_SCHEMA_VERSION && value.schemaVersion !== LEGACY_RUN_EXPERIENCE_SCHEMA_VERSION &&
      value.schemaVersion !== TRIAL_RUN_EXPERIENCE_SCHEMA_VERSION) ||
    typeof value.recordedAt !== "string" || value.recordedAt.length === 0 ||
    !hasExactFields(value, value.schemaVersion === 6 ? [...V4_ROOT_FIELDS, "workEpisodeId", "trialAttribution"]
      : value.schemaVersion === 5 ? [...V4_ROOT_FIELDS, "workEpisodeId"] : V4_ROOT_FIELDS) ||
    (value.schemaVersion !== 4 && (typeof value.workEpisodeId !== "string" || !UUID_V4.test(value.workEpisodeId)))) {
    return null;
  }

  const runStart = value.runStart;
  if (!isRecord(runStart) ||
    !hasExactFields(runStart, V4_RUN_START_FIELDS) ||
    !isOneOf(runStart.taskStatus, TASK_STATUSES) ||
    (typeof runStart.taskGoal !== "string" && runStart.taskGoal !== null)) {
    return null;
  }

  const task = value.task;
  if (!isRecord(task) ||
    !hasExactFields(task, V4_TASK_FIELDS) ||
    typeof task.goal !== "string" ||
    !isOneOf(task.taskRelation, TASK_RELATIONS)) {
    return null;
  }

  const policy = value.policy;
  if (!isRecord(policy) ||
    !hasExactFields(policy, V4_POLICY_FIELDS) ||
    !isNonNegativeSafeInteger(policy.declarationCount) ||
    !isNonNegativeSafeInteger(policy.finalPolicyDeclarationCount)) {
    return null;
  }
  const finalSnapshot = policy.finalSnapshot === null
    ? null
    : parseRevisionAwarePolicySnapshot(policy.finalSnapshot);
  if (policy.finalSnapshot !== null && finalSnapshot === null) return null;
  const finalPolicyFirstDeclaredAfter = policy.finalPolicyFirstDeclaredAfter === null
    ? null
    : parseExecution(policy.finalPolicyFirstDeclaredAfter);
  const finalPolicyLastDeclaredAfter = policy.finalPolicyLastDeclaredAfter === null
    ? null
    : parseExecution(policy.finalPolicyLastDeclaredAfter);
  if (
    (policy.finalPolicyFirstDeclaredAfter !== null && finalPolicyFirstDeclaredAfter === null) ||
    (policy.finalPolicyLastDeclaredAfter !== null && finalPolicyLastDeclaredAfter === null)
  ) return null;

  const execution = parseExecution(value.execution);
  const outcome = value.outcome;
  if (execution === null || !isRecord(outcome) ||
    !hasExactFields(outcome, V4_OUTCOME_FIELDS) ||
    !isOneOf(outcome.taskStatus, TASK_STATUSES) ||
    !isOneOf(outcome.verificationStatus, VERIFICATION_STATUSES) ||
    !isOneOf(outcome.completionRelation, COMPLETION_RELATIONS) ||
    typeof outcome.hasBlockers !== "boolean" ||
    typeof outcome.hasQuestions !== "boolean" ||
    typeof outcome.humanGateOpen !== "boolean") {
    return null;
  }

  if (execution.toolCalls === 0 || task.taskRelation === "none") return null;
  if (
    (runStart.taskStatus === "idle" && runStart.taskGoal !== null) ||
    (runStart.taskStatus !== "idle" && runStart.taskGoal === null)
  ) return null;
  if (
    (runStart.taskStatus === "idle" && task.taskRelation !== "introduced_during_run") ||
    (task.taskRelation === "preexisting_untouched" &&
      (runStart.taskStatus === "idle" ||
        runStart.taskGoal !== task.goal ||
        runStart.taskStatus !== outcome.taskStatus)) ||
    (task.taskRelation === "preexisting_changed" && runStart.taskStatus === "idle")
  ) return null;
  if ((outcome.completionRelation !== "not_completed") !== (outcome.taskStatus === "done")) {
    return null;
  }
  if (
    outcome.verificationStatus === "none" ||
    outcome.taskStatus === "idle" ||
    (outcome.taskStatus === "waiting_human") !== outcome.humanGateOpen ||
    (outcome.taskStatus === "blocked" && !outcome.hasBlockers) ||
    (outcome.hasBlockers && !outcome.humanGateOpen && outcome.taskStatus !== "blocked") ||
    (outcome.taskStatus === "done" &&
      (outcome.verificationStatus !== "passed" ||
        outcome.hasBlockers || outcome.hasQuestions || outcome.humanGateOpen)) ||
    (outcome.completionRelation === "completed_before_run" &&
      (task.taskRelation !== "preexisting_untouched" || runStart.taskStatus !== "done")) ||
    (outcome.completionRelation === "completed_during_run" &&
      task.taskRelation === "preexisting_untouched")
  ) return null;
  if (finalSnapshot === null) {
    if (policy.declarationCount !== 0 || policy.finalPolicyDeclarationCount !== 0 ||
      finalPolicyFirstDeclaredAfter !== null || finalPolicyLastDeclaredAfter !== null) {
      return null;
    }
  } else if (
    policy.declarationCount < 1 ||
    policy.finalPolicyDeclarationCount < 1 ||
    policy.finalPolicyDeclarationCount > policy.declarationCount ||
    finalPolicyFirstDeclaredAfter === null ||
    finalPolicyLastDeclaredAfter === null
  ) {
    return null;
  }
  if (
    finalPolicyFirstDeclaredAfter !== null &&
    (!countersAtOrBefore(finalPolicyFirstDeclaredAfter, execution) ||
      !countersAtOrBefore(finalPolicyLastDeclaredAfter!, execution))
  ) return null;
  if (
    finalPolicyFirstDeclaredAfter !== null &&
    finalPolicyLastDeclaredAfter !== null &&
    ((policy.finalPolicyDeclarationCount === 1 &&
      !countersEqual(finalPolicyFirstDeclaredAfter, finalPolicyLastDeclaredAfter)) ||
      (policy.finalPolicyDeclarationCount > 1 &&
        !countersAtOrBefore(finalPolicyFirstDeclaredAfter, finalPolicyLastDeclaredAfter)))
  ) return null;

  const metrics = value.metrics;
  if (!isRecord(metrics) ||
    !hasExactFields(metrics, V4_METRICS_FIELDS) ||
    (metrics.durationMs !== null && !isNonNegativeFiniteNumber(metrics.durationMs)) ||
    (metrics.cost !== null && !isNonNegativeFiniteNumber(metrics.cost))) {
    return null;
  }

  const trialAttribution = value.schemaVersion === 6
    ? parseTrialAttribution(value.trialAttribution, value.workEpisodeId as string, execution) : null;
  if (value.schemaVersion === 6 && trialAttribution === null) return null;
  return Object.freeze({
    ...(value.schemaVersion === 6
      ? { schemaVersion: TRIAL_RUN_EXPERIENCE_SCHEMA_VERSION, workEpisodeId: value.workEpisodeId as string, trialAttribution: trialAttribution! }
      : value.schemaVersion === 5
        ? { schemaVersion: RUN_EXPERIENCE_SCHEMA_VERSION, workEpisodeId: value.workEpisodeId as string }
        : { schemaVersion: LEGACY_RUN_EXPERIENCE_SCHEMA_VERSION }),
    recordedAt: value.recordedAt,
    runStart: Object.freeze({
      taskStatus: runStart.taskStatus,
      taskGoal: runStart.taskGoal,
    }),
    task: Object.freeze({
      goal: task.goal,
      taskRelation: task.taskRelation,
    }),
    policy: Object.freeze({
      finalSnapshot,
      declarationCount: policy.declarationCount,
      finalPolicyDeclarationCount: policy.finalPolicyDeclarationCount,
      finalPolicyFirstDeclaredAfter,
      finalPolicyLastDeclaredAfter,
    }),
    execution,
    outcome: Object.freeze({
      taskStatus: outcome.taskStatus,
      verificationStatus: outcome.verificationStatus,
      completionRelation: outcome.completionRelation,
      hasBlockers: outcome.hasBlockers,
      hasQuestions: outcome.hasQuestions,
      humanGateOpen: outcome.humanGateOpen,
    }),
    metrics: Object.freeze({
      durationMs: metrics.durationMs,
      cost: metrics.cost,
    }),
  });
}

export function isRunExperience(value: unknown): value is RunExperience {
  return parseRunExperience(value) !== null;
}
