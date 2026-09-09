import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import {
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createStrategyDerivationCandidate,
  strategyDerivationCandidateSemanticFingerprint,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import {
  createPromotedDerivedStrategyCatalog,
  createStrategyDerivationDecision,
  type StrategyDerivationDecisionV1,
} from "../src/strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  formatPromotedTrustedStrategyPortfolio,
  formatTrustedStrategyPortfolio,
  MAX_TRUSTED_PORTFOLIO_ENTRIES,
  resolveTrustedPortfolioRevisionSelection,
} from "../src/strategy-portfolio.ts";
import { MAX_USER_GLOBAL_DERIVED_STRATEGIES } from "../src/strategy-trust-scope-constants.ts";
import {
  buildScopeDecisionCommandProjection,
} from "../src/strategy-trust-scope-review.ts";
import {
  createStrategyTrustScopeCandidate,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeSourceStrategyV1,
} from "../src/strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionStore,
  type StrategyTrustScopeDecisionV1,
} from "../src/strategy-trust-scope-decisions.ts";
import {
  createStrategyTrustScopeDecisionForHuman,
} from "../src/strategy-trust-scope.ts";
import type { ScopeProjectTrustReader } from "../src/strategy-trust-scope-review.ts";
import type { StrategyTrustScopeSourceResolver } from "../src/strategy-trust-scope-resolution.ts";
import { getProjectId } from "../src/store.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

const SOURCE_ROOT = "/slice-d-source";
const TARGET_A_ROOT = "/slice-d-target-a";
const TARGET_B_ROOT = "/slice-d-target-b";
const SOURCE_CANDIDATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPE_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORD_A = "11111111-1111-4111-8111-111111111111.json";
const RECORD_B = "22222222-2222-4222-8222-222222222222.json";

function sourceFixture() {
  const basePortfolio = createTrustedStrategyPortfolio(
    SOURCE_ROOT,
    createPromotedStrategyRevisionCatalog([]),
  );
  const candidate = createStrategyDerivationCandidate({
    projectId: basePortfolio.projectId,
    basePortfolio,
    candidateId: SOURCE_CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: {
      strategyId: "scope-d-checkpoints",
      kind: "modifier",
      summary: "Keep implementation and delivery checks explicit and bounded.",
      useWhen: ["the work has several independent deliverables"],
      avoidWhen: ["the work is only exploratory discussion"],
      principles: ["separate checks", "keep the handoff bounded"],
      sourceRecordIds: ["source-one", "source-two", "source-three"],
      hypothesis: "Bounded checkpoints may make delivery work easier to close.",
    },
  });
  const decision = createStrategyDerivationDecision({
    candidate,
    decision: "promoted",
    trialRecordIds: ["source-trial-one", "source-trial-two"],
    decidedAt: "2026-07-02T00:00:00.000Z",
  });
  const selection = createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
    revisionStatusAtRun: "promoted",
    semantics: candidate.proposal,
  });
  const catalog = createPromotedDerivedStrategyCatalog([{
    candidate,
    decision,
    selection,
  }]);
  const sourceStrategy: StrategyTrustScopeSourceStrategyV1 = {
    sourceProjectId: candidate.projectId,
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
  };
  const scopeCandidate = createStrategyTrustScopeCandidate({
    sourceStrategy,
    candidateId: SCOPE_CANDIDATE_ID,
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  return { basePortfolio, candidate, decision, selection, catalog, sourceStrategy, scopeCandidate };
}

function globalReaders(
  fixture: ReturnType<typeof sourceFixture>,
  decision: StrategyTrustScopeDecisionV1 | null = null,
): {
  candidateReader: StrategyTrustScopeCandidateReader;
  decisionReader: StrategyTrustScopeDecisionReader;
  sourceResolver: StrategyTrustScopeSourceResolver;
} {
  return {
    candidateReader: {
      read: async (id) => id === fixture.scopeCandidate.candidateId ? fixture.scopeCandidate : null,
      readAll: async () => [fixture.scopeCandidate],
    },
    decisionReader: {
      read: async (id) => decision?.candidateId === id ? decision : null,
      readAll: async () => decision === null ? [] : [decision],
    },
    sourceResolver: {
      resolve: async (sourceStrategy) => ({
        sourceStrategy,
        candidate: fixture.candidate,
        decision: fixture.decision,
        selection: fixture.selection,
        promotedDerivedCatalog: fixture.catalog,
      }),
    },
  };
}

function reference(projectId: string, recordId: string, digit: string) {
  return {
    projectId,
    recordId,
    recordFingerprint: `sha256:${digit.repeat(64)}`,
  };
}

test("promoted user-global trust reconstructs after restart without historical Trial reads", async () => {
  const { loadUserGlobalTrustedDerivedStrategyProjection } = await import("../src/strategy-trust-scope-global.ts");
  const fixture = sourceFixture();
  const decision = createStrategyTrustScopeDecision({
    candidate: fixture.scopeCandidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId(TARGET_A_ROOT), RECORD_A, "a"),
      reference(getProjectId(TARGET_B_ROOT), RECORD_B, "b"),
    ],
    decidedAt: "2026-07-04T00:00:00.000Z",
  });
  const readers = globalReaders(fixture, decision);
  const projection = await loadUserGlobalTrustedDerivedStrategyProjection(readers);

  assert.equal(projection.entries.length, 1);
  assert.equal(projection.selections[0]?.revisionStatusAtRun, "promoted");
  assert.equal(projection.selections[0]?.revisionIdentity, SOURCE_CANDIDATE_ID);
  assert.deepEqual(projection.selections[0]?.semantics, {
    summary: fixture.candidate.proposal.summary,
    useWhen: fixture.candidate.proposal.useWhen,
    avoidWhen: fixture.candidate.proposal.avoidWhen,
    principles: fixture.candidate.proposal.principles,
  });
  assert.deepEqual(
    decision.evidence.trialRefs.map((ref) => ref.recordId).sort(),
    [RECORD_A, RECORD_B].sort(),
  );
  const targetPortfolio = createTrustedStrategyPortfolio(
    TARGET_A_ROOT,
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    [{ sourceProjectId: fixture.sourceStrategy.sourceProjectId, selection: projection.selections[0]! }],
  );
  const normal = resolveTrustedPortfolioRevisionSelection({
    strategyId: fixture.sourceStrategy.strategyId,
    revisionIdentity: fixture.sourceStrategy.revisionIdentity,
    revisionFingerprint: fixture.sourceStrategy.revisionFingerprint,
  }, targetPortfolio, "modifier");
  assert.equal(normal?.revisionStatusAtRun, "promoted");
  assert.doesNotThrow(() => projection.selections[0]);

  const malformed = globalReaders(fixture, {
    ...decision,
    sourceStrategy: { ...decision.sourceStrategy, strategyId: "wrong-id" },
  } as StrategyTrustScopeDecisionV1);
  await assert.rejects(
    loadUserGlobalTrustedDerivedStrategyProjection(malformed),
    /binding|Candidate|source/i,
  );
});

