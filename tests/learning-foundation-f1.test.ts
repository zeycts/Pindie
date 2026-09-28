import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore, getProjectId } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { FileWorkEpisodeLedger } from "../src/work-episode.ts";
import { FileRunExperienceReader, FileRunExperienceStore } from "../src/experience-store.ts";
import { assembleRunExperience, parseRunExperience } from "../src/run-experience.ts";
import { FileRunExperienceMaintenance } from "../src/experience-lifecycle.ts";
import { FileLearningJobLedger } from "../src/learning-job-store.ts";
import { DEFAULT_LEARNING_BUDGET_POLICY, FINGERPRINT, validateLearningBudgetPolicy, learningJobKey, learningFingerprint, validateStrategyHypothesis } from "../src/learning-v1-contract.ts";

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
test("F1 jobs are deterministic, fenced, persistent and never silently compacted", async (t) => {
  const f = await setup(t);
  const root = join(f.dir, "global");
  const ledger = new FileLearningJobLedger({ globalBaseDir: root });
  const scope = { kind: "project" as const, projectId: getProjectId(ROOT) };
  const fp = "a".repeat(64);
  const key = learningJobKey("project-discovery", scope, fp, 1);
  const a = await ledger.enqueue("project-discovery", scope, fp, 1, 100);
  assert.equal(a.key, key);
  assert.deepEqual(await ledger.enqueue("project-discovery", scope, fp, 1, 200), a);
  const lease = await ledger.claim(key, "one", 100, 10, 200, 1000);
  assert.ok(lease);
  assert.equal(await ledger.claim(key, "two", 100, 10, 0, 0), null);
  await assert.rejects(ledger.complete(key, "wrong", fp), /Stale/);
  const restarted = new FileLearningJobLedger({ globalBaseDir: root });
  assert.equal(await restarted.reconcileExpired(111), 1);
  assert.equal((await restarted.listEligible(111))[0]?.key, key);
  const next = await restarted.claim(key, "two", 111, 10, 0, 0);
  assert.notEqual(next?.leaseToken, lease?.leaseToken);
  await assert.rejects(restarted.complete(key, lease!.leaseToken!, fp), /Stale/);
  await restarted.complete(key, next!.leaseToken!, fp);
  assert.deepEqual(await restarted.enqueue("project-discovery", scope, fp, 1, 300), (await restarted.read())[0]);
  const failing = new FileLearningJobLedger({ globalBaseDir: root, onBeforeRename: async () => { throw new Error("disk failure"); } });
  await assert.rejects(failing.enqueue("evaluation", scope, fp, 1, 300), /disk failure/);
  assert.equal((await restarted.read()).length, 1);
  await writeFile(join(root, "learning-v1", "jobs.json"), "not json");
  await assert.rejects(restarted.enqueue("evaluation", scope, fp, 1, 300), /Malformed/);
});
test("F1 ledger at capacity refuses enqueue without evicting pending/running", async (t) => {
  const f = await setup(t);
  const globalBaseDir = join(f.dir, "capacity");
  const ledger = new FileLearningJobLedger({ globalBaseDir });
  const scope = { kind: "project" as const, projectId: getProjectId(ROOT) };
  const first = await ledger.enqueue("project-discovery", scope, "0".repeat(64), 1, 1);
  const jobs = Array.from({ length: 2048 }, (_, index) => {
    const inputFingerprint = index.toString(16).padStart(64, "0");
    return { ...first, inputFingerprint, key: learningJobKey("project-discovery", scope, inputFingerprint, 1) };
  });
  await writeFile(join(globalBaseDir, "learning-v1", "jobs.json"), JSON.stringify({ schemaVersion: 1, jobs }));
  await assert.rejects(ledger.enqueue("evaluation", scope, "f".repeat(64), 1, 2), /capacity/);
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
  };
  const v4 = assembleRunExperience(input);
  const v5 = assembleRunExperience({ ...input, workEpisodeId: episodeId });
  assert.equal(v4.schemaVersion, 4);
  assert.equal(v5.schemaVersion, 5);
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
    lineage: "new", parentFingerprint: null, baseRevisionFingerprint: null, summary: "Focus on evidence",
    useWhen: ["Evidence exists"], avoidWhen: ["No evidence"], expectedEffect: "Fewer regressions",
    failureSignals: ["More regressions"], trialHints: [],
    sources: [{ projectId: "a".repeat(64), recordId: "r", fingerprint: "b".repeat(64) }],
    discoveryPacketFingerprint: "c".repeat(64) };
  const hypothesis = { ...semantic, id: "00000000-0000-4000-8000-000000000000", fingerprint: learningFingerprint(semantic) };
  assert.equal(validateStrategyHypothesis(hypothesis), true);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, capability: "task.complete" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, expectedEffect: "" }), false);
  assert.equal(validateStrategyHypothesis({ ...hypothesis, fingerprint: "d".repeat(64) }), false);
});
test("F1 budget validates bounded positive policy", () => {
  assert.equal(validateLearningBudgetPolicy(DEFAULT_LEARNING_BUDGET_POLICY), true);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, maxAttempts: 0 }), false);
  assert.equal(validateLearningBudgetPolicy({ ...DEFAULT_LEARNING_BUDGET_POLICY, perJobTokenCap: 30_000 }), false);
  assert.match(learningJobKey("evaluation", { kind: "user-global" }, "a".repeat(64), 1), FINGERPRINT);
});
