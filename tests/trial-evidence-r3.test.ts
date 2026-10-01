import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hypothesisFingerprint, learningArtifactFingerprint, learningFingerprint, canonicalJson, type StrategyHypothesisV2, type ExactEvidenceRef } from "../src/learning-v1-contract.ts";
import { hypothesisRef } from "../src/discovery-hypotheses.ts";
import { FileTrialAssignmentStore, DEFAULT_ASSIGNMENT_POLICY } from "../src/trial-assignment-v2.ts";
import { D2OpenHypothesisReader } from "../src/open-hypotheses.ts";
import { trustedPortfolioFingerprint } from "../src/strategy-portfolio.ts";
import { createPolicySnapshot, createPolicySnapshotFromRevisions, createStrategyRevisionSelection, serializePolicySnapshot } from "../src/policy.ts";
import { type RunExperience, parseRunExperience } from "../src/run-experience.ts";
import { FileRunExperienceStore } from "../src/experience-store.ts";
import { runExperienceRecordFingerprint } from "../src/run-experience-fingerprint.ts";
import { getProjectId } from "../src/store.ts";
import { FileRunExperienceMaintenance } from "../src/experience-lifecycle.ts";
import { FileTrialEvidenceV2Store, materializeTrialEvidenceV2, validateTrialEvidenceV2, trialEvidenceRef, matchesTrialEvidenceV2Assignment, MAX_TRIAL_EVIDENCE_V2 } from "../src/trial-evidence-v2.ts";

