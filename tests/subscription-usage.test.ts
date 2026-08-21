import assert from "node:assert/strict";
import test from "node:test";

import {
  formatResetTime,
  getRemainingPercent,
  parseSubscriptionUsage,
  selectWeeklyWindow,
} from "../src/subscription-usage.ts";

test("weekly usage is selected by declared duration, not response ordering", () => {
  const snapshot = parseSubscriptionUsage({
    rate_limit: {
      secondary_window: { used_percent: 48, window_minutes: 300, resets_at: 1 },
      primary_window: { used_percent: 48, window_minutes: 10_080, resets_at: 2 },
    },
  }, 10)!;

  assert.deepEqual(selectWeeklyWindow(snapshot), {
    usedPercent: 48,
    windowMinutes: 10_080,
    resetsAt: 2_000,
  });
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

test("reset time delegates deterministic local HH:mm formatting", () => {
  assert.equal(
    formatResetTime(1_700_000_000_000, () => "18:29"),
    "18:29",
  );
});
