import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCrossProjectExperienceRef,
  MAX_CROSS_PROJECT_EXPERIENCE_REFS,
  resolveCrossProjectExperienceRef,
  type CrossProjectExperienceRefV1,
} from "../src/cross-project-experience.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
  type RunExperienceExecution,
} from "../src/run-experience.ts";
import {
  FileRunExperienceReader,
  type RunExperienceProjectReader,
  type RunExperienceReadResult,
  type RunExperienceSourceRecord,
} from "../src/experience-store.ts";
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
} from "../src/strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import {
  createStrategyTrustScopeCandidate,
  type StrategyTrustScopeCandidateReader,
  type StrategyTrustScopeCandidateV1,
} from "../src/strategy-trust-scope-candidates.ts";
import {
  createStrategyTrustScopeDecision,
  type StrategyTrustScopeDecisionReader,
  type StrategyTrustScopeDecisionV1,
} from "../src/strategy-trust-scope-decisions.ts";
import {
  buildScopeTrialReviewCommandProjection,
  deriveStrategyTrustScopeTrialReview,
  filterScopeTrialReviewCommandOptions,
  FileScopeProjectTrustReader,
  formatStrategyTrustScopeTrialReview,
  MAX_SCOPE_REVIEW_RECORD_DETAILS,
  parseScopeTrialReviewCommandValue,
  scopeTrialReviewCommandValue,
  type ScopeProjectTrustReader,
  type ScopeProjectTrustSnapshot,
} from "../src/strategy-trust-scope-review.ts";
import {
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
  type PolicySnapshot,
} from "../src/policy.ts";
import { getProjectId } from "../src/store.ts";
import type { PindieState } from "../src/state.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { StrategyTrustScopeSourceResolver } from "../src/strategy-trust-scope-resolution.ts";

