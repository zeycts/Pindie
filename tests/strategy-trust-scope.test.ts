import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCrossProjectExperienceRef,
  crossProjectExperienceRecordFingerprint,
  validateCrossProjectExperienceRefArtifact,
  type CrossProjectExperienceRefV1,
} from "../src/cross-project-experience.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createStrategyDerivationCandidate,
  FileStrategyDerivationCandidateStore,
  strategyDerivationCandidateSemanticFingerprint,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import {
  createPromotedDerivedStrategyCatalog,
  createStrategyDerivationDecision,
  FileStrategyDerivationDecisionStore,
} from "../src/strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import {
  createStrategyTrustScopeCandidate,
  FileStrategyTrustScopeCandidateStore,
  strategyTrustScopeCandidateFingerprint,
  validateStrategyTrustScopeCandidateArtifact,
  type StrategyTrustScopeCandidateV1,
  type StrategyTrustScopeSourceStrategyV1,
} from "../src/strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  FileStrategyTrustScopeDecisionStore,
  validateStrategyTrustScopeDecisionArtifact,
  validateStrategyTrustScopeDecisionBinding,
} from "../src/strategy-trust-scope-decisions.ts";
import {
  createStrategyTrustScopeCandidateForProject,
  listTransferableDerivedStrategies,
} from "../src/strategy-trust-scope.ts";
import {
  createScopeTrialBinding,
  parseScopeTrialCommandValue,
  resolveScopeTrialBinding,
  scopeTrialCommandValue,
  strategyRevisionSelectionFromScopeTrial,
} from "../src/strategy-trust-scope-trial.ts";
import { TrialRuntime } from "../src/strategy-trial.ts";
import {
  FileStrategyTrustScopeSourceResolver,
} from "../src/strategy-trust-scope-resolution.ts";
import {
  FileGlobalWriterLock,
  getProjectId,
} from "../src/store.ts";
import { getSeedStrategy } from "../src/strategies.ts";
import {
  createPolicySnapshot,
  createStrategyRevisionSelection,
  type PolicySnapshot,
} from "../src/policy.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

const SOURCE_ROOT = "/source-project";
const TARGET_A = "/target-a";
const TARGET_B = "/target-b";
const CANDIDATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function portfolio(projectRoot = SOURCE_ROOT) {
  return createTrustedStrategyPortfolio(
    projectRoot,
    createPromotedStrategyRevisionCatalog([]),
  );
}

function derivedCandidate(
  candidateId = CANDIDATE_ID,
  projectRoot = SOURCE_ROOT,
  strategyId = "delivery-checkpoints",
): StrategyDerivationCandidateV1 {
  const current = portfolio(projectRoot);
  return createStrategyDerivationCandidate({
    projectId: current.projectId,
    basePortfolio: current,
    candidateId,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: {
      strategyId,
      kind: "modifier",
      summary: "Make implementation and delivery progress explicit through bounded checkpoints.",
      useWhen: ["the task has several independent deliverables to close"],
      avoidWhen: ["the work is only exploratory discussion"],
      principles: ["separate implementation and verification checks", "keep checkpoints bounded"],
      sourceRecordIds: ["source-a", "source-b", "source-c"],
      hypothesis: "Repeated delivery work may benefit from bounded checkpoints.",
    },
  });
}

function sourceBinding(candidate: StrategyDerivationCandidateV1): StrategyTrustScopeSourceStrategyV1 {
  return {
    sourceProjectId: candidate.projectId,
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
  };
}

