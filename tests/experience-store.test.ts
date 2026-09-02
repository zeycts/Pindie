import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileRunExperienceStore } from "../src/experience-store.ts";
import {
  assembleRunExperience,
  type RunExperience,
} from "../src/run-experience.ts";
import type { SemanticSnapshot } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function experience(goal: string): RunExperience {
  const task: NonNullable<PindieState["task"]> = {
    goal,
    constraints: [],
    successCriteria: [{ id: "c1", description: "Recorded" }],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
  };
  const snapshot: Extract<SemanticSnapshot, { authority: "coherent" }> = {
    authority: "coherent",
    taskStatus: "active",
    verificationStatus: "pending",
    hasBlockers: false,
    hasQuestions: false,
    completionReady: false,
    taskRelation: "preexisting_untouched",
    completionRelation: "not_completed",
    gateRelation: "none",
  };
  return assembleRunExperience({
    task,
    runStart: { taskStatus: "active", taskGoal: goal },
    snapshot,
    policy: {
      finalSnapshot: null,
      declarationCount: 0,
      finalPolicyDeclarationCount: 0,
      finalPolicyFirstDeclaredAfter: null,
      finalPolicyLastDeclaredAfter: null,
    },
    execution: {
      toolCalls: 1,
      observations: 1,
      consequentialCalls: 0,
      projectMutationEffectCalls: 0,
      verificationCalls: 0,
      toolErrors: 0,
      deniedCalls: 0,
    },
    durationMs: 10,
    cost: 0,
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("FileRunExperienceStore writes separate immutable records per project without State", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-experience-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const store = new FileRunExperienceStore({ baseDir });

  await store.save("/workspace/project-a", experience("Run A1"));
  await store.save("/workspace/project-a", experience("Run A2"));
  await store.save("/workspace/project-b", experience("Run B1"));

  const projectAFiles = await readdir(store.experienceDirectory("/workspace/project-a"));
  const projectBFiles = await readdir(store.experienceDirectory("/workspace/project-b"));
  assert.equal(projectAFiles.length, 2);
  assert.equal(projectBFiles.length, 1);
  assert.ok(projectAFiles.every((name) => /^[0-9a-f-]+\.json$/.test(name)));
  assert.ok(projectBFiles.every((name) => /^[0-9a-f-]+\.json$/.test(name)));
  assert.equal(projectAFiles.some((name) => projectBFiles.includes(name)), false);
  assert.equal((await readdir(baseDir)).length, 2);
  assert.equal(
    await readFile(join(store.experienceDirectory("/workspace/project-a"), projectAFiles[0]!), "utf8")
      .then((contents) => contents.endsWith("\n")),
    true,
  );
  await assert.rejects(
    readFile(join(baseDir, "state.json")),
    { code: "ENOENT" },
  );
});
