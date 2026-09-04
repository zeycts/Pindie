import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createPolicySnapshotForRun,
  type PolicySnapshot,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "../policy.ts";

const RevisionSelector = Type.Object(
  {
    strategyId: Type.String({
      minLength: 1,
      description: "Logical Strategy ID owned by the Harness.",
    }),
    revisionIdentity: Type.String({
      minLength: 1,
      description: "Exact promoted revision UUID from the current Strategy context or Candidate UUID supplied by the active Trial Packet.",
    }),
    revisionFingerprint: Type.String({
      minLength: 1,
      description: "Exact Harness-derived fingerprint from the current promoted Strategy context or active Trial Packet.",
    }),
  },
  { additionalProperties: false },
);
const StrategySelection = Type.Union([
  Type.String({ description: "Seed Strategy ID." }),
  RevisionSelector,
]);

const PolicySetParameters = Type.Object(
  {
    approach: StrategySelection,
    modifiers: Type.Optional(Type.Array(StrategySelection, {
      uniqueItems: true,
      description: "Unique Seed IDs or exact Trial/promoted revision selectors whose kind is modifier.",
    })),
  },
  { additionalProperties: false },
);

export interface PindiePolicyToolOptions {
  onPolicySet: (snapshot: PolicySnapshot) => void;
  /** The Harness resolves exact non-Seed selectors against an active Trial or promoted catalog. */
  resolveRevisionSelector?: (
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    ctx: ExtensionContext,
  ) => StrategyRevisionSelection;
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = createPolicySnapshotForRun(
        params,
        options.resolveRevisionSelector === undefined
          ? undefined
          : (selector, kind) => options.resolveRevisionSelector!(selector, kind, ctx),
      );
      options.onPolicySet(snapshot);
      return result(snapshot);
    },
  });
}
