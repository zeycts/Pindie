import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDuration } from "../run-timer.ts";
import {
  renderCurrentPindieTaskContract,
  renderCurrentPindieTaskProgress,
  renderCurrentPindieVerificationRecord,
} from "../context.ts";
import { PindieStateConflictError, type PindieRuntime } from "../runtime.ts";
import { StateLockBusyError } from "../store.ts";
import type { PindieState, VerificationCheck } from "../state.ts";
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

export interface PindieVerificationToolOptions extends PindieTaskToolOptions {
  resolveEvidence: VerificationEvidenceResolver;
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
    async execute(_toolCallId, params) {
      assertTaskDefinitionInput("pindie_task_start", params);
      const state = await dispatchOrThrow(runtime, {
        type: "start_task",
        goal: params.goal,
        constraints: params.constraints ?? [],
        successCriteria: params.successCriteria,
        nextIntent: params.nextIntent ?? null,
      }, options.onStateChange);
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
      return result(
        "Open loops updated.",
        state,
        `Current Pindie Progress:\n${renderCurrentPindieTaskProgress(state)}`,
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
    async execute(_toolCallId, params) {
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
      }, options.onStateChange);
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
        null,
        true,
      );
    },
  });
}
