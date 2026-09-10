import {
  buildCrossProjectSynthesisPacket,
  scanCrossProjectSynthesisEvidence,
} from "../src/cross-project-synthesis.ts";
import type {
  RunExperienceProjectReader,
  RunExperienceSourceRecord,
} from "../src/experience-store.ts";
import {
  createPolicySnapshot,
  type PolicySnapshot,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import {
  createPromotedStrategyRevisionCatalog,
} from "../src/strategy-decisions.ts";
import {
  createStrategySynthesisCandidate,
  type StrategySynthesisCandidateV1,
} from "../src/strategy-synthesis-candidates.ts";
import {
  createTrustedStrategyPortfolioForProjectId,
} from "../src/strategy-portfolio.ts";
import { getProjectId } from "../src/store.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";

function task(goal: string): NonNullable<PindieState["task"]> {
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

function experience(
  goal: string,
  policy: PolicySnapshot,
  recordedAt: string,
): RunExperience {
  const zero = {
    toolCalls: 0,
    observations: 0,
    consequentialCalls: 0,
    projectMutationEffectCalls: 0,
    verificationCalls: 0,
    toolErrors: 0,
    deniedCalls: 0,
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
  return assembleRunExperience({
    task: task(goal),
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot,
    policy: {
      finalSnapshot: policy,
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: zero,
      finalPolicyLastDeclaredAfter: zero,
    },
    execution: { ...zero, toolCalls: 1, observations: 1 },
    durationMs: 10,
    cost: 0.1,
    recordedAt,
  });
}

export interface SynthesisTrialFixture {
  readonly candidate: StrategySynthesisCandidateV1;
  readonly packet: Awaited<ReturnType<typeof buildPacket>>;
}

async function buildPacket() {
  const projectA = getProjectId("/synthesis-trial-source-a");
  const projectB = getProjectId("/synthesis-trial-source-b");
  const records = new Map<string, readonly RunExperienceSourceRecord[]>([
    [projectA, [
      {
        recordId: "11111111-1111-4111-8111-111111111111.json",
        experience: experience(
          "synthesis source alpha",
          createPolicySnapshot({ approach: "direct-action" }),
          "2026-01-01T00:00:00.000Z",
        ),
      },
      {
        recordId: "22222222-2222-4222-8222-222222222222.json",
        experience: experience(
          "synthesis source beta",
          createPolicySnapshot({ approach: "explore-first", modifiers: ["minimal-change"] }),
          "2026-01-02T00:00:00.000Z",
        ),
      },
    ]],
    [projectB, [{
      recordId: "33333333-3333-4333-8333-333333333333.json",
      experience: experience(
        "synthesis source gamma",
        createPolicySnapshot({ approach: "direct-action" }),
        "2026-01-03T00:00:00.000Z",
      ),
    }]],
  ]);
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => [projectA, projectB],
    readProjectId: async (projectId) => {
      const projectRecords = records.get(projectId) ?? [];
      return {
        records: projectRecords,
        loadedRecords: projectRecords.length,
        unsupportedSchema: 0,
        invalid: 0,
      };
    },
  };
  const trustedPortfolioReader: ProjectTrustedStrategyPortfolioReader = {
    readProjectId: async (projectId) => createTrustedStrategyPortfolioForProjectId(
      projectId,
      createPromotedStrategyRevisionCatalog([]),
    ),
  };
  const scan = await scanCrossProjectSynthesisEvidence({
    experienceReader,
    trustedPortfolioReader,
  });
  return buildCrossProjectSynthesisPacket({
    scan,
    capturedAt: "2026-01-04T00:00:00.000Z",
  });
}

export async function makeSynthesisTrialFixture(
  candidateId = "00000000-0000-4000-8000-000000000031",
  overrides: Partial<{
    readonly strategyId: string;
    readonly summary: string;
  }> = {},
): Promise<SynthesisTrialFixture> {
  const packet = await buildPacket();
  const candidate = createStrategySynthesisCandidate({
    proposal: {
      strategyId: overrides.strategyId ?? "synthesis-boundary",
      kind: "approach",
      summary: overrides.summary ?? "Compare bounded project evidence before choosing a reusable abstraction.",
      useWhen: ["related work spans multiple project namespaces"],
      avoidWhen: ["one local correction already explains the problem"],
      principles: ["keep comparisons factual", "verify the smallest coherent hypothesis"],
      hypothesis: "Distributed trusted-policy evidence may expose a reusable boundary.",
    },
    sourceRefs: packet.sourceRefs,
    derivationReceipt: packet,
    candidateId,
    createdAt: "2026-01-05T00:00:00.000Z",
  });
  return { candidate, packet };
}
