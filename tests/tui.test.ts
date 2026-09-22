import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

import {
  type ActiveSessionClientLifecycle,
  type ActiveSessionFacts,
  PiRuntimeAdapter,
} from "../src/pi-runtime.ts";
import {
  createProjection,
  reduceProjectionEvent,
  type PindieUiProjection,
} from "../src/ui-projection.ts";
import {
  PindieInteractiveMode,
  type PindieInteractiveModeOptions,
} from "../src/tui/pindie-interactive-mode.ts";
import {
  PindieTuiView,
  type PindieTuiViewOptions,
  type PindieTuiViewPort,
} from "../src/tui/view.ts";

function event(value: Record<string, unknown>): AgentSessionEvent {
  return value as unknown as AgentSessionEvent;
}

function userEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-22T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  } as unknown as SessionEntry;
}

class FakeView implements PindieTuiViewPort {
  readonly applied: PindieUiProjection[] = [];
  readonly notices: string[] = [];
  readonly options: PindieTuiViewOptions;
  startCalls = 0;
  stopCalls = 0;
  editorText = "";

  constructor(options: PindieTuiViewOptions) {
    this.options = options;
  }

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  apply(projection: PindieUiProjection): void {
    this.applied.push(projection);
  }

  getEditorText(): string {
    return this.editorText;
  }

  setEditorText(text: string): void {
    this.editorText = text;
  }

  clearEditor(): void {
    this.editorText = "";
  }

  showNotice(message: string): void {
    this.notices.push(message);
  }

  requestRender(): void {}

  submit(text: string): void {
    this.options.onSubmit?.(text);
  }

  followUp(text: string): void {
    this.options.onFollowUp?.(text);
  }

  abort(): void {
    this.options.onAbort?.();
  }

  exit(): void {
    this.options.onExit?.();
  }
}

class FakeRuntime {
  sessionId = "session-a";
  displayIdentity = "Session A";
  branch: readonly SessionEntry[] = [];
  facts: ActiveSessionFacts = {
    sessionId: this.sessionId,
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    pendingMessageCount: 0,
  };
  queue = { steering: [] as string[], followUp: [] as string[] };
  readonly bindings: unknown[] = [];
  readonly subscriptions: Array<{
    sessionId: string;
    listener: (event: AgentSessionEvent) => void;
    active: boolean;
  }> = [];
  readonly deliveryCalls: Array<{ type: string; text: string; sessionId: string }> = [];
  lifecycle: ActiveSessionClientLifecycle | undefined;
  lifecycleHistory: Array<ActiveSessionClientLifecycle | undefined> = [];
  clearQueueCalls = 0;
  abortCalls = 0;
  abortWait: Promise<void> | null = null;

  get activeSessionId(): string {
    return this.sessionId;
  }

  getActiveSessionFacts(): ActiveSessionFacts {
    return { ...this.facts };
  }

  getActiveSessionDisplayIdentity(): string {
    return this.displayIdentity;
  }

  getActiveSessionModelIdentity(): { provider: string; modelId: string } {
    return { provider: "test", modelId: "model" };
  }

  getActiveSessionThinkingLevel(): "high" {
    return "high";
  }

  getActiveSessionBranch(): readonly SessionEntry[] {
    return this.branch;
  }

  bindActiveSessionExtensions(bindings: unknown): Promise<void> {
    this.bindings.push(bindings);
    return Promise.resolve();
  }

  subscribeActiveSession(listener: (event: AgentSessionEvent) => void): () => void {
    const subscription = { sessionId: this.sessionId, listener, active: true };
    this.subscriptions.push(subscription);
    return () => {
      subscription.active = false;
    };
  }

  setActiveSessionClientLifecycle(lifecycle?: ActiveSessionClientLifecycle): void {
    this.lifecycle = lifecycle;
    this.lifecycleHistory.push(lifecycle);
  }

