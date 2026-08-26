import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDuration } from "../run-timer.ts";
import { PindieStateConflictError, type PindieRuntime } from "../runtime.ts";
import { StateLockBusyError } from "../store.ts";
import type { PindieState, VerificationCheck } from "../state.ts";
import type { PindieEvent } from "../transitions.ts";

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

const VerificationCheckSchema = Type.Object(
  {
    name: Type.String({ description: "Unique name of this verification check." }),
    status: StringEnum(["passed", "failed"] as const, {
      description: "Observed result of the check.",
    }),
    covers: Type.Array(Type.String(), {
      description:
        "Success criterion IDs from the current Task Contract, for example ['c1', 'c2']; use criterion IDs, not descriptions.",
    }),
    evidence: Type.String({
      description: "Concrete evidence produced by the check.",
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
  },
  { additionalProperties: false },
);

export interface PindieTaskToolDetails {
  state: PindieState;
}

export interface PindieTaskToolOptions {
  getRunDuration?: () => number | null;
  onStateChange?: () => void;
}

async function dispatchOrThrow(
  runtime: PindieRuntime,
  event: PindieEvent,
  onStateChange?: () => void,
): Promise<PindieState> {
  let result;
  try {
    result = await runtime.dispatch(event);
  } catch (error) {
    if (error instanceof PindieStateConflictError) {
      onStateChange?.();
      throw new Error("Pindie project State changed externally; the latest authoritative State was adopted. Return control and begin a new Agent Run before reconciling this semantic action.");
    }
    if (error instanceof StateLockBusyError) {
      throw new Error("Another Pindie process currently owns this project's State lock. Retry shortly.");
    }
    throw error;
  }
  if (!result.ok) {
    throw new Error(
      `Pindie transition rejected (${result.error.code}): ${result.error.message}`,
    );
  }

  onStateChange?.();
  return runtime.state;
}

function result(message: string, state: PindieState, terminate = false) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { state } satisfies PindieTaskToolDetails,
    ...(terminate ? { terminate: true } : {}),
  };
}

function formatSuccessCriteria(state: PindieState): string {
  const criteria = state.task?.successCriteria ?? [];
  return [
    "Success criteria:",
    ...criteria.map(({ id, description }) => `- ${id}: ${description}`),
  ].join("\n");
}

function formatCompletionResult(
  state: PindieState,
  summary: string,
  runDuration: number | null,
): string {
  const checks = state.task?.verification.checks ?? [];
  return [
    "Current task completed.",
    "",
    "Summary:",
    summary,
    ...(runDuration === null ? [] : ["", `Duration: ${formatDuration(runDuration)}`]),
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

export function createPindieTaskStartTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_task_start",
    label: "Start Pindie Task",
    description: "Start a semantic Task with its durable contract.",
    parameters: TaskDefinitionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      assertTaskDefinitionInput("pindie_task_start", params);
      const state = await dispatchOrThrow(runtime, {
        type: "start_task",
        goal: params.goal,
        constraints: params.constraints ?? [],
        successCriteria: params.successCriteria,
        nextIntent: params.nextIntent ?? null,
      }, options.onStateChange);
      return result(`Current task started.\n\n${formatSuccessCriteria(state)}`, state);
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
    description: "Replace the current unfinished Task with a different Task contract.",
    parameters: TaskDefinitionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      assertTaskDefinitionInput("pindie_task_replace", params);
      const state = await dispatchOrThrow(runtime, {
        type: "replace_task",
        goal: params.goal,
        constraints: params.constraints ?? [],
        successCriteria: params.successCriteria,
        nextIntent: params.nextIntent ?? null,
      }, options.onStateChange);
      return result(
        `Current unfinished task replaced.\n\n${formatSuccessCriteria(state)}`,
        state,
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
    async execute(_toolCallId, params) {
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
      const state = await dispatchOrThrow(runtime, event, options.onStateChange);
      return result(`Task contract refined.\n\n${formatSuccessCriteria(state)}`, state);
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
    async execute(_toolCallId, params) {
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
      }, options.onStateChange);
      return result("Open loops updated.", state);
    },
  });
}

export function createPindieVerificationRecordTool(
  runtime: PindieRuntime,
  options: PindieTaskToolOptions = {},
) {
  return defineTool({
    name: "pindie_verification_record",
    label: "Record Pindie Verification",
    description: "Record one current verification check and its criterion coverage.",
    parameters: VerificationRecordParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const state = await dispatchOrThrow(runtime, {
        type: "record_verification",
        check: params.check as VerificationCheck,
      }, options.onStateChange);
      return result(`Verification check '${params.check.name}' recorded.`, state);
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
    async execute(_toolCallId, params) {
      if (params.summary.trim() === "") {
        throw new Error(
          "Invalid pindie_task_complete input: non-empty summary is required.",
        );
      }
      const state = await dispatchOrThrow(
        runtime,
        { type: "complete_task" },
        options.onStateChange,
      );
      return result(
        formatCompletionResult(
          state,
          params.summary,
          options.getRunDuration?.() ?? null,
        ),
        state,
        true,
      );
    },
  });
}
