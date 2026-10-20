import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSessionEvent,
  ExtensionUIContext,
  SessionEntry,
  TerminalInputHandler,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Terminal } from "@earendil-works/pi-tui";

import type { HumanGate, PindieState, VerificationCheck } from "../src/state.ts";

import {
  type ActiveSessionClientLifecycle,
  type ActiveSessionFacts,
  PiRuntimeAdapter,
} from "../src/pi-runtime.ts";
import {
  appendUserDelivery,
  createProjection,
  reduceProjectionEvent,
  type PindieUiProjection,
  type UiObservationWorkBlock,
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
import { boundedGraphemeText } from "../src/tui/bounded-text.ts";
import {
  PindieExtensionUIBridge,
  UnsupportedExtensionUICapabilityError,
} from "../src/tui/extension-ui.ts";

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
  selectExtension(): Promise<string | undefined> { return Promise.resolve(undefined); }
  confirmExtension(): Promise<boolean> { return Promise.resolve(false); }
  inputExtension(): Promise<string | undefined> { return Promise.resolve(undefined); }
  editorExtension(): Promise<string | undefined> { return Promise.resolve(undefined); }
  cancelExtensionDialog(): void {}
  showExtensionNotice(message: string, type = "info"): void { this.showNotice(`${type}: ${message}`); }
  addExtensionTerminalInputHandler(_handler: TerminalInputHandler): () => void { return () => undefined; }
  setExtensionStatus(): void {}
  setExtensionWorkingMessage(): void {}
  setExtensionWorkingVisible(): void {}
  setExtensionWorkingIndicator(_options?: WorkingIndicatorOptions): void {}
  setExtensionHiddenThinkingLabel(): void {}
  setExtensionStringWidget(): void {}
  addExtensionAutocompleteProvider(): void {}
  getExtensionToolsExpanded(): boolean { return false; }
  setExtensionToolsExpanded(): void {}
  setTerminalTitle(): void {}
  restoreBaseTerminalTitle(): void {}
  pasteToComposer(text: string): void { this.editorText += text; }
  clearExtensionSessionState(): void {}

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
  readonly commandCalls: string[] = [];
  readonly modelChanges: Array<{ provider: string; modelId: string; sessionId: string }> = [];
  readonly sessionSwitches: string[] = [];
  modelChoices: readonly import("../src/pi-runtime.ts").ActiveSessionModelChoice[] = [];
  sessionChoices: readonly import("../src/pi-runtime.ts").ActiveProjectSessionChoice[] = [];

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

  waitForActiveSessionIdle(): Promise<void> { this.commandCalls.push("waitForIdle"); return Promise.resolve(); }
  newSession(): Promise<{ cancelled: boolean }> { this.commandCalls.push("newSession"); return Promise.resolve({ cancelled: false }); }
  forkActiveSession(): Promise<{ cancelled: boolean }> { this.commandCalls.push("fork"); return Promise.resolve({ cancelled: false }); }
  navigateActiveSessionTree(): Promise<{ cancelled: boolean }> { this.commandCalls.push("navigateTree"); return Promise.resolve({ cancelled: false }); }
  switchActiveSession(path?: string): Promise<{ cancelled: boolean }> {
    this.commandCalls.push("switchSession");
    if (path !== undefined) this.sessionSwitches.push(path);
    return Promise.resolve({ cancelled: false });
  }
  reloadActiveSession(): Promise<void> { this.commandCalls.push("reload"); return Promise.resolve(); }
  getActiveSessionModelChoices(): readonly import("../src/pi-runtime.ts").ActiveSessionModelChoice[] { return this.modelChoices; }
  setActiveSessionModel(provider: string, modelId: string): Promise<void> {
    this.modelChanges.push({ provider, modelId, sessionId: this.sessionId });
    return Promise.resolve();
  }
  getActiveProjectSessionChoices(): Promise<readonly import("../src/pi-runtime.ts").ActiveProjectSessionChoice[]> { return Promise.resolve(this.sessionChoices); }

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

test("owned mode idle-resource authority requires known settled UI and rejects overlays or unknown views", async () => {
  const harness = createHarness();
  assert.equal(harness.mode.canReleaseIdleResources(), false);
  const running = harness.mode.run();
  await flush();
  assert.equal(harness.mode.canReleaseIdleResources(), false); // Custom view has no observer.
  let pending = false;
  Object.assign(harness.view, { hasPendingInteraction: () => pending });
  assert.equal(harness.mode.canReleaseIdleResources(), true);
  pending = true;
  assert.equal(harness.mode.canReleaseIdleResources(), false);
  pending = false;
  harness.view.exit();
  await running;
  assert.equal(harness.mode.canReleaseIdleResources(), false);
});

test("PindieInteractiveMode binds, projects, reduces events, and shuts down cleanly", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();

  assert.equal(harness.view.startCalls, 1);
  assert.equal(harness.runtime.bindings.length, 1);
  const bindings = harness.runtime.bindings[0] as {
    mode: string;
    uiContext?: ExtensionUIContext;
    commandContextActions?: Record<string, unknown>;
  };
  assert.equal(bindings.mode, "tui");
  assert.ok(bindings.uiContext);
  assert.deepEqual(Object.keys(bindings.commandContextActions ?? {}).sort(), [
    "fork", "navigateTree", "newSession", "reload", "switchSession", "waitForIdle",
  ]);
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

test("controller distinguishes native idle after agent_end from agent_settled", async () => {
  const harness = createHarness();
  harness.setPresentation(gatePresentation(null, ["missing credential"]));
  const running = harness.mode.run();
  await flush();

  assert.equal(harness.view.applied.at(-1)?.softSignal?.kind, "settled-blocked");

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: false, isStreaming: true };
  harness.runtime.emit(event({ type: "agent_start" }));
  assert.equal(harness.view.applied.at(-1)?.softSignal, null);

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: true, isStreaming: false };
  harness.runtime.emit(event({ type: "agent_end", willRetry: false }));
  harness.refreshCallback();
  assert.equal(harness.view.applied.at(-1)?.softSignal, null);

  harness.runtime.emit(event({ type: "agent_settled" }));
  assert.equal(harness.view.applied.at(-1)?.softSignal?.kind, "settled-blocked");

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: false, isStreaming: true };
  harness.runtime.emit(event({ type: "agent_start" }));
  assert.equal(harness.view.applied.at(-1)?.softSignal, null);

  harness.view.exit();
  await running;
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
  readonly titles: string[] = [];
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
  setTitle(title: string): void { this.titles.push(title); }
  setProgress(_active: boolean): void {}

  emit(data: string): void {
    this.input?.(data);
  }
}