  prompt(text: string): Promise<void> {
    this.deliveryCalls.push({ type: "prompt", text, sessionId: this.sessionId });
    return Promise.resolve();
  }

  steer(text: string): Promise<void> {
    this.deliveryCalls.push({ type: "steer", text, sessionId: this.sessionId });
    return Promise.resolve();
  }

  followUp(text: string): Promise<void> {
    this.deliveryCalls.push({ type: "followUp", text, sessionId: this.sessionId });
    return Promise.resolve();
  }

  clearActiveSessionQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const queue = {
      steering: [...this.queue.steering],
      followUp: [...this.queue.followUp],
    };
    this.queue = { steering: [], followUp: [] };
    return queue;
  }

  abortActiveSession(): Promise<void> {
    this.abortCalls += 1;
    return this.abortWait ?? Promise.resolve();
  }

  emit(eventValue: AgentSessionEvent): void {
    for (const subscription of this.subscriptions) {
      if (subscription.active && subscription.sessionId === this.sessionId) {
        subscription.listener(eventValue);
      }
    }
  }

  replaceSession(sessionId: string, branch: readonly SessionEntry[] = []): void {
    this.sessionId = sessionId;
    this.displayIdentity = `Session ${sessionId.slice(-1).toUpperCase()}`;
    this.branch = branch;
    this.facts = { ...this.facts, sessionId };
  }

  adapter(): PiRuntimeAdapter {
    return this as unknown as PiRuntimeAdapter;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness() {
  const runtime = new FakeRuntime();
  const presentation = { current: () => null };
  let view: FakeView | undefined;
  let refreshCallback: (() => void) | undefined;
  let clearRefreshCalls = 0;
  const timer = {} as ReturnType<typeof setInterval>;
  const options: PindieInteractiveModeOptions = {
    presentation,
    refreshIntervalMs: 1_000,
    createView: (viewOptions) => {
      view = new FakeView(viewOptions);
      return view;
    },
    scheduleRefresh: (callback) => {
      refreshCallback = callback;
      return timer;
    },
    clearRefresh: () => {
      clearRefreshCalls += 1;
    },
  };
  const mode = new PindieInteractiveMode(runtime.adapter(), options);
  return {
    mode,
    runtime,
    presentation,
    get view(): FakeView {
      assert.ok(view);
      return view;
    },
    get refreshCallback(): () => void {
      assert.ok(refreshCallback);
      return refreshCallback;
    },
    get clearRefreshCalls(): number {
      return clearRefreshCalls;
    },
  };
}

test("PindieInteractiveMode binds, projects, reduces events, and shuts down cleanly", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  assert.equal(harness.view.startCalls, 1);
  assert.equal(harness.runtime.bindings.length, 1);
  assert.deepEqual(harness.runtime.bindings[0], {
    mode: "tui",
    abortHandler: harness.runtime.bindings[0] && (harness.runtime.bindings[0] as any).abortHandler,
    shutdownHandler: harness.runtime.bindings[0] && (harness.runtime.bindings[0] as any).shutdownHandler,
    onError: harness.runtime.bindings[0] && (harness.runtime.bindings[0] as any).onError,
  });
  assert.equal(harness.view.applied.length, 1);

  harness.runtime.emit(event({
    type: "tool_execution_start",
    toolCallId: "tool-a",
    toolName: "read",
    args: { path: "src/host.ts" },
  }));
  const latest = harness.view.applied.at(-1)!;
  assert.equal(latest.timeline[0]?.type, "work");
  assert.equal(latest.timeline[0]?.id, "observe:tool-a");
  assert.equal(latest.timeline[0]?.kind, "observation");
  assert.equal((latest.timeline[0] as any).items[0]?.toolCallId, "tool-a");

  harness.refreshCallback();
  const refreshed = harness.view.applied.at(-1)!;
  assert.equal(refreshed.timeline, latest.timeline);
  assert.equal(refreshed.liveAssistant, latest.liveAssistant);

  harness.view.exit();
  await running;
  assert.equal(harness.view.stopCalls, 1);
  assert.equal(harness.clearRefreshCalls, 1);
  assert.equal(harness.runtime.lifecycleHistory.at(-1), undefined);
  assert.equal(harness.runtime.subscriptions[0]?.active, false);
});

