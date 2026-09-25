import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileRunExperienceMaintenance, MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT } from "../src/experience-lifecycle.ts";
import { FileRunExperienceStore } from "../src/experience-store.ts";
import { assembleRunExperience, type RunExperience } from "../src/run-experience.ts";
import { createPromotedStrategyRevisionCatalog, createStrategyRevisionDecision } from "../src/strategy-decisions.ts";
import { createStrategyRevisionCandidate } from "../src/strategy-candidates.ts";
import { getSeedStrategy } from "../src/strategies.ts";
import { createTrustedStrategyPortfolio } from "../src/strategy-portfolio.ts";
import { createStrategyDerivationCandidate, strategyDerivationCandidateSemanticFingerprint } from "../src/strategy-derivation-candidates.ts";
import { createStrategyDerivationDecision } from "../src/strategy-derivation-decisions.ts";
import { createStrategyTrustScopeCandidate } from "../src/strategy-trust-scope-candidates.ts";
import { createStrategyTrustScopeDecision } from "../src/strategy-trust-scope-decisions.ts";
import { getProjectId } from "../src/store.ts";
import { createStrategyRevisionSelection, createPolicySnapshotFromRevisions } from "../src/policy.ts";
import { FileStrategyKnowledge } from "../src/strategy-knowledge-file.ts";
import type { PindieState } from "../src/state.ts";

const ROOT = "/lifecycle-project";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCOPE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recordId = (i: number) => `${i.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json`;
function experience(i: number, trialPolicy = false): RunExperience {
  const task: NonNullable<PindieState["task"]> = {
    goal: `Task ${i}`, constraints: [], successCriteria: [{ id: "c1", description: "done" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] }, humanGate: null, completed: false,
  };
  const zero = { toolCalls: 0, observations: 0, consequentialCalls: 0, projectMutationEffectCalls: 0,
    verificationCalls: 0, toolErrors: 0, deniedCalls: 0 };
  const policy = trialPolicy ? createPolicySnapshotFromRevisions({ approach: createStrategyRevisionSelection({
    strategyId: "portable-learning", kind: "approach", revisionIdentity: ID,
    revisionFingerprint: TRIAL_FINGERPRINT, revisionStatusAtRun: "trial",
    semantics: { summary: "Portable exact cognition", useWhen: ["migration"], avoidWhen: [], principles: ["keep provenance"] },
  }) }) : null;
  return assembleRunExperience({ task, runStart: { taskStatus: "active", taskGoal: task.goal },
    snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false,
      hasQuestions: false, completionReady: false, taskRelation: "preexisting_untouched",
      completionRelation: "not_completed", gateRelation: "none" },
    policy: { finalSnapshot: policy, declarationCount: policy === null ? 0 : 1,
      finalPolicyDeclarationCount: policy === null ? 0 : 1,
      finalPolicyFirstDeclaredAfter: policy === null ? null : zero,
      finalPolicyLastDeclaredAfter: policy === null ? null : zero },
    execution: { ...zero, toolCalls: 1, observations: 1 }, durationMs: 1, cost: 0,
    recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
}
let TRIAL_FINGERPRINT = `sha256:${"0".repeat(64)}`;

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "experience-lifecycle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const projectsBaseDir = join(home, "projects");
  const globalBaseDir = join(home, "global");
  const knowledge = new FileStrategyKnowledge({ projectsBaseDir, globalBaseDir });
  const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir, globalBaseDir });
  const directory = new FileRunExperienceStore({ baseDir: projectsBaseDir }).experienceDirectory(ROOT);
  await mkdir(directory, { recursive: true });
  const directoryFor = (root: string) => new FileRunExperienceStore({ baseDir: projectsBaseDir }).experienceDirectory(root);
  const put = async (i: number, trial = false, root = ROOT) => {
    await mkdir(directoryFor(root), { recursive: true });
    await writeFile(join(directoryFor(root), recordId(i)), JSON.stringify(experience(i, trial)));
  };
  const names = async (root = ROOT) => readdir(directoryFor(root));
  return { knowledge, maintenance, directory, directoryFor, put, names, home };
}

