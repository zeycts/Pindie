import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { LearningDispositionSchema, type LearningDispositionSeam } from "../learning-disposition-contract.ts";
import { formatRunCost } from "../run-cost.ts";
import { formatDuration } from "../run-timer.ts";
import type { ConsumptionMetrics } from "../task-metrics.ts";
import {
  renderCurrentPindieTaskContract,
  renderCurrentPindieTaskProgress,
  renderCurrentPindieVerificationRecord,
} from "../context.ts";
import type { PindieRuntime } from "../runtime.ts";
import { dispatchOrThrow } from "./semantic-dispatch.ts";
import { getTaskStatus, type PindieState, type VerificationCheck } from "../state.ts";
import {
  assertTaskContinuityContent,
  MAX_CONTINUITY_DECISION_LENGTH,
  MAX_CONTINUITY_DECISIONS,
  MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH,
} from "../task-continuity.ts";
import type { PindieEvent } from "../transitions.ts";
import {
  MAX_EVIDENCE_REFS_PER_CHECK,
  type VerificationEvidenceResolver,
} from "../verification-evidence.ts";

const GoalSchema = Type.String({
  description: "Durable outcome the Task is trying to achieve.",
});

const ConstraintsSchema = Type.Array(Type.String(), {
  description:
    "Durable task-wide boundaries or execution requirements, such as scope limits, prohibited actions, fixed human decisions, or technical constraints.",
});

const SuccessCriteriaSchema = Type.Array(Type.String(), {
  minItems: 1,
  description:
    "Final observable outcomes required for completion; the durable Definition of Done. Each criterion must remain meaningful across sessions.",
});

const NextIntentSchema = Type.String({
  description:
    "Continuation intent or likely next meaningful step for unfinished work, including cross-session continuation.",
});

const TaskDefinitionParameters = Type.Object(
  {
    goal: GoalSchema,
    successCriteria: SuccessCriteriaSchema,
    constraints: Type.Optional(ConstraintsSchema),
    nextIntent: Type.Optional(NextIntentSchema),
  },
  { additionalProperties: false },
);

const TaskRefinementParameters = Type.Object(
  {
    goal: Type.Optional(GoalSchema),
    constraints: Type.Optional(ConstraintsSchema),
    successCriteria: Type.Optional(Type.Array(Type.String(), {
      description:
        "Replacement final observable outcomes required for completion; the durable Definition of Done.",
    })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const TaskProgressParameters = Type.Object(
  {
    blockers: Type.Array(Type.String(), {
      description: "Current blockers to consequential project work.",
    }),
    questions: Type.Array(Type.String(), {
      description: "Current unresolved questions.",
    }),
    nextIntent: Type.Optional(NextIntentSchema),
  },
  { additionalProperties: false },
);

const TaskHandoffParameters = Type.Object(
  {
    progressSummary: Type.String({
      minLength: 1,
      maxLength: MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH,
      description: "Bounded summary of the whole unfinished Task's current progress.",
    }),
    decisions: Type.Array(Type.String({
      minLength: 1,
      maxLength: MAX_CONTINUITY_DECISION_LENGTH,
    }), {
      maxItems: MAX_CONTINUITY_DECISIONS,
      description: "Still-relevant decisions that a fresh Session cannot cheaply reconstruct.",
    }),
    nextIntent: Type.Union([Type.String(), Type.Null()], {
      description: "The next meaningful Task direction, applied through existing Task progress semantics.",
    }),
  },
  { additionalProperties: false },
);

const VerificationCheckSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description: "Unique name of this verification check.",
    }),
    status: StringEnum(["passed", "failed"] as const, {
      description:
        "Semantic judgment of whether the cited factual evidence passes or fails this verification check.",
    }),
    covers: Type.Array(Type.String(), {
      description:
        "Success criterion IDs from the current Task Contract, for example ['c1', 'c2']; use criterion IDs, not descriptions.",
    }),
    evidenceRefs: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: MAX_EVIDENCE_REFS_PER_CHECK,
      uniqueItems: true,
      description:
        "Opaque Pindie evidence handles returned by actual tool results in the current Agent Run. Pass each handle exactly as returned; do not derive, reconstruct, or modify it.",
    }),
  },
  { additionalProperties: false },
);

