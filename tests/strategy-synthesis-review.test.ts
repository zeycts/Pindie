import assert from "node:assert/strict";
import test from "node:test";

import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import { scanCrossProjectTrialEvidence } from "../src/cross-project-trial-validation.ts";
import {
  assembleRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import {
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";
import { getProjectId } from "../src/store.ts";
import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  createTrustedStrategyPortfolioForProjectId,
  resolveTrustedPortfolioRevisionSelection,
} from "../src/strategy-portfolio.ts";
import {
  createStrategySynthesisDecision,
  readSynthesisTrustedGlobalArtifacts,
  type StrategySynthesisDecisionReader,
  type StrategySynthesisDecisionStore,
  type StrategySynthesisDecisionV1,
} from "../src/strategy-synthesis-decisions.ts";
import {
  strategySynthesisCandidateSemanticFingerprint,
  type StrategySynthesisCandidateReader,
  type StrategySynthesisCandidateV1,
} from "../src/strategy-synthesis-candidates.ts";
import {
  createStrategySynthesisDecisionForHuman,
  deriveStrategySynthesisTrialReview,
  type StrategySynthesisTrialReviewInput,
} from "../src/strategy-synthesis-review.ts";
import {
  loadUserGlobalTrustedDerivedStrategyProjection,
} from "../src/strategy-trust-scope-global.ts";
import type {
  ScopeProjectTrustReader,
  ScopeProjectTrustSnapshot,
} from "../src/strategy-trust-scope-review.ts";
import type { StrategyTrustScopeSourceResolver } from "../src/strategy-trust-scope-resolution.ts";
import type { GlobalWriterLock } from "../src/store.ts";
import { makeSynthesisTrialFixture } from "./synthesis-trial-fixture.ts";

const TRIAL_PROJECT_NEW = getProjectId("/synthesis-review-new-trial");
const TRIAL_RECORD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json";
const TRIAL_RECORD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "criterion", description: "The review remains factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function trialExperience(
  candidate: StrategySynthesisCandidateV1,
  goal: string,
  recordedAt: string,
): RunExperience {
  const selection = createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
    revisionStatusAtRun: "trial",
    semantics: {
      summary: candidate.proposal.summary,
      useWhen: candidate.proposal.useWhen,
      avoidWhen: candidate.proposal.avoidWhen,
      principles: candidate.proposal.principles,
    },
  });
  const zero = {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  } as const;
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
  return assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot,
    policy: {
      finalSnapshot: createPolicySnapshotFromRevisions({ approach: selection }),
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: zero,
      finalPolicyLastDeclaredAfter: zero,
    },
    execution: { ...zero, toolCalls: 3, observations: 1, consequentialCalls: 2 },
    durationMs: 10,
    cost: 0,
    recordedAt,
  });
}

function emptyScopeSourceResolver(): StrategyTrustScopeSourceResolver {
  return {
    resolve: async () => {
      throw new Error("no transfer-origin artifacts are present in this fixture");
    },
  };
}

function reviewFixture(
  candidate: StrategySynthesisCandidateV1,
  records: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>,
  projectIds: readonly string[],
  decisions: readonly StrategySynthesisDecisionV1[] = [],
  projectTrustByProject: ReadonlyMap<string, ScopeProjectTrustSnapshot["promotedDerived"]> = new Map(),
) {
  const candidateReader: StrategySynthesisCandidateReader = {
    read: async (candidateId) => candidateId === candidate.candidateId ? candidate : null,
    readAll: async () => [candidate],
  };
  const decisionReader: StrategySynthesisDecisionReader = {
    read: async (candidateId) => decisions.find((decision) => decision.candidateId === candidateId) ?? null,
    readAll: async () => [...decisions],
  };
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => [...projectIds],
    readProjectId: async (projectId): Promise<RunExperienceReadResult> => {
      const projectRecords = records.get(projectId) ?? [];
      return {
        records: projectRecords,
        loadedRecords: projectRecords.length,
        unsupportedSchema: 0,
        invalid: 0,
      };
    },
  };
  const projectTrustReader: ScopeProjectTrustReader = {
    readProjectId: async (projectId) => ({
      projectId,
      promotedDerived: projectTrustByProject.get(projectId) ?? [],
    }),
  };
  return {
    candidateReader,
    decisionReader,
    experienceReader,
    projectTrustReader,
    sourceResolver: emptyScopeSourceResolver(),
    input: {
      candidate,
      candidateReader,
      decisionReader,
      experienceReader,
      projectTrustReader,
    } satisfies StrategySynthesisTrialReviewInput,
  };
}

