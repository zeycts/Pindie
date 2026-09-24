import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { PindieControlClient } from "../src/control-client.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import { deriveSemanticSnapshot, type SemanticRunFacts } from "../src/semantics.ts";
import type { HumanGate, PindieState } from "../src/state.ts";

interface FakeSessionControl {
  readonly session: AgentSession;
  start(): void;
  settle(): void;
}

function fakeSession(
  sessionId: string,
  entries: readonly SessionEntry[],
): FakeSessionControl {
  let idle = true;
  let streaming = false;
  let listener: ((event: AgentSessionEvent) => void) | undefined;

  const session = {
    sessionId,
    model: { provider: "openai-codex", id: "gpt-6-sol" },
    thinkingLevel: "medium",
    get isStreaming() {
      return streaming;
    },
    isCompacting: false,
    get isIdle() {
      return idle;
    },
    pendingMessageCount: 0,
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
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    bindExtensions: async () => undefined,
    waitForIdle: async () => undefined,
  } as unknown as AgentSession;

  return {
    session,
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
  };
}

function fakeNativeRuntime(initial: FakeSessionControl) {
  let active = initial;
  let beforeInvalidate: (() => void) | undefined;
  let rebind: (() => Promise<void>) | undefined;

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
    dispose: async () => undefined,
  } as unknown as AgentSessionRuntime;

  return {
    runtime,
    replace: async (next: FakeSessionControl) => {
      beforeInvalidate?.();
      active = next;
      await rebind?.();
    },
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
      reasoningMode: "manual",
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
