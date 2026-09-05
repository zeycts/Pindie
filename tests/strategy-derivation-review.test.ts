import assert from "node:assert/strict";
import test from "node:test";

import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
import type { RunExperienceSourceRecord } from "../src/experience-store.ts";
import {
  deriveStrategyDerivationTrialReview,
  formatStrategyDerivationTrialReview,
  selectDerivationCandidateTrialEvidence,
} from "../src/experience-evaluation.ts";
import {
  createStrategyDerivationCandidate,
  strategyDerivationCandidateSemanticFingerprint,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  trustedPortfolioFingerprint,
  type TrustedPortfolioManifestEntry,
  type TrustedPortfolioResolvedEntry,
  type TrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import { getSeedStrategy } from "../src/strategies.ts";
import type { PindieState } from "../src/state.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000101";
const TRIAL_ONE = "trial-one";
const TRIAL_TWO = "trial-two";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The check is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function zero(): RunExperienceExecution {
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

function snapshot(overrides: Partial<Extract<SemanticSnapshot, { authority: "coherent" }>> = {}) {
  return {
    authority: "coherent" as const,
    taskStatus: "active" as const,
    verificationStatus: "pending" as const,
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched" as const,
    completionRelation: "not_completed" as const,
    gateRelation: "none" as const,
    ...overrides,
  };
}

function experience(
  goal: string,
  policy: PolicySnapshot | null,
  options: {
    execution?: RunExperienceExecution;
    finalPolicyLastDeclaredAfter?: RunExperienceExecution | null;
    verificationStatus?: "pending" | "failed" | "passed" | "stale";
    recordedAt?: string;
  } = {},
): RunExperience {
  const last = options.finalPolicyLastDeclaredAfter ?? (policy === null ? null : zero());
  return assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: snapshot({ verificationStatus: options.verificationStatus ?? "pending" }),
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: last,
      finalPolicyLastDeclaredAfter: last,
    },
    execution: options.execution ?? execution(),
    durationMs: 125,
    cost: 0.75,
    recordedAt: options.recordedAt ?? "2026-04-01T00:00:00.000Z",
  });
}

function source(recordId: string, value: RunExperience): RunExperienceSourceRecord {
  const parsed = parseRunExperience(value);
  assert.ok(parsed);
  return { recordId, experience: parsed };
}

function portfolio(): TrustedStrategyPortfolio {
  return createTrustedStrategyPortfolio("/repo", createPromotedStrategyRevisionCatalog([]));
}

function candidate(base = portfolio()): StrategyDerivationCandidateV1 {
  return createStrategyDerivationCandidate({
    projectId: base.projectId,
    basePortfolio: base,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-04-01T00:00:00.000Z",
    proposal: {
      strategyId: "boundary-first",
      kind: "approach",
      summary: "Make the smallest ownership boundary explicit before implementation.",
      useWhen: ["the requested change crosses an ownership boundary"],
      avoidWhen: ["the correction is local and already clear"],
      principles: ["name the boundary", "verify the smallest coherent move"],
      sourceRecordIds: ["source-a", "source-b", "source-c"],
      hypothesis: "Repeated trusted-policy Runs may expose a missing boundary abstraction.",
    },
  });
}

function trialPolicy(
  value: StrategyDerivationCandidateV1,
  overrides: Partial<{
    revisionIdentity: string;
    revisionFingerprint: string;
    revisionStatusAtRun: "trial" | "promoted";
  }> = {},
): PolicySnapshot {
  const selection = createStrategyRevisionSelection({
    strategyId: value.proposal.strategyId,
    kind: value.proposal.kind,
    revisionIdentity: overrides.revisionIdentity ?? value.candidateId,
    revisionFingerprint: overrides.revisionFingerprint ?? strategyDerivationCandidateSemanticFingerprint(value),
    revisionStatusAtRun: overrides.revisionStatusAtRun ?? "trial",
    semantics: value.proposal,
  });
  return createPolicySnapshotFromRevisions({
    approach: selection,
    modifiers: ["minimal-change"],
  });
}

