import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleRunExperience, parseRunExperience, type AssembleRunExperienceInput } from "../src/run-experience.ts";
import { runExperienceRecordFingerprint } from "../src/run-experience-fingerprint.ts";
import { learningArtifactFingerprint, type TrialAssignment } from "../src/learning-v1-contract.ts";
import type { TrialRunAttempt } from "../src/trial-attribution.ts";
import { FileRunExperienceReader, FileRunExperienceStore } from "../src/experience-store.ts";
import { getProjectId } from "../src/store.ts";
import { EMPTY_STATE } from "../src/state.ts";
import { reduceState } from "../src/transitions.ts";

function fixture(projectId = getProjectId("/repo")) {
  const now = 1_800_000_000_000, workEpisodeId = randomUUID();
  const content = { schemaVersion: 1 as const, id: randomUUID(), projectId, workEpisodeId, sessionId: "native-session",
    hypothesis: { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope: { kind: "project" as const, projectId }, id: randomUUID(), fingerprint: `sha256:${"a".repeat(64)}` },
    comparison: [], offerPolicyFingerprint: `sha256:${"b".repeat(64)}`, offerPolicyVersion: 1 as const,
    hostId: randomUUID(), authorityGeneration: 1, createdAt: now, expiresAt: now + 1000, status: "untrusted-advisory" as const };
  const assignment: TrialAssignment = { ...content, fingerprint: learningArtifactFingerprint(content) };
  const zero = { toolCalls: 0, observations: 0, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 };
  const execution = { ...zero, toolCalls: 2, consequentialCalls: 2 };
  const result = reduceState(EMPTY_STATE, { type: "start_task", goal: "Real work", constraints: [], successCriteria: ["done"] });
  assert.ok(result.ok);
  const input: AssembleRunExperienceInput = {
    task: result.state.task!, workEpisodeId, runStart: { taskStatus: "idle", taskGoal: null },
    snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false, hasQuestions: false,
      completionReady: false, taskRelation: "introduced_during_run", completionRelation: "not_completed", gateRelation: "none" },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    execution, durationMs: 100, cost: 0, recordedAt: new Date(now + 100).toISOString(),
  };
  const attempt: TrialRunAttempt = { assignmentProposal: assignment,
    rendered: { sessionId: "native-session", agentRunGeneration: 1, occurrenceEpoch: 1, at: now, order: 2 },
    delivery: "unknown", publication: "unconfirmed", declaration: "none", declaredAt: null,
    counterScope: "run", declarationFrontier: null, postSelection: zero, authorityCurrent: false };
  return { input, attempt, zero, now };
}

for (const mixed of [false, true]) test(`v7 ${mixed ? "mixed v4" : "bound v5"} aggregate preserves independent partial facts and exact canonical hashes`, () => {
  const f = fixture();
  const record = assembleRunExperience({ ...f.input, workEpisodeId: mixed ? null : f.input.workEpisodeId, trialAttempt: f.attempt });
  if (record.schemaVersion !== 7) assert.fail("Missing partial attempt");
  assert.equal(record.aggregateSchemaVersion, mixed ? 4 : 5);
  assert.equal(record.workEpisodeId, mixed ? null : f.input.workEpisodeId);
  assert.deepEqual(record.trialAttempt, f.attempt);
  assert.deepEqual(parseRunExperience(JSON.parse(JSON.stringify(record))), record);
  const reordered = JSON.parse(JSON.stringify(record));
  reordered.trialAttempt = Object.fromEntries(Object.entries(reordered.trialAttempt).reverse());
  reordered.trialAttempt.assignmentProposal = Object.fromEntries(Object.entries(reordered.trialAttempt.assignmentProposal).reverse());
  assert.equal(runExperienceRecordFingerprint(reordered), runExperienceRecordFingerprint(record));
  const selected = assembleRunExperience({ ...f.input, workEpisodeId: mixed ? null : f.input.workEpisodeId,
    trialAttempt: { ...f.attempt, publication: "confirmed", declaration: "select", declaredAt: f.now + 1,
      declarationFrontier: f.input.execution, authorityCurrent: true } });
  assert.equal(selected.schemaVersion, 7);
  assert.ok(parseRunExperience(selected));
  assert.notEqual(runExperienceRecordFingerprint(selected), runExperienceRecordFingerprint(record));
});

