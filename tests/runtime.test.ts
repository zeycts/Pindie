import assert from "node:assert/strict";
import test from "node:test";

import { PindieRuntime } from "../src/runtime.ts";
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
