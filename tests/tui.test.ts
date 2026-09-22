import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

import type { HumanGate, PindieState, VerificationCheck } from "../src/state.ts";

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
  formatBlock,
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

function tuiState(options: {
  readonly goal?: string;
  readonly criteriaCount?: number;
  readonly blockers?: readonly string[];
  readonly checks?: readonly VerificationCheck[];
  readonly humanGate?: HumanGate | null;
  readonly completed?: boolean;
} = {}): PindieState {
  const criteriaCount = options.criteriaCount ?? 1;
  return {
    task: {
      goal: options.goal ?? "Render semantic timeline",
      constraints: [],
      successCriteria: Array.from({ length: criteriaCount }, (_, index) => ({
        id: `c${index + 1}`,
        description: `Criterion ${index + 1}`,
      })),
      openLoops: { blockers: [...(options.blockers ?? [])], questions: [], nextIntent: null },
      verification: { stale: false, checks: [...(options.checks ?? [])] },
      humanGate: options.humanGate ?? null,
      completed: options.completed ?? false,
    },
  };
}

function tuiResult(state: PindieState, text = ""): Record<string, unknown> {
  return {
    content: text.length === 0 ? [] : [{ type: "text", text }],
    details: { state },
    isError: false,
  };
}

function applyTuiSemantic(
  projection: PindieUiProjection,
  id: string,
  name: string,
  args: unknown,
  result: Record<string, unknown>,
): PindieUiProjection {
  let next = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: name,
    args,
  }));
  return reduceProjectionEvent(next, event({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name,
    result,
    isError: false,
  }));
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

  attentionResponse(text: string): void {
    this.options.onAttentionResponse?.(text);
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
  promptWait: Promise<void> | null = null;
  lifecycle: ActiveSessionClientLifecycle | undefined;
  lifecycleHistory: Array<ActiveSessionClientLifecycle | undefined> = [];
  clearQueueCalls = 0;
  abortCalls = 0;
  readonly clearQueueSessionIds: string[] = [];
  readonly abortSessionIds: string[] = [];
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
    return this.promptWait ?? Promise.resolve();
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
    this.clearQueueSessionIds.push(this.sessionId);
    const queue = {
      steering: [...this.queue.steering],
      followUp: [...this.queue.followUp],
    };
    this.queue = { steering: [], followUp: [] };
    return queue;
  }

  abortActiveSession(): Promise<void> {
    this.abortCalls += 1;
    this.abortSessionIds.push(this.sessionId);
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
  let currentPresentation: any = null;
  const presentation = { current: () => currentPresentation };
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
    setPresentation(value: unknown): void {
      currentPresentation = value === null ? null : { snapshot: () => value };
    },
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

test("Abort fails closed during replacement and targets Session B after rebind", async () => {
  const harness = createHarness();
  harness.runtime.facts = {
    sessionId: "session-a",
    isStreaming: true,
    isCompacting: false,
    isIdle: false,
    pendingMessageCount: 0,
  };
  const running = harness.mode.run();
  await flush();

  assert.equal(harness.view.applied.at(-1)?.header.sessionId, "session-a");
  assert.equal(harness.view.applied.at(-1)?.status.isIdle, false);
  harness.view.editorText = "draft survives replacement";

  harness.runtime.lifecycle?.beforeSessionInvalidate?.();
  harness.view.abort();

  assert.equal(harness.runtime.clearQueueCalls, 0);
  assert.equal(harness.runtime.abortCalls, 0);
  assert.match(harness.view.notices.at(-1) ?? "", /Session switching/);
  assert.equal(harness.view.editorText, "draft survives replacement");

  harness.runtime.replaceSession("session-b");
  harness.runtime.facts = {
    sessionId: "session-b",
    isStreaming: true,
    isCompacting: false,
    isIdle: false,
    pendingMessageCount: 0,
  };
  await harness.runtime.lifecycle!.rebindSession!();
  assert.equal(harness.view.applied.at(-1)?.header.sessionId, "session-b");
  assert.equal(harness.view.applied.at(-1)?.status.isIdle, false);

  harness.view.abort();
  assert.equal(harness.runtime.clearQueueCalls, 1);
  assert.equal(harness.runtime.abortCalls, 1);
  assert.deepEqual(harness.runtime.clearQueueSessionIds, ["session-b"]);
  assert.deepEqual(harness.runtime.abortSessionIds, ["session-b"]);

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
        isStreaming: true,
        isCompacting: false,
        isIdle: false,
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

  view.setEditorText("native editor line");
  terminal.emit("\x1b\r");
  terminal.emit("continued");
  assert.equal(view.getEditorText(), "native editor line\ncontinued");

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

test("PindieTuiView renders structured Task, Verification, Gate, and Completion blocks", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const base = () => createProjection({
    presentation: null,
    session: {
      sessionId: "semantic-render-session",
      displayIdentity: "Semantic Render Session",
      model: { provider: "test", modelId: "model" },
      thinkingLevel: "high",
      runtime: {
        sessionId: "semantic-render-session",
        isStreaming: false,
        isCompacting: false,
        isIdle: true,
        pendingMessageCount: 0,
      },
      branch: [],
    },
  });

  const active = tuiState({ goal: "Deploy migration safely", criteriaCount: 1 });
  let openProjection = base();
  openProjection = applyTuiSemantic(openProjection, "render-start", "pindie_task_start", {
    goal: "Deploy migration safely",
    successCriteria: ["migration is verified"],
  }, tuiResult(active));
  const blocked = tuiState({
    goal: "Deploy migration safely",
    criteriaCount: 1,
    blockers: ["missing staging token"],
  });
  openProjection = applyTuiSemantic(openProjection, "render-progress", "pindie_task_progress", {
    blockers: ["missing staging token"],
    questions: [],
  }, tuiResult(blocked));
  const checked = tuiState({
    goal: "Deploy migration safely",
    criteriaCount: 1,
    blockers: ["missing staging token"],
    checks: [{ name: "migration tests", status: "passed", covers: ["c1"], evidence: "tests passed" }],
  });
  openProjection = applyTuiSemantic(openProjection, "render-verify", "pindie_verification_record", {
    check: { name: "migration tests", status: "passed", covers: ["c1"], evidenceRefs: ["e1"] },
  }, tuiResult(checked));
  const gated = tuiState({
    goal: "Deploy migration safely",
    criteriaCount: 1,
    blockers: ["missing staging token"],
    checks: checked.task!.verification.checks,
    humanGate: { kind: "decision", question: "Deploy migration to production?", options: ["Deploy", "Hold"] },
  });
  openProjection = applyTuiSemantic(openProjection, "render-gate-open", "pindie_gate_open", {
    kind: "decision",
    question: "Deploy migration to production?",
    options: ["Deploy", "Hold"],
  }, tuiResult(gated));

  view.apply(openProjection);
  view.start();
  await flush();
  const openRendered = terminal.writes.join("");
  assert.match(openRendered, /Task · blocked/);
  assert.match(openRendered, /missing staging token/);
  assert.match(openRendered, /Verification · 1\/1/);
  assert.match(openRendered, /Decision required/);
  assert.match(openRendered, /Deploy migration to production\?/);

  const resolved = tuiState({
    goal: "Deploy migration safely",
    criteriaCount: 1,
    blockers: ["missing staging token"],
    checks: checked.task!.verification.checks,
  });
  let finalProjection = applyTuiSemantic(openProjection, "render-gate-resolve", "pindie_gate_resolve", {}, tuiResult(resolved));
  const complete = tuiState({
    goal: "Deploy migration safely",
    criteriaCount: 1,
    checks: checked.task!.verification.checks,
    completed: true,
  });
  finalProjection = applyTuiSemantic(finalProjection, "render-complete", "pindie_task_complete", {
    summary: "Semantic Timeline implemented",
  }, tuiResult(complete));
  terminal.writes.length = 0;
  view.apply(finalProjection);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finalRendered = terminal.writes.join("");
  assert.match(finalRendered, /Decision resolved/);
  assert.match(finalRendered, /Completed/);
  assert.match(finalRendered, /Semantic Timeline implemented/);
  assert.match(finalRendered, /Verification/);
  assert.match(finalRendered, /migration tests/);
  assert.doesNotMatch(`${openRendered}${finalRendered}`, /pindie_(?:task|verification|gate)_/);

  view.stop();
});

function viewProjection(options: {
  readonly sessionId?: string;
  readonly branch?: readonly SessionEntry[];
  readonly running?: boolean;
} = {}): PindieUiProjection {
  const sessionId = options.sessionId ?? "interaction-session";
  const running = options.running ?? false;
  return createProjection({
    presentation: null,
    session: {
      sessionId,
      displayIdentity: `Session ${sessionId}`,
      model: { provider: "test", modelId: "model" },
      thinkingLevel: "high",
      runtime: {
        sessionId,
        isStreaming: running,
        isCompacting: false,
        isIdle: !running,
        pendingMessageCount: 0,
      },
      branch: options.branch ?? [],
    },
  });
}

function withAttention(
  projection: PindieUiProjection,
  attention: PindieUiProjection["attention"],
): PindieUiProjection {
  return { ...projection, attention };
}

function gatePresentation(gate: HumanGate | null): any {
  return {
    semantic: {
      ok: true,
      snapshot: {
        authority: "coherent",
        taskStatus: gate === null ? "active" : "waiting_human",
        verificationStatus: "pending",
        hasBlockers: false,
        hasQuestions: false,
        completionReady: false,
      },
    },
    status: {
      consumption: null,
      reasoningMode: "auto",
      activity: null,
      state: tuiState({ humanGate: gate }),
      stateUnavailableReason: null,
      runStale: false,
      quotaResumeWaiting: false,
      subscriptionUsage: null,
    },
    quotaResumeWaiting: null,
    projectRoot: "/project",
  };
}

function commandViewProjection(
  sessionId = "command-session",
  output = "command output",
  running = false,
): PindieUiProjection {
  let projection = viewProjection({ sessionId, running });
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start",
    toolCallId: "command-block",
    toolName: "bash",
    args: { command: "printf output" },
  }));
  return reduceProjectionEvent(projection, event({
    type: "tool_execution_end",
    toolCallId: "command-block",
    toolName: "bash",
    result: { content: [{ type: "text", text: output }] },
    isError: false,
  }));
}

function waitForTuiRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test("Timeline focus selects the latest stable Block and clamps navigation", () => {
  const terminal = new FakeTerminal();
  const branch = [
    userEntry("block-a", "A"),
    userEntry("block-b", "B"),
    userEntry("block-c", "C"),
  ];
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ branch }));
  view.start();

  terminal.emit("\u001bh");
  assert.deepEqual(view.getInteractionState(), {
    focusMode: "timeline",
    selectedBlockId: "block-c",
    foldOverrides: new Map(),
    activeOverlay: null,
  });
  terminal.emit("k");
  assert.equal(view.getInteractionState().selectedBlockId, "block-b");
  terminal.emit("k");
  assert.equal(view.getInteractionState().selectedBlockId, "block-a");
  terminal.emit("k");
  assert.equal(view.getInteractionState().selectedBlockId, "block-a");
  terminal.emit("j");
  assert.equal(view.getInteractionState().selectedBlockId, "block-b");

  const updated = viewProjection({
    branch: [
      userEntry("block-a", "A"),
      userEntry("block-b", "B updated"),
      userEntry("block-c", "C"),
    ],
  });
  view.apply(updated);
  assert.equal(view.getInteractionState().selectedBlockId, "block-b");

  view.stop();
});

test("Escape resolves overlay, Timeline back, then Composer abort without chaining", async () => {
  const terminal = new FakeTerminal();
  let aborts = 0;
  const view = new PindieTuiView({ terminal, onAbort: () => { aborts += 1; } });
  view.apply(commandViewProjection("escape-session", "viewer output", true));
  view.start();

  terminal.emit("\u001bh");
  terminal.emit("\r");
  assert.equal(view.getInteractionState().activeOverlay, "block-viewer");
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "timeline");
  assert.equal(aborts, 0);

  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(aborts, 0);
  terminal.emit("\u001b");
  assert.equal(aborts, 1);

  await waitForTuiRender();
  view.stop();
});