test("PindieTuiView keeps ordinary chrome bounded and restores terminal lifecycle", async () => {
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
      automaticWorkSettled: false,
      branch: [],
    },
  });

  view.apply(projection);
  view.start();
  await flush();
  view.requestRender();
  await flush();

  const rendered = terminal.writes.join("");
  assert.match(rendered, /Render Session\s+model · high/);
  assert.match(rendered, /Alt[+]P Commands/);
  assert.doesNotMatch(rendered, /Timeline|Composer|Status ·|Hints ·|test[/]model|task no task|authority coherent/);
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
      automaticWorkSettled: true,
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
      automaticWorkSettled: true,
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
      automaticWorkSettled: !running,
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

function gatePresentation(gate: HumanGate | null, blockers: readonly string[] = []): any {
  return {
    semantic: {
      ok: true,
      snapshot: {
        authority: "coherent",
        taskStatus: gate === null ? blockers.length > 0 ? "blocked" : "active" : "waiting_human",
        verificationStatus: "pending",
        hasBlockers: blockers.length > 0,
        hasQuestions: false,
        completionReady: false,
      },
    },
    status: {
      consumption: null,
      reasoningMode: "manual",
      activity: null,
      state: tuiState({ humanGate: gate, blockers }),
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

test("Header and Footer are single-row, width-aware chrome across resizes", () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const base = viewProjection();
  const projection = {
    ...base,
    status: { ...base.status, verificationProgress: { covered: 4, total: 4 } },
    header: {
      ...base.header,
      displayIdentity: "Long human-facing Session identity that exceeds normal terminal width\ncontinued",
      model: { provider: "secret-provider", modelId: "gpt-6-" + "x".repeat(1_200) },
      taskStatus: "blocked" as const,
      semanticAuthority: "stale" as const,
    },
  };
  view.apply(projection);
  const internals = view as unknown as {
    header: { render(width: number): string[] };
    status: { render(width: number): string[] };
    inputRegion: { render(width: number): string[] };
    timelineContent: { render(width: number): string[] };
    blockLineRanges: Map<string, { start: number; end: number }>;
  };

  const headerWide = internals.header.render(2_000);
  assert.equal(headerWide.length, 1);
  assert.match(headerWide[0]!, /Long human-facing Session identity/);
  assert.match(headerWide[0]!, /gpt-6-/);
  assert.match(headerWide[0]!, /high/);
  assert.ok(headerWide[0]!.indexOf("gpt-6-") - headerWide[0]!.indexOf("Long human-facing") > 40,
    "wide Header should visibly separate identity and model zones");
  assert.doesNotMatch(headerWide[0]!, /secret-provider|blocked|stale|Pindie|project/);

  const header80 = internals.header.render(80);
  assert.equal(header80.length, 1);
  assert.ok(header80[0]!.indexOf("gpt-6-") > 30, "model zone should be right-aligned");
  assert.ok(visibleWidth(header80[0]!) <= 80);

  for (const width of [40, 8, 1, 0]) {
    const header = internals.header.render(width);
    assert.equal(header.length, 1);
    assert.ok(visibleWidth(header[0]!) <= width);
  }
  assert.ok(internals.inputRegion.render(8).length > 0, "narrow Header must not remove the Editor region");
  assert.deepEqual(internals.timelineContent.render(80), []);
  assert.equal(internals.blockLineRanges.size, 0);

  terminal.columns = 80;
  const wideFooter = internals.status.render(terminal.columns);
  terminal.columns = 18;
  const narrowFooter = internals.status.render(terminal.columns);
  assert.equal(wideFooter.length, 1);
  assert.equal(narrowFooter.length, 1);
  assert.ok(visibleWidth(narrowFooter[0]!) <= 18);
  assert.notEqual(wideFooter[0], narrowFooter[0]);
  assert.ok(wideFooter[0]!.includes("✓ 4/4"));
  assert.match(wideFooter[0]!, /Alt[+]P Commands/);
  assert.ok(wideFooter[0]!.indexOf("Alt+P Commands") > wideFooter[0]!.indexOf("✓ 4/4") + 10,
    "idle Commands action should occupy the separated right Footer zone");
  assert.doesNotMatch(wideFooter[0]!, /Status ·|Hints ·|Alt[+]M|Alt[+]N|Alt[+]H/);
  view.stop();
});

test("running Footer keeps registry-derived Stop action and bounds Extension contributions", () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const base = viewProjection({ running: true });
  const projection = {
    ...base,
    status: {
      ...base.status,
      activity: "running" as const,
      consumption: { scope: "run" as const, durationMs: 135_000, cost: 0.12 },
      verificationProgress: { covered: 3, total: 4 },
    },
  };
  view.apply(projection);
  view.setExtensionStatus("long", "status ".repeat(500));
  view.setExtensionWorkingMessage("working ".repeat(500));
  const internals = view as unknown as { status: { render(width: number): string[] } };
  const footer = internals.status.render(80);
  assert.ok(footer.length <= 4);
  assert.ok(footer.every((line) => visibleWidth(line) <= 80));
  assert.match(footer[0]!, /running · 2m 15s · \$0\.12 · ○ 3\/4/);
  assert.match(footer[0]!, /Esc Stop/);
  assert.match(footer[0]!, /Alt[+]P Commands/);
  assert.ok(footer[0]!.indexOf("Esc Stop") > footer[0]!.indexOf("running"),
    "running actions belong to the right Footer zone");
  assert.ok(footer.some((line) => line.includes("Extensions")));

  const narrow = internals.status.render(12);
  assert.ok(narrow.length <= 4);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 12));
  view.stop();
});

