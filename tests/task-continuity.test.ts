import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTaskContinuity,
  MAX_CONTINUITY_DECISION_LENGTH,
  MAX_CONTINUITY_DECISIONS,
  MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH,
  taskContractFingerprint,
  validateTaskContinuity,
} from "../src/task-continuity.ts";
import type { PindieTask } from "../src/state.ts";
import { FileTaskContinuityStore, getProjectId } from "../src/store.ts";

function task(): PindieTask {
  return {
    goal: "Ship the continuity substrate",
    constraints: ["Keep the Session native"],
    successCriteria: [
      { id: "c1", description: "A checkpoint persists" },
      { id: "c2", description: "Task binding is deterministic" },
    ],
    openLoops: {
      blockers: [],
      questions: [],
      nextIntent: "Implement tests",
    },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
}

function checkpoint(progressSummary = "The current frontier is ready.") {
  return createTaskContinuity({
    createdAt: "2026-09-03T00:00:00.000Z",
    taskFingerprint: taskContractFingerprint(task()),
    sourceSessionId: "session-a",
    progressSummary,
    decisions: ["Keep the checkpoint latest-only."],
  });
}

test("Task Contract fingerprint is deterministic and excludes mutable execution fields", () => {
  const original = task();
  const baseline = taskContractFingerprint(original);
  assert.equal(taskContractFingerprint(structuredClone(original)), baseline);
  assert.match(baseline, /^sha256:[0-9a-f]{64}$/);

  const mutable = structuredClone(original);
  mutable.openLoops.nextIntent = "A different next step";
  mutable.openLoops.blockers = ["Temporary dependency"];
  mutable.openLoops.questions = ["Which option?" ];
  mutable.verification = {
    stale: false,
    checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "passed" }],
  };
  mutable.humanGate = { kind: "approval", question: "Approve?" };
  mutable.completed = true;
  assert.equal(taskContractFingerprint(mutable), baseline);

  for (const change of [
    (value: PindieTask) => { value.goal = "A new goal"; },
    (value: PindieTask) => { value.constraints = ["A new constraint"]; },
    (value: PindieTask) => { value.successCriteria[0]!.id = "changed"; },
    (value: PindieTask) => { value.successCriteria[0]!.description = "Changed"; },
    (value: PindieTask) => { value.successCriteria.reverse(); },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    assert.notEqual(taskContractFingerprint(changed), baseline);
  }
});

test("Task continuity content is bounded and rejects empty authored values", () => {
  assert.doesNotThrow(() => checkpoint());
  assert.equal(validateTaskContinuity(checkpoint()).ok, true);
  assert.throws(() => checkpoint(" "), /progressSummary/);
  assert.throws(
    () => createTaskContinuity({
      ...checkpoint(),
      createdAt: "2026-09-03T00:00:00.000Z",
      progressSummary: "valid",
      decisions: [" "] ,
    }),
    /decisions\[0\]/,
  );
  assert.throws(
    () => createTaskContinuity({
      ...checkpoint(),
      createdAt: "2026-09-03T00:00:00.000Z",
      progressSummary: "x".repeat(MAX_CONTINUITY_PROGRESS_SUMMARY_LENGTH + 1),
      decisions: [],
    }),
    /progressSummary/,
  );
  assert.throws(
    () => createTaskContinuity({
      ...checkpoint(),
      createdAt: "2026-09-03T00:00:00.000Z",
      progressSummary: "valid",
      decisions: Array.from({ length: MAX_CONTINUITY_DECISIONS + 1 }, () => "decision"),
    }),
    /decisions must contain/,
  );
  assert.throws(
    () => createTaskContinuity({
      ...checkpoint(),
      createdAt: "2026-09-03T00:00:00.000Z",
      progressSummary: "valid",
      decisions: ["x".repeat(MAX_CONTINUITY_DECISION_LENGTH + 1)],
    }),
    /decisions\[0\]/,
  );
});

test("FileTaskContinuityStore is project-local, latest-only, and atomic", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-continuity-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileTaskContinuityStore({ baseDir });
  const projectRoot = "/workspace/project-a";

  await store.save(projectRoot, checkpoint("first"));
  const firstPath = join(baseDir, getProjectId(projectRoot), "continuity.json");
  assert.equal(store.continuityPath(projectRoot), firstPath);
  const firstContents = await readFile(firstPath, "utf8");
  assert.match(firstContents, /"progressSummary": "first"/);

  await store.save(projectRoot, checkpoint("second"));
  assert.match(await readFile(firstPath, "utf8"), /"progressSummary": "second"/);
  assert.deepEqual(await readdir(join(baseDir, getProjectId(projectRoot))), ["continuity.json"]);

  const failed = new FileTaskContinuityStore({
    baseDir,
    onBeforeRename: async () => { throw new Error("rename unavailable"); },
  });
  const previousContents = await readFile(firstPath, "utf8");
  await assert.rejects(failed.save(projectRoot, checkpoint("failed")), /rename unavailable/);
  assert.equal(await readFile(firstPath, "utf8"), previousContents);
  assert.deepEqual(await readdir(join(baseDir, getProjectId(projectRoot))), ["continuity.json"]);
});
