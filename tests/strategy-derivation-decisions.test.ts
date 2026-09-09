import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPolicySnapshot,
  createPolicySnapshotFromRevisions,
  createStrategyRevisionSelection,
} from "../src/policy.ts";
import {
  assembleRunExperience,
  parseRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import type { RunExperienceSourceRecord } from "../src/experience-store.ts";
import {
  buildUnifiedCandidateCommandProjection,
} from "../src/strategy-candidate-commands.ts";
import {
  createPromotedDerivedStrategyCatalog,
  createStrategyDerivationDecision,
  FileStrategyDerivationDecisionStore,
  loadPromotedDerivedStrategyCatalog,
  MAX_PROMOTED_DERIVED_STRATEGIES as CATALOG_MAX_PROMOTED_DERIVED_STRATEGIES,
  validateStrategyDerivationDecisionArtifact,
  validateStrategyDerivationDecisionBinding,
  type StrategyDerivationDecision,
} from "../src/strategy-derivation-decisions.ts";
import {
  createStrategyDerivationCandidate,
  strategyDerivationCandidateSemanticFingerprint,
  type StrategyDerivationCandidateV1,
} from "../src/strategy-derivation-candidates.ts";
import {
  createPromotedStrategyRevisionCatalog,
  MAX_PROMOTED_STRATEGY_REVISIONS,
} from "../src/strategy-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  MAX_PROMOTED_DERIVED_STRATEGIES as PORTFOLIO_MAX_PROMOTED_DERIVED_STRATEGIES,
  MAX_TRUSTED_PORTFOLIO_ENTRIES,
  resolveTrustedPortfolioRevisionSelection,
  type TrustedStrategyPortfolio,
} from "../src/strategy-portfolio.ts";
import { getSeedStrategy, SEED_STRATEGIES } from "../src/strategies.ts";
import { MAX_USER_GLOBAL_DERIVED_STRATEGIES } from "../src/strategy-trust-scope-constants.ts";
import type { PindieState } from "../src/state.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000201";

function task(goal: string): NonNullable<PindieState["task"]> {
  return {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "The check is factual" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function portfolio(): TrustedStrategyPortfolio {
  return createTrustedStrategyPortfolio("/repo", createPromotedStrategyRevisionCatalog([]));
}

function candidate(base = portfolio()): StrategyDerivationCandidateV1 {
  return createStrategyDerivationCandidate({
    projectId: base.projectId,
    basePortfolio: base,
    candidateId: CANDIDATE_ID,
    createdAt: "2026-05-01T00:00:00.000Z",
    proposal: {
      strategyId: "boundary-first",
      kind: "approach",
      summary: "Make the smallest ownership boundary explicit before implementation.",
      useWhen: ["the requested change crosses an ownership boundary"],
      avoidWhen: ["the correction is local and already clear"],
      principles: ["name the boundary", "verify the smallest coherent move"],
      sourceRecordIds: ["source-a", "source-b", "source-c"],
      hypothesis: "Repeated trusted-policy Runs may expose a missing boundary abstraction.",
    },
  });
}

function decision(
  value: StrategyDerivationCandidateV1,
  terminal: "promoted" | "rejected" = "promoted",
  trialRecordIds = ["trial-a", "trial-b"],
): StrategyDerivationDecision {
  return createStrategyDerivationDecision({
    candidate: value,
    decision: terminal,
    trialRecordIds,
    decidedAt: "2026-05-02T00:00:00.000Z",
  });
}

function sourceExperience(
  goal: string,
  policy: ReturnType<typeof createPolicySnapshot>,
  recordedAt: string,
  recordId = `${goal}-${recordedAt}`,
): RunExperienceSourceRecord {
  const execution = {
    toolCalls: 2,
    observations: 1,
    consequentialCalls: 1,
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
    } satisfies Extract<SemanticSnapshot, { authority: "coherent" }>,
    policy: {
      finalSnapshot: policy,
      declarationCount: 1,
      finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: {
        toolCalls: 0,
        observations: 0,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 0,
        deniedCalls: 0,
      },
      finalPolicyLastDeclaredAfter: {
        toolCalls: 0,
        observations: 0,
        consequentialCalls: 0,
        projectMutationEffectCalls: 0,
        verificationCalls: 0,
        toolErrors: 0,
        deniedCalls: 0,
      },
    },
    execution,
    durationMs: 10,
    cost: 0.1,
    recordedAt,
  });
  const parsed = parseRunExperience(value);
  assert.ok(parsed);
  return { recordId, experience: parsed };
}