test("fold overrides survive Projection updates and are pruned by Block ID", () => {
  const terminal = new FakeTerminal();
  let projection = commandViewProjection("fold-session", "first output");
  const originalBlock = projection.timeline[0];
  assert.equal(originalBlock?.type, "work");
  assert.equal(originalBlock?.defaultDisplayMode, "compact");
  const view = new PindieTuiView({ terminal });
  view.apply(projection);
  view.start();
  terminal.emit("\u001bh");

  terminal.emit("l");
  assert.equal(view.getInteractionState().foldOverrides.get("command-block"), "full");
  assert.equal(originalBlock?.defaultDisplayMode, "compact");

  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "command-block",
    toolName: "bash",
    args: { command: "printf output" },
    partialResult: { content: [{ type: "text", text: "updated output" }] },
  }));
  view.apply(projection);
  assert.equal(view.getInteractionState().foldOverrides.get("command-block"), "full");

  terminal.emit("h");
  assert.equal(view.getInteractionState().foldOverrides.get("command-block"), "compact");
  terminal.emit("e");
  assert.equal(view.getInteractionState().foldOverrides.get("command-block"), "full");

  view.apply(viewProjection({ sessionId: "fold-session" }));
  assert.equal(view.getInteractionState().foldOverrides.has("command-block"), false);
  assert.equal(view.getInteractionState().selectedBlockId, null);
  view.stop();
});

