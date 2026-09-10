import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { composePindieExtension } from "../src/composition.ts";

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
  deriveStrategyTrustScopeTrialReview,
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
import {
  createStrategySynthesisDecision,
  FileStrategySynthesisDecisionStore,
  type StrategySynthesisDecisionReader,
  type StrategySynthesisDecisionV1,
} from "../src/strategy-synthesis-decisions.ts";
import {
  FileStrategySynthesisCandidateStore,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  type StrategySynthesisCandidateReader,
} from "../src/strategy-synthesis-candidates.ts";
import { makeSynthesisTrialFixture } from "./synthesis-trial-fixture.ts";
import { deriveStrategySynthesisTrialReview } from "../src/strategy-synthesis-review.ts";
import { loadUserGlobalTrustedDerivedStrategyProjection } from "../src/strategy-trust-scope-global.ts";

const SOURCE_ROOT = "/slice-d-source";
const TARGET_A_ROOT = "/slice-d-target-a";
const TARGET_B_ROOT = "/slice-d-target-b";
const SOURCE_CANDIDATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPE_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORD_A = "11111111-1111-4111-8111-111111111111.json";
const RECORD_B = "22222222-2222-4222-8222-222222222222.json";

function sourceFixture(
  strategyId = "scope-d-checkpoints",
  sourceCandidateId = SOURCE_CANDIDATE_ID,
  scopeCandidateId = SCOPE_CANDIDATE_ID,
) {
  const basePortfolio = createTrustedStrategyPortfolio(
    SOURCE_ROOT,
    createPromotedStrategyRevisionCatalog([]),
  );
  const candidate = createStrategyDerivationCandidate({
    projectId: basePortfolio.projectId,
    basePortfolio,
    candidateId: sourceCandidateId,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: {
      strategyId,
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
    candidateId: scopeCandidateId,
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

type SynthesisCandidate = Awaited<ReturnType<typeof makeSynthesisTrialFixture>>["candidate"];
type ScopeFixture = ReturnType<typeof sourceFixture>;

function synthesisAuthorityReaders(
  candidates: readonly SynthesisCandidate[],
  decisions: readonly StrategySynthesisDecisionV1[],
): {
  readonly candidateReader: StrategySynthesisCandidateReader;
  readonly decisionReader: StrategySynthesisDecisionReader;
} {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const decisionsById = new Map(decisions.map((decision) => [decision.candidateId, decision]));
  return {
    candidateReader: {
      read: async (candidateId) => candidatesById.get(candidateId) ?? null,
      readAll: async () => [...candidates],
    },
    decisionReader: {
      read: async (candidateId) => decisionsById.get(candidateId) ?? null,
      readAll: async () => [...decisions],
    },
  };
}

function scopeAuthorityReaders(
  fixtures: readonly ScopeFixture[],
  decisions: readonly StrategyTrustScopeDecisionV1[],
): {
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
} {
  const candidates = fixtures.map((fixture) => fixture.scopeCandidate);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const decisionsById = new Map(decisions.map((decision) => [decision.candidateId, decision]));
  return {
    candidateReader: {
      read: async (candidateId) => candidatesById.get(candidateId) ?? null,
      readAll: async () => [...candidates],
    },
    decisionReader: {
      read: async (candidateId) => decisionsById.get(candidateId) ?? null,
      readAll: async () => [...decisions],
    },
    sourceResolver: {
      resolve: async (sourceStrategy) => {
        const fixture = fixtures.find((item) =>
          item.sourceStrategy.sourceProjectId === sourceStrategy.sourceProjectId &&
          item.sourceStrategy.revisionIdentity === sourceStrategy.revisionIdentity);
        if (fixture === undefined) throw new Error("source Strategy fixture is unavailable");
        return {
          sourceStrategy,
          candidate: fixture.candidate,
          decision: fixture.decision,
          selection: fixture.selection,
          promotedDerivedCatalog: fixture.catalog,
        };
      },
    },
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

test("Slice E CPL-off reconstructs promoted Synthesis trust from real files and isolates Candidate corruption", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-slice-e-global-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const projectsBaseDir = join(baseDir, "projects");
  const globalBaseDir = join(baseDir, "global");
  const composition = composePindieExtension({
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    storageRoots: {
      projectsBaseDir,
      globalBaseDir,
      remoteRoutingBaseDir: join(baseDir, "remote"),
    },
  }, { env: {} });
  assert.equal(composition.featureSelection.crossProjectLearning, false);
  assert.equal(composition.extensionOptions.strategySynthesisCandidateStore, undefined);

  const { candidate } = await makeSynthesisTrialFixture(
    "00000000-0000-4000-8000-00000000006a",
    { strategyId: "slice-e-real-file-synthesis" },
  );
  const decision = createStrategySynthesisDecision({
    candidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId("/slice-e-trial-a"), RECORD_A, "a"),
      reference(getProjectId("/slice-e-trial-b"), RECORD_B, "b"),
    ],
    decidedAt: "2026-08-20T00:00:00.000Z",
  });
  const candidateStore = new FileStrategySynthesisCandidateStore({ baseDir: globalBaseDir });
  const decisionStore = new FileStrategySynthesisDecisionStore({ baseDir: globalBaseDir });
  await candidateStore.save(candidate);
  await decisionStore.save(decision);

  const candidatePath = join(candidateStore.candidateDirectory(), `${candidate.candidateId}.json`);
  const decisionPath = join(decisionStore.decisionDirectory(), `${decision.candidateId}.json`);
  const candidateText = await readFile(candidatePath, "utf8");
  const persistedCandidate = JSON.parse(candidateText) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persistedCandidate).sort(), [
    "candidateId",
    "candidateType",
    "createdAt",
    "derivationReceipt",
    "evidence",
    "hypothesis",
    "proposal",
    "schemaVersion",
  ]);
  const persistedDecision = JSON.parse(await readFile(decisionPath, "utf8")) as Record<string, unknown>;
  assert.equal(persistedDecision.schemaVersion, 1);
  assert.equal(persistedDecision.candidateArtifactFingerprint, strategySynthesisCandidateArtifactFingerprint(candidate));
  assert.equal(persistedDecision.candidateSemanticFingerprint, strategySynthesisCandidateSemanticFingerprint(candidate));

  const emptyScope = {
    candidateReader: { read: async () => null, readAll: async () => [] },
    decisionReader: { read: async () => null, readAll: async () => [] },
    sourceResolver: { resolve: async () => { throw new Error("no Scope authority in this test"); } },
  };
  const readProjection = () => loadUserGlobalTrustedDerivedStrategyProjection({
    candidateReader: emptyScope.candidateReader,
    decisionReader: emptyScope.decisionReader,
    sourceResolver: emptyScope.sourceResolver,
    synthesisCandidateReader: composition.extensionOptions.strategySynthesisCandidateReader!,
    synthesisDecisionReader: composition.extensionOptions.strategySynthesisDecisionReader!,
  });

  await mkdir(candidateStore.candidateDirectory(), { recursive: true });
  const unrelatedCandidateId = "00000000-0000-4000-8000-00000000006b";
  await writeFile(
    join(candidateStore.candidateDirectory(), `${unrelatedCandidateId}.json`),
    "{\"schemaVersion\":1}\n",
    "utf8",
  );
  const reconstructed = await readProjection();
  assert.equal(reconstructed.entries.length, 1);
  assert.equal(reconstructed.entries[0]?.origin, "synthesis");
  assert.deepEqual(reconstructed.entries[0]?.sourceProjectIds, []);
  assert.equal(reconstructed.selections[0]?.revisionIdentity, candidate.candidateId);

  await rm(candidatePath);
  await assert.rejects(readProjection(), /missing.*Candidate/i);
  await writeFile(candidatePath, candidateText, "utf8");

  await writeFile(candidatePath, "{\"schemaVersion\":1}\n", "utf8");
  await assert.rejects(readProjection(), /invalid|fields|Candidate/i);
  await writeFile(candidatePath, candidateText, "utf8");

  const mismatched = await makeSynthesisTrialFixture(
    candidate.candidateId,
    { strategyId: candidate.proposal.strategyId, summary: "A mismatched persisted revision." },
  );
  await writeFile(candidatePath, `${JSON.stringify(mismatched.candidate, null, 2)}\n`, "utf8");
  await assert.rejects(readProjection(), /binding|fingerprint|mismatch/i);
  await writeFile(candidatePath, candidateText, "utf8");
  assert.equal((await readProjection()).entries.length, 1);
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

test("Slice E transfer and Synthesis origins coexist in one normal global trust projection", async () => {
  const scope = decisionFixture();
  const scopeDecision = createStrategyTrustScopeDecision({
    candidate: scope.fixture.scopeCandidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId(TARGET_A_ROOT), RECORD_A, "a"),
      reference(getProjectId(TARGET_B_ROOT), RECORD_B, "b"),
    ],
    decidedAt: "2026-07-10T00:00:00.000Z",
  });
  const synthesis = await makeSynthesisTrialFixture(
    "00000000-0000-4000-8000-000000000050",
    { strategyId: "slice-e-independent-synthesis" },
  );
  const synthesisDecision = createStrategySynthesisDecision({
    candidate: synthesis.candidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId("/slice-e-synthesis-trial-a"), RECORD_A, "c"),
      reference(getProjectId("/slice-e-synthesis-trial-b"), RECORD_B, "d"),
    ],
    decidedAt: "2026-07-11T00:00:00.000Z",
  });
  const scopeAuthority = scopeAuthorityReaders([scope.fixture], [scopeDecision]);
  const synthesisAuthority = synthesisAuthorityReaders([synthesis.candidate], [synthesisDecision]);
  const projection = await loadUserGlobalTrustedDerivedStrategyProjection({
    candidateReader: scopeAuthority.candidateReader,
    decisionReader: scopeAuthority.decisionReader,
    sourceResolver: scopeAuthority.sourceResolver,
    synthesisCandidateReader: synthesisAuthority.candidateReader,
    synthesisDecisionReader: synthesisAuthority.decisionReader,
  });
  assert.deepEqual(
    projection.entries.map((entry) => entry.origin).sort(),
    ["synthesis", "transfer"],
  );
  const transfer = projection.entries.find((entry) => entry.origin === "transfer")!;
  const synthesized = projection.entries.find((entry) => entry.origin === "synthesis")!;
  const portfolio = createTrustedStrategyPortfolio(
    TARGET_A_ROOT,
    createPromotedStrategyRevisionCatalog([]),
    undefined,
    [
      {
        origin: "transfer",
        sourceProjectId: transfer.sourceProjectIds[0]!,
        selection: transfer.selection,
      },
      {
        origin: "synthesis",
        sourceProjectIds: [],
        selection: synthesized.selection,
      },
    ],
  );
  const transferEntry = portfolio.resolvedEntries.find((entry) => entry.manifest.strategyId === transfer.selection.strategyId)!;
  const synthesisEntry = portfolio.resolvedEntries.find((entry) => entry.manifest.strategyId === synthesized.selection.strategyId)!;
  assert.deepEqual(transferEntry.trust?.origins, ["user-global"]);
  assert.deepEqual(transferEntry.trust?.sourceProjectIds, [transfer.sourceProjectIds[0]]);
  assert.deepEqual(synthesisEntry.trust?.origins, ["user-global"]);
  assert.deepEqual(synthesisEntry.trust?.sourceProjectIds, []);
  assert.equal(
    resolveTrustedPortfolioRevisionSelection({
      strategyId: transfer.selection.strategyId,
      revisionIdentity: transfer.selection.revisionIdentity,
      revisionFingerprint: transfer.selection.revisionFingerprint,
    }, portfolio, transfer.selection.kind)?.revisionStatusAtRun,
    "promoted",
  );
  assert.equal(
    resolveTrustedPortfolioRevisionSelection({
      strategyId: synthesized.selection.strategyId,
      revisionIdentity: synthesized.selection.revisionIdentity,
      revisionFingerprint: synthesized.selection.revisionFingerprint,
    }, portfolio, synthesized.selection.kind)?.revisionStatusAtRun,
    "promoted",
  );
});

