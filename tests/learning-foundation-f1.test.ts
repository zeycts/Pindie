import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { reduceState } from "../src/transitions.ts";
import { FileWorkEpisodeLedger } from "../src/work-episode.ts";
import { FileRunExperienceReader, FileRunExperienceStore } from "../src/experience-store.ts";
import { assembleRunExperience, parseRunExperience } from "../src/run-experience.ts";
import { runExperienceRecordFingerprint } from "../src/run-experience-fingerprint.ts";
import { crossProjectExperienceRecordFingerprint } from "../src/cross-project-experience.ts";
import { FileRunExperienceMaintenance } from "../src/experience-lifecycle.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { DEFAULT_LEARNING_BUDGET_POLICY, FINGERPRINT, validateLearningBudgetPolicy, learningJobKey, learningFingerprint, validateStrategyHypothesis, validateWorkEpisodeBinding, validateLearningJob, validateExactEvidenceRef, validateDiscoveryReceipt, validateTrialAssignment, validateTrialEvidence, validateStrategyEvaluation, validateStrategyDecision, learningArtifactFingerprint, hypothesisFingerprint, validateLearningArtifactRef, matchesLearningArtifactRef, matchesTrialEvidenceAssignment, matchesEvaluationTrial, matchesDecisionEvaluation, matchesLearningJobOutput, validateLearningTerminalOutput } from "../src/learning-v1-contract.ts";
import { exactRunWorkEpisodeId } from "../src/work-episode-attribution.ts";

