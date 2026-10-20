import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCrossProjectSynthesisPacket,
  crossProjectSynthesisEvidenceHandle,
  crossProjectSynthesisEvidenceHandleIndex,
  scanCrossProjectSynthesisEvidence,
  type CrossProjectSynthesisEligibleRun,
  type CrossProjectSynthesisPacket,
} from "../src/cross-project-synthesis.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceReadResult,
  RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import {
  createPolicySnapshot,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import {
  createStrategySynthesisCandidate,
  FileStrategySynthesisCandidateStore,
  strategySynthesisCandidateArtifactFingerprint,
  strategySynthesisCandidateSemanticFingerprint,
  validateStrategySynthesisCandidateArtifact,
  type StrategySynthesisCandidateProposal,
  type StrategySynthesisCandidateRunBinding,
  type StrategySynthesisCandidateRuntimeAccess,
  type StrategySynthesisCandidateStore,
  type StrategySynthesisCandidateV1,
} from "../src/strategy-synthesis-candidates.ts";
import { createTrustedStrategyPortfolioForProjectId } from "../src/strategy-portfolio.ts";
import { createPromotedStrategyRevisionCatalog } from "../src/strategy-decisions.ts";
import { getProjectId } from "../src/store.ts";

const PROJECT_A = getProjectId("/synthesis-candidate-project-a");
const PROJECT_B = getProjectId("/synthesis-candidate-project-b");
const RECORD_A1 = "11111111-1111-4111-8111-111111111111.json";
const RECORD_A2 = "22222222-2222-4222-8222-222222222222.json";
const RECORD_B1 = "33333333-3333-4333-8333-333333333333.json";
const CANDIDATE_ID = "44444444-4444-4444-8444-444444444444";

function zeroExecution() {
  return {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    deniedCalls: 0,
  } as const;
}

function task(goal: string): NonNullable<import("../src/state.ts").PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "criterion", description: "The evidence remains factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function source(
  recordId: string,
  goal: string,
  policy: PolicySnapshot,
  recordedAt: string,
): RunExperienceSourceRecord {
  const execution = {
    toolCalls: 1,
    observations: 1,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
  };
  const value = assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: {
      authority: "coherent",
      taskStatus: "active",
      verificationStatus: "pending",
      hasBlockers: false,
      hasQuestions: false,
      completionReady: false,
      taskRelation: "preexisting_untouched",
      completionRelation: "not_completed",
      gateRelation: "none",
    },
    policy: {
      finalSnapshot: policy,
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: zeroExecution(),
      finalPolicyLastDeclaredAfter: zeroExecution(),
    },
    execution,
    durationMs: 100,
    cost: 0.5,
    recordedAt,
  });
  return { recordId, experience: value };
}

function synthesisRecords(): ReadonlyMap<string, readonly RunExperienceSourceRecord[]> {
  return new Map([
    [PROJECT_A, [
      source(RECORD_A1, "synthesis goal alpha", createPolicySnapshot({ approach: "direct-action" }), "2026-08-01T00:00:00.000Z"),
      source(RECORD_A2, "synthesis goal beta", createPolicySnapshot({ approach: "explore-first", modifiers: ["minimal-change"] }), "2026-08-02T00:00:00.000Z"),
    ]],
    [PROJECT_B, [
      source(RECORD_B1, "synthesis goal gamma", createPolicySnapshot({ approach: "direct-action" }), "2026-08-03T00:00:00.000Z"),
    ]],
  ]);
}

function synthesisReaders(
  records: ReadonlyMap<string, readonly RunExperienceSourceRecord[]> = synthesisRecords(),
  projectIds: readonly string[] = [PROJECT_A, PROJECT_B],
): {
  readonly experienceReader: RunExperienceProjectReader;
  readonly trustReader: { readProjectId(projectId: string): Promise<ReturnType<typeof createTrustedStrategyPortfolioForProjectId>> };
} {
  return {
    experienceReader: {
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
    },
    trustReader: {
      readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
        projectId,
        createPromotedStrategyRevisionCatalog([]),
      ),
    },
  };
}