test("Message compact formatting is a bounded rendering mode", () => {
  const projection = viewProjection({
    branch: [userEntry("message-block", "first meaningful line\nsecond line")],
  });
  const block = projection.timeline[0];
  assert.equal(block?.type, "message");
  assert.match(formatBlock(block!, "compact"), /user · first meaningful line…/);
  assert.doesNotMatch(formatBlock(block!, "compact"), /second line/);
  assert.match(formatBlock(block!, "full"), /second line/);
});

test("Block Viewer refreshes from Projection and copy always uses Full density", async () => {
  const terminal = new FakeTerminal();
  const copied: string[] = [];
  let rejectCopy = false;
  const view = new PindieTuiView({
    terminal,
    copyText: async (text) => {
      if (rejectCopy) throw new Error("clipboard unavailable");
      copied.push(text);
    },
  });
  let projection = commandViewProjection("viewer-session", "initial full output");
  view.apply(projection);
  view.start();
  terminal.emit("\u001bh");
  terminal.emit("\r");
  assert.equal(view.getInteractionState().selectedBlockId, "command-block");
  assert.equal(view.getInteractionState().foldOverrides.size, 0);
  terminal.writes.length = 0;
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /initial full output/);

  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_update",
    toolCallId: "command-block",
    toolName: "bash",
    args: { command: "printf output" },
    partialResult: { content: [{ type: "text", text: "fresh viewer output" }] },
  }));
  view.apply(projection);
  terminal.writes.length = 0;
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /fresh viewer output/);

  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "timeline");
  terminal.emit("y");
  await waitForTuiRender();
  assert.match(copied[0] ?? "", /fresh viewer output/);
  assert.equal(view.getInteractionState().activeOverlay, null);

  rejectCopy = true;
  terminal.emit("y");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /Copy failed: clipboard unavailable/);

  view.apply(viewProjection({ sessionId: "viewer-session" }));
  assert.equal(view.getInteractionState().activeOverlay, null);
  view.stop();
});

