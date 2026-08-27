import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createChatGptSubscriptionUsageProvider,
  formatCreditExpiryCountdown,
  formatResetCountdown,
  getRemainingPercent,
  parseResetCreditDetails,
  parseSubscriptionUsage,
  selectEarliestResetCreditExpiry,
  selectFiveHourWindow,
  selectWeeklyWindow,
} from "../src/subscription-usage.ts";

const accountId = "account-for-test";
const accessToken = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: accountId },
})).toString("base64url")}.signature`;

function context(): ExtensionContext {
  return {
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: accessToken } };
      },
    },
  } as unknown as ExtensionContext;
}

function realUsagePayload(primarySeconds: number, secondarySeconds: number) {
  return {
    rate_limit: {
      primary_window: {
        used_percent: 23,
        limit_window_seconds: primarySeconds,
        reset_after_seconds: 100,
        reset_at: 1_700_000_000,
      },
      secondary_window: {
        used_percent: 48,
        limit_window_seconds: secondarySeconds,
        reset_after_seconds: 100,
        reset_at: 1_700_100_000,
      },
    },
  };
}

test("five-hour and weekly windows are selected by duration, independently of order", () => {
  const fiveHourFirst = parseSubscriptionUsage(realUsagePayload(18_000, 604_800), 10)!;
  const weeklyFirst = parseSubscriptionUsage(realUsagePayload(604_800, 18_000), 10)!;

  assert.deepEqual(selectFiveHourWindow(fiveHourFirst), {
    usedPercent: 23,
    windowMinutes: 300,
    resetsAt: 1_700_000_000_000,
  });
  assert.deepEqual(selectWeeklyWindow(fiveHourFirst), {
    usedPercent: 48,
    windowMinutes: 10_080,
    resetsAt: 1_700_100_000_000,
  });
  assert.deepEqual(selectFiveHourWindow(weeklyFirst)?.usedPercent, 48);
  assert.deepEqual(selectWeeklyWindow(weeklyFirst)?.usedPercent, 23);
});

test("five-hour selection excludes unrelated nearby durations", () => {
  const snapshot = {
    fetchedAt: 10,
    windows: [
      { usedPercent: 40, windowMinutes: 240 },
      { usedPercent: 50, windowMinutes: 360 },
      { usedPercent: 60, windowMinutes: 300 },
      { usedPercent: 70, windowMinutes: 10_080 },
    ],
  };

  assert.equal(selectFiveHourWindow({ ...snapshot, windows: [snapshot.windows[0]!] }), null);
  assert.equal(selectFiveHourWindow({ ...snapshot, windows: [snapshot.windows[1]!] }), null);
  assert.equal(selectFiveHourWindow(snapshot)?.usedPercent, 60);
  assert.equal(selectWeeklyWindow(snapshot)?.usedPercent, 70);
});

test("parser supports nested rate-limit groups and compatibility minute aliases", () => {
  const snapshot = parseSubscriptionUsage({
    rate_limits: {
      codex: realUsagePayload(18_000, 604_800).rate_limit,
      compatibility: { usedPercent: 11, windowMinutes: 300, resetsAt: 1 },
    },
  }, 10)!;

  assert.equal(snapshot.windows.length, 3);
  assert.equal(selectFiveHourWindow(snapshot)?.usedPercent, 23);
  assert.equal(selectWeeklyWindow(snapshot)?.usedPercent, 48);
  assert.equal(selectFiveHourWindow({ windows: [{ usedPercent: 48 }], fetchedAt: 10 }), null);
  assert.equal(selectWeeklyWindow({ windows: [{ usedPercent: 48 }], fetchedAt: 10 }), null);
});

test("remaining subscription percentage clamps and rounds used percentage", () => {
  assert.equal(getRemainingPercent(48), 52);
  assert.equal(getRemainingPercent(0), 100);
  assert.equal(getRemainingPercent(100), 0);
  assert.equal(getRemainingPercent(99.6), 0);
  assert.equal(getRemainingPercent(-10), 100);
  assert.equal(getRemainingPercent(110), 0);
});

test("real reset_at timestamps are converted from seconds", () => {
  const snapshot = parseSubscriptionUsage(realUsagePayload(18_000, 604_800))!;
  assert.equal(selectWeeklyWindow(snapshot)?.resetsAt, 1_700_100_000_000);
});

test("reset countdown uses compact floor-based, timezone-independent units", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  assert.equal(formatResetCountdown(now + 6 * day + 23 * hour + 59 * minute, now), "6d+");
  assert.equal(formatResetCountdown(now + day, now), "1d+");
  assert.equal(formatResetCountdown(now + 23 * hour + 42 * minute, now), "23h+");
  assert.equal(formatResetCountdown(now + 3 * hour + 8 * minute, now), "3h+");
  assert.equal(formatResetCountdown(now + 42 * minute, now), "42m");
  assert.equal(formatResetCountdown(now + 17_000, now), "<1m");
});

test("reset countdown handles boundaries and expired timestamps", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  assert.equal(formatResetCountdown(now + day, now), "1d+");
  assert.equal(formatResetCountdown(now + day - 1, now), "23h+");
  assert.equal(formatResetCountdown(now + hour, now), "1h+");
  assert.equal(formatResetCountdown(now + hour - 1, now), "59m");
  assert.equal(formatResetCountdown(now + minute, now), "1m");
  assert.equal(formatResetCountdown(now + minute - 1, now), "<1m");
  assert.equal(formatResetCountdown(now, now), null);
  assert.equal(formatResetCountdown(now - 1, now), null);
});

test("injected transport fetches a real-shaped payload with bounded canonical headers", async () => {
  let request: { url: string; init: RequestInit } | null = null;
  const provider = createChatGptSubscriptionUsageProvider({
    async fetch(url, init) {
      request = { url, init };
      return Response.json(realUsagePayload(18_000, 604_800));
    },
  });

  const snapshot = await provider.fetchUsage(context());

  assert.equal(request?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal((request?.init.headers as Record<string, string>)["ChatGPT-Account-Id"], accountId);
  assert.equal((request?.init.headers as Record<string, string>).Authorization, `Bearer ${accessToken}`);
  assert.ok(request?.init.signal);
  assert.equal(selectWeeklyWindow(snapshot)?.usedPercent, 48);
});

test("injected transport rejection remains observable to the best-effort caller", async () => {
  const provider = createChatGptSubscriptionUsageProvider({
    async fetch() {
      throw new DOMException("Timed out", "TimeoutError");
    },
  });

  await assert.rejects(provider.fetchUsage(context()), /Timed out/);
});

test("usage summary parses only a valid authoritative reset-credit count", () => {
  const payload = realUsagePayload(18_000, 604_800);
  Object.assign(payload, { rate_limit_reset_credits: { available_count: 1 } });
  assert.equal(parseSubscriptionUsage(payload, 10)?.resetCredits?.availableCount, 1);

  for (const available_count of [-1, 1.5, "1", Number.NaN]) {
    assert.equal(parseSubscriptionUsage({
      ...payload,
      rate_limit_reset_credits: { available_count },
    }, 10)?.resetCredits, undefined);
  }
});

test("real reset-credit details parse UTC timestamps and ignore invalid timestamps", () => {
  const credits = parseResetCreditDetails({ credits: [{
    id: "credit-for-test",
    reset_type: "codex_rate_limits",
    status: "available",
    granted_at: "2026-08-21T00:00:00Z",
    expires_at: "2026-09-21T00:00:00Z",
  }, {
    id: "invalid-time",
    reset_type: "codex_rate_limits",
    status: "available",
    expires_at: "not-a-date",
  }] });

  assert.deepEqual(credits?.[0], {
    id: "credit-for-test",
    resetType: "codex_rate_limits",
    status: "available",
    grantedAt: Date.parse("2026-08-21T00:00:00Z"),
    expiresAt: Date.parse("2026-09-21T00:00:00Z"),
  });
  assert.equal(credits?.[1]?.expiresAt, undefined);
});

test("earliest expiry requires complete eligible available Codex credit details", () => {
  const now = Date.parse("2026-08-21T00:00:00Z");
  const credit = (id: string, expiresAt: number, status = "available", resetType = "codex_rate_limits") => ({ id, expiresAt, status, resetType });
  const first = now + 29 * 24 * 60 * 60 * 1_000;
  const second = now + 54 * 24 * 60 * 60 * 1_000;

  assert.equal(selectEarliestResetCreditExpiry({
    availableCount: 2,
    credits: [credit("later", second), credit("earlier", first)],
  }, now), first);
  assert.equal(selectEarliestResetCreditExpiry({
    availableCount: 3,
    credits: [credit("earlier", first), credit("later", second)],
  }, now), undefined);
  assert.equal(selectEarliestResetCreditExpiry({
    availableCount: 1,
    credits: [credit("used", first, "consumed"), credit("other", second, "available", "other")],
  }, now), undefined);
});

test("credit expiry countdown uses compact lower-precision, timezone-independent units", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  assert.equal(formatCreditExpiryCountdown(now + 29 * day + 8 * hour, now), "29d");
  assert.equal(formatCreditExpiryCountdown(now + day + 23 * hour, now), "1d");
  assert.equal(formatCreditExpiryCountdown(now + 18 * hour + 32 * minute, now), "18h");
  assert.equal(formatCreditExpiryCountdown(now + 42 * minute, now), "42m");
  assert.equal(formatCreditExpiryCountdown(now + 17_000, now), "<1m");
  assert.equal(formatCreditExpiryCountdown(now, now), null);
});

test("provider avoids details for zero count and retains summary when details fail", async () => {
  const usage = { ...realUsagePayload(18_000, 604_800), rate_limit_reset_credits: { available_count: 0 } };
  let requests = 0;
  const provider = createChatGptSubscriptionUsageProvider({
    async fetch() {
      requests += 1;
      return Response.json(usage);
    },
  });
  assert.equal((await provider.fetchUsage(context()))?.resetCredits?.availableCount, 0);
  assert.equal(requests, 1);

  const positiveProvider = createChatGptSubscriptionUsageProvider({
    async fetch(url) {
      requests += 1;
      if (url.endsWith("/usage")) return Response.json({ ...usage, rate_limit_reset_credits: { available_count: 1 } });
      throw new DOMException("Timed out", "TimeoutError");
    },
  });
  const snapshot = await positiveProvider.fetchUsage(context());
  assert.equal(snapshot?.resetCredits?.availableCount, 1);
  assert.equal(snapshot?.resetCredits?.credits, undefined);
  assert.equal(requests, 3);
});

test("provider fetches positive-count details once during the same refresh", async () => {
  const urls: string[] = [];
  const provider = createChatGptSubscriptionUsageProvider({
    async fetch(url) {
      urls.push(url);
      return url.endsWith("/usage")
        ? Response.json({ ...realUsagePayload(18_000, 604_800), rate_limit_reset_credits: { available_count: 1 } })
        : Response.json({ credits: [] });
    },
  });
  await provider.fetchUsage(context());
  assert.deepEqual(urls, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
  ]);
});
