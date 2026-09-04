import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentSession,
  type AgentSessionRuntime,
  type ContextUsage,
} from "@earendil-works/pi-coding-agent";

import {
  PiRuntimeAdapter,
  type SessionReplacementOptions,
  type SessionReplacementResult,
} from "../src/pi-runtime.ts";

interface FakeRuntimeControl {
  runtime: AgentSessionRuntime;
  setSession(session: AgentSession): void;
  setNewSession(handler: (options?: SessionReplacementOptions) => Promise<SessionReplacementResult>): void;
  newSessionCalls(): number;
  forwardedOptions(): SessionReplacementOptions | undefined;
  disposeCalls(): number;
}

function fakeSession(
  id: string,
  usage?: ContextUsage,
  facts: { isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number } = {},
): AgentSession {
  return {
    sessionId: id,
    getContextUsage: () => usage,
    get isStreaming() { return facts.isStreaming ?? false; },
    get isCompacting() { return facts.isCompacting ?? false; },
    get pendingMessageCount() { return facts.pendingMessageCount ?? 0; },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
  } as unknown as AgentSession;
}

function fakeRuntime(initialSession: AgentSession): FakeRuntimeControl {
  let session = initialSession;
  let newSessionHandler: (options?: SessionReplacementOptions) => Promise<SessionReplacementResult> = async () => ({ cancelled: false });
  let newSessionCalls = 0;
  let forwardedOptions: SessionReplacementOptions | undefined;
  let disposeCalls = 0;

  const runtime = {
    get session() {
      return session;
    },
    newSession: async (options?: SessionReplacementOptions) => {
      newSessionCalls += 1;
      forwardedOptions = options;
      return newSessionHandler(options);
    },
    dispose: async () => {
      disposeCalls += 1;
    },
  } as unknown as AgentSessionRuntime;

  return {
    runtime,
    setSession: (nextSession) => {
      session = nextSession;
    },
    setNewSession: (handler) => {
      newSessionHandler = handler;
    },
    newSessionCalls: () => newSessionCalls,
    forwardedOptions: () => forwardedOptions,
    disposeCalls: () => disposeCalls,
  };
}

test("adapter projects the current active Session and identity", () => {
  const first = fakeSession("session-1");
  const second = fakeSession("session-2");
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.equal(adapter.activeSession, first);
  assert.equal(adapter.activeSessionId, "session-1");

  control.setSession(second);

  assert.equal(adapter.activeSession, second);
  assert.equal(adapter.activeSessionId, "session-2");
});

test("replaceWithFreshSession delegates directly and exposes successful identity replacement", async () => {
  const first = fakeSession("session-1");
  const second = fakeSession("session-2");
  const control = fakeRuntime(first);
  control.setNewSession(async () => {
    control.setSession(second);
    return { cancelled: false };
  });
  const adapter = new PiRuntimeAdapter(control.runtime);

  const beforeSessionId = adapter.activeSessionId;
  const result = await adapter.replaceWithFreshSession();

  assert.deepEqual(result, { cancelled: false });
  assert.equal(control.newSessionCalls(), 1);
  assert.notEqual(beforeSessionId, adapter.activeSessionId);
});

test("replaceWithFreshSession forwards the exact native options object", async () => {
  const control = fakeRuntime(fakeSession("session-1"));
  const adapter = new PiRuntimeAdapter(control.runtime);
  const options: SessionReplacementOptions = {
    withSession: async () => undefined,
  };

  await adapter.replaceWithFreshSession(options);

  assert.equal(control.forwardedOptions(), options);
});

test("native withSession remains callable by the Pi runtime", async () => {
  const control = fakeRuntime(fakeSession("session-1"));
  const adapter = new PiRuntimeAdapter(control.runtime);
  let callbackCalled = false;
  const replacedContext = {
    sendMessage: async () => undefined,
  };
  control.setNewSession(async (options) => {
    await options?.withSession?.(replacedContext as never);
    return { cancelled: false };
  });

  await adapter.replaceWithFreshSession({
    withSession: async () => {
      callbackCalled = true;
    },
  });

  assert.equal(callbackCalled, true);
});

test("cancelled replacement preserves Pi cancellation and active identity", async () => {
  const first = fakeSession("session-1");
  const control = fakeRuntime(first);
  control.setNewSession(async () => ({ cancelled: true }));
  const adapter = new PiRuntimeAdapter(control.runtime);

  const result = await adapter.replaceWithFreshSession();

  assert.deepEqual(result, { cancelled: true });
  assert.equal(adapter.activeSessionId, "session-1");
});

test("replacement failures propagate without retry or rollback", async () => {
  const first = fakeSession("session-1");
  const failure = new Error("replacement failed");
  const control = fakeRuntime(first);
  control.setNewSession(async () => {
    throw failure;
  });
  const adapter = new PiRuntimeAdapter(control.runtime);

  await assert.rejects(adapter.replaceWithFreshSession(), failure);

  assert.equal(control.newSessionCalls(), 1);
  assert.equal(adapter.activeSessionId, "session-1");
});

test("messaging primitives and context usage target the current active Session", async () => {
  const calls: string[] = [];
  const first = {
    ...fakeSession("session-1", { tokens: 10, contextWindow: 100, percent: 10 }),
    prompt: async (text: string) => { calls.push(`first prompt:${text}`); },
    steer: async (text: string) => { calls.push(`first steer:${text}`); },
    followUp: async (text: string) => { calls.push(`first followUp:${text}`); },
  } as unknown as AgentSession;
  const second = {
    ...fakeSession("session-2", { tokens: 20, contextWindow: 100, percent: 20 }),
    prompt: async (text: string) => { calls.push(`second prompt:${text}`); },
    steer: async (text: string) => { calls.push(`second steer:${text}`); },
    followUp: async (text: string) => { calls.push(`second followUp:${text}`); },
  } as unknown as AgentSession;
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.deepEqual(adapter.getContextUsage(), { tokens: 10, contextWindow: 100, percent: 10 });
  await adapter.prompt("before");
  await adapter.steer("before");
  await adapter.followUp("before");

  control.setSession(second);

  assert.deepEqual(adapter.getContextUsage(), { tokens: 20, contextWindow: 100, percent: 20 });
  await adapter.prompt("after");
  await adapter.steer("after");
  await adapter.followUp("after");

  assert.deepEqual(calls, [
    "first prompt:before",
    "first steer:before",
    "first followUp:before",
    "second prompt:after",
    "second steer:after",
    "second followUp:after",
  ]);
});

test("active runtime facts always read the current Session", () => {
  const firstFacts = { isStreaming: true, isCompacting: false, pendingMessageCount: 2 };
  const secondFacts = { isStreaming: false, isCompacting: true, pendingMessageCount: 0 };
  const first = fakeSession("session-1", undefined, firstFacts);
  const second = fakeSession("session-2", undefined, secondFacts);
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.deepEqual(adapter.getActiveSessionFacts(), {
    sessionId: "session-1",
    isStreaming: true,
    isCompacting: false,
    pendingMessageCount: 2,
  });

  control.setSession(second);

  assert.deepEqual(adapter.getActiveSessionFacts(), {
    sessionId: "session-2",
    isStreaming: false,
    isCompacting: true,
    pendingMessageCount: 0,
  });
});

test("adapter disposal is idempotent", async () => {
  const control = fakeRuntime(fakeSession("session-1"));
  const adapter = new PiRuntimeAdapter(control.runtime);

  await Promise.all([adapter.dispose(), adapter.dispose()]);

  assert.equal(control.disposeCalls(), 1);
});