test("Command Palette searches registry actions and dispatches the shared action path", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ sessionId: "palette-session" }));
  view.start();
  view.setEditorText("draft survives palette");

  terminal.emit("\u001bp");
  assert.equal(view.getInteractionState().activeOverlay, "command-palette");
  terminal.emit("s");
  terminal.emit("e");
  terminal.emit("n");
  terminal.emit("d");
  await waitForTuiRender();
  const palette = view as unknown as {
    paletteList: SelectList | null;
  };
  assert.match(palette.paletteList?.getSelectedItem()?.value ?? "", /\u0000composer\.follow-up\u0000/);

  // Clear the public Input through its normal editing binding, search for the
  // same action that Alt+H resolves, and execute it with SelectList Enter.
  terminal.emit("\u0015");
  for (const character of "toggle") terminal.emit(character);
  terminal.emit("\r");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "timeline");
  assert.equal(view.getEditorText(), "draft survives palette");

  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "composer");
  view.stop();
});

test("Human Gate Attention selects exact options while preserving the Composer draft", async () => {
  const terminal = new FakeTerminal();
  const responses: string[] = [];
  const view = new PindieTuiView({ terminal, onAttentionResponse: (text) => responses.push(text) });
  const base = viewProjection({ sessionId: "gate-options" });
  view.apply(base);
  view.start();
  view.setEditorText("also remember to update docs");
  const gated = withAttention(base, {
    kind: "human-gate",
    gateKind: "decision",
    question: "Choose compatibility policy",
    options: ["A", "B", "C"],
  });
  view.apply(gated);
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(view.getEditorText(), "also remember to update docs");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /Choose compatibility policy/);
  assert.match(terminal.writes.join(""), /A/);
  assert.match(terminal.writes.join(""), /B/);
  assert.match(terminal.writes.join(""), /C/);
  terminal.emit("j");
  terminal.emit("\u001b[B");
  terminal.emit("k");
  terminal.emit("\u001b[A");
  terminal.emit("\r");
  assert.deepEqual(responses, ["A"]);
  assert.equal(gated.attention?.kind, "human-gate");
  assert.equal(view.getEditorText(), "also remember to update docs");
  view.stop();
});

test("free-form Attention keeps j/k and Up/Down owned by Pi Editor", () => {
  const terminal = new FakeTerminal();
  const responses: string[] = [];
  const view = new PindieTuiView({ terminal, onAttentionResponse: (text) => responses.push(text) });
  const base = viewProjection({ sessionId: "free-form-keys" });
  view.apply(withAttention(base, {
    kind: "human-gate",
    gateKind: "input",
    question: "Enter a project key",
  }));
  view.start();
  for (const character of "project") terminal.emit(character);
  terminal.emit("\u001b\r");
  for (const character of "key") terminal.emit(character);
  terminal.emit("\u001b[A");
  terminal.emit("!");
  terminal.emit("\u001b[B");
  terminal.emit("?");
  terminal.emit("\r");
  assert.deepEqual(responses, ["pro!ject\nkey?"]);
  view.stop();
});