test("Timeline line ranges start at zero and stay aligned through navigation and folds", () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal, startupNotices: ["boot notice"] });
  const branch = [userEntry("range-a", "A"), userEntry("range-b", "B")];
  view.apply(viewProjection({ branch }));
  const internals = view as unknown as {
    blockLineRanges: Map<string, { start: number; end: number }>;
    setSelectedFold(mode: "compact" | "preview" | "full"): void;
    ensureSelectedBlockVisible(): void;
  };
  assert.deepEqual(internals.blockLineRanges.get("range-a"), { start: 1, end: 1 });
  assert.deepEqual(internals.blockLineRanges.get("range-b"), { start: 3, end: 3 });

  view.start();
  terminal.emit("\u001bh");
  terminal.emit("k");
  assert.equal(view.getInteractionState().selectedBlockId, "range-a");
  internals.setSelectedFold("full");
  assert.deepEqual(internals.blockLineRanges.get("range-a"), { start: 1, end: 2 });
  assert.deepEqual(internals.blockLineRanges.get("range-b"), { start: 4, end: 4 });
  internals.ensureSelectedBlockVisible();
  terminal.emit("j");
  assert.equal(view.getInteractionState().selectedBlockId, "range-b");
  assert.deepEqual(internals.blockLineRanges.get("range-b"), { start: 4, end: 4 });
  view.stop();
});

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

test("bounded Timeline messages retain Full inspection and width-aware line ranges", () => {
  const terminal = new FakeTerminal();
  const prompt = "实现🧑‍💻中文内容".repeat(180);
  const answer = "回答👩🏽‍🚀中文 text\n".repeat(180);
  let projection = viewProjection({ branch: [userEntry("long-prompt", prompt)] });
  assert.equal(projection.timeline[0]?.defaultDisplayMode, "compact");
  projection = appendUserDelivery(projection, { id: "steer-long", text: prompt, delivery: "steer" });
  for (const delivery of ["prompt", "followUp"] as const) {
    projection = appendUserDelivery(projection, { id: delivery, text: prompt, delivery });
  }
  for (const block of projection.timeline) {
    assert.equal(block.defaultDisplayMode, "compact");
    assert.equal(formatBlock(block, "full").includes(prompt), true);
  }
  projection = reduceProjectionEvent(projection, event({
    type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "short" }] },
  }));
  const view = new PindieTuiView({ terminal });
  const internals = view as unknown as {
    timelineContent: { children: { render(width: number): string[] }[]; render(width: number): string[] };
    blockLineRanges: Map<string, { start: number; end: number }>;
    timelineScroll: { scrollToStart(): void; scrollTop: number;
      updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void };
  };
  const check = (width: number) => {
    terminal.columns = width;
    view.apply(projection);
    for (const [index, block] of projection.timeline.entries()) {
      const lines = internals.timelineContent.children[index * 2]!.render(width);
      assert.ok(lines.length <= (block.type === "message" && block.role === "user" ? 1 : 4));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(Array.from(new Intl.Segmenter().segment(lines.join(""))).length <= 320);
      if (block.type === "message" && block.role === "user") {
        assert.match(lines[0]!, /user/);
        assert.ok(lines[0]!.includes("…"));
        if (block.delivery) assert.ok(lines[0]!.includes(block.delivery));
      }
    }
    internals.timelineContent.render(width);
    for (const [index, block] of projection.timeline.entries()) {
      const range = internals.blockLineRanges.get(block.id)!;
      assert.equal(range.end - range.start + 1, internals.timelineContent.children[index * 2]!.render(width).length);
    }
  };
  projection = reduceProjectionEvent(projection, event({
    type: "message_update", message: { role: "assistant", content: [{ type: "text", text: answer }] },
  }));
  check(80);
  check(18);
  const assistant = projection.timeline.at(-1)!;
  assert.equal(assistant.defaultDisplayMode, "preview");
  assert.ok(formatBlock(assistant, "full").includes(answer.trim()));
  projection = reduceProjectionEvent(projection, event({
    type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] },
  }));
  assert.equal(projection.timeline.at(-1)?.defaultDisplayMode, "preview");
  view.apply(projection);
  view.start();
  terminal.emit("\u001bh");
  for (const width of [80, 18]) {
    terminal.columns = width;
    const height = internals.timelineContent.render(width).length;
    internals.timelineScroll.scrollToStart();
    internals.timelineScroll.updateLayout(height, 3, () => undefined);
    const selectedRange = internals.blockLineRanges.get(projection.timeline.at(-1)!.id)!;
    assert.ok(internals.timelineScroll.scrollTop <= selectedRange.end);
    assert.ok(internals.timelineScroll.scrollTop + 3 > selectedRange.start);
    if (selectedRange.end - selectedRange.start + 1 <= 3) {
      assert.ok(internals.timelineScroll.scrollTop + 3 > selectedRange.end);
    }
  }
  view.stop();
});

