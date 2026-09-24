import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { classifyHumanSignal } from "../src/human-signal.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";
import {
  createPindieUiProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjection,
  type PindieUiProjectionInput,
} from "../src/ui-projection.ts";
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
        nextIntent: "Continue the architecture spike",
      },
      verification: {
        stale: false,
        checks: [{ name: "architecture", status: "passed", covers: ["c1"], evidence: "reviewed" }],
      },
      humanGate: gate,
      completed: false,
    },
  };
}

function presentationFor(
  state: PindieState,
  quotaResumeWaiting: PindiePresentationSnapshot["quotaResumeWaiting"] = null,
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

  return {
    semantic,
    status: {
      consumption: null,
      reasoningMode: "manual",
      activity: null,
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

interface SpikeSnapshot {
  readonly lease: string;
  readonly revision: number;
  readonly projectRoot: string | null;
  readonly sessionId: string;
  readonly model: { provider: string; modelId: string } | null;
  readonly thinkingLevel: string;
  readonly idle: boolean;
  readonly automaticWorkSettled: boolean;
  readonly taskStatus: string | null;
  readonly taskGoal: string | null;
  readonly verificationStatus: string | null;
  readonly gate: {
    key: string;
    question: string;
  } | null;
  readonly latestAssistant: string | null;
}

class ControlProjectionSpike {
  private readonly runtime: PiRuntimeAdapter;
  private readonly presentation: () => PindiePresentationSnapshot | null;
  private projection: PindieUiProjection | null = null;
  private unsubscribe: (() => void) | null = null;
  private automaticWorkSettled = false;
  private leaseSequence = 0;
  private currentLease = "";
  private currentRevision = 0;
  private lastFingerprint = "";

  constructor(
    runtime: PiRuntimeAdapter,
    presentation: () => PindiePresentationSnapshot | null,
  ) {
    this.runtime = runtime;
    this.presentation = presentation;
  }

  async bind(): Promise<void> {
    this.runtime.setActiveSessionClientLifecycle({
      beforeSessionInvalidate: () => this.invalidate(),
      rebindSession: () => this.bindCurrentSession(),
    });
    await this.bindCurrentSession();
  }

  dispose(): void {
    this.invalidate();
    this.runtime.setActiveSessionClientLifecycle();
  }

  observe(): SpikeSnapshot {
    assert.ok(this.projection);
    const next = refreshProjectionFacts(this.projection, this.input());
    this.publish(next);
    return this.snapshot();
  }

  private input(): PindieUiProjectionInput {
    return {
      presentation: this.presentation(),
      session: {
        sessionId: this.runtime.activeSessionId,
        displayIdentity: this.runtime.getActiveSessionDisplayIdentity(),
        model: this.runtime.getActiveSessionModelIdentity(),
        thinkingLevel: this.runtime.getActiveSessionThinkingLevel(),
        runtime: this.runtime.getActiveSessionFacts(),
        automaticWorkSettled: this.automaticWorkSettled,
        branch: this.runtime.getActiveSessionBranch(),
      },
    };
  }

  private async bindCurrentSession(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.currentLease = `ctl-${++this.leaseSequence}`;
    this.automaticWorkSettled = this.runtime.getActiveSessionFacts().isIdle;
    this.projection = createPindieUiProjection(this.input());
    this.unsubscribe = this.runtime.subscribeActiveSession((event) => {
      if (event.type === "agent_start") this.automaticWorkSettled = false;
      if (event.type === "agent_settled") this.automaticWorkSettled = true;
      assert.ok(this.projection);
      let next = reduceProjectionEvent(this.projection, event);
      if (event.type === "agent_start" || event.type === "agent_settled") {
        next = refreshProjectionFacts(next, this.input());
      }
      this.publish(next);
    });
    this.publish(this.projection, true);
  }

  private invalidate(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.projection = null;
    this.automaticWorkSettled = false;
  }

  private publish(next: PindieUiProjection, force = false): void {
    this.projection = next;
    const fingerprint = JSON.stringify(this.project(next));
    if (force || fingerprint !== this.lastFingerprint) {
      this.currentRevision += 1;
      this.lastFingerprint = fingerprint;
    }
  }

  private project(projection: PindieUiProjection): Omit<SpikeSnapshot, "revision"> {
    const presentation = this.presentation();
    const task = presentation?.status.state?.task ?? null;
    const humanSignal = presentation === null
      ? null
      : classifyHumanSignal({
          phase: "current",
          sessionId: projection.header.sessionId,
          authority: projection.status.semanticAuthority,
          authorityUnavailableReason: projection.status.stateUnavailableReason,
          taskStatus: projection.status.taskStatus,
          task,
          isIdle: projection.status.isIdle,
          automaticWorkSettled: this.automaticWorkSettled,
          pendingMessageCount: projection.status.pendingMessageCount,
          quotaResumeWaiting: presentation.quotaResumeWaiting !== null,
        });
    const latestAssistant = [...projection.timeline]
      .reverse()
      .find((block) => block.type === "message" && block.role === "assistant");

    return {
      lease: this.currentLease,
      projectRoot: projection.header.projectRoot,
      sessionId: projection.header.sessionId,
      model: projection.header.model,
      thinkingLevel: projection.header.thinkingLevel,
      idle: projection.status.isIdle,
      automaticWorkSettled: this.automaticWorkSettled,
      taskStatus: projection.status.taskStatus,
      taskGoal: task?.goal ?? null,
      verificationStatus: projection.status.verificationStatus,
      gate: humanSignal?.kind === "human-gate"
        ? {
            key: humanSignal.key,
            question: task?.humanGate?.question ?? humanSignal.detail[0] ?? humanSignal.summary,
          }
        : null,
      latestAssistant: latestAssistant?.type === "message" ? latestAssistant.text : null,
    };
  }

  private snapshot(): SpikeSnapshot {
    assert.ok(this.projection);
    return {
      ...this.project(this.projection),
      revision: this.currentRevision,
    };
  }
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

test("Control Projection can be derived from existing runtime and semantic truth", async () => {
  const first = fakeSession("session-1", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  let presentation = presentationFor(activeState());
  const control = new ControlProjectionSpike(runtime, () => presentation);

  await control.bind();
  try {
    const initial = control.observe();

    assert.equal(initial.projectRoot, "/repo/Pindie");
    assert.equal(initial.sessionId, "session-1");
    assert.deepEqual(initial.model, { provider: "openai-codex", modelId: "gpt-6-sol" });
    assert.equal(initial.thinkingLevel, "medium");
    assert.equal(initial.idle, true);
    assert.equal(initial.automaticWorkSettled, true);
    assert.equal(initial.taskStatus, "active");
    assert.equal(initial.taskGoal, "Implement Pindie Control safely");
    assert.equal(initial.verificationStatus, "pending");
    assert.equal(initial.latestAssistant, "Visible result.");
    assert.equal(initial.latestAssistant?.includes("private reasoning"), false);

    const beforeStart = initial.revision;
    first.start();
    const running = control.observe();
    assert.equal(running.automaticWorkSettled, false);
    assert.equal(running.idle, false);
    assert.ok(running.revision > beforeStart);

    const beforeSettle = running.revision;
    first.settle();
    const settled = control.observe();
    assert.equal(settled.automaticWorkSettled, true);
    assert.equal(settled.idle, true);
    assert.ok(settled.revision > beforeSettle);

    const beforeGate = settled.revision;
    presentation = presentationFor(activeState({
      kind: "approval",
      question: "Merge this architectural change?",
      options: ["Approve", "Reject"],
    }));
    const gated = control.observe();
    assert.equal(gated.taskStatus, "waiting_human");
    assert.equal(gated.gate?.question, "Merge this architectural change?");
    assert.match(gated.gate?.key ?? "", /^human-gate:/);
    assert.ok(gated.revision > beforeGate);
  } finally {
    control.dispose();
  }
});

test("Control lease changes on lifecycle rebind even when native Session ID is reused", async () => {
  const first = fakeSession("same-session-id", branchEntries());
  const native = fakeNativeRuntime(first);
  const runtime = new PiRuntimeAdapter(native.runtime);
  const presentation = presentationFor(activeState());
  const control = new ControlProjectionSpike(runtime, () => presentation);

  await control.bind();
  try {
    const before = control.observe();
    const replacement = fakeSession("same-session-id", branchEntries());

    await native.replace(replacement);

    const after = control.observe();
    assert.equal(after.sessionId, before.sessionId);
    assert.notEqual(after.lease, before.lease);
    assert.ok(after.revision > before.revision);
  } finally {
    control.dispose();
  }
});