const SOURCE_ROOT = "/scope-review-source";
const TARGET_A_ROOT = "/scope-review-target-a";
const TARGET_B_ROOT = "/scope-review-target-b";
const SOURCE_CANDIDATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPE_CANDIDATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function task(): NonNullable<PindieState["task"]> {
  return {
    goal: "Review cross-project evidence",
    constraints: [],
    successCriteria: [{ id: "c1", description: "The review remains factual" }],
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
    toolCalls: 3,
    observations: 1,
    consequentialCalls: 2,
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

function sourceCandidate(): StrategyDerivationCandidateV1 {
  const portfolio = createTrustedStrategyPortfolio(
    SOURCE_ROOT,
    createPromotedStrategyRevisionCatalog([]),
  );
  return createStrategyDerivationCandidate({
    projectId: portfolio.projectId,
    basePortfolio: portfolio,
    candidateId: SOURCE_CANDIDATE_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: {
      strategyId: "boundary-first",
      kind: "modifier",
      summary: "Make the smallest ownership boundary explicit before implementation.",
      useWhen: ["the requested change crosses an ownership boundary"],
      avoidWhen: ["the correction is local and already clear"],
      principles: ["name the boundary", "verify the smallest coherent move"],
      sourceRecordIds: ["source-one", "source-two", "source-three"],
      hypothesis: "Repeated trusted-policy Runs may expose a missing boundary abstraction.",
    },
  });
}

interface ScopeFixture {
  readonly candidate: StrategyTrustScopeCandidateV1;
  readonly sourceCandidate: StrategyDerivationCandidateV1;
  readonly sourceResolver: StrategyTrustScopeSourceResolver;
  readonly candidateReader: StrategyTrustScopeCandidateReader;
  readonly decisionReader: StrategyTrustScopeDecisionReader;
  readonly experienceReader: MemoryProjectExperienceReader;
  readonly projectTrustReader: MemoryProjectTrustReader;
  readonly projectIds: readonly string[];
}

function scopeFixture(
  recordsByProject: ReadonlyMap<string, readonly RunExperienceSourceRecord[]> = new Map(),
): ScopeFixture {
  const source = sourceCandidate();
  const sourceDecision = createStrategyDerivationDecision({
    candidate: source,
    decision: "promoted",
    trialRecordIds: ["source-trial-one", "source-trial-two"],
    decidedAt: "2026-07-02T00:00:00.000Z",
  });
  const sourceSelection = createStrategyRevisionSelection({
    strategyId: source.proposal.strategyId,
    kind: source.proposal.kind,
    revisionIdentity: source.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(source),
    revisionStatusAtRun: "promoted",
    semantics: source.proposal,
  });
  const sourceCatalog = createPromotedDerivedStrategyCatalog([{
    candidate: source,
    decision: sourceDecision,
    selection: sourceSelection,
  }]);
  const candidate = createStrategyTrustScopeCandidate({
    sourceStrategy: {
      sourceProjectId: source.projectId,
      strategyId: source.proposal.strategyId,
      kind: source.proposal.kind,
      revisionIdentity: source.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(source),
    },
    candidateId: SCOPE_CANDIDATE_ID,
    createdAt: "2026-07-03T00:00:00.000Z",
  });
  const candidates = [candidate];
  const candidateReader: StrategyTrustScopeCandidateReader = {
    read: async (candidateId) => candidates.find((item) => item.candidateId === candidateId) ?? null,
    readAll: async () => [...candidates],
  };
  const decisionReader: StrategyTrustScopeDecisionReader = {
    read: async () => null,
    readAll: async () => [],
  };
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async (binding) => ({
      sourceStrategy: binding,
      candidate: source,
      decision: sourceDecision,
      selection: sourceSelection,
      promotedDerivedCatalog: sourceCatalog,
    }),
  };
  const projectIds = [
    getProjectId(SOURCE_ROOT),
    getProjectId(TARGET_A_ROOT),
    getProjectId(TARGET_B_ROOT),
  ].sort();
  return {
    candidate,
    sourceCandidate: source,
    sourceResolver,
    candidateReader,
    decisionReader,
    experienceReader: new MemoryProjectExperienceReader(projectIds, recordsByProject),
    projectTrustReader: new MemoryProjectTrustReader(projectIds),
    projectIds,
  };
}

class MemoryProjectExperienceReader implements RunExperienceProjectReader {
  readonly listCalls = 0;
  readonly readCalls: string[] = [];
  private readonly ids: readonly string[];
  private readonly recordsByProject: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>;

  constructor(
    ids: readonly string[],
    recordsByProject: ReadonlyMap<string, readonly RunExperienceSourceRecord[]>,
  ) {
    this.ids = ids;
    this.recordsByProject = recordsByProject;
  }

  async listProjectIds(): Promise<readonly string[]> {
    return [...this.ids];
  }

  async readProjectId(projectId: string): Promise<RunExperienceReadResult> {
    this.readCalls.push(projectId);
    const records = this.recordsByProject.get(projectId) ?? [];
    return {
      records,
      loadedRecords: records.length,
      unsupportedSchema: 0,
      invalid: 0,
    };
  }
}

class MemoryProjectTrustReader implements ScopeProjectTrustReader {
  readonly readCalls: string[] = [];
  private readonly ids: readonly string[];
  readonly snapshots = new Map<string, ScopeProjectTrustSnapshot>();

  constructor(ids: readonly string[]) {
    this.ids = ids;
    for (const projectId of ids) {
      this.snapshots.set(projectId, { projectId, promotedDerived: [] });
    }
  }

  async readProjectId(projectId: string): Promise<ScopeProjectTrustSnapshot> {
    this.readCalls.push(projectId);
    return this.snapshots.get(projectId) ?? { projectId, promotedDerived: [] };
  }
}

function policyFor(
  candidate: StrategyDerivationCandidateV1,
  status: "trial" | "promoted" = "trial",
  semantics = candidate.proposal,
): PolicySnapshot {
  const selection = createStrategyRevisionSelection({
    strategyId: candidate.proposal.strategyId,
    kind: candidate.proposal.kind,
    revisionIdentity: candidate.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
    revisionStatusAtRun: status,
    semantics,
  });
  return createPolicySnapshotFromRevisions({
    approach: "direct-action",
    modifiers: [selection],
  });
}

function experience(
  policy: PolicySnapshot,
  options: {
    readonly verificationStatus?: "pending" | "failed" | "passed";
    readonly exposure?: boolean;
    readonly completionBeforeRun?: boolean;
    readonly execution?: RunExperienceExecution;
    readonly recordedAt?: string;
  } = {},
): RunExperience {
  const runExecution = options.execution ?? execution();
  const after = options.exposure === false ? runExecution : zeroExecution();
  const record = assembleRunExperience({
    task: task(),
    runStart: { taskStatus: "active", taskGoal: task().goal },
    snapshot: coherentSnapshot({
      verificationStatus: options.verificationStatus ?? "pending",
    }),
    policy: {
      finalSnapshot: policy,
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: after,
      finalPolicyLastDeclaredAfter: after,
    },
    execution: runExecution,
    durationMs: 100,
    cost: 0.25,
    recordedAt: options.recordedAt ?? "2026-07-04T00:00:00.000Z",
  });
  if (!options.completionBeforeRun) return record;
  const completed = structuredClone(record) as any;
  completed.runStart.taskStatus = "done";
  completed.outcome.taskStatus = "done";
  completed.outcome.verificationStatus = "passed";
  completed.outcome.completionRelation = "completed_before_run";
  return completed as RunExperience;
}

function record(
  number: number,
  value: RunExperience,
): RunExperienceSourceRecord {
  const recordId = `${number.toString(16).padStart(8, "0")}-0000-4000-8000-${number.toString(16).padStart(12, "0")}.json`;
  const parsed = parseRunExperience(value);
  assert.ok(parsed, `invalid fixture Experience: ${JSON.stringify(value)}`);
  return { recordId, experience: parsed };
}

function reviewInput(fixture: ScopeFixture) {
  return {
    candidate: fixture.candidate,
    candidateReader: fixture.candidateReader,
    decisionReader: fixture.decisionReader,
    sourceResolver: fixture.sourceResolver,
    experienceReader: fixture.experienceReader,
    projectTrustReader: fixture.projectTrustReader,
    currentProjectRoot: TARGET_A_ROOT,
  };
}

function recordsFor(
  fixture: ScopeFixture,
  entries: readonly [string, number, RunExperience][],
): ReadonlyMap<string, readonly RunExperienceSourceRecord[]> {
  const grouped = new Map<string, RunExperienceSourceRecord[]>();
  for (const [root, number, value] of entries) {
    const projectId = getProjectId(root);
    const records = grouped.get(projectId) ?? [];
    records.push(record(number, value));
    grouped.set(projectId, records);
  }
  // Keep all known namespaces in the scan even when they have no records.
  for (const projectId of fixture.projectIds) {
    if (!grouped.has(projectId)) grouped.set(projectId, []);
  }
  return grouped;
}

test("cross-project review requires exact identity, semantics, trial status, attribution, exposure, and target diversity", async () => {
  const fixture = scopeFixture();
  const exact = policyFor(fixture.sourceCandidate);
  const recordsByProject = recordsFor(fixture, [
    [SOURCE_ROOT, 1, experience(exact)],
    [TARGET_A_ROOT, 2, experience(exact, {
      verificationStatus: "failed",
      execution: execution({ toolErrors: 2, deniedCalls: 1 }),
    })],
    [TARGET_A_ROOT, 3, experience(policyFor(fixture.sourceCandidate, "promoted"))],
    [TARGET_A_ROOT, 4, experience(exact, { exposure: false })],
    [TARGET_B_ROOT, 5, experience(exact, { verificationStatus: "passed" })],
    [TARGET_B_ROOT, 6, experience(exact, { completionBeforeRun: true })],
    [TARGET_B_ROOT, 7, experience(policyFor(fixture.sourceCandidate, "trial", {
      ...fixture.sourceCandidate.proposal,
      summary: "Forged semantics for an exact identity.",
    }))],
  ]);
  const populated = scopeFixture(recordsByProject);
  // Re-use the populated reader while preserving the same immutable authority
  // fixture; the source and global artifacts are unchanged.
  const review = await deriveStrategyTrustScopeTrialReview(reviewInput(populated));

  assert.equal(review.evidenceScanComplete, true);
  assert.equal(review.globalStateComplete, true);
  assert.equal(review.projectTrustScanComplete, true);
  assert.equal(review.matchingRecordCount, 7);
  assert.equal(review.ineligibleMatchingRunCount, 5);
  assert.equal(review.eligibleTrialRunCount, 2);
  assert.equal(review.distinctEligibleTargetProjectCount, 2);
  assert.deepEqual(review.eligibleTargetProjectIds, [
    getProjectId(TARGET_A_ROOT),
    getProjectId(TARGET_B_ROOT),
  ].sort());
  assert.equal(review.promotionEligibility.eligible, true);
  assert.equal(review.promotionEligibility.selectedEvidenceRefsValid, true);
  assert.equal(review.selectedEvidenceRefs.length, 2);
  assert.equal(review.currentProjectIsSource, false);

  const sourceInventory = review.inventories.find((item) => item.sourceProject)!;
  const targetA = review.inventories.find((item) => item.projectId === getProjectId(TARGET_A_ROOT))!;
  const targetB = review.inventories.find((item) => item.projectId === getProjectId(TARGET_B_ROOT))!;
  assert.equal(sourceInventory.matchingRecordCount, 1);
  assert.equal(sourceInventory.eligibleRunCount, 0);
  assert.equal(sourceInventory.ineligibleRunCount, 1);
  assert.equal(targetA.eligibleRunCount, 1);
  assert.equal(targetA.ineligibleRunCount, 2);
  assert.equal(targetA.outcomes.verificationPassedCount, 0);
  assert.equal(targetA.outcomes.totalToolErrors, 2);
  assert.equal(targetA.outcomes.totalDeniedCalls, 1);
  assert.equal(targetB.eligibleRunCount, 1);
  assert.equal(targetB.ineligibleRunCount, 2);
  assert.equal(targetB.outcomes.verificationPassedCount, 2);
  assert.ok(targetB.detailRecords.some((item) => item.reasons.some((reason) => /trial|exposure|semantics|completed/i.test(reason))));

  const report = formatStrategyTrustScopeTrialReview(review);
  assert.match(report, /Strategy Trust Transfer Review/);
  assert.match(report, /Matching Scope Trial records: 7/);
  assert.match(report, /Distinct eligible target projects: 2/);
  assert.match(report, /Verification passed: 2/);
  assert.match(report, /tool errors 2/);
  assert.match(report, /Promotion Eligibility: eligible for Human review/);
  assert.match(report, /Negative factual outcomes remain visible/);
  assert.doesNotMatch(report, /\n(?:Score|Ranking|Reward|Causal claim):/i);
  assert.equal(populated.experienceReader.readCalls.length, populated.projectIds.length * 2 + 2);
  assert.equal(populated.projectTrustReader.readCalls.length, populated.projectIds.length * 2);
});

test("final project-local trust freshness fails closed when a target gains a conflicting revision", async () => {
  const fixture = scopeFixture();
  const exact = policyFor(fixture.sourceCandidate);
  const recordsByProject = recordsFor(fixture, [
    [TARGET_A_ROOT, 81, experience(exact)],
    [TARGET_B_ROOT, 82, experience(exact)],
  ]);
  const populated = scopeFixture(recordsByProject);
  const targetAId = getProjectId(TARGET_A_ROOT);
  const conflict = {
    strategyId: fixture.sourceCandidate.proposal.strategyId,
    kind: fixture.sourceCandidate.proposal.kind,
    revisionIdentity: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    revisionFingerprint: `sha256:${"c".repeat(64)}`,
  };
  const trustReads = new Map<string, number>();
  const projectTrustReader: ScopeProjectTrustReader = {
    readProjectId: async (projectId) => {
      const readNumber = trustReads.get(projectId) ?? 0;
      trustReads.set(projectId, readNumber + 1);
      return {
        projectId,
        promotedDerived: projectId === targetAId && readNumber > 0 ? [conflict] : [],
      };
    },
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(populated),
    projectTrustReader,
  });

  assert.equal(review.projectTrustScanComplete, false);
  assert.equal(review.promotionEligibility.projectLocalConflictFree, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.match(review.reasons.join(" "), /project-local.*changed|conflicting local revision|coherent/i);
});

test("final global freshness fails closed when a terminal Scope Decision appears", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 91, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 92, experience(policyFor(sourceCandidate()))],
  ]));
  const terminalDecision = createStrategyTrustScopeDecision({
    candidate: fixture.candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-07-05T00:00:00.000Z",
  });
  let decisionReadCount = 0;
  const decisionReader: StrategyTrustScopeDecisionReader = {
    read: async () => null,
    readAll: async () => {
      decisionReadCount += 1;
      return decisionReadCount === 1 ? [] : [terminalDecision];
    },
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    decisionReader,
  });

  assert.equal(review.globalStateComplete, false);
  assert.equal(review.promotionEligibility.scopeCandidateOpen, false);
  assert.equal(review.promotionEligibility.noTerminalScopeDecision, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.equal(review.terminalDecision?.decision, "rejected");
  assert.match(review.reasons.join(" "), /global.*changed|terminal Scope Decision|coherent/i);
});