test("assistant errors and long command labels stay bounded without losing Full text", () => {
  const terminal = new FakeTerminal();
  let projection = viewProjection();
  const diagnostic = "诊断🧑‍💻\n".repeat(500);
  projection = reduceProjectionEvent(projection, event({
    type: "message_end", message: { role: "assistant", stopReason: "error",
      content: [{ type: "text", text: diagnostic }] },
  }));
  assert.equal(projection.timeline[0]?.defaultDisplayMode, "preview");
  const view = new PindieTuiView({ terminal });
  view.apply(projection);
  let content = (view as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  assert.ok(content.children[0]!.render(12).length <= 4);
  assert.ok(formatBlock(projection.timeline[0]!, "full").includes(diagnostic.trim()));
  projection = reduceProjectionEvent(projection, event({
    type: "tool_execution_start", toolCallId: "long-command", toolName: "bash",
    args: { command: "echo " + "long ".repeat(300) },
  }));
  view.apply(projection);
  content = (view as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  const lines = content.children[2]!.render(12);
  assert.ok(lines.length <= 4);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
  assert.match(lines.join(""), /…/);
  view.stop();
});

test("live assistant explicit Full and Compact survive streaming updates", () => {
  const terminal = new FakeTerminal();
  let projection = viewProjection();
  const assistantMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
  projection = reduceProjectionEvent(projection, event({ type: "message_start", message: assistantMessage("first") }));
  const view = new PindieTuiView({ terminal });
  view.apply(projection);
  view.start();
  terminal.emit("\u001bh");
  terminal.emit("l");
  const id = projection.timeline[0]!.id;
  projection = reduceProjectionEvent(projection, event({ type: "message_update", message: assistantMessage("long ".repeat(1000)) }));
  view.apply(projection);
  assert.equal(view.getInteractionState().foldOverrides.get(id), "full");
  let content = (view as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  assert.ok(content.children[0]!.render(30).length > 4);
  terminal.emit("h");
  projection = reduceProjectionEvent(projection, event({ type: "message_end", message: assistantMessage("end ".repeat(1000)) }));
  view.apply(projection);
  assert.equal(view.getInteractionState().foldOverrides.get(id), "compact");
  content = (view as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  assert.ok(content.children[0]!.render(30).length <= 2);
  view.stop();
});

test("observation burst normal preview aggregates all items and Full retains every detail", () => {
  const items: UiObservationWorkBlock["items"] = Array.from({ length: 120 }, (_, index) => ({
    toolCallId: `read-${index}`, toolName: "read", input: null,
    label: `Reading file-${index}`, lifecycle: index === 119 ? "running" : "complete",
    result: index === 119 ? null : { isError: false, summary: `detail-${index}`, details: null },
  }));
  const block: UiObservationWorkBlock = {
    type: "work", kind: "observation", id: "observe:read-0", lifecycle: "running",
    title: "Inspecting project", items, defaultDisplayMode: "preview",
  };
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply({ ...viewProjection(), timeline: [block] });
  const content = (view as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  const lines = content.children[0]!.render(80);
  assert.ok(lines.length <= 4);
  assert.match(lines.join("\n"), /Read 120 files/);
  assert.match(lines.join("\n"), /Reading file-119/);
  assert.doesNotMatch(lines.join("\n"), /Reading file-0/);
  assert.match(formatBlock(block, "full"), /detail-0/);
  assert.match(formatBlock(block, "full"), /Reading file-119/);
  view.start();
  terminal.emit("\u001bh");
  terminal.emit("l");
  view.apply({ ...viewProjection(), timeline: [{ ...block, items: [...items, {
    toolCallId: "read-120", toolName: "read", input: null, label: "Reading file-120",
    lifecycle: "running", result: null,
  }] }] });
  assert.equal(view.getInteractionState().foldOverrides.get(block.id), "full");
  const complete = { ...block, lifecycle: "complete" as const, defaultDisplayMode: "compact" as const };
  assert.doesNotMatch(formatBlock(complete), /Reading file-119/);
  const failed = { ...block, lifecycle: "failed" as const, defaultDisplayMode: "preview" as const,
    items: [...items.slice(0, -1), { ...items[119]!, lifecycle: "failed" as const,
      result: { isError: true, summary: "failure detail ".repeat(100), details: null } }],
  };
  view.stop();
  const failureView = new PindieTuiView({ terminal: new FakeTerminal() });
  failureView.apply({ ...viewProjection(), timeline: [failed] });
  const failureContent = (failureView as unknown as { timelineContent: { children: { render(width: number): string[] }[] } }).timelineContent;
  assert.ok(failureContent.children[0]!.render(18).length <= 4);
  assert.match(formatBlock(failed, "full"), /failure detail/);
  failureView.stop();
});

test("bounded preview respects grapheme boundaries, display width and row limit", () => {
  for (const width of [8, 18, 80]) {
    const text = "中文👩🏽‍🚀🧑‍💻\n".repeat(500);
    const lines = boundedGraphemeText(text, width, 320, 4);
    assert.ok(lines.length <= 4);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(Array.from(new Intl.Segmenter().segment(lines.join("\n"))).length <= 320);
    assert.match(lines.at(-1)!, /…$/);
    assert.ok(!lines.join("").includes("�"));
  }
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

test("settled-blocked renders softly without stealing or clearing the Composer", async () => {
  const terminal = new FakeTerminal();
  const submissions: string[] = [];
  const view = new PindieTuiView({ terminal, onSubmit: (text) => submissions.push(text) });
  const projection = {
    ...viewProjection({ sessionId: "soft-blocked" }),
    softSignal: {
      kind: "settled-blocked" as const,
      summary: "Could not continue autonomously.",
      blockers: ["missing credential"],
    },
  };
  view.apply(projection);
  view.start();
  view.setEditorText("here is the missing credential");
  view.apply({ ...projection, status: { ...projection.status } });
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /Blocked/);
  assert.match(terminal.writes.join(""), /missing credential/);
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(view.getEditorText(), "here is the missing credential");
  terminal.emit("\r");
  assert.deepEqual(submissions, ["here is the missing credential"]);
  assert.equal(view.getInteractionState().activeOverlay, null);
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
  assert.match(terminal.writes.join(""), /Attention/);
  assert.match(terminal.writes.join(""), /state lease unavailable/);
  view.stop();
});

test("authority-unavailable Attention preempts the Command Palette", async () => {
  const terminal = new FakeTerminal();
  const effects = { aborts: 0, submissions: 0, attentionResponses: 0 };
  const view = new PindieTuiView({
    terminal,
    onAbort: () => { effects.aborts += 1; },
    onSubmit: () => { effects.submissions += 1; },
    onAttentionResponse: () => { effects.attentionResponses += 1; },
  });
  const base = viewProjection({ sessionId: "authority-preempts-palette" });
  view.apply(base);
  view.start();
  terminal.emit("\u001bp");
  assert.equal(view.getInteractionState().activeOverlay, "command-palette");

  view.apply(withAttention(base, {
    kind: "authority-unavailable",
    reason: "state lease unavailable",
  }));
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "attention");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /state lease unavailable/);
  assert.deepEqual(effects, { aborts: 0, submissions: 0, attentionResponses: 0 });
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

test("Extension UI dialogs use overlays and preserve the Composer", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ sessionId: "extension-dialogs" }));
  view.start();
  view.setEditorText("composer draft");
  const ui = new PindieExtensionUIBridge(view);

  const selected = ui.select("Choose model", ["A", "B"]);
  assert.equal(view.getInteractionState().activeOverlay, "extension-dialog");
  terminal.emit("j");
  terminal.emit("\r");
  assert.equal(await selected, "B");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getEditorText(), "composer draft");

  const cancelled = ui.select("Cancel", ["A"]);
  terminal.emit("\u001b");
  assert.equal(await cancelled, undefined);

  const yes = ui.confirm("Permission", "Run command?");
  terminal.emit("\r");
  assert.equal(await yes, true);
  const no = ui.confirm("Permission", "Run command?");
  terminal.emit("j");
  terminal.emit("\r");
  assert.equal(await no, false);
  const escaped = ui.confirm("Permission", "Run command?");
  terminal.emit("\u001b");
  assert.equal(await escaped, false);

  const input = ui.input("Name", "placeholder");
  terminal.emit("中文 value");
  terminal.emit("\r");
  assert.equal(await input, "中文 value");
  const inputCancelled = ui.input("Name");
  terminal.emit("ignored");
  terminal.emit("\u001b");
  assert.equal(await inputCancelled, undefined);

  const editor = ui.editor("Details", "first");
  terminal.emit("\u001b\r");
  terminal.emit("second");
  terminal.emit("\r");
  assert.equal(await editor, "first\nsecond");
  const editorCancelled = ui.editor("Details", "keep");
  terminal.emit("\u001b");
  assert.equal(await editorCancelled, undefined);
  assert.equal(view.getEditorText(), "composer draft");

  ui.invalidate();
  view.stop();
});

test("Extension dialog remains above a Human Gate that appears underneath it", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const base = viewProjection({ sessionId: "extension-before-gate" });
  view.apply(base);
  view.start();
  const ui = new PindieExtensionUIBridge(view);

  let resolved = false;
  const selected = ui.select("Extension choice", ["A", "B"]);
  void selected.then(() => { resolved = true; });
  assert.equal(view.getInteractionState().activeOverlay, "extension-dialog");

  const gated = withAttention(base, {
    kind: "human-gate",
    gateKind: "decision",
    question: "Gate remains unresolved?",
    options: ["Yes", "No"],
  });
  view.apply(gated);
  await flush();
  assert.equal(view.getInteractionState().activeOverlay, "extension-dialog");
  assert.equal(resolved, false);
  assert.equal(gated.attention?.kind, "human-gate");

  terminal.emit("j");
  terminal.emit("\r");
  assert.equal(await selected, "B");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(gated.attention?.kind, "human-gate");

  ui.invalidate();
  view.stop();
});

