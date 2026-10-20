import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PresentationIntegration } from "../src/presentation-integration.ts";
import { RunCostTracker } from "../src/run-cost.ts";
import { RunTimer } from "../src/run-timer.ts";
import {
  SubscriptionUsageMonitor,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
} from "../src/subscription-usage.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";
import type { SemanticDerivationResult } from "../src/semantics.ts";
import type { PindieState } from "../src/state.ts";

function createPresentation(options: {
  uiEnabled?: boolean;
  state?: PindieState | null;
  semantic?: SemanticDerivationResult;
  semanticSource?: () => SemanticDerivationResult;
  provider?: SubscriptionUsageProvider;
  now?: () => number;
  monitor?: SubscriptionUsageMonitor;
} = {}) {
  const pi = { getThinkingLevel: () => "medium", setThinkingLevel: () => undefined } as unknown as ExtensionAPI;
  const state = options.state ?? { task: null };
  const semantic = options.semantic ?? { ok: false, error: "test semantic source" };
  return new PresentationIntegration(pi, {
    getSemanticSnapshot: options.semanticSource ?? (() => semantic),
    getState: () => state,
    getProjectRoot: () => "/repo",
    getAuthoritativeState: () => state,
    getStateUnavailableReason: () => null,
    getRunStale: () => false,
    subscriptionUsageMonitor: options.monitor ?? new SubscriptionUsageMonitor(
      options.provider ?? { fetchUsage: async () => null },
      options.now,
    ),
    getStatusWidth: () => undefined,
    runTimer: new RunTimer(),
    runCost: new RunCostTracker(),
    taskMetrics: new TaskMetricsTracker(),
    uiEnabled: options.uiEnabled,
  });
}

function uiContext(sessionId: string) {
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setStatus: (_id: string, text: string | undefined) => statuses.push(text),
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  return { ctx, statuses, notifications };
}

const notice = "Codex quota reached. Auto-resume scheduled after the current reset.";

function usageSnapshot(usedPercent: number, fetchedAt = 1): SubscriptionUsageSnapshot {
  return {
    fetchedAt,
    windows: [{ usedPercent, windowMinutes: 300 }],
  };
}

function stateFixture(): PindieState {
  return {
    task: {
      goal: "Original goal",
      constraints: ["Original constraint"],
      successCriteria: [{ id: "criterion-1", description: "Original criterion" }],
      openLoops: {
        blockers: ["Original blocker"],
        questions: ["Original question"],
        nextIntent: "Original next intent",
      },
      verification: {
        stale: false,
        checks: [{
          name: "Original check",
          status: "passed",
          covers: ["criterion-1"],
          evidence: "Original evidence",
        }],
      },
      humanGate: {
        kind: "decision",
        question: "Original question",
        options: ["Original option"],
      },
      completed: false,
    },
  };
}

function usageSnapshotWithCredits(): SubscriptionUsageSnapshot {
  return {
    fetchedAt: 1,
    windows: [{ usedPercent: 20, windowMinutes: 300, resetsAt: 10 }],
    resetCredits: {
      availableCount: 1,
      credits: [{
        id: "credit-1",
        resetType: "codex_rate_limits",
        status: "available",
        grantedAt: 2,
        expiresAt: 3,
      }],
    },
  };
}

test("presentation State snapshots detach every mutable nested value", () => {
  const authoritativeState = stateFixture();
  const presentation = createPresentation({ state: authoritativeState });
  const firstState = presentation.snapshot().status.state!;
  const authoritativeTask = authoritativeState.task!;
  const firstTask = firstState.task!;

  assert.notStrictEqual(firstState, authoritativeState);
  assert.notStrictEqual(firstTask, authoritativeTask);
  assert.notStrictEqual(firstTask.constraints, authoritativeTask.constraints);
  assert.notStrictEqual(firstTask.successCriteria, authoritativeTask.successCriteria);
  assert.notStrictEqual(firstTask.successCriteria[0], authoritativeTask.successCriteria[0]);
  assert.notStrictEqual(firstTask.openLoops, authoritativeTask.openLoops);
  assert.notStrictEqual(firstTask.openLoops.blockers, authoritativeTask.openLoops.blockers);
  assert.notStrictEqual(firstTask.openLoops.questions, authoritativeTask.openLoops.questions);
  assert.notStrictEqual(firstTask.verification, authoritativeTask.verification);
  assert.notStrictEqual(firstTask.verification.checks, authoritativeTask.verification.checks);
  assert.notStrictEqual(firstTask.verification.checks[0], authoritativeTask.verification.checks[0]);
  assert.notStrictEqual(firstTask.verification.checks[0].covers, authoritativeTask.verification.checks[0].covers);
  assert.notStrictEqual(firstTask.humanGate, authoritativeTask.humanGate);
  assert.notStrictEqual(firstTask.humanGate!.options, authoritativeTask.humanGate!.options);

  firstTask.goal = "Mutated goal";
  firstTask.constraints.push("Mutated constraint");
  firstTask.successCriteria[0].description = "Mutated criterion";
  firstTask.openLoops.blockers.push("Mutated blocker");
  firstTask.openLoops.questions.push("Mutated question");
  firstTask.verification.checks[0].covers.push("mutated-criterion");
  firstTask.humanGate!.options!.push("Mutated option");

  const secondState = presentation.snapshot().status.state!;
  assert.deepEqual(secondState, authoritativeState);
  assert.equal(authoritativeTask.goal, "Original goal");
  assert.deepEqual(authoritativeTask.constraints, ["Original constraint"]);
  assert.deepEqual(authoritativeTask.openLoops.blockers, ["Original blocker"]);
  assert.deepEqual(authoritativeTask.verification.checks[0].covers, ["criterion-1"]);
  assert.deepEqual(authoritativeTask.humanGate!.options, ["Original option"]);
});