test("approval defaults and free-form Gate input remain separate from Composer", () => {
  const terminal = new FakeTerminal();
  const responses: string[] = [];
  const view = new PindieTuiView({ terminal, onAttentionResponse: (text) => responses.push(text) });
  const base = viewProjection({ sessionId: "gate-input" });
  view.apply(base);
  view.start();
  view.setEditorText("existing draft");
  view.apply(withAttention(base, {
    kind: "human-gate",
    gateKind: "approval",
    question: "Approve release?",
  }));
  terminal.emit("j");
  terminal.emit("\r");
  assert.deepEqual(responses, ["Reject"]);

  view.apply(withAttention(base, {
    kind: "human-gate",
    gateKind: "input",
    question: "Which credentials?",
  }));
  for (const character of "Use the staging credentials") terminal.emit(character);
  terminal.emit("\r");
  assert.equal(responses.at(-1), "Use the staging credentials");
  assert.equal(view.getEditorText(), "existing draft");
  view.apply(base);
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(view.getEditorText(), "existing draft");
  view.stop();
});

test("Gate Escape is non-destructive and Timeline inspection returns to Attention", async () => {
  const terminal = new FakeTerminal();
  let aborts = 0;
  const view = new PindieTuiView({ terminal, onAbort: () => { aborts += 1; } });
  const gated = withAttention(commandViewProjection("gate-inspect"), {
    kind: "human-gate",
    gateKind: "input",
    question: "Provide context",
  });
  view.apply(gated);
  view.start();
  terminal.emit("draft response");
  await flush();
  terminal.emit("\u001b");
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(aborts, 0);
  const mechanics = view as unknown as { attentionResponseDraft: string };
  assert.equal(mechanics.attentionResponseDraft, "draft response");
  terminal.emit("\u001bh");
  assert.equal(view.getInteractionState().focusMode, "timeline");
  terminal.emit("\r");
  assert.equal(view.getInteractionState().activeOverlay, "block-viewer");
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "timeline");
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(aborts, 0);
  view.apply(withAttention(gated, null));
  assert.equal(view.getInteractionState().focusMode, "composer");
  view.stop();
});

test("authority-unavailable Attention blocks Composer and permits Timeline inspection", async () => {
  const terminal = new FakeTerminal();
  const submissions: string[] = [];
  const view = new PindieTuiView({ terminal, onSubmit: (text) => submissions.push(text) });
  const attention = withAttention(commandViewProjection("authority-attention"), {
    kind: "authority-unavailable",
    reason: "state lease unavailable",
  });
  view.apply(attention);
  view.start();
  terminal.emit("cannot send");
  terminal.emit("\r");
  assert.deepEqual(submissions, []);
  assert.equal(view.getInteractionState().focusMode, "attention");
  terminal.emit("\u001bh");
  assert.equal(view.getInteractionState().focusMode, "timeline");
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().focusMode, "attention");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /state lease unavailable/);
  view.stop();
});

test("controller delivers one idle Gate response as a prompt and fails closed otherwise", async () => {
  const harness = createHarness();
  harness.setPresentation(gatePresentation({ kind: "decision", question: "Choose", options: ["A", "B"] }));
  const running = harness.mode.run();
  await flush();

  let releasePrompt!: () => void;
  harness.runtime.promptWait = new Promise<void>((resolve) => { releasePrompt = resolve; });
  harness.view.attentionResponse("B");
  harness.view.attentionResponse("B");
  assert.deepEqual(harness.runtime.deliveryCalls, [
    { type: "prompt", text: "B", sessionId: "session-a" },
  ]);
  const echoed = harness.view.applied.at(-1)!.timeline.at(-1);
  assert.equal(echoed?.type, "message");
  assert.equal(echoed?.role, "user");
  assert.equal(echoed?.text, "B");
  assert.equal(echoed?.delivery, "prompt");
  releasePrompt();
  await flush();
  harness.view.attentionResponse("A");
  assert.equal(harness.runtime.deliveryCalls.length, 2);
  await flush();

  harness.setPresentation(null);
  harness.refreshCallback();
  harness.view.attentionResponse("B");
  assert.equal(harness.runtime.deliveryCalls.length, 2);
  assert.match(harness.view.notices.at(-1) ?? "", /no longer current/);

  harness.setPresentation(gatePresentation({ kind: "decision", question: "Choose", options: ["A", "B"] }));
  harness.refreshCallback();
  harness.runtime.facts = { ...harness.runtime.facts, isIdle: false, isStreaming: true };
  harness.view.attentionResponse("B");
  assert.equal(harness.runtime.deliveryCalls.length, 2);
  assert.match(harness.view.notices.at(-1) ?? "", /not safely idle/);

  harness.runtime.lifecycle?.beforeSessionInvalidate?.();
  harness.view.attentionResponse("B");
  assert.equal(harness.runtime.deliveryCalls.length, 2);
  assert.match(harness.view.notices.at(-1) ?? "", /Session switching/);

  harness.view.exit();
  await running;
});

