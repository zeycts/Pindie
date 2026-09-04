import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classifyToolEffect } from "../src/execution-semantics.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  isSeedStrategySelection,
  policySnapshotIdentity,
} from "../src/policy.ts";
import {
  buildAdaptationPacket,
  AdaptationRuntime,
  formatAdaptationPacket,
  selectAdaptationEvidence,
} from "../src/strategy-adaptation.ts";
import {
  createStrategyRevisionCandidate,
  FileStrategyCandidateStore,
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  type StrategyCandidateProposal,
} from "../src/strategy-candidates.ts";
import {
  seedStrategyFingerprint,
  SEED_STRATEGIES,
  type SeedStrategy,
} from "../src/strategies.ts";
import { createPindiePolicySetTool } from "../src/tools/policy.ts";
import { createPindieStrategyCandidateTool } from "../src/tools/strategy-candidate.ts";
import {
  assembleRunExperience,
  RunExperienceTracker,
  type RunExperience,
} from "../src/run-experience.ts";
import type { RunExperienceSourceRecord } from "../src/experience-store.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The evidence is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function experience(
  goal: string,
  policy: ReturnType<typeof createPolicySnapshot> | null,
  recordedAt: string,
): RunExperience {
  const snapshot: Extract<SemanticSnapshot, { authority: "coherent" }> = {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
  };
  const zero = {
    toolCalls: 2,
    observations: 1,
    consequentialCalls: 1,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  const before = {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  return assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot,
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: policy === null ? null : before,
      finalPolicyLastDeclaredAfter: policy === null ? null : before,
    },
    execution: zero,
    durationMs: 100,
    cost: 0.5,
    recordedAt,
  });
}

function legacyV3(value: RunExperience): any {
  const record = structuredClone(value) as any;
  record.schemaVersion = 3;
  if (record.policy.finalSnapshot !== null) {
    record.policy.finalSnapshot = createPolicySnapshot({
      approach: record.policy.finalSnapshot.approach.strategyId,
      modifiers: record.policy.finalSnapshot.modifiers.map((modifier: any) => modifier.strategyId),
    });
  }
  return record;
}

function source(
  recordId: string,
  value: RunExperience | any,
): RunExperienceSourceRecord {
  return { recordId, experience: value };
}

function proposal(sourceRecordIds: readonly string[]): StrategyCandidateProposal {
  return {
    summary: "Prefer a small verified change after a focused check.",
    useWhen: ["the problem has a narrow observable boundary"],
    avoidWhen: ["the likely fix remains unclear"],
    principles: ["make one bounded change", "verify before expanding scope"],
    sourceRecordIds,
    hypothesis: "The attributable Runs suggest that a narrower first move may reduce avoidable rework.",
  };
}

function candidateContext(sessionId = "session") {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as any;
}

test("Seed fingerprints are deterministic and Candidate construction does not mutate Seeds", () => {
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const snapshot = structuredClone(target);
  assert.equal(seedStrategyFingerprint(target), seedStrategyFingerprint(target));
  assert.equal(seedStrategyFingerprint(target), seedStrategyFingerprint(snapshot));
  assert.notEqual(
    seedStrategyFingerprint(target),
    seedStrategyFingerprint({ ...snapshot, summary: "changed" }),
  );
  const candidate = createStrategyRevisionCandidate({
    target,
    proposal: proposal(["one", "two"]),
    candidateId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(target, snapshot);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.proposal), true);
  assert.equal(Object.isFrozen(candidate.proposal.useWhen), true);
  assert.equal(candidate.schemaVersion, 1);
  assert.equal("fingerprint" in candidate, false);
  assert.equal(JSON.stringify(candidate).includes("fingerprint"), false);
  const fingerprint = strategyCandidateSemanticFingerprint(candidate);
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(fingerprint, strategyCandidateSemanticFingerprint(createStrategyRevisionCandidate({
    target,
    proposal: proposal(["different-one", "different-two"]),
    candidateId: candidate.candidateId,
    createdAt: "2027-01-01T00:00:00.000Z",
  })));

  assert.throws(() => createStrategyRevisionCandidate({
    target,
    proposal: {
      ...proposal(["one", "two"]),
      summary: target.summary,
      useWhen: [...target.useWhen],
      avoidWhen: [...(target.avoidWhen ?? [])],
      principles: [...target.principles],
    },
    candidateId: "00000000-0000-4000-8000-000000000003",
  }), /must differ/);
});

