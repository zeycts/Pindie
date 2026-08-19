import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import {
  FileStateStore,
  getProjectId,
} from "../src/store.ts";

function activeState(): PindieState {
  return {
    task: {
      goal: "Add the State Store",
      constraints: ["Use Node built-ins"],
      successCriteria: [{ id: "c1", description: "State persists" }],
      openLoops: { blockers: [], questions: [], nextIntent: "Write tests" },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  };
}

async function createTestStore() {
  const baseDir = await mkdtemp(join(tmpdir(), "pindie-store-"));
  const store = new FileStateStore({ baseDir });

  return {
    baseDir,
    store,
    statePath(projectRoot: string) {
      return join(baseDir, getProjectId(projectRoot), "state.json");
    },
  };
}

function errorMentions(path: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message.includes(path);
}

test("T51 missing State file loads EMPTY_STATE without creating a file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/missing-state";

  assert.deepEqual(await fixture.store.load(projectRoot), EMPTY_STATE);
  await assert.rejects(readFile(fixture.statePath(projectRoot)), {
    code: "ENOENT",
  });
});

test("T52 malformed JSON rejects and preserves the original State file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/malformed-state";
  const statePath = fixture.statePath(projectRoot);
  const corruptContents = "{ this is not JSON\n";

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, corruptContents, "utf8");

  await assert.rejects(fixture.store.load(projectRoot), errorMentions(statePath));
  assert.equal(await readFile(statePath, "utf8"), corruptContents);
});

test("T53 semantically invalid State rejects and preserves the original file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/invalid-state";
  const statePath = fixture.statePath(projectRoot);
  const invalidState = {
    task: {
      ...activeState().task,
      completed: true,
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: true, checks: [] },
    },
  };
  const contents = `${JSON.stringify(invalidState, null, 2)}\n`;

  await fixture.store.save(projectRoot, EMPTY_STATE);
  await writeFile(statePath, contents, "utf8");

  await assert.rejects(fixture.store.load(projectRoot), errorMentions(statePath));
  assert.equal(await readFile(statePath, "utf8"), contents);
});

test("T53 structurally invalid State rejects and preserves the original file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/wrong-shape";
  const statePath = fixture.statePath(projectRoot);
  const contents = '{"task":{"goal":42}}\n';

  await fixture.store.save(projectRoot, EMPTY_STATE);
  await writeFile(statePath, contents, "utf8");

  await assert.rejects(fixture.store.load(projectRoot), errorMentions(statePath));
  assert.equal(await readFile(statePath, "utf8"), contents);
});

test("T54 save writes complete JSON atomically and leaves no temporary file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/atomic-save";
  const state = activeState();

  await fixture.store.save(projectRoot, state);

  const statePath = fixture.statePath(projectRoot);
  const contents = await readFile(statePath, "utf8");
  assert.equal(contents, `${JSON.stringify(state, null, 2)}\n`);
  assert.deepEqual(await fixture.store.load(projectRoot), state);
  assert.deepEqual(
    (await readdir(join(fixture.baseDir, getProjectId(projectRoot)))).sort(),
    ["state.json"],
  );
});

test("save and load round-trip State", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const state = activeState();

  await fixture.store.save("/workspace/round-trip", state);

  assert.deepEqual(await fixture.store.load("/workspace/round-trip"), state);
});

test("project IDs are deterministic and distinct roots use different paths", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const firstRoot = "/workspace/first";
  const secondRoot = "/workspace/second";

  assert.equal(getProjectId(firstRoot), getProjectId(firstRoot));
  assert.match(getProjectId(firstRoot), /^[a-f0-9]{64}$/);
  assert.notEqual(getProjectId(firstRoot), getProjectId(secondRoot));

  await fixture.store.save(firstRoot, activeState());
  await fixture.store.save(secondRoot, EMPTY_STATE);

  assert.notEqual(fixture.statePath(firstRoot), fixture.statePath(secondRoot));
});

test("invalid State passed to save does not overwrite existing State", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/save-validation";
  const statePath = fixture.statePath(projectRoot);
  const validState = activeState();
  const invalidState: PindieState = {
    task: {
      ...validState.task!,
      successCriteria: [
        { id: "c1", description: "First" },
        { id: "c1", description: "Duplicate" },
      ],
    },
  };

  await fixture.store.save(projectRoot, validState);
  const previousContents = await readFile(statePath, "utf8");

  await assert.rejects(fixture.store.save(projectRoot, invalidState));
  assert.equal(await readFile(statePath, "utf8"), previousContents);
});
