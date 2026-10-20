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
import { PindieLivenessTimeoutError } from "../src/liveness.ts";
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

test("Revision Candidate store observes cancellation before the final rename", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-candidate-cancel-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const target = SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!;
  const candidate = createStrategyRevisionCandidate({
    target,
    proposal: proposal(["one", "two"]),
    candidateId: "00000000-0000-4000-8000-000000000008",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const controller = new AbortController();
  const store = new FileStrategyCandidateStore({
    baseDir,
    beforeCommit: () => controller.abort(),
  });
  await assert.rejects(store.save("/project-a", candidate, controller.signal));
  assert.deepEqual(await readdir(store.strategyCandidateDirectory("/project-a")), []);
  assert.equal(await store.read("/project-a", candidate.candidateId), null);
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
