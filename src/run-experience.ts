import type { ToolEffect } from "./execution-semantics.ts";
import type { PolicySnapshot } from "./policy.ts";
import type { SeedStrategy } from "./strategies.ts";
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

export const RUN_EXPERIENCE_SCHEMA_VERSION = 2 as const;

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
  readonly declarationCount: number;
  /** Counters immediately before the first successful declaration. */
  readonly firstDeclarationAfter: RunExperienceExecution | null;
  /** Counters immediately before the final successful declaration. */
  readonly finalDeclarationAfter: RunExperienceExecution | null;
}

export interface RunExperience {
  readonly schemaVersion: typeof RUN_EXPERIENCE_SCHEMA_VERSION;
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

const ZERO_EXECUTION: RunExperienceExecution = Object.freeze({
  toolCalls: 0,
  observations: 0,
  consequentialCalls: 0,
  projectMutationEffectCalls: 0,
  verificationCalls: 0,
  toolErrors: 0,
  deniedCalls: 0,
});

type AuthorizedCallKind = "execution" | "policy";

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
  private firstDeclarationAfter: RunExperienceExecution | null = null;
  private finalDeclarationAfter: RunExperienceExecution | null = null;

  reset(): void {
    this.counters = copyExecution(ZERO_EXECUTION);
    this.authorizedCalls.clear();
    this.currentPolicySnapshot = null;
    this.lastSuccessfulPolicySnapshot = null;
    this.pendingPolicyPrevious = undefined;
    this.declarationCount = 0;
    this.firstDeclarationAfter = null;
    this.finalDeclarationAfter = null;
  }

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    this.pendingPolicyPrevious = this.currentPolicySnapshot;
    this.currentPolicySnapshot = snapshot;
  }

  /** Record a call admitted by the live Gateway without classifying prose. */
  recordAuthorizedCall(toolCallId: string, effect: ToolEffect): void {
    const isPolicy = effect.requiredCapability === "policy.declare";
    this.authorizedCalls.set(toolCallId, isPolicy ? "policy" : "execution");
    if (isPolicy) return;

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
    if (effect.requiredCapability === "policy.declare") return;
    this.counters = {
      ...this.counters,
      deniedCalls: this.counters.deniedCalls + 1,
    };
  }

  /** Record an actual result for an admitted non-policy call. */
  recordToolResult(toolCallId: string, isError: boolean): "execution" | "policy" | null {
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
    this.declarationCount += 1;
    if (this.firstDeclarationAfter === null) {
      this.firstDeclarationAfter = position;
    }
    this.finalDeclarationAfter = position;
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
    return {
      finalSnapshot: this.lastSuccessfulPolicySnapshot === null
        ? null
        : copyPolicySnapshot(this.lastSuccessfulPolicySnapshot),
      declarationCount: this.declarationCount,
      firstDeclarationAfter: this.firstDeclarationAfter === null
        ? null
        : copyExecution(this.firstDeclarationAfter),
      finalDeclarationAfter: this.finalDeclarationAfter === null
        ? null
        : copyExecution(this.finalDeclarationAfter),
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
}

function metric(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Assemble only the approved factual fields from one coherent settled Run. */
export function assembleRunExperience(
  input: AssembleRunExperienceInput,
): RunExperience {
  const record: RunExperience = {
    schemaVersion: RUN_EXPERIENCE_SCHEMA_VERSION,
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
        : copyPolicySnapshot(input.policy.finalSnapshot),
      declarationCount: input.policy.declarationCount,
      firstDeclarationAfter: input.policy.firstDeclarationAfter === null
        ? null
        : copyExecution(input.policy.firstDeclarationAfter),
      finalDeclarationAfter: input.policy.finalDeclarationAfter === null
        ? null
        : copyExecution(input.policy.finalDeclarationAfter),
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

function copySeedStrategy(value: Record<string, unknown>): SeedStrategy {
  return Object.freeze({
    id: value.id as string,
    kind: value.kind as "approach" | "modifier",
    summary: value.summary as string,
    useWhen: Object.freeze([...(value.useWhen as string[])]),
    ...(value.avoidWhen === undefined
      ? {}
      : { avoidWhen: Object.freeze([...(value.avoidWhen as string[])]) }),
    principles: Object.freeze([...(value.principles as string[])]),
  });
}

function parseSeedStrategy(
  value: unknown,
  kind: "approach" | "modifier",
): SeedStrategy | null {
  if (!isRecord(value) || value.kind !== kind ||
    typeof value.id !== "string" || value.id.length === 0 ||
    typeof value.summary !== "string" || !isStringArray(value.useWhen) ||
    (value.avoidWhen !== undefined && !isStringArray(value.avoidWhen)) ||
    !isStringArray(value.principles)) {
    return null;
  }
  return copySeedStrategy(value);
}

function parsePolicySnapshot(value: unknown): PolicySnapshot | null {
  if (!isRecord(value)) return null;
  const approach = parseSeedStrategy(value.approach, "approach");
  if (approach === null || !Array.isArray(value.modifiers)) return null;
  const modifiers = value.modifiers.map((modifier) =>
    parseSeedStrategy(modifier, "modifier"),
  );
  if (modifiers.some((modifier) => modifier === null)) return null;
  const parsedModifiers = modifiers as SeedStrategy[];
  if (new Set(parsedModifiers.map((modifier) => modifier.id)).size !== parsedModifiers.length) {
    return null;
  }
  return Object.freeze({
    approach,
    modifiers: Object.freeze(parsedModifiers),
  });
}

function parseExecution(value: unknown): RunExperienceExecution | null {
  if (!isRecord(value)) return null;
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
  return Object.freeze({
    toolCalls: value.toolCalls as number,
    observations: value.observations as number,
    consequentialCalls: value.consequentialCalls as number,
    projectMutationEffectCalls: value.projectMutationEffectCalls as number,
    verificationCalls: value.verificationCalls as number,
    toolErrors: value.toolErrors as number,
    deniedCalls: value.deniedCalls as number,
  });
}

/**
 * Validates and copies the bounded schema-v2 shape used by Evaluation.
 * Unknown fields are deliberately discarded instead of entering the evaluator.
 */
export function parseRunExperience(value: unknown): RunExperience | null {
  if (!isRecord(value) || value.schemaVersion !== RUN_EXPERIENCE_SCHEMA_VERSION ||
    typeof value.recordedAt !== "string" || value.recordedAt.length === 0) {
    return null;
  }

  const runStart = value.runStart;
  if (!isRecord(runStart) || !isOneOf(runStart.taskStatus, TASK_STATUSES) ||
    (typeof runStart.taskGoal !== "string" && runStart.taskGoal !== null)) {
    return null;
  }

  const task = value.task;
  if (!isRecord(task) || typeof task.goal !== "string" ||
    !isOneOf(task.taskRelation, TASK_RELATIONS)) {
    return null;
  }

  const policy = value.policy;
  if (!isRecord(policy) || !isNonNegativeSafeInteger(policy.declarationCount)) {
    return null;
  }
  const finalSnapshot = policy.finalSnapshot === null
    ? null
    : parsePolicySnapshot(policy.finalSnapshot);
  if (policy.finalSnapshot !== null && finalSnapshot === null) return null;
  const firstDeclarationAfter = policy.firstDeclarationAfter === null
    ? null
    : parseExecution(policy.firstDeclarationAfter);
  const finalDeclarationAfter = policy.finalDeclarationAfter === null
    ? null
    : parseExecution(policy.finalDeclarationAfter);
  if (
    (policy.firstDeclarationAfter !== null && firstDeclarationAfter === null) ||
    (policy.finalDeclarationAfter !== null && finalDeclarationAfter === null)
  ) return null;

  const execution = parseExecution(value.execution);
  const outcome = value.outcome;
  if (execution === null || !isRecord(outcome) ||
    !isOneOf(outcome.taskStatus, TASK_STATUSES) ||
    !isOneOf(outcome.verificationStatus, VERIFICATION_STATUSES) ||
    !isOneOf(outcome.completionRelation, COMPLETION_RELATIONS) ||
    typeof outcome.hasBlockers !== "boolean" ||
    typeof outcome.hasQuestions !== "boolean" ||
    typeof outcome.humanGateOpen !== "boolean") {
    return null;
  }

  const metrics = value.metrics;
  if (!isRecord(metrics) ||
    (metrics.durationMs !== null && !isNonNegativeFiniteNumber(metrics.durationMs)) ||
    (metrics.cost !== null && !isNonNegativeFiniteNumber(metrics.cost))) {
    return null;
  }

  return Object.freeze({
    schemaVersion: RUN_EXPERIENCE_SCHEMA_VERSION,
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
      firstDeclarationAfter,
      finalDeclarationAfter,
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
