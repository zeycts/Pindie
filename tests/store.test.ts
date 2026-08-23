import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import {
  FileStateStore,
  getProjectId,
  StateLockBusyError,
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

test("PSC-L01-L04 project locks serialize same-project operations, do not block other projects, and release on success or throw", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const second = new FileStateStore({ baseDir: fixture.baseDir, lockRetryMs: 2, lockTimeoutMs: 100 });
  let release!: () => void;
  const holding = fixture.store.withProjectLock("/workspace/a", () => new Promise<void>((resolve) => { release = resolve; }));
  // The lock directory is proof A acquired; B cannot enter until it is released.
  await new Promise((resolve) => setTimeout(resolve, 5));
  let secondEntered = false;
  const waiting = second.withProjectLock("/workspace/a", async () => { secondEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondEntered, false);
  let otherEntered = false;
  await second.withProjectLock("/workspace/b", async () => { otherEntered = true; });
  assert.equal(otherEntered, true);
  release();
  await holding;
  await waiting;
  assert.equal(secondEntered, true);
  await assert.rejects(second.withProjectLock("/workspace/a", async () => { throw new Error("callback failure"); }), /callback failure/);
  await assert.doesNotReject(second.withProjectLock("/workspace/a", async () => undefined));
});

test("PSC-L05-L09 lock recovery never steals live owners and narrowly recovers dead or old ownerless locks", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/locks";
  const lockPath = join(fixture.baseDir, getProjectId(projectRoot), "state.lock");
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "live", pid: process.pid, acquiredAt: 0 }));
  const shortStore = new FileStateStore({ baseDir: fixture.baseDir, lockRetryMs: 2, lockTimeoutMs: 15, orphanLockGraceMs: 40 });
  await assert.rejects(shortStore.withProjectLock(projectRoot, async () => undefined), StateLockBusyError);
  await rm(lockPath, { recursive: true, force: true });
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: 999_999_999, acquiredAt: 0 }));
  let reclaimed = false;
  await shortStore.withProjectLock(projectRoot, async () => { reclaimed = true; });
  assert.equal(reclaimed, true);
  await mkdir(lockPath, { recursive: true });
  await assert.rejects(shortStore.withProjectLock(projectRoot, async () => undefined), StateLockBusyError);
  await new Promise((resolve) => setTimeout(resolve, 45));
  await shortStore.withProjectLock(projectRoot, async () => undefined);
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