test("Extension dialog preempts the Command Palette and returns the human answer", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ sessionId: "palette-before-extension" }));
  view.start();
  view.setEditorText("composer draft");
  terminal.emit("\u001bp");
  assert.equal(view.getInteractionState().activeOverlay, "command-palette");

  const ui = new PindieExtensionUIBridge(view);
  const selected = ui.select("Extension choice", ["A", "B"]);
  assert.equal(view.getInteractionState().activeOverlay, "extension-dialog");
  terminal.emit("j");
  terminal.emit("\r");
  assert.equal(await selected, "B");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(view.getEditorText(), "composer draft");

  ui.invalidate();
  view.stop();
});

test("Extension dialog abort, timeout, serialization, and epoch invalidation are bounded", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ sessionId: "extension-lifecycle" }));
  view.start();
  const ui = new PindieExtensionUIBridge(view);

  const already = new AbortController();
  already.abort();
  assert.equal(await ui.select("Never", ["A"], { signal: already.signal }), undefined);
  assert.equal(view.getInteractionState().activeOverlay, null);

  const activeAbort = new AbortController();
  const aborted = ui.input("Abort", undefined, { signal: activeAbort.signal });
  assert.equal(view.getInteractionState().activeOverlay, "extension-dialog");
  activeAbort.abort();
  assert.equal(await aborted, undefined);
  assert.equal(view.getInteractionState().activeOverlay, null);

  const timedOut = ui.select("Timeout", ["A"], { timeout: 5 });
  assert.equal(await timedOut, undefined);
  assert.equal(view.getInteractionState().activeOverlay, null);

  const first = ui.select("First", ["A"]);
  const second = ui.confirm("Second", "Later");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /First/);
  terminal.writes.length = 0;
  terminal.emit("\r");
  assert.equal(await first, "A");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /Second/);

  ui.invalidate();
  assert.equal(await second, false);
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(await ui.input("Stale"), undefined);
  assert.equal(view.getInteractionState().activeOverlay, null);
  view.stop();
});