test("TrustedStrategyPortfolio deduplicates exact global/local identity, rejects conflicts, and derives bounds", () => {
  const fixture = sourceFixture();
  const localCatalog = fixture.catalog;
  const local = createTrustedStrategyPortfolio(SOURCE_ROOT, createPromotedStrategyRevisionCatalog([]), localCatalog);
  const combined = createTrustedStrategyPortfolio(
    SOURCE_ROOT,
    createPromotedStrategyRevisionCatalog([]),
    localCatalog,
    [{ sourceProjectId: fixture.sourceStrategy.sourceProjectId, selection: fixture.selection }],
  );
  assert.equal(combined.entries.length, local.entries.length);
  assert.equal(combined.fingerprint, local.fingerprint);
  const combinedEntry = combined.resolvedEntries.find((entry) => entry.manifest.strategyId === fixture.sourceStrategy.strategyId);
  assert.deepEqual(combinedEntry?.trust?.origins, ["user-global", "project-local"]);
  assert.deepEqual(combinedEntry?.trust?.sourceProjectIds, [fixture.sourceStrategy.sourceProjectId]);

  const alternate = createStrategyRevisionSelection({
    strategyId: fixture.sourceStrategy.strategyId,
    kind: fixture.sourceStrategy.kind,
    revisionIdentity: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    revisionFingerprint: `sha256:${"c".repeat(64)}`,
    revisionStatusAtRun: "promoted",
    semantics: { ...fixture.candidate.proposal, summary: "A conflicting revision." },
  });
  assert.throws(
    () => createTrustedStrategyPortfolio(
      TARGET_A_ROOT,
      createPromotedStrategyRevisionCatalog([]),
      createPromotedDerivedStrategyCatalog([{
        candidate: fixture.candidate,
        decision: fixture.decision,
        selection: fixture.selection,
      }]),
      [{ sourceProjectId: fixture.sourceStrategy.sourceProjectId, selection: alternate }],
    ),
    /duplicate|conflicting|logical Strategy/i,
  );

  const globals = Array.from({ length: MAX_USER_GLOBAL_DERIVED_STRATEGIES }, (_, index) => ({
    sourceProjectId: getProjectId(`/global-source-${index}`),
    selection: createStrategyRevisionSelection({
      strategyId: `global-derived-${index}`,
      kind: "approach",
      revisionIdentity: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      revisionFingerprint: `sha256:${index.toString(16).repeat(64)}`,
      revisionStatusAtRun: "promoted",
      semantics: {
        summary: `Global Strategy ${index}`,
        useWhen: ["the bounded case applies"],
        avoidWhen: [],
        principles: ["stay explicit"],
      },
    }),
  }));
  const bounded = createTrustedStrategyPortfolio(
    TARGET_B_ROOT,
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    globals,
  );
  assert.equal(bounded.entries.length, SEED_COUNT + MAX_USER_GLOBAL_DERIVED_STRATEGIES);
  assert.equal(MAX_TRUSTED_PORTFOLIO_ENTRIES, 30);
  assert.throws(
    () => createTrustedStrategyPortfolio(TARGET_B_ROOT, createPromotedStrategyRevisionCatalog([]), undefined, [
      ...globals,
      {
        sourceProjectId: getProjectId("/global-source-extra"),
        selection: createStrategyRevisionSelection({
          strategyId: "global-derived-extra",
          kind: "approach",
          revisionIdentity: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          revisionFingerprint: `sha256:${"d".repeat(64)}`,
          revisionStatusAtRun: "promoted",
          semantics: { summary: "extra", useWhen: ["extra"], avoidWhen: [], principles: ["extra"] },
        }),
      },
    ]),
    /capacity/i,
  );

  const list = formatTrustedStrategyPortfolio(combined);
  assert.match(list, /Trust: user-global \+ project-local/);
  assert.match(formatTrustedStrategyPortfolio(combined, fixture.sourceStrategy.strategyId), /Trust: user-global \+ project-local/);
  assert.match(formatPromotedTrustedStrategyPortfolio(combined), /user-global/);
  assert.match(formatPromotedTrustedStrategyPortfolio(combined), /Revision status: promoted/);
});

