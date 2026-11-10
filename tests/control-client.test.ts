import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  PindieControlClient,
  PindieControlError,
} from "../src/control-client.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { QuotaResumeSupervisor } from "../src/quota-resume-supervisor.ts";
import { isQuotaResumeWaiting } from "../src/quota-resume-control.ts";
import {
  PresentationIntegration,
  type PindiePresentationSnapshot,
} from "../src/presentation-integration.ts";
import { RunCostTracker } from "../src/run-cost.ts";
import { RunTimer } from "../src/run-timer.ts";
import { SubscriptionUsageMonitor } from "../src/subscription-usage.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";
import { deriveSemanticSnapshot, type SemanticRunFacts } from "../src/semantics.ts";
import type { HumanGate, PindieState } from "../src/state.ts";

interface FakeSessionControl {
  readonly session: AgentSession;
  readonly prompts: string[];
  readonly steers: string[];
  readonly followUps: string[];
  readonly nameWrites: string[];
  readonly queue: {
    steering: string[];
    followUp: string[];
  };
  readonly abortCalls: () => number;
  readonly branchReads: () => number;
  /** Simulates Pi persisting an assistant entry on message_end. */
  persistAssistant(entryId: string, message: Record<string, unknown>): void;
  start(): void;
  settle(): void;
  /** Pi is non-idle but not streaming: compaction, not an Agent Run. */
  compacting(): void;
  emit(event: AgentSessionEvent): void;
}

function fakeSession(
  sessionId: string,
  entries: readonly SessionEntry[],
  options: { unnamed?: boolean } = {},
): FakeSessionControl {
  let idle = true;
  let streaming = false;
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let abortCalls = 0;
  let branchReadCount = 0;
  let thinkingLevel: AgentSession["thinkingLevel"] = "medium";
  let model: { provider: string; id: string; name?: string } = {
    provider: "openai-codex",
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
  };
  const availableModels = [
    model,
    { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
  ];
  let sessionName: string | undefined = options.unnamed ? undefined : "Pindie Control";
  const nameWrites: string[] = [];
  const prompts: string[] = [];
  const steers: string[] = [];
  const followUps: string[] = [];
  const queue = {
    steering: [] as string[],
    followUp: [] as string[],
  };

  const session = {
    sessionId,
    get model() {
      return model;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    get isStreaming() {
      return streaming;
    },
    isCompacting: false,
    get isIdle() {
      return idle;
    },
    get pendingMessageCount() {
      return queue.steering.length + queue.followUp.length;
    },
    extensionRunner: {
      getModelRegistry: () => ({
        find: (provider: string, id: string) =>
          availableModels.find((candidate) =>
            candidate.provider === provider && candidate.id === id),
        getAvailable: () => [...availableModels],
      }),
    },
    sessionManager: {
      getSessionName: () => sessionName,
      getHeader: () => ({ type: "session", id: sessionId }),
      getEntries: () => [...entries],
      getBranch: () => { branchReadCount += 1; return [...entries]; },
    },
    setSessionName: (name: string) => { nameWrites.push(name); sessionName = name; },
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    prompt: async (text: string, options?: { preflightResult?: (disposition: "started" | "queued" | "handled") => void }) => {
      prompts.push(text);
      options?.preflightResult?.("started");
    },
    steer: async (text: string) => {
      steers.push(text);
      queue.steering.push(text);
    },
    followUp: async (text: string) => {
      followUps.push(text);
      queue.followUp.push(text);
    },
    abort: async () => {
      abortCalls += 1;
      idle = true;
      streaming = false;
      listener?.({ type: "agent_settled" } as AgentSessionEvent);
    },
    clearQueue: () => {
      const cleared = {
        steering: [...queue.steering],
        followUp: [...queue.followUp],
      };
      queue.steering.length = 0;
      queue.followUp.length = 0;
      return cleared;
    },
    bindExtensions: async () => undefined,
    waitForIdle: async () => undefined,
    setModel: async (next: typeof model) => {
      model = next;
    },
    setThinkingLevel: (level: AgentSession["thinkingLevel"]) => {
      thinkingLevel = level;
    },
  } as unknown as AgentSession;

  return {
    session,
    prompts,
    steers,
    followUps,
    nameWrites,
    queue,
    abortCalls: () => abortCalls,
    branchReads: () => branchReadCount,
    persistAssistant: (entryId, message) => {
      (entries as SessionEntry[]).push({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: new Date().toISOString(),
        message,
      } as unknown as SessionEntry);
    },
    start: () => {
      idle = false;
      streaming = true;
      listener?.({ type: "agent_start" } as AgentSessionEvent);
    },
    settle: () => {
      idle = true;
      streaming = false;
      listener?.({ type: "agent_settled" } as AgentSessionEvent);
    },
    compacting: () => {
      idle = false;
      streaming = false;
    },
    emit: (event) => listener?.(event),
  };
}

function fakeNativeRuntime(initial: FakeSessionControl) {
  let active = initial;
  let beforeInvalidate: (() => void) | undefined;
  let rebind: (() => Promise<void>) | undefined;
  let nextFreshSession: FakeSessionControl | undefined;
  let nextSwitchSession: FakeSessionControl | undefined;
  let switchCancelled = false;
  let switchFailure: Error | undefined;
  const switchCalls: string[] = [];

  const replace = async (next: FakeSessionControl) => {
    beforeInvalidate?.();
    active = next;
    await rebind?.();
  };

  const runtime = {
    get session() {
      return active.session;
    },
    setBeforeSessionInvalidate: (callback?: () => void) => {
      beforeInvalidate = callback;
    },
    setRebindSession: (callback?: () => Promise<void>) => {
      rebind = callback;
    },
    newSession: async () => {
      if (nextFreshSession === undefined) return { cancelled: true };
      const next = nextFreshSession;
      nextFreshSession = undefined;
      await replace(next);
      return { cancelled: false };
    },
    switchSession: async (path: string) => {
      switchCalls.push(path);
      if (switchFailure) throw switchFailure;
      if (switchCancelled) return { cancelled: true };
      if (!nextSwitchSession) throw new Error("No fake Session for path");
      const next = nextSwitchSession;
      nextSwitchSession = undefined;
      await replace(next);
      return { cancelled: false };
    },
    dispose: async () => undefined,
  } as unknown as AgentSessionRuntime;

  return {
    runtime,
    replace,
    setNextFreshSession: (next: FakeSessionControl) => {
      nextFreshSession = next;
    },
    setNextSwitchSession: (next: FakeSessionControl) => { nextSwitchSession = next; },
    setSwitchCancelled: (value: boolean) => { switchCancelled = value; },
    setSwitchFailure: (error: Error | undefined) => { switchFailure = error; },
    switchCalls,
  };
}

function setSessionChoices(
  runtime: PiRuntimeAdapter,
  choices: readonly { path: string; id: string; name?: string; created: Date; modified: Date; messageCount: number; firstMessage: string; current: boolean }[],
): void {
  runtime.getActiveProjectSessionChoices = async () => choices;
}

function sessionChoice(id: string, path: string, modified: string, overrides: object = {}) {
  return {
    id, path, created: new Date("2026-01-01T00:00:00.000Z"), modified: new Date(modified),
    messageCount: 3, firstMessage: `  first\n message   ${"👨‍👩‍👧‍👦".repeat(40)}`, current: false, ...overrides,
  };
}

function activeState(gate: HumanGate | null = null): PindieState {
  return {
    task: {
      goal: "Implement Pindie Control safely",
      constraints: ["Do not expose shell access"],
      successCriteria: [
        { id: "c1", description: "Control uses existing runtime truth" },
        { id: "c2", description: "Writes fail closed when stale" },
      ],
      openLoops: {
        blockers: [],
        questions: [],
        nextIntent: "Continue",
      },
      verification: {
        stale: false,
        checks: [{
          name: "architecture",
          status: "passed",
          covers: ["c1"],
          evidence: "reviewed",
        }],
      },
      humanGate: gate,
      completed: false,
    },
  };
}

function presentationFor(
  state: PindieState,
  options: {
    activity?: PindiePresentationSnapshot["status"]["activity"];
    quotaResumeWaiting?: PindiePresentationSnapshot["quotaResumeWaiting"];
    quotaResumeEvent?: PindiePresentationSnapshot["quotaResumeEvent"];
    reasoningMode?: PindiePresentationSnapshot["status"]["reasoningMode"];
  } = {},
): PindiePresentationSnapshot {
  const task = state.task;
  const facts: SemanticRunFacts = {
    stateAvailable: true,
    runCoherent: true,
    taskRelation: task === null ? "none" : "preexisting_untouched",
    completionRelation: task?.completed ? "completed_before_run" : "not_completed",
    gateRelation: task?.humanGate ? "existed_before_run" : "none",
  };
  const semantic = deriveSemanticSnapshot(state, facts);
  assert.equal(semantic.ok, true);

  const quotaResumeWaiting = options.quotaResumeWaiting ?? null;
  return {
    semantic,
    status: {
      consumption: null,
      reasoningMode: options.reasoningMode === undefined ? "manual" : options.reasoningMode,
      activity: options.activity ?? null,
      state,
      stateUnavailableReason: null,
      runStale: false,
      quotaResumeWaiting: quotaResumeWaiting !== null,
      subscriptionUsage: null,
    },
    quotaResumeWaiting,
    quotaResumeEvent: options.quotaResumeEvent ?? quotaResumeWaiting,
    projectRoot: "/repo/Pindie",
  };
}

/** Real Presentation with UI output disabled: the actual headless Control path. */
function createHeadlessPresentation(): PresentationIntegration {
  const state = activeState();
  const task = state.task;
  const semantic = deriveSemanticSnapshot(state, {
    stateAvailable: true,
    runCoherent: true,
    taskRelation: task === null ? "none" : "preexisting_untouched",
    completionRelation: task?.completed ? "completed_before_run" : "not_completed",
    gateRelation: task?.humanGate ? "existed_before_run" : "none",
  });
  assert.equal(semantic.ok, true);
  const pi = { getThinkingLevel: () => "medium", setThinkingLevel: () => undefined } as unknown as ExtensionAPI;
  return new PresentationIntegration(pi, {
    getSemanticSnapshot: () => semantic,
    getState: () => state,
    getProjectRoot: () => "/repo/Pindie",
    getAuthoritativeState: () => state,
    getStateUnavailableReason: () => null,
    getRunStale: () => false,
    subscriptionUsageMonitor: new SubscriptionUsageMonitor({ fetchUsage: async () => null }),
    runTimer: new RunTimer(),
    runCost: new RunCostTracker(),
    taskMetrics: new TaskMetricsTracker(),
    uiEnabled: false,
  });
}

function headlessContext(sessionId: string): ExtensionContext {
  return {
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
  } as unknown as ExtensionContext;
}

/** Waiting phase suppresses settlement gating as well as exposing the event. */
function quotaPresentation(
  state: PindieState,
  status: PindiePresentationSnapshot["quotaResumeEvent"],
): PindiePresentationSnapshot {
  const waiting = status === null || status === undefined || (status.phase ?? "waiting") === "waiting"
    ? status ?? null
    : null;
  return presentationFor(state, { quotaResumeWaiting: waiting, quotaResumeEvent: status ?? null });
}

function quotaStatus(
  sessionId: string,
  anchorEntryId: string,
  phase: "waiting" | "wake_started" | "cancelled" | "invalidated" | "wake_failed" = "waiting",
) {
  return { sessionId, resumeAt: 4321, anchorEntryId, phase };
}

/** Persist the terminal assistant error entry, then end the Run. */
function failRun(
  session: FakeSessionControl,
  entryId: string,
  errorMessage: string,
  options: { readonly aborted?: boolean } = {},
): void {
  emitAssistant(session, "", { stopReason: "error", errorMessage });
  session.persistAssistant(entryId, {
    role: "assistant",
    content: [],
    provider: "openai-codex",
    model: "gpt-6-sol",
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  });
  if (options.aborted === true) {
    session.emit({ type: "agent_settled", aborted: true } as AgentSessionEvent);
  } else {
    session.settle();
  }
}

function resumeMessage(anchorEntryId: string): AgentSessionEvent {
  return {
    type: "message_start",
    message: {
      role: "custom",
      customType: "pindie-quota-resume",
      content: [],
      display: false,
      details: { anchorEntryId },
    },
  } as unknown as AgentSessionEvent;
}

function branchEntries(): readonly SessionEntry[] {
  return [
    {
      type: "custom_message",
      id: "probe-hidden",
      parentId: null,
      timestamp: "2026-09-24T00:00:00.000Z",
      customType: "pindie-active-task-continuation",
      content: "private continuation probe sentinel",
      display: true,
    } as unknown as SessionEntry,
    {
      type: "custom_message",
      id: "hidden",
      parentId: null,
      timestamp: "2026-09-24T00:00:00.000Z",
      customType: "pindie-hidden-test",
      content: "secret runtime metadata",
      display: false,
    } as unknown as SessionEntry,
    {
      type: "message",
      id: "assistant",
      parentId: "hidden",
      timestamp: "2026-09-24T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "private reasoning" },
          { type: "text", text: "Visible result." },
        ],
        stopReason: "stop",
      },
    } as unknown as SessionEntry,
  ];
}

test("read-only Control client projects existing runtime and semantic truth", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  let presentation = presentationFor(activeState(), { activity: "reading" });
  let leaseSequence = 0;
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => `lease-${++leaseSequence}` },
  );

  await control.start();
  try {
    const initial = control.observe();

    assert.equal(initial.lease, "lease-1");
    assert.equal(initial.project.root, "/repo/Pindie");
    assert.equal(initial.session.id, "session-1");
    assert.equal(initial.session.displayIdentity, "Pindie Control");
    assert.deepEqual(initial.executionConfig.model, {
      provider: "openai-codex",
      modelId: "gpt-6-sol",
    });
    assert.equal(initial.executionConfig.thinkingLevel, "medium");
    assert.equal(initial.runtime.idle, true);
    assert.equal(initial.runtime.automaticWorkSettled, true);
    assert.equal(initial.runtime.activity, "reading");
    assert.equal(initial.semantic.authority, "coherent");
    assert.equal(initial.semantic.taskStatus, "active");
    assert.equal(initial.semantic.taskGoal, "Implement Pindie Control safely");
    assert.deepEqual(initial.semantic.blockers, []);
    assert.equal(initial.semantic.verificationStatus, "pending");
    assert.deepEqual(initial.semantic.verificationProgress, { covered: 1, total: 2 });
    assert.equal(initial.latestAssistant?.text, "Visible result.");
    assert.equal(initial.latestAssistant?.source, "assistant");
    assert.equal(initial.latestAssistant?.text.includes("private reasoning"), false);

    const beforeActivityOnly = initial.revision;
    presentation = presentationFor(activeState(), { activity: "editing" });
    const activityOnly = control.observe();
    assert.equal(activityOnly.runtime.activity, "editing");
    assert.equal(activityOnly.revision, beforeActivityOnly);

    const beforeStart = activityOnly.revision;
    session.start();
    const running = control.observe();
    assert.equal(running.runtime.idle, false);
    assert.equal(running.runtime.automaticWorkSettled, false);
    assert.ok(running.revision > beforeStart);

    const beforeSettle = running.revision;
    session.settle();
    const settled = control.observe();
    assert.equal(settled.runtime.idle, true);
    assert.equal(settled.runtime.automaticWorkSettled, true);
    assert.ok(settled.revision > beforeSettle);

    const beforeGate = settled.revision;
    presentation = presentationFor(activeState({
      kind: "approval",
      question: "Merge this architectural change?",
      options: ["Approve", "Reject"],
    }));
    const gated = control.observe();
    assert.equal(gated.semantic.taskStatus, "waiting_human");
    assert.equal(gated.semantic.humanGate?.question, "Merge this architectural change?");
    assert.match(gated.semantic.humanGate?.key ?? "", /^human-gate:/);
    assert.ok(gated.revision > beforeGate);
  } finally {
    control.dispose();
  }
});