function packetFixture(): CrossProjectSynthesisPacket {
  const policyA = createPolicySnapshot({ approach: "direct-action" });
  const policyB = createPolicySnapshot({ approach: "explore-first", modifiers: ["minimal-change"] });
  const evaluation = (recordId: string, goal: string, policy: PolicySnapshot, recordedAt: string) => ({
    attributionEligible: true,
    source: { recordId, recordedAt, taskGoal: goal },
    policy: {
      finalSnapshot: policy,
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclarationProgress: 0,
      finalPolicyLastActivationProgress: 0,
      finalPolicyExposureCalls: 1,
      finalPolicyExposureRatio: 1,
    },
    execution: {
      toolCalls: 1,
      toolErrors: 0,
      deniedCalls: 0,
      observationRatio: 1,
      consequentialRatio: 0,
      toolErrorRatio: 0,
      deniedCallRatio: 0,
    },
    outcome: {
      verificationPassed: false,
      completedDuringRun: false,
      hasBlockers: false,
      hasQuestions: false,
      humanGateOpen: false,
    },
    metrics: { durationMs: 100, cost: 0.5 },
  });
  const run = (projectId: string, recordId: string, goal: string, policy: PolicySnapshot, recordedAt: string, fingerprint: string): CrossProjectSynthesisEligibleRun => ({
    ref: { projectId, recordId, recordFingerprint: `sha256:${fingerprint.repeat(64)}` },
    evaluation: evaluation(recordId, goal, policy, recordedAt),
  });
  const eligible = [
    run(PROJECT_A, RECORD_A1, "synthesis goal alpha", policyA, "2026-08-01T00:00:00.000Z", "a"),
    run(PROJECT_A, RECORD_A2, "synthesis goal beta", policyB, "2026-08-02T00:00:00.000Z", "b"),
    run(PROJECT_B, RECORD_B1, "synthesis goal gamma", policyA, "2026-08-03T00:00:00.000Z", "c"),
  ];
  const portfolio = (projectId: string) => createTrustedStrategyPortfolioForProjectId(
    projectId,
    createPromotedStrategyRevisionCatalog([]),
  );
  return buildCrossProjectSynthesisPacket({
    scan: {
      projectIds: [PROJECT_A, PROJECT_B],
      eligible,
      inventory: {
        projectCount: 2,
        loadedRecordCount: 3,
        unsupportedSchemaCount: 0,
        invalidRecordCount: 0,
        duplicateRecordLocatorCount: 0,
        validUniqueRecordCount: 3,
        eligibleRunCount: 3,
        ineligibleRunCount: 0,
        projects: [
          { projectId: PROJECT_A, loadedRecordCount: 2, unsupportedSchemaCount: 0, invalidRecordCount: 0, duplicateRecordLocatorCount: 0, validUniqueRecordCount: 2, eligibleRunCount: 2, ineligibleRunCount: 0, trustAvailable: true, trustFailure: null },
          { projectId: PROJECT_B, loadedRecordCount: 1, unsupportedSchemaCount: 0, invalidRecordCount: 0, duplicateRecordLocatorCount: 0, validUniqueRecordCount: 1, eligibleRunCount: 1, ineligibleRunCount: 0, trustAvailable: true, trustFailure: null },
        ],
      },
      projectTrust: [
        { projectId: PROJECT_A, portfolio: portfolio(PROJECT_A) },
        { projectId: PROJECT_B, portfolio: portfolio(PROJECT_B) },
      ],
    },
    capturedAt: "2026-08-20T00:00:00.000Z",
  });
}

function proposal(packet: CrossProjectSynthesisPacket): StrategySynthesisCandidateProposal {
  return {
    strategyId: "cross-project-boundary",
    kind: "approach",
    summary: "Compare bounded evidence before choosing a missing abstraction.",
    useWhen: ["several project namespaces expose related work"],
    avoidWhen: ["one local correction already explains the problem"],
    principles: ["keep comparisons factual", "verify the smallest coherent hypothesis"],
    hypothesis: "Distributed trusted-policy evidence may reveal a reusable boundary that no one project exposes alone.",
  };
}

function binding(
  packet: CrossProjectSynthesisPacket,
  overrides: Partial<StrategySynthesisCandidateRunBinding> = {},
): StrategySynthesisCandidateRunBinding {
  return Object.freeze({
    attemptId: "attempt-synthesis",
    sessionId: "session-synthesis",
    invocationRoot: "/repo",
    projectId: getProjectId("/repo"),
    agentRunGeneration: 7,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-08-21T00:00:00.000Z",
    packet,
    ...overrides,
  });
}

function toolContext(sessionId = "session-synthesis") {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as never;
}

