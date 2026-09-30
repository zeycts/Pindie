import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleRunExperience, parseRunExperience, type AssembleRunExperienceInput } from "../src/run-experience.ts";
import { runExperienceRecordFingerprint } from "../src/run-experience-fingerprint.ts";
import { learningArtifactFingerprint, type TrialAssignment } from "../src/learning-v1-contract.ts";
import type { TrialRunAttribution } from "../src/trial-attribution.ts";
import { FileRunExperienceReader, FileRunExperienceStore } from "../src/experience-store.ts";
import { getProjectId } from "../src/store.ts";
import { EMPTY_STATE } from "../src/state.ts";
import { reduceState } from "../src/transitions.ts";

function fixture(projectId = getProjectId("/repo")) {
  const workEpisodeId = randomUUID(), now = 1_800_000_000_000;
  const content = { schemaVersion: 1 as const, id: randomUUID(), projectId, workEpisodeId, sessionId: "native-session",
    hypothesis: { schemaVersion: 1 as const, family: "strategy-hypothesis" as const, scope: { kind: "project" as const, projectId }, id: randomUUID(), fingerprint: `sha256:${"a".repeat(64)}` },
    comparison: [], offerPolicyFingerprint: `sha256:${"b".repeat(64)}`, offerPolicyVersion: 1 as const,
    hostId: randomUUID(), authorityGeneration: 1, createdAt: now, expiresAt: now + 1000, status: "untrusted-advisory" as const };
  const assignment: TrialAssignment = { ...content, fingerprint: learningArtifactFingerprint(content) };
  const zero = { toolCalls: 0, observations: 0, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 };
  const execution = { ...zero, toolCalls: 2, consequentialCalls: 2 };
  const result = reduceState(EMPTY_STATE, { type: "start_task", goal: "Real Human work", constraints: [], successCriteria: ["done"] });
  assert.ok(result.ok);
  const input: AssembleRunExperienceInput = {
    task: result.state.task!, workEpisodeId, runStart: { taskStatus: "idle", taskGoal: null },
    snapshot: { authority: "coherent", taskStatus: "active", verificationStatus: "pending", hasBlockers: false, hasQuestions: false,
      completionReady: false, taskRelation: "introduced_during_run", completionRelation: "not_completed", gateRelation: "none" },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    execution, durationMs: 100, cost: 0, recordedAt: new Date(now + 100).toISOString(),
  };
  const attribution: TrialRunAttribution = {
    assignment, exposure: { sessionId: "native-session", agentRunGeneration: 1, occurrenceEpoch: 1, at: now, order: 2 },
    declaration: "none", declaredAt: null, declarationFrontier: null, postSelection: zero, authorityCurrent: true,
  };
  return { input, attribution, zero, now };
}

for (const declaration of ["none", "select", "decline"] as const) test(`v6 strict ${declaration} facts round-trip; v5 remains the no-attribution default`, () => {
  const f = fixture();
  const attribution: TrialRunAttribution = declaration === "none" ? f.attribution : {
    ...f.attribution, declaration, declaredAt: f.now + 1,
    declarationFrontier: { ...f.zero, toolCalls: 1, consequentialCalls: 1 },
    postSelection: declaration === "select" ? { ...f.zero, toolCalls: 1, consequentialCalls: 1 } : f.zero,
  };
  const ordinary = assembleRunExperience(f.input);
  assert.equal(ordinary.schemaVersion, 5);
  assert.ok(!("trialAttribution" in ordinary));
  const trial = assembleRunExperience({ ...f.input, trialAttribution: attribution });
  assert.equal(trial.schemaVersion, 6);
  assert.deepEqual(parseRunExperience(JSON.parse(JSON.stringify(trial))), trial);
  assert.notEqual(runExperienceRecordFingerprint(trial), runExperienceRecordFingerprint(ordinary));
  const reordered = JSON.parse(JSON.stringify(trial));
  reordered.trialAttribution.assignment = Object.fromEntries(Object.entries(reordered.trialAttribution.assignment).reverse());
  assert.equal(runExperienceRecordFingerprint(reordered), runExperienceRecordFingerprint(trial));
  const partial = { ...attribution, authorityCurrent: false };
  const historical = assembleRunExperience({ ...f.input, trialAttribution: partial });
  assert.equal(historical.schemaVersion, 6);
  assert.ok(parseRunExperience(historical));
  assert.notEqual(runExperienceRecordFingerprint(historical), runExperienceRecordFingerprint(trial));
  assert.ok(!JSON.stringify(trial).includes('"used"'));
});

