import assert from "node:assert/strict";
import test from "node:test";

import {
  type AgentSession,
  type AgentSessionRuntime,
  type ContextUsage,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_LONG_TASK_SESSION_NAME,
  formatLongTaskContinuationSessionName,
  MAX_SESSION_LINEAGE_NAME_LENGTH,
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
  facts: {
    isStreaming?: boolean;
    isCompacting?: boolean;
    isIdle?: boolean;
    pendingMessageCount?: number;
    thinkingLevel?: AgentSession["thinkingLevel"];
  } = {},
  presentation: { name?: string; entries?: unknown[] } = {},
): AgentSession {
  let sessionName = presentation.name;
  return {
    sessionId: id,
    sessionManager: {
      getSessionName: () => sessionName,
      getEntries: () => presentation.entries ?? [],
    },
    setSessionName: (name: string) => { sessionName = name; },
    getContextUsage: () => usage,
    get isStreaming() { return facts.isStreaming ?? false; },
    get isCompacting() { return facts.isCompacting ?? false; },
    get isIdle() {
      return facts.isIdle ?? (!(facts.isStreaming ?? false) && !(facts.isCompacting ?? false));
    },
    get pendingMessageCount() { return facts.pendingMessageCount ?? 0; },
    get thinkingLevel() { return facts.thinkingLevel ?? "off"; },
    subscribe: () => () => {},
    abort: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    bindExtensions: async () => {},
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

test("lineage formatting is leading, strict, compatible, and bounded", () => {
  assert.equal(formatLongTaskContinuationSessionName("Foo"), "cont. 2 · Foo");
  assert.equal(formatLongTaskContinuationSessionName("cont. 2 · Foo"), "cont. 3 · Foo");
  assert.equal(formatLongTaskContinuationSessionName("cont. 9 · Foo"), "cont. 10 · Foo");
  assert.equal(formatLongTaskContinuationSessionName("Foo · cont. 2"), "cont. 3 · Foo");
  assert.equal(
    formatLongTaskContinuationSessionName("Foo · cont. 1"),
    "cont. 2 · Foo · cont. 1",
  );
  assert.equal(
    formatLongTaskContinuationSessionName("A title containing cont. 2"),
    "cont. 2 · A title containing cont. 2",
  );
  assert.equal(
    formatLongTaskContinuationSessionName("\n  cont.\t 2 \n ·  Foo \n"),
    "cont. 3 · Foo",
  );
  assert.equal(
    formatLongTaskContinuationSessionName("\n  Foo   with\t whitespace \n"),
    "cont. 2 · Foo with whitespace",
  );

  const prefix = "cont. 2 · ";
  const availableBaseLength = MAX_SESSION_LINEAGE_NAME_LENGTH - prefix.length;
  const longName = formatLongTaskContinuationSessionName("A".repeat(200));
  assert.equal(longName, `${prefix}${"A".repeat(availableBaseLength - 1)}…`);
  assert.equal(longName.startsWith(prefix), true);
  assert.equal(longName.length <= MAX_SESSION_LINEAGE_NAME_LENGTH, true);
  assert.equal(formatLongTaskContinuationSessionName(""), `${prefix}${DEFAULT_LONG_TASK_SESSION_NAME}`);
  assert.equal(formatLongTaskContinuationSessionName(undefined), `${prefix}${DEFAULT_LONG_TASK_SESSION_NAME}`);
});

test("adapter prefers an explicit active Session name", () => {
  const session = fakeSession("session-1", undefined, {}, {
    name: "  Explicit   Session  ",
    entries: [{ type: "message", message: { role: "user", content: "fallback prompt" } }],
  });
  const control = fakeRuntime(session);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.equal(adapter.getActiveSessionDisplayIdentity(), "Explicit Session");
});

test("adapter falls back to the first real textual user message", () => {
  const session = fakeSession("session-1", undefined, {}, {
    entries: [
      { type: "custom_message", customType: "pindie-long-task-resume", content: "hidden resume" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "\n  First   human" },
            { type: "image", data: "x", mimeType: "image/png" },
            { type: "text", text: " prompt\t" },
          ],
        },
      },
      { type: "message", message: { role: "user", content: "later prompt" } },
    ],
  });
  const control = fakeRuntime(session);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.equal(adapter.getActiveSessionDisplayIdentity(), "First human prompt");
});