test("Scope and Synthesis reviews share bidirectional global logical-ID safety", async () => {
  const scope = decisionFixture();
  const scopeDecision = createStrategyTrustScopeDecision({
    candidate: scope.fixture.scopeCandidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId(TARGET_A_ROOT), RECORD_A, "a"),
      reference(getProjectId(TARGET_B_ROOT), RECORD_B, "b"),
    ],
    decidedAt: "2026-07-10T00:00:00.000Z",
  });
  const promotedScopeAuthority = scopeAuthorityReaders([scope.fixture], [scopeDecision]);
  const openScopeAuthority = scopeAuthorityReaders([scope.fixture], []);
  const synthesis = await makeSynthesisTrialFixture(
    "00000000-0000-4000-8000-000000000051",
    { strategyId: scope.fixture.sourceStrategy.strategyId },
  );
  const synthesisDecision = createStrategySynthesisDecision({
    candidate: synthesis.candidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId("/slice-d-synthesis-trial-a"), RECORD_A, "a"),
      reference(getProjectId("/slice-d-synthesis-trial-b"), RECORD_B, "b"),
    ],
    decidedAt: "2026-07-11T00:00:00.000Z",
  });
  const openSynthesisAuthority = synthesisAuthorityReaders([synthesis.candidate], []);
  const promotedSynthesisAuthority = synthesisAuthorityReaders([synthesis.candidate], [synthesisDecision]);

  const synthesisReview = await deriveStrategySynthesisTrialReview({
    candidate: synthesis.candidate,
    candidateReader: openSynthesisAuthority.candidateReader,
    decisionReader: openSynthesisAuthority.decisionReader,
    experienceReader: scope.experienceReader,
    projectTrustReader: scope.projectTrustReader,
    scopeCandidateReader: promotedScopeAuthority.candidateReader,
    scopeDecisionReader: promotedScopeAuthority.decisionReader,
    sourceResolver: promotedScopeAuthority.sourceResolver,
  });
  assert.equal(synthesisReview.globalStateComplete, true);
  assert.equal(synthesisReview.promotionEligibility.globalLogicalIdAvailable, false);
  assert.equal(synthesisReview.promotionEligibility.eligible, false);
  assert.match(synthesisReview.reasons.join(" "), /user-global logical Strategy ID is unavailable/i);

  const scopeReview = await deriveStrategyTrustScopeTrialReview({
    candidate: scope.fixture.scopeCandidate,
    candidateReader: openScopeAuthority.candidateReader,
    decisionReader: openScopeAuthority.decisionReader,
    sourceResolver: openScopeAuthority.sourceResolver,
    experienceReader: scope.experienceReader,
    projectTrustReader: scope.projectTrustReader,
    synthesisCandidateReader: promotedSynthesisAuthority.candidateReader,
    synthesisDecisionReader: promotedSynthesisAuthority.decisionReader,
  });
  assert.equal(scopeReview.globalStateComplete, true);
  assert.equal(scopeReview.promotionEligibility.globalLogicalIdAvailable, false);
  assert.equal(scopeReview.promotionEligibility.eligible, false);
  assert.match(scopeReview.reasons.join(" "), /user-global logical Strategy ID is unavailable/i);
});