async function derived(f: Awaited<ReturnType<typeof fixture>>, sources: readonly string[]) {
  const candidate = createStrategyDerivationCandidate({ projectId: (createTrustedStrategyPortfolio(ROOT, createPromotedStrategyRevisionCatalog([]))).projectId,
    basePortfolio: createTrustedStrategyPortfolio(ROOT, createPromotedStrategyRevisionCatalog([])),
    candidateId: ID, createdAt: "2026-01-02T00:00:00.000Z",
    proposal: { strategyId: "portable-learning", kind: "approach", summary: "Portable exact cognition",
      useWhen: ["migration"], avoidWhen: [], principles: ["keep provenance"],
      sourceRecordIds: [...sources], hypothesis: "Evidence may support portable cognition." },
  });
  TRIAL_FINGERPRINT = strategyDerivationCandidateSemanticFingerprint(candidate);
  await f.knowledge.derivationCandidates.save(ROOT, candidate);
  return candidate;
}

test("retains <=256; recency uses recordedAt not filename; leaves unknown files untouched", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < MAX_LIVE_ORDINARY_EXPERIENCE_PER_PROJECT; i++) await f.put(i);
  await writeFile(join(f.directory, "notes.txt"), "keep");
  await writeFile(join(f.directory, recordId(999)), "broken json");
  assert.equal(await f.maintenance.prune(ROOT), 0);
  await f.put(256);
  await writeFile(join(f.directory, recordId(0)), JSON.stringify({ ...experience(0), recordedAt: "2026-01-03T00:00:00.000Z" }));
  assert.equal(await f.maintenance.prune(ROOT), 1);
  assert.equal((await f.names()).includes(recordId(0)), true);
  assert.equal((await f.names()).includes(recordId(1)), false);
  assert.equal((await f.names()).includes("notes.txt"), true);
  assert.equal(await readFile(join(f.directory, recordId(999)), "utf8"), "broken json");
});

test("schema-v4's non-ISO recordedAt cannot be ordered, so pruning fails closed", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i <= 256; i++) await f.put(i);
  await writeFile(join(f.directory, recordId(300)), JSON.stringify({ ...experience(300), recordedAt: "yesterday" }));
  await assert.rejects(f.maintenance.prune(ROOT), /canonical ISO instant/);
  assert.equal((await f.names()).length, 258);
});

test("unresolved local sources and global Trial survive; terminal trust survives later pruning", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 260; i++) await f.put(i);
  const candidate = await derived(f, [recordId(0), recordId(1), recordId(2)]);
  // A pre-existing unresolved local Candidate requires its exact source set.
  assert.equal(await f.maintenance.prune(ROOT), 1);
  assert.equal((await f.names()).includes(recordId(0)), true);
  assert.equal((await f.names()).includes(recordId(3)), false);
  await f.knowledge.derivationDecisions.save(ROOT, createStrategyDerivationDecision({
    candidate, decision: "promoted", decidedAt: "2026-01-03T00:00:00.000Z", trialRecordIds: ["trial-a", "trial-b"],
  }));
  const before = await f.knowledge.projectTrust.readProjectId(candidate.projectId);
  const scope = createStrategyTrustScopeCandidate({ candidateId: SCOPE_ID, createdAt: "2026-01-04T00:00:00.000Z",
    sourceStrategy: { sourceProjectId: candidate.projectId, strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind, revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate) },
  });
  await f.knowledge.scopeCandidates.save(scope);
  // A scope Trial in this source project is ineligible; a local trial for a terminal Candidate is historical too.
  await f.put(270, true);
  assert.equal(await f.maintenance.prune(ROOT), 4);
  assert.equal((await f.names()).includes(recordId(0)), false);
  assert.equal((await f.names()).includes(recordId(270)), false);
  assert.deepEqual(await f.knowledge.projectTrust.readProjectId(candidate.projectId), before);
  const snapshot = await f.knowledge.exportSnapshot();
  assert.equal(JSON.stringify(snapshot).includes("Task 259"), false);
  assert.equal(snapshot.projects[0]?.derivationDecisions[0]?.decision, "promoted");
});