test("final source freshness fails closed when the exact promoted binding disappears", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 101, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 102, experience(policyFor(sourceCandidate()))],
  ]));
  let sourceReadCount = 0;
  const sourceResolver: StrategyTrustScopeSourceResolver = {
    resolve: async (binding) => {
      sourceReadCount += 1;
      if (sourceReadCount > 1) throw new Error("source promoted binding missing");
      return fixture.sourceResolver.resolve(binding);
    },
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    sourceResolver,
  });

  assert.equal(review.sourceBindingValid, false);
  assert.equal(review.sourceTrustValid, false);
  assert.equal(review.promotionEligibility.sourceBindingValid, false);
  assert.equal(review.promotionEligibility.sourceStrategyTrustValid, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.match(review.reasons.join(" "), /source.*(missing|changed|stale|coherent)/i);
});

test("final authority freshness runs after the selected evidence boundary", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 111, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 112, experience(policyFor(sourceCandidate()))],
  ]));
  const terminalDecision = createStrategyTrustScopeDecision({
    candidate: fixture.candidate,
    decision: "rejected",
    trialRefs: [],
    decidedAt: "2026-07-06T00:00:00.000Z",
  });
  let boundaryReached = false;
  let experienceReads = 0;
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => fixture.experienceReader.listProjectIds(),
    readProjectId: async (projectId) => {
      experienceReads += 1;
      if (experienceReads > fixture.projectIds.length * 2) boundaryReached = true;
      return fixture.experienceReader.readProjectId(projectId);
    },
  };
  const decisionReader: StrategyTrustScopeDecisionReader = {
    read: async () => null,
    readAll: async () => boundaryReached ? [terminalDecision] : [],
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    experienceReader,
    decisionReader,
  });

  assert.equal(boundaryReached, true);
  assert.equal(review.globalStateComplete, false);
  assert.equal(review.promotionEligibility.scopeCandidateOpen, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.match(review.reasons.join(" "), /terminal Scope Decision|global.*changed|coherent/i);
});

