import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCrossProjectSynthesisPacket,
  formatCrossProjectSynthesisPacket,
  MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS,
  MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT,
  MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH,
  deriveCrossProjectSynthesisSufficiency,
  recomputeCrossProjectSynthesisPacketSufficiency,
  scanCrossProjectSynthesisEvidence,
  selectBoundedCrossProjectSynthesisEvidence,
  type CrossProjectSynthesisPacket,
  validateCrossProjectSynthesisPacket,
} from "../src/cross-project-synthesis.ts";
import {
  createCrossProjectExperienceRef,
  resolveCrossProjectExperienceRef,
} from "../src/cross-project-experience.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import { evaluateRunExperience } from "../src/experience-evaluation.ts";
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
import {
  createPromotedStrategyRevisionCatalog,
  createStrategyRevisionDecision,
  FileStrategyDecisionStore,
} from "../src/strategy-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  createTrustedStrategyPortfolioForProjectId,
  type TrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import {
  createStrategyRevisionCandidate,
  FileStrategyCandidateStore,
  strategyRevisionSelectionFromCandidate,
} from "../src/strategy-candidates.ts";
import {
  createStrategyDerivationCandidate,
  FileStrategyDerivationCandidateStore,
  strategyDerivationCandidateSemanticFingerprint,
} from "../src/strategy-derivation-candidates.ts";
import {
  createStrategyDerivationDecision,
  FileStrategyDerivationDecisionStore,
} from "../src/strategy-derivation-decisions.ts";
import {
  createStrategyTrustScopeCandidate,
  FileStrategyTrustScopeCandidateStore,
} from "../src/strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  FileStrategyTrustScopeDecisionStore,
} from "../src/strategy-trust-scope-decisions.ts";
import {
  FileProjectTrustedStrategyPortfolioReader,
  loadTrustedStrategyPortfolio,
} from "../src/strategy-trust-safety.ts";
import { FileStrategyTrustScopeSourceResolver } from "../src/strategy-trust-scope-resolution.ts";
import { getSeedStrategy, seedStrategyFingerprint } from "../src/strategies.ts";
import { getProjectId } from "../src/store.ts";
import type { PindieState } from "../src/state.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";

const PROJECT_A = getProjectId("/cross-project-synthesis-a");
const PROJECT_B = getProjectId("/cross-project-synthesis-b");
const PROJECT_C = getProjectId("/cross-project-synthesis-c");
const SHARED_RECORD_ID = "11111111-1111-4111-8111-111111111111.json";
const RECORD_A2 = "22222222-2222-4222-8222-222222222222.json";
const RECORD_A3 = "33333333-3333-4333-8333-333333333333.json";
const RECORD_B2 = "44444444-4444-4444-8444-444444444444.json";
const RECORD_B3 = "55555555-5555-4555-8555-555555555555.json";
const RECORD_C = "66666666-6666-4666-8666-666666666666.json";
const NEGATIVE_VERIFICATION = "77777777-7777-4777-8777-777777777777.json";
const NEGATIVE_PENDING = "88888888-8888-4888-8888-888888888888.json";
const NEGATIVE_BLOCKER = "99999999-9999-4999-8999-999999999999.json";
const NEGATIVE_QUESTION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab.json";
const NEGATIVE_GATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc.json";
const NEGATIVE_EXECUTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccd.json";
const TRIAL_RECORD = "dddddddd-dddd-4ddd-8ddd-ddddddddddde.json";
const TRUST_SEED_CANDIDATE_ID = "11111111-1111-4111-8111-111111111112";
const TRUST_LOCAL_DERIVED_CANDIDATE_ID = "22222222-2222-4222-8222-222222222223";
const TRUST_GLOBAL_DERIVED_CANDIDATE_ID = "33333333-3333-4333-8333-333333333334";
const TRUST_SCOPE_CANDIDATE_ID = "44444444-4444-4444-8444-444444444445";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The evidence remains factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
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