const ROOT = "/repo/f1";
const start = { type: "start_task" as const, goal: "goal", constraints: [], successCriteria: ["done"] };
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pindie-f1-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(dir, { recursive: true, force: true }); });
  const projects = join(dir, "projects");
  const store = new FileStateStore({ baseDir: projects });
  const reader = new FileRunExperienceReader({ baseDir: projects });
  const episodes = new FileWorkEpisodeLedger({ projectsBaseDir: projects, stateStore: store, experienceReader: reader });
  return { dir, projects, store, reader, episodes, runtime: new PindieRuntime(store, episodes) };
}
test("F1 episode is stable through refinement, Runs, reload and completion; replacement rotates it", async (t) => {
  const f = await setup(t);
  await f.runtime.load(ROOT);
  assert.equal((await f.runtime.dispatch(start)).ok, true);
  const first = await f.episodes.current(ROOT, f.runtime.state);
  assert.match(first!, /^[0-9a-f-]{36}$/);
  await f.runtime.dispatch({ type: "refine_task", goal: "refined" });
  assert.equal(await f.episodes.current(ROOT, f.runtime.state), first);
  const reload = new PindieRuntime(f.store, f.episodes);
  await reload.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, reload.state), first);
  await reload.dispatch({ type: "replace_task", goal: "next", constraints: [], successCriteria: ["done"] });
  const second = await f.episodes.current(ROOT, reload.state);
  assert.notEqual(second, first);
  await reload.dispatch({ type: "record_verification", check: { name: "ok", status: "passed", covers: ["c1"], evidence: "observed" } });
  await reload.dispatch({ type: "complete_task" });
  assert.equal(await f.episodes.current(ROOT, reload.state), second);
  const file = JSON.parse(await readFile(join(f.projects, getProjectId(ROOT), "work-episode.json"), "utf8"));
  assert.equal(file.current, null);
  assert.equal(file.lastClosed.episodeId, second);
  await new PindieRuntime(f.store, f.episodes).load(ROOT);
});
test("F1 pre-v1 active State bootstraps once, but missing ledger with v5 evidence does not remint", async (t) => {
  const f = await setup(t);
  const legacy = new PindieRuntime(f.store);
  await legacy.load(ROOT);
  await legacy.dispatch(start);
  const first = new PindieRuntime(f.store, f.episodes);
  await first.load(ROOT);
  const id = await f.episodes.current(ROOT, first.state);
  assert.ok(id);
  const next = new PindieRuntime(f.store, f.episodes);
  await next.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, next.state), id);
  const { rm } = await import("node:fs/promises");
  await rm(join(f.projects, getProjectId(ROOT), "work-episode.json"));
  const dir = join(f.projects, getProjectId(ROOT), "experience");
  await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
  await writeFile(join(dir, "00000000-0000-4000-8000-000000000000.json"), JSON.stringify({ schemaVersion: 5, workEpisodeId: id }));
  const uncertain = new PindieRuntime(f.store, f.episodes);
  await uncertain.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, uncertain.state), null);
});
test("F1 crash mismatch and corrupt binding fail closed without blocking semantic transitions", async (t) => {
  const f = await setup(t);
  await f.runtime.load(ROOT);
  await f.runtime.dispatch(start);
  const file = join(f.projects, getProjectId(ROOT), "work-episode.json");
  const old = await readFile(file, "utf8");
  await f.runtime.dispatch({ type: "refine_task", goal: "crashed after State save" });
  await writeFile(file, old); // simulate State committed before ledger rename
  const restarted = new PindieRuntime(f.store, f.episodes);
  await restarted.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, restarted.state), null);
  assert.equal((await restarted.dispatch({ type: "replace_task", goal: "fresh", constraints: [], successCriteria: ["done"] })).ok, true);
  assert.ok(await f.episodes.current(ROOT, restarted.state));
  // Interrupted identical replacement must not resurrect the old ID.
  await f.episodes.prepared(ROOT, restarted.state, { type: "replace_task", goal: "fresh", constraints: [], successCriteria: ["done"] });
  const uncertain = new PindieRuntime(f.store, f.episodes);
  await uncertain.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, uncertain.state), null);
  await writeFile(file, "{broken");
  const corrupt = new PindieRuntime(f.store, f.episodes);
  await corrupt.load(ROOT);
  assert.equal((await corrupt.dispatch({ type: "refine_task", goal: "human continues" })).ok, true);
  await assert.rejects(f.episodes.current(ROOT, corrupt.state), /Corrupt/);
});
test("F1 same-contract replacement crash marker prevents old identity reuse on both sides of State commit", async (t) => {
  const f = await setup(t);
  await f.runtime.load(ROOT);
  await f.runtime.dispatch(start);
  const old = await f.episodes.current(ROOT, f.runtime.state);
  const replace = { ...start, type: "replace_task" as const };
  await f.store.withProjectLock(ROOT, async () => { await f.episodes.prepared(ROOT, f.runtime.state, replace); });
  const beforeCommit = new PindieRuntime(f.store, f.episodes);
  await beforeCommit.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, beforeCommit.state), null);
  const result = reduceState(beforeCommit.state, replace);
  assert.equal(result.ok, true);
  if (result.ok) await f.store.withProjectLock(ROOT, () => f.store.save(ROOT, result.state));
  const afterCommit = new PindieRuntime(f.store, f.episodes);
  await afterCommit.load(ROOT);
  assert.equal(await f.episodes.current(ROOT, afterCommit.state), null);
  assert.equal((await afterCommit.dispatch(replace)).ok, true);
  const fresh = await f.episodes.current(ROOT, afterCommit.state);
  assert.ok(fresh);
  assert.notEqual(fresh, old);
});
test("F1 run attribution never assigns one Run crossing episodes to its final Task", async (t) => {
  const f = await setup(t);
  await f.runtime.load(ROOT);
  const empty = { projectRoot: ROOT, episodeId: null, taskWasOpen: false, occurrenceEpoch: f.runtime.taskOccurrenceEpoch, externalStateEpoch: f.runtime.externalStateEpoch };
  await f.runtime.dispatch(start);
  const a = await f.episodes.current(ROOT, f.runtime.state);
  const end = () => ({ projectRoot: ROOT, state: f.runtime.state, episodeId: a, occurrenceEpoch: f.runtime.taskOccurrenceEpoch, externalStateEpoch: f.runtime.externalStateEpoch });
  assert.equal(exactRunWorkEpisodeId(empty, end()), a); // idle -> one Task
  const startA = { ...empty, episodeId: a, taskWasOpen: true, occurrenceEpoch: f.runtime.taskOccurrenceEpoch };
  assert.equal(exactRunWorkEpisodeId(startA, end()), a); // stable across Runs
  await f.runtime.dispatch({ ...start, type: "replace_task" });
  const b = await f.episodes.current(ROOT, f.runtime.state);
  assert.notEqual(a, b);
  assert.equal(exactRunWorkEpisodeId(startA, { ...end(), episodeId: b }), null); // A -> B
  assert.equal(exactRunWorkEpisodeId(empty, { ...end(), episodeId: b }), null); // idle -> A -> B
  assert.equal(exactRunWorkEpisodeId(startA, { ...end(), episodeId: b, externalStateEpoch: 99 }), null);
});
test("F1 jobs are deterministic, fenced, persistent and never silently compacted", async (t) => {
  const f = await setup(t);
  const root = join(f.dir, "global");
  const ledger = new FileLearningJobLedger({ globalBaseDir: root });
  const scope = { kind: "project" as const, projectId: getProjectId(ROOT) };
  const fp = `sha256:${"a".repeat(64)}`;
  const key = learningJobKey("project-discovery", scope, fp, 1);
  const receiptBody = { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000000",
    jobKey: key, packetFingerprint: fp, scope, outcome: "none", hypotheses: [],
    sources: [{ projectId: scope.projectId, recordId: "00000000-0000-4000-8000-000000000001.json", fingerprint: fp, recordedAt: "2026-01-01T00:00:00.000Z" }] };
  const receipt = { ...receiptBody, fingerprint: learningArtifactFingerprint(receiptBody) };
  const receiptRef = { schemaVersion: 1 as const, family: "discovery-receipt" as const, scope,
    id: receipt.id, fingerprint: receipt.fingerprint };
  const a = await ledger.enqueue("project-discovery", scope, fp, 1, 100);
  assert.equal(a.key, key);
  assert.deepEqual(await ledger.enqueue("project-discovery", scope, fp, 1, 200), a);
  const lease = await ledger.claim(key, "one", 100, 10, 200, 1000);
  assert.ok(lease);
  assert.equal(await ledger.claim(key, "two", 100, 10, 0, 0), null);
  const other = await ledger.enqueue("evaluation", scope, fp, 1, 100);
  assert.equal(await ledger.claim(other.key, "two", 100, 10, 0, 0), null); // global one-running invariant
  await assert.rejects(ledger.complete(key, "wrong", receiptRef), /Stale/);
  const restarted = new FileLearningJobLedger({ globalBaseDir: root });
  assert.equal(await restarted.reconcileExpired(111), 1);
  assert.equal((await restarted.listEligible(111))[0]?.key, key);
  assert.equal((await restarted.read())[0]?.stopReason, "timeout");
  const next = await restarted.claim(key, "two", 111, 10, 0, 0);
  assert.notEqual(next?.leaseToken, lease?.leaseToken);
  await assert.rejects(restarted.complete(key, lease!.leaseToken!, receiptRef), /Stale/);
  await restarted.release(key, next!.leaseToken!, 115, "human-work");
  assert.equal((await restarted.read())[0]?.stopReason, "human-work");
  const final = await restarted.claim(key, "three", 115, 10, 0, 0);
  assert.equal(final?.stopReason, null);
  await assert.rejects(restarted.complete(key, final!.leaseToken!, { ...receiptRef, scope: { kind: "user-global" } }), /validation/);
  await restarted.complete(key, final!.leaseToken!, receiptRef);
  assert.deepEqual((await restarted.read())[0]?.terminalReceiptRef, receiptRef);
  assert.ok(validateLearningJob((await restarted.read())[0]));
  assert.equal(validateDiscoveryReceipt(receipt), true);
  assert.equal(matchesLearningArtifactRef((await restarted.read())[0]!.terminalReceiptRef, receipt), true);
  assert.equal(matchesLearningJobOutput((await restarted.read())[0]!, receipt), true);
  const wrongKeyReceipt = { ...receipt, jobKey: fp };
  assert.equal(matchesLearningJobOutput((await restarted.read())[0]!, { ...wrongKeyReceipt, fingerprint: learningArtifactFingerprint(wrongKeyReceipt) }), false);
  assert.equal(matchesLearningArtifactRef((await restarted.read())[0]!.terminalReceiptRef, { ...receipt, packetFingerprint: key }), false);
  assert.deepEqual(await restarted.enqueue("project-discovery", scope, fp, 1, 300), (await restarted.read())[0]);
  const failing = new FileLearningJobLedger({ globalBaseDir: root, onBeforeRename: async () => { throw new Error("disk failure"); } });
  await assert.rejects(failing.enqueue("evaluation", scope, `sha256:${"d".repeat(64)}`, 1, 300), /disk failure/);
  assert.equal((await restarted.read()).length, 2);
  await writeFile(join(root, "learning-v1", "jobs.json"), "not json");
  await assert.rejects(restarted.enqueue("evaluation", scope, fp, 1, 300), /Malformed/);
});
test("F1 independent job directory initializes, owner/token are strictly bounded", async (t) => {
  const f = await setup(t);
  const base = join(f.dir, "shared-global");
  await (await import("node:fs/promises")).mkdir(join(base, "learning-v1"), { recursive: true });
  const ledger = new FileLearningJobLedger({ globalBaseDir: base });
  assert.deepEqual(await ledger.read(), []);
  const scope = { kind: "project" as const, projectId: getProjectId(ROOT) };
  const job = await ledger.enqueue("evaluation", scope, `sha256:${"e".repeat(64)}`, 1, 1);
  await assert.rejects(ledger.claim(job.key, "x".repeat(129), 1, 10, 0, 0), /claim/);
  const claimed = await ledger.claim(job.key, "owner", 1, 10, 0, 0);
  assert.ok(validateLearningJob(claimed));
  assert.equal(validateLearningJob({ ...claimed, leaseOwner: "x".repeat(129) }), false);
  assert.equal(validateLearningJob({ ...claimed, leaseToken: "arbitrary" }), false);
  assert.equal(await ledger.claim(job.key, "another", 1, 10, 0, 0), null);
});
test("F1 ledger at capacity refuses enqueue without evicting pending/running", async (t) => {
  const f = await setup(t);
  const globalBaseDir = join(f.dir, "capacity");
  const ledger = new FileLearningJobLedger({ globalBaseDir });
  const scope = { kind: "project" as const, projectId: getProjectId(ROOT) };
  const first = await ledger.enqueue("project-discovery", scope, `sha256:${"0".repeat(64)}`, 1, 1);
  const jobs = Array.from({ length: 2048 }, (_, index) => {
    const inputFingerprint = `sha256:${index.toString(16).padStart(64, "0")}`;
    return { ...first, inputFingerprint, key: learningJobKey("project-discovery", scope, inputFingerprint, 1) };
  });
  await writeFile(join(globalBaseDir, "learning-v1", "jobs.json"), JSON.stringify({ schemaVersion: 1, jobs }));
  await assert.rejects(ledger.enqueue("evaluation", scope, `sha256:${"f".repeat(64)}`, 1, 2), /capacity/);
  assert.equal((await ledger.read()).length, 2048);
  assert.equal((await ledger.read())[0]?.state, "pending");
});
test("F1 v4 remains readable; coherent v5 survives storage and pruning", async (t) => {
  const f = await setup(t);
  await f.runtime.load(ROOT);
  await f.runtime.dispatch(start);
  const episodeId = (await f.episodes.current(ROOT, f.runtime.state))!;
  const input = {
    task: f.runtime.state.task!, runStart: { taskStatus: "active" as const, taskGoal: "goal" },
    snapshot: { authority: "coherent" as const, taskStatus: "active" as const,
      verificationStatus: "pending" as const, hasBlockers: false, hasQuestions: false,
      completionReady: false, taskRelation: "preexisting_untouched" as const,
      completionRelation: "not_completed" as const, gateRelation: "none" as const },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0,
      finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0,
      verificationCalls: 0, toolErrors: 0, deniedCalls: 0 }, durationMs: 1, cost: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  const v4 = assembleRunExperience(input);
  const v5 = assembleRunExperience({ ...input, workEpisodeId: episodeId });
  assert.equal(v4.schemaVersion, 4);
  assert.equal(v5.schemaVersion, 5);
  assert.equal(runExperienceRecordFingerprint(v4), "sha256:76fb8aa2d87549d6e4f4e167a828c61bf5f6b1c1416b0be540021c442ffdb6c1");
  assert.equal(crossProjectExperienceRecordFingerprint(v4), runExperienceRecordFingerprint(v4));
  assert.equal(crossProjectExperienceRecordFingerprint(v5), runExperienceRecordFingerprint(v5));
  assert.notEqual(runExperienceRecordFingerprint(v5), runExperienceRecordFingerprint({ ...v5, workEpisodeId: "11111111-1111-4111-8111-111111111111" }));
  assert.deepEqual(parseRunExperience(JSON.parse(JSON.stringify(v4))), v4);
  assert.deepEqual(parseRunExperience(JSON.parse(JSON.stringify(v5))), v5);
  const store = new FileRunExperienceStore({ baseDir: f.projects });
  await store.save(ROOT, v4);
  await store.save(ROOT, v5);
  assert.equal((await f.reader.read(ROOT)).loadedRecords, 2);
  await new FileRunExperienceMaintenance({ projectsBaseDir: f.projects, globalBaseDir: join(f.dir, "global") }).prune(ROOT);
  const result = await f.reader.read(ROOT);
  assert.equal(result.loadedRecords, 2);
  assert.ok(result.records.some((r) => r.experience.schemaVersion === 5 && r.experience.workEpisodeId === episodeId));
});
test("F1 hypothesis contract rejects authority-bearing fields and fingerprint drift", () => {
  const semantic = { schemaVersion: 1, scope: { kind: "user-global" }, logicalId: "focus", kind: "approach",
    lineage: "new", parent: null, baseRevisionFingerprint: null, summary: "Focus on evidence",
    useWhen: ["Evidence exists"], avoidWhen: ["No evidence"], expectedEffect: "Fewer regressions",
    failureSignals: ["More regressions"], trialHints: [],
    sources: [{ projectId: "a".repeat(64), recordId: "00000000-0000-4000-8000-000000000000.json", fingerprint: `sha256:${"b".repeat(64)}` }],
    discoveryPacketFingerprint: `sha256:${"c".repeat(64)}` };
  const hypothesis = { ...semantic, id: "00000000-0000-4000-8000-000000000000", fingerprint: hypothesisFingerprint(semantic as Parameters<typeof hypothesisFingerprint>[0]) };
  assert.equal(validateStrategyHypothesis(hypothesis), true);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, capability: "task.complete" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, expectedEffect: "" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, fingerprint: `sha256:${"d".repeat(64)}` }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, parent: { schemaVersion: 1, family: "strategy-hypothesis", scope: semantic.scope, id: hypothesis.id, fingerprint: `sha256:${"b".repeat(64)}` } }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, baseRevisionFingerprint: `sha256:${"b".repeat(64)}` }), false);
  const revision = { ...hypothesis, lineage: "revise", parent: { schemaVersion: 1, family: "strategy-hypothesis", scope: semantic.scope, id: "11111111-1111-4111-8111-111111111111", fingerprint: `sha256:${"b".repeat(64)}` } };
  assert.equal(validateStrategyHypothesis({ ...revision, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(revision) as Parameters<typeof hypothesisFingerprint>[0]) }), true);
  const trustedRevision = { ...hypothesis, lineage: "revise", parent: null, baseRevisionFingerprint: `sha256:${"e".repeat(64)}` };
  assert.equal(validateStrategyHypothesis({ ...trustedRevision, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(trustedRevision) as Parameters<typeof hypothesisFingerprint>[0]) }), true);
  const unanchored = { ...hypothesis, lineage: "revise", parent: null, baseRevisionFingerprint: null };
  assert.equal(validateStrategyHypothesis({ ...unanchored, fingerprint: hypothesisFingerprint((({ id: _id, fingerprint: _fp, ...rest }) => rest)(unanchored) as Parameters<typeof hypothesisFingerprint>[0]) }), false);
});
test("F1 all frozen artifact shells reject extra fields, malformed IDs and inconsistent relations", () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const other = "11111111-1111-4111-8111-111111111111";
  const fp = `sha256:${"a".repeat(64)}`;
  const projectId = "a".repeat(64);
  const ref = { projectId, recordId: `${id}.json`, fingerprint: fp };
  assert.equal(validateExactEvidenceRef(ref), true);
  assert.equal(validateExactEvidenceRef({ ...ref, recordId: id }), false);
  assert.equal(validateExactEvidenceRef({ ...ref, fingerprint: "a".repeat(64) }), false);
  const binding = { schemaVersion: 1, projectId, episodeId: id, observedStateFingerprint: fp,
    openedAt: "2026-01-01T00:00:00.000Z", closedAt: null };
  assert.equal(validateWorkEpisodeBinding(binding), true);
  assert.equal(validateWorkEpisodeBinding({ ...binding, invented: true }), false);
  assert.equal(validateWorkEpisodeBinding({ ...binding, closedAt: "2025-01-01T00:00:00.000Z" }), false);
  const scope = { kind: "project" as const, projectId };
  const hyp = { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope, id: other, fingerprint: fp };
  const seal = <T extends Record<string, unknown>>(content: T) => ({ ...content, fingerprint: learningArtifactFingerprint(content) });
  const receipt = seal({ schemaVersion: 1, id, jobKey: fp, packetFingerprint: fp, scope, outcome: "none", hypotheses: [], sources: [{ ...ref, recordedAt: "2026-01-01T00:00:00.000Z" }] });
  assert.equal(validateDiscoveryReceipt(receipt), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "published" })), false);
  const published = seal({ ...receipt, outcome: "published", hypotheses: [hyp] });
  assert.equal(validateDiscoveryReceipt(published), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...published, hypotheses: [{ ...hyp, scope: { kind: "user-global" } }] })), false);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "covered", hypotheses: [hyp] })), true);
  assert.equal(validateDiscoveryReceipt(seal({ ...receipt, outcome: "covered", hypotheses: [] })), false);
  assert.equal(validateDiscoveryReceipt({ ...receipt, id: "arbitrary" }), false);
  const assignment = seal({ schemaVersion: 1, id, projectId, workEpisodeId: other, sessionId: "session",
    hypothesis: hyp, comparison: [ref], offerPolicyFingerprint: fp, expiresAt: 100 });
  const assignmentRef = { schemaVersion: 1 as const, family: "trial-assignment" as const, scope, id, fingerprint: assignment.fingerprint };
  assert.equal(validateTrialAssignment(assignment), true);
  assert.equal(validateTrialAssignment(seal({ ...assignment, comparison: [{ ...ref, projectId: "b".repeat(64) }] })), false);
  assert.equal(validateLearningArtifactRef(assignmentRef), true);
  assert.equal(validateLearningArtifactRef({ ...assignmentRef, scope: { kind: "user-global" } }), false);
  assert.equal(matchesLearningArtifactRef(assignmentRef, assignment), true);
  assert.equal(matchesLearningArtifactRef({ ...assignmentRef, fingerprint: fp }, assignment), false);
  assert.equal(validateTrialAssignment({ ...assignment, permission: "task.complete" }), false);
  assert.equal(validateTrialAssignment({ ...assignment, expiresAt: 101 }), false); // exact content changed
  assert.notEqual(learningArtifactFingerprint({ ...assignment, expiresAt: 101 }), assignment.fingerprint);
  const evidence = seal({ schemaVersion: 1, id, assignment: assignmentRef, hypothesis: hyp, source: ref,
    workEpisodeId: other, exposed: true, eligible: true, eligibilityReason: "verified",
    outcome: "passed", regressions: [], comparison: [] });
  const evidenceRef = { schemaVersion: 1 as const, family: "trial-evidence" as const, scope, id, fingerprint: evidence.fingerprint };
  assert.equal(validateTrialEvidence(evidence), true);
  assert.equal(validateLearningArtifactRef({ ...evidenceRef, scope: { kind: "user-global" } }), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, assignment: { ...assignmentRef, scope: { kind: "user-global" } } })), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, comparison: [{ ...ref, projectId: "b".repeat(64) }] })), false);
  assert.equal(matchesTrialEvidenceAssignment(evidence, assignment), true);
  assert.equal(matchesTrialEvidenceAssignment(seal({ ...evidence, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), assignment), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, exposed: false })), false);
  assert.equal(validateTrialEvidence(seal({ ...evidence, assignment: { ...assignmentRef, family: "strategy-evaluation" } })), false);
  const evaluation = seal({ schemaVersion: 1, id, hypothesis: hyp, packetFingerprint: fp,
    gateVersion: 1, trialEvidence: [evidenceRef], verdict: "continue-testing", rationale: "not enough data", citedHandles: ["E1"] });
  const evaluationRef = { schemaVersion: 1 as const, family: "strategy-evaluation" as const, scope, id, fingerprint: evaluation.fingerprint };
  assert.equal(validateStrategyEvaluation(evaluation), true);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, scope: { kind: "project", projectId: "b".repeat(64) } }] })), false);
  const globalHyp = { ...hyp, scope: { kind: "user-global" as const } };
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, hypothesis: globalHyp,
    trialEvidence: [evidenceRef, { ...evidenceRef, scope: { kind: "project", projectId: "b".repeat(64) } }] })), true);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, hypothesis: globalHyp,
    trialEvidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(matchesEvaluationTrial(evaluation, evidence), true);
  assert.equal(matchesEvaluationTrial(seal({ ...evaluation, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), evidence), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, verdict: "suspend" })), false);
  assert.equal(validateStrategyEvaluation(seal({ ...evaluation, trialEvidence: [{ ...evidenceRef, fingerprint: "bad" }] })), false);
  const decision = seal({ schemaVersion: 1, id, scope, action: "promote", actor: "autonomous", hypothesis: hyp,
    evaluation: evaluationRef, evidence: [evidenceRef], supersedes: null, decidedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(validateStrategyDecision(decision), true);
  assert.equal(validateStrategyDecision(seal({ ...decision, evaluation: { ...evaluationRef, scope: { kind: "user-global" } } })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, scope: globalHyp.scope, hypothesis: globalHyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, evidence: [{ ...evidenceRef, scope: { kind: "user-global" } }] })), false);
  assert.equal(matchesDecisionEvaluation(decision, evaluation), false); // continue-testing cannot promote
  const promoting = seal({ ...evaluation, verdict: "promote" });
  assert.equal(matchesDecisionEvaluation(seal({ ...decision, evaluation: { ...evaluationRef, fingerprint: promoting.fingerprint } }), promoting), true);
  assert.equal(matchesDecisionEvaluation(seal({ ...decision, evaluation: { ...evaluationRef, fingerprint: promoting.fingerprint }, hypothesis: { ...hyp, fingerprint: `sha256:${"b".repeat(64)}` } }), promoting), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, evaluation: null })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "reject", supersedes: hyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, supersedes: hyp })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "suspend", evaluation: evaluationRef })), false);
  assert.equal(validateStrategyDecision(seal({ ...decision, action: "suspend", evaluation: null,
    evidence: [{ schemaVersion: 1, family: "terminal-output", scope, id: other, fingerprint: fp }] })), true);
  assert.equal(validateStrategyDecision({ ...decision, actor: "human" }), false); // self-fingerprint binds every field
  assert.equal(matchesLearningArtifactRef({ schemaVersion: 1, family: "strategy-decision", scope, id, fingerprint: decision.fingerprint }, decision), true);
  const terminal = seal({ schemaVersion: 1, id, scope, jobKey: fp, state: "cancelled", stopReason: "budget" });
  assert.equal(validateLearningTerminalOutput(terminal), true);
  assert.equal(matchesLearningArtifactRef({ schemaVersion: 1, family: "terminal-output", scope, id, fingerprint: terminal.fingerprint }, terminal), true);
  assert.equal(validateLearningTerminalOutput(seal({ ...terminal, state: "completed" })), false);
});
test("F1 budget validates bounded positive policy", () => {
  assert.equal(validateLearningBudgetPolicy(DEFAULT_LEARNING_BUDGET_POLICY), true);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, maxAttempts: 0 }), false);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, perJobTokenCap: 30_000 }), false);
  assert.match(learningJobKey("evaluation", { kind: "user-global" }, `sha256:${"a".repeat(64)}`, 1), FINGERPRINT);
});