test("final project-local trust freshness catches a conflict appearing at the boundary", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 121, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 122, experience(policyFor(sourceCandidate()))],
  ]));
  const targetAId = getProjectId(TARGET_A_ROOT);
  const conflict = {
    strategyId: fixture.sourceCandidate.proposal.strategyId,
    kind: fixture.sourceCandidate.proposal.kind,
    revisionIdentity: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    revisionFingerprint: `sha256:${"c".repeat(64)}`,
  };
  let boundaryReached = false;
  let experienceReads = 0;
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => fixture.experienceReader.listProjectIds(),
    readProjectId: async (projectId) => {
      experienceReads += 1;
      if (experienceReads > fixture.projectIds.length * 2) boundaryReached = true;
      return fixture.experienceReader.readProjectId(projectId);
    },
  };
  const projectTrustReader: ScopeProjectTrustReader = {
    readProjectId: async (projectId) => ({
      projectId,
      promotedDerived: boundaryReached && projectId === targetAId ? [conflict] : [],
    }),
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    experienceReader,
    projectTrustReader,
  });

  assert.equal(boundaryReached, true);
  assert.equal(review.projectTrustScanComplete, false);
  assert.equal(review.promotionEligibility.projectLocalConflictFree, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.match(review.reasons.join(" "), /project-local.*changed|conflicting local revision|coherent/i);
});