test("unresolved Seed Revision source evidence is protected until a terminal Decision", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i <= 257; i++) await f.put(i);
  const candidate = createStrategyRevisionCandidate({ target: getSeedStrategy("direct-action")!, candidateId: ID,
    createdAt: "2026-01-02T00:00:00.000Z", proposal: {
      summary: "Verify focused moves", useWhen: ["small change"], avoidWhen: [], principles: ["verify"],
      sourceRecordIds: [recordId(0), recordId(1)], hypothesis: "A focused check may help." },
  });
  await f.knowledge.revisionCandidates.save(ROOT, candidate);
  assert.equal(await f.maintenance.prune(ROOT), 0);
  await f.knowledge.revisionDecisions.save(ROOT, createStrategyRevisionDecision({
    candidate, decision: "rejected", decidedAt: "2026-01-03T00:00:00.000Z", trialRecordIds: [],
  }));
  assert.equal(await f.maintenance.prune(ROOT), 2);
  assert.equal((await f.names()).includes(recordId(0)), false);
});

test("unresolved local Trial evidence is retained until terminal Decision", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i <= 256; i++) await f.put(i);
  const candidate = await derived(f, [recordId(0), recordId(1), recordId(2)]);
  await f.put(300, true);
  assert.equal(await f.maintenance.prune(ROOT), 0);
  assert.equal((await f.names()).includes(recordId(300)), true);
  await f.knowledge.derivationDecisions.save(ROOT, createStrategyDerivationDecision({ candidate,
    decision: "rejected", decidedAt: "2026-01-03T00:00:00.000Z", trialRecordIds: [],
  }));
  assert.equal(await f.maintenance.prune(ROOT), 2);
  assert.equal((await f.names()).includes(recordId(300)), false);
  assert.equal((await f.names()).includes(recordId(0)), false);
});

test("open cross-project Scope Trial remains protected; terminal refs and discovery provenance do not pin Experience", async (t) => {
  const f = await fixture(t);
  const candidate = await derived(f, [recordId(300), recordId(301), recordId(302)]);
  await f.knowledge.derivationDecisions.save(ROOT, createStrategyDerivationDecision({
    candidate, decision: "promoted", decidedAt: "2026-01-01T00:00:00.000Z", trialRecordIds: ["t1", "t2"],
  }));
  const scope = createStrategyTrustScopeCandidate({ candidateId: SCOPE_ID, createdAt: "2026-01-01T00:00:00.000Z",
    sourceStrategy: { sourceProjectId: getProjectId(ROOT), strategyId: candidate.proposal.strategyId,
      kind: candidate.proposal.kind, revisionIdentity: candidate.candidateId,
      revisionFingerprint: strategyDerivationCandidateSemanticFingerprint(candidate) },
  });
  await f.knowledge.scopeCandidates.save(scope);
  const target = "/another-project";
  await f.put(0, true, target);
  for (let i = 1; i <= 260; i++) await f.put(i, false, target);
  assert.equal(await f.maintenance.prune(target), 4);
  assert.equal((await f.names(target)).includes(recordId(0)), true);
  await f.knowledge.scopeDecisions.save(createStrategyTrustScopeDecision({ candidate: scope,
    decision: "rejected", decidedAt: "2026-01-06T00:00:00.000Z", trialRefs: [],
  }));
  assert.equal(await f.maintenance.prune(target), 1);
  assert.equal((await f.names(target)).includes(recordId(0)), false);
  // A promoted local source's discovery IDs were never required by current trust.
  assert.equal((await f.names(ROOT)).length, 0);
});

test("incoherent source/Decision protection refuses all deletion; save remains authoritative on cleanup failure", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 257; i++) await f.put(i);
  await derived(f, [recordId(0), recordId(1), recordId(999)]);
  await assert.rejects(f.maintenance.prune(ROOT), /Unresolved learning source/);
  assert.equal((await f.names()).includes(recordId(0)), true);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const store = new FileRunExperienceStore({ baseDir: join(f.home, "projects"), onSaved: async (root) => {
      await f.maintenance.prune(root);
    } });
    await store.save(ROOT, experience(300));
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
  assert.equal((await f.names()).length, 258);
});