test("adapter safely falls back when no explicit or textual user identity exists", () => {
  const session = fakeSession("session-1", undefined, {}, {
    entries: [
      { type: "custom_message", customType: "pindie-long-task-resume", content: "hidden resume" },
      { type: "message", message: { role: "assistant", content: "assistant" } },
      { type: "message", message: { role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } },
    ],
  });
  const control = fakeRuntime(session);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.equal(adapter.getActiveSessionDisplayIdentity(), DEFAULT_LONG_TASK_SESSION_NAME);
});

test("setActiveSessionName delegates to the current active Session", () => {
  const first = fakeSession("session-1");
  const second = fakeSession("session-2");
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  adapter.setActiveSessionName("first name");
  assert.equal(first.sessionManager.getSessionName(), "first name");
  control.setSession(second);
  adapter.setActiveSessionName("fresh name");

  assert.equal(first.sessionManager.getSessionName(), "first name");
  assert.equal(second.sessionManager.getSessionName(), "fresh name");
});

test("setting a name after native replacement affects the fresh Session", async () => {
  const first = fakeSession("session-1");
  const second = fakeSession("session-2");
  const control = fakeRuntime(first);
  control.setNewSession(async (options) => {
    control.setSession(second);
    await options?.withSession?.({ sendMessage: async () => undefined } as never);
    return { cancelled: false };
  });
  const adapter = new PiRuntimeAdapter(control.runtime);

  await adapter.replaceWithFreshSession({
    withSession: async () => adapter.setActiveSessionName("fresh name"),
  });

  assert.equal(first.sessionManager.getSessionName(), undefined);
  assert.equal(second.sessionManager.getSessionName(), "fresh name");
});

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

test("active Session subscriptions stay native and Session-scoped", () => {
  type SessionListener = Parameters<AgentSession["subscribe"]>[0];
  function trackedSession(id: string) {
    let listener: SessionListener | undefined;
    let unsubscribed = false;
    const unsubscribe = () => {
      unsubscribed = true;
      listener = undefined;
    };
    const session = {
      ...fakeSession(id),
      subscribe: (next: SessionListener) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as AgentSession;
    return {
      session,
      unsubscribe,
      wasUnsubscribed: () => unsubscribed,
      emit: () => listener?.({ type: "agent_settled" } as never),
    };
  }

  const first = trackedSession("session-1");
  const second = trackedSession("session-2");
  const control = fakeRuntime(first.session);
  const adapter = new PiRuntimeAdapter(control.runtime);
  const observed: string[] = [];

  const firstUnsubscribe = adapter.subscribeActiveSession(() => observed.push("first"));
  assert.equal(firstUnsubscribe, first.unsubscribe);
  first.emit();
  control.setSession(second.session);
  first.emit();
  second.emit();
  assert.deepEqual(observed, ["first", "first"]);

  const secondUnsubscribe = adapter.subscribeActiveSession(() => observed.push("second"));
  assert.equal(secondUnsubscribe, second.unsubscribe);
  second.emit();
  assert.deepEqual(observed, ["first", "first", "second"]);
  firstUnsubscribe();
  secondUnsubscribe();
  assert.equal(first.wasUnsubscribed(), true);
  assert.equal(second.wasUnsubscribed(), true);
});

test("abortActiveSession delegates and waits for the native abort Promise", async () => {
  let resolveAbort!: () => void;
  let abortCalls = 0;
  const nativeAbort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const session = {
    ...fakeSession("session-1"),
    abort: () => {
      abortCalls += 1;
      return nativeAbort;
    },
  } as unknown as AgentSession;
  const adapter = new PiRuntimeAdapter(fakeRuntime(session).runtime);
  let settled = false;

  const aborting = adapter.abortActiveSession().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(abortCalls, 1);
  assert.equal(settled, false);
  resolveAbort();
  await aborting;
  assert.equal(settled, true);
});

test("clearActiveSessionQueue preserves native queue provenance and clears the active Session", () => {
  const cleared: string[] = [];
  const firstQueue = { steering: ["steer A"], followUp: ["follow A"] };
  const secondQueue = { steering: ["steer B"], followUp: ["follow B"] };
  const first = {
    ...fakeSession("session-1"),
    clearQueue: () => {
      cleared.push("first");
      return firstQueue;
    },
  } as unknown as AgentSession;
  const second = {
    ...fakeSession("session-2"),
    clearQueue: () => {
      cleared.push("second");
      return secondQueue;
    },
  } as unknown as AgentSession;
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.deepEqual(adapter.clearActiveSessionQueue(), firstQueue);
  control.setSession(second);
  assert.deepEqual(adapter.clearActiveSessionQueue(), secondQueue);
  assert.deepEqual(cleared, ["first", "second"]);
});

test("bindActiveSessionExtensions and thinking-level reads target the active Session", async () => {
  const bindings = {} as Parameters<AgentSession["bindExtensions"]>[0];
  let receivedBindings: unknown;
  const bindingPromise = Promise.resolve();
  const first = {
    ...fakeSession("session-1", undefined, { thinkingLevel: "high" }),
    bindExtensions: (value: Parameters<AgentSession["bindExtensions"]>[0]) => {
      receivedBindings = value;
      return bindingPromise;
    },
  } as unknown as AgentSession;
  const second = fakeSession("session-2", undefined, { thinkingLevel: "low" });
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);

  assert.equal(adapter.getActiveSessionThinkingLevel(), "high");
  assert.equal(adapter.bindActiveSessionExtensions(bindings), bindingPromise);
  await bindingPromise;
  assert.equal(receivedBindings, bindings);

  control.setSession(second);
  assert.equal(adapter.getActiveSessionThinkingLevel(), "low");
});

