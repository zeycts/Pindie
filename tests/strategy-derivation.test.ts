import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleRunExperience } from "../src/run-experience.ts";
import type { RunExperienceSourceRecord } from "../src/experience-store.ts";
import { evaluateRunExperience } from "../src/experience-evaluation.ts";
import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  createPromotedStrategyRevisionCatalog,
  createStrategyRevisionDecision,
} from "../src/strategy-decisions.ts";
import {
  createStrategyRevisionCandidate,
  strategyRevisionSelectionFromCandidate,
  type StrategyRevisionCandidate,
} from "../src/strategy-candidates.ts";
import {
  getSeedStrategy,
  SEED_STRATEGIES,
} from "../src/strategies.ts";
import {
  createTrustedStrategyPortfolio,
  trustedPortfolioFingerprint,
  type TrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import {
  buildDerivationPacket,
  DerivationRuntime,
  deriveDerivationSufficiency,
  finalPolicyUsesOnlyTrustedRevisions,
  formatDerivationPacket,
  selectBoundedDerivationSourceEvidence,
  selectDerivationSourceEvidence,
} from "../src/strategy-derivation.ts";
import {
  createStrategyDerivationCandidate,
  FileStrategyDerivationCandidateStore,
  strategyDerivationCandidateSemanticFingerprint,
  validateStrategyDerivationCandidateArtifact,
  validateStrategyDerivationCandidateBinding,
  type StrategyDerivationCandidateProposal,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import { getProjectId } from "../src/store.ts";
import { createPindieStrategyDerivationCandidateTool } from "../src/tools/strategy-derivation-candidate.ts";

function task(goal: string): NonNullable<import("../src/state.ts").PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The bounded check is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function coherentSnapshot(): Extract<import("../src/semantics.ts").SemanticSnapshot, { authority: "coherent" }> {
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
  };
}

function source(
  recordId: string,
  goal: string,
  policy: PolicySnapshot | null,
  recordedAt: string,
  lastActivationToolCalls = 0,
): RunExperienceSourceRecord {
  const execution = {
    toolCalls: 2,
    observations: 2,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  const declarationPosition = policy === null
    ? null
    : {
        ...execution,
        toolCalls: lastActivationToolCalls,
        observations: lastActivationToolCalls,
      };
  const experience = assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: coherentSnapshot(),
    policy: {
      finalSnapshot: policy,
      declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: declarationPosition,
      finalPolicyLastDeclaredAfter: declarationPosition,
    },
    execution,
    durationMs: 100,
    cost: 0.5,
    recordedAt,
  });
  return { recordId, experience };
}

function derivationProposal(sourceRecordIds: readonly string[]): StrategyDerivationCandidateProposal {
  return {
    strategyId: "boundary-first",
    kind: "approach",
    summary: "Name the smallest boundary before choosing a broader change.",
    useWhen: ["the requested change crosses a meaningful interface"],
    avoidWhen: ["the correction is already local and clear"],
    principles: ["make the boundary explicit", "verify the smallest coherent move"],
    sourceRecordIds,
    hypothesis: "Repeated trusted-policy Runs may expose a missing boundary-first abstraction.",
  };
}

function portfolio(): TrustedStrategyPortfolio {
  return createTrustedStrategyPortfolio(
    "/repo",
    createPromotedStrategyRevisionCatalog([]),
  );
}

function sourceRecords(): readonly RunExperienceSourceRecord[] {
  return [
    source("source-new", "goal-b", createPolicySnapshot({ approach: "explore-first" }), "2026-03-03T00:00:00.000Z"),
    source("source-middle", "goal-a", createPolicySnapshot({ approach: "direct-action", modifiers: ["minimal-change"] }), "2026-03-02T00:00:00.000Z"),
    source("source-old", "goal-a", createPolicySnapshot({ approach: "direct-action" }), "2026-03-01T00:00:00.000Z"),
  ];
}

test("trusted portfolio is deterministic, bounded, and contains only Seed trust", () => {
  const current = portfolio();
  assert.equal(current.projectId, getProjectId("/repo"));
  assert.equal(current.entries.length, SEED_STRATEGIES.length);
  assert.ok(current.entries.every((entry) => entry.origin === "seed"));
  assert.match(current.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    trustedPortfolioFingerprint(current.projectId, [...current.entries].reverse()),
    current.fingerprint,
  );
  assert.equal(
    trustedPortfolioFingerprint(current.projectId, current.entries),
    trustedPortfolioFingerprint(current.projectId, current.entries),
  );
  assert.notEqual(
    current.fingerprint,
    trustedPortfolioFingerprint("0".repeat(64), current.entries),
  );
  assert.ok(current.resolvedEntries.every((entry) => entry.semantics.summary.length <= 512));
});

