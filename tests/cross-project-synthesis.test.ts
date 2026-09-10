import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCrossProjectSynthesisPacket,
  formatCrossProjectSynthesisPacket,
  MAX_CROSS_PROJECT_SYNTHESIS_PACKET_RUNS,
  MAX_CROSS_PROJECT_SYNTHESIS_RUNS_PER_PROJECT,
  recomputeCrossProjectSynthesisPacketSufficiency,
  scanCrossProjectSynthesisEvidence,
  selectBoundedCrossProjectSynthesisEvidence,
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
} from "../src/strategy-decisions.ts";
import {
  createTrustedStrategyPortfolioForProjectId,
  type TrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
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

function experience(
  goal: string,
  policy: PolicySnapshot | null,
  options: {
    readonly recordedAt?: string;
    readonly exposure?: boolean;
    readonly verificationStatus?: "pending" | "failed" | "passed";
    readonly toolErrors?: number;
    readonly deniedCalls?: number;
    readonly completedBeforeRun?: boolean;
  } = {},
): RunExperience {
  const runExecution = execution({
    toolErrors: options.toolErrors ?? 0,
    deniedCalls: options.deniedCalls ?? 0,
  });
  const finalPolicyPosition = options.exposure === false ? runExecution : zeroExecution();
  const value = assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot: coherentSnapshot({ verificationStatus: options.verificationStatus ?? "pending" }),
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

function policyA(): PolicySnapshot {
  return createPolicySnapshot({ approach: "direct-action" });
}

function policyB(): PolicySnapshot {
  return createPolicySnapshot({
    approach: "explore-first",
    modifiers: ["minimal-change"],
  });
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

test("FileProjectTrustedStrategyPortfolioReader reads a foreign namespace directly without fabricating a root", async () => {
  const projectsBaseDir = await mkdtemp(join(tmpdir(), "pindie-slice-a-projects-"));
  const globalBaseDir = await mkdtemp(join(tmpdir(), "pindie-slice-a-global-"));
  try {
    const reader = new FileProjectTrustedStrategyPortfolioReader({ projectsBaseDir, globalBaseDir });
    const addressed = await reader.readProjectId(PROJECT_A);
    const expected = portfolio(PROJECT_A);
    assert.equal(addressed.projectId, PROJECT_A);
    assert.equal(addressed.fingerprint, expected.fingerprint);
    await assert.rejects(
      reader.readProjectId("not-a-project-id"),
      /canonical project identity/i,
    );
  } finally {
    await Promise.all([
      rm(projectsBaseDir, { recursive: true, force: true }),
      rm(globalBaseDir, { recursive: true, force: true }),
    ]);
  }
});
