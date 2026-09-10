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
  GlobalDerivationRuntime,
} from "../src/strategy-global-derivation.ts";
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
import { createPindieStrategySynthesisCandidateTool } from "../src/tools/strategy-synthesis-candidate.ts";

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

test("Global Derivation Runtime reserves one exact Session/root and generation-bound attempt", () => {
  const runtime = new GlobalDerivationRuntime();
  const reservation = runtime.reserve("session-a", "/repo");
  assert.ok(reservation);
  assert.equal(runtime.reserve("session-b", "/other"), null);
  assert.equal(runtime.isCurrent(reservation!), true);
  assert.equal(runtime.isCurrent({ ...reservation!, sessionId: "session-b" }), false);
  assert.equal(runtime.bind(reservation!, "session-b", "/repo", 1), null);

  const lease = runtime.bind(reservation!, "session-a", "/repo", 7);
  assert.ok(lease);
  assert.equal(runtime.hasPending, false);
  assert.equal(runtime.hasActive, true);
  assert.equal(runtime.isActiveForGeneration(7), true);
  assert.equal(runtime.isActiveForGeneration(8), false);
  assert.equal(runtime.activeFor("session-a", "/repo", 7)?.attemptId, lease?.attemptId);
  assert.equal(runtime.activeFor("session-a", "/repo", 8), null);
  runtime.clear();
  assert.equal(runtime.hasAttempt, false);
});

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

test("Synthesis Candidate tool resolves exact packet handles, publishes once, and never rereads discovery sources", async () => {
  const packet = await packetFixture();
  const active = binding(packet);
  let publication: "idle" | "publishing" | "published" = "idle";
  const saved: StrategySynthesisCandidateV1[] = [];
  const runtime: StrategySynthesisCandidateRuntimeAccess = {
    activeFor: (sessionId, invocationRoot, generation) =>
      sessionId === active.sessionId && invocationRoot === active.invocationRoot && generation === active.agentRunGeneration
        ? active
        : null,
    claimPublication: (attemptId) => {
      if (attemptId !== active.attemptId || publication !== "idle") return false;
      publication = "publishing";
      return true;
    },
    releasePublication: (attemptId) => {
      if (attemptId === active.attemptId && publication === "publishing") publication = "idle";
    },
    completePublication: (attemptId) => {
      if (attemptId !== active.attemptId || publication !== "publishing") return false;
      publication = "published";
      return true;
    },
  };
  const tool = createPindieStrategySynthesisCandidateTool({
    runtime,
    candidateStore: { save: async (candidate) => { saved.push(candidate); } },
    getProjectRoot: () => "/repo",
    getAgentRunGeneration: () => active.agentRunGeneration,
  });
  const input = {
    ...proposal(packet),
    evidenceHandles: ["E1", "E2", "E3"],
  };
  const result = await tool.execute("create-synthesis", input, undefined, undefined, toolContext()) as {
    content: Array<{ text?: string }>;
    details: { candidateId: string; semanticFingerprint: string; artifactFingerprint: string };
  };
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.candidateId, CANDIDATE_ID);
  assert.deepEqual(
    new Set(saved[0]?.evidence.sourceRefs.map((ref) => `${ref.projectId}/${ref.recordId}/${ref.recordFingerprint}`)),
    new Set(packet.sourceRefs.map((ref) => `${ref.projectId}/${ref.recordId}/${ref.recordFingerprint}`)),
  );
  assert.equal(result.details.candidateId, CANDIDATE_ID);
  assert.match(result.content[0]?.text ?? "", /inactive and immutable/i);
  assert.match(result.details.semanticFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.details.artifactFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(publication, "published");

  await assert.rejects(
    tool.execute("create-synthesis-again", input, undefined, undefined, toolContext()),
    /already published or is publishing/i,
  );
  await assert.rejects(
    tool.execute("bad-handle", { ...input, evidenceHandles: ["E1", "E2", "E9"] }, undefined, undefined, toolContext()),
    /not an exact evidence handle/i,
  );
  assert.equal(saved.length, 1);
});