test("a project namespace change at the evidence boundary fails closed", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 131, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 132, experience(policyFor(sourceCandidate()))],
  ]));
  const addedProjectId = getProjectId("/scope-review-target-c");
  let boundaryReached = false;
  let experienceReads = 0;
  const experienceReader: RunExperienceProjectReader = {
    listProjectIds: async () => Object.freeze(boundaryReached
      ? [...fixture.projectIds, addedProjectId].sort()
      : [...fixture.projectIds]),
    readProjectId: async (projectId) => {
      experienceReads += 1;
      if (experienceReads > fixture.projectIds.length * 2) boundaryReached = true;
      return fixture.experienceReader.readProjectId(projectId);
    },
  };
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    experienceReader,
  });

  assert.equal(boundaryReached, true);
  assert.equal(review.projectTrustScanComplete, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.match(review.reasons.join(" "), /project-local trust namespace set|collision scan.*coherent/i);
});

test("two unchanged eligible target Runs remain promotion-eligible", async () => {
  const fixture = scopeFixture(recordsFor(scopeFixture(), [
    [TARGET_A_ROOT, 141, experience(policyFor(sourceCandidate()))],
    [TARGET_B_ROOT, 142, experience(policyFor(sourceCandidate()))],
  ]));
  const review = await deriveStrategyTrustScopeTrialReview(reviewInput(fixture));

  assert.equal(review.eligibleTrialRunCount, 2);
  assert.equal(review.distinctEligibleTargetProjectCount, 2);
  assert.equal(review.selectedEvidenceRefs.length, 2);
  assert.equal(review.promotionEligibility.eligible, true);
  assert.equal(review.promotionEligibility.selectedEvidenceRefsValid, true);
});