function sourceRecords(): readonly RunExperienceSourceRecord[] {
  return [
    source("source-a", experience("same exact goal", createPolicySnapshot({ approach: "direct-action" }), {
      recordedAt: "2026-04-01T00:00:00.000Z",
    })),
    source("source-b", experience("same exact goal", createPolicySnapshot({
      approach: "direct-action",
      modifiers: ["minimal-change"],
    }), { recordedAt: "2026-04-02T00:00:00.000Z" })),
    source("source-c", experience("another exact goal", createPolicySnapshot({ approach: "explore-first" }), {
      recordedAt: "2026-04-03T00:00:00.000Z",
    })),
  ];
}

function readResult(records: readonly RunExperienceSourceRecord[]) {
  return {
    records,
    loadedRecords: records.length,
    unsupportedSchema: 0,
    invalid: 0,
  };
}

test("Derivation review keeps revalidated source and exact Candidate Trial inventories separate", async () => {
  const value = candidate();
  const records = [
    ...sourceRecords(),
    source(TRIAL_ONE, experience("same exact goal", trialPolicy(value), {
      verificationStatus: "failed",
      execution: execution({ toolErrors: 2, deniedCalls: 1 }),
    })),
    source(TRIAL_TWO, experience("trial-only goal", trialPolicy(value), {
      verificationStatus: "passed",
    })),
  ];
  const review = await deriveStrategyDerivationTrialReview(value, records, {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });

  assert.equal(review.sourceEvidence.provenanceValid, true);
  assert.deepEqual(review.sourceEvidence.citedSourceRecordIds, ["source-a", "source-b", "source-c"]);
  assert.equal(review.sourceEvidence.profile.runCount, 3);
  assert.equal(review.sourceEvidence.profile.distinctExactGoalCount, 2);
  assert.equal(review.sourceEvidence.profile.distinctPolicyProfileCount, 3);
  assert.deepEqual(review.candidateTrialEvidence.profile.sourceRecordIds, [TRIAL_ONE, TRIAL_TWO]);
  assert.equal(review.candidateTrialEvidence.profile.verificationPassedCount, 1);
  assert.equal(review.candidateTrialEvidence.profile.totalToolErrors, 2);
  assert.equal(review.candidateTrialEvidence.profile.totalDeniedCalls, 1);
  assert.deepEqual(review.comparableCohorts, [{
    taskGoal: "same exact goal",
    sourceRecordIds: ["source-a", "source-b"],
    trialRecordIds: [TRIAL_ONE],
  }]);
  assert.equal(review.promotionEligibility.eligible, true);

  const report = formatStrategyDerivationTrialReview(readResult(records), review);
  assert.match(report, /Strategy Derivation Trial Review/);
  assert.match(report, new RegExp(`Candidate ID: ${CANDIDATE_ID}`));
  assert.match(report, /Cited source Experience IDs: source-a, source-b, source-c/);
  assert.match(report, /Derivation Source Evidence/);
  assert.match(report, /Candidate Trial Evidence/);
  assert.doesNotMatch(report, /Seed Baseline Evidence/);
  assert.match(report, /Verification passed: 1 · not passed: 1/);
  assert.match(report, /Candidate Trial records: trial-one/);
  assert.match(report, /no Strategy score, ranking, reward, superiority, novelty, usefulness, or causal claim/);
});