test("Synthesis Candidate publication reconciles ambiguous immutable writes without changing identity", async () => {
  const packet = await packetFixture();
  const input = {
    ...proposal(packet),
    evidenceHandles: ["E1", "E2", "E3"],
  };

  const publicationRuntime = () => {
    let publication: "idle" | "publishing" | "published" = "idle";
    const active = binding(packet);
    const runtime: StrategySynthesisCandidateRuntimeAccess = {
      activeFor: (sessionId, invocationRoot, generation) =>
        sessionId === active.sessionId && invocationRoot === active.invocationRoot && generation === active.agentRunGeneration
          ? active
          : null,
      claimPublication: (attemptId) => {
        if (attemptId !== active.attemptId || publication !== "idle") return false;
        publication = "publishing";
        return true;
      },
      releasePublication: (attemptId) => {
        if (attemptId === active.attemptId && publication === "publishing") publication = "idle";
      },
      completePublication: (attemptId) => {
        if (attemptId !== active.attemptId || publication !== "publishing") return false;
        publication = "published";
        return true;
      },
    };
    return {
      active,
      runtime,
      publication: () => publication,
    };
  };
  const makeTool = (
    runtime: StrategySynthesisCandidateRuntimeAccess,
    candidateStore: StrategySynthesisCandidateStore,
  ) => createPindieStrategySynthesisCandidateTool({
    runtime,
    candidateStore,
    getProjectRoot: () => "/repo",
    getAgentRunGeneration: () => 7,
  });

  {
    const { runtime, publication } = publicationRuntime();
    const originalSaveError = new Error("injected save failure");
    const store: StrategySynthesisCandidateStore = {
      read: async () => null,
      readAll: async () => [],
      save: async () => { throw originalSaveError; },
    };
    await assert.rejects(
      makeTool(runtime, store).execute("save-fails", input, undefined, undefined, toolContext()),
      (error: unknown) => error === originalSaveError,
    );
    assert.equal(publication(), "idle");
  }

  {
    const { runtime, active, publication } = publicationRuntime();
    const durable = new Map<string, StrategySynthesisCandidateV1>();
    const saved: StrategySynthesisCandidateV1[] = [];
    const store: StrategySynthesisCandidateStore = {
      read: async (candidateId) => durable.get(candidateId) ?? null,
      readAll: async () => [...durable.values()],
      save: async (candidate) => {
        saved.push(candidate);
        durable.set(candidate.candidateId, structuredClone(candidate));
        throw new Error("persisted before injected transport failure");
      },
    };
    const result = await makeTool(runtime, store).execute(
      "persist-then-throw",
      input,
      undefined,
      undefined,
      toolContext(),
    ) as { details: { candidateId: string } };
    assert.equal(result.details.candidateId, active.candidateId);
    assert.equal(publication(), "published");
    assert.equal(saved.length, 1);
    assert.equal(durable.size, 1);
    assert.deepEqual([...durable.keys()], [active.candidateId]);

    await assert.rejects(
      makeTool(runtime, store).execute("retry-after-reconcile", input, undefined, undefined, toolContext()),
      /already published or is publishing/i,
    );
    assert.equal(saved.length, 1);
    assert.deepEqual([...durable.keys()], [active.candidateId]);
  }

  {
    const { runtime, active, publication } = publicationRuntime();
    const conflicting = createStrategySynthesisCandidate({
      proposal: { ...proposal(packet), summary: "A different artifact occupies this identity." },
      sourceRefs: packet.sourceRefs.slice(0, 3),
      derivationReceipt: packet,
      candidateId: active.candidateId,
      createdAt: active.createdAt,
    });
    const store: StrategySynthesisCandidateStore = {
      read: async () => conflicting,
      readAll: async () => [conflicting],
      save: async () => { throw new Error("ambiguous write with conflicting occupant"); },
    };
    await assert.rejects(
      makeTool(runtime, store).execute("conflicting-occupant", input, undefined, undefined, toolContext()),
      /failed closed|does not exactly match/i,
    );
    assert.equal(publication(), "idle");
  }

  {
    const { runtime, publication } = publicationRuntime();
    const store: StrategySynthesisCandidateStore = {
      read: async () => { throw new Error("candidate read unavailable"); },
      readAll: async () => [],
      save: async () => { throw new Error("ambiguous save"); },
    };
    await assert.rejects(
      makeTool(runtime, store).execute("reconciliation-read-fails", input, undefined, undefined, toolContext()),
      /persistence\/reconciliation failed.*could not read Candidate/i,
    );
    assert.equal(publication(), "idle");
  }

  {
    const { runtime, active, publication } = publicationRuntime();
    const durable = new Map<string, StrategySynthesisCandidateV1>();
    const savedIds: string[] = [];
    let saves = 0;
    const store: StrategySynthesisCandidateStore = {
      read: async (candidateId) => durable.get(candidateId) ?? null,
      readAll: async () => [...durable.values()],
      save: async (candidate) => {
        saves += 1;
        savedIds.push(candidate.candidateId);
        if (saves === 1) throw new Error("first attempt did not become durable");
        durable.set(candidate.candidateId, structuredClone(candidate));
        throw new Error("retry persisted before injected transport failure");
      },
    };
    await assert.rejects(
      makeTool(runtime, store).execute("retry-first-fails", input, undefined, undefined, toolContext()),
      /first attempt did not become durable/i,
    );
    assert.equal(publication(), "idle");
    const result = await makeTool(runtime, store).execute(
      "retry-reconciles",
      input,
      undefined,
      undefined,
      toolContext(),
    ) as { details: { candidateId: string } };
    assert.equal(result.details.candidateId, active.candidateId);
    assert.equal(publication(), "published");
    assert.deepEqual(savedIds, [active.candidateId, active.candidateId]);
    assert.equal(durable.size, 1);
    assert.deepEqual([...durable.keys()], [active.candidateId]);
  }
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