function derivationTrialRecords(value: StrategyDerivationCandidateV1): readonly RunExperienceSourceRecord[] {
  const fingerprint = strategyDerivationCandidateSemanticFingerprint(value);
  const policy = createPolicySnapshotFromRevisions({
    approach: createStrategyRevisionSelection({
      strategyId: value.proposal.strategyId,
      kind: value.proposal.kind,
      revisionIdentity: value.candidateId,
      revisionFingerprint: fingerprint,
      revisionStatusAtRun: "trial",
      semantics: value.proposal,
    }),
  });
  return [
    sourceExperience("trial-one", policy, "2026-05-03T00:00:00.000Z"),
    sourceExperience("trial-two", policy, "2026-05-04T00:00:00.000Z"),
  ];
}

function emptyRevisionReader() {
  return { read: async () => null, readAll: async () => [] };
}

function emptyDecisionReader() {
  return { read: async () => null, readAll: async () => [] };
}

test("Derived trust and trusted portfolio bounds share their SSOT", () => {
  assert.equal(PORTFOLIO_MAX_PROMOTED_DERIVED_STRATEGIES, CATALOG_MAX_PROMOTED_DERIVED_STRATEGIES);
  assert.equal(CATALOG_MAX_PROMOTED_DERIVED_STRATEGIES, 8);
  assert.equal(MAX_USER_GLOBAL_DERIVED_STRATEGIES, 8);
  assert.equal(MAX_PROMOTED_STRATEGY_REVISIONS, SEED_STRATEGIES.length);
  const expectedPortfolioEntries = SEED_STRATEGIES.length +
    MAX_PROMOTED_STRATEGY_REVISIONS +
    CATALOG_MAX_PROMOTED_DERIVED_STRATEGIES +
    MAX_USER_GLOBAL_DERIVED_STRATEGIES;
  assert.equal(MAX_TRUSTED_PORTFOLIO_ENTRIES, expectedPortfolioEntries);
  assert.equal(expectedPortfolioEntries, 30);
});