test("subscription usage snapshots detach the monitor cache", async () => {
  const authoritativeUsage = usageSnapshotWithCredits();
  const monitor = new SubscriptionUsageMonitor({
    fetchUsage: async () => authoritativeUsage,
  });
  const presentation = createPresentation({ monitor });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  await presentation.refreshSubscriptionUsage(ui.ctx);

  const monitorSnapshot = monitor.snapshot!;
  const firstUsage = presentation.snapshot().status.subscriptionUsage!;
  assert.notStrictEqual(firstUsage, monitorSnapshot);
  assert.notStrictEqual(firstUsage.windows, monitorSnapshot.windows);
  assert.notStrictEqual(firstUsage.windows[0], monitorSnapshot.windows[0]);
  assert.notStrictEqual(firstUsage.resetCredits, monitorSnapshot.resetCredits);
  assert.notStrictEqual(firstUsage.resetCredits!.credits, monitorSnapshot.resetCredits!.credits);
  assert.notStrictEqual(firstUsage.resetCredits!.credits![0], monitorSnapshot.resetCredits!.credits![0]);

  firstUsage.windows[0].usedPercent = 99;
  firstUsage.windows.push({ usedPercent: 88, windowMinutes: 60 });
  firstUsage.resetCredits!.credits!.push({
    id: "mutated-credit",
    resetType: "codex_rate_limits",
    status: "available",
  });

  const secondUsage = presentation.snapshot().status.subscriptionUsage!;
  assert.deepEqual(secondUsage, authoritativeUsage);
  assert.deepEqual(monitor.snapshot, authoritativeUsage);
});

test("presentation snapshot passes through the injected semantic source", () => {
  const semantic: SemanticDerivationResult = { ok: false, error: "sentinel semantic result" };
  const presentation = createPresentation({ semantic });

  assert.strictEqual(presentation.snapshot().semantic, semantic);
});

test("presentation snapshot includes the existing status facts", async () => {
  const usage = usageSnapshot(20, 2);
  const presentation = createPresentation({
    monitor: new SubscriptionUsageMonitor({ fetchUsage: async () => usage }),
  });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  presentation.runTimer.start();
  presentation.runCost.start([]);
  presentation.runActivity?.start();
  presentation.runActivity?.toolExecutionStart("call", "bash");

  await presentation.refreshSubscriptionUsage(ui.ctx);
  const snapshot = presentation.snapshot();

  assert.deepEqual(snapshot.status.state, { task: null });
  assert.equal(snapshot.status.stateUnavailableReason, null);
  assert.equal(snapshot.status.reasoningMode, "manual");
  assert.equal(snapshot.status.thinkingLevel, "medium");
  assert.equal(snapshot.status.activity, "running");
  assert.equal(snapshot.status.consumption?.scope, "run");
  assert.equal(snapshot.status.consumption?.cost, 0);
  assert.deepEqual(snapshot.status.subscriptionUsage, usage);
  assert.equal(snapshot.status.quotaResumeWaiting, false);
});

test("refreshStatus renders from the shared structured presentation snapshot", () => {
  const semantic: SemanticDerivationResult = { ok: false, error: "shared semantic result" };
  let reads = 0;
  const presentation = createPresentation({
    semanticSource: () => {
      reads += 1;
      return semantic;
    },
  });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);

  presentation.refreshStatus(ui.ctx);

  assert.equal(reads, 1);
  assert.match(ui.statuses.at(-1) ?? "", /idle/);
});

test("matching authoritative waiting renders and notifies exactly once", () => {
  const presentation = createPresentation();
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });

  const snapshot = presentation.snapshot();
  assert.equal(snapshot.status.quotaResumeWaiting, true);
  assert.deepEqual(snapshot.quotaResumeWaiting, { sessionId: "session", resumeAt: 123 });
  assert.match(ui.statuses.at(-1) ?? "", /waiting · quota/);
  assert.deepEqual(ui.notifications, [{ message: notice, type: "info" }]);

  presentation.setQuotaResumeWaiting(null);
  assert.equal(ui.notifications.length, 1);
  assert.doesNotMatch(ui.statuses.at(-1) ?? "", /waiting · quota/);
});