test("PindieInteractiveMode safely replaces Session subscriptions and projection epochs", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  harness.runtime.emit(event({
    type: "tool_execution_start",
    toolCallId: "old-tool",
    toolName: "read",
    args: {},
  }));
  const oldSubscription = harness.runtime.subscriptions[0]!;
  assert.equal(harness.view.applied.at(-1)?.timeline[0]?.id, "observe:old-tool");

  harness.runtime.lifecycle?.beforeSessionInvalidate?.();
  assert.equal(oldSubscription.active, false);
  const appliedBeforeStaleEvent = harness.view.applied.length;
  oldSubscription.listener(event({
    type: "message_start",
    message: { role: "assistant", content: [{ type: "text", text: "stale" }] },
  }));
  assert.equal(harness.view.applied.length, appliedBeforeStaleEvent);

  harness.runtime.replaceSession("session-b", [userEntry("new-entry", "new Session")]);
  harness.presentation.current = () => null;
  await harness.runtime.lifecycle!.rebindSession!();

  assert.equal(harness.runtime.bindings.length, 2);
  assert.equal(harness.runtime.subscriptions.length, 2);
  const fresh = harness.view.applied.at(-1)!;
  assert.equal(fresh.header.sessionId, "session-b");
  assert.deepEqual(fresh.timeline.map((block) => block.id), ["new-entry"]);
  assert.equal(fresh.status.presentationAvailability, "unavailable");
  assert.equal(fresh.timeline.some((block) => block.id === "old-tool"), false);

  harness.view.exit();
  await running;
});

test("input fails closed and remains editable during Session replacement", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  const oldSubscription = harness.runtime.subscriptions[0]!;
  harness.runtime.lifecycle?.beforeSessionInvalidate?.();
  assert.equal(oldSubscription.active, false);

  // Real pi-tui Editor.submitValue clears before invoking onSubmit.
  harness.view.editorText = "";
  harness.view.submit("keep this instruction");
  assert.deepEqual(harness.runtime.deliveryCalls, []);
  assert.equal(harness.view.editorText, "keep this instruction");
  assert.match(harness.view.notices.at(-1) ?? "", /Session switching/);

  harness.view.editorText = "follow up after switch";
  harness.view.followUp("follow up after switch");
  assert.deepEqual(harness.runtime.deliveryCalls, []);
  assert.equal(harness.view.editorText, "follow up after switch");
  assert.match(harness.view.notices.at(-1) ?? "", /input kept in Composer/);

  harness.runtime.replaceSession("session-b");
  await harness.runtime.lifecycle!.rebindSession!();
  harness.view.submit("keep this instruction");
  assert.deepEqual(harness.runtime.deliveryCalls, [
    { type: "prompt", text: "keep this instruction", sessionId: "session-b" },
  ]);

  harness.view.exit();
  await running;
});

test("Prompt, Steer, and Follow-up use native active Session facts and echo delivery provenance", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: true };
  harness.view.submit("  idle prompt  ");
  harness.view.followUp("idle after");

  harness.runtime.facts = {
    ...harness.runtime.facts,
    isIdle: false,
    isStreaming: true,
  };
  harness.view.submit("working steer");
  harness.view.followUp("working after");

  assert.deepEqual(harness.runtime.deliveryCalls, [
    { type: "prompt", text: "idle prompt", sessionId: "session-a" },
    { type: "prompt", text: "idle after", sessionId: "session-a" },
    { type: "steer", text: "working steer", sessionId: "session-a" },
    { type: "followUp", text: "working after", sessionId: "session-a" },
  ]);
  assert.deepEqual(
    harness.view.applied.at(-1)!.timeline
      .filter((block) => block.type === "message" && block.role === "user")
      .map((block) => ({ id: block.id, text: block.text, delivery: block.delivery })),
    [
      { id: "live:session-a:user:1", text: "idle prompt", delivery: "prompt" },
      { id: "live:session-a:user:2", text: "idle after", delivery: "prompt" },
      { id: "live:session-a:user:3", text: "working steer", delivery: "steer" },
      { id: "live:session-a:user:4", text: "working after", delivery: "followUp" },
    ],
  );

  harness.view.exit();
  await running;
});

