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
import { createPindiePolicySetTool } from "../src/tools/policy.ts";
import { PINDIE_TOOL_LIVENESS_TIMEOUT_MS } from "../src/liveness.ts";

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

test("SI v0.6 revision identity is explicit while ordinary Policy declaration remains Seed-only", async () => {
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
  const declared: PolicySnapshot[] = [];
  const tool = createPindiePolicySetTool({ onPolicySet: (snapshot) => declared.push(snapshot) });
  await assert.rejects(
    (tool.execute as any)("inactive-candidate", { approach: trial }),
    /approach must be a Seed Strategy ID/i,
  );
  assert.deepEqual(declared, []);
});

test("Policy presentation preserves Seed shorthand and identifies Trial/promoted revisions without changing Policy identity", async () => {
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

  const declared: PolicySnapshot[] = [];
  const revisions = [trial, promoted];
  let resolved = 0;
  const tool = createPindiePolicySetTool({
    onPolicySet: (snapshot) => declared.push(snapshot),
    resolveRevisionSelector: () => revisions[resolved++]!,
  });
  const trialResult = await (tool.execute as any)("trial", {
    approach: {
      strategyId: "architecture-first",
      revisionIdentity: REVISION_ID,
      revisionFingerprint: REVISION_FINGERPRINT,
    },
  });
  const promotedResult = await (tool.execute as any)("promoted", {
    approach: {
      strategyId: "architecture-first",
      revisionIdentity: REVISION_ID,
      revisionFingerprint: REVISION_FINGERPRINT,
    },
  });
  const trialText = trialResult.content.map((part: { text?: string }) => part.text ?? "").join("\\n");
  const promotedText = promotedResult.content.map((part: { text?: string }) => part.text ?? "").join("\\n");

  assert.match(trialText, /Approach: architecture-first · trial 00000000/);
  assert.match(promotedText, /Approach: architecture-first · promoted 00000000/);
  for (const text of [trialText, promotedText]) {
    assert.doesNotMatch(text, /sha256:/);
    assert.doesNotMatch(text, /00000000-0000-4000-8000-000000000001/);
  }
  assert.equal(resolved, 2);
  assert.equal(declared[0]?.approach, trial);
  assert.equal(declared[1]?.approach, promoted);
  assert.equal(policySnapshotIdentity(declared[0]!), policySnapshotIdentity(trialPolicy));
  assert.equal(policySnapshotIdentity(declared[1]!), policySnapshotIdentity(promotedPolicy));
  assert.equal(trial.revisionStatusAtRun, "trial");
  assert.equal(promoted.revisionStatusAtRun, "promoted");
  assert.equal("candidateStatus" in trial, false);
  assert.equal("trust" in promoted, false);
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

test("pindie_policy_set bounds a hanging revision resolver and never installs its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const declared: PolicySnapshot[] = [];
  let markStarted!: () => void;
  let resolveRevision!: (selection: ReturnType<typeof revisionSelection>) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const tool = createPindiePolicySetTool({
    onPolicySet: (snapshot) => declared.push(snapshot),
    resolveRevisionSelector: async () => {
      markStarted();
      return new Promise((resolve) => { resolveRevision = resolve; });
    },
  });
  const execution = (tool.execute as any)("hung", {
    approach: {
      strategyId: "architecture-first",
      revisionIdentity: REVISION_ID,
      revisionFingerprint: REVISION_FINGERPRINT,
    },
  });
  await started;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await assert.rejects(execution, /Policy resolution timed out/);
  assert.deepEqual(declared, []);

  resolveRevision(revisionSelection());
  await Promise.resolve();
  assert.deepEqual(declared, []);
});

test("pindie_policy_set uses the caller AbortSignal to cancel resolution", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const tool = createPindiePolicySetTool({
    onPolicySet: () => assert.fail("aborted Policy resolution must not install a Snapshot"),
    resolveRevisionSelector: async () => {
      markStarted();
      return new Promise(() => {});
    },
  });
  const execution = (tool.execute as any)("aborted", {
    approach: {
      strategyId: "architecture-first",
      revisionIdentity: REVISION_ID,
      revisionFingerprint: REVISION_FINGERPRINT,
    },
  }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(execution, /Policy resolution was aborted/);
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