test("Control projects terminal semantic completion without inventing an assistant message", async () => {
  const state = activeState();
  const completed: PindieState = {
    task: {
      ...state.task!,
      completed: true,
      openLoops: { blockers: [], questions: [], nextIntent: null },
      verification: {
        stale: false,
        checks: [{ name: "tests", status: "passed", covers: ["c1", "c2"], evidence: "tested" }],
      },
    },
  };
  const entries: SessionEntry[] = [];
  const session = fakeSession("terminal-session", entries);
  const control = new PindieControlClient(
    new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
    { current: () => ({ snapshot: () => presentationFor(completed) }) },
  );
  await control.start();
  try {
    const completionCall: SessionEntry = {
      type: "message", id: "completion-call", parentId: null, timestamp: "2026-09-24T00:00:01.000Z",
      message: {
        role: "assistant", content: [{ type: "toolCall", id: "complete", name: "pindie_task_complete",
          arguments: { summary: "Delivered the fix and opened the PR." } }], stopReason: "toolUse",
      },
    } as unknown as SessionEntry;
    entries.push(completionCall);
    session.emit({ type: "entry_appended", entry: completionCall } as AgentSessionEvent);
    const completionResult: SessionEntry = {
      type: "message", id: "completion-result", parentId: "completion-call", timestamp: "2026-09-24T00:00:02.000Z",
      message: {
        role: "toolResult", toolCallId: "complete", toolName: "pindie_task_complete",
        content: [{ type: "text", text: "Summary: WRONG RESULT PROSE" }],
        details: { state: completed }, isError: false,
      },
    } as unknown as SessionEntry;
    entries.push(completionResult);
    session.emit({ type: "entry_appended", entry: completionResult } as AgentSessionEvent);
    session.start();
    session.settle();
    const terminal = control.observe();
    assert.equal(terminal.semantic.taskStatus, "done");
    assert.equal(terminal.runtime.automaticWorkSettled, true);
    assert.deepEqual(terminal.latestAssistant, {
      entryId: "semantic:completion:complete",
      text: "Delivered the fix and opened the PR.",
      lifecycle: "complete",
      source: "task_completion",
    });
    assert.equal(entries.length, 2);

    const ordinaryReply: SessionEntry = {
      type: "message", id: "ordinary-reply", parentId: "completion-result", timestamp: "2026-09-24T00:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Here is the follow-up." }], stopReason: "stop" },
    } as unknown as SessionEntry;
    entries.push(ordinaryReply);
    session.emit({ type: "entry_appended", entry: ordinaryReply } as AgentSessionEvent);
    assert.deepEqual(control.observe().latestAssistant, {
      entryId: "ordinary-reply", text: "Here is the follow-up.", lifecycle: "complete", source: "assistant",
    });
  } finally {
    control.dispose();
  }
});

test("Control does not present a failed completion as a successful report", async () => {
  const entries: SessionEntry[] = [{
    type: "message", id: "failed-call", parentId: null, timestamp: "2026-09-24T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "pindie_task_complete",
      arguments: { summary: "Not delivered" } }], stopReason: "toolUse" },
  } as unknown as SessionEntry, {
    type: "message", id: "failed-result", parentId: "failed-call", timestamp: "2026-09-24T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: "failed", toolName: "pindie_task_complete",
      content: [{ type: "text", text: "Completion denied" }], isError: true },
  } as unknown as SessionEntry];
  const session = fakeSession("failed-session", entries);
  const control = new PindieControlClient(
    new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) },
  );
  await control.start();
  try {
    assert.equal(control.observe().latestAssistant, null);
    const errorReply: SessionEntry = {
      type: "message", id: "error-reply", parentId: "failed-result", timestamp: "2026-09-24T00:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Completion failed." }], stopReason: "error" },
    } as unknown as SessionEntry;
    entries.push(errorReply);
    session.emit({ type: "entry_appended", entry: errorReply } as AgentSessionEvent);
    assert.deepEqual(control.observe().latestAssistant, {
      entryId: "error-reply", text: "Completion failed.", lifecycle: "error", source: "assistant",
      errorMessage: "Assistant request failed (no diagnostic available).",
    });
  } finally {
    control.dispose();
  }
});

test("Control binding waits for extension bootstrap on initial and replacement Sessions", async () => {
  const first = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(first);
  let release!: () => void;
  let started!: () => void;
  let bindingStarted = new Promise<void>((resolve) => { started = resolve; });
  let bindingGate = new Promise<void>((resolve) => { release = resolve; });
  const bound: string[] = [];
  let sequence = 0;
  const control = new PindieControlClient(
    new PiRuntimeAdapter(native.runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) },
    {
      createLease: () => `lease-${++sequence}`,
      bindActiveSession: async () => {
        const sessionId = native.runtime.session.sessionId;
        started();
        await bindingGate;
        bound.push(sessionId);
      },
    },
  );
  try {
    const initial = control.start();
    await bindingStarted;
    assert.throws(() => control.observe(), /no active Session binding/);
    release();
    await initial;
    const oldLease = control.observe().lease;
    assert.deepEqual(bound, ["session-1"]);

    bindingStarted = new Promise<void>((resolve) => { started = resolve; });
    bindingGate = new Promise<void>((resolve) => { release = resolve; });
    const replacement = native.replace(fakeSession("session-2", branchEntries()));
    await bindingStarted;
    assert.throws(() => control.observe(), /no active Session binding/);
    release();
    await replacement;
    assert.deepEqual(bound, ["session-1", "session-2"]);
    assert.equal(control.observe().lease, "lease-2");
    await assert.rejects(control.input({ lease: oldLease, text: "stale" }),
      (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
  } finally {
    control.dispose();
  }
});

test("failed extension bootstrap never exposes a Control lease", async () => {
  const first = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(first);
  let fail = false;
  let sequence = 0;
  const control = new PindieControlClient(
    new PiRuntimeAdapter(native.runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) },
    {
      createLease: () => `lease-${++sequence}`,
      bindActiveSession: async () => { if (fail) throw new Error("session_start failed"); },
    },
  );
  await control.start();
  try {
    const oldLease = control.observe().lease;
    fail = true;
    await assert.rejects(native.replace(fakeSession("session-2", branchEntries())), /session_start failed/);
    assert.throws(() => control.observe(), /no active Session binding/);
    await assert.rejects(control.input({ lease: oldLease, text: "no write" }), /no active Session binding/);
    fail = false;
    await native.replace(fakeSession("session-3", branchEntries()));
    assert.equal(control.observe().session.id, "session-3");
  } finally {
    control.dispose();
  }

  const initial = new PindieControlClient(
    new PiRuntimeAdapter(fakeNativeRuntime(first).runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) },
    { bindActiveSession: async () => { throw new Error("initial session_start failed"); } },
  );
  await assert.rejects(initial.start(), /initial session_start failed/);
  assert.throws(() => initial.observe(), /no active Session binding/);
  initial.dispose();
});

test("Control lease is lifecycle-scoped rather than native Session-ID-scoped", async () => {
  const first = fakeSession("same-session-id", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  let leaseSequence = 0;
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => `lease-${++leaseSequence}` },
  );

  await control.start();
  try {
    const before = control.observe();
    const replacement = fakeSession("same-session-id", branchEntries());

    await native.replace(replacement);

    const after = control.observe();
    assert.equal(after.session.id, before.session.id);
    assert.equal(before.lease, "lease-1");
    assert.equal(after.lease, "lease-2");
    assert.ok(after.revision > before.revision);

    first.start();
    const afterStaleOldEvent = control.observe();
    assert.equal(afterStaleOldEvent.runtime.automaticWorkSettled, true);
    assert.equal(afterStaleOldEvent.revision, after.revision);
  } finally {
    control.dispose();
  }
});

test("Control client remains read-fail-closed while a Session binding is invalidated", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease" },
  );

  await control.start();
  control.dispose();

  assert.throws(() => control.observe(), /disposed/);
  await assert.rejects(control.start(), /disposed/);
});


test("Control rebind projection failure leaves no partially authorized binding", async () => {
  const first = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  let failProjection = false;
  let leaseSequence = 0;
  const control = new PindieControlClient(
    runtime,
    {
      current: () => ({
        snapshot: () => {
          if (failProjection) throw new Error("projection unavailable");
          return presentation;
        },
      }),
    },
    { createLease: () => `lease-${++leaseSequence}` },
  );

  await control.start();
  try {
    assert.equal(control.observe().lease, "lease-1");

    failProjection = true;
    await assert.rejects(
      native.replace(fakeSession("session-2", branchEntries())),
      /projection unavailable/,
    );
    assert.throws(
      () => control.observe(),
      /no active Session binding/,
    );

    failProjection = false;
    await native.replace(fakeSession("session-3", branchEntries()));
    assert.equal(control.observe().lease, "lease-3");
    assert.equal(control.observe().session.id, "session-3");
  } finally {
    control.dispose();
  }
});


test("Control timeline fingerprint inspects only the fixed recent tail", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const projection = (control as unknown as { projection: { timeline: unknown[] } }).projection;
    const history = [...projection.timeline];
    const historicalBlock = history[0];
    assert.ok(historicalBlock);
    const largeTimeline = [...history, ...Array.from({ length: 2000 }, () => historicalBlock)];
    let observedSlice: unknown[] | undefined;
    projection.timeline = new Proxy(largeTimeline, {
      get(target, property, receiver) {
        if (property === "slice") {
          return (...args: unknown[]) => {
            observedSlice = args;
            return Array.prototype.slice.apply(target, args as [number?]);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    control.observe();
    assert.deepEqual(observedSlice, [-32]);
  } finally {
    control.dispose();
  }
});

test("Control input maps user intent to Pi-native prompt, steer, and followUp", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const lease = control.observe().lease;

    const prompt = await control.input({ lease, text: "start work" });
    assert.equal(prompt.delivery, "prompt");
    assert.deepEqual(session.prompts, ["start work"]);

    session.start();
    const steer = await control.input({ lease, text: "correct this now" });
    assert.equal(steer.delivery, "steer");
    assert.deepEqual(session.steers, ["correct this now"]);

    const followUp = await control.input({
      lease,
      text: "after that, run the full check",
      timing: "after_current_run",
    });
    assert.equal(followUp.delivery, "followUp");
    assert.deepEqual(session.followUps, ["after that, run the full check"]);
  } finally {
    control.dispose();
  }
});

test("Control prompt input waits for preflight acceptance and cannot settle before the Agent Run", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );
  let accept!: (disposition: "started" | "queued" | "handled") => void;
  runtime.prompt = async (text, options) => {
    session.prompts.push(text);
    accept = options!.preflightResult!;
  };

  await control.start();
  try {
    const lease = control.observe().lease;
    let completed = false;
    const input = control.input({ lease, text: "start work" }).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.role === "user" && block.text === "start work"), false);

    accept("started");
    session.start();
    const delivered = await input;
    assert.equal(delivered.delivery, "prompt");
    assert.equal(delivered.snapshot.runtime.idle, false);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.role === "user" && block.text === "start work"), true);

    let settled = false;
    const waiting = control.wait({ lease, until: "settled" }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    session.settle();
    assert.equal((await waiting).reason, "settled");
  } finally {
    control.dispose();
  }
});

test("S2 accepted prompt identity survives a post-delivery acknowledgement projection failure", async () => {
  const session = fakeSession("ack-session", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  let failAcknowledgement = 0;
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => {
      if (failAcknowledgement > 0) {
        failAcknowledgement -= 1;
        throw new Error("mock acknowledgement projection unavailable");
      }
      return presentationFor(activeState());
    } }),
  });
  runtime.prompt = async (text, options) => {
    session.prompts.push(text);
    options!.preflightResult!("started");
    session.start();
    // Fail the promise-settlement refresh and then the delivery acknowledgement.
    failAcknowledgement = 2;
  };
  await control.start();
  try {
    const result = await control.input({ lease: control.observe().lease, text: "Execute once" }).catch((error: unknown) => error);
    assert.ok(result instanceof PindieControlError);
    assert.equal(result.code, "delivery_uncertain");
    assert.equal(result.receipt?.nextAction, "wait_observe_do_not_resend");
    assert.equal(session.prompts.length, 1);
    const dispatches = control.observe().dispatches;
    assert.equal(dispatches.length, 1, "already-delivered work must stay identifiable after acknowledgement failure");
    assert.deepEqual(dispatches[0]?.runIds, ["ack-session:run:1"]);
    assert.equal(result.receipt?.dispatchId, dispatches[0]?.dispatchId);
    const waiting = control.wait({ lease: control.observe().lease, until: "settled" });
    emitAssistant(session, "Executed once.");
    session.settle();
    const settled = await waiting;
    assert.equal(settled.reason, "settled");
    assert.equal(settled.snapshot?.dispatches[0]?.state, "complete");
    const outputIds = settled.snapshot!.dispatches[0]!.output!.entryIds;
    assert.deepEqual(control.readTimeline().timeline.filter((entry) => outputIds.includes(entry.id)).map((entry) => entry.type === "message" ? entry.text : ""), ["Executed once."]);
    assert.equal(session.prompts.length, 1);
  } finally { control.dispose(); }
});