test("Derivation source provenance preserves negative outcomes and fails closed for cited problems", async () => {
  const value = candidate();
  const negative = source("source-a", experience("same exact goal", createPolicySnapshot({ approach: "direct-action" }), {
    verificationStatus: "failed",
    execution: execution({ toolErrors: 3, deniedCalls: 2 }),
  }));
  const noAttribution = source("source-b", experience("same exact goal", createPolicySnapshot({ approach: "direct-action" })));
  const malformed = { recordId: "source-c", experience: { schemaVersion: 4 } as never };
  const review = await deriveStrategyDerivationTrialReview(value, [negative, noAttribution, malformed], {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });
  assert.equal(review.sourceEvidence.records.length, 3);
  assert.equal(review.sourceEvidence.records.find((record) => record.recordId === "source-a")?.eligible, true);
  assert.equal(review.sourceEvidence.profile.verificationPassedCount, 0);
  assert.equal(review.sourceEvidence.profile.totalToolErrors, 3);
  assert.equal(review.sourceEvidence.records.find((record) => record.recordId === "source-b")?.eligible, true);
  assert.equal(review.sourceEvidence.records.find((record) => record.recordId === "source-c")?.eligible, false);
  assert.equal(review.sourceEvidence.provenanceValid, false);
  assert.deepEqual(review.sourceEvidence.invalidSourceRecordIds, ["source-c"]);
  assert.equal(review.promotionEligibility.eligible, false);
});

test("Source provenance and sufficiency remain separate factual gates", async () => {
  const value = candidate();
  const records = [
    source("source-a", experience("one exact goal", createPolicySnapshot({ approach: "direct-action" }))),
    source("source-b", experience("one exact goal", createPolicySnapshot({
      approach: "direct-action",
      modifiers: ["minimal-change"],
    }))),
    source("source-c", experience("one exact goal", createPolicySnapshot({ approach: "explore-first" }))),
  ];
  const review = await deriveStrategyDerivationTrialReview(value, records, {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });
  assert.equal(review.sourceEvidence.provenanceValid, true);
  assert.equal(review.sourceEvidence.sufficiency.sufficient, false);
  assert.equal(review.sourceEvidence.sufficiency.distinctEligibleExactGoalCount, 1);
  assert.equal(review.promotionEligibility.derivationSourceProvenanceValid, true);
  assert.equal(review.promotionEligibility.sourceSufficiencyValid, false);
  assert.equal(review.promotionEligibility.eligible, false);
});

test("Missing, one-goal, one-profile, and Trial-containing source sets remain visibly insufficient", async () => {
  const value = candidate();
  const samePolicy = createPolicySnapshot({ approach: "direct-action" });
  const trial = trialPolicy(value);
  const records = [
    source("source-a", experience("only goal", samePolicy)),
    source("source-b", experience("only goal", samePolicy)),
    source("source-c", experience("only goal", trial)),
  ];
  const review = await deriveStrategyDerivationTrialReview(value, records, {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });
  assert.equal(review.sourceEvidence.records.length, 3);
  assert.equal(review.sourceEvidence.records[2]?.eligible, false);
  assert.equal(review.sourceEvidence.sufficiency.distinctEligibleRecordCount, 2);
  assert.equal(review.sourceEvidence.sufficiency.distinctEligibleExactGoalCount, 1);
  assert.equal(review.sourceEvidence.sufficiency.distinctEligiblePolicyProfileCount, 1);
  assert.equal(review.sourceEvidence.provenanceValid, false);

  const missing = await deriveStrategyDerivationTrialReview(value, records.slice(0, 2), {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });
  assert.equal(missing.sourceEvidence.records.find((record) => record.recordId === "source-c")?.eligible, false);
  assert.match(missing.sourceEvidence.records.at(-1)?.reasons.join(" ") ?? "", /missing/i);
});

test("Exact Derivation Trial attribution requires identity, role, status, semantics, and real exposure", () => {
  const value = candidate();
  const valid = source(TRIAL_ONE, experience("goal", trialPolicy(value)));
  const late = source("late", experience("goal", trialPolicy(value), {
    finalPolicyLastDeclaredAfter: execution(),
  }));
  const records = [
    valid,
    source("wrong-id", experience("goal", trialPolicy(value, {
      revisionIdentity: "00000000-0000-4000-8000-000000000102",
    }))),
    source("wrong-fingerprint", experience("goal", trialPolicy(value, {
      revisionFingerprint: `sha256:${"0".repeat(64)}`,
    }))),
    source("promoted", experience("goal", trialPolicy(value, {
      revisionStatusAtRun: "promoted",
    }))),
    late,
  ];
  assert.equal(selectDerivationCandidateTrialEvidence(value, [valid]).length, 1);
  assert.equal(selectDerivationCandidateTrialEvidence(value, [late]).length, 0);
  assert.equal(selectDerivationCandidateTrialEvidence(value, records).length, 1);
});

