import assert from "node:assert/strict";
import test from "node:test";

import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
import type { RunExperienceSourceRecord } from "../src/experience-store.ts";
import {
  createStrategyRevisionCandidate,
  strategyCandidateSemanticFingerprint,
  strategyRevisionSelectionFromCandidate,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import { getSeedStrategy, seedStrategyFingerprint } from "../src/strategies.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";
import {
  deriveCandidateTrialReview,
  formatCandidateTrialReview,
  selectCandidateTrialEvidence,
  selectSeedBaselineEvidence,
} from "../src/experience-evaluation.ts";
import type { RunExperienceReadResult } from "../src/experience-store.ts";

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CANDIDATE_ID = "00000000-0000-4000-8000-000000000002";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The review is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function execution(overrides: Partial<RunExperienceExecution> = {}): RunExperienceExecution {
  return {
    toolCalls: 3,
    observations: 1,
    consequentialCalls: 2,
    projectMutationEffectCalls: 1,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
    ...overrides,
  };
}

function coherentSnapshot(
  overrides: Partial<Extract<SemanticSnapshot, { authority: "coherent" }>> = {},
): Extract<SemanticSnapshot, { authority: "coherent" }> {
  return {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
    ...overrides,
  };
}

function zeroExecution(): RunExperienceExecution {
  return {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
}

function experience(
  goal: string,
  policy: ReturnType<typeof createPolicySnapshot> | null,
  options: {
    execution?: RunExperienceExecution;
    finalPolicyFirstDeclaredAfter?: RunExperienceExecution | null;
    finalPolicyLastDeclaredAfter?: RunExperienceExecution | null;
    verificationStatus?: "pending" | "stale" | "failed" | "passed";
    completionRelation?: "not_completed" | "completed_during_run";
    recordedAt?: string;
  } = {},
): RunExperience {
  const finalPolicyLastDeclaredAfter = options.finalPolicyLastDeclaredAfter ??
    (policy === null ? null : zeroExecution());
  const finalPolicyFirstDeclaredAfter = options.finalPolicyFirstDeclaredAfter ??
    finalPolicyLastDeclaredAfter;
  return assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: coherentSnapshot({
      verificationStatus: options.verificationStatus ?? "pending",
      completionRelation: options.completionRelation ?? "not_completed",
      taskStatus: options.completionRelation === "completed_during_run" ? "done" : "active",
    }),
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter,
      finalPolicyLastDeclaredAfter,
    },
    execution: options.execution ?? execution(),
    durationMs: 100,
    cost: 0.5,
    recordedAt: options.recordedAt ?? "2026-01-01T00:00:00.000Z",
  });
}

function source(recordId: string, experienceValue: unknown): RunExperienceSourceRecord {
  return { recordId, experience: experienceValue as RunExperience };
}

function candidate(
  candidateId = CANDIDATE_ID,
): StrategyRevisionCandidate {
  return createStrategyRevisionCandidate({
    target: getSeedStrategy("architecture-first")!,
    candidateId,
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded architectural check before changing code.",
      useWhen: ["the change crosses a known interface boundary"],
      avoidWhen: ["the issue is already a local correction"],
      principles: ["name the boundary", "verify the smallest coherent change"],
      sourceRecordIds: ["adapt-one", "adapt-two"],
      hypothesis: "A narrower boundary check may reduce avoidable rework.",
    },
  });
}

function candidatePolicy(
  selectedCandidate: StrategyRevisionCandidate,
  selectionOverrides: Partial<{
    revisionIdentity: string;
    revisionFingerprint: string;
    revisionStatusAtRun: "trial" | "promoted";
  }> = {},
) {
  const selection = createStrategyRevisionSelection({
    strategyId: selectedCandidate.target.strategyId,
    kind: selectedCandidate.target.kind,
    revisionIdentity: selectionOverrides.revisionIdentity ?? selectedCandidate.candidateId,
    revisionFingerprint: selectionOverrides.revisionFingerprint ?? strategyCandidateSemanticFingerprint(selectedCandidate),
    revisionStatusAtRun: selectionOverrides.revisionStatusAtRun ?? "trial",
    semantics: selectedCandidate.proposal,
  });
  return createPolicySnapshotFromRevisions({
    approach: selection,
    modifiers: ["minimal-change"],
  });
}