test("S2 native queued delivery followed by rejection retains uncertainty without inferring acceptance from text", async () => {
  const session = fakeSession("queued-ack-session", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  runtime.steer = async (text) => {
    session.steers.push(text);
    session.queue.steering.push(text);
    session.emit({ type: "queue_update", steering: [...session.queue.steering], followUp: [] } as AgentSessionEvent);
    throw new Error("mock native acknowledgement lost after enqueue");
  };
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Primary work" });
    session.start();
    const result = await control.input({ lease: control.observe().lease, text: "Guidance once" }).catch((error: unknown) => error);
    assert.ok(result instanceof PindieControlError);
    assert.equal(result.code, "delivery_uncertain");
    assert.equal(session.steers.length, 1);
    const dispatches = control.observe().dispatches;
    assert.equal(dispatches.length, 2, "queued work must not disappear from the dispatch ledger on ambiguous rejection");
    assert.equal(dispatches[1]?.state, "running", "queue text without native acknowledgement cannot confirm this invocation");
    assert.equal(result.receipt?.dispatchId, dispatches[1]?.dispatchId);
    assert.notEqual(dispatches[0]?.dispatchId, dispatches[1]?.dispatchId);
    const timedOut = await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 });
    assert.equal(timedOut.reason, "timeout");
    assert.equal(session.steers.length, 1, "wait timeout must never resend guidance");
    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    emitAssistant(session, "Guidance consumed.");
    session.settle();
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled" })).snapshot?.dispatches[1]?.state, "no_result");
    assert.equal(session.steers.length, 1);
  } finally { control.dispose(); }
});

test("S2 rejected native execution cannot become success even after a recorded completion", async () => {
  for (const recordedOutput of [false, true]) {
    const session = fakeSession("rejected-run", []);
    const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
    let rejectRun!: (error: Error) => void;
    runtime.prompt = (text, options) => {
      session.prompts.push(text);
      options!.preflightResult!("started");
      session.start();
      return new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    };
    const control = new PindieControlClient(runtime, {
      current: () => ({ snapshot: () => presentationFor(activeState()) }),
    });
    await control.start();
    try {
      const input = await control.input({ lease: control.observe().lease, text: "Execute once" });
      const guidance = await control.input({ lease: input.snapshot.lease, text: "Guidance" });
      session.queue.steering.length = 0;
      session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
      if (recordedOutput) emitAssistant(session, "Recorded before execution failed.");
      const waiting = control.wait({ lease: input.snapshot.lease, until: "settled" });
      let returned = false;
      void waiting.then(() => { returned = true; });
      // Native _startRun emits agent_settled in finally before its promise rejects.
      session.settle();
      await Promise.resolve();
      assert.equal(returned, false);
      assert.equal(control.observe().runtime.automaticWorkSettled, false);
      assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["running", "running"]);
      rejectRun(new Error("mock process failure token=never-project-this"));
      const result = await waiting;
      assert.equal(result.reason, "settled");
      assert.deepEqual(result.snapshot!.dispatches.map(({ state }) => state), ["error", "error"]);
      assert.deepEqual(result.snapshot!.dispatches.map(({ dispatchId }) => dispatchId), [input.dispatch.dispatchId, guidance.dispatch.dispatchId]);
      assert.ok(!JSON.stringify(result).includes("never-project-this"));
      assert.equal(session.prompts.length, 1);
      assert.equal(control.readTimeline().timeline.filter((entry) => entry.type === "message" && entry.role === "assistant").length, recordedOutput ? 1 : 0);
    } finally { control.dispose(); }
  }
});

test("S2 rejected prompt without agent_start stays failed and never attaches to later work", async () => {
  const session = fakeSession("unstarted-run", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  let rejectRun!: (error: Error) => void;
  runtime.prompt = (text, options) => {
    session.prompts.push(text);
    options!.preflightResult!("started");
    return new Promise<void>((_resolve, reject) => { rejectRun = reject; });
  };
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const input = await control.input({ lease: control.observe().lease, text: "Fails before Run start" });
    session.settle();
    rejectRun(new Error("mock start failure"));
    await Promise.resolve();
    const result = await control.wait({ lease: input.snapshot.lease, until: "settled" });
    assert.equal(latestDispatch(result.snapshot!).state, "error");
    assert.equal(latestDispatch(result.snapshot!).runId, null);
    runtime.prompt = async (text, options) => {
      session.prompts.push(text);
      options!.preflightResult!("started");
      session.start();
    };
    await control.input({ lease: input.snapshot.lease, text: "New explicitly authorized work" });
    emitAssistant(session, "New work complete.");
    session.settle();
    const records = control.observe().dispatches;
    assert.deepEqual(records.map(({ state }) => state), ["error", "complete"]);
    assert.equal(records[0]?.dispatchId, input.dispatch.dispatchId);
    assert.deepEqual(records[0]?.runIds, []);
    assert.equal(records[0]?.output, null);
    assert.equal(session.prompts.length, 2);
  } finally { control.dispose(); }
});

test("S2 successful native promise closes the settlement window without redispatch", async () => {
  const session = fakeSession("resolved-run", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  let resolveRun!: () => void;
  runtime.prompt = (text, options) => {
    session.prompts.push(text);
    options!.preflightResult!("started");
    session.start();
    return new Promise<void>((resolve) => { resolveRun = resolve; });
  };
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const input = await control.input({ lease: control.observe().lease, text: "Execute once" });
    emitAssistant(session, "Recorded completion.");
    const waiting = control.wait({ lease: input.snapshot.lease, until: "settled" });
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "running");
    resolveRun();
    const result = await waiting;
    assert.equal(result.reason, "settled");
    assert.equal(result.snapshot?.runtime.automaticWorkSettled, true);
    assert.equal(result.snapshot?.dispatches[0]?.state, "complete");
    assert.equal(result.snapshot?.dispatches[0]?.dispatchId, input.dispatch.dispatchId);
    assert.equal(session.prompts.length, 1);
  } finally { control.dispose(); }
});

test("S2 ambiguous identical delivery cannot borrow queue confirmation or hide an unconsumed acknowledged input", async () => {
  for (const timing of ["now", "after_current_run"] as const) {
    for (const leaveAcknowledgedQueued of [false, true]) {
      const session = fakeSession("identical-uncertain-session", []);
      const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
      const control = new PindieControlClient(runtime, {
        current: () => ({ snapshot: () => presentationFor(activeState()) }),
      });
      await control.start();
      try {
        const lease = control.observe().lease;
        await control.input({ lease, text: "Main work" });
        session.start();
        const acknowledged = await control.input({ lease, text: "Check logs", timing });
        // B is a distinct intentional input, but its native call rejects before enqueue.
        if (timing === "now") runtime.steer = async () => { throw new Error("mock reject before enqueue"); };
        else runtime.followUp = async () => { throw new Error("mock reject before enqueue"); };
        const uncertain = await control.input({ lease, text: "Check logs", timing }).catch((error: unknown) => error);
        assert.ok(uncertain instanceof PindieControlError);
        assert.equal(uncertain.code, "delivery_uncertain");
        assert.notEqual(uncertain.receipt?.dispatchId, acknowledged.dispatch.dispatchId);
        const other = await control.input({ lease, text: "Unrelated guidance", timing: timing === "now" ? "after_current_run" : "now" });
        // Native enqueues emit full snapshots: the old occurrence belongs to A, not B.
        session.emit({ type: "queue_update", steering: [...session.queue.steering], followUp: [...session.queue.followUp] } as AgentSessionEvent);
        const afterUnrelatedUpdate = control.observe();
        const ownQueue = timing === "now" ? session.queue.steering : session.queue.followUp;
        const otherQueue = timing === "now" ? session.queue.followUp : session.queue.steering;
        if (!leaveAcknowledgedQueued) ownQueue.length = 0;
        otherQueue.length = 0;
        session.emit({ type: "queue_update", steering: [...session.queue.steering], followUp: [...session.queue.followUp] } as AgentSessionEvent);
        emitAssistant(session, "Consumed native work complete.");
        session.settle();
        const settled = control.observe();
        const byId = (id: string | undefined) => settled.dispatches.find((record) => record.dispatchId === id);
        assert.equal(byId(uncertain.receipt?.dispatchId)?.state, "no_result", "B must not inherit A's queue acceptance and false completion");
        assert.equal(byId(acknowledged.dispatch.dispatchId)?.state, leaveAcknowledgedQueued ? "cancelled" : "complete", "B must not steal A's still-queued occurrence");
        assert.equal(byId(other.dispatch.dispatchId)?.state, "complete");
        assert.equal(afterUnrelatedUpdate.dispatches.find(({ dispatchId }) => dispatchId === acknowledged.dispatch.dispatchId)?.state, "queued");
        assert.equal(afterUnrelatedUpdate.dispatches.find(({ dispatchId }) => dispatchId === uncertain.receipt?.dispatchId)?.state, "running");
        assert.equal(settled.dispatches.length, 4);
        assert.equal(new Set(settled.dispatches.map(({ dispatchId }) => dispatchId)).size, 4);
      } finally { control.dispose(); }
    }
  }
});

test("S2 queue acknowledgement arriving after settlement cannot complete unconsumed input", async () => {
  const session = fakeSession("late-queue-ack-session", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  let acknowledge!: () => void;
  runtime.steer = (text) => {
    session.queue.steering.push(text);
    session.emit({ type: "queue_update", steering: [...session.queue.steering], followUp: [] } as AgentSessionEvent);
    return new Promise<void>((resolve) => { acknowledge = resolve; });
  };
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const lease = control.observe().lease;
    await control.input({ lease, text: "Main work" });
    session.start();
    const pending = control.input({ lease, text: "Never consumed" });
    emitAssistant(session, "Main work complete.");
    session.settle();
    acknowledge();
    const delivered = await pending;
    assert.equal(delivered.dispatch.state, "cancelled");
    assert.deepEqual(session.queue.steering, ["Never consumed"]);
    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "cancelled", "later queue clearing must not revive unconsumed input as complete");
    assert.equal(control.observe().dispatches[0]?.state, "complete");
  } finally { control.dispose(); }
});

test("S2 unconfirmed queued delivery never inherits the current Run's success", async () => {
  const session = fakeSession("unconfirmed-session", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  runtime.followUp = async () => { throw new Error("mock acknowledgement loss without queue evidence"); };
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const error = await control.input({ lease: control.observe().lease, text: "Possibly not delivered", timing: "after_current_run" }).catch((error: unknown) => error);
    assert.ok(error instanceof PindieControlError);
    assert.equal(error.code, "delivery_uncertain");
    emitAssistant(session, "Main work complete.");
    session.settle();
    const result = await control.wait({ lease: control.observe().lease, until: "settled" });
    assert.deepEqual(result.snapshot!.dispatches.map(({ state }) => state), ["complete", "no_result"]);
    assert.equal(result.snapshot!.dispatches[1]?.dispatchId, error.receipt?.dispatchId);
  } finally { control.dispose(); }
});

test("S2 Gate response keeps its receipt after native acceptance and acknowledgement failure", async () => {
  const session = fakeSession("gate-ack-session", []);
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  let failAcknowledgement = 0;
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => {
      if (failAcknowledgement > 0) {
        failAcknowledgement -= 1;
        throw new Error("mock Gate acknowledgement failure");
      }
      return presentationFor(activeState({ kind: "approval", question: "Proceed?" }));
    } }),
  });
  runtime.prompt = async (text, options) => {
    session.prompts.push(text);
    options!.preflightResult!("started");
    session.start();
    failAcknowledgement = 2;
  };
  await control.start();
  try {
    const snapshot = control.observe();
    const error = await control.respond({ lease: snapshot.lease, gateKey: snapshot.semantic.humanGate!.key, response: "Approve" }).catch((error: unknown) => error);
    assert.ok(error instanceof PindieControlError);
    assert.equal(error.code, "delivery_uncertain");
    assert.equal(control.observe().dispatches[0]?.dispatchId, error.receipt?.dispatchId);
    emitAssistant(session, "Approval received.");
    session.settle();
    assert.equal(control.observe().dispatches[0]?.state, "complete");
    assert.deepEqual(session.prompts, ["Approve"]);
  } finally { control.dispose(); }
});

test("Control Pi 0.99 handled dispositions never fabricate prompt or queued timeline deliveries", async () => {
  const session = fakeSession("session-1", branchEntries());
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  const control = new PindieControlClient(runtime,
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  runtime.prompt = async (_text, options) => { options!.preflightResult!("handled"); };
  runtime.steer = async () => "handled";
  runtime.followUp = async () => "handled";
  await control.start();
  try {
    const lease = control.observe().lease;
    await assert.rejects(control.input({ lease, text: "consumed prompt" }), (error: unknown) =>
      error instanceof PindieControlError && error.code === "delivery_failed");
    session.start();
    for (const timing of ["now", "after_current_run"] as const) {
      await assert.rejects(control.input({ lease, text: `consumed ${timing}`, timing }), (error: unknown) =>
        error instanceof PindieControlError && error.code === "delivery_failed");
    }
    assert.equal(control.readTimeline().timeline.some((block) =>
      block.type === "message" && block.role === "user" && block.text.startsWith("consumed")), false);
  } finally { control.dispose(); }
});

test("Control rejected prompt preflight returns delivery_failed without a timeline echo", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );
  runtime.prompt = async (_text, options) => {
    throw new Error("preflight rejected");
  };

  await control.start();
  try {
    const lease = control.observe().lease;
    await assert.rejects(control.input({ lease, text: "rejected" }), (error: unknown) =>
      error instanceof PindieControlError && error.code === "delivery_failed");
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.role === "user" && block.text === "rejected"), false);
  } finally {
    control.dispose();
  }
});