test("v6 rejects mismatched bindings, forged identities, impossible declarations and extra cognition; assembly omits ambiguous attribution", () => {
  const f = fixture(), valid = assembleRunExperience({ ...f.input, trialAttribution: f.attribution });
  assert.equal(valid.schemaVersion, 6);
  const changes: ((value: any) => void)[] = [
    (v) => { v.workEpisodeId = randomUUID(); },
    (v) => { v.trialAttribution.assignment.id = randomUUID(); },
    (v) => { v.trialAttribution.assignment.hypothesis.fingerprint = `sha256:${"c".repeat(64)}`; },
    (v) => { v.trialAttribution.exposure.sessionId = "other-session"; },
    (v) => { v.trialAttribution.exposure.at = f.now + 1000; },
    (v) => { v.trialAttribution.exposure.agentRunGeneration = -1; },
    (v) => { v.trialAttribution.exposure.order = 0.5; },
    (v) => { v.trialAttribution.declaration = "select"; },
    (v) => { v.trialAttribution.declaredAt = f.now; },
    (v) => { v.trialAttribution.postSelection.toolCalls = 1; v.trialAttribution.postSelection.observations = 1; },
    (v) => { v.trialAttribution.why = "hidden cognition"; },
    (v) => { v.trialAttribution.used = true; },
    (v) => { delete v.trialAttribution; },
  ];
  for (const change of changes) {
    const value = structuredClone(valid); change(value);
    assert.equal(parseRunExperience(value), null);
    assert.throws(() => runExperienceRecordFingerprint(value));
  }
  assert.equal(assembleRunExperience({ ...f.input, trialAttribution: { ...f.attribution, assignment: { ...f.attribution.assignment, workEpisodeId: randomUUID() } } }).schemaVersion, 5);
  assert.equal(assembleRunExperience({ ...f.input, workEpisodeId: null, trialAttribution: f.attribution }).schemaVersion, 4);
});

test("v4/v5 canonical fingerprint bytes remain the historical projection", () => {
  const f = fixture();
  for (const workEpisodeId of [null, f.input.workEpisodeId]) {
    const record = assembleRunExperience({ ...f.input, workEpisodeId });
    const expected = `sha256:${createHash("sha256").update(JSON.stringify(record)).digest("hex")}`;
    assert.equal(runExperienceRecordFingerprint(record), expected);
    assert.deepEqual(parseRunExperience(record), record);
    assert.equal(assembleRunExperience({ ...f.input, workEpisodeId }).schemaVersion, workEpisodeId === null ? 4 : 5);
  }
});

test("v4/v5/v6 immutable files coexist; wrong-project v6 fails closed; no old bytes rewritten or TrialEvidence created", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pindie-v6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(getProjectId(root)), reader = new FileRunExperienceReader({ baseDir: root }), store = new FileRunExperienceStore({ baseDir: root });
  await store.save(root, assembleRunExperience({ ...f.input, workEpisodeId: null }));
  await store.save(root, assembleRunExperience(f.input));
  const dir = reader.experienceDirectory(root);
  const oldNames = await readdir(dir);
  const oldBytes = await Promise.all(oldNames.map((name) => readFile(join(dir, name), "utf8")));
  const trial = assembleRunExperience({ ...f.input, trialAttribution: f.attribution });
  await store.save(root, trial);
  const loaded = await reader.read(root);
  assert.equal(loaded.invalid, 0); assert.equal(loaded.unsupportedSchema, 0);
  assert.deepEqual(loaded.records.map((r) => r.experience.schemaVersion).sort(), [4, 5, 6]);
  assert.deepEqual(await Promise.all(oldNames.map((name) => readFile(join(dir, name), "utf8"))), oldBytes);
  assert.deepEqual(await readdir(join(root, getProjectId(root))), ["experience"]);
  await assert.rejects(store.save("/other-project", trial), /invalid record/);
  const otherDir = reader.experienceDirectory("/other-project");
  const { mkdir } = await import("node:fs/promises"); await mkdir(otherDir, { recursive: true });
  await writeFile(join(otherDir, `${randomUUID()}.json`), JSON.stringify(trial));
  assert.equal((await reader.read("/other-project")).invalid, 1);
});
