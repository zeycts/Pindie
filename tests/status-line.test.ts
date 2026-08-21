import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import type { PindieState, PindieTask } from "../src/state.ts";
import {
  deriveStatusLayout,
  deriveStatusSegments,
  getVerificationProgress,
  renderStatusLayout,
  renderStatusSegments,
  type StatusTone,
} from "../src/status-line.ts";

function task(overrides: Partial<PindieTask> = {}): PindieTask {
  return {
    goal: "Render Pindie status",
    constraints: [],
    successCriteria: [
      { id: "c1", description: "Timer works" },
      { id: "c2", description: "Verification works" },
      { id: "c3", description: "Alerts work" },
      { id: "c4", description: "Theme works" },
    ],
    openLoops: { blockers: [], questions: [], nextIntent: null },
    verification: { stale: false, checks: [] },
    humanGate: null,
    completed: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<Parameters<typeof deriveStatusSegments>[0]> = {}) {
  return {
    timing: { durationMs: 134_000, active: true },
    state: { task: task() } satisfies PindieState,
    stateUnavailableReason: null,
    ...overrides,
  };
}

function segments(overrides: Partial<Parameters<typeof deriveStatusSegments>[0]> = {}) {
  return deriveStatusSegments(snapshot(overrides));
}

const now = 1_700_000_000_000;
const day = 24 * 60 * 60 * 1_000;
const countdownReset = now + 6 * day + 23 * 60 * 60 * 1_000 + 59 * 60 * 1_000;

test("active Run presents dim timing and neutral pending verification", () => {
  assert.deepEqual(segments(), [
    { text: "⏱ 2m 14s", tone: "dim" },
    { text: "verify 0/4", tone: "text" },
  ]);
});

test("Run Cost is dim and follows the timer before verification and attention", () => {
  assert.deepEqual(segments({
    runCost: { cost: 0.14, active: true },
    state: {
      task: task({
        openLoops: { blockers: ["Waiting"], questions: [], nextIntent: null },
      }),
    },
  }), [
    { text: "⏱ 2m 14s", tone: "dim" },
    { text: "$0.14", tone: "dim" },
    { text: "verify 0/4", tone: "text" },
    { text: "⚠ blocked", tone: "warning" },
  ]);
});

test("settled Run presents final duration and passed verification", () => {
  const result = segments({
    timing: { durationMs: 291_000, active: false },
    state: {
      task: task({
        verification: {
          stale: false,
          checks: [
            { name: "all", status: "passed", covers: ["c1", "c2", "c3", "c4"], evidence: "passed" },
          ],
        },
      }),
    },
  });

  assert.deepEqual(result, [
    { text: "last 4m 51s", tone: "dim" },
    { text: "✓ 4/4", tone: "success" },
  ]);
});

test("partial passed criterion coverage remains normal verification progress", () => {
  assert.deepEqual(segments({
    state: { task: task({ verification: { stale: false, checks: [
      { name: "partial", status: "passed", covers: ["c1", "c2"], evidence: "passed" },
    ] } }) },
  }).at(1), { text: "verify 2/4", tone: "text" });
});

test("verification progress counts distinct criteria covered by passed checks", () => {
  const progress = getVerificationProgress(task({
    verification: {
      stale: false,
      checks: [
        { name: "first", status: "passed", covers: ["c1", "c2"], evidence: "passed" },
        { name: "overlap", status: "passed", covers: ["c2", "c3"], evidence: "passed" },
        { name: "failure", status: "failed", covers: ["c4"], evidence: "failed" },
      ],
    },
  }));

  assert.deepEqual(progress, { covered: 3, total: 4 });
  assert.deepEqual(segments({
    state: { task: task({ verification: { stale: false, checks: [
      { name: "first", status: "passed", covers: ["c1", "c2"], evidence: "passed" },
      { name: "overlap", status: "passed", covers: ["c2", "c3"], evidence: "passed" },
      { name: "failure", status: "failed", covers: ["c4"], evidence: "failed" },
    ] } }) },
  }).at(1), { text: "verify failed 3/4", tone: "error" });
});

test("stale verification suppresses historical progress and uses warning", () => {
  assert.deepEqual(segments({
    state: { task: task({ verification: { stale: true, checks: [] } }) },
  }).at(1), { text: "verify stale", tone: "warning" });
});

test("Human Gate takes precedence over blocked attention and uses warning", () => {
  assert.deepEqual(segments({
    state: {
      task: task({
        openLoops: { blockers: ["Waiting for access"], questions: [], nextIntent: null },
        humanGate: { kind: "approval", question: "Approve release?" },
      }),
    },
  }).at(-1), { text: "⚠ gate: approval", tone: "warning" });
});

test("blocked and unavailable State each use their actionable semantic tone", () => {
  assert.deepEqual(segments({
    state: { task: task({ openLoops: { blockers: ["Dependency offline"], questions: [], nextIntent: null } }) },
  }).at(-1), { text: "⚠ blocked", tone: "warning" });

  assert.deepEqual(segments({
    state: null,
    stateUnavailableReason: "State file cannot load",
  }).at(-1), { text: "⚠ state unavailable", tone: "error" });
});

test("no task omits verification and preserves timing only", () => {
  assert.deepEqual(segments({ state: { task: null } }), [
    { text: "⏱ 2m 14s", tone: "dim" },
  ]);
});

test("weekly account status is dim and derives its reset countdown at render time", () => {
  const withUsage = deriveStatusLayout({
    ...snapshot(),
    subscriptionUsage: {
      fetchedAt: 1,
      windows: [{ usedPercent: 48, windowMinutes: 10_080, resetsAt: countdownReset }],
    },
  }, now);
  assert.deepEqual(withUsage.right, [
    { text: "w52%", tone: "dim" },
    { text: "↻6d23h", tone: "dim" },
  ]);
  assert.deepEqual(deriveStatusLayout({ ...snapshot(), subscriptionUsage: null }, now).right, []);
  assert.deepEqual(deriveStatusLayout({
    ...snapshot(),
    subscriptionUsage: { fetchedAt: 1, windows: [{ usedPercent: 48, windowMinutes: 10_080 }] },
  }, now).right, [{ text: "w52%", tone: "dim" }]);
  assert.deepEqual(deriveStatusLayout({
    ...snapshot(),
    subscriptionUsage: { fetchedAt: 1, windows: [{ usedPercent: 48, windowMinutes: 10_080, resetsAt: now }] },
  }, now).right, [{ text: "w52%", tone: "dim" }]);
});

test("Run Cost preserves right-aligned weekly usage", () => {
  const layout = deriveStatusLayout({
    ...snapshot({
      timing: { durationMs: 9_000, active: false },
      state: { task: task({ verification: { stale: true, checks: [] } }) },
    }),
    runCost: { cost: 0.008, active: false },
    subscriptionUsage: {
      fetchedAt: 1,
      windows: [{ usedPercent: 3, windowMinutes: 10_080, resetsAt: countdownReset }],
    },
  }, now);
  const rendered = renderStatusLayout({ fg: (_tone, text) => text }, layout, 70)!;

  assert.equal(visibleWidth(rendered), 70);
  assert.match(rendered, /last 9s • \$0.008 • verify stale/);
  assert.match(rendered, /w97% • ↻6d23h$/);
});

test("ANSI-aware layout aligns right usage, degrades narrowly, and falls back without width", () => {
  const theme = { fg: (tone: string, text: string) => `\u001b[${tone}m${text}\u001b[0m` } as any;
  const layout = {
    left: [{ text: "⏱ 4m 27s", tone: "dim" as const }, { text: "verify 3/4", tone: "text" as const }],
    right: [{ text: "w52%", tone: "dim" as const }, { text: "↻6d23h", tone: "dim" as const }],
  };
  const wide = renderStatusLayout(theme, layout, 50)!;
  assert.equal(visibleWidth(wide), 50);
  const narrow = renderStatusLayout(theme, layout, 18)!;
  assert.ok(visibleWidth(narrow) <= 18);
  assert.match(narrow, /w52%/);
  assert.match(renderStatusLayout(theme, layout), /verify.*w52%/);
});

test("theme rendering styles individual segments and dim separators without ANSI assertions", () => {
  const calls: Array<{ tone: StatusTone; text: string }> = [];
  const rendered = renderStatusSegments({
    fg: (tone, text) => {
      calls.push({ tone: tone as StatusTone, text });
      return `[${tone}:${text}]`;
    },
  }, [
    { text: "⏱ 42s", tone: "dim" },
    { text: "verify 2/4", tone: "text" },
    { text: "⚠ blocked", tone: "warning" },
  ]);

  assert.equal(rendered, "[dim:⏱ 42s][dim: • ][text:verify 2/4][dim: • ][warning:⚠ blocked]");
  assert.deepEqual(calls, [
    { tone: "dim", text: "⏱ 42s" },
    { tone: "text", text: "verify 2/4" },
    { tone: "warning", text: "⚠ blocked" },
    { tone: "dim", text: " • " },
  ]);
});