test("normal Composer delivery cannot bypass a current Human Gate", async () => {
  const harness = createHarness();
  harness.setPresentation(gatePresentation({ kind: "input", question: "Respond here" }));
  const running = harness.mode.run();
  await flush();
  harness.view.submit("hidden composer draft");
  harness.view.followUp("hidden follow-up");
  assert.deepEqual(harness.runtime.deliveryCalls, []);
  assert.equal(harness.view.editorText, "hidden follow-up");
  assert.match(harness.view.notices.at(-1) ?? "", /respond through Attention/);
  harness.view.exit();
  await running;
});

test("normal Composer delivery fails closed under authority-unavailable Attention", async () => {
  const harness = createHarness();
  const unavailable = gatePresentation(null);
  unavailable.status.stateUnavailableReason = "state lease unavailable";
  harness.setPresentation(unavailable);
  const running = harness.mode.run();
  await flush();
  assert.equal(harness.view.applied.at(-1)?.attention?.kind, "authority-unavailable");

  harness.view.submit("draft");
  assert.equal(harness.view.editorText, "draft");
  harness.view.followUp("after");
  assert.equal(harness.view.editorText, "after");
  assert.deepEqual(harness.runtime.deliveryCalls, []);
  assert.match(harness.view.notices.at(-1) ?? "", /Semantic authority unavailable/);

  harness.view.exit();
  await running;
});

test("Session replacement discards Attention mechanics and derives fresh primary focus", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const sessionA = withAttention(viewProjection({ sessionId: "attention-a" }), {
    kind: "human-gate",
    gateKind: "input",
    question: "Session A response?",
  });
  view.apply(sessionA);
  view.start();
  terminal.emit("session A draft");
  await flush();
  const mechanics = view as unknown as {
    attentionResponseDraft: string;
    attentionSelectedIndex: number;
  };
  assert.equal(mechanics.attentionResponseDraft, "session A draft");

  view.apply(viewProjection({ sessionId: "attention-b" }));
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(mechanics.attentionResponseDraft, "");
  assert.equal(mechanics.attentionSelectedIndex, 0);

  view.apply(withAttention(viewProjection({ sessionId: "attention-c" }), {
    kind: "human-gate",
    gateKind: "decision",
    question: "Session C choice?",
    options: ["C1", "C2"],
  }));
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(mechanics.attentionResponseDraft, "");
  assert.equal(mechanics.attentionSelectedIndex, 0);
  view.stop();
});

test("Session epoch resets all UI-local interaction state and restores Editor focus", () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({
    sessionId: "session-a",
    branch: [userEntry("session-a-block-a", "A"), userEntry("session-a-block-b", "B")],
  }));
  view.start();
  terminal.emit("\u001bh");
  terminal.emit("l");
  terminal.emit("\r");
  assert.equal(view.getInteractionState().activeOverlay, "block-viewer");

  view.apply(viewProjection({
    sessionId: "session-b",
    branch: [userEntry("session-b-block", "B")],
  }));
  assert.deepEqual(view.getInteractionState(), {
    focusMode: "composer",
    selectedBlockId: null,
    foldOverrides: new Map(),
    activeOverlay: null,
  });
  terminal.emit("x");
  assert.equal(view.getEditorText(), "x");
  view.stop();
});