test("a valid promoted Seed revision enters the trusted portfolio while rejected trust does not", () => {
  const seed = getSeedStrategy("architecture-first")!;
  const candidate = createStrategyRevisionCandidate({
    target: seed,
    candidateId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded ownership check before a cross-cutting change.",
      useWhen: ["the change spans more than one owner"],
      avoidWhen: ["the correction is local"],
      principles: ["name the owners", "verify the handoff"],
      sourceRecordIds: ["one", "two"],
      hypothesis: "A sharper ownership check may reduce rework.",
    },
  });
  const decision = createStrategyRevisionDecision({
    candidate,
    decision: "promoted",
    trialRecordIds: ["trial-one", "trial-two"],
    decidedAt: "2026-02-01T00:00:00.000Z",
  });
  const catalog = createPromotedStrategyRevisionCatalog([{
    candidate,
    decision,
    selection: strategyRevisionSelectionFromCandidate(candidate, "promoted"),
  }]);
  const current = createTrustedStrategyPortfolio("/repo", catalog);
  const promoted = current.entries.find((entry) => entry.origin === "promoted-seed-revision");
  assert.ok(promoted);
  assert.equal(promoted?.strategyId, seed.id);
  assert.equal(promoted?.revisionIdentity, candidate.candidateId);
  assert.equal(current.entries.length, SEED_STRATEGIES.length + 1);
});

test("Derivation source selection requires trusted final Policy, exposure, attribution, and excludes Trial", () => {
  const current = portfolio();
  const candidate = createStrategyRevisionCandidate({
    target: getSeedStrategy("direct-action")!,
    candidateId: "00000000-0000-4000-8000-000000000002",
    createdAt: "2026-01-01T00:00:00.000Z",
    proposal: {
      summary: "Use a bounded check before the focused move.",
      useWhen: ["the change has an observable boundary"],
      avoidWhen: ["the fix is already obvious"],
      principles: ["check first", "verify after"],
      sourceRecordIds: ["one", "two"],
      hypothesis: "A check may help.",
    },
  });
  const trialPolicy = createPolicySnapshotFromRevisions({
    approach: strategyRevisionSelectionFromCandidate(candidate, "trial"),
  });
  const records = [
    ...sourceRecords(),
    source("trial", "goal-c", trialPolicy, "2026-03-04T00:00:00.000Z"),
    source("no-policy", "goal-d", null, "2026-03-05T00:00:00.000Z"),
    source("unexposed", "goal-e", createPolicySnapshot({ approach: "direct-action" }), "2026-03-06T00:00:00.000Z", 2),
    { ...sourceRecords()[0]!, recordId: "source-new" },
  ];
  const selected = selectDerivationSourceEvidence(current, records);
  assert.deepEqual(selected.map((evaluation) => evaluation.source.recordId), [
    "source-middle", "source-old",
  ]);
  assert.ok(selected.every((evaluation) => finalPolicyUsesOnlyTrustedRevisions(evaluation, current)));
  assert.equal(finalPolicyUsesOnlyTrustedRevisions(
    evaluateRunExperience(source("trial", "goal-c", trialPolicy, "2026-03-04T00:00:00.000Z")),
    current,
  ), false);
});

test("sufficiency and bounded packet selection preserve the gate before recency fill", () => {
  const current = portfolio();
  const eligible = selectDerivationSourceEvidence(current, sourceRecords());
  const selected = selectBoundedDerivationSourceEvidence(eligible);
  assert.equal(selected.sufficiency.sufficient, true);
  assert.deepEqual(selected.shown.map((evaluation) => evaluation.source.recordId), [
    "source-new", "source-middle", "source-old",
  ]);
  assert.deepEqual(deriveDerivationSufficiency(selected.shown), {
    distinctRecordCount: 3,
    distinctExactGoalCount: 2,
    distinctPolicyProfileCount: 3,
    sufficient: true,
  });

  const packet = buildDerivationPacket("/repo", current, sourceRecords());
  assert.deepEqual(packet.sourceRecordIds, ["source-new", "source-middle", "source-old"]);
  assert.equal(packet.evidence.omittedRunCount, 0);
  const rendered = formatDerivationPacket(packet);
  assert.match(rendered, /<PINDIE_DERIVATION_PACKET>/);
  assert.match(rendered, /optional missing-abstraction hypothesis/i);
  assert.doesNotMatch(rendered, /transcript|chain.of.thought|raw tool results|embedding results|task taxonomy/i);
});

test("Derivation runtime is one pending/active, exact-session, exact-generation lease", () => {
  const runtime = new DerivationRuntime();
  const current = portfolio();
  const packet = buildDerivationPacket("/repo", current, sourceRecords());
  assert.equal(runtime.establish("session-a", current, packet), true);
  assert.equal(runtime.establish("session-b", current, packet), false);
  assert.equal(runtime.bind("session-b", 1), null);
  const lease = runtime.bind("session-a", 4);
  assert.ok(lease);
  assert.equal(runtime.activeFor("session-a", 4)?.attemptId, lease?.attemptId);
  assert.equal(runtime.activeFor("session-a", 5), null);
  assert.equal(runtime.isActiveForGeneration(4), true);
  assert.equal(runtime.consume(lease!.attemptId), true);
  assert.equal(runtime.hasDerivation, false);
  assert.equal(runtime.consume(lease!.attemptId), false);
});