test("fresh second-pass resolution invalidates changed selected refs and remains read-only", async () => {
  const fixture = scopeFixture();
  const exact = policyFor(fixture.sourceCandidate);
  const targetAId = getProjectId(TARGET_A_ROOT);
  const targetBId = getProjectId(TARGET_B_ROOT);
  const first = new Map<string, readonly RunExperienceSourceRecord[]>([
    [getProjectId(SOURCE_ROOT), []],
    [targetAId, [record(11, experience(exact))]],
    [targetBId, [record(12, experience(exact))]],
  ]);
  let targetAReads = 0;
  const reader: RunExperienceProjectReader = {
    listProjectIds: async () => fixture.projectIds,
    readProjectId: async (projectId) => {
      if (projectId === targetAId) {
        targetAReads += 1;
        const value = targetAReads === 1 ? experience(exact) : experience(exact, { recordedAt: "2026-07-05T00:00:00.000Z" });
        return { records: [record(11, value)], loadedRecords: 1, unsupportedSchema: 0, invalid: 0 };
      }
      const records = first.get(projectId) ?? [];
      return { records, loadedRecords: records.length, unsupportedSchema: 0, invalid: 0 };
    },
  };
  const before = JSON.stringify(fixture.candidate);
  const review = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    experienceReader: reader,
  });
  assert.equal(review.evidenceScanComplete, false);
  assert.equal(review.promotionEligibility.eligible, false);
  assert.equal(review.promotionEligibility.selectedEvidenceRefsValid, false);
  assert.match(review.reasons.join(" "), /changed|fingerprint|resolv/i);
  assert.equal(JSON.stringify(fixture.candidate), before);
});

test("eligible refs and Human detail are bounded while aggregate facts remain complete", async () => {
  const seedFixture = scopeFixture();
  const exact = policyFor(seedFixture.sourceCandidate);
  const entries: Array<[string, number, RunExperience]> = [];
  for (let index = 1; index <= 600; index += 1) entries.push([TARGET_A_ROOT, index, experience(exact)]);
  for (let index = 601; index <= 1025; index += 1) entries.push([TARGET_B_ROOT, index, experience(exact)]);
  const fixture = scopeFixture(recordsFor(seedFixture, entries));
  const review = await deriveStrategyTrustScopeTrialReview(reviewInput(fixture));

  assert.equal(review.eligibleTrialRunCount, 1025);
  assert.equal(review.matchingRecordCount, 1025);
  assert.equal(review.distinctEligibleTargetProjectCount, 2);
  assert.equal(review.selectedEvidenceRefs.length, MAX_CROSS_PROJECT_EXPERIENCE_REFS);
  assert.equal(review.omittedEligibleRefCount, 1);
  assert.equal(review.promotionEligibility.retainedEligibleRefCount, MAX_CROSS_PROJECT_EXPERIENCE_REFS);
  assert.equal(review.promotionEligibility.omittedEligibleRefCount, 1);
  for (const inventory of review.inventories) {
    assert.ok(inventory.detailRecords.length <= MAX_SCOPE_REVIEW_RECORD_DETAILS);
    if (!inventory.sourceProject) {
      assert.equal(inventory.omittedDetailRecordCount, inventory.matchingRecordCount - MAX_SCOPE_REVIEW_RECORD_DETAILS);
    }
  }
  assert.match(formatStrategyTrustScopeTrialReview(review), /1 eligible evidence ref\(s\) omitted/);
});

