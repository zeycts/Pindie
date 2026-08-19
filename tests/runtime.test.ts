import assert from "node:assert/strict";
import test from "node:test";

import { PindieRuntime } from "../src/runtime.ts";
import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";

class FakeStateStore implements PindieStateStore {
  readonly loads: string[] = [];
  readonly saves: Array<{ projectRoot: string; state: PindieState }> = [];
  loadState: PindieState = EMPTY_STATE;
  saveError: Error | null = null;
  beforeSave: (() => Promise<void>) | null = null;

  async load(projectRoot: string): Promise<PindieState> {
    this.loads.push(projectRoot);
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
