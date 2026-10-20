import assert from "node:assert/strict";
import test from "node:test";import type { RunExperienceProjectReader, RunExperienceSourceRecord } from "../src/experience-store.ts";
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
import { getProjectId } from "../src/store.ts";import { createStrategySynthesisDecision, readSynthesisTrustedGlobalArtifacts } from "../src/strategy-synthesis-decisions.ts";import { strategySynthesisCandidateSemanticFingerprint, type StrategySynthesisCandidateV1 } from "../src/strategy-synthesis-candidates.ts";
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
