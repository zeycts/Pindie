import assert from "node:assert/strict";
import test from "node:test";

import { renderPindieSystemContract } from "../src/context.ts";
import { createPolicySnapshot } from "../src/policy.ts";
import { SEED_STRATEGIES } from "../src/strategies.ts";

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

test("Core system contract excludes retired Seed and Policy guidance", () => {
  const contract = renderPindieSystemContract();
  assert.doesNotMatch(contract, /Seed Strategies:/);
  for (const seed of SEED_STRATEGIES) assert.equal(contract.includes(seed.id), false);
  assert.doesNotMatch(contract, /Current Policy Snapshot/);
  assert.doesNotMatch(contract, /pindie_policy_set/);
});