test("Two valid Trials make the gate eligible only with a matching fresh portfolio", async () => {
  const value = candidate();
  const records = [
    ...sourceRecords(),
    source(TRIAL_ONE, experience("trial one", trialPolicy(value))),
    source(TRIAL_TWO, experience("trial two", trialPolicy(value))),
  ];
  const fresh = await deriveStrategyDerivationTrialReview(value, records, {
    projectRoot: "/repo",
    currentPortfolio: portfolio(),
  });
  assert.equal(fresh.promotionEligibility.eligible, true);
  assert.equal(fresh.promotionEligibility.currentPortfolioMatch, true);
  assert.equal(fresh.promotionEligibility.logicalStrategyIdAvailable, true);
  assert.equal(fresh.promotionEligibility.derivedStrategyCapacityAvailable, true);
  assert.equal(fresh.promotionEligibility.noPriorTerminalDecision, true);

  const stalePortfolio = createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([]),
  );
  const stale = await deriveStrategyDerivationTrialReview(value, records, {
    projectRoot: "/repo",
    currentPortfolio: {
      ...stalePortfolio,
      fingerprint: `sha256:${"f".repeat(64)}`,
    },
  });
  assert.equal(stale.promotionEligibility.currentPortfolioMatch, false);
  assert.equal(stale.promotionEligibility.eligible, false);
  assert.ok(stale.sourceEvidence.provenanceValid);
  assert.match(formatStrategyDerivationTrialReview(readResult(records), stale), /Current portfolio match: false/);
});

test("Derivation review revalidates the captured portfolio instead of current display labels", async () => {
  const value = candidate();
  const sourceOnly = sourceRecords();
  const changed = createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([]),
  );
  const review = await deriveStrategyDerivationTrialReview(value, sourceOnly, {
    projectRoot: "/repo",
    currentPortfolio: changed,
  });
  assert.equal(review.sourceEvidence.capturedBasePortfolioValid, true);
  assert.equal(review.sourceEvidence.provenanceValid, true);
  assert.equal(review.promotionEligibility.currentPortfolioMatch, true);
});

test("Review is fail-closed for an invalid captured promoted trust entry", async () => {
  const base = portfolio();
  const invalidEntry: TrustedPortfolioManifestEntry = {
    origin: "promoted-derived",
    strategyId: "future-derived",
    kind: "approach",
    revisionIdentity: "00000000-0000-4000-8000-000000000199",
    revisionFingerprint: `sha256:${"1".repeat(64)}`,
  };
  const entries = [invalidEntry, ...base.entries];
  const fakeResolved: TrustedPortfolioResolvedEntry[] = [
    ...base.resolvedEntries,
    {
      manifest: invalidEntry,
      semantics: {
        summary: "future",
        useWhen: ["future"],
        avoidWhen: [],
        principles: ["future"],
      },
    },
  ];
  const fake: TrustedStrategyPortfolio = {
    projectId: base.projectId,
    fingerprintVersion: 1,
    fingerprint: trustedPortfolioFingerprint(base.projectId, entries),
    entries,
    resolvedEntries: fakeResolved,
  };
  const value = candidate(fake);
  const review = await deriveStrategyDerivationTrialReview(value, sourceRecords(), {
    projectRoot: "/repo",
    currentPortfolio: fake,
  });
  assert.equal(review.sourceEvidence.capturedBasePortfolioValid, false);
  assert.equal(review.sourceEvidence.provenanceValid, false);
  assert.equal(review.promotionEligibility.candidateBindingValid, false);
});

// Keep the candidate fingerprint contract observable in this review-focused
// suite without introducing a second persisted review artifact.
assert.match(strategyDerivationCandidateSemanticFingerprint(candidate()), /^sha256:[0-9a-f]{64}$/);
assert.equal(getSeedStrategy("direct-action")?.kind, "approach");