function decisionFixture(
  candidate: StrategySynthesisCandidateV1,
  records: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>,
  projectIds: readonly string[],
  decisions: StrategySynthesisDecisionV1[] = [],
) {
  const review = reviewFixture(candidate, records, projectIds, decisions);
  const decisionStore: StrategySynthesisDecisionStore = {
    read: async (candidateId) => decisions.find((decision) => decision.candidateId === candidateId) ?? null,
    readAll: async () => [...decisions],
    save: async (decision) => {
      if (decisions.some((existing) => existing.candidateId === decision.candidateId)) {
        throw new Error("terminal Decision exists");
      }
      decisions.push(decision);
    },
  };
  let lockCalls = 0;
  const writerLock: GlobalWriterLock = {
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return operation();
    },
  };
  return {
    ...review,
    decisionStore,
    writerLock,
    decisions,
    get lockCalls() { return lockCalls; },
  };
}

function emptyTransferReaders() {
  return {
    candidateReader: {
      read: async () => null,
      readAll: async () => [],
    },
    decisionReader: {
      read: async () => null,
      readAll: async () => [],
    },
    sourceResolver: emptyScopeSourceResolver(),
  };
}

test("Synthesis review validates exact Trial evidence and shows discovery overlap without excluding it", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000041");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [discoveryProject, [{
      recordId: TRIAL_RECORD_A,
      experience: trialExperience(candidate, "trial in a discovery project", "2026-02-01T00:00:00.000Z"),
    }]],
    [TRIAL_PROJECT_NEW, [{
      recordId: TRIAL_RECORD_B,
      experience: trialExperience(candidate, "trial in a new project", "2026-02-02T00:00:00.000Z"),
    }]],
  ]);
  const fixture = reviewFixture(candidate, records, [discoveryProject, TRIAL_PROJECT_NEW]);

  const review = await deriveStrategySynthesisTrialReview(fixture.input);

  assert.equal(review.promotionEligibility.eligible, true);
  assert.equal(review.promotionEligibility.projectLocalConflictFree, true);
  assert.equal(review.eligibleTrialRunCount, 2);
  assert.equal(review.distinctEligibleTrialProjectCount, 2);
  assert.deepEqual(review.discoverySourceProjectIds, [
    ...new Set(candidate.evidence.sourceRefs.map((ref) => ref.projectId)),
  ].sort());
  assert.deepEqual(review.overlappingProjectIds, [discoveryProject]);
  assert.deepEqual(review.newlyRepresentedTrialProjectIds, [TRIAL_PROJECT_NEW]);
  assert.equal(review.selectedEvidenceRefs.length, 2);
  assert.equal(review.selectedEvidenceRefsValid, true);
  assert.equal(review.evidenceScanComplete, true);
});

test("Synthesis Promotion rejects a project-local owner with a different revision", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000048");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [discoveryProject, [{
      recordId: TRIAL_RECORD_A,
      experience: trialExperience(candidate, "local collision trial one", "2026-07-01T00:00:00.000Z"),
    }]],
    [TRIAL_PROJECT_NEW, [{
      recordId: TRIAL_RECORD_B,
      experience: trialExperience(candidate, "local collision trial two", "2026-07-02T00:00:00.000Z"),
    }]],
  ]);
  const localOwner: ScopeProjectTrustSnapshot["promotedDerived"][number] = {
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: "different-promoted-revision",
    revisionFingerprint: `sha256:${"d".repeat(64)}`,
  };
  const fixture = reviewFixture(
    candidate,
    records,
    [discoveryProject, TRIAL_PROJECT_NEW],
    [],
    new Map([[discoveryProject, [localOwner]]]),
  );

  const review = await deriveStrategySynthesisTrialReview(fixture.input);

  assert.equal(review.promotionEligibility.eligible, false);
  assert.equal(review.promotionEligibility.projectLocalConflictFree, false);
  assert.match(
    review.reasons.join(" "),
    new RegExp(`project ${discoveryProject.slice(0, 8)} owns logical Strategy ID '${candidate.proposal.strategyId}'`),
  );
});

