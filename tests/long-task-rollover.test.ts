import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import type { CommittedRolloverRequest } from "../src/long-task-control.ts";
import {
  LongTaskRolloverSupervisor,
  type LongTaskRolloverScheduler,
} from "../src/long-task-rollover.ts";
import {
  PiRuntimeAdapter,
  type SessionReplacementOptions,
  type SessionReplacementResult,
} from "../src/pi-runtime.ts";
import { createTaskContinuity } from "../src/task-continuity.ts";

class ManualScheduler {
  readonly callbacks: Array<() => void> = [];

  readonly schedule: LongTaskRolloverScheduler = (callback) => {
    this.callbacks.push(callback);
  };

  async runNext(): Promise<void> {
    const callback = this.callbacks.shift();
    assert.ok(callback);
    callback();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
}

interface FakeSessionPresentation {
  name?: string;
  entries?: unknown[];
  setNameError?: Error;
}

interface FakeRuntimeControl {
  readonly adapter: PiRuntimeAdapter;
  readonly calls: SessionReplacementOptions[];
  readonly nativeCallCount: () => number;
  readonly messages: Array<{ message: unknown; options: unknown }>;
  readonly events: string[];
  readonly facts: { isStreaming: boolean; isCompacting: boolean; pendingMessageCount: number };
  setReplacement(handler: (options?: SessionReplacementOptions) => Promise<SessionReplacementResult>): void;
  setSessionId(id: string): void;
  setActiveSessionPresentation(presentation: FakeSessionPresentation): void;
  setNextSessionNameError(error: Error): void;
  activeSessionName(): string | undefined;
  setFacts(facts: Partial<FakeRuntimeControl["facts"]>): void;
}

function fakeSession(
  id: string,
  facts: FakeRuntimeControl["facts"],
  presentation: FakeSessionPresentation,
  events: string[],
): AgentSession {
  let sessionName = presentation.name;
  return {
    sessionId: id,
    sessionManager: {
      getSessionName: () => sessionName,
      getEntries: () => presentation.entries ?? [],
    },
    setSessionName: (name: string) => {
      events.push("setSessionName");
      if (presentation.setNameError) throw presentation.setNameError;
      sessionName = name;
    },
    get isStreaming() { return facts.isStreaming; },
    get isCompacting() { return facts.isCompacting; },
    get pendingMessageCount() { return facts.pendingMessageCount; },
    getContextUsage: () => undefined,
  } as unknown as AgentSession;
}

function fakeRuntime(): FakeRuntimeControl {
  const facts = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  const calls: SessionReplacementOptions[] = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const events: string[] = [];
  let activeSessionPresentation: FakeSessionPresentation = {};
  let activeSession = fakeSession("session-1", facts, activeSessionPresentation, events);
  let nextSessionNumber = 2;
  let nextSessionNameError: Error | undefined;
  let replacement: (options?: SessionReplacementOptions) => Promise<SessionReplacementResult> = async (options) => {
    if (options) calls.push(options);
    activeSessionPresentation = { setNameError: nextSessionNameError };
    nextSessionNameError = undefined;
    activeSession = fakeSession(`session-${nextSessionNumber++}`, facts, activeSessionPresentation, events);
    await options?.withSession?.({
      sendMessage: async (message: unknown, options: unknown) => {
        events.push("sendMessage");
        messages.push({ message, options });
      },
      sendUserMessage: async () => {
        throw new Error("supervisor must not send a user message");
      },
    } as never);
    return { cancelled: false };
  };
  let nativeCallCount = 0;
  const runtime = {
    get session() { return activeSession; },
    newSession: async (options?: SessionReplacementOptions) => {
      nativeCallCount += 1;
      return replacement(options);
    },
    dispose: async () => undefined,
  } as unknown as AgentSessionRuntime;
  const control: FakeRuntimeControl = {
    adapter: new PiRuntimeAdapter(runtime),
    calls,
    nativeCallCount: () => nativeCallCount,
    messages,
    events,
    facts,
    setReplacement: (handler) => { replacement = handler; },
    setSessionId: (id) => {
      activeSessionPresentation = {};
      activeSession = fakeSession(id, facts, activeSessionPresentation, events);
    },
    setActiveSessionPresentation: (presentation) => {
      activeSessionPresentation = presentation;
      activeSession = fakeSession(activeSession.sessionId, facts, activeSessionPresentation, events);
    },
    setNextSessionNameError: (error) => { nextSessionNameError = error; },
    activeSessionName: () => activeSession.sessionManager.getSessionName(),
    setFacts: (next) => Object.assign(facts, next),
  };
  return control;
}

function request(sourceSessionId: string): CommittedRolloverRequest {
  return {
    sourceSessionId,
    checkpoint: createTaskContinuity({
      createdAt: "2026-09-04T00:00:00.000Z",
      taskFingerprint: `sha256:${"b".repeat(64)}`,
      sourceSessionId,
      progressSummary: "Progress carried from the outgoing Session.",
      decisions: ["Use Reality as the source of factual truth."],
    }),
  };
}

async function attempt(
  supervisor: LongTaskRolloverSupervisor,
  scheduler: ManualScheduler,
  rolloverRequest: CommittedRolloverRequest,
): Promise<void> {
  supervisor.request(rolloverRequest);
  await scheduler.runNext();
}

test("a committed request is scheduled instead of replacing synchronously", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  supervisor.request(request("session-1"));
  assert.equal(control.calls.length, 0);
  assert.equal(scheduler.callbacks.length, 1);

  await scheduler.runNext();
  assert.equal(control.calls.length, 1);
});