async function fixture(t: test.TestContext) {
  const projectsBaseDir = await mkdtemp(join(tmpdir(), "pindie-scope-projects-"));
  const globalBaseDir = await mkdtemp(join(tmpdir(), "pindie-scope-global-"));
  t.after(async () => {
    await Promise.all([
      rm(projectsBaseDir, { recursive: true, force: true }),
      rm(globalBaseDir, { recursive: true, force: true }),
    ]);
  });
  const candidate = derivedCandidate();
  const candidateStore = new FileStrategyDerivationCandidateStore({ baseDir: projectsBaseDir });
  const decisionStore = new FileStrategyDerivationDecisionStore({ baseDir: projectsBaseDir });
  await candidateStore.save(SOURCE_ROOT, candidate);
  const decision = createStrategyDerivationDecision({
    candidate,
    decision: "promoted",
    trialRecordIds: ["trial-a", "trial-b"],
    decidedAt: "2026-07-02T00:00:00.000Z",
  });
  await decisionStore.save(SOURCE_ROOT, decision);
  const source = sourceBinding(candidate);
  const sourceResolver = new FileStrategyTrustScopeSourceResolver({ projectsBaseDir });
  const scopeCandidateStore = new FileStrategyTrustScopeCandidateStore({ baseDir: globalBaseDir });
  const scopeDecisionStore = new FileStrategyTrustScopeDecisionStore({ baseDir: globalBaseDir });
  const writerLock = new FileGlobalWriterLock({
    baseDir: globalBaseDir,
    lockRetryMs: 2,
    lockTimeoutMs: 250,
  });
  return {
    projectsBaseDir,
    globalBaseDir,
    candidate,
    decision,
    source,
    sourceResolver,
    candidateStore,
    decisionStore,
    scopeCandidateStore,
    scopeDecisionStore,
    writerLock,
  };
}