test("Synthesis Promotion rejects a project-local owner with the exact candidate revision", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000049");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [discoveryProject, [{
      recordId: TRIAL_RECORD_A,
      experience: trialExperience(candidate, "exact local collision trial one", "2026-08-01T00:00:00.000Z"),
    }]],
    [TRIAL_PROJECT_NEW, [{
      recordId: TRIAL_RECORD_B,
      experience: trialExperience(candidate, "exact local collision trial two", "2026-08-02T00:00:00.000Z"),
    }]],
  ]);
  const exactLocalOwner: ScopeProjectTrustSnapshot["promotedDerived"][number] = {
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
  };
  const fixture = reviewFixture(
    candidate,
    records,
    [discoveryProject, TRIAL_PROJECT_NEW],
    [],
    new Map([[discoveryProject, [exactLocalOwner]]]),
  );

  const review = await deriveStrategySynthesisTrialReview(fixture.input);

  assert.equal(review.promotionEligibility.eligible, false);
  assert.equal(review.promotionEligibility.projectLocalConflictFree, false);
  assert.match(
    review.reasons.join(" "),
    new RegExp(`project ${discoveryProject.slice(0, 8)} owns logical Strategy ID '${candidate.proposal.strategyId}'`),
  );
});

test("Synthesis Human Decisions are terminal, lock-protected, and reconcile an ambiguous immutable promotion write", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000042");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [discoveryProject, [{
      recordId: TRIAL_RECORD_A,
      experience: trialExperience(candidate, "promotion trial one", "2026-03-01T00:00:00.000Z"),
    }]],
    [TRIAL_PROJECT_NEW, [{
      recordId: TRIAL_RECORD_B,
      experience: trialExperience(candidate, "promotion trial two", "2026-03-02T00:00:00.000Z"),
    }]],
  ]);
  const fixture = decisionFixture(candidate, records, [discoveryProject, TRIAL_PROJECT_NEW]);
  const originalSave = fixture.decisionStore.save;
  let firstSave = true;
  const ambiguousStore: StrategySynthesisDecisionStore = {
    read: fixture.decisionStore.read,
    readAll: fixture.decisionStore.readAll,
    save: async (decision) => {
      await originalSave(decision);
      if (firstSave) {
        firstSave = false;
        throw new Error("persisted before transport failure");
      }
    },
  };

  const result = await createStrategySynthesisDecisionForHuman({
    candidateId: candidate.candidateId,
    decision: "promoted",
    decidedAt: "2026-03-03T00:00:00.000Z",
  }, {
    ...fixture.input,
    writerLock: fixture.writerLock,
    decisionStore: ambiguousStore,
  });

  assert.equal(result.decision.decision, "promoted");
  assert.equal(result.decision.evidence.trialRefs.length, 2);
  assert.equal(fixture.decisions.length, 1);
  assert.equal(fixture.lockCalls, 1);
  await assert.rejects(
    createStrategySynthesisDecisionForHuman({
      candidateId: candidate.candidateId,
      decision: "rejected",
      decidedAt: "2026-03-04T00:00:00.000Z",
    }, {
      ...fixture.input,
      writerLock: fixture.writerLock,
      decisionStore: fixture.decisionStore,
    }),
    /terminal|replacement/i,
  );
  assert.equal(fixture.decisions.length, 1);
});