test("optional Session naming is normalized, started-only, one-shot native metadata", async () => {
  const entries: SessionEntry[] = [];
  const session = fakeSession("fresh", entries, { unnamed: true });
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  const control = new PindieControlClient(runtime,
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  let accept!: NonNullable<import("@earendil-works/pi-coding-agent").PromptOptions["preflightResult"]>;
  runtime.prompt = async (_text, options) => { accept = options!.preflightResult!; };
  await control.start();
  try {
    const lease = control.observe().lease;
    const pending = control.input({ lease, text: "authorized work", sessionName: "  Pindie   Control · Session Identity  " });
    assert.deepEqual(session.nameWrites, []);
    accept("started");
    accept("started");
    const result = await pending;
    assert.deepEqual(session.nameWrites, ["Pindie Control · Session Identity"]);
    assert.equal(result.snapshot.session.displayIdentity, session.nameWrites[0]);
    const again = control.input({ lease, text: "related continuation", sessionName: "Do not rename" });
    accept("started");
    await again;
    assert.equal(session.nameWrites.length, 1);
  } finally { control.dispose(); }
});

test("Session naming rejects invalid labels before dispatch and preserves optional old calls", async () => {
  const session = fakeSession("fresh", [], { unnamed: true });
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  await control.start();
  try {
    const lease = control.observe().lease;
    for (const sessionName of ["", "   ", "a".repeat(97), "a".repeat(513), "bad\nname", "bad\tname", "\u001b[31m", "\u202ename", "\ud800"]) {
      await assert.rejects(control.input({ lease, text: "work", sessionName }),
        (error: unknown) => error instanceof PindieControlError && error.code === "invalid_request");
    }
    assert.deepEqual(session.prompts, []);
    const oldCall = await control.input({ lease, text: "old client" });
    assert.equal(oldCall.delivery, "prompt");
    assert.deepEqual(session.nameWrites, []);
    session.settle();
    // Fake native persistence of the first untitled prompt: later continuations
    // must not title it, including after a new Control binding/restart.
    session.session.sessionManager.getEntries = () => branchEntries();
    await control.input({ lease, text: "work", sessionName: "Later label" });
    assert.deepEqual(session.nameWrites, []);
  } finally { control.dispose(); }
});

test("Session names count graphemes rather than UTF-16 units", async () => {
  const session = fakeSession("fresh", [], { unnamed: true });
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "work", sessionName: "😀".repeat(96) });
    assert.equal(session.nameWrites[0], "😀".repeat(96));
    assert.deepEqual(session.prompts, ["work"]); // Label never becomes prompt content.
  } finally { control.dispose(); }
});

test("Session naming never renames busy, named, historical or explicitly cleared Sessions", async () => {
  const clear = { type: "session_info", id: "clear", parentId: null, timestamp: "2026-01-01", name: "" } as SessionEntry;
  for (const scenario of ["named", "history", "cleared", "custom", "steer", "followUp", "pending", "quota"] as const) {
    const entries = scenario === "history" ? branchEntries() : scenario === "cleared" ? [clear] :
      scenario === "custom" ? [{ type: "custom", id: "old", parentId: null, timestamp: "2026-01-01", customType: "old", data: {} } as SessionEntry] : [];
    const session = fakeSession(scenario, entries, { unnamed: scenario !== "named" });
    const presentation = presentationFor(activeState());
    if (scenario === "quota") presentation.quotaResumeWaiting = { sessionId: scenario, resumeAt: Date.now() + 1000 };
    const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
      { current: () => ({ snapshot: () => presentation }) });
    await control.start();
    try {
      if (scenario === "steer" || scenario === "followUp") session.start();
      if (scenario === "pending") session.queue.followUp.push("pending");
      await control.input({ lease: control.observe().lease, text: "work", sessionName: "Do not rename", timing: scenario === "followUp" ? "after_current_run" : "now" });
      assert.deepEqual(session.nameWrites, [], scenario);
    } finally { control.dispose(); }
  }
});

test("Session naming ignores rejected, handled and queued preflight, and metadata write errors never reject delivery", async () => {
  for (const disposition of ["rejected", "handled", "queued", "write_error", "partial_write_error"] as const) {
    const session = fakeSession("fresh", [], { unnamed: true });
    const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
    const control = new PindieControlClient(runtime,
      { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
    runtime.prompt = async (_text, options) => {
      if (disposition === "rejected") throw new Error("rejected");
      options!.preflightResult!(disposition === "write_error" || disposition === "partial_write_error" ? "started" : disposition);
    };
    if (disposition === "write_error") session.session.setSessionName = () => { throw new Error("private native path"); };
    if (disposition === "partial_write_error") {
      const write = session.session.setSessionName;
      session.session.setSessionName = (name) => { write(name); throw new Error("private native path"); };
    }
    await control.start();
    try {
      const pending = control.input({ lease: control.observe().lease, text: "work", sessionName: "Title" });
      if (disposition === "rejected" || disposition === "handled") await assert.rejects(pending, (error: unknown) => error instanceof PindieControlError && error.code === "delivery_failed");
      else {
        const result = await pending;
        assert.equal(result.delivery, "prompt");
        assert.equal(JSON.stringify(result).includes("private native path"), false);
        if (disposition === "partial_write_error") assert.equal(result.snapshot.session.displayIdentity, "Title");
      }
      assert.deepEqual(session.nameWrites, disposition === "partial_write_error" ? ["Title"] : []);
    } finally { control.dispose(); }
  }
});

test("Session naming cannot bypass initial Human Gate or unavailable presentation authorization", async () => {
  for (const unavailable of [false, true]) {
    const session = fakeSession("fresh", [], { unnamed: true });
    const presentation = presentationFor(activeState({ kind: "approval", question: "Approve?" }));
    const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
      { current: () => unavailable ? null : ({ snapshot: () => presentation }) });
    await control.start();
    try {
      await assert.rejects(control.input({ lease: control.observe().lease, text: "work", sessionName: "Title" }),
        (error: unknown) => error instanceof PindieControlError && error.code === (unavailable ? "semantic_unavailable" : "human_gate_required"));
      assert.deepEqual(session.prompts, []);
      assert.deepEqual(session.nameWrites, []);
    } finally { control.dispose(); }
  }
});

test("unavailable naming metadata never prevents an otherwise accepted prompt", async () => {
  const session = fakeSession("fresh", [], { unnamed: true });
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  await control.start();
  try {
    session.session.sessionManager.getHeader = () => { throw new Error("private path"); };
    assert.equal((await control.input({ lease: control.observe().lease, text: "work", sessionName: "Title" })).delivery, "prompt");
    assert.deepEqual(session.nameWrites, []);
    assert.deepEqual(session.prompts, ["work"]);
  } finally { control.dispose(); }
});

test("Session naming revalidates exact binding and native state at preflight, including replacement with reused ID", async () => {
  for (const change of ["replacement", "name", "conversation", "gate"] as const) {
    const entries: SessionEntry[] = [];
    const session = fakeSession("same-id", entries, { unnamed: true });
    const native = fakeNativeRuntime(session);
    const runtime = new PiRuntimeAdapter(native.runtime);
    let presentation = presentationFor(activeState());
    const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentation }) });
    let accept!: NonNullable<import("@earendil-works/pi-coding-agent").PromptOptions["preflightResult"]>;
    runtime.prompt = async (_text, options) => { accept = options!.preflightResult!; };
    await control.start();
    try {
      const lease = control.observe().lease;
      await assert.rejects(control.input({ lease: "stale", text: "work", sessionName: "Title" }), (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
      const pending = control.input({ lease, text: "work", sessionName: "Title" });
      let replacement: FakeSessionControl | undefined;
      if (change === "replacement") { replacement = fakeSession("same-id", [], { unnamed: true }); await native.replace(replacement); }
      if (change === "name") session.session.setSessionName("Human title");
      if (change === "conversation") entries.push(...branchEntries());
      if (change === "gate") presentation = presentationFor({ ...activeState(), task: { ...activeState().task!, humanGate: { kind: "approval", question: "Approve?" } } });
      accept("started");
      if (change === "replacement") await assert.rejects(pending, (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
      else await pending;
      assert.deepEqual(session.nameWrites, change === "name" ? ["Human title"] : [], change);
      assert.deepEqual(replacement?.nameWrites ?? [], []);
    } finally { control.dispose(); }
  }
});

test("Control Human Gate response waits for the same prompt preflight acceptance", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState({ kind: "approval", question: "Proceed?" }));
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );
  let accept!: (disposition: "started" | "queued" | "handled") => void;
  runtime.prompt = async (_text, options) => { accept = options!.preflightResult!; };

  await control.start();
  try {
    const snapshot = control.observe();
    const gate = snapshot.semantic.humanGate!;
    let completed = false;
    const response = control.respond({ lease: snapshot.lease, gateKey: gate.key, response: "Approve" })
      .then((result) => { completed = true; return result; });
    await Promise.resolve();
    assert.equal(completed, false);
    // The dispatch exists before Pi's preflight can start the Run.
    const pending = control.observe().dispatches;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.delivery, "prompt");
    assert.equal(pending[0]?.state, "accepted");
    assert.equal(pending[0]?.runId, null);
    accept("started");
    session.start();
    const accepted = await response;
    assert.equal(accepted.delivery, "prompt");
    assert.equal(accepted.dispatch.dispatchId, pending[0]?.dispatchId);
    assert.equal(accepted.dispatch.runId, "session-1:run:1");
    // The answered Gate is still current in this fixture, so the active Run is waiting.
    assert.equal(accepted.dispatch.state, "waiting");
    assert.equal(control.observe().runtime.idle, false);

    emitAssistant(session, "Approved and applied.");
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "complete");
    assert.deepEqual(latestDispatch(control.observe()).output?.entryIds, ["live:session-1:assistant:1"]);
  } finally {
    control.dispose();
  }
});

test("Control separates ordinary input from a current Human Gate response", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState({
    kind: "approval",
    question: "Merge the reviewed PR?",
    options: ["Approve", "Reject"],
  }));
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const snapshot = control.observe();
    const gate = snapshot.semantic.humanGate;
    assert.ok(gate);

    await assert.rejects(
      control.input({ lease: snapshot.lease, text: "keep coding" }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "human_gate_required",
    );
    assert.deepEqual(session.prompts, []);

    await assert.rejects(
      control.respond({
        lease: snapshot.lease,
        gateKey: "stale-gate",
        response: "Approve",
      }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "human_gate_mismatch",
    );

    const response = await control.respond({
      lease: snapshot.lease,
      gateKey: gate.key,
      response: "Approve",
    });
    assert.equal(response.delivery, "prompt");
    assert.deepEqual(session.prompts, ["Approve"]);
  } finally {
    control.dispose();
  }
});

test("Control stop clears native queues before aborting current work", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const lease = control.observe().lease;
    session.start();
    await control.input({ lease, text: "steer queued" });
    await control.input({
      lease,
      text: "follow-up queued",
      timing: "after_current_run",
    });
    assert.equal(session.queue.steering.length, 1);
    assert.equal(session.queue.followUp.length, 1);

    const stopped = await control.stop({ lease });
    assert.equal(stopped.stopped, true);
    assert.deepEqual(stopped.cleared, { steering: 1, followUp: 1 });
    assert.equal(session.queue.steering.length, 0);
    assert.equal(session.queue.followUp.length, 0);
    assert.equal(session.abortCalls(), 1);
    assert.equal(stopped.snapshot.runtime.idle, true);
    assert.equal(stopped.snapshot.runtime.automaticWorkSettled, true);
  } finally {
    control.dispose();
  }
});

test("Control fresh Session requires a safe boundary and returns a new lease", async () => {
  const first = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  let leaseSequence = 0;
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => `lease-${++leaseSequence}` },
  );

  await control.start();
  try {
    const before = control.observe();
    const waiting = control.wait({ lease: before.lease, until: "human_gate", timeoutSeconds: 30 });
    const replacement = fakeSession("session-2", branchEntries());
    native.setNextFreshSession(replacement);

    const replaced = await control.freshSession({ lease: before.lease });
    assert.equal((await waiting).reason, "binding_changed");
    assert.equal(replaced.cancelled, false);
    assert.equal(replaced.snapshot.session.id, "session-2");
    assert.notEqual(replaced.snapshot.lease, before.lease);

    await assert.rejects(
      control.input({ lease: before.lease, text: "stale write" }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "stale_control_lease",
    );
  } finally {
    control.dispose();
  }
});

test("Control fresh Session does not bypass an unresolved Human Gate", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState({
    kind: "decision",
    question: "Choose the architecture.",
    options: ["A", "B"],
  }));
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const snapshot = control.observe();
    await assert.rejects(
      control.freshSession({ lease: snapshot.lease }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "human_gate_required",
    );
  } finally {
    control.dispose();
  }
});

test("Control lists bounded, deterministic Session projections without internal paths", async () => {
  const session = fakeSession("session-current", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  setSessionChoices(runtime, [
    sessionChoice("z", "/private/session-z", "2026-03-01T00:00:00.000Z"),
    sessionChoice("b", "/private/session-b", "2026-03-02T00:00:00.000Z", { name: `  ${"n".repeat(110)}  ` }),
    sessionChoice("a", "/private/session-a", "2026-03-02T00:00:00.000Z", { firstMessage: `  hello\n   ${"👨‍👩‍👧‍👦".repeat(40)}  ` }),
    sessionChoice("session-current", "/private/current", "2026-02-01T00:00:00.000Z", { current: true }),
  ]);
  const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  await control.start();
  try {
    const page = await control.listSessions({ offset: 1, limit: 2 });
    assert.equal(page.activeSessionId, "session-current");
    assert.equal(page.total, 4);
    assert.equal(page.offset, 1);
    assert.equal(page.limit, 2);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.sessions.map(({ id }) => id), ["b", "z"]);
    assert.equal(page.sessions[0]?.created, "2026-01-01T00:00:00.000Z");
    assert.equal(page.sessions[0]?.modified, "2026-03-02T00:00:00.000Z");
    assert.equal(page.sessions[0]?.name, "n".repeat(95) + "…");
    const all = await control.listSessions({ limit: 50 });
    const preview = all.sessions.find(({ id }) => id === "a")!.firstMessagePreview;
    assert.equal(preview.startsWith("hello "), true);
    assert.ok(Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(preview)).length <= 160);
    assert.equal(all.sessions.find(({ id }) => id === "session-current")?.current, true);
    assert.equal(JSON.stringify({ page, all }).includes("/private/"), false);
    assert.equal(JSON.stringify({ page, all }).includes("path"), false);
    await assert.rejects(control.listSessions({ limit: 51 }), (error: unknown) => error instanceof PindieControlError && error.code === "invalid_request");
  } finally { control.dispose(); }
});