function execution(overrides: Partial<RunExperienceExecution> = {}): RunExperienceExecution {
  return {
    toolCalls: 4,
    observations: 1,
    consequentialCalls: 3,
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

interface ExperienceOptions {
  readonly recordedAt?: string;
  readonly exposure?: boolean;
  readonly verificationStatus?: "pending" | "failed" | "passed";
  readonly toolErrors?: number;
  readonly deniedCalls?: number;
  readonly completedBeforeRun?: boolean;
  readonly hasBlockers?: boolean;
  readonly hasQuestions?: boolean;
  readonly humanGateOpen?: boolean;
}

function experience(
  goal: string,
  policy: PolicySnapshot | null,
  options: ExperienceOptions = {},
): RunExperience {
  const runExecution = execution({
    toolErrors: options.toolErrors ?? 0,
    deniedCalls: options.deniedCalls ?? 0,
  });
  const finalPolicyPosition = options.exposure === false ? runExecution : zeroExecution();
  const hasBlockers = options.hasBlockers ?? false;
  const hasQuestions = options.hasQuestions ?? false;
  const humanGateOpen = options.humanGateOpen ?? false;
  const finalTaskStatus = humanGateOpen
    ? "waiting_human" as const
    : hasBlockers
      ? "blocked" as const
      : "active" as const;
  const runTask = task(goal);
  const value = assembleRunExperience({
    task: {
      ...runTask,
      openLoops: {
        ...runTask.openLoops,
        blockers: hasBlockers ? ["fixture blocker"] : [],
        questions: hasQuestions ? ["fixture question"] : [],
      },
      humanGate: humanGateOpen
        ? { kind: "approval", question: "Fixture approval" }
        : null,
    },
    runStart: { taskStatus: finalTaskStatus, taskGoal: goal },
    snapshot: coherentSnapshot({
      taskStatus: finalTaskStatus,
      verificationStatus: options.verificationStatus ?? "pending",
      hasBlockers,
      hasQuestions,
      gateRelation: humanGateOpen ? "existed_before_run" : "none",
    }),
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: policy === null ? null : finalPolicyPosition,
      finalPolicyLastDeclaredAfter: policy === null ? null : finalPolicyPosition,
    },
    execution: runExecution,
    durationMs: 100,
    cost: 0.5,
    recordedAt: options.recordedAt ?? "2026-08-01T00:00:00.000Z",
  });
  if (!options.completedBeforeRun) return value;
  const completed = structuredClone(value) as any;
  completed.runStart.taskStatus = "done";
  completed.outcome.taskStatus = "done";
  completed.outcome.verificationStatus = "passed";
  completed.outcome.completionRelation = "completed_before_run";
  const parsed = parseRunExperience(completed);
  assert.ok(parsed);
  return parsed;
}

function source(recordId: string, value: RunExperience): RunExperienceSourceRecord {
  const parsed = parseRunExperience(value);
  assert.ok(parsed, `invalid fixture Experience for ${recordId}`);
  return { recordId, experience: parsed };
}

function portfolio(projectId: string): TrustedStrategyPortfolio {
  return createTrustedStrategyPortfolioForProjectId(
    projectId,
    createPromotedStrategyRevisionCatalog([]),
  );
}

function readers(
  recordsByProject: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>,
  projectIds: readonly string[] = [PROJECT_A, PROJECT_B],
): {
  readonly experienceReader: RunExperienceProjectReader;
  readonly trustReader: { readProjectId(projectId: string): Promise<TrustedStrategyPortfolio> };
} {
  const portfolios = new Map(projectIds.map((projectId) => [projectId, portfolio(projectId)]));
  return {
    experienceReader: {
      listProjectIds: async () => [...projectIds].reverse(),
      readProjectId: async (projectId): Promise<RunExperienceReadResult> => {
        const records = recordsByProject.get(projectId) ?? [];
        return {
          records,
          loadedRecords: records.length,
          unsupportedSchema: 0,
          invalid: 0,
        };
      },
    },
    trustReader: {
      readProjectId: async (projectId) => {
        const result = portfolios.get(projectId);
        if (result === undefined) throw new Error(`missing trust for ${projectId}`);
        return result;
      },
    },
  };
}

function readersInOrder(
  recordsByProject: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>,
  projectIds: readonly string[],
): {
  readonly experienceReader: RunExperienceProjectReader;
  readonly trustReader: { readProjectId(projectId: string): Promise<TrustedStrategyPortfolio> };
} {
  const portfolios = new Map(projectIds.map((projectId) => [projectId, portfolio(projectId)]));
  return {
    experienceReader: {
      listProjectIds: async () => [...projectIds],
      readProjectId: async (projectId): Promise<RunExperienceReadResult> => {
        const records = recordsByProject.get(projectId) ?? [];
        return {
          records,
          loadedRecords: records.length,
          unsupportedSchema: 0,
          invalid: 0,
        };
      },
    },
    trustReader: {
      readProjectId: async (projectId) => {
        const result = portfolios.get(projectId);
        if (result === undefined) throw new Error(`missing trust for ${projectId}`);
        return result;
      },
    },
  };
}

function synthesisRun(
  projectId: string,
  recordId: string,
  goal: string,
  policy: PolicySnapshot,
  recordedAt: string,
  options: ExperienceOptions = {},
) {
  const record = source(recordId, experience(goal, policy, { ...options, recordedAt }));
  return Object.freeze({
    ref: createCrossProjectExperienceRef({
      projectId,
      recordId,
      experience: record.experience,
    }),
    evaluation: evaluateRunExperience(record),
  });
}

function generatedRecordId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}.json`;
}

function policyA(): PolicySnapshot {
  return createPolicySnapshot({ approach: "direct-action" });
}

function policyB(): PolicySnapshot {
  return createPolicySnapshot({
    approach: "explore-first",
    modifiers: ["minimal-change"],
  });
}

function semanticFacts(value: {
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}) {
  return {
    summary: value.summary,
    useWhen: [...value.useWhen],
    avoidWhen: [...value.avoidWhen],
    principles: [...value.principles],
  };
}

async function createNamespaceTrustFixture() {
  const projectsBaseDir = await mkdtemp(join(tmpdir(), "pindie-slice-a-projects-"));
  const globalBaseDir = await mkdtemp(join(tmpdir(), "pindie-slice-a-global-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "pindie-slice-a-root-target-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "pindie-slice-a-root-source-"));
  const revisionCandidateStore = new FileStrategyCandidateStore({ baseDir: projectsBaseDir });
  const revisionDecisionStore = new FileStrategyDecisionStore({ baseDir: projectsBaseDir });
  const derivationCandidateStore = new FileStrategyDerivationCandidateStore({ baseDir: projectsBaseDir });
  const derivationDecisionStore = new FileStrategyDerivationDecisionStore({ baseDir: projectsBaseDir });
  const scopeCandidateStore = new FileStrategyTrustScopeCandidateStore({ baseDir: globalBaseDir });
  const scopeDecisionStore = new FileStrategyTrustScopeDecisionStore({ baseDir: globalBaseDir });

  const seed = getSeedStrategy("architecture-first")!;
  const promotedSeedCandidate = createStrategyRevisionCandidate({
    target: seed,
    candidateId: TRUST_SEED_CANDIDATE_ID,
    createdAt: "2026-08-10T00:00:00.000Z",
    proposal: {
      summary: "Name the owners before making a cross-cutting change.",
      useWhen: ["the change crosses a meaningful boundary"],
      avoidWhen: ["the correction is already local"],
      principles: ["map ownership", "verify the handoff"],
      sourceRecordIds: ["seed-source-one", "seed-source-two"],
      hypothesis: "A bounded ownership check may reduce cross-cutting rework.",
    },
  });
  const promotedSeedDecision = createStrategyRevisionDecision({
    candidate: promotedSeedCandidate,
    decision: "promoted",
    trialRecordIds: ["seed-trial-one", "seed-trial-two"],
    decidedAt: "2026-08-11T00:00:00.000Z",
  });
  const targetSeedCatalog = createPromotedStrategyRevisionCatalog([{
    candidate: promotedSeedCandidate,
    decision: promotedSeedDecision,
    selection: strategyRevisionSelectionFromCandidate(promotedSeedCandidate, "promoted"),
  }]);
  const targetBasePortfolio = createTrustedStrategyPortfolio(targetRoot, targetSeedCatalog);
  const localDerivedCandidate = createStrategyDerivationCandidate({
    projectId: targetBasePortfolio.projectId,
    basePortfolio: targetBasePortfolio,
    candidateId: TRUST_LOCAL_DERIVED_CANDIDATE_ID,
    createdAt: "2026-08-12T00:00:00.000Z",
    proposal: {
      strategyId: "namespace-local-derived",
      kind: "modifier",
      summary: "Keep namespace-local delivery facts explicit.",
      useWhen: ["the current project has several delivery boundaries"],
      avoidWhen: ["the work has one obvious local check"],
      principles: ["separate local facts", "verify the handoff"],
      sourceRecordIds: ["local-source-one", "local-source-two", "local-source-three"],
      hypothesis: "A local delivery framing may keep evidence bounded.",
    },
  });
  const localDerivedDecision = createStrategyDerivationDecision({
    candidate: localDerivedCandidate,
    decision: "promoted",
    trialRecordIds: ["local-trial-one", "local-trial-two"],
    decidedAt: "2026-08-13T00:00:00.000Z",
  });

  const sourceBasePortfolio = createTrustedStrategyPortfolio(
    sourceRoot,
    createPromotedStrategyRevisionCatalog([]),
  );
  const globalSourceCandidate = createStrategyDerivationCandidate({
    projectId: sourceBasePortfolio.projectId,
    basePortfolio: sourceBasePortfolio,
    candidateId: TRUST_GLOBAL_DERIVED_CANDIDATE_ID,
    createdAt: "2026-08-14T00:00:00.000Z",
    proposal: {
      strategyId: "namespace-transferred-derived",
      kind: "approach",
      summary: "Carry an exact promoted Derived revision across namespaces.",
      useWhen: ["the same immutable revision is being transferred"],
      avoidWhen: ["the source promotion is unavailable"],
      principles: ["bind the source exactly", "keep semantics immutable"],
      sourceRecordIds: ["global-source-one", "global-source-two", "global-source-three"],
      hypothesis: "An exact source binding should survive namespace-addressed reconstruction.",
    },
  });
  const globalSourceDecision = createStrategyDerivationDecision({
    candidate: globalSourceCandidate,
    decision: "promoted",
    trialRecordIds: ["global-trial-one", "global-trial-two"],
    decidedAt: "2026-08-15T00:00:00.000Z",
  });
  const sourceStrategy = {
    sourceProjectId: sourceBasePortfolio.projectId,
    strategyId: globalSourceCandidate.proposal.strategyId,
    kind: globalSourceCandidate.proposal.kind,
    revisionIdentity: globalSourceCandidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(globalSourceCandidate),
  } as const;
  const scopeCandidate = createStrategyTrustScopeCandidate({
    sourceStrategy,
    candidateId: TRUST_SCOPE_CANDIDATE_ID,
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  const scopeDecision = createStrategyTrustScopeDecision({
    candidate: scopeCandidate,
    decision: "promoted",
    trialRefs: [
      {
        projectId: getProjectId("/slice-a-transfer-trial-a"),
        recordId: RECORD_A2,
        recordFingerprint: `sha256:${"a".repeat(64)}`,
      },
      {
        projectId: getProjectId("/slice-a-transfer-trial-b"),
        recordId: RECORD_B2,
        recordFingerprint: `sha256:${"b".repeat(64)}`,
      },
    ],
    decidedAt: "2026-08-17T00:00:00.000Z",
  });

  await Promise.all([
    revisionCandidateStore.save(targetRoot, promotedSeedCandidate),
    revisionDecisionStore.save(targetRoot, promotedSeedDecision),
    derivationCandidateStore.save(targetRoot, localDerivedCandidate),
    derivationDecisionStore.save(targetRoot, localDerivedDecision),
    derivationCandidateStore.save(sourceRoot, globalSourceCandidate),
    derivationDecisionStore.save(sourceRoot, globalSourceDecision),
    scopeCandidateStore.save(scopeCandidate),
    scopeDecisionStore.save(scopeDecision),
  ]);

  return {
    projectsBaseDir,
    globalBaseDir,
    targetRoot,
    sourceRoot,
    revisionCandidateStore,
    revisionDecisionStore,
    derivationCandidateStore,
    derivationDecisionStore,
    scopeCandidateStore,
    scopeDecisionStore,
    targetProjectId: targetBasePortfolio.projectId,
    sourceProjectId: sourceBasePortfolio.projectId,
    promotedSeedCandidate,
    localDerivedCandidate,
    globalSourceCandidate,
    scopeCandidate,
  };
}

type NamespaceTrustFixture = Awaited<ReturnType<typeof createNamespaceTrustFixture>>;

async function removeNamespaceTrustFixture(fixture: NamespaceTrustFixture): Promise<void> {
  await Promise.all([
    rm(fixture.projectsBaseDir, { recursive: true, force: true }),
    rm(fixture.globalBaseDir, { recursive: true, force: true }),
    rm(fixture.targetRoot, { recursive: true, force: true }),
    rm(fixture.sourceRoot, { recursive: true, force: true }),
  ]);
}

function eligibleRecords(): ReadonlyMap<string, readonly RunExperienceSourceRecord[]> {
  return new Map([
    [PROJECT_A, [
      source(SHARED_RECORD_ID, experience("goal-a", policyA(), {
        recordedAt: "2026-08-01T00:00:00.000Z",
      })),
      source(RECORD_A2, experience("goal-b", policyB(), {
        recordedAt: "2026-08-02T00:00:00.000Z",
      })),
    ]],
    [PROJECT_B, [
      source(SHARED_RECORD_ID, experience("goal-c", policyA(), {
        recordedAt: "2026-08-03T00:00:00.000Z",
      })),
    ]],
  ]);
}

test("namespace-addressed synthesis scan keeps same record IDs distinct and qualifies only current trusted Policy", async () => {
  const trustedSeed = policyA().approach;
  const forged = createPolicySnapshotFromRevisions({
    approach: createStrategyRevisionSelection({
      strategyId: trustedSeed.id,
      kind: trustedSeed.kind,
      revisionIdentity: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revisionFingerprint: `sha256:${"f".repeat(64)}`,
      revisionStatusAtRun: "promoted",
      semantics: {
        summary: trustedSeed.summary,
        useWhen: [...trustedSeed.useWhen],
        avoidWhen: [...(trustedSeed.avoidWhen ?? [])],
        principles: [...trustedSeed.principles],
      },
    }),
    modifiers: [],
  });
  const records = new Map(eligibleRecords());
  records.set(PROJECT_A, [
    ...records.get(PROJECT_A)!,
    source(RECORD_A3, experience("forged", forged)),
    source(RECORD_B2, experience("unexposed", policyA(), { exposure: false })),
    source(RECORD_B3, experience("completed before", policyA(), { completedBeforeRun: true })),
    source(RECORD_C, experience("no policy", null)),
  ]);
  const { experienceReader, trustReader } = readers(records);
  const scan = await scanCrossProjectSynthesisEvidence({
    experienceReader,
    trustedPortfolioReader: trustReader,
  });

  assert.equal(scan.eligible.length, 3);
  assert.deepEqual(
    scan.eligible.map((run) => [run.ref.projectId, run.ref.recordId]),
    [
      [PROJECT_B, SHARED_RECORD_ID],
      [PROJECT_A, RECORD_A2],
      [PROJECT_A, SHARED_RECORD_ID],
    ],
  );
  assert.equal(new Set(scan.eligible.map((run) => `${run.ref.projectId}:${run.ref.recordId}`)).size, 3);
  assert.equal(scan.inventory.eligibleRunCount, 3);
  assert.equal(scan.inventory.ineligibleRunCount, 4);
  assert.equal(scan.inventory.projects.length, 2);
  assert.equal(scan.inventory.projects.every((project) => project.trustAvailable), true);
});

test("malformed and duplicate namespace records are excluded, and exact refs reject missing or stale fingerprints", async () => {
  const valid = eligibleRecords();
  const malformed = {
    recordId: RECORD_C,
    experience: { schemaVersion: 4 },
  } as unknown as RunExperienceSourceRecord;
  const duplicate = valid.get(PROJECT_A)![0]!;
  const records = new Map(valid);
  records.set(PROJECT_A, [duplicate, { ...duplicate }, malformed]);
  const { experienceReader, trustReader } = readers(records);
  const scan = await scanCrossProjectSynthesisEvidence({
    experienceReader,
    trustedPortfolioReader: trustReader,
  });
  assert.equal(scan.eligible.length, 1);
  assert.equal(scan.inventory.duplicateRecordLocatorCount, 1);
  assert.equal(scan.inventory.invalidRecordCount, 1);
  assert.equal(scan.inventory.validUniqueRecordCount, 1);

  const exact = createCrossProjectExperienceRef({
    projectId: PROJECT_A,
    recordId: RECORD_A2,
    experience: valid.get(PROJECT_A)![1]!.experience,
  });
  const reader: RunExperienceProjectReader = {
    listProjectIds: async () => [PROJECT_A],
    readProjectId: async (projectId) => projectId === PROJECT_A
      ? {
        records: [valid.get(PROJECT_A)![1]!],
        loadedRecords: 1,
        unsupportedSchema: 0,
        invalid: 0,
      }
      : {
        records: [],
        loadedRecords: 0,
        unsupportedSchema: 0,
        invalid: 0,
      },
  };
  assert.ok(await resolveCrossProjectExperienceRef(exact, reader));
  assert.equal(
    await resolveCrossProjectExperienceRef({
      ...exact,
      recordFingerprint: `sha256:${"0".repeat(64)}`,
    }, reader),
    null,
  );
  assert.equal(
    await resolveCrossProjectExperienceRef({ ...exact, projectId: PROJECT_C }, reader),
    null,
  );
  const duplicateReader: RunExperienceProjectReader = {
    ...reader,
    readProjectId: async () => ({
      records: [valid.get(PROJECT_A)![1]!, valid.get(PROJECT_A)![1]!],
      loadedRecords: 2,
      unsupportedSchema: 0,
      invalid: 0,
    }),
  };
  assert.equal(await resolveCrossProjectExperienceRef(exact, duplicateReader), null);
});

test("discovery excludes any final Policy containing a trial revision while retaining negative factual outcomes", async () => {
  const trialModifier = createStrategyRevisionSelection({
    strategyId: "discovery-trial-modifier",
    kind: "modifier",
    revisionIdentity: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    revisionFingerprint: `sha256:${"e".repeat(64)}`,
    revisionStatusAtRun: "trial",
    semantics: {
      summary: "A temporary discovery fixture revision.",
      useWhen: ["the fixture needs a trial selection"],
      avoidWhen: [],
      principles: ["exclude the whole Run"],
    },
  });
  const mixedPolicy = createPolicySnapshotFromRevisions({
    approach: "direct-action",
    modifiers: [trialModifier],
  });
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [PROJECT_A, [
      source(NEGATIVE_VERIFICATION, experience("negative-verification", policyA(), {
        verificationStatus: "failed",
      })),
      source(NEGATIVE_PENDING, experience("negative-pending", policyA())),
      source(NEGATIVE_BLOCKER, experience("negative-blocker", policyA(), {
        hasBlockers: true,
      })),
      source(NEGATIVE_QUESTION, experience("negative-question", policyA(), {
        hasQuestions: true,
      })),
      source(NEGATIVE_GATE, experience("negative-gate", policyA(), {
        humanGateOpen: true,
      })),
      source(NEGATIVE_EXECUTION, experience("negative-execution", policyA(), {
        toolErrors: 2,
        deniedCalls: 3,
      })),
      source(TRIAL_RECORD, experience("excluded-trial", mixedPolicy)),
    ]],
    [PROJECT_B, []],
  ]);
  const { experienceReader, trustReader } = readers(records, [PROJECT_A, PROJECT_B]);
  const scan = await scanCrossProjectSynthesisEvidence({
    experienceReader,
    trustedPortfolioReader: trustReader,
  });
  const eligibleIds = scan.eligible.map((run) => run.ref.recordId).sort();
  assert.deepEqual(eligibleIds, [
    NEGATIVE_BLOCKER,
    NEGATIVE_EXECUTION,
    NEGATIVE_GATE,
    NEGATIVE_PENDING,
    NEGATIVE_QUESTION,
    NEGATIVE_VERIFICATION,
  ].sort());
  assert.equal(scan.eligible.some((run) => run.ref.recordId === TRIAL_RECORD), false);

  const byId = new Map(scan.eligible.map((run) => [run.ref.recordId, run.evaluation]));
  assert.equal(byId.get(NEGATIVE_VERIFICATION)?.outcome.verificationPassed, false);
  assert.equal(byId.get(NEGATIVE_PENDING)?.outcome.completedDuringRun, false);
  assert.equal(byId.get(NEGATIVE_BLOCKER)?.outcome.hasBlockers, true);
  assert.equal(byId.get(NEGATIVE_QUESTION)?.outcome.hasQuestions, true);
  assert.equal(byId.get(NEGATIVE_GATE)?.outcome.humanGateOpen, true);
  assert.equal(byId.get(NEGATIVE_EXECUTION)?.execution.toolErrors, 2);
  assert.equal(byId.get(NEGATIVE_EXECUTION)?.execution.deniedCalls, 3);
});

test("a single namespace cannot pass the discovery gate, while a distributed witness does", () => {
  const oneProject = [...eligibleRecords().get(PROJECT_A)!];
  const insufficient = selectBoundedCrossProjectSynthesisEvidence(
    oneProject.map((record) => ({
      ref: createCrossProjectExperienceRef({
        projectId: PROJECT_A,
        recordId: record.recordId,
        experience: record.experience,
      }),
      evaluation: evaluateRunExperience(record),
    })),
  );
  assert.equal(insufficient.poolSufficiency.distinctProjectIdCount, 1);
  assert.equal(insufficient.poolSufficiency.sufficient, false);
  assert.deepEqual(insufficient.shown, []);

  const distributed = selectBoundedCrossProjectSynthesisEvidence(
    [
      ...eligibleRecords().get(PROJECT_A)!.map((record) => ({
        ref: createCrossProjectExperienceRef({ projectId: PROJECT_A, recordId: record.recordId, experience: record.experience }),
        evaluation: evaluateRunExperience(record),
      })),
      ...eligibleRecords().get(PROJECT_B)!.map((record) => ({
        ref: createCrossProjectExperienceRef({ projectId: PROJECT_B, recordId: record.recordId, experience: record.experience }),
        evaluation: evaluateRunExperience(record),
      })),
    ],
  );
  assert.equal(distributed.poolSufficiency.sufficient, true);
  assert.equal(distributed.shownSufficiency.sufficient, true);
});

test("bounded selector reaches its hard packet limit without exceeding the per-project bound", () => {
  const projects = Array.from({ length: 5 }, (_, index) =>
    getProjectId(`/slice-a-volume-project-${index}`));
  const eligible = projects.flatMap((projectId, projectIndex) =>
    Array.from({ length: 4 }, (_, recordIndex) => synthesisRun(
      projectId,
      generatedRecordId(projectIndex * 4 + recordIndex + 1),
      `volume-goal-${(projectIndex + recordIndex) % 4}`,
      (projectIndex + recordIndex) % 2 === 0 ? policyA() : policyB(),
      `2026-09-${String(projectIndex * 4 + recordIndex + 1).padStart(2, "0")}T00:00:00.000Z`,
    )));
  const selection = selectBoundedCrossProjectSynthesisEvidence(eligible);
  assert.equal(selection.poolSufficiency.sufficient, true);
  assert.equal(selection.shown.length, MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS);
  assert.ok(selection.shown.every((run) =>
    selection.shown.filter((other) => other.ref.projectId === run.ref.projectId).length <=
      MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT));
  assert.equal(selection.shownSufficiency.sufficient, true);
});

test("newer high-volume evidence cannot fill the packet before a cross-project witness exists", () => {
  const crowdedProject = getProjectId("/slice-a-newer-crowded-project");
  const witnessProject = getProjectId("/slice-a-only-witness-project");
  const crowded = Array.from({ length: 12 }, (_, index) => synthesisRun(
    crowdedProject,
    generatedRecordId(index + 101),
    "crowded-goal",
    policyA(),
    `2027-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  ));
  const witness = synthesisRun(
    witnessProject,
    generatedRecordId(201),
    "only-witness-goal",
    policyB(),
    "2026-01-01T00:00:00.000Z",
  );
  const selection = selectBoundedCrossProjectSynthesisEvidence([...crowded, witness]);
  assert.equal(selection.poolSufficiency.sufficient, true);
  assert.equal(selection.shown.length, 3);
  assert.equal(selection.shown.filter((run) => run.ref.projectId === crowdedProject).length, 2);
  assert.equal(selection.shown.filter((run) => run.ref.projectId === witnessProject).length, 1);
  assert.equal(
    deriveCrossProjectSynthesisSufficiency(selection.shown.slice(0, 3)).sufficient,
    true,
  );
  assert.equal(selection.shown[2]?.ref.projectId, witnessProject);
});