const VerificationRecordParameters = Type.Object(
  { check: VerificationCheckSchema },
  { additionalProperties: false },
);

const TaskCompleteParameters = Type.Object(
  {
    summary: Type.String({
      description:
        "Concise user-facing summary of the completed outcome and meaningful changes. Recorded verification evidence is rendered separately.",
    }),
    learningDisposition: Type.Optional(LearningDispositionSchema),
  },
  { additionalProperties: false },
);

export interface PindieTaskToolDetails {
  state: PindieState;
}

export interface PindieTaskToolOptions {
  captureTaskMetricsBaseline?: () => ConsumptionMetrics;
  onTaskEpochStarted?: (
    state: PindieState,
    baseline: ConsumptionMetrics,
  ) => void;
  onTaskRefined?: (state: PindieState) => void;
  onTaskCompleted?: (state: PindieState) => ConsumptionMetrics | null;
  learningDisposition?: LearningDispositionSeam;
  onStateChange?: () => void;
  onMutationUncertain?: (reason: string) => void;
}

export interface PindieTaskHandoffToolOptions extends PindieTaskToolOptions {
  onHandoffStaged: (
    toolCallId: string,
    state: PindieState,
    progressSummary: string,
    decisions: readonly string[],
  ) => void;
}

export interface PindieVerificationToolOptions extends PindieTaskToolOptions {
  resolveEvidence: VerificationEvidenceResolver;
}

function result(
  message: string,
  state: PindieState,
  projection: string | null = null,
  terminate = false,
) {
  return {
    content: [{
      type: "text" as const,
      text: projection === null
        ? message
        : [message, "", projection].join("\n"),
    }],
    details: { state } satisfies PindieTaskToolDetails,
    ...(terminate ? { terminate: true } : {}),
  };
}

function formatCompletionResult(
  state: PindieState,
  summary: string,
  taskMetrics: ConsumptionMetrics | null,
): string {
  const checks = state.task?.verification.checks ?? [];
  return [
    "Current task completed.",
    "",
    "Summary:",
    summary,
    ...(taskMetrics === null
      ? []
      : [
          "",
          `Duration: ${formatDuration(taskMetrics.durationMs)}`,
          `Cost: ${formatRunCost(taskMetrics.cost)}`,
        ]),
    "",
    "Verification:",
    ...checks.map((check) => `- ${check.name}: ${check.evidence}`),
  ].join("\n");
}

function assertTaskDefinitionInput(
  toolName: "pindie_task_start" | "pindie_task_replace",
  params: { goal?: unknown; successCriteria?: unknown },
): asserts params is { goal: string; successCriteria: string[] } {
  if (typeof params.goal !== "string") {
    throw new Error(`Invalid ${toolName} input: goal is required.`);
  }
  if (!Array.isArray(params.successCriteria) || params.successCriteria.length === 0) {
    throw new Error(
      `Invalid ${toolName} input: provide at least one success criterion.`,
    );
  }
}

function assertVerificationRecordInput(params: unknown): asserts params is {
  check: {
    name: string;
    status: "passed" | "failed";
    covers: string[];
    evidenceRefs: string[];
  };
} {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid pindie_verification_record input: check is required.");
  }
  const check = (params as { check?: unknown }).check;
  if (typeof check !== "object" || check === null) {
    throw new Error("Invalid pindie_verification_record input: check is required.");
  }
  const value = check as Record<string, unknown>;
  if ("evidence" in value) {
    throw new Error(
      "Invalid pindie_verification_record input: free-text evidence is not accepted.",
    );
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error(
      "Invalid pindie_verification_record input: non-empty check name is required.",
    );
  }
  if (value.status !== "passed" && value.status !== "failed") {
    throw new Error(
      "Invalid pindie_verification_record input: status must be 'passed' or 'failed'.",
    );
  }
  if (
    !Array.isArray(value.covers) ||
    !value.covers.every((criterionId) => typeof criterionId === "string")
  ) {
    throw new Error(
      "Invalid pindie_verification_record input: covers must contain criterion IDs.",
    );
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    !value.evidenceRefs.every((ref) => typeof ref === "string") ||
    value.evidenceRefs.length === 0
  ) {
    throw new Error(
      "Invalid pindie_verification_record input: provide at least one evidence reference.",
    );
  }
  if (value.evidenceRefs.length > MAX_EVIDENCE_REFS_PER_CHECK) {
    throw new Error(
      `Invalid pindie_verification_record input: provide at most ${MAX_EVIDENCE_REFS_PER_CHECK} evidence references.`,
    );
  }
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    throw new Error(
      "Invalid pindie_verification_record input: evidence references must be unique.",
    );
  }
}

