import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRunExperienceStore } from "../src/experience-store.ts";
import { runExperienceRecordFingerprint } from "../src/run-experience-fingerprint.ts";
import { type RunExperience, parseRunExperience } from "../src/run-experience.ts";
import { getProjectId } from "../src/store.ts";

// Preserve the mixed store's real commit/caller-mutation contract independently
// of retired Hypothesis/Trial assignment/materialization fixtures.
const projectRoot = "/r3-project", projectId = getProjectId(projectRoot);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "r3-committed-experience-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const experience: RunExperience = {
    schemaVersion: 5, workEpisodeId: randomUUID(), recordedAt: "2026-01-01T00:00:00.000Z",
    runStart: { taskStatus: "active", taskGoal: "Work" }, task: { goal: "Work", taskRelation: "preexisting_untouched" },
    policy: { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0, finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null },
    execution: { toolCalls: 1, observations: 1, consequentialCalls: 0, projectMutationEffectCalls: 0, verificationCalls: 0, toolErrors: 0, deniedCalls: 0 },
    outcome: { taskStatus: "active", verificationStatus: "pending", completionRelation: "not_completed", hasBlockers: false, hasQuestions: false, humanGateOpen: false },
    metrics: { durationMs: 100, cost: 0.01 },
  };
  assert.ok(parseRunExperience(experience));
  return { root, experience };
}

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