test("Extension terminal input, Composer access, status, notify, and deferred failures are truthful", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const projection = viewProjection({ sessionId: "extension-surface", running: true });
  view.apply(projection);
  view.start();
  const ui = new PindieExtensionUIBridge(view);
  const observed: string[] = [];
  const unsubscribe = ui.onTerminalInput((data) => {
    observed.push(data);
    return data === "x" ? { consume: true } : data === "q" ? { data: "Q" } : undefined;
  });
  terminal.emit("x");
  assert.equal(view.getEditorText(), "");
  terminal.emit("q");
  assert.equal(view.getEditorText(), "Q");
  assert.deepEqual(observed, ["x", "q"]);
  unsubscribe();
  terminal.emit("z");
  assert.equal(view.getEditorText(), "Qz");

  ui.setEditorText("draft");
  ui.pasteToEditor(" + pasted");
  assert.equal(ui.getEditorText(), "draft + pasted");
  ui.setStatus("a", "foo");
  ui.setStatus("b", "bar");
  ui.setStatus("a", undefined);
  ui.setWorkingMessage("Indexing project");
  ui.setWorkingVisible(true);
  ui.setWorkingIndicator({ frames: ["◆"] });
  ui.setHiddenThinkingLabel("Reasoning hidden");
  ui.notify("careful", "warning");
  await waitForTuiRender();
  const rendered = terminal.writes.join("");
  assert.match(rendered, /Extensions · bar/);
  assert.match(rendered, /◆ Indexing project/);
  assert.match(rendered, /Warning · careful/);
  assert.equal(projection.timeline.length, 0);
  ui.setWidget("x", ["bounded widget"]);
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /bounded widget/);
  assert.throws(() => ui.setWidget("factory", () => ({ render: () => [], invalidate: () => {} })), UnsupportedExtensionUICapabilityError);

  ui.invalidate();
  terminal.emit("x");
  assert.equal(view.getEditorText(), "draft + pastedx");
  view.stop();
});

test("Extension string widgets are ordered, bounded, removable, and Session-scoped", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const projection = viewProjection({ sessionId: "widget-a" });
  view.apply(projection);
  view.start();
  const ui = new PindieExtensionUIBridge(view);
  ui.setWidget("above", Array.from({ length: 20 }, (_, index) => `above-${index}`));
  ui.setWidget("below", ["below-editor"], { placement: "belowEditor" });
  await waitForTuiRender();
  const rendered = terminal.writes.join("");
  assert.match(rendered, /above-0/);
  assert.doesNotMatch(rendered, /above-10/);
  assert.match(rendered, /below-editor/);
  assert.equal(projection.timeline.length, 0);

  terminal.writes.length = 0;
  ui.setWidget("above", ["replacement"]);
  ui.setWidget("below", undefined);
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /replacement/);
  assert.doesNotMatch(terminal.writes.join(""), /below-editor/);
  ui.invalidate();
  terminal.writes.length = 0;
  view.apply(viewProjection({ sessionId: "widget-b" }));
  await waitForTuiRender();
  assert.doesNotMatch(terminal.writes.join(""), /replacement/);
  view.stop();
});

