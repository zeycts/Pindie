import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  buildQuotaResumePlan,
  detectCodexQuotaIncident,
  MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS,
  QUOTA_RESET_GRACE_MS,
} from "../src/quota-resume-incident.ts";
import {
  SubscriptionUsageMonitor,
  type SubscriptionUsageSnapshot,
} from "../src/subscription-usage.ts";

const NOW = 1_700_000_000_000;
const CURRENT_CODEX_QUOTA_ERROR =
  "You have hit your ChatGPT usage limit (plus plan). Try again in ~148 min.";

function assistantEntry(
  id: string,
  overrides: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(NOW).toISOString(),
    message: {
      role: "assistant",
      content: [],
      provider: "openai-codex",
      model: "gpt-5-codex",
      usage: {},
      stopReason: "error",
      errorMessage: "The usage limit has been reached",
      timestamp: NOW,
      ...overrides,
    },
  } as SessionEntry;
}

function userEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(NOW).toISOString(),
    message: { role: "user", content: "continue", timestamp: NOW },
  } as SessionEntry;
}

function metadataEntry(
  type: "custom" | "session_info",
  id: string,
): SessionEntry {
  return type === "custom"
    ? {
        type,
        id,
        parentId: null,
        timestamp: new Date(NOW).toISOString(),
        customType: "test-metadata",
        data: { value: true },
      } as SessionEntry
    : {
        type,
        id,
        parentId: null,
        timestamp: new Date(NOW).toISOString(),
        name: "test",
      } as SessionEntry;
}

function quotaBranch(overrides: Record<string, unknown> = {}): SessionEntry[] {
  return [assistantEntry("quota", overrides)];
}

function usageSnapshot(options: {
  fetchedAt?: number;
  fiveUsedPercent?: number;
  weeklyUsedPercent?: number;
  fiveResetsAt?: number;
  weeklyResetsAt?: number;
  includeFive?: boolean;
  includeWeekly?: boolean;
  resetCredits?: number;
} = {}): SubscriptionUsageSnapshot {
  const {
    fetchedAt = NOW,
    fiveUsedPercent = 100,
    weeklyUsedPercent = 50,
    fiveResetsAt,
    weeklyResetsAt,
    includeFive = true,
    includeWeekly = true,
    resetCredits,
  } = options;
  const windows = [
    ...(includeFive
      ? [{ usedPercent: fiveUsedPercent, windowMinutes: 300, ...(fiveResetsAt === undefined ? {} : { resetsAt: fiveResetsAt }) }]
      : []),
    ...(includeWeekly
      ? [{ usedPercent: weeklyUsedPercent, windowMinutes: 10_080, ...(weeklyResetsAt === undefined ? {} : { resetsAt: weeklyResetsAt }) }]
      : []),
  ];
  return {
    fetchedAt,
    windows,
    ...(resetCredits === undefined ? {} : { resetCredits: { availableCount: resetCredits } }),
  };
}

function planningContext(
  getSessionId: () => string = () => "session-for-test",
): ExtensionContext {
  return { sessionManager: { getSessionId } } as unknown as ExtensionContext;
}

function monitorFor(
  snapshot: SubscriptionUsageSnapshot | null,
  calls?: { count: number },
): SubscriptionUsageMonitor {
  return new SubscriptionUsageMonitor({
    async fetchUsage() {
      if (calls) calls.count += 1;
      return snapshot;
    },
  }, () => NOW);
}

test("detects the current real-shaped Codex quota error", () => {
  assert.deepEqual(detectCodexQuotaIncident(quotaBranch({
    errorMessage: CURRENT_CODEX_QUOTA_ERROR,
  })), {
    anchorEntryId: "quota",
    provider: "openai-codex",
    modelId: "gpt-5-codex",
    errorMessage: CURRENT_CODEX_QUOTA_ERROR,
  });
});

test("recognizes current wording with plan and retry-time variants", () => {
  for (const errorMessage of [
    CURRENT_CODEX_QUOTA_ERROR,
    "You have hit your ChatGPT usage limit (pro plan). Try again in ~2 min.",
    "You have hit your ChatGPT usage limit",
    "YOU HAVE HIT YOUR CHATGPT USAGE LIMIT (plus plan)",
  ]) {
    assert.ok(detectCodexQuotaIncident(quotaBranch({ errorMessage })), errorMessage);
  }
});