test("Scope and Synthesis promotion reviews enforce the combined user-global capacity", async () => {
  const scope = decisionFixture();
  const promotedScopeDecision = createStrategyTrustScopeDecision({
    candidate: scope.fixture.scopeCandidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId(TARGET_A_ROOT), RECORD_A, "a"),
      reference(getProjectId(TARGET_B_ROOT), RECORD_B, "b"),
    ],
    decidedAt: "2026-07-12T00:00:00.000Z",
  });
  const promotedScopeAuthority = scopeAuthorityReaders([scope.fixture], [promotedScopeDecision]);
  const existingSynthesisCandidates: SynthesisCandidate[] = [];
  const existingSynthesisDecisions: StrategySynthesisDecisionV1[] = [];
  for (let index = 0; index < MAX_USER_GLOBAL_DERIVED_STRATEGIES - 1; index += 1) {
    const fixture = await makeSynthesisTrialFixture(
      `00000000-0000-4000-8000-${(0x60 + index).toString(16).padStart(12, "0")}`,
      { strategyId: `synthesis-capacity-${index}` },
    );
    existingSynthesisCandidates.push(fixture.candidate);
    existingSynthesisDecisions.push(createStrategySynthesisDecision({
      candidate: fixture.candidate,
      decision: "promoted",
      trialRefs: [
        reference(getProjectId(`/slice-d-capacity-a-${index}`), RECORD_A, "a"),
        reference(getProjectId(`/slice-d-capacity-b-${index}`), RECORD_B, "b"),
      ],
      decidedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    }));
  }
  const targetSynthesis = await makeSynthesisTrialFixture(
    "00000000-0000-4000-8000-000000000068",
    { strategyId: "synthesis-capacity-target" },
  );
  const synthesisWithTarget = synthesisAuthorityReaders(
    [...existingSynthesisCandidates, targetSynthesis.candidate],
    existingSynthesisDecisions,
  );
  const synthesisReview = await deriveStrategySynthesisTrialReview({
    candidate: targetSynthesis.candidate,
    candidateReader: synthesisWithTarget.candidateReader,
    decisionReader: synthesisWithTarget.decisionReader,
    experienceReader: scope.experienceReader,
    projectTrustReader: scope.projectTrustReader,
    scopeCandidateReader: promotedScopeAuthority.candidateReader,
    scopeDecisionReader: promotedScopeAuthority.decisionReader,
    sourceResolver: promotedScopeAuthority.sourceResolver,
  });
  assert.equal(synthesisReview.globalStateComplete, true);
  assert.equal(synthesisReview.promotionEligibility.globalLogicalIdAvailable, true);
  assert.equal(synthesisReview.promotionEligibility.userGlobalCapacityAvailable, false);
  assert.equal(synthesisReview.promotionEligibility.eligible, false);

  const existingScope = sourceFixture(
    "scope-d-capacity-existing",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
  const existingScopeDecision = createStrategyTrustScopeDecision({
    candidate: existingScope.scopeCandidate,
    decision: "promoted",
    trialRefs: [
      reference(getProjectId(TARGET_A_ROOT), RECORD_A, "c"),
      reference(getProjectId(TARGET_B_ROOT), RECORD_B, "d"),
    ],
    decidedAt: "2026-08-10T00:00:00.000Z",
  });
  const combinedScopeAuthority = scopeAuthorityReaders(
    [scope.fixture, existingScope],
    [existingScopeDecision],
  );
  const existingSynthesisAuthority = synthesisAuthorityReaders(
    existingSynthesisCandidates,
    existingSynthesisDecisions,
  );
  const scopeReview = await deriveStrategyTrustScopeTrialReview({
    candidate: scope.fixture.scopeCandidate,
    candidateReader: combinedScopeAuthority.candidateReader,
    decisionReader: combinedScopeAuthority.decisionReader,
    sourceResolver: combinedScopeAuthority.sourceResolver,
    experienceReader: scope.experienceReader,
    projectTrustReader: scope.projectTrustReader,
    synthesisCandidateReader: existingSynthesisAuthority.candidateReader,
    synthesisDecisionReader: existingSynthesisAuthority.decisionReader,
  });
  assert.equal(scopeReview.globalStateComplete, true);
  assert.equal(scopeReview.promotionEligibility.globalLogicalIdAvailable, true);
  assert.equal(scopeReview.promotionEligibility.userGlobalCapacityAvailable, false);
  assert.equal(scopeReview.promotionEligibility.eligible, false);
});