const projectRoot = "/r3-project", projectId = getProjectId(projectRoot);
const zero = { toolCalls: 0, observations: 0, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: test.TestContext, kind: "approach" | "modifier" = "approach") {
  const root = await mkdtemp(join(tmpdir(), "r3-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  const semantic = { schemaVersion: 2 as const, scope: { kind: "project" as const, projectId }, logicalId: "focused-check", kind, lineage: "new" as const, parent: null, baseRevisionFingerprint: null,
    summary: "Check changed contracts", useWhen: ["Local work"], avoidWhen: [], principles: ["Check focused tests"], expectedEffect: "Fewer missed contracts", failureSignals: ["Missed checks"], trialHints: [],
    sources: [{ projectId, recordId: `${randomUUID()}.json`, fingerprint: `sha256:${"a".repeat(64)}` }], discoveryPacketFingerprint: `sha256:${"b".repeat(64)}` };
  const h: StrategyHypothesisV2 = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  const assignments = new FileTrialAssignmentStore({ projectsBaseDir: root });
  const reader = new D2OpenHypothesisReader({ list: async () => [h] }, { readProjectId: async () => ({ projectId, fingerprintVersion: 1, entries: [], resolvedEntries: [], fingerprint: trustedPortfolioFingerprint(projectId, []) }) });
  const result = await assignments.assignIfAbsent({ projectId, workEpisodeId: randomUUID(), signal: new AbortController().signal, isCurrent: () => true }, { ...DEFAULT_ASSIGNMENT_POLICY, operationTimeoutMs: 1000 }, reader, () => 1000);
  assert.equal(result.status, "created"); if (result.status === "none") throw new Error("No fixture assignment");
  const a = result.assignment;
  const selection = createStrategyRevisionSelection({ strategyId: h.logicalId, kind, revisionIdentity: h.id, revisionFingerprint: h.fingerprint, revisionStatusAtRun: "trial", semantics: h });
  const snapshot = createPolicySnapshotFromRevisions(kind === "approach" ? { approach: selection } : { approach: createPolicySnapshot({ approach: "direct-action" }).approach, modifiers: [selection] });
  const experience: RunExperience = { schemaVersion: 5, workEpisodeId: a.workEpisodeId, recordedAt: "2026-01-01T00:00:00.000Z",
    runStart: { taskStatus: "active", taskGoal: "Work" }, task: { goal: "Work", taskRelation: "preexisting_untouched" },
    policy: { finalSnapshot: snapshot, declarationCount: 1, finalPolicyDeclarationCount: 1, finalPolicyFirstDeclaredAfter: zero, finalPolicyLastDeclaredAfter: zero },
    execution: { ...zero, toolCalls: 1, observations: 1 }, outcome: { taskStatus: "active", verificationStatus: "pending", completionRelation: "not_completed", hasBlockers: false, hasQuestions: false, humanGateOpen: false }, metrics: { durationMs: 100, cost: 0.01 } };
  assert.ok(parseRunExperience(experience));
  const source: ExactEvidenceRef = { projectId, recordId: `${randomUUID()}.json`, fingerprint: runExperienceRecordFingerprint(experience) };
  const evidence = materializeTrialEvidenceV2(a, h, source, experience)!; assert.ok(evidence);
  const dir = join(root, projectId, "learning-v1", "hypotheses"); await mkdir(dir, { recursive: true });
  const commit = { schemaVersion: 2, packetFingerprint: h.discoveryPacketFingerprint, outcome: "published", refs: [hypothesisRef(h)], newHypotheses: [h], modelIdentity: { provider: "faux", modelId: "discovery", thinkingLevel: "off" } };
  await writeFile(join(dir, `${h.discoveryPacketFingerprint.slice(7)}.json`), canonicalJson({ ...commit, fingerprint: learningFingerprint(commit) }));
  const store = (options = {}) => new FileTrialEvidenceV2Store({ projectsBaseDir: root, ...options });
  return { root, a, h, experience, source, evidence, store, assignments };
}
const snapshotSeed = () => createPolicySnapshot({ approach: "direct-action" }).approach;
const seal = <T extends object>(v: T) => ({ ...v, fingerprint: learningArtifactFingerprint(v as Record<string, unknown>) });

for (const kind of ["approach", "modifier"] as const) test(`R3 exact ${kind} final trial declaration plus subsequent ordinary work only`, async (t) => {
  const f = await fixture(t, kind);
  assert.ok(validateTrialEvidenceV2(f.evidence)); assert.ok(matchesTrialEvidenceV2Assignment(f.evidence, f.a));
  const materialize = (e: RunExperience) => materializeTrialEvidenceV2(f.a, f.h, { ...f.source, fingerprint: runExperienceRecordFingerprint(e) }, e);
  const { workEpisodeId: _episode, ...legacy } = f.experience as import("../src/run-experience.ts").EpisodeRunExperience;
  assert.equal(materialize({ ...legacy, schemaVersion: 4 }), null);
  assert.equal(materialize({ ...f.experience, workEpisodeId: randomUUID() } as RunExperience), null);
  const noPolicy = { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null };
  assert.equal(materialize({ ...f.experience, policy: noPolicy }), null, "assignment/rendering is not selection");
  assert.equal(materialize({ ...f.experience, execution: { ...f.experience.execution, deniedCalls: 1 }, policy: { ...f.experience.policy, finalPolicyFirstDeclaredAfter: f.experience.execution, finalPolicyLastDeclaredAfter: f.experience.execution } }), null, "Policy calls and denied calls are not ordinary work");
  const seed = serializePolicySnapshot(createPolicySnapshot({ approach: "direct-action" }));
  assert.equal(materialize({ ...f.experience, policy: { ...f.experience.policy, finalSnapshot: seed } }), null, "a replaced final Policy cannot count");
  const before = { ...f.experience, runStart: { taskStatus: "done" as const, taskGoal: "Work" }, outcome: { ...f.experience.outcome, taskStatus: "done" as const, verificationStatus: "passed" as const, completionRelation: "completed_before_run" as const } };
  assert.equal(materialize(before), null);
  assert.throws(() => materializeTrialEvidenceV2(f.a, f.h, { ...f.source, fingerprint: `sha256:${"0".repeat(64)}` }, f.experience), /Invalid exact/);
  assert.throws(() => materializeTrialEvidenceV2(f.a, f.h, { ...f.source, projectId: "a".repeat(64) }, f.experience), /Invalid exact/);
  const wrongStatus = createStrategyRevisionSelection({ strategyId: f.h.logicalId, kind, revisionIdentity: f.h.id, revisionFingerprint: f.h.fingerprint, revisionStatusAtRun: "promoted", semantics: f.h });
  const wrongSnapshot = createPolicySnapshotFromRevisions(kind === "approach" ? { approach: wrongStatus } : { approach: snapshotSeed(), modifiers: [wrongStatus] });
  assert.equal(materialize({ ...f.experience, policy: { ...f.experience.policy, finalSnapshot: wrongSnapshot } }), null);
  assert.equal(f.evidence.postDeclaration.toolCalls, 1);
  assert.equal(JSON.stringify(f.evidence).includes("Work"), false, "no Task goal, transcript or reasoning is copied");
});

test("R3 strict bounded schema rejects lifecycle/verdict fields, malformed refs, counters, role and digest", async (t) => {
  const f = await fixture(t);
  for (const field of ["used", "exposed", "eligible", "status", "regressions", "reward", "trust"]) assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, [field]: true })), false);
  assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, schemaVersion: 1 })), false);
  assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, postDeclaration: { ...zero } })), false);
  assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, source: { ...f.source, recordId: "../escape.json" } })), false);
  assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, selection: { ...f.evidence.selection, revisionFingerprint: `sha256:${"c".repeat(64)}` } })), false);
  assert.equal(validateTrialEvidenceV2(seal({ ...f.evidence, outcome: { ...f.evidence.outcome, verificationStatus: "passed", taskStatus: "done" } })), false);
  assert.equal(validateTrialEvidenceV2({ ...f.evidence, fingerprint: `sha256:${"0".repeat(64)}` }), false);
  assert.equal(matchesTrialEvidenceV2Assignment(f.evidence, seal({ ...f.a, id: randomUUID() })), false);
});