test("requires the current assistant message to be OpenAI Codex and terminal", () => {
  assert.equal(detectCodexQuotaIncident(quotaBranch({
    provider: "openai",
    errorMessage: CURRENT_CODEX_QUOTA_ERROR,
  })), null);
  assert.equal(detectCodexQuotaIncident(quotaBranch({
    provider: "anthropic",
    errorMessage: CURRENT_CODEX_QUOTA_ERROR,
  })), null);
  assert.equal(detectCodexQuotaIncident(quotaBranch({ stopReason: "stop" })), null);
});

test("classifies only the narrow known quota signatures", () => {
  for (const errorMessage of [
    "connection limit reached",
    "server overloaded",
    "network failure",
    "network error",
    "context_length_exceeded",
    "context limit reached",
    "token limit reached",
    "request limit",
    "rate limit reached",
    "rate limit exceeded",
    "HTTP 429 Too Many Requests",
    "This unrelated limit string is not quota exhaustion",
  ]) {
    assert.equal(detectCodexQuotaIncident(quotaBranch({ errorMessage })), null, errorMessage);
  }

  for (const errorMessage of [
    "The usage limit has been reached",
    "usage_limit_reached",
    "usage limit reached",
    "GoUsageLimitError: quota exhausted",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "insufficient_quota",
  ]) {
    assert.ok(detectCodexQuotaIncident(quotaBranch({ errorMessage })), errorMessage);
  }
});

test("historical quota errors are ignored after a later conversation message", () => {
  assert.equal(detectCodexQuotaIncident([
    ...quotaBranch(),
    userEntry("later-user"),
  ]), null);
});

test("metadata after a quota assistant message does not hide the incident", () => {
  for (const type of ["custom", "session_info"] as const) {
    const incident = detectCodexQuotaIncident([
      ...quotaBranch(),
      metadataEntry(type, `metadata-${type}`),
    ]);
    assert.equal(incident?.anchorEntryId, "quota");
  }
});

test("confirms current Codex quota from fresh five-hour usage, not retry text", async () => {
  const fiveResetsAt = NOW + 5_000;
  const plan = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch({ errorMessage: CURRENT_CODEX_QUOTA_ERROR }),
    monitor: monitorFor(usageSnapshot({
      fiveResetsAt,
      weeklyUsedPercent: 1,
    })),
    enabled: true,
    now: () => NOW,
  });
  assert.ok(plan);
  assert.equal(plan.resumeAt, fiveResetsAt + QUOTA_RESET_GRACE_MS);
  assert.notEqual(plan.resumeAt, NOW + 148 * 60_000);
});

test("derives five-hour-only resume time plus grace", async () => {
  const plan = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor: monitorFor(usageSnapshot({
      fiveResetsAt: NOW + 5_000,
    })),
    enabled: true,
    now: () => NOW,
  });
  assert.equal(plan?.resumeAt, NOW + 5_000 + QUOTA_RESET_GRACE_MS);
});

test("derives weekly-only resume time plus grace", async () => {
  const plan = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch({}),
    monitor: monitorFor(usageSnapshot({
      fiveUsedPercent: 48,
      weeklyUsedPercent: 100,
      weeklyResetsAt: NOW + 7_000,
    })),
    enabled: true,
    now: () => NOW,
  });
  assert.equal(plan?.resumeAt, NOW + 7_000 + QUOTA_RESET_GRACE_MS);
});

test("uses the later reset plus grace when both standard windows are exhausted", async () => {
  const plan = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor: monitorFor(usageSnapshot({
      fiveResetsAt: NOW + 5_000,
      weeklyUsedPercent: 100,
      weeklyResetsAt: NOW + 9_000,
    })),
    enabled: true,
    now: () => NOW,
  });
  assert.equal(plan?.resumeAt, NOW + 9_000 + QUOTA_RESET_GRACE_MS);
});

test("requires an actually exhausted standard window", async () => {
  assert.equal(await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor: monitorFor(usageSnapshot({ fiveUsedPercent: 48 })),
    enabled: true,
    now: () => NOW,
  }), null);
});