function parsedSource(recordId: string, value: RunExperience): RunExperienceSourceRecord {
  const parsed = parseRunExperience(value);
  assert.ok(parsed);
  return { recordId, experience: parsed };
}

function validTrialSource(
  selectedCandidate: StrategyRevisionCandidate,
  recordId: string,
  goal: string,
  options: Parameters<typeof experience>[2] = {},
): RunExperienceSourceRecord {
  return parsedSource(recordId, experience(goal, candidatePolicy(selectedCandidate), options));
}

test("valid Candidate Trial evidence requires exact v4 revision identity and real exposure", () => {
  const selectedCandidate = candidate();
  const valid = validTrialSource(selectedCandidate, "trial-valid", "shared goal");
  const seed = parsedSource(
    "seed-current",
    experience("shared goal", createPolicySnapshot({ approach: "architecture-first" })),
  );
  const review = deriveCandidateTrialReview(selectedCandidate, [seed, valid]);

  assert.deepEqual(review.candidateProfile.sourceRecordIds, ["trial-valid"]);
  assert.equal(review.candidateProfile.runCount, 1);
  assert.equal(review.seedBaselineProfile.runCount, 1);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.equal(review.promotionEligibility.seedBaselineAvailable, true);
  assert.equal(review.trialEvaluations[0]?.policy.finalPolicyExposureCalls, 3);
});

test("wrong Candidate UUID or fingerprint and incorrect role do not become Trial evidence", () => {
  const selectedCandidate = candidate();
  const wrongUuid = parsedSource(
    "trial-wrong-uuid",
    experience(
      "wrong uuid",
      candidatePolicy(selectedCandidate, { revisionIdentity: OTHER_CANDIDATE_ID }),
    ),
  );
  const wrongFingerprint = parsedSource(
    "trial-wrong-fingerprint",
    experience(
      "wrong fingerprint",
      candidatePolicy(selectedCandidate, { revisionFingerprint: `sha256:${"0".repeat(64)}` }),
    ),
  );
  const wrongRoleRecord = structuredClone(validTrialSource(selectedCandidate, "trial-wrong-role", "wrong role").experience) as any;
  wrongRoleRecord.policy.finalSnapshot.approach.kind = "modifier";
  const records = [wrongUuid, wrongFingerprint, source("trial-wrong-role", wrongRoleRecord)];

  assert.deepEqual(selectCandidateTrialEvidence(selectedCandidate, records), []);

  const staleBinding = structuredClone(selectedCandidate) as any;
  staleBinding.target.baseFingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => deriveCandidateTrialReview(staleBinding, records),
    /immutable Seed binding/i,
  );
});

test("non-attributable and unexposed Candidate Runs are excluded while negative outcomes remain visible", () => {
  const selectedCandidate = candidate();
  const negative = validTrialSource(selectedCandidate, "trial-negative", "negative goal", {
    execution: execution({ toolErrors: 2, deniedCalls: 3 }),
    verificationStatus: "failed",
  });
  const noExposure = validTrialSource(selectedCandidate, "trial-no-exposure", "late declaration", {
    finalPolicyLastDeclaredAfter: execution(),
  });
  const completedBefore = structuredClone(validTrialSource(
    selectedCandidate,
    "trial-completed-before",
    "old goal",
  ).experience) as any;
  completedBefore.runStart.taskStatus = "done";
  completedBefore.outcome.taskStatus = "done";
  completedBefore.outcome.verificationStatus = "passed";
  completedBefore.outcome.completionRelation = "completed_before_run";

  const review = deriveCandidateTrialReview(selectedCandidate, [
    negative,
    noExposure,
    source("trial-completed-before", completedBefore),
  ]);
  assert.deepEqual(review.candidateProfile.sourceRecordIds, ["trial-negative"]);
  assert.equal(review.candidateProfile.verificationPassedCount, 0);
  assert.equal(review.candidateProfile.totalToolErrors, 2);
  assert.equal(review.candidateProfile.totalDeniedCalls, 3);
  assert.equal(review.promotionEligibility.eligibleTrialRunCount, 1);
  assert.match(
    formatCandidateTrialReview({
      records: [],
      loadedRecords: 3,
      unsupportedSchema: 0,
      invalid: 0,
    }, review),
    /Verification passed: 0 · not passed: 1/,
  );
});