test("v7 rejects fabricated delivery/use/commit authority, impossible bindings/counters, and unknown fields", () => {
  const f = fixture(), record = assembleRunExperience({ ...f.input, trialAttempt: f.attempt });
  const mutations: ((value: any) => void)[] = [
    (v) => { v.trialAttempt.delivery = "actual"; },
    (v) => { v.trialAttempt.used = true; },
    (v) => { v.trialAttempt.publication = "eligible-trial"; },
    (v) => { v.trialAttempt.authorityCurrent = true; },
    (v) => { v.trialAttempt.declaration = "select"; v.trialAttempt.declaredAt = f.now; v.trialAttempt.declarationFrontier = f.input.execution; },
    (v) => { v.trialAttempt.counterScope = "work-episode"; },
    (v) => { v.trialAttempt.rendered.sessionId = "foreign"; },
    (v) => { v.trialAttempt.rendered.at = f.now + 1000; },
    (v) => { v.trialAttempt.assignmentProposal.workEpisodeId = randomUUID(); },
    (v) => { v.trialAttempt.assignmentProposal.fingerprint = `sha256:${"c".repeat(64)}`; },
    (v) => { v.trialAttempt.postSelection.toolCalls = 100; },
    (v) => { v.workEpisodeId = null; },
    (v) => { v.aggregateSchemaVersion = 4; },
    (v) => { v.aggregateSchemaVersion = 6; },
    (v) => { v.trialAttribution = {}; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(record); mutate(value);
    assert.equal(parseRunExperience(value), null);
    assert.throws(() => runExperienceRecordFingerprint(value));
  }
  assert.equal(assembleRunExperience({ ...f.input, trialAttempt: { ...f.attempt, delivery: "actual" as any } }).schemaVersion, 5);
});

test("v4/v5/v6/v7 files coexist without rewriting old bytes; v7 namespace fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pindie-v7-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(getProjectId(root)), store = new FileRunExperienceStore({ baseDir: root }), reader = new FileRunExperienceReader({ baseDir: root });
  await store.save(root, assembleRunExperience({ ...f.input, workEpisodeId: null }));
  await store.save(root, assembleRunExperience(f.input));
  await store.save(root, assembleRunExperience({ ...f.input, trialAttribution: {
    assignment: f.attempt.assignmentProposal, exposure: f.attempt.rendered, declaration: "none", declaredAt: null,
    declarationFrontier: null, postSelection: f.zero, authorityCurrent: false,
  } }));
  const dir = reader.experienceDirectory(root), names = await readdir(dir);
  const bytes = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
  const fingerprints = bytes.map((text) => runExperienceRecordFingerprint(JSON.parse(text)));
  await store.save(root, assembleRunExperience({ ...f.input, trialAttempt: f.attempt }));
  await store.save(root, assembleRunExperience({ ...f.input, workEpisodeId: null, trialAttempt: f.attempt }));
  const read = await reader.read(root);
  assert.equal(read.invalid, 0); assert.equal(read.unsupportedSchema, 0);
  assert.deepEqual(read.records.map((r) => r.experience.schemaVersion).sort(), [4, 5, 6, 7, 7]);
  assert.deepEqual(await Promise.all(names.map((name) => readFile(join(dir, name), "utf8"))), bytes);
  assert.deepEqual(bytes.map((text) => runExperienceRecordFingerprint(JSON.parse(text))), fingerprints);
  await assert.rejects(store.save("/foreign-project", assembleRunExperience({ ...f.input, trialAttempt: f.attempt })), /invalid record/);
});
