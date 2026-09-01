import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createPolicySnapshot,
  type PolicySnapshot,
} from "../policy.ts";

const PolicySetParameters = Type.Object(
  {
    approach: Type.String({
      description: "ID of exactly one Seed Strategy whose kind is approach.",
    }),
    modifiers: Type.Optional(Type.Array(Type.String(), {
      uniqueItems: true,
      description: "Unique IDs of zero or more Seed Strategies whose kind is modifier.",
    })),
  },
  { additionalProperties: false },
);

export interface PindiePolicyToolOptions {
  onPolicySet: (snapshot: PolicySnapshot) => void;
}

function result(snapshot: PolicySnapshot) {
  return {
    content: [{
      type: "text" as const,
      text: [
        "Current Policy Snapshot declared.",
        "",
        `Approach: ${snapshot.approach.id}`,
        `Modifiers: ${snapshot.modifiers.length > 0
          ? snapshot.modifiers.map((strategy) => strategy.id).join(", ")
          : "none"}`,
      ].join("\n"),
    }],
    details: undefined,
  };
}

export function createPindiePolicySetTool(
  options: PindiePolicyToolOptions,
) {
  return defineTool({
    name: "pindie_policy_set",
    label: "Set Pindie Policy Snapshot",
    description: "Optionally declare or replace the current Agent Run's cognitive Policy Snapshot. Use this only when a named Strategy materially guides the current work or the current approach meaningfully changes; do not call merely to populate metadata.",
    parameters: PolicySetParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const snapshot = createPolicySnapshot(params);
      options.onPolicySet(snapshot);
      return result(snapshot);
    },
  });
}
