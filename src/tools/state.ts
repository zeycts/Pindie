import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDuration } from "../run-timer.ts";
import { PindieStateConflictError, type PindieRuntime } from "../runtime.ts";
import { StateLockBusyError } from "../store.ts";
import type { PindieState, VerificationCheck } from "../state.ts";
import type { PindieEvent } from "../transitions.ts";

const STATE_ACTIONS = [
  "start_task",
  "replace_task",
  "refine_task",
  "set_open_loops",
  "record_verification",
  "complete_task",
] as const;

const VerificationCheckSchema = Type.Object(
  {
    name: Type.String(),
    status: StringEnum(["passed", "failed"] as const),
    covers: Type.Array(Type.String(), {
      description:
        "Success criterion IDs from the current Task Contract, for example ['c1', 'c2']. Use the IDs returned by start_task or refine_task, not criterion descriptions.",
    }),
    evidence: Type.String(),
  },
  {
    additionalProperties: false,
    description: "Verification check; used only by record_verification.",
  },
);

const PindieStateParameters = Type.Object(
  {
    action: StringEnum(STATE_ACTIONS, {
      description:
        "Action contract: start_task starts a new Task: goal + successCriteria required; constraints + nextIntent optional. replace_task starts a different user-requested unfinished current Task: goal + successCriteria required; constraints + nextIntent optional. refine_task changes the existing Task Contract: goal / constraints / successCriteria only; at least one required. set_open_loops: blockers + questions required; nextIntent optional. record_verification: check required. complete_task: summary required; no other semantic fields.",
    }),
    goal: Type.Optional(Type.String({
      description:
        "Durable outcome the task is trying to achieve; used by start_task, replace_task, and refine_task.",
    })),
    constraints: Type.Optional(Type.Array(Type.String(), {
      description:
        "Durable task-wide boundaries or execution requirements used by start_task, replace_task, and refine_task, such as scope limits, prohibited actions, fixed human decisions, or technical constraints. Constraints are boundaries, not completion outcomes.",
    })),
    successCriteria: Type.Optional(Type.Array(Type.String(), {
      description:
        "Final observable outcomes required for completion; the final, durable Definition of Done used by start_task, replace_task, and refine_task. Each criterion must remain meaningful across sessions and true at final completion. Do not use success criteria for execution rules, prohibited actions, process sequencing, or temporary current-run choreography that belongs in constraints or current-run context.",
    })),
    nextIntent: Type.Optional(Type.String({
      description:
        "Continuation intent or likely next meaningful step for unfinished work, including cross-session continuation. Accepted only by start_task, replace_task, and set_open_loops; not part of the Definition of Done.",
    })),
    blockers: Type.Optional(Type.Array(Type.String(), {
      description: "Current blockers; used only by set_open_loops.",
    })),
    questions: Type.Optional(Type.Array(Type.String(), {
      description: "Unresolved questions; used only by set_open_loops.",
    })),
    check: Type.Optional(VerificationCheckSchema),
    summary: Type.Optional(Type.String({
      description:
        "Concise user-facing summary of the completed outcome and meaningful changes, grounded in observed project reality. Used only by complete_task. Verification evidence is rendered separately from recorded Pindie verification.",
    })),
  },
  { additionalProperties: false },
);

export interface PindieStateToolDetails {
  state: PindieState;
}

export interface PindieStateToolOptions {
  getRunDuration?: () => number | null;
  onStateChange?: () => void;
}

