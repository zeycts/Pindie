import assert from "node:assert/strict";
import test from "node:test";

import { renderPindieSystemContract } from "../src/context.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
  formatStrategySelectionLabel,
  isSeedStrategySelection,
  policySnapshotIdentity,
  serializePolicySnapshot,
  type PolicySnapshot,
} from "../src/policy.ts";
import { SEED_STRATEGIES } from "../src/strategies.ts";

const REVISION_ID = "00000000-0000-4000-8000-000000000001";
const REVISION_FINGERPRINT = `sha256:${"1".repeat(64)}`;

function revisionSelection(
  status: "trial" | "promoted" = "trial",
) {
  return createStrategyRevisionSelection({
    strategyId: "architecture-first",
    kind: "approach",
    revisionIdentity: REVISION_ID,
    revisionFingerprint: REVISION_FINGERPRINT,
    revisionStatusAtRun: status,
    semantics: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is a local, already-understood correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
    },
  });
}

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

test("SI v0.6 revision identity is explicit while ordinary Policy declaration remains Seed-only", () => {
  const seed = createPolicySnapshot({ approach: "architecture-first" });
  const trial = revisionSelection();
  const trialPolicy = createPolicySnapshotFromRevisions({ approach: trial });
  const promotedPolicy = createPolicySnapshotFromRevisions({
    approach: revisionSelection("promoted"),
  });
  const serialized = serializePolicySnapshot(trialPolicy);

  assert.equal(isSeedStrategySelection(seed.approach), true);
  assert.equal(isSeedStrategySelection(trial), false);
  assert.notEqual(policySnapshotIdentity(seed), policySnapshotIdentity(trialPolicy));
  assert.equal(policySnapshotIdentity(trialPolicy), policySnapshotIdentity(promotedPolicy));
  assert.deepEqual(Object.keys(serialized.approach), [
    "strategyId",
    "kind",
    "revisionIdentity",
    "revisionFingerprint",
    "revisionStatusAtRun",
    "semantics",
  ]);
  assert.deepEqual(serialized.approach.semantics, trial.semantics);

  assert.throws(
    () => createPolicySnapshot({ approach: trial }),
    /approach must be a Seed Strategy ID/i,
  );
});

test("Policy presentation preserves Seed shorthand and identifies Trial/promoted revisions without changing Policy identity", () => {
  const seed = createPolicySnapshot({ approach: "architecture-first" });
  const trial = revisionSelection("trial");
  const promoted = revisionSelection("promoted");
  const trialPolicy = createPolicySnapshotFromRevisions({ approach: trial });
  const promotedPolicy = createPolicySnapshotFromRevisions({ approach: promoted });

  assert.equal(formatStrategySelectionLabel(seed.approach), "architecture-first");
  assert.equal(formatStrategySelectionLabel(trial), "architecture-first · trial 00000000");
  assert.equal(formatStrategySelectionLabel(promoted), "architecture-first · promoted 00000000");
  assert.equal(
    policySnapshotIdentity(trialPolicy),
    policySnapshotIdentity(promotedPolicy),
    "Run status remains attribution metadata outside Policy identity",
  );
  assert.equal(serializePolicySnapshot(trialPolicy).approach.revisionStatusAtRun, "trial");
  assert.equal(serializePolicySnapshot(promotedPolicy).approach.revisionStatusAtRun, "promoted");
  assert.equal(trial.revisionStatusAtRun, "trial");
  assert.equal(promoted.revisionStatusAtRun, "promoted");
  assert.equal("candidateStatus" in trial, false);
  assert.equal("trust" in promoted, false);
});

test("Core system contract excludes retired Seed and Policy guidance", () => {
  const contract = renderPindieSystemContract();
  assert.doesNotMatch(contract, /Seed Strategies:/);
  for (const seed of SEED_STRATEGIES) assert.equal(contract.includes(seed.id), false);
  assert.doesNotMatch(contract, /Current Policy Snapshot/);
  assert.doesNotMatch(contract, /pindie_policy_set/);
});