function assertTaskHandoffInput(params: unknown): asserts params is {
  progressSummary: string;
  decisions: string[];
  nextIntent: string | null;
} {
  if (typeof params !== "object" || params === null) {
    throw new Error("Invalid pindie_task_handoff input.");
  }
  const value = params as Record<string, unknown>;
  if (typeof value.progressSummary !== "string" || value.progressSummary.trim() === "") {
    throw new Error("Invalid pindie_task_handoff input: progressSummary must be non-empty.");
  }
  if (!Array.isArray(value.decisions)) {
    throw new Error("Invalid pindie_task_handoff input: decisions must be an array.");
  }
  if (!value.decisions.every((decision) => typeof decision === "string")) {
    throw new Error("Invalid pindie_task_handoff input: decisions must contain strings.");
  }
  assertTaskContinuityContent({
    progressSummary: value.progressSummary,
    decisions: value.decisions,
  });
  if (typeof value.nextIntent !== "string" && value.nextIntent !== null) {
    throw new Error("Invalid pindie_task_handoff input: nextIntent must be a string or null.");
  }
}

export function createPindieTaskStartTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_start",
    label: "Start Pindie Task",
    description: "Start a Task when there is no current Task or begin new work after the previous Task is completed.",
    parameters: TaskDefinitionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      assertTaskDefinitionInput("pindie_task_start", params);
      const metricsBaseline = options.captureTaskMetricsBaseline?.();
      const state = await dispatchOrThrow(runtime, {
        type: "start_task",
        goal: params.goal,
        constraints: params.constraints ?? [],
        successCriteria: params.successCriteria,
        nextIntent: params.nextIntent ?? null,
      }, signal, options);
      if (metricsBaseline) options.onTaskEpochStarted?.(state, metricsBaseline);
      return result(
        "Current task started.",
        state,
        `Current Task Contract:\n${renderCurrentPindieTaskContract(state)}`,
      );
    },
  });
}

export function createPindieTaskReplaceTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_replace",
    label: "Replace Pindie Task",
    description: "Replace a different unfinished current Task. Do not use this for a completed Task; use pindie_task_start instead.",
    parameters: TaskDefinitionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      assertTaskDefinitionInput("pindie_task_replace", params);
      const metricsBaseline = options.captureTaskMetricsBaseline?.();
      const state = await dispatchOrThrow(runtime, {
        type: "replace_task",
        goal: params.goal,
        constraints: params.constraints ?? [],
        successCriteria: params.successCriteria,
        nextIntent: params.nextIntent ?? null,
      }, signal, options);
      if (metricsBaseline) options.onTaskEpochStarted?.(state, metricsBaseline);
      return result(
        "Current unfinished task replaced.",
        state,
        `Current Task Contract:\n${renderCurrentPindieTaskContract(state)}`,
      );
    },
  });
}

export function createPindieTaskRefineTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_refine",
    label: "Refine Pindie Task",
    description: "Refine one or more fields in the current Task contract.",
    parameters: TaskRefinementParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (
        params.goal === undefined &&
        params.constraints === undefined &&
        params.successCriteria === undefined
      ) {
        throw new Error(
          "Invalid pindie_task_refine input: provide at least one refinement field.",
        );
      }
      const event: Extract<PindieEvent, { type: "refine_task" }> = {
        type: "refine_task",
        ...(params.goal === undefined ? {} : { goal: params.goal }),
        ...(params.constraints === undefined ? {} : { constraints: params.constraints }),
        ...(params.successCriteria === undefined
          ? {}
          : { successCriteria: params.successCriteria }),
      };
      const state = await dispatchOrThrow(runtime, event, signal, options);
      options.onTaskRefined?.(state);
      return result(
        "Task contract refined.",
        state,
        `Current Task Contract:\n${renderCurrentPindieTaskContract(state)}`,
      );
    },
  });
}