test("Synthesis rejection is terminal without a Trial gate, while promoted trust projects through both portfolio addressing paths", async () => {
  const rejected = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000043");
  const rejectedFixture = decisionFixture(
    rejected.candidate,
    new Map(),
    [],
  );
  const rejection = await createStrategySynthesisDecisionForHuman({
    candidateId: rejected.candidate.candidateId,
    decision: "rejected",
    decidedAt: "2026-04-01T00:00:00.000Z",
  }, {
    ...rejectedFixture.input,
    writerLock: rejectedFixture.writerLock,
    decisionStore: rejectedFixture.decisionStore,
  });
  assert.equal(rejection.decision.decision, "rejected");
  assert.deepEqual(rejection.decision.evidence.trialRefs, []);

  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000044");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const refs = [
    {
      projectId: discoveryProject,
      recordId: TRIAL_RECORD_A,
      recordFingerprint: `sha256:${"a".repeat(64)}`,
    },
    {
      projectId: TRIAL_PROJECT_NEW,
      recordId: TRIAL_RECORD_B,
      recordFingerprint: `sha256:${"b".repeat(64)}`,
    },
  ] as const;
  const promoted = createStrategySynthesisDecision({
    candidate,
    decision: "promoted",
    trialRefs: refs,
    decidedAt: "2026-04-02T00:00:00.000Z",
  });
  const synthesisCandidateReader: StrategySynthesisCandidateReader = {
    read: async (candidateId) => candidateId === candidate.candidateId ? candidate : null,
    readAll: async () => [candidate],
  };
  const synthesisDecisionReader: StrategySynthesisDecisionReader = {
    read: async (candidateId) => candidateId === candidate.candidateId ? promoted : null,
    readAll: async () => [promoted],
  };
  const projection = await loadUserGlobalTrustedDerivedStrategyProjection({
    ...emptyTransferReaders(),
    synthesisCandidateReader,
    synthesisDecisionReader,
  });

  assert.equal(projection.entries.length, 1);
  assert.equal(projection.entries[0]?.origin, "synthesis");
  assert.deepEqual(projection.entries[0]?.sourceProjectIds, []);
  assert.equal(projection.selections[0]?.revisionIdentity, candidate.candidateId);
  assert.equal(projection.selections[0]?.revisionStatusAtRun, "promoted");

  const rootPortfolio = createTrustedStrategyPortfolio(
    "/synthesis-review-root",
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    [{ origin: "synthesis", sourceProjectIds: [], selection: projection.selections[0]! }],
  );
  const projectIdPortfolio = createTrustedStrategyPortfolioForProjectId(
    getProjectId("/synthesis-review-root"),
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    [{ origin: "synthesis", sourceProjectIds: [], selection: projection.selections[0]! }],
  );
  for (const portfolio of [rootPortfolio, projectIdPortfolio]) {
    const resolved = resolveTrustedPortfolioRevisionSelection({
      strategyId: candidate.proposal.strategyId,
      revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
    }, portfolio, candidate.proposal.kind);
    assert.equal(resolved?.revisionStatusAtRun, "promoted");
    assert.equal(resolved?.revisionIdentity, candidate.candidateId);
  }
});

test("normal trusted Synthesis reconstruction ignores rejected Candidate authority and fails closed for promoted authority", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000045");
  const rejected = createStrategySynthesisDecision({
    candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-04-03T00:00:00.000Z",
  });
  const rejectedArtifacts = await readSynthesisTrustedGlobalArtifacts(
    {
      read: async () => ({ malformed: true } as unknown as StrategySynthesisCandidateV1),
      readAll: async () => [{ malformed: true } as unknown as StrategySynthesisCandidateV1],
    },
    {
      read: async () => rejected,
      readAll: async () => [rejected],
    },
  );
  assert.deepEqual(rejectedArtifacts.decisions, [rejected]);
  assert.deepEqual(rejectedArtifacts.candidates, []);

  const promoted = createStrategySynthesisDecision({
    candidate,
    decision: "promoted",
    trialRefs: [
      {
        projectId: getProjectId("/synthesis-review-promoted-a"),
        recordId: TRIAL_RECORD_A,
        recordFingerprint: `sha256:${"a".repeat(64)}`,
      },
      {
        projectId: getProjectId("/synthesis-review-promoted-b"),
        recordId: TRIAL_RECORD_B,
        recordFingerprint: `sha256:${"b".repeat(64)}`,
      },
    ],
    decidedAt: "2026-04-04T00:00:00.000Z",
  });
  await assert.rejects(
    readSynthesisTrustedGlobalArtifacts(
      {
        read: async () => ({
          ...candidate,
          proposal: { ...candidate.proposal, summary: "corrupted authority" },
        } as StrategySynthesisCandidateV1),
        readAll: async () => [],
      },
      {
        read: async () => promoted,
        readAll: async () => [promoted],
      },
    ),
    /binding|fingerprint/i,
  );
});