test("Control Session switch resolves fresh IDs, checks binding after discovery, and rejects stale leases", async () => {
  const first = fakeSession("session-current", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const choices = [sessionChoice("target", "/private/target.jsonl", "2026-03-02T00:00:00.000Z")];
  setSessionChoices(runtime, choices);
  const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) });
  await control.start();
  try {
    const lease = control.observe().lease;
    await assert.rejects(control.switchSession({ lease, sessionId: "unknown" }), (error: unknown) => error instanceof PindieControlError && error.code === "session_not_found");
    setSessionChoices(runtime, [...choices, { ...choices[0]!, path: "/private/duplicate.jsonl" }]);
    await assert.rejects(control.switchSession({ lease, sessionId: "target" }), (error: unknown) => error instanceof PindieControlError && error.code === "session_ambiguous");
    let discoveries = 0;
    runtime.getActiveProjectSessionChoices = async () => { discoveries++; return choices; };
    await assert.rejects(control.switchSession({ lease: "stale", sessionId: "target" }), (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
    assert.equal(discoveries, 0);

    let release!: (value: typeof choices) => void;
    runtime.getActiveProjectSessionChoices = () => new Promise((resolve) => { release = resolve; });
    const inFlight = control.switchSession({ lease, sessionId: "target" });
    await native.replace(fakeSession("session-replaced", branchEntries()));
    release(choices);
    await assert.rejects(inFlight, (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
    assert.deepEqual(native.switchCalls, []);
  } finally { control.dispose(); }
});

test("same-Session switch is idempotent before safety checks", async () => {
  const session = fakeSession("session-current", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  setSessionChoices(runtime, [sessionChoice("session-current", "/private/current", "2026-03-02T00:00:00.000Z", { current: true })]);
  const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) }, { createLease: () => "same-lease" });
  await control.start();
  try {
    const before = control.observe();
    session.start();
    const result = await control.switchSession({ lease: before.lease, sessionId: "session-current" });
    assert.equal(result.snapshot.lease, before.lease);
    assert.deepEqual(native.switchCalls, []);
    assert.equal(result.snapshot.runtime.idle, false);
  } finally { control.dispose(); }
});

test("real Session switches enforce only runtime, gate and recovery safety", async () => {
  for (const unsafe of [
    { label: "busy", runtime: { idle: false, streaming: true, automaticWorkSettled: true, pendingMessageCount: 0 } },
    { label: "unsettled", runtime: { idle: true, streaming: false, automaticWorkSettled: false, pendingMessageCount: 0 } },
    { label: "pending", runtime: { idle: true, streaming: false, automaticWorkSettled: true, pendingMessageCount: 1 } },
    { label: "Human Gate", gate: { kind: "approval" as const, question: "Approve?" } },
    { label: "quota wait", quota: { sessionId: "session-current", resumeAt: 1 } },
  ]) {
    const current = fakeSession("session-current", branchEntries());
    const native = fakeNativeRuntime(current);
    const runtime = new PiRuntimeAdapter(native.runtime);
    setSessionChoices(runtime, [sessionChoice("target", "/private/target", "2026-03-02T00:00:00.000Z")]);
    const state = activeState(unsafe.gate ?? null);
    const presentation = presentationFor(state, { quotaResumeWaiting: unsafe.quota ?? null });
    const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentation }) });
    await control.start();
    try {
      if (unsafe.runtime) {
        if (unsafe.runtime.pendingMessageCount) await current.session.steer("pending");
        else if (!unsafe.runtime.idle) current.start();
        if (!unsafe.runtime.automaticWorkSettled) current.start();
      }
      await assert.rejects(control.switchSession({ lease: control.observe().lease, sessionId: "target" }), (error: unknown) => error instanceof PindieControlError && error.code === "session_switch_unsafe", unsafe.label);
      assert.deepEqual(native.switchCalls, [], unsafe.label);
    } finally { control.dispose(); }
  }
});

test("active or blocked Tasks and pending verification do not block safe Session switches", async () => {
  for (const taskStatus of ["active", "blocked"] as const) {
    const first = fakeSession("session-current", branchEntries());
    const native = fakeNativeRuntime(first);
    const runtime = new PiRuntimeAdapter(native.runtime);
    const target = sessionChoice("target", "/private/target", "2026-03-02T00:00:00.000Z");
    setSessionChoices(runtime, [target]);
    native.setNextSwitchSession(fakeSession("target", branchEntries()));
    const state = activeState();
    if (taskStatus === "blocked") state.task!.openLoops.blockers.push("External dependency");
    const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(state) }) });
    await control.start();
    try {
      const result = await control.switchSession({ lease: control.observe().lease, sessionId: target.id });
      assert.equal(result.snapshot.session.id, "target");
      assert.equal(state.task?.completed, false);
      assert.equal(result.snapshot.semantic.taskStatus, taskStatus);
      assert.equal(result.snapshot.semantic.verificationStatus, "pending");
    } finally { control.dispose(); }
  }
});

test("successful Session switch rotates the Control binding; cancellation and failures fail closed", async () => {
  const first = fakeSession("session-current", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  setSessionChoices(runtime, [sessionChoice("target", "/internal/target.jsonl", "2026-03-02T00:00:00.000Z")]);
  native.setNextSwitchSession(fakeSession("target", branchEntries()));
  let bound: string[] = [];
  let leaseSequence = 0;
  const control = new PindieControlClient(runtime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) }, {
    createLease: () => `switch-lease-${++leaseSequence}`,
    bindActiveSession: async () => { bound.push(runtime.activeSessionId); },
  });
  await control.start();
  try {
    const before = control.observe();
    const waiting = control.wait({ lease: before.lease, until: "human_gate", timeoutSeconds: 30 });
    const switched = await control.switchSession({ lease: before.lease, sessionId: "target" });
    assert.equal((await waiting).reason, "binding_changed");
    assert.deepEqual(native.switchCalls, ["/internal/target.jsonl"]);
    assert.deepEqual(bound, ["session-current", "target"]);
    assert.equal(switched.snapshot.session.id, "target");
    assert.notEqual(switched.snapshot.lease, before.lease);
    await assert.rejects(control.input({ lease: before.lease, text: "stale" }), (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");
  } finally { control.dispose(); }

  const old = fakeSession("old", branchEntries());
  const cancelledNative = fakeNativeRuntime(old);
  const cancelledRuntime = new PiRuntimeAdapter(cancelledNative.runtime);
  setSessionChoices(cancelledRuntime, [sessionChoice("target", "/private/target", "2026-03-02T00:00:00.000Z")]);
  cancelledNative.setSwitchCancelled(true);
  const cancelledControl = new PindieControlClient(cancelledRuntime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) }, { createLease: () => "cancel-lease" });
  await cancelledControl.start();
  try {
    const before = cancelledControl.observe();
    const cancelled = await cancelledControl.switchSession({ lease: before.lease, sessionId: "target" });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.snapshot.lease, before.lease);
    assert.equal(cancelledControl.observe().session.id, "old");
  } finally { cancelledControl.dispose(); }

  const failing = fakeNativeRuntime(fakeSession("old", branchEntries()));
  const failingRuntime = new PiRuntimeAdapter(failing.runtime);
  setSessionChoices(failingRuntime, [sessionChoice("target", "/private/target", "2026-03-02T00:00:00.000Z")]);
  failing.setSwitchFailure(new Error("private /path/must/not/leak"));
  const failedControl = new PindieControlClient(failingRuntime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) }, { createLease: () => "failure-lease" });
  await failedControl.start();
  try {
    await assert.rejects(failedControl.switchSession({ lease: "failure-lease", sessionId: "target" }), (error: unknown) => error instanceof PindieControlError && error.code === "session_switch_failed" && !error.message.includes("/path"));
  } finally { failedControl.dispose(); }

  const bootstrapFailure = fakeNativeRuntime(fakeSession("old", branchEntries()));
  const bootstrapRuntime = new PiRuntimeAdapter(bootstrapFailure.runtime);
  setSessionChoices(bootstrapRuntime, [sessionChoice("target", "/private/target", "2026-03-02T00:00:00.000Z")]);
  bootstrapFailure.setNextSwitchSession(fakeSession("target", branchEntries()));
  const bootstrapControl = new PindieControlClient(bootstrapRuntime, { current: () => ({ snapshot: () => presentationFor(activeState()) }) }, {
    createLease: () => "bootstrap-lease",
    bindActiveSession: async () => { if (bootstrapRuntime.activeSessionId === "target") throw new Error("session_start failed"); },
  });
  await bootstrapControl.start();
  try {
    await assert.rejects(bootstrapControl.switchSession({ lease: "bootstrap-lease", sessionId: "target" }),
      (error: unknown) => error instanceof PindieControlError && error.code === "session_switch_failed" && error.snapshot === null);
    assert.throws(() => bootstrapControl.observe(), /no active Session binding/);
  } finally { bootstrapControl.dispose(); }
});

test("Control retains live timeline events, reconciles persistence, and filters unsafe Session content", async () => {
  const session = fakeSession("live-session", branchEntries());
  const control = new PindieControlClient(
    new PiRuntimeAdapter(fakeNativeRuntime(session).runtime),
    { current: () => ({ snapshot: () => presentationFor(activeState()) }) },
  );
  await control.start();
  try {
    const startRevision = control.observe().revision;
    session.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Visible" }] } } as AgentSessionEvent);
    const streamed = control.readTimeline();
    assert.equal(streamed.timeline.some((block) => block.type === "message" && block.role === "assistant" && block.text === "Visible" && block.lifecycle === "streaming"), true);
    const assistantRevision = streamed.revision;
    assert.ok(assistantRevision > startRevision);
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Visible, still streaming" }] } } as AgentSessionEvent);
    assert.equal(control.observe().revision, assistantRevision);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.text === "Visible, still streaming"), true);

    session.emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo safe" } } as AgentSessionEvent);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "work" && block.id === "tool-1" && block.lifecycle === "running"), true);
    const workRevision = control.observe().revision;
    session.emit({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: { command: "echo safe" }, partialResult: { content: [{ type: "text", text: "partial" }] } } as AgentSessionEvent);
    assert.equal(control.observe().revision, workRevision);
    session.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false } as AgentSessionEvent);
    assert.ok(control.observe().revision > workRevision);
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "work" && block.id === "tool-1" && block.lifecycle === "complete"), true);

    session.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Visible, still streaming" }], stopReason: "stop" } as never } as AgentSessionEvent);
    const completedRevision = control.observe().revision;
    assert.ok(completedRevision > startRevision);
    session.settle();
    assert.equal(control.observe().runtime.automaticWorkSettled, true);

    const latest = control.readTimeline().timeline;
    assert.equal(latest.some((block) => block.type === "message" && block.text.includes("private reasoning")), false);
    assert.equal(latest.some((block) => block.type === "message" && block.text.includes("secret runtime metadata")), false);
    assert.equal(latest.some((block) => block.type === "message" && block.text.includes("continuation probe sentinel")), false);
    assert.equal(JSON.stringify(latest).includes("/repo/Pindie"), false);
    assert.equal(control.readTimeline({ limit: 1 }).timeline.length, 1);
    assert.equal(control.readTimeline({ limit: 1 }).hasMoreBefore, true);
    assert.throws(() => control.readTimeline({ limit: 0 }), (error: unknown) => error instanceof PindieControlError && error.code === "invalid_request");

    session.emit({ type: "entry_appended", entry: { type: "message", id: "persisted-assistant", parentId: null, timestamp: "2026-09-24T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "Visible, still streaming" }], stopReason: "stop" } } } as AgentSessionEvent);
    const reconciled = control.readTimeline().timeline.filter((block) => block.type === "message" && block.role === "assistant" && block.text === "Visible, still streaming");
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.source, "session");
  } finally { control.dispose(); }
});

test("Control reads persisted branch only once per Session epoch", async () => {
  const first = fakeSession("branch-count-1", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    assert.equal(first.branchReads(), 1);
    const message = { role: "assistant", content: [{ type: "text", text: "branch-free stream" }] };
    first.emit({ type: "message_start", message } as AgentSessionEvent);
    first.emit({ type: "message_update", message: { ...message, content: [{ type: "text", text: "branch-free update one" }] } } as AgentSessionEvent);
    first.emit({ type: "message_update", message: { ...message, content: [{ type: "text", text: "branch-free update two" }] } } as AgentSessionEvent);
    first.emit({ type: "message_end", message: { ...message, content: [{ type: "text", text: "branch-free complete" }], stopReason: "stop" } as never } as AgentSessionEvent);
    first.emit({ type: "tool_execution_start", toolCallId: "branch-tool", toolName: "bash", args: { command: "echo test" } } as AgentSessionEvent);
    first.emit({ type: "tool_execution_update", toolCallId: "branch-tool", toolName: "bash", args: { command: "echo test" }, partialResult: { content: "partial" } } as AgentSessionEvent);
    first.emit({ type: "tool_execution_end", toolCallId: "branch-tool", toolName: "bash", result: { content: "done" }, isError: false } as AgentSessionEvent);
    assert.equal(first.branchReads(), 1);

    control.observe();
    assert.equal(first.branchReads(), 1);
    control.readTimeline();
    assert.equal(first.branchReads(), 1);

    const second = fakeSession("branch-count-2", branchEntries());
    await native.replace(second);
    assert.equal(first.branchReads(), 1);
    assert.equal(second.branchReads(), 1);
    assert.equal(first.branchReads() + second.branchReads(), 2);
  } finally { control.dispose(); }
});

test("Control echoes successful prompt, steer and followUp deliveries once and reconciles persisted user entries", async () => {
  const session = fakeSession("delivery-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const lease = control.observe().lease;
    await control.input({ lease, text: "prompt echo" });
    session.start();
    await control.input({ lease, text: "steer echo" });
    await control.input({ lease, text: "follow echo", timing: "after_current_run" });
    const echoes = control.readTimeline().timeline.filter((block) => block.type === "message" && block.role === "user");
    assert.deepEqual(echoes.map(({ text, source, delivery }) => [text, source, delivery]), [
      ["prompt echo", "live", "prompt"], ["steer echo", "live", "steer"], ["follow echo", "live", "followUp"],
    ]);
    session.emit({ type: "entry_appended", entry: { type: "message", id: "persisted-user", parentId: null, timestamp: "2026-09-24T00:00:03Z", message: { role: "user", content: [{ type: "text", text: "prompt echo" }] } } as never } as AgentSessionEvent);
    const matches = control.readTimeline().timeline.filter((block) => block.type === "message" && block.role === "user" && block.text === "prompt echo");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source, "session");

    (session.session as unknown as { steer: () => Promise<void> }).steer = () => { throw new Error("failed synchronously"); };
    await assert.rejects(control.input({ lease, text: "must not echo" }), (error: unknown) => error instanceof PindieControlError && error.code === "delivery_uncertain" && error.receipt?.nextAction === "wait_observe_do_not_resend");
    assert.equal(control.readTimeline().timeline.some((block) => block.type === "message" && block.text === "must not echo"), false);
  } finally { control.dispose(); }
});