export function createPindieTaskProgressTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_progress",
    label: "Update Pindie Task Progress",
    description: "Record the current Task blockers, questions, and continuation intent.",
    parameters: TaskProgressParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!Array.isArray(params.blockers) || !Array.isArray(params.questions)) {
        throw new Error(
          "Invalid pindie_task_progress input: blockers and questions are required.",
        );
      }
      const state = await dispatchOrThrow(runtime, {
        type: "set_open_loops",
        blockers: params.blockers,
        questions: params.questions,
        nextIntent: params.nextIntent ?? null,
      }, signal, options);
      return result(
        "Open loops updated.",
        state,
        `Current Pindie Progress:\n${renderCurrentPindieTaskProgress(state)}`,
      );
    },
  });
}

export function createPindieTaskHandoffTool(
  runtime: PindieRuntime,
  options: PindieTaskHandoffToolOptions,
) {
  return defineTool({
    name: "pindie_task_handoff",
    label: "Stage Pindie Task Handoff",
    description: "Stage a bounded working-memory handoff at the current unfinished Task frontier.",
    parameters: TaskHandoffParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      assertTaskHandoffInput(params);
      const currentTask = runtime.state.task;
      if (currentTask === null || getTaskStatus(runtime.state) !== "active") {
        throw new Error("Pindie rejected this handoff: an active, unblocked Task is required.");
      }
      const state = await dispatchOrThrow(runtime, {
        type: "set_open_loops",
        blockers: [...currentTask.openLoops.blockers],
        questions: [...currentTask.openLoops.questions],
        nextIntent: params.nextIntent,
      }, signal, options);
      options.onHandoffStaged(
        toolCallId,
        state,
        params.progressSummary,
        params.decisions,
      );
      return result(
        "Task remains unfinished. Handoff staged; the current Run should end at this work frontier.",
        state,
        null,
        true,
      );
    },
  });
}

export function createPindieVerificationRecordTool(
  runtime: PindieRuntime,
  options: PindieVerificationToolOptions,
) {
  return defineTool({
    name: "pindie_verification_record",
    label: "Record Pindie Verification",
    description: "Record one current verification check and its criterion coverage.",
    parameters: VerificationRecordParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      assertVerificationRecordInput(params);
      const evidence = options.resolveEvidence(params.check.evidenceRefs);
      const check: VerificationCheck = {
        name: params.check.name,
        status: params.check.status,
        covers: params.check.covers,
        evidence,
      };
      const state = await dispatchOrThrow(runtime, {
        type: "record_verification",
        check,
      }, signal, options);
      return result(
        `Verification check '${params.check.name}' recorded.`,
        state,
        `Current Verification Result:\n${renderCurrentPindieVerificationRecord(state, params.check)}`,
      );
    },
  });
}

export function createPindieTaskCompleteTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_complete",
    label: "Complete Pindie Task",
    description: "Complete the current Task and render its outcome summary.",
    parameters: TaskCompleteParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (params.summary.trim() === "") {
        throw new Error(
          "Invalid pindie_task_complete input: non-empty summary is required.",
        );
      }
      const disposition = params.learningDisposition;
      const learning = options.learningDisposition;
      if (learning?.isRequired() && disposition === undefined) {
        throw new Error("Invalid pindie_task_complete input: learningDisposition is required for ordinary SI-enabled completion.");
      }
      if (disposition !== undefined && !learning) {
        throw new Error("Invalid pindie_task_complete input: learningDisposition conflicts with this Run or is invalid.");
      }
      const rollback = disposition === undefined ? null : learning!.stage(disposition);
      let state: PindieState;
      let mayHaveCommitted = false;
      const retainSignal = () => { mayHaveCommitted = true; };
      try {
        state = await dispatchOrThrow(runtime, { type: "complete_task" }, signal, options, retainSignal, retainSignal);
      } catch (error) {
        if (!mayHaveCommitted) rollback?.();
        throw error;
      }
      const taskMetrics = options.onTaskCompleted?.(state) ?? null;
      return result(formatCompletionResult(state, params.summary, taskMetrics), state, null, true);
    },
  });
}