test("Escape restores native queues, aborts once, and never exits an idle Session", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  let releaseAbort!: () => void;
  harness.runtime.abortWait = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  harness.runtime.facts = { ...harness.runtime.facts, isIdle: false, isStreaming: true };
  harness.runtime.queue = {
    steering: ["fix A"],
    followUp: ["then update docs"],
  };
  harness.view.editorText = "draft";
  harness.view.abort();
  harness.view.abort();

  assert.equal(harness.runtime.clearQueueCalls, 1);
  assert.equal(harness.runtime.abortCalls, 1);
  assert.equal(harness.view.editorText, "fix A\n\nthen update docs\n\ndraft");

  releaseAbort();
  await flush();
  harness.runtime.queue = { steering: [], followUp: [] };
  harness.runtime.abortWait = null;
  harness.view.editorText = "draft only";
  harness.view.abort();
  assert.equal(harness.view.editorText, "draft only");
  assert.equal(harness.runtime.clearQueueCalls, 2);
  assert.equal(harness.runtime.abortCalls, 2);

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: true, isStreaming: false };
  harness.view.abort();
  assert.equal(harness.runtime.abortCalls, 2);

  harness.view.exit();
  await running;
});

class FakeTerminal implements Terminal {
  readonly writes: string[] = [];
  columns = 80;
  rows = 24;
  started = false;
  private input?: (data: string) => void;

  get kittyProtocolActive(): boolean {
    return false;
  }

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.started = true;
    this.input = onInput;
  }

  stop(): void {
    this.started = false;
  }

  drainInput(): Promise<void> {
    return Promise.resolve();
  }

  write(data: string): void {
    this.writes.push(data);
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}

  emit(data: string): void {
    this.input?.(data);
  }
}

test("PindieTuiView renders the four Slice D regions and restores terminal lifecycle", async () => {
  const terminal = new FakeTerminal();
  const gestures = { followUp: [] as string[], aborts: 0, exits: 0 };
  const view = new PindieTuiView({
    terminal,
    onFollowUp: (text) => gestures.followUp.push(text),
    onAbort: () => { gestures.aborts += 1; },
    onExit: () => { gestures.exits += 1; },
  });
  const projection = createProjection({
    presentation: null,
    session: {
      sessionId: "render-session",
      displayIdentity: "Render Session",
      model: { provider: "test", modelId: "model" },
      thinkingLevel: "high",
      runtime: {
        sessionId: "render-session",
        isStreaming: false,
        isCompacting: false,
        isIdle: true,
        pendingMessageCount: 0,
      },
      branch: [],
    },
  });

  view.apply(projection);
  view.start();
  await flush();
  view.requestRender();
  await flush();

  const rendered = terminal.writes.join("");
  assert.match(rendered, /Pindie/);
  assert.match(rendered, /Timeline/);
  assert.match(rendered, /Composer/);
  assert.match(rendered, /Status/);
  assert.equal(terminal.started, true);

  terminal.writes.length = 0;
  view.showNotice("Delivery failed: test");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(terminal.writes.join(""), /Delivery failed: test/);

  view.setEditorText("follow-up text");
  terminal.emit("\x1bu");
  assert.deepEqual(gestures.followUp, ["follow-up text"]);
  terminal.emit("\x1b");
  assert.equal(gestures.aborts, 1);
  view.clearEditor();
  terminal.emit("\x04");
  assert.equal(gestures.exits, 1);

  view.stop();
  assert.equal(terminal.started, false);
});