test("Control wait handles immediate, event-driven, interrupted, timeout and replacement results", async () => {
  const session = fakeSession("wait-session", []);
  const native = fakeNativeRuntime(session);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(native.runtime), { current: () => ({ snapshot: () => presentation }) });
  await control.start();
  try {
    const initial = control.observe();
    assert.equal((await control.wait({ lease: initial.lease, until: "settled" })).reason, "settled");
    assert.equal((await control.wait({ lease: initial.lease, until: "meaningful_change", afterRevision: Math.max(0, initial.revision - 1) })).reason, "changed");
    assert.throws(() => control.wait({ lease: initial.lease, until: "meaningful_change" }), (error: unknown) => error instanceof PindieControlError && error.code === "invalid_request");
    assert.throws(() => control.wait({ lease: initial.lease, until: "settled", timeoutSeconds: 31 }), (error: unknown) => error instanceof PindieControlError && error.code === "invalid_request");
    assert.throws(() => control.wait({ lease: "stale", until: "settled" }), (error: unknown) => error instanceof PindieControlError && error.code === "stale_control_lease");

    const after = control.observe().revision;
    const change = control.wait({ lease: initial.lease, until: "meaningful_change", afterRevision: after, timeoutSeconds: 2 });
    const sharedChange = control.wait({ lease: initial.lease, until: "meaningful_change", afterRevision: after, timeoutSeconds: 2 });
    session.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "started" }] } } as AgentSessionEvent);
    assert.deepEqual((await Promise.all([change, sharedChange])).map(({ reason }) => reason), ["changed", "changed"]);

    session.start();
    const settledWait = control.wait({ lease: initial.lease, until: "settled", timeoutSeconds: 2 });
    session.settle();
    assert.equal((await settledWait).reason, "settled");

    session.start();
    await control.input({ lease: initial.lease, text: "queued work" });
    const queuedWait = control.wait({ lease: initial.lease, until: "settled", timeoutSeconds: 2 });
    session.settle();
    let queuedResolved = false;
    void queuedWait.then(() => { queuedResolved = true; });
    await Promise.resolve();
    assert.equal(queuedResolved, false);
    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.equal((await queuedWait).reason, "settled");

    presentation = presentationFor(activeState(), { quotaResumeWaiting: { sessionId: "wait-session", resumeAt: 1234 } });
    session.start();
    const quotaWait = control.wait({ lease: initial.lease, until: "settled", timeoutSeconds: 2 });
    session.settle();
    let quotaResolved = false;
    void quotaWait.then(() => { quotaResolved = true; });
    await Promise.resolve();
    assert.equal(quotaResolved, false);
    presentation = presentationFor(activeState());
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.equal((await quotaWait).reason, "settled");

    session.start();
    const gateWait = control.wait({ lease: initial.lease, until: "settled", timeoutSeconds: 2 });
    presentation = presentationFor(activeState({ kind: "approval", question: "Approve?", options: ["Yes", "No"] }));
    session.emit({ type: "agent_end", willRetry: false } as AgentSessionEvent);
    assert.equal((await gateWait).reason, "human_gate");
    assert.equal((await control.wait({ lease: initial.lease, until: "human_gate" })).reason, "human_gate");

    presentation = presentationFor(activeState());
    const pendingTimeout = control.wait({ lease: initial.lease, until: "human_gate", timeoutSeconds: 1 });
    assert.equal((await pendingTimeout).reason, "timeout");

    const oldLease = control.observe().lease;
    const changedBinding = control.wait({ lease: oldLease, until: "human_gate", timeoutSeconds: 5 });
    await native.replace(fakeSession("wait-replacement", []));
    assert.equal((await changedBinding).reason, "binding_changed");
    assert.equal(control.observe().session.id, "wait-replacement");
  } finally { control.dispose(); }
});

test("empty terminal errors wake meaningful_change with sanitized diagnostics", async () => {
  const session = fakeSession("error-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const before = control.observe();
    const waiting = control.wait({ lease: before.lease, until: "meaningful_change", afterRevision: before.revision, timeoutSeconds: 2 });
    session.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 auth failed token=secret-value" } } as unknown as AgentSessionEvent);
    assert.equal((await waiting).reason, "changed");
    const after = control.observe();
    assert.ok(after.revision > before.revision);
    assert.deepEqual(after.latestAssistant, { entryId: "live:error-session:assistant:1", text: "", lifecycle: "error", source: "assistant", errorMessage: "401 auth failed token=[REDACTED]" });
    assert.deepEqual(after.semantic, before.semantic);
    assert.ok(!JSON.stringify(control.readTimeline()).includes("secret-value"));
  } finally { control.dispose(); }
});

test("Control disposal resolves pending waiters without retaining timers", async () => {
  const session = fakeSession("dispose-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  const snapshot = control.observe();
  const pending = control.wait({ lease: snapshot.lease, until: "human_gate", timeoutSeconds: 30 });
  control.dispose();
  assert.equal((await pending).reason, "binding_changed");
});

test("Control configure changes explicit model/thinking only at a safe idle boundary", async () => {
  const session = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(session);
  const runtime = new PiRuntimeAdapter(native.runtime);
  let presentation = presentationFor(activeState(), { reasoningMode: "manual" });
  const control = new PindieControlClient(
    runtime,
    { current: () => ({ snapshot: () => presentation }) },
    { createLease: () => "lease-1" },
  );

  await control.start();
  try {
    const lease = control.observe().lease;
    const configured = await control.configure({
      lease,
      model: { provider: "openai-codex", modelId: "gpt-6-luna" },
      thinkingLevel: "high",
    });
    assert.deepEqual(configured.executionConfig.model, {
      provider: "openai-codex",
      modelId: "gpt-6-luna",
    });
    assert.equal(configured.executionConfig.thinkingLevel, "high");
    assert.equal(configured.executionConfig.reasoningMode, "manual");

    await assert.rejects(
      control.configure({
        lease,
        model: { provider: "missing", modelId: "missing" },
      }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "model_unavailable",
    );

    // Fixed native thinking mutations also work when the legacy mode is null.
    presentation = presentationFor(activeState(), { reasoningMode: null });
    const fixed = await control.configure({ lease, thinkingLevel: "medium" });
    assert.equal(fixed.executionConfig.thinkingLevel, "medium");
    assert.equal(fixed.executionConfig.reasoningMode, null);

    session.start();
    await assert.rejects(
      control.configure({
        lease,
        model: { provider: "openai-codex", modelId: "gpt-6-sol" },
      }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "unsafe_runtime_state",
    );
  } finally {
    control.dispose();
  }
});

/**
 * Native assistant turn: message_start → message_update → message_end, the same
 * public events Pi emits (regular messages are persisted without entry_appended).
 */
function emitAssistant(
  session: FakeSessionControl,
  text: string,
  options: { readonly stopReason?: string; readonly errorMessage?: string } = {},
): void {
  session.emit({ type: "message_start", message: { role: "assistant", content: [] } } as AgentSessionEvent);
  if (text !== "") {
    session.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text }] },
    } as AgentSessionEvent);
  }
  session.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: text === "" ? [] : [{ type: "text", text }],
      stopReason: options.stopReason ?? "stop",
      ...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
    },
  } as AgentSessionEvent);
}

function latestDispatch(snapshot: { dispatches: readonly { dispatchId: string }[] }) {
  return snapshot.dispatches.at(-1)!;
}

test("accepted dispatch keeps one identity across Run start, native output and settlement", async () => {
  const session = fakeSession("dispatch-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const before = control.observe();
    assert.deepEqual(before.dispatches, []);

    const accepted = await control.input({ lease: before.lease, text: "Implement the slice" });
    assert.equal(accepted.dispatch.dispatchId, "live:dispatch-session:control:1");
    assert.equal(accepted.dispatch.delivery, "prompt");
    // Pi accepted the prompt; the Run itself has not started yet.
    assert.equal(accepted.dispatch.state, "accepted");
    assert.equal(accepted.dispatch.runId, null);
    assert.equal(accepted.dispatch.output, null);
    assert.equal(accepted.dispatch.acceptedRevision, before.revision);

    session.start();
    const running = latestDispatch(control.observe());
    assert.equal(running.dispatchId, accepted.dispatch.dispatchId);
    assert.equal(running.state, "running");
    assert.equal(running.runId, "dispatch-session:run:1");

    emitAssistant(session, "Implemented.");
    const streaming = latestDispatch(control.observe());
    assert.equal(streaming.state, "running");
    assert.deepEqual(streaming.output, { entryIds: ["live:dispatch-session:assistant:1"], lifecycle: "complete" });

    session.settle();
    const settled = control.observe();
    assert.equal(latestDispatch(settled).state, "complete");
    assert.deepEqual(latestDispatch(settled).output, {
      entryIds: ["live:dispatch-session:assistant:1"],
      lifecycle: "complete",
    });

    const timeline = control.readTimeline().timeline;
    const delivered = timeline.find((block) => block.type === "message" && block.role === "user");
    assert.equal(delivered?.type === "message" ? delivered.id : null, accepted.dispatch.dispatchId);
    assert.equal(delivered?.type === "message" ? delivered.dispatchId : null, accepted.dispatch.dispatchId);
    assert.equal(delivered?.type === "message" ? delivered.delivery : null, "prompt");
  } finally { control.dispose(); }
});

test("repeated identical inputs and separate Runs keep distinct dispatch identities and outputs", async () => {
  const session = fakeSession("repeat-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const first = await control.input({ lease: control.observe().lease, text: "Continue" });
    session.start();
    emitAssistant(session, "First run.");
    session.settle();

    const second = await control.input({ lease: control.observe().lease, text: "Continue" });
    session.start();
    emitAssistant(session, "Second run.");
    session.settle();

    assert.notEqual(first.dispatch.dispatchId, second.dispatch.dispatchId);
    assert.equal(second.dispatch.dispatchId, "live:repeat-session:control:2");
    const dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["complete", "complete"]);
    assert.deepEqual(dispatches.map(({ runId }) => runId), ["repeat-session:run:1", "repeat-session:run:2"]);
    assert.deepEqual(dispatches.map(({ output }) => output?.entryIds), [
      ["live:repeat-session:assistant:1"],
      ["live:repeat-session:assistant:2"],
    ]);
  } finally { control.dispose(); }
});

test("busy steer attaches to the current Run and reports queue consumption", async () => {
  const session = fakeSession("busy-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const prompt = await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();

    const steer = await control.input({ lease: control.observe().lease, text: "Also check logs", timing: "now" });
    assert.equal(steer.dispatch.delivery, "steer");
    assert.equal(steer.dispatch.runId, "busy-session:run:1");
    session.emit({ type: "queue_update", steering: ["Also check logs"], followUp: [] } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "queued");

    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "running");

    emitAssistant(session, "Checked.");
    session.settle();
    const dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ dispatchId }) => dispatchId), [prompt.dispatch.dispatchId, steer.dispatch.dispatchId]);
    assert.deepEqual(dispatches.map(({ runId }) => runId), ["busy-session:run:1", "busy-session:run:1"]);
    assert.deepEqual(dispatches.map(({ state }) => state), ["complete", "complete"]);
    assert.deepEqual(dispatches.map(({ output }) => output?.entryIds), [
      ["live:busy-session:assistant:1"],
      ["live:busy-session:assistant:1"],
    ]);
  } finally { control.dispose(); }
});

test("identical queued steer texts keep distinct identities as each is consumed", async () => {
  const session = fakeSession("identical-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const first = await control.input({ lease: control.observe().lease, text: "Check the logs", timing: "now" });
    const second = await control.input({ lease: control.observe().lease, text: "Check the logs", timing: "now" });
    assert.notEqual(first.dispatch.dispatchId, second.dispatch.dispatchId);
    assert.equal(first.dispatch.runId, "identical-session:run:1");
    assert.equal(second.dispatch.runId, "identical-session:run:1");

    session.emit({
      type: "queue_update",
      steering: ["Check the logs", "Check the logs"],
      followUp: [],
    } as AgentSessionEvent);
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "queued", "queued"]);

    // Pi removes the first matching queued text: the earlier dispatch is consumed.
    session.queue.steering.length = 1;
    session.emit({ type: "queue_update", steering: ["Check the logs"], followUp: [] } as AgentSessionEvent);
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "running", "queued"]);
    assert.deepEqual(dispatches.map(({ dispatchId }) => dispatchId), [
      dispatches[0]!.dispatchId,
      first.dispatch.dispatchId,
      second.dispatch.dispatchId,
    ]);

    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["running", "running", "running"]);

    emitAssistant(session, "Checked both.");
    session.settle();
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["complete", "complete", "complete"]);
    assert.equal(new Set(dispatches.map(({ dispatchId }) => dispatchId)).size, 3);
    assert.deepEqual(dispatches.map(({ runId }) => runId), [
      "identical-session:run:1",
      "identical-session:run:1",
      "identical-session:run:1",
    ]);
  } finally { control.dispose(); }
});

test("identical queued followUp texts keep distinct identities as each is consumed", async () => {
  const session = fakeSession("identical-followup-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const first = await control.input({ lease: control.observe().lease, text: "Check the logs", timing: "after_current_run" });
    const second = await control.input({ lease: control.observe().lease, text: "Check the logs", timing: "after_current_run" });
    assert.equal(first.dispatch.delivery, "followUp");
    assert.equal(second.dispatch.delivery, "followUp");
    assert.notEqual(first.dispatch.dispatchId, second.dispatch.dispatchId);

    session.emit({
      type: "queue_update",
      steering: [],
      followUp: ["Check the logs", "Check the logs"],
    } as AgentSessionEvent);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["running", "queued", "queued"]);

    // Pi removes the first matching followUp text.
    session.queue.followUp.length = 1;
    session.emit({ type: "queue_update", steering: [], followUp: ["Check the logs"] } as AgentSessionEvent);
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "running", "queued"]);
    assert.deepEqual(dispatches.map(({ dispatchId }) => dispatchId), [
      dispatches[0]!.dispatchId,
      first.dispatch.dispatchId,
      second.dispatch.dispatchId,
    ]);

    session.queue.followUp.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["running", "running", "running"]);

    emitAssistant(session, "Checked both later.");
    session.settle();
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["complete", "complete", "complete"]);
    assert.equal(new Set(dispatches.map(({ dispatchId }) => dispatchId)).size, 3);
  } finally { control.dispose(); }
});

test("the same text queued as steer and followUp consumes the steering entry first", async () => {
  const session = fakeSession("mixed-queue-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const steer = await control.input({ lease: control.observe().lease, text: "Same text", timing: "now" });
    const followUp = await control.input({ lease: control.observe().lease, text: "Same text", timing: "after_current_run" });
    assert.notEqual(steer.dispatch.dispatchId, followUp.dispatch.dispatchId);

    session.emit({
      type: "queue_update",
      steering: ["Same text"],
      followUp: ["Same text"],
    } as AgentSessionEvent);
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "queued", "queued"]);

    // Pi checks the steering queue first, so the steer delivery is consumed.
    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: ["Same text"] } as AgentSessionEvent);
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "running", "queued"]);
    assert.equal(dispatches[1]?.dispatchId, steer.dispatch.dispatchId);
    assert.equal(dispatches[2]?.dispatchId, followUp.dispatch.dispatchId);

    session.queue.followUp.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["running", "running", "running"]);
  } finally { control.dispose(); }
});