test("setActiveSessionClientLifecycle delegates single native callback slots", () => {
  const calls: string[] = [];
  const beforeHandlers: Array<(() => void) | undefined> = [];
  const rebindHandlers: Array<((session: AgentSession) => Promise<void>) | undefined> = [];
  const first = fakeSession("session-1");
  const second = fakeSession("session-2");
  let activeSession = first;
  const runtime = {
    get session() { return activeSession; },
    setBeforeSessionInvalidate: (handler?: () => void) => { beforeHandlers.push(handler); },
    setRebindSession: (handler?: (session: AgentSession) => Promise<void>) => { rebindHandlers.push(handler); },
    newSession: async () => ({ cancelled: false }),
    dispose: async () => undefined,
  } as unknown as AgentSessionRuntime;
  const adapter = new PiRuntimeAdapter(runtime);

  adapter.setActiveSessionClientLifecycle({
    beforeSessionInvalidate: () => calls.push("before"),
    rebindSession: async () => calls.push(`rebind:${adapter.activeSessionId}`),
  });
  beforeHandlers[0]?.();
  assert.ok(rebindHandlers[0]);
  activeSession = second;
  void rebindHandlers[0]!(first);
  assert.deepEqual(calls, ["before", "rebind:session-2"]);

  adapter.setActiveSessionClientLifecycle();
  assert.equal(beforeHandlers[1], undefined);
  assert.equal(rebindHandlers[1], undefined);
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
    isIdle: false,
    pendingMessageCount: 2,
  });

  control.setSession(second);

  assert.deepEqual(adapter.getActiveSessionFacts(), {
    sessionId: "session-2",
    isStreaming: false,
    isCompacting: true,
    isIdle: false,
    pendingMessageCount: 0,
  });
});

test("adapter disposal is idempotent", async () => {
  const control = fakeRuntime(fakeSession("session-1"));
  const adapter = new PiRuntimeAdapter(control.runtime);

  await Promise.all([adapter.dispose(), adapter.dispose()]);

  assert.equal(control.disposeCalls(), 1);
});

test("quota primitives always read and delegate to the current active Session", async () => {
  const calls: unknown[][] = [];
  const branchOne = [{ type: "custom", id: "one" }] as unknown as import("@earendil-works/pi-coding-agent").SessionEntry[];
  const branchTwo = [{ type: "custom", id: "two" }] as unknown as import("@earendil-works/pi-coding-agent").SessionEntry[];
  const first = { ...fakeSession("one"), model: { provider: "first", id: "m1" }, sessionManager: { getBranch: () => branchOne }, sendCustomMessage: async (...args: unknown[]) => { calls.push(args); } } as unknown as AgentSession;
  const second = { ...fakeSession("two"), model: { provider: "openai-codex", id: "gpt-5-codex" }, sessionManager: { getBranch: () => branchTwo }, sendCustomMessage: async (...args: unknown[]) => { calls.push(args); } } as unknown as AgentSession;
  const control = fakeRuntime(first);
  const adapter = new PiRuntimeAdapter(control.runtime);
  control.setSession(second);

  assert.deepEqual(adapter.getActiveSessionModelIdentity(), { provider: "openai-codex", modelId: "gpt-5-codex" });
  assert.equal(adapter.getActiveSessionBranch(), branchTwo);
  const message = { customType: "test", content: "wake", display: false };
  const options = { triggerTurn: true };
  await adapter.sendCustomMessage(message, options);
  assert.deepEqual(calls, [[message, options]]);
});