test("tools-expanded affects only WorkBlocks and explicit fold overrides win", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const projection = commandViewProjection("tools-expanded", "full tool output");
  view.apply(projection);
  view.start();
  const ui = new PindieExtensionUIBridge(view);
  assert.equal(ui.getToolsExpanded(), false);
  ui.setToolsExpanded(true);
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /full tool output/);
  assert.equal(projection.timeline[0]?.defaultDisplayMode, "compact");
  terminal.emit("\u001bh");
  terminal.emit("h");
  terminal.writes.length = 0;
  view.apply(projection);
  await waitForTuiRender();
  assert.doesNotMatch(terminal.writes.join(""), /full tool output/);
  ui.invalidate();
  assert.equal(new PindieExtensionUIBridge(view).getToolsExpanded(), false);
  view.stop();
});

test("Extension autocomplete wrappers accept through the public base and reset with the Session", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal, cwd: process.cwd() });
  view.apply(viewProjection());
  view.start();
  const ui = new PindieExtensionUIBridge(view);
  ui.addAutocompleteProvider((current) => ({
    triggerCharacters: ["#"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const prefix = lines[cursorLine]?.slice(0, cursorCol).match(/#[0-9]*$/u)?.[0];
      if (prefix !== undefined) {
        return { items: [{ value: "#123", label: "#123" }], prefix };
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
  }));

  view.setEditorText("fix ");
  terminal.emit("#");
  await waitForTuiRender();
  terminal.emit("1");
  terminal.emit("2");
  await waitForTuiRender();
  terminal.emit("\r");
  assert.equal(view.getEditorText(), "fix #123");

  for (const invoke of [
    () => ui.setHeader(() => ({ render: () => [], invalidate: () => {} })),
    () => ui.setFooter(() => ({ render: () => [], invalidate: () => {} })),
    () => ui.getAllThemes(),
    () => ui.getEditorComponent(),
  ]) assert.throws(invoke, UnsupportedExtensionUICapabilityError);

  ui.invalidate();
  view.setEditorText("fix ");
  terminal.writes.length = 0;
  for (const character of "#12") terminal.emit(character);
  await flush();
  assert.equal(view.getEditorText(), "fix #12");
  assert.doesNotMatch(terminal.writes.join(""), /#123/);

  view.stop();
});

test("model and Session pickers search, preserve drafts, and delegate selections", async () => {
  const terminal = new FakeTerminal();
  const modelSelections: string[] = [];
  const sessionSelections: string[] = [];
  const now = new Date("2026-09-22T00:00:00.000Z");
  const view = new PindieTuiView({
    terminal,
    onRequestModelPicker: async () => [
      { provider: "OpenAI", modelId: "gpt-current", displayName: "Current", current: true },
      { provider: "OpenAI", modelId: "gpt-sol", displayName: "Sol", current: false },
    ],
    onSelectModel: (sessionId, choice) => modelSelections.push(`${sessionId}:${choice.modelId}`),
    onRequestSessionPicker: async () => [
      { path: "/a", id: "picker-session", created: now, modified: now, messageCount: 2, firstMessage: "Current", current: true },
      { path: "/b", id: "older", name: "Other work", created: now, modified: new Date(now.getTime() - 1), messageCount: 4, firstMessage: "Other", current: false },
    ],
    onSelectSession: (sessionId, choice) => sessionSelections.push(`${sessionId}:${choice.path}`),
  });
  view.apply(viewProjection({ sessionId: "picker-session" }));
  view.start();
  view.setEditorText("draft survives");
  terminal.emit("\u001bm");
  await flush();
  assert.equal(view.getInteractionState().activeOverlay, "model-picker");
  terminal.emit("s"); terminal.emit("o"); terminal.emit("l");
  await waitForTuiRender();
  assert.match(terminal.writes.join(""), /OpenAI · Sol/);
  terminal.emit("\r");
  assert.deepEqual(modelSelections, ["picker-session:gpt-sol"]);
  assert.equal(view.getEditorText(), "draft survives");

  terminal.emit("\u001bn");
  await flush();
  assert.equal(view.getInteractionState().activeOverlay, "session-picker");
  terminal.emit("o"); terminal.emit("t"); terminal.emit("h");
  terminal.emit("\r");
  assert.deepEqual(sessionSelections, ["picker-session:/b"]);
  terminal.emit("\u001bm");
  await flush();
  terminal.emit("\u001b");
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getEditorText(), "draft survives");
  view.stop();
});

test("async Session picker does not open after the same Session becomes running", async () => {
  const terminal = new FakeTerminal();
  const selections: string[] = [];
  let resolveChoices!: (choices: readonly import("../src/pi-runtime.ts").ActiveProjectSessionChoice[]) => void;
  const pendingChoices = new Promise<readonly import("../src/pi-runtime.ts").ActiveProjectSessionChoice[]>((resolve) => {
    resolveChoices = resolve;
  });
  const view = new PindieTuiView({
    terminal,
    onRequestSessionPicker: () => pendingChoices,
    onSelectSession: (_sessionId, choice) => selections.push(choice.path),
  });
  view.apply(viewProjection({ sessionId: "picker-race" }));
  view.start();
  view.setEditorText("draft survives");

  assert.equal(view.hasPendingInteraction(), false);
  terminal.emit("\u001bn");
  await flush();
  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.hasPendingInteraction(), true); // Picker choices have not resolved yet.
  view.apply(viewProjection({ sessionId: "picker-race", running: true }));
  resolveChoices([{
    path: "/other",
    id: "other",
    created: new Date("2026-09-22T00:00:00.000Z"),
    modified: new Date("2026-09-22T00:00:00.000Z"),
    messageCount: 1,
    firstMessage: "Other",
    current: false,
  }]);
  await flush();

  assert.equal(view.getInteractionState().activeOverlay, null);
  assert.equal(view.getInteractionState().focusMode, "composer");
  assert.equal(view.getEditorText(), "draft survives");
  assert.deepEqual(selections, []);
  view.stop();
});