test("terminal error, lost output and abort are never reported as dispatch success", async () => {
  const session = fakeSession("terminal-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Failing work" });
    session.start();
    emitAssistant(session, "", { stopReason: "error", errorMessage: "401 auth failed token=secret-value" });
    session.settle();
    const failed = latestDispatch(control.observe());
    assert.equal(failed.state, "error");
    assert.equal(failed.output?.lifecycle, "error");
    assert.deepEqual(failed.output?.entryIds, ["live:terminal-session:assistant:1"]);
    assert.equal(failed.output?.errorMessage, "401 auth failed token=[REDACTED]");
    assert.ok(!JSON.stringify(control.observe()).includes("secret-value"));
    const failedWait = await control.wait({ lease: control.observe().lease, until: "settled" });
    assert.equal(failedWait.reason, "settled");
    assert.equal(latestDispatch(failedWait.snapshot!).state, "error");
    const errorBlock = control.readTimeline().timeline.find((entry) => entry.id === failed.output?.entryIds[0]);
    assert.equal(errorBlock?.type === "message" ? errorBlock.errorMessage : null, failed.output?.errorMessage);

    await control.input({ lease: control.observe().lease, text: "Silent work" });
    session.start();
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "no_result");
    assert.equal(latestDispatch((await control.wait({ lease: control.observe().lease, until: "settled" })).snapshot!).state, "no_result");

    await control.input({ lease: control.observe().lease, text: "Aborted work" });
    session.start();
    session.emit({ type: "agent_settled", aborted: true } as AgentSessionEvent);
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "cancelled");
    assert.equal(latestDispatch((await control.wait({ lease: control.observe().lease, until: "settled" })).snapshot!).state, "cancelled");
  } finally { control.dispose(); }
});

test("a settled Run without terminal assistant completion is no_result, not complete", async () => {
  const session = fakeSession("unterminated-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Streamed work" });
    session.start();
    // Streaming text without message_end leaves no recorded terminal lifecycle.
    session.emit({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    } as AgentSessionEvent);
    session.settle();
    const dispatch = latestDispatch(control.observe());
    assert.equal(dispatch.state, "no_result");
    assert.equal(dispatch.output?.lifecycle, null);
    assert.deepEqual(dispatch.output?.entryIds, ["live:unterminated-session:assistant:1"]);
  } finally { control.dispose(); }
});

test("a followUp still queued when the Run settles is cancelled, not completed", async () => {
  const session = fakeSession("unconsumed-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const prompt = await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const queued = await control.input({ lease: control.observe().lease, text: "Later work", timing: "after_current_run" });
    session.emit({
      type: "queue_update",
      steering: [],
      followUp: ["Later work"],
    } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "queued");

    emitAssistant(session, "Main answer.");
    session.settle();
    const dispatches = control.observe().dispatches;
    assert.equal(dispatches[0]?.dispatchId, prompt.dispatch.dispatchId);
    assert.equal(dispatches[0]?.state, "complete");
    assert.equal(dispatches[1]?.dispatchId, queued.dispatch.dispatchId);
    assert.equal(dispatches[1]?.state, "cancelled");
  } finally { control.dispose(); }
});

test("binding to an already compacting Session does not adopt a phantom Run", async () => {
  const session = fakeSession("compacting-session", []);
  session.compacting();
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const steer = await control.input({ lease: control.observe().lease, text: "guidance", timing: "now" });
    assert.equal(steer.dispatch.delivery, "steer");
    // No Run was adopted, so the dispatch stays unattached until a real agent_start.
    assert.deepEqual(steer.dispatch.runIds, []);
    assert.equal(steer.dispatch.runId, null);
    assert.ok(["accepted", "queued"].includes(steer.dispatch.state));

    session.start();
    const attached = latestDispatch(control.observe());
    assert.deepEqual(attached.runIds, ["compacting-session:run:1"]);
    assert.equal(attached.state, "running");
  } finally { control.dispose(); }
});

test("binding to an already streaming Session adopts the current Run for busy input", async () => {
  const session = fakeSession("adopted-session", []);
  // The native Run starts before Control binds, so agent_start is missed.
  session.start();
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const steer = await control.input({ lease: control.observe().lease, text: "mid-run guidance", timing: "now" });
    assert.equal(steer.dispatch.delivery, "steer");
    assert.deepEqual(steer.dispatch.runIds, ["adopted-session:run:1"]);
    assert.equal(steer.dispatch.runId, "adopted-session:run:1");

    session.emit({ type: "queue_update", steering: ["mid-run guidance"], followUp: [] } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "queued");
    session.queue.steering.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    assert.equal(latestDispatch(control.observe()).state, "running");

    emitAssistant(session, "Applied mid-run.");
    session.settle();
    const settled = latestDispatch(control.observe());
    assert.equal(settled.state, "complete");
    assert.deepEqual(settled.output?.entryIds, ["live:adopted-session:assistant:1"]);
  } finally { control.dispose(); }
});

test("a pinned dispatch keeps its Run and output past the Run retention window", async () => {
  const session = fakeSession("retained-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    const accepted = await control.input({ lease: control.observe().lease, text: "First work" });
    session.start();
    emitAssistant(session, "First answer.");
    session.settle();

    const waiting = control.wait({ lease: control.observe().lease, until: "human_gate", timeoutSeconds: 3 });
    for (let index = 0; index < 9; index += 1) {
      await control.input({ lease: control.observe().lease, text: `Later work ${index}` });
      session.start();
      emitAssistant(session, `Later answer ${index}.`);
      session.settle();
    }
    // Ten Runs occurred; only the pinned dispatch's Run must still be resolvable.
    assert.equal(control.observe().dispatches[0]?.dispatchId, accepted.dispatch.dispatchId);
    assert.equal(control.observe().dispatches[0]?.state, "complete");
    assert.deepEqual(control.observe().dispatches[0]?.output?.entryIds, ["live:retained-session:assistant:1"]);

    presentation = presentationFor(activeState({ kind: "approval", question: "Approve?" }));
    session.emit({ type: "agent_end", willRetry: false } as AgentSessionEvent);
    const result = await waiting;
    assert.equal(result.reason, "human_gate");
    const retained = result.snapshot?.dispatches.find(({ dispatchId }) => dispatchId === accepted.dispatch.dispatchId);
    assert.ok(retained !== undefined);
    assert.deepEqual(retained.runIds, ["retained-session:run:1"]);
    assert.equal(retained.state, "complete");
    assert.deepEqual(retained.output?.entryIds, ["live:retained-session:assistant:1"]);
  } finally { control.dispose(); }
});

test("pending dispatches are never evicted and the backlog fails closed", async () => {
  const session = fakeSession("backlog-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Main work" });
    session.start();
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push((await control.input({
        lease: control.observe().lease,
        text: `Pending work ${index}`,
        timing: "after_current_run",
      })).dispatch.dispatchId);
    }
    // More pending dispatches than the terminal-history bound are all retained.
    assert.equal(control.observe().dispatches.length, 7);
    assert.deepEqual(control.observe().dispatches.slice(1).map(({ dispatchId }) => dispatchId), ids);

    let delivered = 6;
    while (true) {
      try {
        await control.input({
          lease: control.observe().lease,
          text: `Overflow work ${delivered}`,
          timing: "after_current_run",
        });
      } catch (error) {
        assert.ok(error instanceof PindieControlError);
        assert.equal(error.code, "dispatch_backlog_full");
        break;
      }
      delivered += 1;
      assert.ok(delivered <= 31, "backlog bound must fail closed at 32 pending dispatches");
    }
    // 32 pending dispatches total (one prompt plus 31 queued followUps).
    assert.equal(delivered, 31);
    // Denial happens before delivery: Pi never received the rejected input.
    assert.equal(session.followUps.length, 31);
    assert.equal(control.observe().dispatches.length, 32);
  } finally { control.dispose(); }
});

test("every dispatch of a failed Run continues through an observed quota recovery", async () => {
  const session = fakeSession("quota-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    const prompt = await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    const steer = await control.input({ lease: control.observe().lease, text: "Also check logs", timing: "now" });
    const followUp = await control.input({ lease: control.observe().lease, text: "Then summarize", timing: "after_current_run" });
    session.emit({
      type: "queue_update",
      steering: ["Also check logs"],
      followUp: ["Then summarize"],
    } as AgentSessionEvent);
    // Both guidance messages are consumed by the same Run before it fails.
    session.queue.steering.length = 0;
    session.queue.followUp.length = 0;
    session.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent);
    failRun(session, "entry-quota-1", "429 quota exceeded");
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "error", "error"]);
    assert.deepEqual(control.observe().dispatches.map(({ runIds }) => runIds), [
      ["quota-session:run:1"],
      ["quota-session:run:1"],
      ["quota-session:run:1"],
    ]);

    // Pindie reports the wait for exactly this incident anchor.
    presentation = quotaPresentation(activeState(), quotaStatus("quota-session", "entry-quota-1"));
    assert.equal(control.observe().recovery.quotaWaiting?.sessionId, "quota-session");
    assert.equal(control.observe().recovery.quotaWaiting?.anchorEntryId, "entry-quota-1");
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["waiting", "waiting", "waiting"]);
    // Supervisor clears the wait immediately before the message.
    presentation = quotaPresentation(activeState(), quotaStatus("quota-session", "entry-quota-1", "wake_started"));
    // Auto Resume starts the successor Run (agent_start precedes its message).
    session.start();
    // Only the real hidden resume message authorizes continuation.
    session.emit(resumeMessage("entry-quota-1"));
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["running", "running", "running"]);
    assert.deepEqual(dispatches.map(({ runIds }) => runIds), [
      ["quota-session:run:1", "quota-session:run:2"],
      ["quota-session:run:1", "quota-session:run:2"],
      ["quota-session:run:1", "quota-session:run:2"],
    ]);
    assert.deepEqual(dispatches.map(({ runId }) => runId), ["quota-session:run:1", "quota-session:run:1", "quota-session:run:1"]);

    emitAssistant(session, "Recovered and finished.");
    session.persistAssistant("entry-quota-2", { role: "assistant", content: [], stopReason: "stop" });
    session.settle();
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["complete", "complete", "complete"]);
    assert.deepEqual(dispatches.map(({ dispatchId }) => dispatchId), [
      prompt.dispatch.dispatchId,
      steer.dispatch.dispatchId,
      followUp.dispatch.dispatchId,
    ]);
    for (const dispatch of dispatches) {
      assert.deepEqual(dispatch.output?.entryIds, [
        "live:quota-session:assistant:1",
        "live:quota-session:assistant:2",
      ]);
    }

    // A later Run after recorded success is not retroactively absorbed.
    session.start();
    emitAssistant(session, "Unrelated follow-up.");
    session.settle();
    assert.deepEqual(latestDispatch(control.observe()).runIds, ["quota-session:run:1", "quota-session:run:2"]);
  } finally { control.dispose(); }
});

test("an unrelated failed dispatch is not continued by another dispatch's quota recovery", async () => {
  const session = fakeSession("cross-incident-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    // A fails for an authentication reason: unrelated to any quota incident.
    const authFailed = await control.input({ lease: control.observe().lease, text: "Auth-bound work" });
    session.start();
    failRun(session, "entry-auth", "401 invalid api key");
    // B fails with the real quota incident.
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-quota", "429 quota exceeded");

    // Only B's incident enters the wait; A must not be reclassified.
    presentation = quotaPresentation(activeState(), quotaStatus("cross-incident-session", "entry-quota"));
    const waiting = control.observe().dispatches;
    assert.deepEqual(waiting.map(({ state }) => state), ["error", "waiting"]);
    assert.deepEqual(waiting[0]?.runIds, ["cross-incident-session:run:1"]);
    assert.deepEqual(waiting[0]?.output?.entryIds, ["live:cross-incident-session:assistant:1"]);

    presentation = quotaPresentation(activeState(), quotaStatus("cross-incident-session", "entry-quota", "wake_started"));
    session.start();
    session.emit(resumeMessage("entry-quota"));
    let dispatches = control.observe().dispatches;
    // A is untouched; B continues into the successor Run.
    assert.deepEqual(dispatches[0]?.runIds, ["cross-incident-session:run:1"]);
    assert.equal(dispatches[0]?.state, "error");
    assert.deepEqual(dispatches[1]?.runIds, ["cross-incident-session:run:2", "cross-incident-session:run:3"]);

    emitAssistant(session, "Recovered.");
    session.persistAssistant("entry-quota-ok", { role: "assistant", content: [], stopReason: "stop" });
    session.settle();
    dispatches = control.observe().dispatches;
    assert.equal(dispatches[0]?.dispatchId, authFailed.dispatch.dispatchId);
    assert.equal(dispatches[0]?.state, "error");
    assert.deepEqual(dispatches[0]?.runIds, ["cross-incident-session:run:1"]);
    assert.deepEqual(dispatches[0]?.output?.entryIds, ["live:cross-incident-session:assistant:1"]);
    assert.equal(dispatches[1]?.state, "complete");
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
  } finally { control.dispose(); }
});

test("an aborted error Run is excluded from quota continuation", async () => {
  const session = fakeSession("aborted-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Aborted work" });
    session.start();
    failRun(session, "entry-aborted", "429 quota exceeded", { aborted: true });
    await control.input({ lease: control.observe().lease, text: "Quota work" });
    session.start();
    failRun(session, "entry-quota", "429 quota exceeded");

    // Only B's real incident enters the wait; the aborted error never does.
    presentation = quotaPresentation(activeState(), quotaStatus("aborted-session", "entry-quota"));
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["cancelled", "waiting"]);

    presentation = quotaPresentation(activeState(), quotaStatus("aborted-session", "entry-quota", "wake_started"));
    session.start();
    session.emit(resumeMessage("entry-quota"));
    const dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches[0]?.runIds, ["aborted-session:run:1"]);
    assert.equal(dispatches[0]?.state, "cancelled");
    assert.deepEqual(dispatches[1]?.runIds, ["aborted-session:run:2", "aborted-session:run:3"]);
    assert.equal(dispatches[1]?.state, "running");
  } finally { control.dispose(); }
});

test("terminal quota abandonment releases protection without false completion", async () => {
  for (const phase of ["cancelled", "invalidated", "wake_failed"] as const) {
    const session = fakeSession(`abandon-${phase}-session`, []);
    let presentation = presentationFor(activeState());
    const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
      current: () => ({ snapshot: () => presentation }),
    });
    await control.start();
    try {
      await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
      session.start();
      failRun(session, "entry-abandon", "429 quota exceeded");
      const anchor = "entry-abandon";
      presentation = quotaPresentation(activeState(), quotaStatus(`abandon-${phase}-session`, anchor));
      assert.equal(latestDispatch(control.observe()).state, "waiting");
      assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "timeout");

      presentation = quotaPresentation(activeState(), quotaStatus(`abandon-${phase}-session`, anchor, phase));
      // The failed dispatch is released to its factual terminal error.
      assert.equal(latestDispatch(control.observe()).state, "error");
      assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
    } finally { control.dispose(); }
  }
});