const SEED_COUNT = 7;

function trialExperience(
  fixture: ReturnType<typeof sourceFixture>,
  recordedAt: string,
): RunExperience {
  const trialSelection = createStrategyRevisionSelection({
    strategyId: fixture.candidate.proposal.strategyId,
    kind: fixture.candidate.proposal.kind,
    revisionIdentity: fixture.candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(fixture.candidate),
    revisionStatusAtRun: "trial",
    semantics: fixture.candidate.proposal,
  });
  const policy = createPolicySnapshotFromRevisions({
    approach: "direct-action",
    modifiers: [trialSelection],
  });
  const task: NonNullable<PindieState["task"]> = {
    goal: "Scope Trial",
    constraints: [],
    successCriteria: [{ id: "c1", description: "The check is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
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
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  const value = assembleRunExperience({
    task,
    runStart: { taskStatus: "active", taskGoal: task.goal },
    snapshot,
    policy: {
      finalSnapshot: policy,
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
  const parsed = parseRunExperience(value);
  assert.ok(parsed);
  return parsed;
}

function decisionFixture(boundaryChange = false) {
  const fixture = sourceFixture();
  const candidateReader: StrategyTrustScopeCandidateReader = {
    read: async (id) => id === fixture.scopeCandidate.candidateId ? fixture.scopeCandidate : null,
    readAll: async () => [fixture.scopeCandidate],
  };
  const saved: StrategyTrustScopeDecisionV1[] = [];
  const decisionStore: StrategyTrustScopeDecisionStore = {
    read: async (id) => saved.find((decision) => decision.candidateId === id) ?? null,
    readAll: async () => [...saved],
    save: async (decision) => {
      if (saved.some((item) => item.candidateId === decision.candidateId)) throw new Error("terminal Decision exists");
      saved.push(decision);
    },
  };
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async (sourceStrategy) => ({
      sourceStrategy,
      candidate: fixture.candidate,
      decision: fixture.decision,
      selection: fixture.selection,
      promotedDerivedCatalog: fixture.catalog,
    }),
  };
  const projectIds = [SOURCE_ROOT, TARGET_A_ROOT, TARGET_B_ROOT].map(getProjectId).sort();
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [getProjectId(SOURCE_ROOT), []],
    [getProjectId(TARGET_A_ROOT), [{ recordId: RECORD_A, experience: trialExperience(fixture, "2026-07-04T00:00:00.000Z") }]],
    [getProjectId(TARGET_B_ROOT), [{ recordId: RECORD_B, experience: trialExperience(fixture, "2026-07-05T00:00:00.000Z") }]],
  ]);
  const readCounts = new Map<string, number>();
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => [...projectIds],
    readProjectId: async (projectId): Promise<RunExperienceReadResult> => {
      const count = (readCounts.get(projectId) ?? 0) + 1;
      readCounts.set(projectId, count);
      let projectRecords = records.get(projectId) ?? [];
      if (boundaryChange && projectId === getProjectId(TARGET_A_ROOT) && count >= 3) {
        projectRecords = [{ recordId: RECORD_A, experience: trialExperience(fixture, "2026-07-06T00:00:00.000Z") }];
      }
      return { records: projectRecords, loadedRecords: projectRecords.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const projectTrustReader: ScopeProjectTrustReader = {
    readProjectId: async (projectId) => ({ projectId, promotedDerived: [] }),
  };
  let lockCalls = 0;
  const writerLock = {
    withLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      lockCalls += 1;
      return operation();
    },
  };
  return {
    fixture,
    candidateReader,
    decisionStore,
    sourceResolver,
    experienceReader,
    projectTrustReader,
    writerLock,
    saved,
    get lockCalls() { return lockCalls; },
  };
}

test("Scope promote/reject completion is namespaced and Human promotion writes one immutable terminal Decision", async () => {
  const value = decisionFixture();
  const rejectProjection = await buildScopeDecisionCommandProjection({
    command: "reject",
    candidateReader: value.candidateReader,
    decisionReader: value.decisionStore,
    sourceResolver: value.sourceResolver,
  });
  assert.deepEqual(rejectProjection.options.map((option) => option.value), [`scope:${SCOPE_CANDIDATE_ID}`]);
  assert.match(rejectProjection.options[0]!.label, /rejection is not falsification/);

  const promoteProjection = await buildScopeDecisionCommandProjection({
    command: "promote",
    candidateReader: value.candidateReader,
    decisionReader: value.decisionStore,
    sourceResolver: value.sourceResolver,
    experienceReader: value.experienceReader,
    projectTrustReader: value.projectTrustReader,
    currentProjectRoot: TARGET_A_ROOT,
  });
  assert.deepEqual(promoteProjection.options.map((option) => option.value), [`scope:${SCOPE_CANDIDATE_ID}`]);
  assert.match(promoteProjection.options[0]!.label, /user-global trust eligible/);

  const result = await createStrategyTrustScopeDecisionForHuman({
    candidateId: SCOPE_CANDIDATE_ID,
    decision: "promoted",
    decidedAt: "2026-07-07T00:00:00.000Z",
    currentProjectRoot: TARGET_A_ROOT,
  }, {
    candidateReader: value.candidateReader,
    decisionStore: value.decisionStore,
    sourceResolver: value.sourceResolver,
    writerLock: value.writerLock,
    experienceReader: value.experienceReader,
    projectTrustReader: value.projectTrustReader,
  });
  assert.equal(result.decision.decision, "promoted");
  assert.equal(result.decision.evidence.trialRefs.length, 2);
  assert.equal(value.saved.length, 1);
  assert.equal(value.lockCalls, 1);
  await assert.rejects(
    createStrategyTrustScopeDecisionForHuman({ candidateId: SCOPE_CANDIDATE_ID, decision: "promoted" }, {
      candidateReader: value.candidateReader,
      decisionStore: value.decisionStore,
      sourceResolver: value.sourceResolver,
      writerLock: value.writerLock,
      experienceReader: value.experienceReader,
      projectTrustReader: value.projectTrustReader,
    }),
    /terminal|replacement/i,
  );
  assert.equal(value.saved.length, 1);
});

test("Scope promotion rejects changed boundary evidence without writing, while rejection needs no evidence gate", async () => {
  const stale = decisionFixture(true);
  await assert.rejects(
    createStrategyTrustScopeDecisionForHuman({
      candidateId: SCOPE_CANDIDATE_ID,
      decision: "promoted",
      decidedAt: "2026-07-08T00:00:00.000Z",
    }, {
      candidateReader: stale.candidateReader,
      decisionStore: stale.decisionStore,
      sourceResolver: stale.sourceResolver,
      writerLock: stale.writerLock,
      experienceReader: stale.experienceReader,
      projectTrustReader: stale.projectTrustReader,
    }),
    /Eligibility|changed|fingerprint|resolv/i,
  );
  assert.equal(stale.saved.length, 0);
  assert.equal(stale.lockCalls, 1);

  const rejected = decisionFixture();
  const result = await createStrategyTrustScopeDecisionForHuman({
    candidateId: SCOPE_CANDIDATE_ID,
    decision: "rejected",
    decidedAt: "2026-07-09T00:00:00.000Z",
  }, {
    candidateReader: rejected.candidateReader,
    decisionStore: rejected.decisionStore,
    sourceResolver: rejected.sourceResolver,
    writerLock: rejected.writerLock,
  });
  assert.equal(result.decision.decision, "rejected");
  assert.deepEqual(result.decision.evidence.trialRefs, []);
  assert.equal(rejected.saved.length, 1);
});
