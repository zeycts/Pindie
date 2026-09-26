import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  PindieControlClient,
  PindieControlError,
} from "../src/control-client.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import { deriveSemanticSnapshot, type SemanticRunFacts } from "../src/semantics.ts";
import type { HumanGate, PindieState } from "../src/state.ts";

interface FakeSessionControl {
  readonly session: AgentSession;
  readonly prompts: string[];
  readonly steers: string[];
  readonly followUps: string[];
  readonly queue: {
    steering: string[];
    followUp: string[];
  };
  readonly abortCalls: () => number;
  start(): void;
  settle(): void;
  emit(event: AgentSessionEvent): void;
}

function fakeSession(
  sessionId: string,
  entries: readonly SessionEntry[],
): FakeSessionControl {
  let idle = true;
  let streaming = false;
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let abortCalls = 0;
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
      getSessionName: () => "Pindie Control",
      getEntries: () => [...entries],
      getBranch: () => [...entries],
    },
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    prompt: async (text: string) => {
      prompts.push(text);
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
    queue,
    abortCalls: () => abortCalls,
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
      reasoningMode: options.reasoningMode ?? "manual",
      activity: options.activity ?? null,
      state,
      stateUnavailableReason: null,
      runStale: false,
      quotaResumeWaiting: quotaResumeWaiting !== null,
      subscriptionUsage: null,
    },
    quotaResumeWaiting,
    projectRoot: "/repo/Pindie",
  };
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
    await assert.rejects(control.input({ lease, text: "must not echo" }), (error: unknown) => error instanceof PindieControlError && error.code === "delivery_failed");
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

    await assert.rejects(
      control.configure({
        lease,
        model: { provider: "missing", modelId: "missing" },
      }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "model_unavailable",
    );

    presentation = presentationFor(activeState(), { reasoningMode: "auto" });
    await assert.rejects(
      control.configure({ lease, thinkingLevel: "medium" }),
      (error: unknown) =>
        error instanceof PindieControlError &&
        error.code === "reasoning_auto",
    );

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