function assertOnlyFields(
  params: Record<string, unknown>,
  action: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Invalid pindie_state input for '${action}': unexpected field(s) ${unexpected.join(", ")}. Allowed fields: ${allowed.join(", ")}.`,
    );
  }
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
    details: { state } satisfies PindieStateToolDetails,
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

export function createPindieStateTool(
  runtime: PindieRuntime,
  options: PindieStateToolOptions = {},
) {
  return defineTool({
    name: "pindie_state",
    label: "Pindie State",
    description: "Update semantic current-task State through approved Pindie actions.",
    promptSnippet: "Update Pindie's semantic current-task State",
    parameters: PindieStateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      switch (params.action) {
        case "start_task": {
          assertOnlyFields(params, params.action, [
            "action",
            "goal",
            "constraints",
            "successCriteria",
            "nextIntent",
          ]);
          if (params.goal === undefined) {
            throw new Error("Invalid pindie_state start_task input: goal is required.");
          }
          if (!params.successCriteria || params.successCriteria.length === 0) {
            throw new Error(
              "Invalid pindie_state start_task input: provide at least one success criterion.",
            );
          }

          const state = await dispatchOrThrow(
            runtime,
            {
              type: "start_task",
              goal: params.goal,
              constraints: params.constraints ?? [],
              successCriteria: params.successCriteria,
              nextIntent: params.nextIntent ?? null,
            },
            options.onStateChange,
          );
          return result(
            `Current task started.\n\n${formatSuccessCriteria(state)}`,
            state,
          );
        }

        case "replace_task": {
          assertOnlyFields(params, params.action, [
            "action",
            "goal",
            "constraints",
            "successCriteria",
            "nextIntent",
          ]);
          if (params.goal === undefined) {
            throw new Error("Invalid pindie_state replace_task input: goal is required.");
          }
          if (!params.successCriteria || params.successCriteria.length === 0) {
            throw new Error(
              "Invalid pindie_state replace_task input: provide at least one success criterion.",
            );
          }

          const state = await dispatchOrThrow(
            runtime,
            {
              type: "replace_task",
              goal: params.goal,
              constraints: params.constraints ?? [],
              successCriteria: params.successCriteria,
              nextIntent: params.nextIntent ?? null,
            },
            options.onStateChange,
          );
          return result(
            `Current unfinished task replaced.\n\n${formatSuccessCriteria(state)}`,
            state,
          );
        }

        case "refine_task": {
          assertOnlyFields(params, params.action, [
            "action",
            "goal",
            "constraints",
            "successCriteria",
          ]);
          if (
            params.goal === undefined &&
            params.constraints === undefined &&
            params.successCriteria === undefined
          ) {
            throw new Error(
              "Invalid pindie_state refine_task input: provide at least one refinement field.",
            );
          }

          const event: Extract<PindieEvent, { type: "refine_task" }> = {
            type: "refine_task",
            ...(params.goal === undefined ? {} : { goal: params.goal }),
            ...(params.constraints === undefined
              ? {}
              : { constraints: params.constraints }),
            ...(params.successCriteria === undefined
              ? {}
              : { successCriteria: params.successCriteria }),
          };
          const state = await dispatchOrThrow(
            runtime,
            event,
            options.onStateChange,
          );
          return result(
            `Task contract refined.\n\n${formatSuccessCriteria(state)}`,
            state,
          );
        }

        case "set_open_loops": {
          assertOnlyFields(params, params.action, [
            "action",
            "blockers",
            "questions",
            "nextIntent",
          ]);
          if (!params.blockers || !params.questions) {
            throw new Error(
              "Invalid pindie_state set_open_loops input: blockers and questions are required.",
            );
          }

          const state = await dispatchOrThrow(
            runtime,
            {
              type: "set_open_loops",
              blockers: params.blockers,
              questions: params.questions,
              nextIntent: params.nextIntent ?? null,
            },
            options.onStateChange,
          );
          return result("Open loops updated.", state);
        }

        case "record_verification": {
          assertOnlyFields(params, params.action, ["action", "check"]);
          if (!params.check) {
            throw new Error(
              "Invalid pindie_state record_verification input: check is required.",
            );
          }

          const state = await dispatchOrThrow(
            runtime,
            {
              type: "record_verification",
              check: params.check as VerificationCheck,
            },
            options.onStateChange,
          );
          return result(`Verification check '${params.check.name}' recorded.`, state);
        }

        case "complete_task": {
          assertOnlyFields(params, params.action, ["action", "summary"]);
          if (typeof params.summary !== "string" || params.summary.trim() === "") {
            throw new Error(
              "Invalid pindie_state complete_task input: non-empty summary is required.",
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
        }

        default:
          throw new Error(`Unsupported pindie_state action: ${String(params.action)}.`);
      }
    },
  });
}