test("Synthesis promotion fails closed when a terminal Decision appears after its initial scan", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000046");
  const discoveryProject = candidate.evidence.sourceRefs[0]!.projectId;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [discoveryProject, [{
      recordId: TRIAL_RECORD_A,
      experience: trialExperience(candidate, "race trial one", "2026-05-01T00:00:00.000Z"),
    }]],
    [TRIAL_PROJECT_NEW, [{
      recordId: TRIAL_RECORD_B,
      experience: trialExperience(candidate, "race trial two", "2026-05-02T00:00:00.000Z"),
    }]],
  ]);
  const fixture = decisionFixture(candidate, records, [discoveryProject, TRIAL_PROJECT_NEW]);
  const terminal = createStrategySynthesisDecision({
    candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-05-03T00:00:00.000Z",
  });
  let readAllCalls = 0;
  let saveCalls = 0;
  const racingStore: StrategySynthesisDecisionStore = {
    read: async (candidateId) => candidateId === candidate.candidateId ? terminal : null,
    readAll: async () => {
      readAllCalls += 1;
      return readAllCalls === 1 ? [] : [terminal];
    },
    save: async () => {
      saveCalls += 1;
      throw new Error("unexpected terminal write");
    },
  };

  await assert.rejects(
    createStrategySynthesisDecisionForHuman({
      candidateId: candidate.candidateId,
      decision: "promoted",
      decidedAt: "2026-05-04T00:00:00.000Z",
    }, {
      ...fixture.input,
      decisionReader: racingStore,
      decisionStore: racingStore,
      writerLock: fixture.writerLock,
    }),
    /Eligibility|terminal|no Decision/i,
  );
  assert.equal(saveCalls, 0);
  assert.equal(fixture.decisions.length, 0);
  assert.ok(readAllCalls >= 2);
});

test("shared Trial ref selection preserves one eligible project witness before deterministic extras", async () => {
  const { candidate } = await makeSynthesisTrialFixture("00000000-0000-4000-8000-000000000047");
  const projectA = getProjectId("/synthesis-ref-selection-a");
  const projectB = getProjectId("/synthesis-ref-selection-b");
  const recordsByProject = new Map<string, readonly RunExperienceSourceRecord[]>([
    [projectA, [
      { recordId: "11111111-1111-4111-8111-111111111111.json", experience: trialExperience(candidate, "many A one", "2026-06-01T00:00:00.000Z") },
      { recordId: "22222222-2222-4222-8222-222222222222.json", experience: trialExperience(candidate, "many A two", "2026-06-02T00:00:00.000Z") },
      { recordId: "33333333-3333-4333-8333-333333333333.json", experience: trialExperience(candidate, "many A three", "2026-06-03T00:00:00.000Z") },
    ]],
    [projectB, [{
      recordId: "44444444-4444-4444-8444-444444444444.json",
      experience: trialExperience(candidate, "one B", "2026-06-04T00:00:00.000Z"),
    }]],
  ]);
  const reader = (projectIds: readonly string[], reverseRecords: boolean): RunExperienceProjectReader => ({
    listProjectIds: async () => [...projectIds],
    readProjectId: async (projectId) => {
      const records = [...(recordsByProject.get(projectId) ?? [])];
      if (reverseRecords) records.reverse();
      return {
        records,
        loadedRecords: records.length,
        unsupportedSchema: 0,
        invalid: 0,
      };
    },
  });
  const subject = {
    origin: "synthesis" as const,
    subjectId: candidate.candidateId,
    strategy: {
      strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind,
      revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategySynthesisCandidateSemanticFingerprint(candidate),
      semantics: {
        summary: candidate.proposal.summary,
        useWhen: [...candidate.proposal.useWhen],
        avoidWhen: [...candidate.proposal.avoidWhen],
        principles: [...candidate.proposal.principles],
      },
    },
    excludedTrialProjectIds: [],
    minimumTrialRecordedAt: candidate.createdAt,
  };
  const first = await scanCrossProjectTrialEvidence({
    subject,
    experienceReader: reader([projectB, projectA], false),
    maxSelectedRefs: 2,
  });
  const reordered = await scanCrossProjectTrialEvidence({
    subject,
    experienceReader: reader([projectA, projectB], true),
    maxSelectedRefs: 2,
  });

  assert.equal(first.selectedEvidenceRefs.length, 2);
  assert.deepEqual(
    new Set(first.selectedEvidenceRefs.map((ref) => ref.projectId)),
    new Set([projectA, projectB]),
  );
  assert.deepEqual(
    new Set(first.selectedEvidenceRefs.map((ref) => ref.recordId)),
    new Set([
      "11111111-1111-4111-8111-111111111111.json",
      "44444444-4444-4444-8444-444444444444.json",
    ]),
  );
  assert.deepEqual(first.selectedEvidenceRefs, reordered.selectedEvidenceRefs);
});