test("Strategy Synthesis Candidate is strict, immutable, packet-bound, and has distinct fingerprints", async () => {
  const packet = await packetFixture();
  const candidate = createStrategySynthesisCandidate({
    proposal: proposal(packet),
    sourceRefs: packet.sourceRefs.slice(0, 3),
    derivationReceipt: packet,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-08-21T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(candidate).sort(), [
    "candidateId", "candidateType", "createdAt", "derivationReceipt", "evidence",
    "hypothesis", "proposal", "schemaVersion",
  ].sort());
  assert.equal(candidate.candidateType, "cross-project-synthesis");
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.proposal), true);
  assert.equal(Object.isFrozen(candidate.evidence.sourceRefs), true);
  assert.equal(Object.isFrozen(candidate.derivationReceipt), true);
  assert.equal(Object.isFrozen(candidate.derivationReceipt.evidence.runs), true);
  assert.doesNotThrow(() => validateStrategySynthesisCandidateArtifact(candidate));
  assert.doesNotThrow(() => validateStrategySynthesisCandidateArtifact({
    ...candidate,
    createdAt: "2026-08-21T00:00:00.000Z",
  }));
  assert.throws(() => validateStrategySynthesisCandidateArtifact({
    ...candidate,
    createdAt: "2026-08-21T00:00:00Z",
  }), /canonical ISO/i);
  assert.throws(() => validateStrategySynthesisCandidateArtifact({
    ...candidate,
    createdAt: "not-a-timestamp",
  }), /valid timestamp/i);
  assert.match(strategySynthesisCandidateSemanticFingerprint(candidate), /^sha256:[0-9a-f]{64}$/);
  assert.match(strategySynthesisCandidateArtifactFingerprint(candidate), /^sha256:[0-9a-f]{64}$/);

  const changedHypothesis = createStrategySynthesisCandidate({
    proposal: { ...proposal(packet), hypothesis: "A different bounded hypothesis." },
    sourceRefs: packet.sourceRefs.slice(0, 3),
    derivationReceipt: packet,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(
    strategySynthesisCandidateSemanticFingerprint(candidate),
    strategySynthesisCandidateSemanticFingerprint(changedHypothesis),
  );
  assert.notEqual(
    strategySynthesisCandidateArtifactFingerprint(candidate),
    strategySynthesisCandidateArtifactFingerprint(changedHypothesis),
  );

  assert.throws(() => validateStrategySynthesisCandidateArtifact({
    ...candidate,
    forged: true,
  } as unknown), /artifact fields/i);
  assert.throws(() => createStrategySynthesisCandidate({
    proposal: { ...proposal(packet), strategyId: "direct-action" },
    sourceRefs: packet.sourceRefs.slice(0, 3),
    derivationReceipt: packet,
  }), /trusted Strategy/i);
  assert.throws(() => createStrategySynthesisCandidate({
    proposal: { ...proposal(packet), strategyId: "same-semantics" },
    sourceRefs: packet.sourceRefs.slice(0, 2),
    derivationReceipt: packet,
  }), /between 3 and 8 refs/i);
  assert.throws(() => validateStrategySynthesisCandidateArtifact({
    ...candidate,
    evidence: { sourceRefs: [...candidate.evidence.sourceRefs].reverse() },
  } as unknown), /sorted|fingerprint|sourceRefs/i);
});

test("Strategy Synthesis Candidate store is global, immutable, strict, and create-without-replacement", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-synthesis-candidates-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const packet = await packetFixture();
  const candidate = createStrategySynthesisCandidate({
    proposal: proposal(packet),
    sourceRefs: packet.sourceRefs.slice(0, 3),
    derivationReceipt: packet,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  const store = new FileStrategySynthesisCandidateStore({ baseDir });
  await store.save(candidate);
  assert.equal(store.candidateDirectory(), join(baseDir, "strategy-synthesis-candidates"));
  assert.deepEqual(await readdir(store.candidateDirectory()), [`${CANDIDATE_ID}.json`]);
  assert.deepEqual(JSON.parse(await readFile(join(store.candidateDirectory(), `${CANDIDATE_ID}.json`))), candidate);
  assert.deepEqual(await store.readAll(), [candidate]);
  await assert.rejects(store.save(candidate), /already exists/i);
  assert.equal(await store.read("55555555-5555-4555-8555-555555555555"), null);
  await assert.rejects(store.read("not-a-candidate"), /canonical lowercase UUID/i);
});

test("Synthesis Candidate store observes cancellation before the final hard link", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-synthesis-candidate-cancel-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const packet = await packetFixture();
  const candidate = createStrategySynthesisCandidate({
    proposal: proposal(packet),
    sourceRefs: packet.sourceRefs.slice(0, 3),
    derivationReceipt: packet,
    candidateId: "55555555-5555-4555-8555-555555555555",
    createdAt: "2026-08-21T00:00:00.000Z",
  });
  const controller = new AbortController();
  const store = new FileStrategySynthesisCandidateStore({
    baseDir,
    beforeCommit: () => controller.abort(),
  });
  await assert.rejects(store.save(candidate, controller.signal));
  assert.deepEqual(await readdir(store.candidateDirectory()), []);
  assert.equal(await store.read(candidate.candidateId), null);
});

test("packet evidence handles are canonical and bounded", () => {
  assert.equal(crossProjectSynthesisEvidenceHandle(0), "E1");
  assert.equal(crossProjectSynthesisEvidenceHandle(7), "E8");
  assert.equal(crossProjectSynthesisEvidenceHandleIndex("E1"), 0);
  assert.equal(crossProjectSynthesisEvidenceHandleIndex("E8"), 7);
  for (const value of ["E0", "E9", "e1", "E01", "E1x", "source-one"]) {
    assert.equal(crossProjectSynthesisEvidenceHandleIndex(value), null, value);
  }
  assert.throws(() => crossProjectSynthesisEvidenceHandle(-1), /bounds/i);
});