test("R3 filesystem concurrent retry is immutable, exact and restart-persistent", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.store().publish(f.evidence)));
  assert.equal(new Set(results.map((e) => e.fingerprint)).size, 1);
  assert.deepEqual(await f.store().readExact(trialEvidenceRef(f.evidence)), f.evidence);
  assert.equal((await f.store().list(projectId)).length, 1);
  await assert.rejects(f.store().publish(seal({ ...f.evidence, metrics: { cost: 2, durationMs: 10 } })), /Conflicting/);
  await assert.rejects(f.store().readExact({ ...trialEvidenceRef(f.evidence), fingerprint: `sha256:${"0".repeat(64)}` }), /Missing/);
  await assert.rejects(f.store().list("../escape"), /namespace/);
});

for (const published of [false, true]) test(`R3 publication barrier ${published ? "after" : "before"} atomic frontier preserves exact restart outcome`, async (t) => {
  const f = await fixture(t), reached = deferred(), release = deferred(), controller = new AbortController();
  const hook = async () => { reached.resolve(); await release.promise; };
  const write = f.store(published ? { afterPublish: hook } : { beforePublish: hook }).publish(f.evidence, controller.signal);
  await reached.promise; controller.abort(); release.resolve();
  if (published) { await write; assert.deepEqual(await f.store().readExact(trialEvidenceRef(f.evidence)), f.evidence); }
  else { await assert.rejects(write); assert.deepEqual(await f.store().list(projectId), []); }
  assert.deepEqual((await readdir(join(f.root, projectId, "learning-v1", "trial-evidence-v2"))).filter((n) => n !== `${f.evidence.id}.json`), []);
});

test("R3 failed write and stale authority never publish; after-publication failure retries exact record", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store({ beforePublish: async () => { throw new Error("Injected write failure"); } }).publish(f.evidence));
  assert.deepEqual(await f.store().list(projectId), []);
  let current = true;
  await assert.rejects(f.store({ beforePublish: async () => { current = false; } }).publish(f.evidence, undefined, () => current), /Stale/);
  assert.deepEqual(await f.store().list(projectId), []);
  await assert.rejects(f.store({ afterPublish: async () => { throw new Error("Injected acknowledgment failure"); } }).publish(f.evidence));
  assert.deepEqual(await f.store().publish(f.evidence), f.evidence);
});

test("R3 corrupt, oversized and full immutable history fail closed without deleting artifacts", async (t) => {
  const f = await fixture(t), dir = join(f.root, projectId, "learning-v1", "trial-evidence-v2"); await mkdir(dir, { recursive: true });
  const path = join(dir, `${f.evidence.id}.json`);
  for (const text of ["broken", "null", JSON.stringify({ ...f.evidence, fingerprint: "bad" }), " ".repeat(16_385)]) {
    await writeFile(path, text); await assert.rejects(f.store().publish(f.evidence)); assert.equal(await readFile(path, "utf8"), text);
  }
  await rm(path);
  await Promise.all(Array.from({ length: MAX_TRIAL_EVIDENCE_V2 + 1 }, () => writeFile(join(dir, `${randomUUID()}.json`), "{}")));
  await assert.rejects(f.store().list(projectId), /full/); assert.equal((await readdir(dir)).length, MAX_TRIAL_EVIDENCE_V2 + 1);
});

test("R3 Experience returns exact committed bytes even across maintenance failure and caller mutation", async (t) => {
  const f = await fixture(t), reached = deferred(), release = deferred();
  const original = structuredClone(f.experience);
  const store = new FileRunExperienceStore({ baseDir: f.root, onBeforeRename: async () => { reached.resolve(); await release.promise; }, onSaved: async () => { throw new Error("Injected maintenance failure"); } });
  const writing = store.save(projectRoot, f.experience);
  await reached.promise; (f.experience.metrics as { cost: number }).cost = 999; release.resolve();
  const ref = await writing;
  const persisted = JSON.parse(await readFile(join(store.experienceDirectory(projectRoot), ref.recordId), "utf8"));
  assert.deepEqual(persisted, original); assert.equal(ref.fingerprint, runExperienceRecordFingerprint(persisted)); assert.equal(ref.projectId, projectId);
});

