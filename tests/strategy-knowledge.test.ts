import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileStrategyKnowledge, validateStrategyKnowledgeSnapshot } from "../src/strategy-knowledge-file.ts";
import { createStrategyDerivationCandidate } from "../src/strategy-derivation-candidates.ts";
import { createStrategyDerivationDecision } from "../src/strategy-derivation-decisions.ts";
import { createPromotedStrategyRevisionCatalog } from "../src/strategy-decisions.ts";
import { createTrustedStrategyPortfolio } from "../src/strategy-portfolio.ts";
import { getProjectId } from "../src/store.ts";
import { createStrategyTrustScopeCandidate } from "../src/strategy-trust-scope-candidates.ts";
import { createStrategyTrustScopeDecision } from "../src/strategy-trust-scope-decisions.ts";
import { strategyDerivationCandidateSemanticFingerprint } from "../src/strategy-derivation-candidates.ts";
import { createCrossProjectExperienceRef } from "../src/cross-project-experience.ts";
import { assembleRunExperience } from "../src/run-experience.ts";
import { createPolicySnapshot } from "../src/policy.ts";
import type { PindieState } from "../src/state.ts";

const ROOT = "/strategy-knowledge-test";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const copy = <T>(value: T): T => structuredClone(value);

function trialRef(root: string, id: string) {
  const task: NonNullable<PindieState["task"]> = {
    goal: "Trial", constraints: [], successCriteria: [{ id: "c1", description: "Trial" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] }, humanGate: null, completed: false,
  };
  const zero = { toolCalls: 0, observations: 0, consequentialCalls: 0,
    projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 };
  const policy = createPolicySnapshot({ approach: "direct-action" });
  const experience = assembleRunExperience({ task,
    runStart: { taskStatus: "active", taskGoal: "Trial" },
    snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending",
      hasBlockers: false, hasQuestions: false, completionReady: false,
      taskRelation: "preexisting_untouched", completionRelation: "not_completed", gateRelation: "none" },
    policy: { finalSnapshot: policy, declarationCount: 1, finalPolicyDeclarationCount: 1,
      finalPolicyFirstDeclaredAfter: zero, finalPolicyLastDeclaredAfter: zero },
    execution: { ...zero, toolCalls: 1, observations: 1 }, durationMs: 10, cost: 0,
    recordedAt: "2026-07-05T00:00:00.000Z",
  });
  return createCrossProjectExperienceRef({ projectId: getProjectId(root), recordId: `${id}.json`, experience });
}

test("portable cognition preserves exact local/global trust without exporting unrelated state", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pindie-cognition-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = new FileStrategyKnowledge({ projectsBaseDir: join(home, "source", "projects"), globalBaseDir: join(home, "source", "global") });
  const base = createTrustedStrategyPortfolio(ROOT, createPromotedStrategyRevisionCatalog([]));
  const candidate = createStrategyDerivationCandidate({
    projectId: getProjectId(ROOT), basePortfolio: base, candidateId: ID,
    createdAt: "2026-07-01T00:00:00.000Z",
    proposal: { strategyId: "portable-cognition", kind: "modifier", summary: "Preserve exact trust across hosts.",
      useWhen: ["migration requires exact identity"], avoidWhen: [], principles: ["keep immutable provenance"],
      sourceRecordIds: ["a", "b", "c"], hypothesis: "Portable trust can retain exact semantic identity." },
  });
  await source.derivationCandidates.save(ROOT, candidate);
  await source.derivationDecisions.save(ROOT, createStrategyDerivationDecision({
    candidate, decision: "promoted", decidedAt: "2026-07-02T00:00:00.000Z", trialRecordIds: ["t1", "t2"],
  }));
  const scope = createStrategyTrustScopeCandidate({ candidateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    createdAt: "2026-07-03T00:00:00.000Z", sourceStrategy: {
      sourceProjectId: candidate.projectId, strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind, revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate),
    },
  });
  await source.scopeCandidates.save(scope);
  await source.scopeDecisions.save(createStrategyTrustScopeDecision({
    candidate: scope, decision: "promoted", decidedAt: "2026-07-06T00:00:00.000Z", trialRefs: [
      trialRef("/trial-a", "11111111-1111-4111-8111-111111111111"),
      trialRef("/trial-b", "22222222-2222-4222-8222-222222222222"),
    ],
  }));
  // Experience and unrelated state must not leak into the portable representation.
  const projectDir = join(home, "source", "projects", getProjectId(ROOT));
  await mkdir(join(projectDir, "experience"), { recursive: true });
  await writeFile(join(projectDir, "experience", "private.json"), '{"token":"SECRET"}');
  const snapshot = await source.exportSnapshot();
  assert.equal(snapshot.projects[0]?.derivationCandidates[0]?.candidateId, ID);
  assert.equal(snapshot.projects[0]?.derivationDecisions[0]?.decision, "promoted");
  assert.equal(snapshot.global.scopeDecisions[0]?.decision, "promoted");
  assert.equal(JSON.stringify(snapshot).includes("SECRET"), false);
  assert.deepEqual(Object.keys(snapshot).sort(), ["global", "projects", "schema", "version"]);
  const destination = new FileStrategyKnowledge({ projectsBaseDir: join(home, "destination", "projects"), globalBaseDir: join(home, "destination", "global") });
  await destination.importSnapshot(snapshot);
  assert.deepEqual(await destination.exportSnapshot(), snapshot);
  const originalTrust = await source.projectTrust.readProjectId(getProjectId(ROOT));
  assert.equal(originalTrust.resolvedEntries.filter((entry) => entry.trust.origins.includes("user-global")).length, 1);
  assert.deepEqual(await destination.projectTrust.readProjectId(getProjectId(ROOT)), originalTrust);
  await assert.rejects(destination.importSnapshot(snapshot), /absent, isolated destination namespace/);

  const missing = copy(snapshot);
  (missing.projects[0] as { derivationCandidates: unknown[] }).derivationCandidates = [];
  assert.throws(() => validateStrategyKnowledgeSnapshot(missing), /no Candidate/);
  const brokenGlobal = copy(snapshot);
  (brokenGlobal.global.scopeDecisions[0] as { candidateFingerprint: string }).candidateFingerprint = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validateStrategyKnowledgeSnapshot(brokenGlobal), /fingerprint|binding/);
  const duplicate = copy(snapshot);
  (duplicate.projects[0] as { derivationCandidates: unknown[] }).derivationCandidates.push(candidate);
  assert.throws(() => validateStrategyKnowledgeSnapshot(duplicate), /Duplicate immutable/);
  const malformed = copy(snapshot);
  (malformed.projects[0]!.derivationCandidates[0] as { fingerprint: string }).fingerprint = "bad";
  assert.throws(() => validateStrategyKnowledgeSnapshot(malformed));
  const invalidTarget = new FileStrategyKnowledge({ projectsBaseDir: join(home, "invalid", "projects"), globalBaseDir: join(home, "invalid", "global") });
  await assert.rejects(invalidTarget.importSnapshot(missing));
  assert.deepEqual(await invalidTarget.exportSnapshot(), { schema: "pindie.strategy-knowledge", version: 1, projects: [],
    global: { scopeCandidates: [], scopeDecisions: [], synthesisCandidates: [], synthesisDecisions: [] } });
});