test("incomplete authority and collision gates fail closed without inventing evidence", async () => {
  const fixture = scopeFixture();
  const exact = policyFor(fixture.sourceCandidate);
  const recordsByProject = recordsFor(fixture, [
    [TARGET_A_ROOT, 21, experience(exact)],
    [TARGET_B_ROOT, 22, experience(exact)],
  ]);
  const conflict = {
    strategyId: fixture.sourceCandidate.proposal.strategyId,
    kind: fixture.sourceCandidate.proposal.kind,
    revisionIdentity: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    revisionFingerprint: `sha256:${"c".repeat(64)}`,
  };
  const conflictedTrust = scopeFixture(recordsByProject);
  conflictedTrust.projectTrustReader.snapshots.set(getProjectId(TARGET_A_ROOT), {
    projectId: getProjectId(TARGET_A_ROOT),
    promotedDerived: [conflict],
  });
  const conflictReview = await deriveStrategyTrustScopeTrialReview(reviewInput(conflictedTrust));
  assert.equal(conflictReview.promotionEligibility.projectLocalConflictFree, false);
  assert.equal(conflictReview.promotionEligibility.eligible, false);
  assert.match(conflictReview.reasons.join(" "), /conflicting local revision/i);

  const terminalDecision = {
    ...fixture.decisionReader,
    read: async () => null,
    readAll: async (): Promise<readonly StrategyTrustScopeDecisionV1[]> => [{
      schemaVersion: 1,
      candidateId: fixture.candidate.candidateId,
      candidateFingerprint: "sha256:" + "0".repeat(64),
      decidedAt: "2026-07-05T00:00:00.000Z",
      sourceStrategy: fixture.candidate.sourceStrategy,
      currentTrustScope: "project",
      proposedTrustScope: "user-global",
      decision: "rejected",
      evidence: { trialRefs: [] },
    }],
  } satisfies StrategyTrustScopeDecisionReader;
  const terminalReview = await deriveStrategyTrustScopeTrialReview({
    ...reviewInput(fixture),
    decisionReader: terminalDecision,
  });
  assert.equal(terminalReview.globalStateComplete, false);
  assert.equal(terminalReview.promotionEligibility.eligible, false);
  assert.match(terminalReview.reasons.join(" "), /global Scope artifacts|binding|fingerprint/i);
});

test("qualified refs resolve only one fresh exact live record", async () => {
  const fixture = scopeFixture();
  const exact = policyFor(fixture.sourceCandidate);
  const value = record(31, experience(exact));
  const projectId = getProjectId(TARGET_A_ROOT);
  const reader: RunExperienceProjectReader = {
    listProjectIds: async () => [projectId],
    readProjectId: async () => ({ records: [value], loadedRecords: 1, unsupportedSchema: 0, invalid: 0 }),
  };
  const ref = createCrossProjectExperienceRef({
    projectId,
    recordId: value.recordId,
    experience: value.experience,
  });
  assert.ok(await resolveCrossProjectExperienceRef(ref, reader));
  assert.equal(await resolveCrossProjectExperienceRef({
    ...ref,
    recordFingerprint: `sha256:${"0".repeat(64)}`,
  }, reader), null);
  assert.equal(await resolveCrossProjectExperienceRef(ref, {
    ...reader,
    readProjectId: async () => ({
      records: [value, value],
      loadedRecords: 2,
      unsupportedSchema: 0,
      invalid: 0,
    }),
  }), null);
  assert.equal(await resolveCrossProjectExperienceRef(ref, {
    ...reader,
    readProjectId: async () => { throw new Error("namespace unavailable"); },
  }), null);
});