test("Candidate fingerprints bind revision semantics and remain inactive outside a future activation path", async () => {
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "architecture-first")!;
  const candidate = createStrategyRevisionCandidate({
    target,
    proposal: proposal(["one", "two"]),
    candidateId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const sameSemantics = {
    ...candidate,
    candidateId: "00000000-0000-4000-8000-000000000004",
    createdAt: "2027-01-01T00:00:00.000Z",
    evidence: { sourceRecordIds: ["other-one", "other-two"] },
    hypothesis: "A different non-factual hypothesis.",
  };
  assert.equal(
    strategyCandidateSemanticFingerprint(candidate),
    strategyCandidateSemanticFingerprint(sameSemantics),
  );
  assert.notEqual(
    strategyCandidateSemanticFingerprint(candidate),
    strategyCandidateSemanticFingerprint({
      ...candidate,
      proposal: {
        ...candidate.proposal,
        summary: "A materially different bounded proposal.",
      },
    }),
  );

  const trialSelection = strategyRevisionSelectionFromCandidate(candidate, "trial");
  const trialPolicy = createPolicySnapshotFromRevisions({ approach: trialSelection });
  assert.equal(trialSelection.strategyId, target.id);
  assert.equal(trialSelection.revisionIdentity, candidate.candidateId);
  assert.equal(
    trialSelection.revisionFingerprint,
    strategyCandidateSemanticFingerprint(candidate),
  );
  assert.equal(trialSelection.revisionStatusAtRun, "trial");
  assert.equal(isSeedStrategySelection(trialSelection), false);
  assert.notEqual(
    policySnapshotIdentity(createPolicySnapshot({ approach: target.id })),
    policySnapshotIdentity(trialPolicy),
  );

  const policyTool = createPindiePolicySetTool({ onPolicySet: () => undefined });
  await assert.rejects(
    (policyTool.execute as any)("inactive", { approach: trialSelection }),
    /approach must be a Seed Strategy ID/i,
  );
});

test("pre-Slice-A schema-v1 Candidate artifacts remain valid without persisted fingerprints", () => {
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const candidateProposal = proposal(["old-one", "old-two"]);
  const candidate = {
    schemaVersion: 1 as const,
    candidateId: "00000000-0000-4000-8000-000000000006",
    createdAt: "2026-01-01T00:00:00.000Z",
    target: {
      strategyId: target.id,
      kind: target.kind,
      baseFingerprint: seedStrategyFingerprint(target),
    },
    proposal: {
      summary: candidateProposal.summary,
      useWhen: candidateProposal.useWhen,
      avoidWhen: candidateProposal.avoidWhen,
      principles: candidateProposal.principles,
    },
    evidence: { sourceRecordIds: candidateProposal.sourceRecordIds },
    hypothesis: candidateProposal.hypothesis,
  };

  assert.equal("fingerprint" in candidate, false);
  const fingerprint = strategyCandidateSemanticFingerprint(candidate);
  assert.equal(fingerprint, strategyCandidateSemanticFingerprint(candidate));
  const selection = strategyRevisionSelectionFromCandidate(candidate, "trial");
  assert.equal(selection.revisionFingerprint, fingerprint);
});

test("Adaptation evidence selects only attributable target-policy Runs, newest first, and caps at eight", () => {
  const approach = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const modifier = SEED_STRATEGIES.find((strategy) => strategy.id === "minimal-change")!;
  const records: RunExperienceSourceRecord[] = Array.from({ length: 10 }, (_, index) =>
    source(
      `record-${String(index).padStart(2, "0")}`,
      experience(
        `goal-${index}`,
        createPolicySnapshot({ approach: approach.id }),
        `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    ));
  const candidate = createStrategyRevisionCandidate({
    target: approach,
    proposal: proposal(["candidate-one", "candidate-two"]),
    candidateId: "00000000-0000-4000-8000-000000000005",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const candidatePolicy = createPolicySnapshotFromRevisions({
    approach: strategyRevisionSelectionFromCandidate(candidate, "trial"),
  });
  records.push(source(
    "legacy-seed",
    legacyV3(experience(
      "legacy goal",
      createPolicySnapshot({ approach: approach.id }),
      "2025-12-31T00:00:00.000Z",
    )),
  ));
  records.push(source(
    "candidate-revision",
    experience("candidate goal", candidatePolicy, "2027-01-03T00:00:00.000Z"),
  ));
  records.push(source(
    "modifier-only",
    experience("modifier", createPolicySnapshot({ approach: "explore-first", modifiers: [modifier.id] }), "2027-01-01T00:00:00.000Z"),
  ));
  records.push(source(
    "no-policy",
    experience("none", null, "2027-01-02T00:00:00.000Z"),
  ));
  const before = structuredClone(records[0]!.experience) as any;
  before.runStart.taskStatus = "done";
  before.runStart.taskGoal = before.task.goal;
  before.outcome.taskStatus = "done";
  before.outcome.verificationStatus = "passed";
  before.outcome.completionRelation = "completed_before_run";
  records.push(source("completed-before", before));

  const selected = selectAdaptationEvidence(approach, records);
  assert.equal(selected.length, 11);
  assert.equal(selected.some((run) => run.source.recordId === "legacy-seed"), true);
  assert.equal(selected.some((run) => run.source.recordId === "candidate-revision"), false);
  const modifierSelected = selectAdaptationEvidence(modifier, records);
  assert.deepEqual(modifierSelected.map((run) => run.source.recordId), ["modifier-only"]);
  assert.deepEqual(selected[0]!.source.recordId, "record-09");
  assert.equal(selected.some((run) => run.source.recordId === "modifier-only"), false);
  assert.equal(selected.some((run) => run.source.recordId === "no-policy"), false);
  assert.equal(selected.some((run) => run.source.recordId === "completed-before"), false);

  const packet = buildAdaptationPacket(approach, records);
  assert.equal(packet.evidence.eligibleRunCount, 11);
  assert.equal(packet.evidence.shownRunCount, 8);
  assert.equal(packet.evidence.omittedRunCount, 3);
  assert.deepEqual(packet.sourceRecordIds, [
    "record-09", "record-08", "record-07", "record-06",
    "record-05", "record-04", "record-03", "record-02",
  ]);
  assert.match(packet.target.baseFingerprint, /^sha256:[0-9a-f]{64}$/);
  const rendered = formatAdaptationPacket(packet);
  assert.match(rendered, /confounders|causal proof|does not justify a revision/i);
  assert.doesNotMatch(rendered, /transcript|chain.of.thought|raw tool|score|ranking/i);
});

test("Candidate control has a separate non-execution effect and successful creation consumes its lease", async () => {
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const first = source("one", experience("one", createPolicySnapshot({ approach: target.id }), "2026-01-01T00:00:00.000Z"));
  const second = source("two", experience("two", createPolicySnapshot({ approach: target.id }), "2026-01-02T00:00:00.000Z"));
  const records = [first, second];
  const packet = buildAdaptationPacket(target, records);
  const adaptation = new AdaptationRuntime();
  assert.equal(adaptation.establish("session", target, packet), true);
  assert.ok(adaptation.bind("session", 4));
  const saved: any[] = [];
  let failSave = true;
  const tool = createPindieStrategyCandidateTool({
    adaptation,
    experienceReader: { read: async () => ({ records, loadedSchemaV3: 0, loadedSchemaV4: 2, unsupportedSchema: 0, invalid: 0 }) },
    candidateStore: {
      save: async (_root, candidate) => {
        if (failSave) {
          failSave = false;
          throw new Error("candidate disk unavailable");
        }
        saved.push(candidate);
      },
    },
    getProjectRoot: () => "/project",
    getAgentRunGeneration: () => 4,
  });
  assert.deepEqual(classifyToolEffect("pindie_strategy_candidate_create"), {
    requiredCapability: "policy.adapt",
    projectMutation: "none",
  });
  await assert.rejects(
    tool.execute("invalid", proposal(["one", "outside"]), undefined, undefined, candidateContext()),
    /active Adaptation Packet/,
  );
  await assert.rejects(
    tool.execute("failed-save", proposal(["one", "two"]), undefined, undefined, candidateContext()),
    /adaptation attempt remains retryable/,
  );
  assert.equal(saved.length, 0);
  const result = await tool.execute("candidate", proposal(["one", "two"]), undefined, undefined, candidateContext());
  assert.match(result.content[0]!.text, /Candidate created/);
  assert.match(result.content[0]!.text, /inactive.*not active Policy/i);
  assert.equal(saved.length, 1);
  await assert.rejects(
    tool.execute("second", proposal(["one", "two"]), undefined, undefined, candidateContext()),
    /without a live adaptation attempt/i,
  );
});

test("Candidate persistence is project-local, schema-v1, UUID-v4, and atomic", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-candidate-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyCandidateStore({ baseDir });
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const candidate = createStrategyRevisionCandidate({
    target,
    proposal: proposal(["one", "two"]),
    candidateId: "00000000-0000-4000-8000-000000000002",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await store.save("/project-a", candidate);
  const directory = store.strategyCandidateDirectory("/project-a");
  assert.deepEqual(await readdir(directory), [`${candidate.candidateId}.json`]);
  const persisted = JSON.parse(await readFile(join(directory, `${candidate.candidateId}.json`)));
  assert.deepEqual(persisted, candidate);
  assert.equal("fingerprint" in persisted, false);
  assert.equal((await readdir(store.strategyCandidateDirectory("/project-b")).catch(() => [])).length, 0);
  await assert.rejects(store.save("/project-a", candidate), /already exists/);
});

test("adaptation-control calls do not create normal execution or policy telemetry", () => {
  const tracker = new RunExperienceTracker();
  const effect = classifyToolEffect("pindie_strategy_candidate_create");
  tracker.recordAuthorizedCall("candidate", effect);
  assert.equal(tracker.execution.toolCalls, 0);
  assert.equal(tracker.execution.observations, 0);
  assert.equal(tracker.execution.consequentialCalls, 0);
  assert.equal(tracker.execution.deniedCalls, 0);
  assert.equal(tracker.recordToolResult("candidate", true), "self-improvement");
  assert.equal(tracker.policy.declarationCount, 0);
});