test("other-Session waiting neither renders nor notifies", () => {
  const presentation = createPresentation();
  const ui = uiContext("current");
  presentation.setStatusContext(ui.ctx);
  presentation.setQuotaResumeWaiting({ sessionId: "other", resumeAt: 123 });

  const snapshot = presentation.snapshot();
  assert.equal(snapshot.status.quotaResumeWaiting, false);
  assert.equal(snapshot.quotaResumeWaiting, null);
  assert.doesNotMatch(ui.statuses.at(-1) ?? "", /waiting · quota/);
  assert.deepEqual(ui.notifications, []);
});

test("presentation-disabled waiting produces no status or notification", () => {
  const presentation = createPresentation({ uiEnabled: false });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });
  assert.deepEqual(ui.statuses, []);
  assert.deepEqual(ui.notifications, []);
});

test("snapshot without a current status context does not leak a quota lease", () => {
  const presentation = createPresentation();
  presentation.setQuotaResumeWaiting({ sessionId: "stale-session", resumeAt: 123 });

  const snapshot = presentation.snapshot();

  assert.equal(snapshot.status.quotaResumeWaiting, false);
  assert.equal(snapshot.quotaResumeWaiting, null);
});

test("snapshot with an unknown Session identity excludes the quota lease", () => {
  const presentation = createPresentation();
  const staleContext = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => { throw new Error("stale ExtensionContext"); },
      getEntries: () => { throw new Error("stale ExtensionContext"); },
    },
    ui: {
      theme: { fg: (_tone: string, text: string) => text },
      setStatus: () => undefined,
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
  presentation.setStatusContext(staleContext);
  presentation.setQuotaResumeWaiting({ sessionId: "stale-session", resumeAt: 123 });

  const snapshot = presentation.snapshot();

  assert.equal(snapshot.status.quotaResumeWaiting, false);
  assert.equal(snapshot.quotaResumeWaiting, null);
  assert.equal(snapshot.status.consumption, null);
});

test("snapshot performs no Extension UI operation", () => {
  let uiCalls = 0;
  const presentation = createPresentation();
  const context = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "session",
      getEntries: () => [],
    },
    ui: {
      get theme(): never {
        uiCalls += 1;
        throw new Error("snapshot must not read the UI theme");
      },
      setStatus: () => {
        uiCalls += 1;
        throw new Error("snapshot must not set status");
      },
      notify: () => {
        uiCalls += 1;
        throw new Error("snapshot must not notify");
      },
    },
  } as unknown as ExtensionContext;
  presentation.setStatusContext(context);

  assert.doesNotThrow(() => presentation.snapshot());
  assert.equal(uiCalls, 0);
});

test("forced subscription refresh replaces stale visible quota presentation", async () => {
  const snapshots = [usageSnapshot(100), usageSnapshot(20, 2)];
  let calls = 0;
  const presentation = createPresentation({
    provider: {
      fetchUsage: async () => snapshots[calls++] ?? null,
    },
  });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);

  await presentation.refreshSubscriptionUsage(ui.ctx);
  assert.match(ui.statuses.at(-1) ?? "", /5h 0%/);

  await presentation.refreshSubscriptionUsage(ui.ctx, { force: true });
  assert.equal(calls, 2);
  assert.match(ui.statuses.at(-1) ?? "", /5h 80%/);
});

test("failed forced subscription refresh is fail-soft and keeps the old visible snapshot", async () => {
  let calls = 0;
  const presentation = createPresentation({
    provider: {
      fetchUsage: async () => {
        calls += 1;
        if (calls === 1) return usageSnapshot(100);
        throw new Error("usage unavailable");
      },
    },
  });
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);

  await presentation.refreshSubscriptionUsage(ui.ctx);
  await assert.doesNotReject(
    presentation.refreshSubscriptionUsage(ui.ctx, { force: true }),
  );

  assert.equal(calls, 2);
  assert.match(ui.statuses.at(-1) ?? "", /5h 0%/);
});

test("late forced refresh completion cannot repaint a replaced Session context", async () => {
  let markStarted!: () => void;
  let release!: (snapshot: SubscriptionUsageSnapshot) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const presentation = createPresentation({
    provider: {
      fetchUsage: async () => new Promise<SubscriptionUsageSnapshot>((resolve) => {
        release = resolve;
        markStarted();
      }),
    },
  });
  const oldUi = uiContext("old");
  const newUi = uiContext("new");
  presentation.setStatusContext(oldUi.ctx);
  const request = presentation.refreshSubscriptionUsage(oldUi.ctx, { force: true });
  await started;

  presentation.setStatusContext(newUi.ctx);
  release(usageSnapshot(20, 2));
  await request;
  assert.deepEqual(newUi.statuses, []);
});