test("packet selection is input-order independent, bounded, frozen, and renders only bounded factual context", async () => {
  const records = new Map(eligibleRecords());
  records.set(PROJECT_A, [
    source(SHARED_RECORD_ID, experience("goal-a", policyA(), { recordedAt: "2026-08-01T00:00:00.000Z" })),
    source(RECORD_A2, experience("goal-b", policyB(), { recordedAt: "2026-08-02T00:00:00.000Z" })),
    source(RECORD_A3, experience("goal-c", policyA(), { recordedAt: "2026-08-03T00:00:00.000Z" })),
    source(RECORD_B2, experience("goal-d", policyB(), { recordedAt: "2026-08-04T00:00:00.000Z" })),
    source(RECORD_B3, experience("goal-e", policyA(), { recordedAt: "2026-08-05T00:00:00.000Z" })),
  ]);
  records.set(PROJECT_B, [
    source(SHARED_RECORD_ID, experience("goal-f", policyB(), { recordedAt: "2026-08-06T00:00:00.000Z" })),
    source(RECORD_C, experience("goal-g", policyA(), { recordedAt: "2026-08-07T00:00:00.000Z" })),
  ]);
  const first = readers(records, [PROJECT_B, PROJECT_A]);
  const second = readers(new Map([
    [PROJECT_A, [...records.get(PROJECT_A)!].reverse()],
    [PROJECT_B, [...records.get(PROJECT_B)!].reverse()],
  ]), [PROJECT_A, PROJECT_B]);
  const scanOne = await scanCrossProjectSynthesisEvidence({
    experienceReader: first.experienceReader,
    trustedPortfolioReader: first.trustReader,
  });
  const scanTwo = await scanCrossProjectSynthesisEvidence({
    experienceReader: second.experienceReader,
    trustedPortfolioReader: second.trustReader,
  });
  const packetOne = buildCrossProjectSynthesisPacket({ scan: scanOne, capturedAt: "2026-08-20T00:00:00.000Z" });
  const packetTwo = buildCrossProjectSynthesisPacket({ scan: scanTwo, capturedAt: "2026-08-20T00:00:00.000Z" });

  assert.deepEqual(packetOne, packetTwo);
  assert.ok(packetOne.evidence.shownRunCount <= MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS);
  assert.ok(packetOne.evidence.runs.every((run) =>
    packetOne.evidence.runs.filter((other) => other.sourceRef.projectId === run.sourceRef.projectId).length <= MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT));
  assert.ok(packetOne.trustedStrategyComparison.length <= MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS);
  assert.equal(packetOne.sufficiency.sufficient, true);
  assert.deepEqual(recomputeCrossProjectSynthesisPacketSufficiency(packetOne), packetOne.sufficiency);
  assert.equal(Object.isFrozen(packetOne), true);
  assert.equal(Object.isFrozen(packetOne.evidence), true);
  assert.equal(Object.isFrozen(packetOne.evidence.runs), true);
  assert.equal(Object.isFrozen(packetOne.inventory), true);
  assert.equal(Object.isFrozen(packetOne.inventory.projects), true);
  assert.equal(Object.isFrozen(packetOne.trustedStrategyComparison), true);
  assert.equal(validateCrossProjectSynthesisPacket(packetOne), packetOne);
  assert.throws(() => validateCrossProjectSynthesisPacket({
    ...packetOne,
    sourceRefs: [...packetOne.sourceRefs].reverse(),
  } as any), /binding|fingerprint/i);

  const rendered = formatCrossProjectSynthesisPacket(packetOne);
  assert.match(rendered, /frozen, read-only cross-project discovery packet/);
  assert.match(rendered, /Packet fingerprint:/);
  assert.match(rendered, /no transcript, tool-result body, source file, Skill content/);

  assert.throws(() => {
    (packetOne.inventory.projects as any).push({});
  }, /read only|object is not extensible|Cannot add property/i);
  assert.throws(() => {
    (packetOne.evidence.runs[0] as any).taskGoal = "mutated";
  }, /read only|object is not extensible|Cannot assign to read only property/i);
});