function coherentState(): PindieState {
  return {
    task: {
      goal: "Trust scope fixture",
      constraints: [],
      successCriteria: [{ id: "c1", description: "fixture" }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  };
}

function experience(
  projectRoot: string,
  policy: PolicySnapshot | null = createPolicySnapshot({ approach: "direct-action" }),
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
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  const record = assembleRunExperience({
    task: coherentState().task!,
    runStart: { taskStatus: "active", taskGoal: "Trust scope fixture" },
    snapshot,
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: policy === null ? null : zero,
      finalPolicyLastDeclaredAfter: policy === null ? null : zero,
    },
    execution: { ...zero, toolCalls: 1, observations: 1 },
    durationMs: 10,
    cost: 0,
    recordedAt: `2026-07-0${projectRoot.endsWith("a") ? "3" : "4"}T00:00:00.000Z`,
  });
  assert.ok(parseRunExperience(record));
  return record;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}

function refs(): readonly CrossProjectExperienceRefV1[] {
  const first = experience(TARGET_A);
  const second = experience(TARGET_B);
  return [
    createCrossProjectExperienceRef({
      projectId: getProjectId(TARGET_A),
      recordId: "11111111-1111-4111-8111-111111111111.json",
      experience: first,
    }),
    createCrossProjectExperienceRef({
      projectId: getProjectId(TARGET_B),
      recordId: "22222222-2222-4222-8222-222222222222.json",
      experience: second,
    }),
  ];
}

test("StrategyTrustScopeCandidateV1 is exact, immutable, and occurrence-independent", () => {
  const candidate = createStrategyTrustScopeCandidate({
    sourceStrategy: {
      sourceProjectId: "0".repeat(64),
      strategyId: "delivery-checkpoints",
      kind: "modifier",
      revisionIdentity: CANDIDATE_ID,
      revisionFingerprint: `sha256:${"1".repeat(64)}`,
    },
    candidateId: CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  assert.deepEqual(Object.keys(candidate).sort(), [
    "candidateId",
    "createdAt",
    "currentTrustScope",
    "proposedTrustScope",
    "schemaVersion",
    "sourceStrategy",
  ]);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.sourceStrategy), true);
  assert.match(strategyTrustScopeCandidateFingerprint(candidate), /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    strategyTrustScopeCandidateFingerprint(candidate),
    strategyTrustScopeCandidateFingerprint({
      ...candidate,
      candidateId: SECOND_CANDIDATE_ID,
      createdAt: "2027-07-01T00:00:00.000Z",
    }),
  );
  assert.doesNotThrow(() => validateStrategyTrustScopeCandidateArtifact(candidate));
  assert.throws(
    () => validateStrategyTrustScopeCandidateArtifact({ ...candidate, fingerprint: "unexpected" }),
    /artifact fields/i,
  );
  assert.throws(
    () => validateStrategyTrustScopeCandidateArtifact({ ...candidate, candidateId: CANDIDATE_ID.toUpperCase() }),
    /UUID/i,
  );
  assert.throws(
    () => validateStrategyTrustScopeCandidateArtifact({
      ...candidate,
      sourceStrategy: { ...candidate.sourceStrategy, sourceProjectId: "G".repeat(64) },
    }),
    /project/i,
  );
  assert.throws(
    () => validateStrategyTrustScopeCandidateArtifact({
      ...candidate,
      sourceStrategy: { ...candidate.sourceStrategy, revisionFingerprint: "sha256:bad" },
    }),
    /fingerprint/i,
  );
});

test("CrossProjectExperienceRefV1 is strict and record fingerprints are canonical", () => {
  const record = experience(TARGET_A);
  const ref = createCrossProjectExperienceRef({
    projectId: getProjectId(TARGET_A),
    recordId: "11111111-1111-4111-8111-111111111111.json",
    experience: record,
  });
  assert.doesNotThrow(() => validateCrossProjectExperienceRefArtifact(ref));
  assert.equal(Object.isFrozen(ref), true);
  assert.match(ref.recordFingerprint, /^sha256:[0-9a-f]{64}$/);
  const reordered = reverseObjectKeys(record);
  assert.equal(crossProjectExperienceRecordFingerprint(record), crossProjectExperienceRecordFingerprint(reordered));
  // v4's historical exact fingerprint stays unchanged; v5 binds the episode as part of the exact record.
  const v4 = crossProjectExperienceRecordFingerprint(record);
  const firstV5 = { ...record, schemaVersion: 5, workEpisodeId: "00000000-0000-4000-8000-000000000000" };
  const secondV5 = { ...firstV5, workEpisodeId: "11111111-1111-4111-8111-111111111111" };
  assert.equal(crossProjectExperienceRecordFingerprint(record), v4);
  assert.notEqual(crossProjectExperienceRecordFingerprint(firstV5), crossProjectExperienceRecordFingerprint(secondV5));
  assert.notEqual(crossProjectExperienceRecordFingerprint(firstV5), v4);
  assert.equal(crossProjectExperienceRecordFingerprint(firstV5), crossProjectExperienceRecordFingerprint(reverseObjectKeys(firstV5)));
  assert.notEqual(
    crossProjectExperienceRecordFingerprint({ ...record, recordedAt: "2026-07-09T00:00:00.000Z" }),
    ref.recordFingerprint,
  );
  for (const bad of [
    { ...ref, projectId: "not-a-project" },
    { ...ref, recordId: "11111111-1111-4111-8111-111111111111" },
    { ...ref, recordFingerprint: "sha256:BAD" },
    { ...ref, extra: true },
  ]) {
    assert.throws(() => validateCrossProjectExperienceRefArtifact(bad), /invalid|canonical|fingerprint/i);
  }
});

test("Scope Decision V1 is strict and Candidate-bound", () => {
  const candidate = createStrategyTrustScopeCandidate({
    sourceStrategy: {
      sourceProjectId: "0".repeat(64),
      strategyId: "delivery-checkpoints",
      kind: "modifier",
      revisionIdentity: CANDIDATE_ID,
      revisionFingerprint: `sha256:${"1".repeat(64)}`,
    },
    candidateId: CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  const promoted = createStrategyTrustScopeDecision({
    candidate,
    decision: "promoted",
    trialRefs: [...refs()],
    decidedAt: "2026-07-05T00:00:00.000Z",
  });
  assert.equal(Object.isFrozen(promoted), true);
  assert.equal(Object.isFrozen(promoted.evidence), true);
  assert.doesNotThrow(() => validateStrategyTrustScopeDecisionArtifact(promoted));
  assert.doesNotThrow(() => validateStrategyTrustScopeDecisionBinding(promoted, candidate));
  assert.throws(
    () => validateStrategyTrustScopeDecisionBinding({
      ...promoted,
      candidateFingerprint: `sha256:${"0".repeat(64)}`,
    }, candidate),
    /fingerprint|binding/i,
  );
  assert.throws(
    () => validateStrategyTrustScopeDecisionArtifact({
      ...promoted,
      evidence: { trialRefs: [promoted.evidence.trialRefs[1], promoted.evidence.trialRefs[0]] },
    }),
    /sorted|unique/i,
  );
  assert.throws(
    () => createStrategyTrustScopeDecision({ candidate, decision: "promoted", trialRefs: [refs()[0]!] }),
    /two|distinct/i,
  );
  const rejected = createStrategyTrustScopeDecision({
    candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-07-06T00:00:00.000Z",
  });
  assert.doesNotThrow(() => validateStrategyTrustScopeDecisionArtifact(rejected));
  assert.throws(
    () => validateStrategyTrustScopeDecisionBinding({
      ...rejected,
      sourceStrategy: { ...rejected.sourceStrategy, kind: "approach" },
    }, candidate),
    /source|binding/i,
  );
});

test("global Scope Candidate and Decision stores are immutable and deterministically ordered", async (t) => {
  const value = await fixture(t);
  const first = createStrategyTrustScopeCandidate({
    sourceStrategy: value.source,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  const second = createStrategyTrustScopeCandidate({
    sourceStrategy: { ...value.source, strategyId: "another-derived" },
    candidateId: SECOND_CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  await value.scopeCandidateStore.save(second);
  await value.scopeCandidateStore.save(first);
  assert.deepEqual((await value.scopeCandidateStore.readAll()).map((item) => item.candidateId), [CANDIDATE_ID, SECOND_CANDIDATE_ID]);
  const firstPath = join(value.scopeCandidateStore.strategyScopeCandidateDirectory(), `${CANDIDATE_ID}.json`);
  const before = await readFile(firstPath, "utf8");
  await assert.rejects(value.scopeCandidateStore.save(first), /already exists/i);
  assert.equal(await readFile(firstPath, "utf8"), before);

  const rejected = createStrategyTrustScopeDecision({ candidate: first, decision: "rejected", trialRefs: [] });
  await value.scopeDecisionStore.save(rejected);
  assert.deepEqual((await value.scopeDecisionStore.readAll()).map((item) => item.candidateId), [CANDIDATE_ID]);
  await assert.rejects(value.scopeDecisionStore.save(rejected), /already exists|terminal/i);
});

test("malformed global artifacts fail closed", async (t) => {
  const value = await fixture(t);
  const directory = value.scopeCandidateStore.strategyScopeCandidateDirectory();
  await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${CANDIDATE_ID}.json`), "{ malformed", "utf8");
  await assert.rejects(value.scopeCandidateStore.readAll(), /invalid JSON/i);
});

test("strict source resolver accepts only one exact promoted Derived revision", async (t) => {
  const value = await fixture(t);
  const resolved = await value.sourceResolver.resolve(value.source);
  assert.equal(resolved.candidate.candidateId, value.candidate.candidateId);
  assert.equal(resolved.decision.decision, "promoted");
  assert.equal(resolved.selection.revisionFingerprint, value.source.revisionFingerprint);
  assert.equal(resolved.promotedDerivedCatalog.entries.length, 1);

  const wrongs: Array<[string, StrategyTrustScopeSourceStrategyV1]> = [
    ["project", { ...value.source, sourceProjectId: "f".repeat(64) }],
    ["logical ID", { ...value.source, strategyId: "wrong-id" }],
    ["kind", { ...value.source, kind: "approach" }],
    ["revision identity", { ...value.source, revisionIdentity: SECOND_CANDIDATE_ID }],
    ["revision fingerprint", { ...value.source, revisionFingerprint: `sha256:${"f".repeat(64)}` }],
    ["Seed collision", { ...value.source, strategyId: "direct-action" }],
  ];
  for (const [label, binding] of wrongs) {
    await assert.rejects(value.sourceResolver.resolve(binding), /source|match|Seed|missing|fingerprint|identity|kind/i, label);
  }
});

test("source resolver fails closed for missing, malformed, rejected, and cross-store ambiguous artifacts", async (t) => {
  const missing = await fixture(t);
  await rm(join(missing.candidateStore.strategyDerivationCandidateDirectory(SOURCE_ROOT), `${CANDIDATE_ID}.json`));
  await assert.rejects(missing.sourceResolver.resolve(missing.source), /missing/i);

  const malformed = await fixture(t);
  await writeFile(
    join(malformed.candidateStore.strategyDerivationCandidateDirectory(SOURCE_ROOT), `${CANDIDATE_ID}.json`),
    JSON.stringify({ schemaVersion: 1 }),
    "utf8",
  );
  await assert.rejects(malformed.sourceResolver.resolve(malformed.source), /malformed|invalid/i);

  const nonCanonical = await fixture(t);
  await writeFile(
    join(nonCanonical.candidateStore.strategyDerivationCandidateDirectory(SOURCE_ROOT), "not-a-candidate.json"),
    "{}",
    "utf8",
  );
  await assert.rejects(nonCanonical.sourceResolver.resolve(nonCanonical.source), /non-canonical/i);

  const rejected = await fixture(t);
  const rejectedDecision = createStrategyDerivationDecision({
    candidate: rejected.candidate,
    decision: "rejected",
    trialRecordIds: [],
    decidedAt: "2026-07-03T00:00:00.000Z",
  });
  await writeFile(
    join(rejected.decisionStore.strategyDerivationDecisionDirectory(SOURCE_ROOT), `${CANDIDATE_ID}.json`),
    `${JSON.stringify(rejectedDecision, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(rejected.sourceResolver.resolve(rejected.source), /not promoted/i);

  const ambiguous = await fixture(t);
  const revisionCandidate = {
    schemaVersion: 1,
    candidateId: ambiguous.candidate.candidateId,
    createdAt: "2026-07-01T00:00:00.000Z",
    target: {
      strategyId: "direct-action",
      kind: "approach",
      baseFingerprint: "sha256:" + "0".repeat(64),
    },
    proposal: {
      summary: "Revision collision",
      useWhen: ["a"],
      avoidWhen: [],
      principles: ["b"],
    },
    evidence: { sourceRecordIds: ["a", "b"] },
    hypothesis: "collision",
  };
  const revisionStore = new (await import("../src/strategy-candidates.ts")).FileStrategyCandidateStore({ baseDir: ambiguous.projectsBaseDir });
  // The frozen Revision validator requires the real Seed fingerprint and
  // non-Seed semantics; use a valid Candidate and then reuse its UUID.
  const seed = getSeedStrategy("direct-action")!;
  const validRevision = (await import("../src/strategy-candidates.ts")).createStrategyRevisionCandidate({
    target: seed,
    candidateId: ambiguous.candidate.candidateId,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: {
      summary: "A revision with the colliding UUID.",
      useWhen: ["the collision is being tested"],
      avoidWhen: [],
      principles: ["do not guess the Candidate kind"],
      sourceRecordIds: ["a", "b"],
      hypothesis: "collision",
    },
  });
  void revisionCandidate;
  await revisionStore.save(SOURCE_ROOT, validRevision);
  await assert.rejects(ambiguous.sourceResolver.resolve(ambiguous.source), /ambiguous/i);
});

test("only a promoted Derived entry is transferable and completion remains meaning-first", async (t) => {
  const value = await fixture(t);
  const projection = await listTransferableDerivedStrategies(
    SOURCE_ROOT,
    createTrustedStrategyPortfolio(
      SOURCE_ROOT,
      createPromotedStrategyRevisionCatalog([]),
      value.sourceResolver
        ? (await value.sourceResolver.resolve(value.source)).promotedDerivedCatalog
        : undefined,
    ),
    value.sourceResolver,
    value.scopeCandidateStore,
    value.scopeDecisionStore,
  );
  assert.equal(projection.options.length, 1);
  assert.equal(projection.options[0]?.value, "delivery-checkpoints");
  assert.match(projection.options[0]?.label ?? "", /delivery-checkpoints/);
  assert.match(projection.options[0]?.label ?? "", /modifier/);
  assert.match(projection.options[0]?.label ?? "", /promoted aaaaaaaa/);
  assert.match(projection.options[0]?.label ?? "", /project-local trusted Derived Strategy/);
  assert.doesNotMatch(projection.options[0]?.label ?? "", new RegExp(CANDIDATE_ID));
});

test("trust-transfer completion excludes hypotheses that creation would reject as duplicates", async (t) => {
  const value = await fixture(t);
  const currentPortfolio = createTrustedStrategyPortfolio(
    SOURCE_ROOT,
    createPromotedStrategyRevisionCatalog([]),
    (await value.sourceResolver.resolve(value.source)).promotedDerivedCatalog,
  );
  const options = () => listTransferableDerivedStrategies(
    SOURCE_ROOT, currentPortfolio, value.sourceResolver,
    value.scopeCandidateStore, value.scopeDecisionStore,
  );
  assert.deepEqual((await options()).options.map((entry) => entry.value), ["delivery-checkpoints"]);
  const candidate = createStrategyTrustScopeCandidate({
    sourceStrategy: value.source,
    candidateId: CANDIDATE_ID,
  });
  await value.scopeCandidateStore.save(candidate);
  assert.deepEqual((await options()).options, []);
  await value.scopeDecisionStore.save(createStrategyTrustScopeDecision({
    candidate, decision: "rejected", trialRefs: [],
  }));
  assert.deepEqual((await options()).options, []);
  await assert.rejects(createStrategyTrustScopeCandidateForProject({
    projectRoot: SOURCE_ROOT, sourceStrategy: value.source,
  }, {
    candidateStore: value.scopeCandidateStore,
    decisionReader: value.scopeDecisionStore,
    sourceResolver: value.sourceResolver,
    writerLock: value.writerLock,
  }), /identical|reopen/i);
});

test("locked Candidate creation enforces source, duplicates, rejection closure, and no copied semantics", async (t) => {
  const value = await fixture(t);
  const dependencies = {
    candidateStore: value.scopeCandidateStore,
    decisionReader: value.scopeDecisionStore,
    sourceResolver: value.sourceResolver,
    writerLock: value.writerLock,
  };
  const created = await createStrategyTrustScopeCandidateForProject({
    projectRoot: SOURCE_ROOT,
    sourceStrategy: value.source,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-07-07T00:00:00.000Z",
  }, dependencies);
  assert.equal(created.sourceStrategy.strategyId, "delivery-checkpoints");
  assert.equal("summary" in created, false);
  assert.equal("useWhen" in created.sourceStrategy, false);
  await assert.rejects(
    createStrategyTrustScopeCandidateForProject({
      projectRoot: SOURCE_ROOT,
      sourceStrategy: value.source,
      candidateId: SECOND_CANDIDATE_ID,
    }, dependencies),
    /identical|reopen/i,
  );

  const rejected = createStrategyTrustScopeDecision({ candidate: created, decision: "rejected", trialRefs: [] });
  await value.scopeDecisionStore.save(rejected);
  await assert.rejects(
    createStrategyTrustScopeCandidateForProject({
      projectRoot: SOURCE_ROOT,
      sourceStrategy: value.source,
      candidateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }, dependencies),
    /identical|reopen/i,
  );
  await assert.rejects(
    createStrategyTrustScopeCandidateForProject({
      projectRoot: TARGET_A,
      sourceStrategy: value.source,
    }, dependencies),
    /source project/i,
  );
});

test("global writer lock serializes competing operations and releases after failure", async (t) => {
  const value = await fixture(t);
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { release = resolve; });
  let firstEntered!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
  const first = value.writerLock.withLock(async () => {
    firstEntered();
    await entered;
    return "first";
  });
  await firstStarted;
  const competing = value.writerLock.withLock(async () => "second");
  await assert.rejects(competing, /writer lock|Retry/i);
  release();
  assert.equal(await first, "first");
  assert.equal(await value.writerLock.withLock(async () => "released"), "released");
  assert.equal(await readFile(join(value.globalBaseDir, "writer.lock", "owner.json"), "utf8").catch(() => null), null);
});

test("Scope Trial binding enforces source, target, terminal, and stale-artifact gates", async (t) => {
  const value = await fixture(t);
  const scopeCandidate = createStrategyTrustScopeCandidate({
    sourceStrategy: value.source,
    candidateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    createdAt: "2026-07-08T00:00:00.000Z",
  });
  const targetPortfolio = portfolio(TARGET_A);
  const binding = await createScopeTrialBinding(
    scopeCandidate,
    TARGET_A,
    targetPortfolio,
    value.sourceResolver,
  );
  assert.equal(binding.targetProjectId, getProjectId(TARGET_A));
  assert.equal(binding.revisionSelection.revisionStatusAtRun, "trial");
  assert.equal(binding.packet.selector.revisionIdentity, value.candidate.candidateId);
  assert.doesNotMatch(binding.renderedPacket, /source-a|source-b|source-c|sourceRecordIds/);

  await assert.rejects(
    createScopeTrialBinding(scopeCandidate, SOURCE_ROOT, portfolio(SOURCE_ROOT), value.sourceResolver),
    /source project/i,
  );

  const targetCandidate = derivedCandidate(SECOND_CANDIDATE_ID, TARGET_A);
  const targetDecision = createStrategyDerivationDecision({
    candidate: targetCandidate,
    decision: "promoted",
    trialRecordIds: ["target-trial-a", "target-trial-b"],
  });
  const targetSelection = createStrategyRevisionSelection({
    strategyId: targetCandidate.proposal.strategyId,
    kind: targetCandidate.proposal.kind,
    revisionIdentity: targetCandidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(targetCandidate),
    revisionStatusAtRun: "promoted",
    semantics: targetCandidate.proposal,
  });
  const conflictingTargetPortfolio = createTrustedStrategyPortfolio(
    TARGET_A,
    createPromotedStrategyRevisionCatalog([]),
    createPromotedDerivedStrategyCatalog([{
      candidate: targetCandidate,
      decision: targetDecision,
      selection: targetSelection,
    }]),
  );
  await assert.rejects(
    createScopeTrialBinding(scopeCandidate, TARGET_A, conflictingTargetPortfolio, value.sourceResolver),
    /same-ID|logical Strategy ID|already trusts/i,
  );

  const terminalDecision = createStrategyTrustScopeDecision({
    candidate: scopeCandidate,
    decision: "rejected",
    trialRefs: [],
  });
  const globalCandidateReader = {
    read: async () => scopeCandidate,
    readAll: async () => [scopeCandidate],
  };
  const terminalDecisionReader = {
    read: async () => terminalDecision,
    readAll: async () => [terminalDecision],
  };
  await assert.rejects(
    resolveScopeTrialBinding({
      candidateId: scopeCandidate.candidateId,
      targetProjectRoot: TARGET_A,
      targetPortfolio,
      candidateReader: globalCandidateReader,
      decisionReader: terminalDecisionReader,
      sourceResolver: value.sourceResolver,
    }),
    /terminal.*Decision/i,
  );

  await assert.rejects(
    createScopeTrialBinding(
      scopeCandidate,
      TARGET_A,
      targetPortfolio,
      { resolve: async () => { throw new Error("source namespace disappeared"); } },
    ),
    /resolution failed|disappeared/i,
  );
  await assert.rejects(
    resolveScopeTrialBinding({
      candidateId: scopeCandidate.candidateId,
      targetProjectRoot: TARGET_A,
      targetPortfolio,
      candidateReader: { read: async () => scopeCandidate, readAll: async () => [{ bad: true } as any] },
      decisionReader: { read: async () => null, readAll: async () => [] },
      sourceResolver: value.sourceResolver,
    }),
    /invalid|malformed/i,
  );
});

test("Scope Trial command values stay namespaced and the shared lease authorizes one exact Run", async (t) => {
  const value = await fixture(t);
  const scopeCandidate = createStrategyTrustScopeCandidate({
    sourceStrategy: value.source,
    candidateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    createdAt: "2026-07-08T00:00:00.000Z",
  });
  const binding = await createScopeTrialBinding(
    scopeCandidate,
    TARGET_A,
    portfolio(TARGET_A),
    value.sourceResolver,
  );
  const commandValue = scopeTrialCommandValue(scopeCandidate.candidateId);
  assert.equal(parseScopeTrialCommandValue(commandValue), scopeCandidate.candidateId);
  assert.equal(parseScopeTrialCommandValue(scopeCandidate.candidateId), null);
  assert.throws(() => parseScopeTrialCommandValue("scope:not-a-uuid"), /UUID/i);

  const runtime = new TrialRuntime();
  assert.equal(runtime.establishScope("scope-session", binding), true);
  assert.equal(runtime.pendingScopeTrial?.scopeCandidate.candidateId, scopeCandidate.candidateId);
  assert.equal(runtime.pendingTrial, null);
  assert.equal(runtime.establishDerivation("other-session", value.candidate), false);
  assert.equal(runtime.bindScope("other-session", 7), null);
  const active = runtime.bindScope("scope-session", 7);
  assert.ok(active);
  const selector = {
    strategyId: active!.revisionSelection.strategyId,
    revisionIdentity: active!.revisionSelection.revisionIdentity,
    revisionFingerprint: active!.revisionSelection.revisionFingerprint,
  };
  const resolved = runtime.resolveScopeSelector("scope-session", 7, selector, "modifier");
  assert.equal(resolved.revisionStatusAtRun, "trial");
  assert.deepEqual(resolved.semantics, {
    summary: value.candidate.proposal.summary,
    useWhen: value.candidate.proposal.useWhen,
    avoidWhen: value.candidate.proposal.avoidWhen,
    principles: value.candidate.proposal.principles,
  });
  assert.throws(
    () => runtime.resolveScopeSelector("scope-session", 7, selector, "approach"),
    /wrong.*role/i,
  );
  assert.throws(
    () => runtime.resolveScopeSelector("scope-session", 7, { ...selector, revisionFingerprint: `sha256:${"0".repeat(64)}` }, "modifier"),
    /does not match|exact selector/i,
  );
  const changed = {
    ...value.candidate,
    proposal: { ...value.candidate.proposal, summary: "Changed after activation." },
  } as StrategyDerivationCandidateV1;
  assert.throws(
    () => runtime.resolveScopeSelector("scope-session", 7, selector, "modifier", changed),
    /changed|binding/i,
  );
  runtime.clear();
  assert.equal(runtime.hasTrial, false);
});
