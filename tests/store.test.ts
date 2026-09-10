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

test("M5 legacy free-text verification evidence remains loadable and semantically valid", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const state = activeState();
  const legacyState: PindieState = {
    task: {
      ...state.task!,
      verification: {
        stale: false,
        checks: [{
          name: "legacy tests",
          status: "passed",
          covers: ["c1"],
          evidence: "Tests passed.",
        }],
      },
    },
  };

  await fixture.store.save("/workspace/legacy-verification", legacyState);

  assert.deepEqual(
    await fixture.store.load("/workspace/legacy-verification"),
    legacyState,
  );
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

function lockPath(baseDir: string, projectRoot: string): string {
  return join(baseDir, getProjectId(projectRoot), "state.lock");
}

async function writeLockOwner(path: string, owner: object): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "owner.json"), JSON.stringify(owner));
}

test("FIX-L01 two reclaimers serialize recovery of one valid dead-owner lock", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/two-reclaimers";
  await writeLockOwner(lockPath(fixture.baseDir, projectRoot), { token: "dead", pid: 42, acquiredAt: 1 });
  let reclaimClaimed!: () => void;
  let releaseReclaim!: () => void;
  const claimed = new Promise<void>((resolve) => { reclaimClaimed = resolve; });
  const reclaimBarrier = new Promise<void>((resolve) => { releaseReclaim = resolve; });
  const options = {
    baseDir: fixture.baseDir,
    lockRetryMs: 1,
    lockTimeoutMs: 100,
    // Only the seeded stale lock owner is dead; replacement owners use this
    // process PID and must be treated as live by the competing reclaimer.
    isProcessAlive: (pid: number) => pid !== 42,
  };
  const first = new FileStateStore({ ...options, onReclaimClaimed: async () => { reclaimClaimed(); await reclaimBarrier; } });
  const second = new FileStateStore(options);
  let active = 0;
  let maximumActive = 0;
  let releaseFirst!: () => void;
  const firstCritical = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const enter = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await firstCritical;
    active -= 1;
  };
  const firstAttempt = first.withProjectLock(projectRoot, enter);
  await claimed;
  const secondAttempt = second.withProjectLock(projectRoot, enter);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 0, "the reclaim claim is not the State critical section");
  releaseReclaim();
  while (active === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximumActive, 1);
  releaseFirst();
  await Promise.all([firstAttempt, secondAttempt]);
  assert.equal(maximumActive, 1);
});

test("FIX-L02 and FIX-L05 ambiguous ownerless or corrupt locks are never age-stolen", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const store = new FileStateStore({ baseDir: fixture.baseDir, lockRetryMs: 1, lockTimeoutMs: 10 });
  for (const [projectRoot, contents] of [["/workspace/ownerless", null], ["/workspace/corrupt", "not json"]] as const) {
    const path = lockPath(fixture.baseDir, projectRoot);
    await mkdir(path, { recursive: true });
    if (contents) await writeFile(join(path, "owner.json"), contents);
    await assert.rejects(store.withProjectLock(projectRoot, async () => undefined), StateLockBusyError);
    if (contents === null) {
      await assert.rejects(readFile(join(path, "owner.json"), "utf8"), { code: "ENOENT" });
    } else {
      assert.equal(await readFile(join(path, "owner.json"), "utf8"), contents);
    }
  }
});

test("FIX-L03-L04 valid dead owners recover while live owners remain busy", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const deadProject = "/workspace/dead";
  await writeLockOwner(lockPath(fixture.baseDir, deadProject), { token: "dead", pid: 42, acquiredAt: 0 });
  const deadStore = new FileStateStore({
    baseDir: fixture.baseDir,
    isProcessAlive: (pid) => pid !== 42,
  });
  let recovered = false;
  await deadStore.withProjectLock(deadProject, async () => { recovered = true; });
  assert.equal(recovered, true);
  const liveProject = "/workspace/live";
  await writeLockOwner(lockPath(fixture.baseDir, liveProject), { token: "live", pid: process.pid, acquiredAt: 0 });
  const liveStore = new FileStateStore({ baseDir: fixture.baseDir, lockRetryMs: 1, lockTimeoutMs: 10 });
  await assert.rejects(liveStore.withProjectLock(liveProject, async () => undefined), StateLockBusyError);
});

test("FIX-L06 former token release cannot remove a replacement owner", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/foreign-token";
  const path = lockPath(fixture.baseDir, projectRoot);
  await fixture.store.withProjectLock(projectRoot, async () => {
    await writeFile(join(path, "owner.json"), JSON.stringify({ token: "replacement", pid: process.pid, acquiredAt: 2 }));
  });
  const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  assert.equal(owner.token, "replacement");
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

test("State save cancellation before rename preserves the original file and cleans its temp file", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/save-abort-before-rename";
  const original = activeState();
  const replacement: PindieState = {
    task: {
      ...original.task!,
      goal: "Replacement must not be renamed",
    },
  };
  await fixture.store.save(projectRoot, original);
  const statePath = fixture.statePath(projectRoot);
  const previousContents = await readFile(statePath, "utf8");
  const controller = new AbortController();
  const store = new FileStateStore({
    baseDir: fixture.baseDir,
    onBeforeRename: async () => controller.abort(),
  });

  await assert.rejects(
    store.save(projectRoot, replacement, controller.signal),
    /Could not save Pindie State file/,
  );
  assert.equal(await readFile(statePath, "utf8"), previousContents);
  assert.deepEqual(
    (await readdir(join(fixture.baseDir, getProjectId(projectRoot)))).sort(),
    ["state.json"],
  );
});

test("cancelled State lock contenders exit without entering the critical section", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/lock-abort-waiter";
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holding = fixture.store.withProjectLock(projectRoot, async () => {
    markEntered();
    await held;
  });
  await entered;

  const contender = new FileStateStore({
    baseDir: fixture.baseDir,
    lockRetryMs: 2,
    lockTimeoutMs: 500,
  });
  const controller = new AbortController();
  let contenderEntered = false;
  const waiting = contender.withProjectLock(
    projectRoot,
    async () => { contenderEntered = true; },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(waiting, (error: unknown) => error === controller.signal.reason);
  assert.equal(contenderEntered, false);
  release();
  await holding;
});

test("State lock release is not cancelled when its owned operation aborts", async (t) => {
  const fixture = await createTestStore();
  t.after(() => rm(fixture.baseDir, { recursive: true, force: true }));
  const projectRoot = "/workspace/lock-abort-owner";
  const controller = new AbortController();
  let ownerEntered = false;
  await fixture.store.withProjectLock(
    projectRoot,
    async () => {
      ownerEntered = true;
      controller.abort();
      await Promise.resolve();
    },
    controller.signal,
  );
  assert.equal(ownerEntered, true);

  let replacementEntered = false;
  await fixture.store.withProjectLock(projectRoot, async () => {
    replacementEntered = true;
  });
  assert.equal(replacementEntered, true);
});