test("exact long Task goals remain distinct after bounded packet display truncation", async () => {
  const sharedPrefix = "g".repeat(MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH - 14);
  const firstGoal = `${sharedPrefix}-tail-one-not-shown`;
  const secondGoal = `${sharedPrefix}-tail-two-not-shown`;
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [PROJECT_A, [
      source(RECORD_A3, experience(firstGoal, policyA(), {
        recordedAt: "2026-10-01T00:00:00.000Z",
      })),
    ]],
    [PROJECT_B, [
      source(RECORD_B2, experience(secondGoal, policyA(), {
        recordedAt: "2026-10-02T00:00:00.000Z",
      })),
      source(RECORD_B3, experience("short exact goal", policyB(), {
        recordedAt: "2026-10-03T00:00:00.000Z",
      })),
    ]],
  ]);
  const { experienceReader, trustReader } = readersInOrder(records, [PROJECT_A, PROJECT_B]);
  const scan = await scanCrossProjectSynthesisEvidence({
    experienceReader,
    trustedPortfolioReader: trustReader,
  });
  const packet = buildCrossProjectSynthesisPacket({
    scan,
    capturedAt: "2026-10-20T00:00:00.000Z",
  });
  const longRuns = packet.evidence.runs.filter((run) =>
    run.sourceRef.recordId === RECORD_A3 || run.sourceRef.recordId === RECORD_B2);
  assert.equal(firstGoal === secondGoal, false);
  assert.equal(longRuns.length, 2);
  assert.equal(longRuns[0]?.taskGoal, longRuns[1]?.taskGoal);
  assert.notEqual(longRuns[0]?.exactTaskGoalDigest, longRuns[1]?.exactTaskGoalDigest);
  assert.ok(longRuns.every((run) => run.taskGoal.length <= MAX_CROSS_PROJECT_SYNTHESIS_TASK_GOAL_LENGTH));
  assert.doesNotMatch(JSON.stringify(packet), /tail-one-not-shown|tail-two-not-shown/);
  assert.equal(packet.sufficiency.distinctExactTaskGoalCount, 3);
  assert.equal(packet.evidence.poolSufficiency.distinctExactTaskGoalCount, 3);
  assert.deepEqual(recomputeCrossProjectSynthesisPacketSufficiency(packet), packet.sufficiency);
  assert.equal(validateCrossProjectSynthesisPacket(packet), packet);
});

