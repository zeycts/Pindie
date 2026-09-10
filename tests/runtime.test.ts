import assert from "node:assert/strict";
import test from "node:test";

import {
  PindieRuntime,
  PindieRuntimeStaleAuthorityError,
} from "../src/runtime.ts";
import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";

class FakeStateStore implements PindieStateStore {
  readonly loads: string[] = [];
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  loadState: PindieState = EMPTY_STATE;
  loadError: Error | null = null;
  saveError: Error | null = null;
  beforeSave: (() => Promise<void>) | null = null;

  async load(projectRoot: string): Promise<PindieState> {
    this.loads.push(projectRoot);
    if (this.loadError) throw this.loadError;
    return this.loadState;
  }

  async save(projectRoot: string, state: PindieState): Promise<void> {
    this.saves.push({ projectRoot, state });
    if (this.beforeSave) await this.beforeSave();
    if (this.saveError) throw this.saveError;
    this.loadState = state;
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class DeferredLoadStore implements PindieStateStore {
  state: PindieState = EMPTY_STATE;
  private readonly pending: Array<{
    readonly started: () => void;
    readonly promise: Promise<PindieState>;
  }> = [];

  deferLoad(): {
    started: Promise<void>;
    resolve: (state: PindieState) => void;
  } {
    let markStarted!: () => void;
    let resolve!: (state: PindieState) => void;
    const started = new Promise<void>((settle) => { markStarted = settle; });
    const promise = new Promise<PindieState>((settle) => { resolve = settle; });
    this.pending.push({ started: markStarted, promise });
    return { started, resolve };
  }

  async load(_projectRoot: string, _signal?: AbortSignal): Promise<PindieState> {
    const next = this.pending.shift();
    if (next !== undefined) {
      next.started();
      return next.promise;
    }
    return this.state;
  }

  async save(_projectRoot: string, state: PindieState): Promise<void> {
    this.state = state;
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

const START_EVENT = {
  type: "start_task" as const,
  goal: "Add Pindie tools",
  constraints: [],
  successCriteria: ["Tools mutate State through the Runtime"],
};

test("R01 load stores State and the active project root", async () => {
  const store = new FakeStateStore();
  store.loadState = { task: null };
  const runtime = new PindieRuntime(store);

  await runtime.load("/workspace/pindie");

  assert.deepEqual(runtime.state, store.loadState);
  assert.equal(runtime.projectRoot, "/workspace/pindie");
  assert.deepEqual(store.loads, ["/workspace/pindie"]);
});

test("R02 dispatch saves before updating runtime State", async () => {
  const store = new FakeStateStore();
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  store.beforeSave = () =>
    new Promise<void>((resolve) => {
      releaseSave = resolve;
      markSaveStarted();
    });
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");

  const dispatch = runtime.dispatch(START_EVENT);
  await saveStarted;

  assert.equal(runtime.state.task, null);
  assert.equal(store.saves.length, 1);
  assert.equal(store.saves[0]?.state.task?.goal, "Add Pindie tools");

  releaseSave();
  const result = await dispatch;

  assert.equal(result.ok, true);
  assert.equal(runtime.state.task?.goal, "Add Pindie tools");
});

test("R03 reducer rejection does not save or change runtime State", async () => {
  const store = new FakeStateStore();
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const first = await runtime.dispatch(START_EVENT);
  assert.equal(first.ok, true);
  const previousState = runtime.state;
  store.saves.length = 0;

  const result = await runtime.dispatch({
    ...START_EVENT,
    goal: "Silently replace active task",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "task_already_active");
  assert.equal(runtime.state, previousState);
  assert.deepEqual(store.saves, []);
});

test("R04 Store save failure leaves runtime State unchanged", async () => {
  const store = new FakeStateStore();
  store.saveError = new Error("disk unavailable");
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const previousState = runtime.state;

  await assert.rejects(runtime.dispatch(START_EVENT), /disk unavailable/);

  assert.equal(runtime.state, previousState);
  assert.equal(store.saves.length, 1);
});

test("R05 dispatch before load fails without persistence", async () => {
  const store = new FakeStateStore();
  const runtime = new PindieRuntime(store);

  await assert.rejects(runtime.dispatch(START_EVENT), /load.*before dispatch/i);

  assert.deepEqual(store.saves, []);
  assert.equal(runtime.projectRoot, null);
});

test("R06 a failed project switch invalidates the previous runtime context", async () => {
  const store = new FakeStateStore();
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/project-a");
  const started = await runtime.dispatch(START_EVENT);
  assert.equal(started.ok, true);
  assert.notEqual(runtime.state.task, null);
  store.saves.length = 0;

  store.loadError = new Error("Project B State is unreadable");
  await assert.rejects(
    runtime.load("/workspace/project-b"),
    /Project B State is unreadable/,
  );

  assert.equal(runtime.projectRoot, null);
  assert.deepEqual(runtime.state, EMPTY_STATE);
  await assert.rejects(runtime.dispatch(START_EVENT), /load.*before dispatch/i);
  assert.deepEqual(store.saves, []);

  store.loadError = null;
  store.loadState = EMPTY_STATE;
  await runtime.load("/workspace/project-b");
  const recovered = await runtime.dispatch(START_EVENT);

  assert.equal(recovered.ok, true);
  assert.equal(runtime.projectRoot, "/workspace/project-b");
  assert.equal(runtime.state.task?.goal, START_EVENT.goal);
  assert.deepEqual(
    store.saves.map(({ projectRoot }) => projectRoot),
    ["/workspace/project-b"],
  );
});

test("PSC-R01-R04 refresh preserves equal identity, adopts external State, and preserves snapshot on failure", async () => {
  const store = new FakeStateStore();
  store.loadState = {
    task: {
      goal: "Task A", constraints: [], successCriteria: [{ id: "c1", description: "Works" }],
      openLoops: { blockers: [], questions: [], nextIntent: null }, verification: { stale: false, checks: [] }, humanGate: null, completed: false,
    },
  };
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const stateBefore = runtime.state;
  const taskBefore = runtime.state.task;
  store.loadState = structuredClone(store.loadState);
  assert.equal(await runtime.refresh(), false);
  assert.equal(runtime.state, stateBefore);
  assert.equal(runtime.state.task, taskBefore);
  assert.equal(runtime.externalStateEpoch, 0);
  store.loadState = { ...store.loadState, task: { ...store.loadState.task!, goal: "Task B" } };
  assert.equal(await runtime.refresh(), true);
  assert.equal(runtime.state.task?.goal, "Task B");
  assert.equal(runtime.externalStateEpoch, 1);
  const adopted = runtime.state;
  assert.equal(await runtime.refresh(), false);
  assert.equal(runtime.state, adopted);
  store.loadError = new Error("unreadable");
  await assert.rejects(runtime.refresh(), /unreadable/);
  assert.equal(runtime.state, adopted);
  assert.equal(runtime.externalStateEpoch, 1);
});

test("runtime rejects a late refresh after unload without adopting stale State", async () => {
  const store = new DeferredLoadStore();
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const pending = store.deferLoad();
  const refresh = runtime.refresh();
  await pending.started;

  runtime.unload();
  pending.resolve({
    task: {
      goal: "Stale task",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Must not be adopted" }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  });

  await assert.rejects(
    refresh,
    (error: unknown) => error instanceof PindieRuntimeStaleAuthorityError,
  );
  assert.equal(runtime.projectRoot, null);
  assert.deepEqual(runtime.state, EMPTY_STATE);
});

test("overlapping project loads can only commit the latest authority generation", async () => {
  const store = new DeferredLoadStore();
  const runtime = new PindieRuntime(store);
  const first = store.deferLoad();
  const firstLoad = runtime.load("/workspace/project-a");
  await first.started;
  const second = store.deferLoad();
  const secondLoad = runtime.load("/workspace/project-b");
  await second.started;

  second.resolve({ task: null });
  await secondLoad;
  first.resolve({
    task: {
      goal: "Stale project A task",
      constraints: [],
      successCriteria: [{ id: "c1", description: "Must not be adopted" }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [] },
      humanGate: null,
      completed: false,
    },
  });

  await assert.rejects(
    firstLoad,
    (error: unknown) => error instanceof PindieRuntimeStaleAuthorityError,
  );
  assert.equal(runtime.projectRoot, "/workspace/project-b");
  assert.deepEqual(runtime.state, { task: null });
});

test("PSC-D02-D03 stale semantic events adopt authority and conflict without overwrite", async () => {
  const store = new FakeStateStore();
  const a = new PindieRuntime(store);
  const b = new PindieRuntime(store);
  await a.load("/workspace/pindie");
  await b.load("/workspace/pindie");
  await b.dispatch(START_EVENT);
  await assert.rejects(a.dispatch(START_EVENT), { name: "PindieStateConflictError" });
  assert.equal(a.state.task?.goal, START_EVENT.goal);
  assert.equal(a.externalStateEpoch, 1);
  assert.equal(store.loadState.task?.goal, START_EVENT.goal);
});

test("PSC-D08-D09 invalidation alone safely rebases and reopens concurrent completion", async () => {
  const store = new FakeStateStore();
  const a = new PindieRuntime(store);
  const b = new PindieRuntime(store);
  const verified: PindieState = {
    task: {
      goal: "Task", constraints: [], successCriteria: [{ id: "c1", description: "Works" }],
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: { stale: false, checks: [{ name: "tests", status: "passed", covers: ["c1"], evidence: "pass" }] }, humanGate: null, completed: false,
    },
  };
  store.loadState = verified;
  await a.load("/workspace/pindie");
  await b.load("/workspace/pindie");
  await b.dispatch({ type: "complete_task" });
  const result = await a.dispatch({ type: "invalidate_verification" });
  assert.equal(result.ok, true);
  assert.equal(a.externalStateEpoch, 1);
  assert.equal(store.loadState.task?.completed, false);
  assert.deepEqual(store.loadState.task?.verification, { stale: true, checks: [] });
});

test("unload clears transient Runtime context without persistence", async () => {
  const store = new FakeStateStore();
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const started = await runtime.dispatch(START_EVENT);
  assert.equal(started.ok, true);
  store.saves.length = 0;

  runtime.unload();

  assert.equal(runtime.projectRoot, null);
  assert.deepEqual(runtime.state, EMPTY_STATE);
  assert.deepEqual(store.saves, []);
  await assert.rejects(runtime.dispatch(START_EVENT), /load.*before dispatch/i);
});