test("R3 retention pins unmaterialized exact support, then immutable evidence permits source pruning and restart lookup", async (t) => {
  const f = await fixture(t), store = new FileRunExperienceStore({ baseDir: f.root }), dir = store.experienceDirectory(projectRoot);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, f.source.recordId), JSON.stringify(f.experience));
  const { workEpisodeId: _episode, ...legacy } = f.experience as import("../src/run-experience.ts").EpisodeRunExperience;
  for (let i = 0; i < 256; i++) {
    const e = { ...legacy, schemaVersion: 4, recordedAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(), policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null } };
    await writeFile(join(dir, `${randomUUID()}.json`), JSON.stringify(e));
  }
  const maintenance = () => new FileRunExperienceMaintenance({ projectsBaseDir: f.root, globalBaseDir: join(f.root, "global") });
  assert.equal(await maintenance().prune(projectRoot), 0); assert.ok((await readdir(dir)).includes(f.source.recordId));
  await f.store().publish(f.evidence);
  assert.equal(await maintenance().prune(projectRoot), 1); assert.ok(!(await readdir(dir)).includes(f.source.recordId));
  assert.deepEqual(await f.store().readExact(trialEvidenceRef(f.evidence)), f.evidence);
  assert.equal(await maintenance().prune(projectRoot), 0, "already-pruned source does not revoke exact immutable support");
});

test("R3 assignment comparison remains exact live support after trial source materialization", async (t) => {
  const f = await fixture(t), store = new FileRunExperienceStore({ baseDir: f.root }), dir = store.experienceDirectory(projectRoot);
  await mkdir(dir, { recursive: true });
  const { workEpisodeId: _episode, ...legacy } = f.experience as import("../src/run-experience.ts").EpisodeRunExperience;
  const comparison = { ...legacy, schemaVersion: 4 as const, policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null } };
  const comparisonRef = { projectId, recordId: `${randomUUID()}.json`, fingerprint: runExperienceRecordFingerprint(comparison) };
  await writeFile(join(dir, comparisonRef.recordId), JSON.stringify(comparison));
  const assignment = seal({ ...f.a, comparison: [comparisonRef] });
  await writeFile(join(f.root, projectId, "learning-v1", "trial-assignments-v2", `${assignment.workEpisodeId}.json`), canonicalJson(assignment));
  await writeFile(join(dir, f.source.recordId), JSON.stringify(f.experience));
  await f.store().publish(materializeTrialEvidenceV2(assignment, f.h, f.source, f.experience)!);
  for (let i = 0; i < 256; i++) await writeFile(join(dir, `${randomUUID()}.json`), JSON.stringify({ ...comparison, recordedAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString() }));
  const maintenance = new FileRunExperienceMaintenance({ projectsBaseDir: f.root, globalBaseDir: join(f.root, "global") });
  assert.equal(await maintenance.prune(projectRoot), 1);
  assert.ok((await readdir(dir)).includes(comparisonRef.recordId));
  await rm(join(dir, comparisonRef.recordId));
  await assert.rejects(maintenance.prune(projectRoot), /Missing exact Trial comparison/);
});

for (const corruption of ["evidence", "assignment", "source", "binding"] as const) test(`R3 retention refuses all deletion for ${corruption} corruption`, async (t) => {
  const f = await fixture(t), experienceStore = new FileRunExperienceStore({ baseDir: f.root }), dir = experienceStore.experienceDirectory(projectRoot);
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, f.source.recordId), JSON.stringify(f.experience));
  await f.store().publish(f.evidence);
  if (corruption === "evidence") await writeFile(join(f.root, projectId, "learning-v1", "trial-evidence-v2", `${f.evidence.id}.json`), "null");
  if (corruption === "assignment") await rm(join(f.root, projectId, "learning-v1", "trial-assignments-v2", `${f.a.workEpisodeId}.json`));
  if (corruption === "source") await writeFile(join(dir, f.source.recordId), JSON.stringify({ ...f.experience, metrics: { cost: 99, durationMs: 100 } }));
  if (corruption === "binding") await writeFile(join(f.root, projectId, "learning-v1", "trial-evidence-v2", `${f.evidence.id}.json`), canonicalJson(seal({ ...f.evidence, workEpisodeId: randomUUID() })));
  await assert.rejects(new FileRunExperienceMaintenance({ projectsBaseDir: f.root, globalBaseDir: join(f.root, "global") }).prune(projectRoot));
  assert.ok((await readdir(dir)).includes(f.source.recordId));
});