test("selection and packet output are stable across project, record, and eligible-input permutations", async () => {
  const projects = Array.from({ length: 4 }, (_, index) =>
    getProjectId(`/slice-a-permutation-project-${index}`));
  const baseRecords = new Map<string, readonly RunExperienceSourceRecord[]>(
    projects.map((projectId, projectIndex) => [projectId, Array.from({ length: 4 }, (_, recordIndex) =>
      source(
        generatedRecordId(300 + projectIndex * 4 + recordIndex),
        experience(
          `permutation-goal-${(projectIndex + recordIndex) % 4}`,
          (projectIndex + recordIndex) % 2 === 0 ? policyA() : policyB(),
          { recordedAt: `2026-11-${String(projectIndex * 4 + recordIndex + 1).padStart(2, "0")}T00:00:00.000Z` },
        ),
      ))]),
  );
  const permutations = [
    projects,
    [...projects].reverse(),
    [projects[2]!, projects[0]!, projects[3]!, projects[1]!],
  ];
  const recordPermutations = [
    baseRecords,
    new Map(projects.map((projectId) => [projectId, [...baseRecords.get(projectId)!].reverse()])),
    new Map(projects.map((projectId, index) => {
      const records = baseRecords.get(projectId)!;
      return [projectId, [...records.slice(index), ...records.slice(0, index)]] as const;
    })),
  ];
  const packets: CrossProjectSynthesisPacket[] = [];
  for (let index = 0; index < permutations.length; index += 1) {
    const orderedReaders = readersInOrder(recordPermutations[index]!, permutations[index]!);
    const scan = await scanCrossProjectSynthesisEvidence({
      experienceReader: orderedReaders.experienceReader,
      trustedPortfolioReader: orderedReaders.trustReader,
    });
    packets.push(buildCrossProjectSynthesisPacket({
      scan,
      capturedAt: "2026-11-20T00:00:00.000Z",
    }));
  }
  const baseline = packets[0]!;
  for (const packet of packets.slice(1)) assert.deepEqual(packet, baseline);

  const baselineScanReaders = readersInOrder(baseRecords, projects);
  const baselineScan = await scanCrossProjectSynthesisEvidence({
    experienceReader: baselineScanReaders.experienceReader,
    trustedPortfolioReader: baselineScanReaders.trustReader,
  });
  const eligiblePermutations = [
    [...baselineScan.eligible].reverse(),
    [...baselineScan.eligible.slice(5), ...baselineScan.eligible.slice(0, 5)],
    [...baselineScan.eligible].sort((left, right) => left.ref.recordId < right.ref.recordId ? -1 : 1),
  ];
  for (const eligible of eligiblePermutations) {
    const packet = buildCrossProjectSynthesisPacket({
      scan: { ...baselineScan, eligible },
      capturedAt: "2026-11-20T00:00:00.000Z",
    });
    assert.deepEqual(packet.evidence.runs.map((run) => run.sourceRef), baseline.evidence.runs.map((run) => run.sourceRef));
    assert.deepEqual(packet, baseline);
  }
});

