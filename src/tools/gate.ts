import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { PindieRuntime } from "../runtime.ts";
import type { PindieState } from "../state.ts";
import { notifyStateChangeBestEffort } from "./state-observer.ts";
import type { PindieEvent } from "../transitions.ts";

const GATE_ACTIONS = ["open", "resolve"] as const;

const PindieGateParameters = Type.Object(
  {
    action: StringEnum(GATE_ACTIONS, {
      description: "Open or resolve the current Human Gate",
    }),
    kind: Type.Optional(
      StringEnum(["decision", "approval", "input"] as const),
    ),
    question: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export interface PindieGateToolDetails {
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
      `Invalid pindie_gate input for '${action}': unexpected field(s) ${unexpected.join(", ")}.`,
    );
  }
}

async function dispatchOrThrow(
  runtime: PindieRuntime,
  event: PindieEvent,
  onStateChange?: () => void,
): Promise<PindieState> {
  const result = await runtime.dispatch(event);
  if (!result.ok) {
    throw new Error(
      `Pindie transition rejected (${result.error.code}): ${result.error.message}`,
    );
  }

  notifyStateChangeBestEffort(onStateChange);
  return runtime.state;
}

function result(message: string, state: PindieState, terminate = false) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { state } satisfies PindieGateToolDetails,
    ...(terminate ? { terminate: true } : {}),
  };
}

function openGateMessage(question: string, options?: string[]): string {
  const lines = ["Human input required:", "", question];

  if (options && options.length > 0) {
    lines.push("", "Options:", ...options.map((option) => `- ${option}`));
  }

  return lines.join("\n");
}

export function createPindieGateTool(
  runtime: PindieRuntime,
  options: { onStateChange?: () => void } = {},
) {
  return defineTool({
    name: "pindie_gate",
    label: "Pindie Human Gate",
    description: "Pause for or resolve consequential human input.",
    promptSnippet: "Open or resolve Pindie's Human Gate",
    parameters: PindieGateParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      switch (params.action) {
        case "open": {
          assertOnlyFields(params, params.action, [
            "action",
            "kind",
            "question",
            "options",
          ]);
          if (params.kind === undefined || params.question === undefined) {
            throw new Error(
              "Invalid pindie_gate open input: kind and question are required.",
            );
          }

          const gate = {
            kind: params.kind,
            question: params.question,
            ...(params.options === undefined ? {} : { options: params.options }),
          };
          const state = await dispatchOrThrow(
            runtime,
            { type: "open_human_gate", gate },
            options.onStateChange,
          );
          return result(
            openGateMessage(gate.question, gate.options),
            state,
            true,
          );
        }

        case "resolve": {
          assertOnlyFields(params, params.action, ["action"]);
          const state = await dispatchOrThrow(
            runtime,
            { type: "resolve_human_gate" },
            options.onStateChange,
          );
          return result(
            "Human Gate resolved. Re-observe relevant project reality before continuing.",
            state,
          );
        }

        default:
          throw new Error(`Unsupported pindie_gate action: ${String(params.action)}.`);
      }
    },
  });
}