test("stale source Session requests fail closed", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  await attempt(supervisor, scheduler, request("stale-session"));

  assert.equal(control.calls.length, 0);
});

test("streaming, compacting, and pending-user Sessions do not roll over", async () => {
  for (const facts of [
    { isStreaming: true },
    { isCompacting: true },
    { pendingMessageCount: 1 },
  ]) {
    const control = fakeRuntime();
    control.setFacts(facts);
    const scheduler = new ManualScheduler();
    const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

    await attempt(supervisor, scheduler, request("session-1"));

    assert.equal(control.calls.length, 0);
  }
});

test("an idle matching Session receives one native replacement with hidden resume", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  await attempt(supervisor, scheduler, request("session-1"));

  assert.equal(control.calls.length, 1);
  assert.equal(typeof control.calls[0]!.withSession, "function");
  assert.equal(control.messages.length, 1);
  const sent = control.messages[0]!;
  assert.deepEqual(sent.options, { triggerTurn: true });
  const message = sent.message as { customType: string; content: string; display: boolean };
  assert.equal(message.customType, "pindie-long-task-resume");
  assert.equal(message.display, false);
  assert.match(
    message.content,
    /<PINDIE_LONG_TASK_RESUME>[\s\S]*Progress carried from the outgoing Session\.[\s\S]*Use Reality as the source of factual truth\./i,
  );
  assert.match(message.content, /This is not new user intent\./i);
});

test("automatic rollover names the fresh Session before hidden resume and continues the lineage", async () => {
  const control = fakeRuntime();
  control.setActiveSessionPresentation({
    entries: [{ type: "message", message: { role: "user", content: "Foo" } }],
  });
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  await attempt(supervisor, scheduler, request("session-1"));

  assert.equal(control.activeSessionName(), "cont. 2 · Foo");
  assert.deepEqual(control.events, ["setSessionName", "sendMessage"]);

  await attempt(supervisor, scheduler, request("session-2"));

  assert.equal(control.activeSessionName(), "cont. 3 · Foo");
  assert.deepEqual(control.events, [
    "setSessionName",
    "sendMessage",
    "setSessionName",
    "sendMessage",
  ]);
});

test("lineage ordinal survives a newly created supervisor with a reset safety chain", async () => {
  const control = fakeRuntime();
  control.setActiveSessionPresentation({ name: "Foo · cont. 2" });
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  await attempt(supervisor, scheduler, request("session-1"));

  assert.equal(control.activeSessionName(), "cont. 3 · Foo");
});

test("Session naming failure is isolated from successful hidden resume", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  const warnings: string[] = [];
  control.setNextSessionNameError(new Error("native name write failed"));
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, {
    schedule: scheduler.schedule,
    logger: (message) => warnings.push(message),
  });

  await attempt(supervisor, scheduler, request("session-1"));

  assert.equal(control.adapter.activeSessionId, "session-2");
  assert.equal(control.nativeCallCount(), 1);
  assert.equal(control.messages.length, 1);
  assert.deepEqual(control.events, ["setSessionName", "sendMessage"]);
  assert.equal(scheduler.callbacks.length, 0);
  assert.equal(warnings.some((message) => /lineage naming failed/i.test(message)), true);
});

