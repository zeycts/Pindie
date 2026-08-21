import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createChatGptSubscriptionUsageProvider,
  formatResetCountdown,
  getRemainingPercent,
  parseSubscriptionUsage,
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

test("real Codex rate_limit windows select the seven-day duration, not position", () => {
  const snapshot = parseSubscriptionUsage(realUsagePayload(18_000, 604_800), 10)!;

  assert.deepEqual(selectWeeklyWindow(snapshot), {
    usedPercent: 48,
    windowMinutes: 10_080,
    resetsAt: 1_700_100_000_000,
  });
});

test("real Codex weekly window is selected when it precedes a five-hour window", () => {
  const snapshot = parseSubscriptionUsage(realUsagePayload(604_800, 18_000), 10)!;

  assert.deepEqual(selectWeeklyWindow(snapshot), {
    usedPercent: 23,
    windowMinutes: 10_080,
    resetsAt: 1_700_000_000_000,
  });
});

test("parser supports nested rate-limit groups and compatibility minute aliases", () => {
  const snapshot = parseSubscriptionUsage({
    rate_limits: {
      codex: realUsagePayload(18_000, 604_800).rate_limit,
      compatibility: { usedPercent: 11, windowMinutes: 300, resetsAt: 1 },
    },
  }, 10)!;

  assert.equal(snapshot.windows.length, 3);
  assert.equal(selectWeeklyWindow(snapshot)?.usedPercent, 48);
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

  assert.equal(formatResetCountdown(now + 6 * day + 23 * hour + 59 * minute, now), "6d23h");
  assert.equal(formatResetCountdown(now + day, now), "1d0h");
  assert.equal(formatResetCountdown(now + 23 * hour + 42 * minute, now), "23h42m");
  assert.equal(formatResetCountdown(now + 3 * hour + 8 * minute, now), "3h8m");
  assert.equal(formatResetCountdown(now + 42 * minute, now), "42m");
  assert.equal(formatResetCountdown(now + 17_000, now), "<1m");
});

test("reset countdown handles boundaries and expired timestamps", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  assert.equal(formatResetCountdown(now + day, now), "1d0h");
  assert.equal(formatResetCountdown(now + day - 1, now), "23h59m");
  assert.equal(formatResetCountdown(now + hour, now), "1h0m");
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
