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

function createPresentation(options: {
  uiEnabled?: boolean;
  provider?: SubscriptionUsageProvider;
  now?: () => number;
  monitor?: SubscriptionUsageMonitor;
} = {}) {
  const pi = { getThinkingLevel: () => "medium", setThinkingLevel: () => undefined } as unknown as ExtensionAPI;
  return new PresentationIntegration(pi, {
    getState: () => ({ task: null }),
    getProjectRoot: () => "/repo",
    getAuthoritativeState: () => ({ task: null }),
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

test("matching authoritative waiting renders and notifies exactly once", () => {
  const presentation = createPresentation();
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });

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
