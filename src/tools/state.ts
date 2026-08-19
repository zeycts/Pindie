import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { PindieRuntime } from "../runtime.ts";
import type { PindieState, VerificationCheck } from "../state.ts";
import type { PindieEvent } from "../transitions.ts";

const STATE_ACTIONS = [
  "start_task",
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
  { additionalProperties: false },
);

const PindieStateParameters = Type.Object(
  {
    action: StringEnum(STATE_ACTIONS, {
      description: "The semantic State action to perform",
    }),
    goal: Type.Optional(Type.String()),
    constraints: Type.Optional(Type.Array(Type.String())),
    successCriteria: Type.Optional(Type.Array(Type.String())),
    nextIntent: Type.Optional(Type.String()),
    blockers: Type.Optional(Type.Array(Type.String())),
    questions: Type.Optional(Type.Array(Type.String())),
    check: Type.Optional(VerificationCheckSchema),
  },
  { additionalProperties: false },
);

export interface PindieStateToolDetails {
  state: PindieState;
}

function assertOnlyFields(
  params: Record<string, unknown>,
  action: string,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `Invalid pindie_state input for '${action}': unexpected field(s) ${unexpected.join(", ")}.`,
    );
  }
}

async function dispatchOrThrow(
  runtime: PindieRuntime,
  event: PindieEvent,
): Promise<PindieState> {
  const result = await runtime.dispatch(event);
  if (!result.ok) {
    throw new Error(
      `Pindie transition rejected (${result.error.code}): ${result.error.message}`,
    );
  }

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

export function createPindieStateTool(runtime: PindieRuntime) {
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

          const state = await dispatchOrThrow(runtime, {
            type: "start_task",
            goal: params.goal,
            constraints: params.constraints ?? [],
            successCriteria: params.successCriteria,
            nextIntent: params.nextIntent ?? null,
          });
          return result(
            `Current task started.\n\n${formatSuccessCriteria(state)}`,
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
          const state = await dispatchOrThrow(runtime, event);
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

          const state = await dispatchOrThrow(runtime, {
            type: "set_open_loops",
            blockers: params.blockers,
            questions: params.questions,
            nextIntent: params.nextIntent ?? null,
          });
          return result("Open loops updated.", state);
        }

        case "record_verification": {
          assertOnlyFields(params, params.action, ["action", "check"]);
          if (!params.check) {
            throw new Error(
              "Invalid pindie_state record_verification input: check is required.",
            );
          }

          const state = await dispatchOrThrow(runtime, {
            type: "record_verification",
            check: params.check as VerificationCheck,
          });
          return result(`Verification check '${params.check.name}' recorded.`, state);
        }

        case "complete_task": {
          assertOnlyFields(params, params.action, ["action"]);
          const state = await dispatchOrThrow(runtime, { type: "complete_task" });
          return result("Current task completed with passing verification.", state, true);
        }

        default:
          throw new Error(`Unsupported pindie_state action: ${String(params.action)}.`);
      }
    },
  });
}
