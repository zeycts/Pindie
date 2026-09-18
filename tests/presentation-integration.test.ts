import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PresentationIntegration } from "../src/presentation-integration.ts";
import { RunCostTracker } from "../src/run-cost.ts";
import { RunTimer } from "../src/run-timer.ts";
import { SubscriptionUsageMonitor } from "../src/subscription-usage.ts";
import { TaskMetricsTracker } from "../src/task-metrics.ts";

function createPresentation(uiEnabled = true) {
  const pi = { getThinkingLevel: () => "medium", setThinkingLevel: () => undefined } as unknown as ExtensionAPI;
  return new PresentationIntegration(pi, {
    getState: () => ({ task: null }),
    getProjectRoot: () => "/repo",
    getAuthoritativeState: () => ({ task: null }),
    getStateUnavailableReason: () => null,
    getRunStale: () => false,
    subscriptionUsageMonitor: new SubscriptionUsageMonitor({ fetchUsage: async () => null }),
    getStatusWidth: () => undefined,
    runTimer: new RunTimer(),
    runCost: new RunCostTracker(),
    taskMetrics: new TaskMetricsTracker(),
    uiEnabled,
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
  const presentation = createPresentation(false);
  const ui = uiContext("session");
  presentation.setStatusContext(ui.ctx);
  presentation.setQuotaResumeWaiting({ sessionId: "session", resumeAt: 123 });
  assert.deepEqual(ui.statuses, []);
  assert.deepEqual(ui.notifications, []);
});
