import assert from "node:assert/strict";
import test from "node:test";

import { SEED_STRATEGIES } from "../src/strategies.ts";

const expectedStrategies = [
  ["direct-action", "approach"],
  ["reproduce-first", "approach"],
  ["explore-first", "approach"],
  ["hypothesis-driven", "approach"],
  ["architecture-first", "approach"],
  ["minimal-change", "modifier"],
  ["verify-as-you-go", "modifier"],
] as const;

const forbiddenWorkflowTerms = /\b(?:steps?|phases?|transitions?|retry|workflow|control flow)\b/i;

test("SI01 Seed Strategy catalog contains exactly the seven immutable priors", () => {
  assert.deepEqual(
    SEED_STRATEGIES.map((strategy) => [strategy.id, strategy.kind]),
    expectedStrategies,
  );
  assert.equal(new Set(SEED_STRATEGIES.map((strategy) => strategy.id)).size, 7);
  assert.equal(Object.isFrozen(SEED_STRATEGIES), true);

  for (const strategy of SEED_STRATEGIES) {
    assert.equal(Object.isFrozen(strategy), true, strategy.id);
    assert.deepEqual(
      Object.keys(strategy).sort(),
      ["avoidWhen", "id", "kind", "principles", "summary", "useWhen"],
      strategy.id,
    );
    assert.ok(strategy.summary.length > 0, strategy.id);
    assert.ok(strategy.useWhen.length > 0, strategy.id);
    assert.ok(strategy.principles.length >= 2, strategy.id);
    assert.ok(strategy.avoidWhen && strategy.avoidWhen.length > 0, strategy.id);
    assert.equal(Object.isFrozen(strategy.useWhen), true, strategy.id);
    assert.equal(Object.isFrozen(strategy.avoidWhen), true, strategy.id);
    assert.equal(Object.isFrozen(strategy.principles), true, strategy.id);
    assert.doesNotMatch(JSON.stringify(strategy), forbiddenWorkflowTerms, strategy.id);
  }
});