test("the wait-clear to resume-message gap keeps failed work waiting, not settled", async () => {
  const session = fakeSession("gap-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-gap-1", "429 quota exceeded");

    // Supervisor publishes the wait, then clears it immediately before the
    // hidden resume message: neither clearing nor the reported wake gap may
    // erase the protection.
    presentation = quotaPresentation(activeState(), quotaStatus("gap-session", "entry-gap-1"));
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    presentation = presentationFor(activeState());
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    presentation = quotaPresentation(activeState(), quotaStatus("gap-session", "entry-gap-1", "wake_started"));
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "timeout");

    // Supervisor wakes the work: Pi starts the Run, then emits the resume message.
    session.start();
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    session.emit(resumeMessage("entry-gap-1"));
    session.emit({
      type: "message_end",
      message: { role: "custom", customType: "pindie-quota-resume", content: [], display: false },
    } as AgentSessionEvent);
    const resumed = latestDispatch(control.observe());
    assert.deepEqual(resumed.runIds, ["gap-session:run:1", "gap-session:run:2"]);
    assert.equal(resumed.state, "running");

    emitAssistant(session, "Recovered.");
    session.persistAssistant("entry-gap-2", { role: "assistant", content: [], stopReason: "stop" });
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "complete");
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
  } finally { control.dispose(); }
});

test("a resume message observed before agent_start still continues the failed Run", async () => {
  const session = fakeSession("early-resume-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-early-1", "429 quota exceeded");
    presentation = quotaPresentation(activeState(), quotaStatus("early-resume-session", "entry-early-1"));
    control.observe();
    presentation = quotaPresentation(activeState(), quotaStatus("early-resume-session", "entry-early-1", "wake_started"));

    // Alternate ordering (queued custom message): the message precedes the Run.
    session.emit(resumeMessage("entry-early-1"));
    session.start();
    const resumed = latestDispatch(control.observe());
    assert.deepEqual(resumed.runIds, ["early-resume-session:run:1", "early-resume-session:run:2"]);
    assert.equal(resumed.state, "running");
  } finally { control.dispose(); }
});

test("quota plan replacement reconciles protection through headless Presentation without intermediate reads", async () => {
  const sessionId = "replacement-session";
  const session = fakeSession(sessionId, []);
  const presentation = createHeadlessPresentation();
  presentation.setStatusContext(headlessContext(sessionId));
  const runtime = new PiRuntimeAdapter(fakeNativeRuntime(session).runtime);
  const control = new PindieControlClient(runtime, {
    current: () => ({ snapshot: () => presentation.snapshot() }),
  });
  const phases: string[] = [];
  const timers: Array<() => void> = [];
  let rejectWake!: (error: Error) => void;
  // Deterministic send fixture: hold before any native successor/message event.
  session.session.sendCustomMessage = () => new Promise<void>((_resolve, reject) => { rejectWake = reject; });
  const supervisor = new QuotaResumeSupervisor(runtime, {
    now: () => 1000,
    schedule: (_delay, callback) => { timers.push(callback); return () => undefined; },
    logger: () => undefined,
    onWaitingChange: (status) => {
      phases.push(`${status?.anchorEntryId}:${status?.phase}`);
      // Same projection as Extension wiring, with no Control read in between.
      presentation.setQuotaResumeEvent(status);
      presentation.setQuotaResumeWaiting(isQuotaResumeWaiting(status) ? status : null);
    },
  });
  const plan = (anchorEntryId: string) => ({
    sessionId, anchorEntryId, provider: "openai-codex" as const,
    modelId: "gpt-6-sol", detectedAt: 1000, resumeAt: 2000,
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "A" });
    session.start();
    failRun(session, "anchor-A", "The usage limit has been reached");
    await control.input({ lease: control.observe().lease, text: "B" });
    session.start();
    failRun(session, "anchor-B", "The usage limit has been reached");
    const failed = control.observe().dispatches;
    assert.equal(supervisor.request(plan("anchor-A")), true);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["waiting", "error"]);

    // request() synchronously publishes A cancelled, then B waiting. Presentation
    // exposes only B's latest status; Control must not need to see A's event.
    assert.equal(supervisor.request(plan("anchor-B")), true);
    assert.deepEqual(phases, ["anchor-A:waiting", "anchor-A:cancelled", "anchor-B:waiting"]);
    assert.equal(presentation.snapshot().quotaResumeEvent?.anchorEntryId, "anchor-B");
    const replaced = control.observe().dispatches;
    assert.deepEqual(replaced.map(({ state }) => state), ["error", "waiting"]);
    assert.deepEqual(replaced.map(({ runIds, output }) => ({ runIds, output })),
      failed.map(({ runIds, output }) => ({ runIds, output })));

    supervisor.cancel(sessionId);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "error"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");

    // A replacement can itself be cancelled before any Control observation.
    assert.equal(supervisor.request(plan("anchor-A")), true);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["waiting", "error"]);
    assert.equal(supervisor.request(plan("anchor-B")), true);
    supervisor.cancel(sessionId);
    assert.equal(presentation.snapshot().quotaResumeEvent?.anchorEntryId, "anchor-B");
    assert.equal(presentation.snapshot().quotaResumeEvent?.phase, "cancelled");
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "error"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");

    // Once B replaces A, its protection must survive the wake-started gap.
    assert.equal(supervisor.request(plan("anchor-A")), true);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["waiting", "error"]);
    assert.equal(supervisor.request(plan("anchor-B")), true);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "waiting"]);
    timers.at(-1)!();
    assert.equal(presentation.snapshot().quotaResumeEvent?.phase, "wake_started");
    assert.equal(presentation.snapshot().quotaResumeWaiting, null);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "waiting"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "timeout");

    // A wrong-Session plan cannot supersede B or release its gap protection.
    assert.equal(supervisor.request({ ...plan("anchor-A"), sessionId: "other-session" }), false);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "waiting"]);
    rejectWake(new Error("mock wake rejected"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(presentation.snapshot().quotaResumeEvent?.phase, "wake_failed");
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "error"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
    assert.deepEqual(control.observe().dispatches.map(({ runIds, output }) => ({ runIds, output })),
      failed.map(({ runIds, output }) => ({ runIds, output })));
  } finally {
    supervisor.dispose();
    control.dispose();
  }
});

test("foreign or unanchored quota status cannot replace current incident protection", async () => {
  const session = fakeSession("scope-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Quota work" });
    session.start();
    failRun(session, "anchor", "The usage limit has been reached");
    presentation = quotaPresentation(activeState(), quotaStatus("scope-session", "anchor"));
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    for (const phase of ["waiting", "wake_started", "cancelled"] as const) {
      presentation = quotaPresentation(activeState(), quotaStatus("other-session", "anchor", phase));
      assert.equal(latestDispatch(control.observe()).state, "waiting");
    }
    presentation = quotaPresentation(activeState(), { sessionId: "scope-session", resumeAt: 2000 });
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    presentation = quotaPresentation(activeState(), quotaStatus("scope-session", "anchor", "cancelled"));
    assert.equal(latestDispatch(control.observe()).state, "error");
  } finally { control.dispose(); }
});

test("headless Control observes quota-wait cancellation through Presentation", async () => {
  const session = fakeSession("headless-quota-session", []);
  const presentation = createHeadlessPresentation();
  presentation.setStatusContext(headlessContext("headless-quota-session"));
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation.snapshot() }),
  });
  await control.start();
  try {
    // A fails independently, then B fails on the real quota incident.
    await control.input({ lease: control.observe().lease, text: "Auth-bound work" });
    session.start();
    failRun(session, "entry-auth", "401 invalid api key");
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-quota", "429 quota exceeded");

    const waiting = quotaStatus("headless-quota-session", "entry-quota");
    presentation.setQuotaResumeEvent(waiting);
    presentation.setQuotaResumeWaiting(waiting);
    assert.deepEqual(presentation.snapshot().quotaResumeEvent, waiting);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "waiting"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "timeout");

    // Disabling Auto Resume reaches headless Control: protection is released.
    const cancelled = quotaStatus("headless-quota-session", "entry-quota", "cancelled");
    presentation.setQuotaResumeWaiting(null);
    presentation.setQuotaResumeEvent(cancelled);
    assert.deepEqual(control.observe().dispatches.map(({ state }) => state), ["error", "error"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
  } finally { control.dispose(); }
});

test("headless Control continues only the anchored incident on resume", async () => {
  const session = fakeSession("headless-resume-session", []);
  const presentation = createHeadlessPresentation();
  presentation.setStatusContext(headlessContext("headless-resume-session"));
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation.snapshot() }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Auth-bound work" });
    session.start();
    failRun(session, "entry-auth", "401 invalid api key");
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-quota", "429 quota exceeded");

    const waiting = quotaStatus("headless-resume-session", "entry-quota");
    presentation.setQuotaResumeEvent(waiting);
    presentation.setQuotaResumeWaiting(waiting);
    const wakeStarted = quotaStatus("headless-resume-session", "entry-quota", "wake_started");
    presentation.setQuotaResumeWaiting(null);
    presentation.setQuotaResumeEvent(wakeStarted);
    session.start();
    session.emit(resumeMessage("entry-quota"));
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches[0]?.runIds, ["headless-resume-session:run:1"]);
    assert.equal(dispatches[0]?.state, "error");
    assert.deepEqual(dispatches[1]?.runIds, ["headless-resume-session:run:2", "headless-resume-session:run:3"]);

    emitAssistant(session, "Recovered.");
    session.persistAssistant("entry-quota-ok", { role: "assistant", content: [], stopReason: "stop" });
    session.settle();
    dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches.map(({ state }) => state), ["error", "complete"]);
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");
  } finally { control.dispose(); }
});

test("a resume message without the validated incident anchor continues nothing", async () => {
  const session = fakeSession("anchorless-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-anchorless", "429 quota exceeded");
    presentation = quotaPresentation(activeState(), quotaStatus("anchorless-session", "entry-anchorless"));
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    presentation = quotaPresentation(activeState(), quotaStatus("anchorless-session", "entry-anchorless", "wake_started"));

    session.start();
    session.emit({
      type: "message_start",
      message: { role: "custom", customType: "pindie-quota-resume", content: [], display: false },
    } as AgentSessionEvent);
    const dispatches = control.observe().dispatches;
    // No anchor means no continuation: the failed dispatch stays factual.
    assert.deepEqual(dispatches[0]?.runIds, ["anchorless-session:run:1"]);
    assert.equal(dispatches[0]?.state, "error");
  } finally { control.dispose(); }
});

test("a quota wait alone never authorizes continuation of a failed dispatch", async () => {
  const session = fakeSession("no-resume-session", []);
  let presentation = presentationFor(activeState());
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentation }),
  });
  await control.start();
  try {
    const failed = await control.input({ lease: control.observe().lease, text: "Quota-bound work" });
    session.start();
    failRun(session, "entry-noresume-1", "429 quota exceeded");
    assert.equal(latestDispatch(control.observe()).state, "error");

    presentation = quotaPresentation(activeState(), quotaStatus("no-resume-session", "entry-noresume-1"));
    // The reported wait keeps failed work readable and unsettled, not successful.
    assert.equal(latestDispatch(control.observe()).state, "waiting");
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "timeout");
    // Auto Resume is cancelled explicitly (disable toggle): recovery is abandoned.
    presentation = quotaPresentation(activeState(), quotaStatus("no-resume-session", "entry-noresume-1", "cancelled"));
    assert.equal(latestDispatch(control.observe()).state, "error");
    assert.equal((await control.wait({ lease: control.observe().lease, until: "settled", timeoutSeconds: 1 })).reason, "settled");

    // The user dispatches unrelated work instead of Auto Resume waking the Run.
    const independent = await control.input({ lease: control.observe().lease, text: "Independent work" });
    session.start();
    let dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches[0]?.runIds, ["no-resume-session:run:1"]);
    assert.equal(dispatches[0]?.state, "error");
    assert.deepEqual(dispatches[1]?.runIds, ["no-resume-session:run:2"]);

    emitAssistant(session, "Independent answer.");
    session.settle();
    // A hidden resume message for another anchor changes nothing.
    session.emit(resumeMessage("some-other-anchor"));
    dispatches = control.observe().dispatches;
    assert.equal(dispatches[0]?.dispatchId, failed.dispatch.dispatchId);
    assert.deepEqual(dispatches[0]?.runIds, ["no-resume-session:run:1"]);
    assert.equal(dispatches[1]?.dispatchId, independent.dispatch.dispatchId);
    assert.deepEqual(dispatches[1]?.runIds, ["no-resume-session:run:2"]);
    assert.equal(dispatches[1]?.state, "complete");
  } finally { control.dispose(); }
});

test("an unrelated prompt after a terminal error does not inherit the failed dispatch", async () => {
  const session = fakeSession("independent-session", []);
  const control = new PindieControlClient(new PiRuntimeAdapter(fakeNativeRuntime(session).runtime), {
    current: () => ({ snapshot: () => presentationFor(activeState()) }),
  });
  await control.start();
  try {
    const failed = await control.input({ lease: control.observe().lease, text: "Failing work" });
    session.start();
    emitAssistant(session, "", { stopReason: "error", errorMessage: "boom" });
    session.settle();
    assert.equal(latestDispatch(control.observe()).state, "error");

    const independent = await control.input({ lease: control.observe().lease, text: "Independent work" });
    session.start();
    const dispatches = control.observe().dispatches;
    assert.deepEqual(dispatches[0]?.runIds, ["independent-session:run:1"]);
    assert.equal(dispatches[0]?.dispatchId, failed.dispatch.dispatchId);
    assert.equal(dispatches[0]?.state, "error");
    assert.deepEqual(dispatches[1]?.runIds, ["independent-session:run:2"]);
    assert.equal(dispatches[1]?.dispatchId, independent.dispatch.dispatchId);
    assert.equal(dispatches[1]?.state, "running");

    // An unsolicited Run without a dispatch or quota signal is not attributed either.
    emitAssistant(session, "Independent answer.");
    session.settle();
    session.start();
    emitAssistant(session, "Host continuation.");
    session.settle();
    assert.deepEqual(control.observe().dispatches[1]?.runIds, ["independent-session:run:2"]);
  } finally { control.dispose(); }
});
