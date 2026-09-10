import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { PindieRuntime } from "../runtime.ts";
import { dispatchOrThrow } from "./semantic-dispatch.ts";
import { renderCurrentPindieGate } from "../context.ts";
import type { PindieState } from "../state.ts";

const GateOpenParameters = Type.Object(
  {
    kind: StringEnum(["decision", "approval", "input"] as const, {
      description: "Kind of consequential human input required.",
    }),
    question: Type.String({ description: "Question presented to the human." }),
    options: Type.Optional(Type.Array(Type.String(), {
      description: "Explicit answer options, when useful.",
    })),
  },
  { additionalProperties: false },
);

const GateResolveParameters = Type.Object({}, { additionalProperties: false });

export interface PindieGateToolDetails {
  state: PindieState;
}

export interface PindieGateToolOptions {
  onStateChange?: () => void;
  onMutationUncertain?: (reason: string) => void;
}

function result(message: string, state: PindieState, terminate = false) {
  return {
    content: [{
      type: "text" as const,
      text: [message, "", renderCurrentPindieGate(state)].join("\n"),
    }],
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

export function createPindieGateOpenTool(
  runtime: PindieRuntime,
  options: PindieGateToolOptions = {},
) {
  return defineTool({
    name: "pindie_gate_open",
    label: "Open Pindie Human Gate",
    description: "Open a Human Gate for consequential human input.",
    parameters: GateOpenParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (params.kind === undefined || typeof params.question !== "string") {
        throw new Error(
          "Invalid pindie_gate_open input: kind and question are required.",
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
        signal,
        options,
      );
      return result(openGateMessage(gate.question, gate.options), state, true);
    },
  });
}

export function createPindieGateResolveTool(
  runtime: PindieRuntime,
  options: PindieGateToolOptions = {},
) {
  return defineTool({
    name: "pindie_gate_resolve",
    label: "Resolve Pindie Human Gate",
    description: "Resolve the current Human Gate.",
    parameters: GateResolveParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal) {
      const state = await dispatchOrThrow(
        runtime,
        { type: "resolve_human_gate" },
        signal,
        options,
      );
      return result(
        "Human Gate resolved. Re-observe relevant project reality before continuing.",
        state,
      );
    },
  });
}
