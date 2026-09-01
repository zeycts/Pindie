import assert from "node:assert/strict";
import test from "node:test";

import { renderPindieSystemContract } from "../src/context.ts";
import {
  createPolicySnapshot,
  type PolicySnapshot,
} from "../src/policy.ts";
import { SEED_STRATEGIES } from "../src/strategies.ts";
import { createPindiePolicySetTool } from "../src/tools/policy.ts";

function strategy(id: string) {
  const found = SEED_STRATEGIES.find((candidate) => candidate.id === id);
  assert.ok(found, id);
  return found;
}

test("SI02 valid Policy Snapshots resolve one approach and unique modifiers from Seed Strategies", () => {
  const snapshot = createPolicySnapshot({
    approach: "architecture-first",
    modifiers: ["minimal-change", "verify-as-you-go"],
  });

  assert.deepEqual(snapshot, {
    approach: strategy("architecture-first"),
    modifiers: [strategy("minimal-change"), strategy("verify-as-you-go")],
  });
  assert.deepEqual(Object.keys(snapshot), ["approach", "modifiers"]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.modifiers), true);
});

test("SI02 Policy Snapshot validation keeps approach and modifier kinds separate", () => {
  assert.throws(
    () => createPolicySnapshot({ approach: "not-a-seed-strategy" }),
    /approach.*Seed approach Strategy/i,
  );
  assert.throws(
    () => createPolicySnapshot({ approach: "minimal-change" }),
    /approach.*Seed approach Strategy/i,
  );
  assert.throws(
    () => createPolicySnapshot({
      approach: "direct-action",
      modifiers: ["architecture-first"],
    }),
    /modifier.*Seed modifier Strategy/i,
  );
  assert.throws(
    () => createPolicySnapshot({
      approach: "direct-action",
      modifiers: ["minimal-change", "minimal-change"],
    }),
    /modifiers must be unique/i,
  );
});

test("SI02 policy declaration tool is optional, structured, and replaces the current Snapshot", async () => {
  const snapshots: PolicySnapshot[] = [];
  const tool = createPindiePolicySetTool({
    onPolicySet: (snapshot) => snapshots.push(snapshot),
  });

  assert.equal(tool.name, "pindie_policy_set");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual((tool.parameters as any).required, ["approach"]);
  assert.equal((tool.parameters as any).properties.modifiers.uniqueItems, true);
  assert.match(tool.description, /only when a named Strategy materially guides/i);
  assert.match(tool.description, /current approach meaningfully changes/i);
  assert.match(tool.description, /not.*populate metadata/i);

  await (tool.execute as any)("first", {
    approach: "direct-action",
    modifiers: ["minimal-change"],
  });
  await (tool.execute as any)("replacement", {
    approach: "explore-first",
  });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1)?.approach.id, "explore-first");
  assert.deepEqual(snapshots.at(-1)?.modifiers, []);
  assert.notEqual(snapshots[0], snapshots[1]);
});

test("SI02 policy keeps Seed Strategies in the stable contract and declares current Policy in its tool result", async () => {
  const contract = renderPindieSystemContract();
  assert.match(contract, /Seed Strategies:/);
  for (const seed of SEED_STRATEGIES) assert.match(contract, new RegExp(`- ${seed.id} \\(${seed.kind}\\)`));
  assert.doesNotMatch(contract, /Current Policy Snapshot/);

  const snapshots: PolicySnapshot[] = [];
  const tool = createPindiePolicySetTool({ onPolicySet: (snapshot) => snapshots.push(snapshot) });
  const result = await (tool.execute as any)("declare", {
    approach: "architecture-first",
    modifiers: ["minimal-change"],
  });
  const text = result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
  assert.match(text, /Current Policy Snapshot declared\./);
  assert.match(text, /Approach: architecture-first/);
  assert.match(text, /Modifiers: minimal-change/);
  assert.equal(snapshots[0]?.approach.id, "architecture-first");
});