test("Derivation Candidate validation is immutable, project-bound, collision-safe, and semantically fingerprinted", () => {
  const current = portfolio();
  const proposal = derivationProposal(["source-new", "source-middle", "source-old"]);
  const candidate = createStrategyDerivationCandidate({
    projectId: current.projectId,
    basePortfolio: current,
    proposal,
    candidateId: "00000000-0000-4000-8000-000000000003",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.basePortfolio), true);
  assert.equal(Object.isFrozen(candidate.basePortfolio.entries), true);
  assert.equal(Object.isFrozen(candidate.proposal), true);
  assert.match(strategyDerivationCandidateSemanticFingerprint(candidate), /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    strategyDerivationCandidateSemanticFingerprint(candidate),
    strategyDerivationCandidateSemanticFingerprint({
      ...candidate,
      candidateId: "00000000-0000-4000-8000-000000000004",
      createdAt: "2027-01-01T00:00:00.000Z",
      evidence: { sourceRecordIds: ["other-a", "other-b", "other-c"] },
      hypothesis: "Different hypothesis prose.",
    }),
  );
  assert.doesNotThrow(() => validateStrategyDerivationCandidateArtifact(candidate));
  assert.doesNotThrow(() => validateStrategyDerivationCandidateBinding(candidate, "/repo", current));
  assert.throws(() => createStrategyDerivationCandidate({
    projectId: current.projectId,
    basePortfolio: current,
    proposal: { ...proposal, strategyId: "direct-action" },
  }), /already belongs/);
  assert.throws(() => createStrategyDerivationCandidate({
    projectId: current.projectId,
    basePortfolio: current,
    proposal: {
      ...proposal,
      strategyId: "different-id",
      kind: "approach",
      summary: SEED_STRATEGIES.find((strategy) => strategy.id === "direct-action")!.summary,
      useWhen: ["the request is concrete and the relevant code path is known"],
      avoidWhen: ["the cause or affected surface is still uncertain"],
      principles: ["keep the move focused", "let current project evidence guide the change", "verify the result against the task"],
    },
  }), /duplicate/);
  assert.throws(() => validateStrategyDerivationCandidateArtifact({
    ...candidate,
    proposal: { ...candidate.proposal, forged: true },
  }), /artifact fields|proposal fields/);
  const otherPortfolio = createTrustedStrategyPortfolio("/other", createPromotedStrategyRevisionCatalog([]));
  assert.throws(() => validateStrategyDerivationCandidateBinding(candidate, "/other", otherPortfolio), /project|binding/i);
});

test("Derivation Candidate store is project-local, immutable, and atomic", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-derivation-candidates-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const current = portfolio();
  const candidate = createStrategyDerivationCandidate({
    projectId: current.projectId,
    basePortfolio: current,
    proposal: derivationProposal(["source-new", "source-middle", "source-old"]),
    candidateId: "00000000-0000-4000-8000-000000000005",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const store = new FileStrategyDerivationCandidateStore({ baseDir });
  await store.save("/repo", candidate);
  const directory = store.strategyDerivationCandidateDirectory("/repo");
  assert.deepEqual(await readdir(directory), [`${candidate.candidateId}.json`]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, `${candidate.candidateId}.json`))), candidate);
  await assert.rejects(store.save("/repo", candidate), /already exists/);
  assert.equal(await store.read("/other", candidate.candidateId), null);
  assert.deepEqual(await store.readAll("/repo"), [candidate]);
});

test("Derivation Candidate tool accepts only the packet proposal, revalidates fresh facts, and consumes once", async () => {
  const current = portfolio();
  const packet = buildDerivationPacket("/repo", current, sourceRecords());
  const runtime = new DerivationRuntime();
  assert.equal(runtime.establish("session", current, packet), true);
  assert.ok(runtime.bind("session", 7));
  const saved: StrategyDerivationCandidateV1[] = [];
  const tool = createPindieStrategyDerivationCandidateTool({
    derivation: runtime,
    experienceReader: {
      read: async () => ({ records: sourceRecords(), loadedRecords: 3, unsupportedSchema: 0, invalid: 0 }),
    },
    candidateStore: {
      save: async (_root, candidate) => { saved.push(candidate); },
    },
    getProjectRoot: () => "/repo",
    getAgentRunGeneration: () => 7,
    loadPortfolio: async () => current,
  });
  const input = derivationProposal(packet.sourceRecordIds);
  const result = await tool.execute(
    "derive-candidate",
    input,
    undefined,
    undefined,
    { sessionManager: { getSessionId: () => "session" } } as never,
  ) as { content: Array<{ text?: string }>; details: { candidateId: string } };
  assert.match(result.content[0]?.text ?? "", /Candidate Derivation Candidate created|Candidate created/);
  assert.equal(saved.length, 1);
  assert.equal(runtime.hasDerivation, false);
  await assert.rejects(
    tool.execute("second", input, undefined, undefined, { sessionManager: { getSessionId: () => "session" } } as never),
    /without a live \/derive lease/i,
  );
});