test("Extension title returns to the Pindie baseline across Session bridges", () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  view.apply(viewProjection({ sessionId: "title-session-a" }));
  view.start();

  const sessionA = new PindieExtensionUIBridge(view);
  sessionA.setTitle("A custom title");
  assert.equal(terminal.titles.at(-1), "A custom title");
  sessionA.invalidate();
  assert.equal(terminal.titles.at(-1), "Pindie");

  view.apply(viewProjection({ sessionId: "title-session-b" }));
  const sessionB = new PindieExtensionUIBridge(view);
  assert.notEqual(terminal.titles.at(-1), "A custom title");
  sessionB.invalidate();
  view.stop();
});

test("Extension overlay outranks semantic Attention without resolving the Human Gate", async () => {
  const terminal = new FakeTerminal();
  const view = new PindieTuiView({ terminal });
  const gated = withAttention(viewProjection({ sessionId: "extension-over-gate" }), {
    kind: "human-gate",
    gateKind: "decision",
    question: "Keep gate open?",
    options: ["Yes", "No"],
  });
  view.apply(gated);
  view.start();
  view.setEditorText("hidden composer draft");
  const ui = new PindieExtensionUIBridge(view);
  const dialog = ui.select("Extension choice", ["A", "B"]);
  terminal.emit("\u001b");
  assert.equal(await dialog, undefined);
  assert.equal(view.getInteractionState().focusMode, "attention");
  assert.equal(view.getEditorText(), "hidden composer draft");
  assert.equal(gated.attention?.kind, "human-gate");
  ui.invalidate();
  view.stop();
});

test("owned mode runs an extension choice through the generic ExtensionUIContext bridge", async () => {
  const runtime = new FakeRuntime();
  const terminal = new FakeTerminal();
  const presentationLease = { current: () => null };
  const mode = new PindieInteractiveMode(runtime.adapter(), {
    presentation: presentationLease,
    terminal,
    createView: (options) => new PindieTuiView(options),
    scheduleRefresh: () => ({} as ReturnType<typeof setInterval>),
    clearRefresh: () => undefined,
  });
  const running = mode.run();
  await flush();

  const binding = runtime.bindings[0] as { mode: string; uiContext: ExtensionUIContext };
  assert.equal(binding.mode, "tui");
  assert.ok(binding.uiContext instanceof PindieExtensionUIBridge);

  const choice = binding.uiContext.select("Extension choice", ["First", "Second"]);
  await waitForTuiRender();
  const selector = terminal.writes.join("");
  assert.match(selector, /Extension choice/);
  assert.match(selector, /First/);
  assert.match(selector, /Second/);
  terminal.emit("\r");
  assert.equal(await choice, "First");

  terminal.emit("\u0004");
  await running;
});

test("picker controller mutations are current-epoch idle-only and current choices are no-ops", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();
  const currentModel = { provider: "openai", modelId: "current", displayName: "Current", current: true };
  const nextModel = { provider: "openai", modelId: "next", displayName: "Next", current: false };
  const currentSession = { path: "/a", id: "session-a", created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "A", current: true };
  const nextSession = { ...currentSession, path: "/b", id: "session-b", current: false };

  harness.view.options.onSelectModel?.("session-a", currentModel);
  harness.view.options.onSelectSession?.("session-a", currentSession);
  assert.deepEqual(harness.runtime.modelChanges, []);
  assert.deepEqual(harness.runtime.sessionSwitches, []);

  harness.view.options.onSelectModel?.("session-a", nextModel);
  await flush();
  assert.deepEqual(harness.runtime.modelChanges, [{ provider: "openai", modelId: "next", sessionId: "session-a" }]);

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: false, isStreaming: true };
  harness.view.options.onSelectSession?.("session-a", nextSession);
  assert.deepEqual(harness.runtime.sessionSwitches, []);
  assert.match(harness.view.notices.at(-1) ?? "", /no longer safely idle/);

  harness.runtime.facts = { ...harness.runtime.facts, isIdle: true, isStreaming: false };
  harness.runtime.lifecycle?.beforeSessionInvalidate?.();
  harness.runtime.replaceSession("session-b");
  await harness.runtime.lifecycle!.rebindSession!();
  harness.view.options.onSelectModel?.("session-a", nextModel);
  harness.view.options.onSelectSession?.("session-a", nextSession);
  await flush();
  assert.equal(harness.runtime.modelChanges.length, 1);
  assert.deepEqual(harness.runtime.sessionSwitches, []);

  harness.view.exit();
  await running;
});

test("owned mode binds all ExtensionCommandContextActions to the runtime adapter", async () => {
  const harness = createHarness();
  const running = harness.mode.run();
  await flush();
  const actions = (harness.runtime.bindings[0] as any).commandContextActions;
  await actions.waitForIdle();
  await actions.newSession();
  await actions.fork("entry");
  await actions.navigateTree("entry");
  await actions.switchSession("session.jsonl");
  await actions.reload();
  assert.deepEqual(harness.runtime.commandCalls, [
    "waitForIdle", "newSession", "fork", "navigateTree", "switchSession", "reload",
  ]);
  assert.equal(harness.runtime.bindings.length, 1, "actions do not manually rebind");
  harness.view.exit();
  await running;
});