test("Scope review completion is namespaced, bounded, and rejects ambiguous global artifacts", async () => {
  const fixture = scopeFixture();
  const projection = await buildScopeTrialReviewCommandProjection({
    candidateReader: fixture.candidateReader,
    decisionReader: fixture.decisionReader,
  });
  assert.deepEqual(projection.options.map((option) => option.value), [
    scopeTrialReviewCommandValue(fixture.candidate.candidateId),
  ]);
  assert.match(projection.options[0]!.label, /boundary-first/);
  assert.match(projection.options[0]!.label, /Scope Trust review/);
  assert.equal(filterScopeTrialReviewCommandOptions(projection, "scope:").length, 1);
  assert.equal(filterScopeTrialReviewCommandOptions(projection, "other:").length, 0);
  assert.equal(parseScopeTrialReviewCommandValue(projection.options[0]!.value), fixture.candidate.candidateId);
  assert.equal(parseScopeTrialReviewCommandValue(fixture.candidate.candidateId), null);

  await assert.rejects(
    buildScopeTrialReviewCommandProjection({
      candidateReader: {
        ...fixture.candidateReader,
        readAll: async () => [fixture.candidate, fixture.candidate],
      },
      decisionReader: fixture.decisionReader,
    }),
    /duplicate|same exact hypothesis/i,
  );
});

test("FileRunExperienceReader discovers canonical project IDs and reads them directly", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-scope-review-experience-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const fixture = scopeFixture();
  const exact = experience(policyFor(fixture.sourceCandidate));
  const reader = new FileRunExperienceReader({ baseDir });
  const firstId = getProjectId(TARGET_A_ROOT);
  const secondId = getProjectId(TARGET_B_ROOT);
  const firstDirectory = reader.experienceDirectoryForProjectId(firstId);
  await mkdir(firstDirectory, { recursive: true });
  await mkdir(reader.experienceDirectoryForProjectId(secondId), { recursive: true });
  const firstRecord = record(41, exact);
  await writeFile(join(firstDirectory, firstRecord.recordId), JSON.stringify(firstRecord.experience));

  assert.deepEqual(await reader.listProjectIds(), [firstId, secondId].sort());
  assert.deepEqual((await reader.readProjectId(firstId)).records.map((item) => item.recordId), [firstRecord.recordId]);
  assert.deepEqual((await reader.read(TARGET_A_ROOT)).records.map((item) => item.recordId), [firstRecord.recordId]);
  await assert.rejects(reader.readProjectId("not-a-project"), /canonical/i);

  await mkdir(join(baseDir, "not-a-canonical-project"), { recursive: true });
  await assert.rejects(reader.listProjectIds(), /non-canonical/i);
});

test("FileScopeProjectTrustReader reconstructs only valid promoted Derived identities", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-scope-review-trust-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const source = sourceCandidate();
  const candidateDir = join(baseDir, source.projectId, "strategy-derivation-candidates");
  const decisionDir = join(baseDir, source.projectId, "strategy-derivation-decisions");
  await mkdir(candidateDir, { recursive: true });
  await mkdir(decisionDir, { recursive: true });
  const decision = createStrategyDerivationDecision({
    candidate: source,
    decision: "promoted",
    trialRecordIds: ["source-trial-one", "source-trial-two"],
  });
  await writeFile(`${candidateDir}/${source.candidateId}.json`, `${JSON.stringify(source)}\n`);
  await writeFile(`${decisionDir}/${source.candidateId}.json`, `${JSON.stringify(decision)}\n`);
  const reader = new FileScopeProjectTrustReader({ projectsBaseDir: baseDir });
  const snapshot = await reader.readProjectId(source.projectId);
  assert.deepEqual(snapshot.promotedDerived, [{
    strategyId: source.proposal.strategyId,
    kind: source.proposal.kind,
    revisionIdentity: source.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(source),
  }]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.promotedDerived), true);
});
