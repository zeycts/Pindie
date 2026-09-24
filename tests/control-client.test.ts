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
  };
}

function fakeNativeRuntime(initial: FakeSessionControl) {
  let active = initial;
  let beforeInvalidate: (() => void) | undefined;
  let rebind: (() => Promise<void>) | undefined;
  let nextFreshSession: FakeSessionControl | undefined;

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
    dispose: async () => undefined,
  } as unknown as AgentSessionRuntime;

  return {
    runtime,
    replace,
    setNextFreshSession: (next: FakeSessionControl) => {
      nextFreshSession = next;
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
    const replacement = fakeSession("session-2", branchEntries());
    native.setNextFreshSession(replacement);

    const replaced = await control.freshSession({ lease: before.lease });
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
