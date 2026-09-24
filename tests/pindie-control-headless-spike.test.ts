import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

import { createPindieHost } from "../src/host.ts";

test("Headless Host exposes the active Pi runtime without starting InteractiveMode", async () => {
  const projectRoot = "/tmp/pindie-control-headless-spike";
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let idle = true;
  let interactiveRuns = 0;
  let nativeDisposeCalls = 0;
  const prompts: string[] = [];
  const observedEvents: string[] = [];

  const session = {
    sessionId: "session-headless",
    get isStreaming() {
      return !idle;
    },
    isCompacting: false,
    get isIdle() {
      return idle;
    },
    pendingMessageCount: 0,
    thinkingLevel: "medium",
    sessionManager: {
      getSessionName: () => "Headless control spike",
      getEntries: () => [],
    },
    subscribe: (next: (event: AgentSessionEvent) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    prompt: async (text: string) => {
      prompts.push(text);
      idle = false;
      listener?.({ type: "agent_start" } as AgentSessionEvent);
      await Promise.resolve();
      idle = true;
      listener?.({ type: "agent_settled" } as AgentSessionEvent);
    },
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    bindExtensions: async () => undefined,
    waitForIdle: async () => undefined,
  } as unknown as AgentSession;

  const nativeRuntime = {
    session,
    diagnostics: [],
    modelFallbackMessage: undefined,
    dispose: async () => {
      nativeDisposeCalls += 1;
    },
  } as unknown as AgentSessionRuntime;

  const host = await createPindieHost({
    cwd: projectRoot,
    env: { PINDIE_BROWSER_ENABLED: "false" },
    sessionManager: SessionManager.inMemory(projectRoot),
    dependencies: {
      createAgentSessionRuntime: async () => nativeRuntime,
      createInteractiveMode: () => ({
        run: async () => {
          interactiveRuns += 1;
        },
      }),
    },
  });

  const unsubscribe = host.runtime.subscribeActiveSession((event) => {
    observedEvents.push(event.type);
  });

  try {
    assert.equal(interactiveRuns, 0);
    assert.equal(host.runtime.activeSessionId, "session-headless");
    assert.equal(host.runtime.getActiveSessionFacts().isIdle, true);

    await host.runtime.prompt("headless control prompt");

    assert.deepEqual(prompts, ["headless control prompt"]);
    assert.deepEqual(observedEvents, ["agent_start", "agent_settled"]);
    assert.equal(host.runtime.getActiveSessionFacts().isIdle, true);
    assert.equal(interactiveRuns, 0);
  } finally {
    unsubscribe();
    await host.dispose();
  }

  assert.equal(interactiveRuns, 0);
  assert.equal(nativeDisposeCalls, 1);
});
