import assert from "node:assert/strict";
import test from "node:test";

import {
  PindieRuntime,
  PindieRuntimeStaleAuthorityError,
  PindieSemanticMutationPendingError,
  PindieStateMutationUncertainError,
} from "../src/runtime.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
} from "../src/liveness.ts";
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

class DeferredSaveStore implements PindieStateStore {
  state: PindieState = EMPTY_STATE;
  readonly loads: string[] = [];
  readonly saves: PindieState[] = [];
  readonly saveStarted: Promise<void>;
  readonly saveFinished: Promise<void>;
  private readonly commitBeforePending: boolean;
  private readonly saveError: Error | null;
  private resolveSaveStarted!: () => void;
  private resolveSaveFinished!: () => void;
  private resolvePendingSave!: () => void;
  private rejectPendingSave!: (error: Error) => void;

  constructor(options: { commitBeforePending: boolean; saveError?: Error | null }) {
    this.commitBeforePending = options.commitBeforePending;
    this.saveError = options.saveError ?? null;
    this.saveStarted = new Promise((resolve) => { this.resolveSaveStarted = resolve; });
    this.saveFinished = new Promise((resolve) => { this.resolveSaveFinished = resolve; });
    this.pendingSave = new Promise<void>((resolve, reject) => {
      this.resolvePendingSave = resolve;
      this.rejectPendingSave = reject;
    });
  }

  private readonly pendingSave: Promise<void>;

  releaseSave(): void {
    if (this.saveError === null) this.resolvePendingSave();
    else this.rejectPendingSave(this.saveError);
  }

  async load(projectRoot: string, _signal?: AbortSignal): Promise<PindieState> {
    this.loads.push(projectRoot);
    return structuredClone(this.state);
  }

  async save(_projectRoot: string, state: PindieState): Promise<void> {
    this.saves.push(state);
    if (this.commitBeforePending) this.state = structuredClone(state);
    this.resolveSaveStarted();
    try {
      await this.pendingSave;
    } finally {
      this.resolveSaveFinished();
    }
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

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function observerLedger(): import("../src/work-episode.ts").WorkEpisodeLedger {
  let id: string | null = null;
  return { reconcile: async () => id, current: async () => id, prepared: async () => undefined,
    committed: async (_root, _before, _after, event) => {
      if (event.type === "start_task" || event.type === "replace_task") id = event.type;
      return id;
    } };
}

test("retired episode observer is never invoked by Task dispatch/refine/progress/reload", async () => {
  const store = new FakeStateStore(), runtime = new PindieRuntime(store, observerLedger());
  let calls = 0;
  runtime.onWorkEpisodeOpened = async () => { calls++; await new Promise(() => {}); };
  await runtime.load("/repo");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      assert.ok((await runtime.dispatch(START_EVENT)).ok);
      assert.ok((await runtime.dispatch({ ...START_EVENT, type: "replace_task", goal: "Replacement" })).ok);
      await runtime.dispatch({ type: "refine_task", goal: "Refined" });
      await runtime.dispatch({ type: "set_open_loops", blockers: [], questions: [], nextIntent: null });
      await runtime.load("/repo");
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Dispatch awaited observer")), 250); })]);
  } finally { clearTimeout(timer); }
  assert.equal(calls, 0);
  assert.equal(runtime.state.task?.goal, "Refined");
});

test("retired episode observer cannot throw or reject into Core transitions", async (t) => {
  const warnings: string[] = [], unhandled: unknown[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const runtime = new PindieRuntime(new FakeStateStore(), observerLedger());
  await runtime.load("/repo");
  runtime.onWorkEpisodeOpened = () => { throw new Error("sync failure".repeat(100)); };
  assert.ok((await runtime.dispatch(START_EVENT)).ok);
  runtime.onWorkEpisodeOpened = async () => { throw new Error("async failure".repeat(100)); };
  assert.ok((await runtime.dispatch({ ...START_EVENT, type: "replace_task", goal: "Replacement" })).ok);
  await nextTurn();
  assert.equal(warnings.length, 0);
  assert.ok(warnings.every((message) => message.length < 600));
  assert.deepEqual(unhandled, []);
  assert.equal(runtime.state.task?.goal, "Replacement");
});

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

test("dispatchBounded reports an uncertain mutation at its deadline and fences new authority", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new DeferredSaveStore({ commitBeforePending: true });
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");

  const dispatch = runtime.dispatchBounded(START_EVENT);
  await store.saveStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);

  await assert.rejects(
    dispatch,
    (error: unknown) => error instanceof PindieStateMutationUncertainError,
  );
  const loadCount = store.loads.length;
  await assert.rejects(
    runtime.load("/workspace/pindie"),
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );
  await assert.rejects(
    runtime.refresh(),
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );
  await assert.rejects(
    runtime.dispatch(START_EVENT),
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );
  assert.equal(store.loads.length, loadCount);

  runtime.unload();
  store.releaseSave();
  await store.saveFinished;
  await nextTurn();
  assert.equal(runtime.projectRoot, null);
  assert.deepEqual(runtime.state, EMPTY_STATE);

  await runtime.load("/workspace/pindie");
  assert.deepEqual(runtime.state, store.state);
});