test("Seed baseline uses only current schema-v4 evidence and exact goals form cohorts", () => {
  const selectedCandidate = candidate();
  const seedPolicy = createPolicySnapshot({ approach: "architecture-first" });
  const records = [
    validTrialSource(selectedCandidate, "trial-shared", "shared goal"),
    validTrialSource(selectedCandidate, "trial-other", "candidate-only"),
    parsedSource("seed-current-shared", experience("shared goal", seedPolicy)),
    parsedSource("seed-current-other", experience("seed-only", seedPolicy)),
    source("seed-pre-v4", { schemaVersion: 3 } as any),
  ];
  const review = deriveCandidateTrialReview(selectedCandidate, records);

  assert.equal(review.seedBaselineProfile.runCount, 2);
  assert.deepEqual(review.seedBaselineProfile.sourceRecordIds, [
    "seed-current-other",
    "seed-current-shared",
  ]);
  assert.deepEqual(review.comparableCohorts, [{
    taskGoal: "shared goal",
    candidateSourceRecordIds: ["trial-shared"],
    seedSourceRecordIds: ["seed-current-shared"],
  }]);
  assert.equal(selectSeedBaselineEvidence(selectedCandidate, records).length, 2);
});

test("Promotion Eligibility is false below two Trials and deterministic when the full gate is satisfied", () => {
  const selectedCandidate = candidate();
  const seedPolicy = createPolicySnapshot({ approach: "architecture-first" });
  const records = [
    validTrialSource(selectedCandidate, "trial-two", "shared goal", { recordedAt: "2026-01-03T00:00:00.000Z" }),
    validTrialSource(selectedCandidate, "trial-one", "shared goal", { recordedAt: "2026-01-02T00:00:00.000Z" }),
    parsedSource("seed-one", experience("shared goal", seedPolicy)),
  ];
  const oneTrial = deriveCandidateTrialReview(selectedCandidate, records.slice(0, 1));
  assert.equal(oneTrial.promotionEligibility.eligible, false);
  assert.match(oneTrial.promotionEligibility.reasons.join(" "), /at least 2/i);

  const first = deriveCandidateTrialReview(selectedCandidate, records);
  const second = deriveCandidateTrialReview(selectedCandidate, [...records].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.promotionEligibility.eligible, true);
  assert.deepEqual(first.promotionEligibility.reasons, []);
  assert.equal(first.promotionEligibility.noPriorTerminalDecision, true);
  assert.equal(first.candidateProfile.runCount, 2);
  assert.equal(first.seedBaselineProfile.runCount, 1);
  assert.match(
    formatCandidateTrialReview({
      records,
      loadedRecords: records.length,
      unsupportedSchema: 0,
      invalid: 0,
    }, first),
    /Promotion Eligibility: eligible for human review/,
  );
  assert.doesNotMatch(JSON.stringify(first), /score|ranking|reward|superiority|causal/i);

  const priorDecision = deriveCandidateTrialReview(selectedCandidate, records, {
    priorTerminalDecision: true,
  });
  assert.equal(priorDecision.promotionEligibility.eligible, false);
  assert.equal(priorDecision.promotionEligibility.noPriorTerminalDecision, false);
});

test("Promotion Eligibility keeps Candidate and Seed inventories separate without a comparable cohort", () => {
  const selectedCandidate = candidate();
  const records = [
    validTrialSource(selectedCandidate, "trial-one", "candidate goal one"),
    validTrialSource(selectedCandidate, "trial-two", "candidate goal two"),
    parsedSource("seed-one", experience("seed goal one", createPolicySnapshot({ approach: "architecture-first" }))),
  ];
  const review = deriveCandidateTrialReview(selectedCandidate, records);
  assert.deepEqual(review.comparableCohorts, []);
  const report = formatCandidateTrialReview({
    records,
    loadedRecords: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  } satisfies RunExperienceReadResult, review);
  assert.match(report, /Candidate and Seed evidence inventories remain separate/);
  assert.match(report, /Candidate Trial Evidence/);
  assert.match(report, /Seed Baseline Evidence/);
});

// Keep the immutable Seed binding used by these fixtures observable in the
// same way the review validates it; this also guards accidental catalog drift.
assert.match(seedStrategyFingerprint(getSeedStrategy("architecture-first")!), /^sha256:[0-9a-f]{64}$/);
assert.equal(
  strategyRevisionSelectionFromCandidate(candidate(), "trial").revisionFingerprint,
  strategyCandidateSemanticFingerprint(candidate()),
);