test("FileProjectTrustedStrategyPortfolioReader reconstructs real Seed, local Derived, and transferred Derived trust by namespace", async () => {
  const fixture = await createNamespaceTrustFixture();
  try {
    const rootBased = await loadTrustedStrategyPortfolio(fixture.targetRoot, {
      decisionReader: fixture.revisionDecisionStore,
      candidateReader: fixture.revisionCandidateStore,
      derivationDecisionReader: fixture.derivationDecisionStore,
      derivationCandidateReader: fixture.derivationCandidateStore,
      scopeCandidateReader: fixture.scopeCandidateStore,
      scopeDecisionReader: fixture.scopeDecisionStore,
      scopeSourceResolver: new FileStrategyTrustScopeSourceResolver({
        projectsBaseDir: fixture.projectsBaseDir,
      }),
    });
    const addressedReader = new FileProjectTrustedStrategyPortfolioReader({
      projectsBaseDir: fixture.projectsBaseDir,
      globalBaseDir: fixture.globalBaseDir,
    });
    const addressed = await addressedReader.readProjectId(fixture.targetProjectId);
    await assert.rejects(
      addressedReader.readProjectId("not-a-project-id"),
      /canonical project identity/i,
    );

    assert.deepEqual(addressed, rootBased);
    assert.equal(addressed.projectId, fixture.targetProjectId);
    assert.equal(addressed.fingerprintVersion, 1);
    assert.match(addressed.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(addressed.fingerprint, rootBased.fingerprint);

    const seed = getSeedStrategy("architecture-first")!;
    const seedEntry = addressed.resolvedEntries.find((entry) =>
      entry.manifest.origin === "seed" && entry.manifest.strategyId === seed.id);
    assert.ok(seedEntry);
    assert.deepEqual(seedEntry?.manifest, {
      origin: "seed",
      strategyId: seed.id,
      kind: seed.kind,
      revisionIdentity: "seed",
      revisionFingerprint: seedStrategyFingerprint(seed),
    });
    assert.deepEqual(seedEntry?.semantics, {
      summary: seed.summary,
      useWhen: [...seed.useWhen],
      avoidWhen: [...(seed.avoidWhen ?? [])],
      principles: [...seed.principles],
    });
    assert.deepEqual(seedEntry?.trust, { origins: ["seed"], sourceProjectIds: [] });

    const promotedSeedEntry = addressed.resolvedEntries.find((entry) =>
      entry.manifest.revisionIdentity === fixture.promotedSeedCandidate.candidateId);
    assert.ok(promotedSeedEntry);
    assert.deepEqual(promotedSeedEntry?.manifest, {
      origin: "promoted-seed-revision",
      strategyId: fixture.promotedSeedCandidate.target.strategyId,
      kind: fixture.promotedSeedCandidate.target.kind,
      revisionIdentity: fixture.promotedSeedCandidate.candidateId,
      revisionFingerprint: strategyRevisionSelectionFromCandidate(fixture.promotedSeedCandidate, "promoted").revisionFingerprint,
    });
    assert.deepEqual(promotedSeedEntry?.semantics, semanticFacts(fixture.promotedSeedCandidate.proposal));
    assert.deepEqual(promotedSeedEntry?.trust, { origins: ["project-local"], sourceProjectIds: [] });

    const localEntry = addressed.resolvedEntries.find((entry) =>
      entry.manifest.revisionIdentity === fixture.localDerivedCandidate.candidateId);
    assert.ok(localEntry);
    assert.deepEqual(localEntry?.manifest, {
      origin: "promoted-derived",
      strategyId: fixture.localDerivedCandidate.proposal.strategyId,
      kind: fixture.localDerivedCandidate.proposal.kind,
      revisionIdentity: fixture.localDerivedCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(fixture.localDerivedCandidate),
    });
    assert.deepEqual(localEntry?.semantics, semanticFacts(fixture.localDerivedCandidate.proposal));
    assert.deepEqual(localEntry?.trust, { origins: ["project-local"], sourceProjectIds: [] });

    const transferredEntry = addressed.resolvedEntries.find((entry) =>
      entry.manifest.revisionIdentity === fixture.globalSourceCandidate.candidateId);
    assert.ok(transferredEntry);
    assert.deepEqual(transferredEntry?.manifest, {
      origin: "promoted-derived",
      strategyId: fixture.globalSourceCandidate.proposal.strategyId,
      kind: fixture.globalSourceCandidate.proposal.kind,
      revisionIdentity: fixture.globalSourceCandidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(fixture.globalSourceCandidate),
    });
    assert.deepEqual(transferredEntry?.semantics, semanticFacts(fixture.globalSourceCandidate.proposal));
    assert.deepEqual(transferredEntry?.trust, {
      origins: ["user-global"],
      sourceProjectIds: [fixture.sourceProjectId],
    });
    for (const entry of addressed.resolvedEntries) {
      assert.equal(Object.isFrozen(entry.manifest), true);
      assert.equal(Object.isFrozen(entry.semantics), true);
      assert.equal(Object.isFrozen(entry.semantics.useWhen), true);
      assert.equal(Object.isFrozen(entry.semantics.avoidWhen), true);
      assert.equal(Object.isFrozen(entry.semantics.principles), true);
    }
  } finally {
    await removeNamespaceTrustFixture(fixture);
  }
});

test("namespace-addressed trust fails closed for malformed foreign Candidate and Decision chains", async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (fixture: NamespaceTrustFixture) => Promise<void>;
  }[] = [
    {
      name: "missing Candidate for promoted source Decision",
      mutate: async (fixture) => {
        await rm(join(
          fixture.derivationCandidateStore.strategyDerivationCandidateDirectory(fixture.sourceRoot),
          `${fixture.globalSourceCandidate.candidateId}.json`,
        ));
      },
    },
    {
      name: "wrong Candidate project binding",
      mutate: async (fixture) => {
        await writeFile(
          join(
            fixture.derivationCandidateStore.strategyDerivationCandidateDirectory(fixture.sourceRoot),
            `${fixture.globalSourceCandidate.candidateId}.json`,
          ),
          `${JSON.stringify({ ...fixture.globalSourceCandidate, projectId: fixture.targetProjectId })}\n`,
        );
      },
    },
    {
      name: "wrong Scope Candidate and Decision binding",
      mutate: async (fixture) => {
        await writeFile(
          join(
            fixture.scopeCandidateStore.candidateDirectory(),
            `${fixture.scopeCandidate.candidateId}.json`,
          ),
          `${JSON.stringify({
            ...fixture.scopeCandidate,
            sourceStrategy: {
              ...fixture.scopeCandidate.sourceStrategy,
              strategyId: "foreign-binding-mismatch",
            },
          })}\n`,
        );
      },
    },
    {
      name: "wrong exact source semantics fingerprint",
      mutate: async (fixture) => {
        await writeFile(
          join(
            fixture.derivationCandidateStore.strategyDerivationCandidateDirectory(fixture.sourceRoot),
            `${fixture.globalSourceCandidate.candidateId}.json`,
          ),
          `${JSON.stringify({
            ...fixture.globalSourceCandidate,
            proposal: {
              ...fixture.globalSourceCandidate.proposal,
              summary: "manually replaced foreign semantics",
            },
          })}\n`,
        );
      },
    },
  ];

  for (const malformed of cases) {
    const fixture = await createNamespaceTrustFixture();
    try {
      await malformed.mutate(fixture);
      const reader = new FileProjectTrustedStrategyPortfolioReader({
        projectsBaseDir: fixture.projectsBaseDir,
        globalBaseDir: fixture.globalBaseDir,
      });
      await assert.rejects(
        reader.readProjectId(fixture.targetProjectId),
        /Candidate|binding|source|malformed|missing/i,
        malformed.name,
      );
    } finally {
      await removeNamespaceTrustFixture(fixture);
    }
  }
});
