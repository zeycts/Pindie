import type { ToolEffect } from "./execution-semantics.ts";
import type { PolicySnapshot } from "./policy.ts";
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

export const RUN_EXPERIENCE_SCHEMA_VERSION = 1 as const;

/** Bounded execution facts collected for one Agent Run. */
export interface RunExperienceExecution {
  readonly toolCalls: number;
  readonly observations: number;
  readonly consequentialCalls: number;
  readonly projectMutationCalls: number;
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
  readonly task: {
    readonly goal: string;
    readonly taskRelation: TaskRunRelation;
    readonly statusAtStart: TaskStatus;
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
  projectMutationCalls: 0,
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
    projectMutationCalls: counters.projectMutationCalls,
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

  get policySnapshot(): PolicySnapshot | null {
    return this.currentPolicySnapshot;
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
      projectMutationCalls: this.counters.projectMutationCalls + (
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
  readonly statusAtStart: TaskStatus;
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
    task: Object.freeze({
      goal: input.task.goal,
      taskRelation: input.snapshot.taskRelation,
      statusAtStart: input.statusAtStart,
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