test("replacement cancellation and failure do not retry", async () => {
  for (const handler of [
    async () => ({ cancelled: true }),
    async () => { throw new Error("replacement failed"); },
  ] satisfies Array<(options?: SessionReplacementOptions) => Promise<SessionReplacementResult>>) {
    const control = fakeRuntime();
    control.setReplacement(handler);
    const scheduler = new ManualScheduler();
    const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

    await attempt(supervisor, scheduler, request("session-1"));

    assert.equal(control.nativeCallCount(), 1);
    assert.equal(scheduler.callbacks.length, 0);
  }
});

test("resume-message failure leaves the fresh Session active without rollback or retry", async () => {
  const control = fakeRuntime();
  control.setReplacement(async (options) => {
    control.setSessionId("session-2");
    await options?.withSession?.({
      sendMessage: async () => { throw new Error("resume failed"); },
    } as never);
    return { cancelled: false };
  });
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  await attempt(supervisor, scheduler, request("session-1"));

  assert.equal(control.adapter.activeSessionId, "session-2");
  assert.equal(control.nativeCallCount(), 1);
  assert.equal(scheduler.callbacks.length, 0);
});

test("duplicate and in-progress requests never overlap replacements", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  control.setReplacement(async () => {
    entered();
    await barrier;
    return { cancelled: false };
  });
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });

  supervisor.request(request("session-1"));
  supervisor.request(request("session-1"));
  assert.equal(scheduler.callbacks.length, 1);
  const running = scheduler.runNext();
  await enteredPromise;
  supervisor.request(request("session-1"));
  assert.equal(scheduler.callbacks.length, 0);
  release();
  await running;
  assert.equal(control.nativeCallCount(), 1);
});

test("releases replacement ownership before the resumed Agent Run settles", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  let replacementNumber = 0;
  let resolveResume!: () => void;
  let resumeStarted!: () => void;
  const resumeStartedPromise = new Promise<void>((resolve) => { resumeStarted = resolve; });
  const resumeSettled = new Promise<void>((resolve) => { resolveResume = resolve; });

  control.setReplacement(async (options) => {
    replacementNumber += 1;
    control.setSessionId(`session-${replacementNumber + 1}`);
    if (replacementNumber === 1) {
      control.setFacts({ isStreaming: true });
      await options?.withSession?.({
        sendMessage: async () => {
          resumeStarted();
          await resumeSettled;
        },
      } as never);
      return { cancelled: false };
    }

    await options?.withSession?.({ sendMessage: async () => undefined } as never);
    return { cancelled: false };
  });

  const supervisor = new LongTaskRolloverSupervisor(control.adapter, { schedule: scheduler.schedule });
  supervisor.request(request("session-1"));
  const firstAttempt = scheduler.runNext();
  await resumeStartedPromise;

  // The fresh Session is active while its native custom-message Promise is
  // still pending, matching Pi 0.84.4's sendCustomMessage lifetime.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(control.nativeCallCount(), 1);
  assert.equal(control.adapter.activeSessionId, "session-2");

  // The resumed run settles and commits its next checkpoint. The supervisor
  // must already have released replacement ownership by this point.
  control.setFacts({ isStreaming: false });
  supervisor.request(request("session-2"));
  assert.equal(scheduler.callbacks.length, 1);

  resolveResume();
  await firstAttempt;
  await scheduler.runNext();
  assert.equal(control.nativeCallCount(), 2);
  assert.equal(control.adapter.activeSessionId, "session-3");
});

test("the automatic rollover fuse stops an excessive uninterrupted chain", async () => {
  const control = fakeRuntime();
  const scheduler = new ManualScheduler();
  const supervisor = new LongTaskRolloverSupervisor(control.adapter, {
    schedule: scheduler.schedule,
    maxAutomaticRollovers: 2,
  });

  await attempt(supervisor, scheduler, request("session-1"));
  await attempt(supervisor, scheduler, request("session-2"));
  await attempt(supervisor, scheduler, request("session-3"));

  assert.equal(control.calls.length, 2);
});