test("requires both recognized standard windows", async () => {
  for (const options of [
    { includeFive: false, weeklyResetsAt: NOW + 5_000 },
    { includeWeekly: false, fiveResetsAt: NOW + 5_000 },
  ]) {
    assert.equal(await buildQuotaResumePlan({
      ctx: planningContext(),
      branch: quotaBranch(),
      monitor: monitorFor(usageSnapshot(options)),
      enabled: true,
      now: () => NOW,
    }), null);
  }
});

test("fails closed when an exhausted window has no reliable future reset", async () => {
  for (const options of [
    {},
    { fiveResetsAt: NOW },
    { fiveResetsAt: NOW - 1 },
    { fiveResetsAt: Number.NaN },
  ]) {
    assert.equal(await buildQuotaResumePlan({
      ctx: planningContext(),
      branch: quotaBranch(),
      monitor: monitorFor(usageSnapshot(options)),
      enabled: true,
      now: () => NOW,
    }), null);
  }
});

test("rejects stale and clearly future-dated usage snapshots", async () => {
  for (const fetchedAt of [
    NOW - MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS - 1,
    NOW + MAX_QUOTA_USAGE_SNAPSHOT_AGE_MS + 1,
  ]) {
    assert.equal(await buildQuotaResumePlan({
      ctx: planningContext(),
      branch: quotaBranch(),
      monitor: monitorFor(usageSnapshot({ fetchedAt, fiveResetsAt: NOW + 5_000 })),
      enabled: true,
      now: () => NOW,
    }), null);
  }
});

test("reset-credit availability has no effect on quota plan derivation", async () => {
  const withoutCredits = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor: monitorFor(usageSnapshot({ fiveResetsAt: NOW + 5_000, resetCredits: 0 })),
    enabled: true,
    now: () => NOW,
  });
  const withCredits = await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor: monitorFor(usageSnapshot({ fiveResetsAt: NOW + 5_000, resetCredits: 4 })),
    enabled: true,
    now: () => NOW,
  });
  assert.equal(withoutCredits?.resumeAt, withCredits?.resumeAt);
});

test("disabled or non-candidate planning does not fetch usage", async () => {
  const calls = { count: 0 };
  const monitor = monitorFor(usageSnapshot({ fiveResetsAt: NOW + 5_000 }), calls);
  assert.equal(await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: quotaBranch(),
    monitor,
    enabled: false,
    now: () => NOW,
  }), null);
  assert.equal(await buildQuotaResumePlan({
    ctx: planningContext(),
    branch: [userEntry("user")],
    monitor,
    enabled: true,
    now: () => NOW,
  }), null);
  assert.equal(calls.count, 0);
});

test("candidate planning forces a fresh fetch despite a recent monitor snapshot", async () => {
  const calls = { count: 0 };
  const snapshot = usageSnapshot({ fiveResetsAt: NOW + 5_000 });
  const monitor = monitorFor(snapshot, calls);
  const ctx = planningContext();
  await monitor.refresh(ctx);
  const plan = await buildQuotaResumePlan({
    ctx,
    branch: quotaBranch(),
    monitor,
    enabled: true,
    now: () => NOW,
  });
  assert.ok(plan);
  assert.equal(calls.count, 2);
});

test("unavailable fresh usage produces no plan and no session lookup", async () => {
  let sessionLookups = 0;
  const result = await buildQuotaResumePlan({
    ctx: planningContext(() => {
      sessionLookups += 1;
      return "unexpected";
    }),
    branch: quotaBranch(),
    monitor: monitorFor(null),
    enabled: true,
    now: () => NOW,
  });
  assert.equal(result, null);
  assert.equal(sessionLookups, 0);
});

test("a valid plan uses the assistant's provider/model facts and only reads the session id last", async () => {
  const calls: string[] = [];
  const plan = await buildQuotaResumePlan({
    ctx: planningContext(() => {
      calls.push("session-id");
      return "session-for-test";
    }),
    branch: quotaBranch({ model: "o3-codex" }),
    monitor: monitorFor(usageSnapshot({ fiveResetsAt: NOW + 5_000 })),
    enabled: true,
    now: () => NOW,
  });
  assert.deepEqual(plan, {
    sessionId: "session-for-test",
    anchorEntryId: "quota",
    provider: "openai-codex",
    modelId: "o3-codex",
    detectedAt: NOW,
    resumeAt: NOW + 5_000 + QUOTA_RESET_GRACE_MS,
  });
  assert.deepEqual(calls, ["session-id"]);
});