test("PindieTuiView follows Work density without dumping successful output", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const base = () => createProjection({
    presentation: null,
    session: {
      sessionId: "density-session",
      displayIdentity: "Density Session",
      model: { provider: "test", modelId: "model" },
      thinkingLevel: "high",
      runtime: {
        sessionId: "density-session",
        isStreaming: false,
        isCompacting: false,
        isIdle: true,
        pendingMessageCount: 0,
      },
      branch: [],
    },
  });

  let projection = base();
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "compact-command",
    toolName: "bash",
    args: { command: "pnpm test" },
  }));
  const successfulOutput = "successful output that should recede";
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "compact-command",
    toolName: "bash",
    result: { content: [{ type: "text", text: successfulOutput }] },
    isError: false,
  }));
  view.apply(projection);
  view.start();
  await flush();
  const compact = terminal.writes.join("");
  assert.match(compact, /Command · pnpm test/);
  assert.doesNotMatch(compact, /successful output that should recede/);

  let failed = base();
  const failedOutput = Array.from({ length: 40 }, (_, index) => `failure line ${index}`).join("\n");
  failed = reduceProjectionEvent(failed, event({
    type: "tool_execution_start",
    toolCallId: "failed-command",
    toolName: "bash",
    args: { command: "pnpm test" },
  }));
  failed = reduceProjectionEvent(failed, event({
    type: "tool_execution_end",
    toolCallId: "failed-command",
    toolName: "bash",
    result: { content: [{ type: "text", text: failedOutput }] },
    isError: true,
  }));
  terminal.writes.length = 0;
  view.apply(failed);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const failure = terminal.writes.join("");
  assert.match(failure, /failure line 39/);
  assert.doesNotMatch(failure, /failure line 0/);

  let observation = base();
  observation = reduceProjectionEvent(observation, event({
    type: "tool_execution_start",
    toolCallId: "density-read",
    toolName: "read",
    args: { path: "src/ui-projection.ts" },
  }));
  terminal.writes.length = 0;
  view.apply(observation);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const running = terminal.writes.join("");
  assert.match(running, /Inspecting project/);
  assert.match(running, /Reading src\/ui-projection.ts/);

  observation = reduceProjectionEvent(observation, event({
    type: "tool_execution_end",
    toolCallId: "density-read",
    toolName: "read",
    result: { content: [] },
    isError: false,
  }));
  observation = reduceProjectionEvent(observation, event({
    type: "tool_execution_start",
    toolCallId: "density-grep",
    toolName: "grep",
    args: { pattern: "UiWorkBlock" },
  }));
  observation = reduceProjectionEvent(observation, event({
    type: "tool_execution_end",
    toolCallId: "density-grep",
    toolName: "grep",
    result: { content: [] },
    isError: false,
  }));
  terminal.writes.length = 0;
  view.apply(observation);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const grouped = terminal.writes.join("");
  assert.match(grouped, /Inspected project/);
  assert.match(grouped, /Read 1 file · Searched 1 pattern/);

  let edit = base();
  edit = reduceProjectionEvent(edit, event({
    type: "tool_execution_start",
    toolCallId: "density-edit",
    toolName: "edit",
    args: { path: "src/ui-projection.ts" },
  }));
  edit = reduceProjectionEvent(edit, event({
    type: "tool_execution_end",
    toolCallId: "density-edit",
    toolName: "edit",
    result: { content: [{ type: "text", text: "large edit details" }] },
    isError: false,
  }));
  terminal.writes.length = 0;
  view.apply(edit);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const editOutput = terminal.writes.join("");
  assert.match(editOutput, /Edited src\/ui-projection.ts/);
  assert.doesNotMatch(editOutput, /large edit details/);

  view.stop();
});