test("Derivation Decision V1 is immutable, strictly bound, and atomically create-only", async (t) => {
  const value = candidate();
  const promoted = decision(value);
  assert.deepEqual(promoted.evidence, {
    sourceRecordIds: ["source-a", "source-b", "source-c"],
    trialRecordIds: ["trial-a", "trial-b"],
  });
  assert.equal(Object.isFrozen(promoted), true);
  assert.equal(Object.isFrozen(promoted.strategy), true);
  assert.equal(Object.isFrozen(promoted.evidence), true);
  assert.doesNotThrow(() => validateStrategyDerivationDecisionArtifact(promoted));
  assert.doesNotThrow(() => validateStrategyDerivationDecisionBinding(promoted, value));
  assert.throws(
    () => validateStrategyDerivationDecisionBinding({ ...promoted, candidateFingerprint: `sha256:${"0".repeat(64)}` }, value),
    /fingerprint|binding/i,
  );
  assert.throws(
    () => createStrategyDerivationDecision({ candidate: value, decision: "promoted", trialRecordIds: ["one"] }),
    /between 2|at least/i,
  );

  const baseDir = await mkdtemp(join(tmpdir(), "pindie-derived-decisions-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileStrategyDerivationDecisionStore({ baseDir });
  await store.save("/repo", promoted);
  const path = join(store.strategyDerivationDecisionDirectory("/repo"), `${CANDIDATE_ID}.json`);
  const before = await readFile(path, "utf8");
  await assert.rejects(store.save("/repo", decision(value, "rejected", [])), /terminal Decision|already exists/i);
  assert.equal(await readFile(path, "utf8"), before);
  assert.deepEqual(await store.readAll("/repo"), [promoted]);
});

test("promoted Derived catalog and trusted portfolio resolve only immutable trust artifacts", async () => {
  const value = candidate();
  const promoted = decision(value);
  const candidateReader = {
    read: async (_root: string, id: string) => id === value.candidateId ? value : null,
  };
  const decisionReader = {
    read: async (_root: string, id: string) => id === value.candidateId ? promoted : null,
    readAll: async () => [promoted],
  };
  const catalog = await loadPromotedDerivedStrategyCatalog(
    "/repo",
    decisionReader,
    candidateReader,
  );
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0]!.selection.revisionStatusAtRun, "promoted");
  assert.equal(catalog.entries[0]!.selection.revisionIdentity, value.candidateId);
  const trusted = createTrustedStrategyPortfolio("/repo", createPromotedStrategyRevisionCatalog([]), catalog);
  const selector = {
    strategyId: value.proposal.strategyId,
    revisionIdentity: value.candidateId,
    revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(value),
  };
  const resolved = resolveTrustedPortfolioRevisionSelection(selector, trusted, "approach");
  assert.equal(resolved?.revisionStatusAtRun, "promoted");
  assert.deepEqual(resolved?.semantics, {
    summary: value.proposal.summary,
    useWhen: value.proposal.useWhen,
    avoidWhen: value.proposal.avoidWhen,
    principles: value.proposal.principles,
  });
  assert.throws(() => catalog.resolve(selector, "modifier"), /unavailable|role/i);
  assert.equal(trusted.entries.filter((entry) => entry.origin === "promoted-derived").length, 1);

  const rejected = decision(value, "rejected", []);
  assert.throws(() => createPromotedDerivedStrategyCatalog([{
    candidate: value,
    decision: rejected,
    selection: catalog.entries[0]!.selection,
  }]), /Rejected|promoted/i);
});

test("unified lifecycle projection exposes Derivation promotion/rejection gates and exact IDs", async () => {
  const value = candidate();
  const records = [
    sourceExperience("goal-one", createPolicySnapshot({ approach: "direct-action" }), "2026-05-01T00:00:00.000Z", "source-a"),
    sourceExperience("goal-two", createPolicySnapshot({ approach: "explore-first" }), "2026-05-02T00:00:00.000Z", "source-b"),
    sourceExperience("goal-one", createPolicySnapshot({ approach: "direct-action", modifiers: ["minimal-change"] }), "2026-05-03T00:00:00.000Z", "source-c"),
    ...derivationTrialRecords(value),
  ];
  const experienceReader = {
    read: async () => ({ records, loadedRecords: records.length, unsupportedSchema: 0, invalid: 0 }),
  };
  const derivationReader = {
    read: async (_root: string, id: string) => id === value.candidateId ? value : null,
    readAll: async () => [value],
  };
  const projection = await buildUnifiedCandidateCommandProjection({
    projectRoot: "/repo",
    command: "promote",
    candidateReader: emptyRevisionReader(),
    derivationCandidateReader: derivationReader,
    decisionReader: emptyDecisionReader(),
    derivationDecisionReader: emptyDecisionReader(),
    experienceReader,
    trustedPortfolio: portfolio(),
  });
  assert.deepEqual(projection.options.map((option) => option.value), [value.candidateId]);
  const entry = projection.entries[0];
  assert.equal(entry?.kind, "derivation");
  assert.equal(entry?.promotionEligible, true);
  assert.equal(entry?.decision, null);
  assert.match(entry?.label ?? "", /boundary-first|promotion eligible/i);
});