test("late failed semantic mutation is consumed and does not restore authority", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lateError = new Error("late durable failure");
  const store = new DeferredSaveStore({ commitBeforePending: false, saveError: lateError });
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");

  const dispatch = runtime.dispatchBounded(START_EVENT);
  await store.saveStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await assert.rejects(dispatch, PindieStateMutationUncertainError);
  runtime.unload();

  let unhandled = false;
  const onUnhandled = (reason: unknown): void => {
    if (reason === lateError) unhandled = true;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    store.releaseSave();
    await store.saveFinished;
    await nextTurn();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, false);
  await runtime.load("/workspace/pindie");
  assert.deepEqual(runtime.state, EMPTY_STATE);
});

test("an abort before dispatch starts does not fence or poison authority", async () => {
  const store = new FakeStateStore();
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const controller = new AbortController();
  controller.abort();
  const loadsBefore = store.loads.length;

  await assert.rejects(
    runtime.dispatchBounded(START_EVENT, controller.signal),
    (error: unknown) => error instanceof PindieLivenessAbortError,
  );
  assert.equal(store.loads.length, loadsBefore);
  assert.deepEqual(store.saves, []);

  const result = await runtime.dispatchBounded(START_EVENT);
  assert.equal(result.ok, true);
});

test("an abort after dispatch starts fences authority until late settlement", async () => {
  const store = new DeferredSaveStore({ commitBeforePending: true });
  const runtime = new PindieRuntime(store);
  await runtime.load("/workspace/pindie");
  const controller = new AbortController();
  const dispatch = runtime.dispatchBounded(START_EVENT, controller.signal);
  await store.saveStarted;

  controller.abort();
  await assert.rejects(
    dispatch,
    (error: unknown) => error instanceof PindieStateMutationUncertainError,
  );
  await assert.rejects(
    runtime.dispatch(START_EVENT),
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );

  runtime.unload();
  store.releaseSave();
  await store.saveFinished;
  await nextTurn();
  assert.equal(runtime.projectRoot, null);
  await runtime.load("/workspace/pindie");
  assert.deepEqual(runtime.state, store.state);
});

test("a process project fence blocks a replacement Runtime and an in-flight load cannot publish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mutationStore = new DeferredSaveStore({ commitBeforePending: true });
  const runtimeA = new PindieRuntime(mutationStore);
  await runtimeA.load("/workspace/pindie");

  const replacementStore = new DeferredLoadStore();
  const runtimeB = new PindieRuntime(replacementStore);
  const pendingLoad = replacementStore.deferLoad();
  const loadB = runtimeB.load("/workspace/pindie");
  await pendingLoad.started;

  const mutation = runtimeA.dispatchBounded(START_EVENT);
  await mutationStore.saveStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await assert.rejects(mutation, PindieStateMutationUncertainError);

  pendingLoad.resolve({ task: null });
  await assert.rejects(
    loadB,
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );
  assert.equal(runtimeB.projectRoot, null);

  mutationStore.releaseSave();
  await mutationStore.saveFinished;
  await nextTurn();
  assert.equal(runtimeA.state.task, null, "the late old mutation must not publish Runtime A State");
  await runtimeB.load("/workspace/pindie");
  assert.deepEqual(runtimeB.state, replacementStore.state);
});

test("a process project fence recheck prevents an in-flight refresh from adopting State", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mutationStore = new DeferredSaveStore({ commitBeforePending: true });
  const runtimeA = new PindieRuntime(mutationStore);
  await runtimeA.load("/workspace/pindie");

  const refreshStore = new DeferredLoadStore();
  const runtimeB = new PindieRuntime(refreshStore);
  await runtimeB.load("/workspace/pindie");
  const pendingRefresh = refreshStore.deferLoad();
  const refreshB = runtimeB.refresh();
  await pendingRefresh.started;

  const mutation = runtimeA.dispatchBounded(START_EVENT);
  await mutationStore.saveStarted;
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await assert.rejects(mutation, PindieStateMutationUncertainError);

  pendingRefresh.resolve({ task: null });
  await assert.rejects(
    refreshB,
    (error: unknown) => error instanceof PindieSemanticMutationPendingError,
  );
  assert.deepEqual(runtimeB.state, EMPTY_STATE);

  mutationStore.releaseSave();
  await mutationStore.saveFinished;
  await nextTurn();
});

test("exact process fence leases keep a project fenced until every uncertain mutation settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const storeA = new DeferredSaveStore({ commitBeforePending: true });
  const storeB = new DeferredSaveStore({ commitBeforePending: true });
  const runtimeA = new PindieRuntime(storeA);
  const runtimeB = new PindieRuntime(storeB);
  await runtimeA.load("/workspace/pindie");
  await runtimeB.load("/workspace/pindie");

  const mutationA = runtimeA.dispatchBounded(START_EVENT);
  const mutationB = runtimeB.dispatchBounded(START_EVENT);
  await Promise.all([storeA.saveStarted, storeB.saveStarted]);
  t.mock.timers.tick(PINDIE_TOOL_LIVENESS_TIMEOUT_MS);
  await Promise.all([
    assert.rejects(mutationA, PindieStateMutationUncertainError),
    assert.rejects(mutationB, PindieStateMutationUncertainError),
  ]);

  const probe = new PindieRuntime(storeA);
  await assert.rejects(probe.load("/workspace/pindie"), PindieSemanticMutationPendingError);
  storeA.releaseSave();
  await storeA.saveFinished;
  await nextTurn();
  await assert.rejects(probe.load("/workspace/pindie"), PindieSemanticMutationPendingError);

  storeB.releaseSave();
  await storeB.saveFinished;
  await nextTurn();
  await probe.load("/workspace/pindie");
  assert.deepEqual(probe.state, storeA.state);
});
