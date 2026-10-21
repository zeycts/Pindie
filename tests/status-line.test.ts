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
    consumption: { scope: "task" as const, durationMs: 134_000, cost: 0 },
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

test("SSA-S02 active unfinished Task renders lifecycle before pending verification", () => {
  assert.deepEqual(segments(), [
    { text: "task 2m 14s", tone: "dim" },
    { text: "$0.000", tone: "dim" },
    { text: "active", tone: "text" },
    { text: "verify 0/4", tone: "text" },
  ]);
});

test("status ignores legacy thinking fields and preserves activity and semantics", () => {
  assert.deepEqual(segments({ reasoningMode: "manual", thinkingLevel: "high", activity: "running" }), [
    { text: "task 2m 14s", tone: "dim" },
    { text: "$0.000", tone: "dim" },
    { text: "running", tone: "accent" },
    { text: "active", tone: "text" },
    { text: "verify 0/4", tone: "text" },
  ]);
  assert.equal(segments({ reasoningMode: "manual" }).some(({ text }) => text === "manual"), false);
  assert.deepEqual(segments({ thinkingLevel: "off" }), segments());
});

test("Run Cost and accent Activity follow the timer before verification and attention", () => {
  assert.deepEqual(segments({
    consumption: { scope: "task", durationMs: 134_000, cost: 0.14 },
    activity: "editing",
    state: {
      task: task({
        openLoops: { blockers: ["Waiting"], questions: [], nextIntent: null },
      }),
    },
  }), [
    { text: "task 2m 14s", tone: "dim" },
    { text: "$0.14", tone: "dim" },
    { text: "editing", tone: "accent" },
    { text: "verify 0/4", tone: "text" },
    { text: "⚠ blocked", tone: "warning" },
  ]);
});

test("settled Run omits cleared Activity and presents final duration and passed verification", () => {
  const result = segments({
    consumption: { scope: "task", durationMs: 291_000, cost: 0.41 },
    activity: null,
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
    { text: "task 4m 51s", tone: "dim" },
    { text: "$0.41", tone: "dim" },
    { text: "active", tone: "text" },
    { text: "✓ 4/4", tone: "success" },
  ]);
});

test("partial passed criterion coverage remains normal verification progress", () => {
  assert.deepEqual(segments({
    state: { task: task({ verification: { stale: false, checks: [
      { name: "partial", status: "passed", covers: ["c1", "c2"], evidence: "passed" },
    ] } }) },
  }).at(3), { text: "verify 2/4", tone: "text" });
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
  }).at(3), { text: "verify failed 3/4", tone: "error" });
});

test("stale verification suppresses historical progress and uses warning", () => {
  assert.deepEqual(segments({
    state: { task: task({ verification: { stale: true, checks: [] } }) },
  }).at(3), { text: "verify stale", tone: "warning" });
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

test("SSA-S03 through SSA-S11 lifecycle and attention preserve independent semantic truth", () => {
  const passed = { stale: false, checks: [
    { name: "all", status: "passed" as const, covers: ["c1", "c2", "c3", "c4"], evidence: "passed" },
  ] };
  assert.deepEqual(segments({ state: { task: task({ verification: passed }) } }).slice(2), [
    { text: "active", tone: "text" }, { text: "✓ 4/4", tone: "success" },
  ]);
  assert.deepEqual(segments({ state: { task: task({ completed: true, verification: passed, openLoops: { blockers: [], questions: [], nextIntent: null } }) } }).slice(2), [
    { text: "done", tone: "success" }, { text: "✓ 4/4", tone: "success" },
  ]);
  assert.deepEqual(segments({ state: { task: task({ openLoops: { blockers: ["blocked"], questions: [], nextIntent: null } }) } }).slice(2), [
    { text: "verify 0/4", tone: "text" }, { text: "⚠ blocked", tone: "warning" },
  ]);
  assert.deepEqual(segments({ state: { task: task({ humanGate: { kind: "approval", question: "Approve?" } }) } }).slice(2), [
    { text: "verify 0/4", tone: "text" }, { text: "⚠ gate: approval", tone: "warning" },
  ]);
  assert.deepEqual(segments({ runStale: true }).slice(2), [
    { text: "active", tone: "text" }, { text: "verify 0/4", tone: "text" }, { text: "⚠ stale run", tone: "warning" },
  ]);
  assert.equal(segments({ runStale: true, state: { task: task({ humanGate: { kind: "input", question: "Input?" } }) } }).some(({ text }) => text === "⚠ stale run"), false);
  assert.deepEqual(segments({ runStale: true, state: { task: task({ openLoops: { blockers: ["blocked"], questions: [], nextIntent: null } }) } }).at(-1), { text: "⚠ stale run", tone: "warning" });
  assert.deepEqual(segments({ runStale: true, state: null, stateUnavailableReason: "missing" }).slice(2), [
    { text: "⚠ state unavailable", tone: "error" },
  ]);
});

test("quota waiting replaces active, stays accent, and preserves verification and attention", () => {
  const result = segments({ quotaResumeWaiting: true });
  assert.deepEqual(result.slice(2), [
    { text: "waiting · quota", tone: "accent" },
    { text: "verify 0/4", tone: "text" },
  ]);
  assert.equal(result.some(({ text }) => text === "active"), false);

  const attention = segments({
    quotaResumeWaiting: true,
    runStale: true,
    state: { task: task({ humanGate: { kind: "input", question: "Input?" } }) },
  });
  assert.equal(attention.at(-1)?.text, "⚠ gate: input");
});

test("no-Task quota waiting remains visible", () => {
  assert.deepEqual(segments({
    consumption: { scope: "run", durationMs: 134_000, cost: 0 },
    state: { task: null },
    quotaResumeWaiting: true,
  }), [
    { text: "run 2m 14s", tone: "dim" },
    { text: "$0.000", tone: "dim" },
    { text: "waiting · quota", tone: "accent" },
  ]);
});

test("no-Task Run uses run consumption scope and omits idle verification", () => {
  assert.deepEqual(segments({
    consumption: { scope: "run", durationMs: 134_000, cost: 0 },
    state: { task: null },
  }), [
    { text: "run 2m 14s", tone: "dim" },
    { text: "$0.000", tone: "dim" },
  ]);
});

test("no-Task Run suppresses stale completed-Task lifecycle and verification", () => {
  const passed = { stale: false, checks: [
    { name: "all", status: "passed" as const, covers: ["c1", "c2", "c3", "c4"], evidence: "passed" },
  ] };
  const result = segments({
    consumption: { scope: "run", durationMs: 42_000, cost: 0.006 },
    reasoningMode: "manual",
    state: { task: task({ completed: true, verification: passed }) },
  });

  assert.deepEqual(result, [
    { text: "run 42s", tone: "dim" },
    { text: "$0.006", tone: "dim" },
  ]);
  assert.equal(result.some(({ text }) => text.startsWith("last ")), false);
});

test("SIR-M01 through SIR-M10 representative status matrix locks semantic boundaries", () => {
  const passed = {
    stale: false,
    checks: [{
      name: "all",
      status: "passed" as const,
      covers: ["c1", "c2", "c3", "c4"],
      evidence: "passed",
    }],
  };
  const cases = [
    { name: "idle", input: { activity: null, state: { task: null } }, expected: ["idle"], absent: ["verify"] },
    { name: "reading pending", input: { activity: "reading" as const }, expected: ["reading", "active", "verify 0/4"] },
    { name: "editing stale", input: { activity: "editing" as const, state: { task: task({ verification: { stale: true, checks: [] } }) } }, expected: ["editing", "active", "verify stale"] },
    { name: "running active passed", input: { activity: "running" as const, state: { task: task({ verification: passed }) } }, expected: ["running", "active", "✓ 4/4"], absent: ["done"] },
    { name: "done passed", input: { activity: null, state: { task: task({ completed: true, verification: passed }) } }, expected: ["done", "✓ 4/4"], absent: ["active"] },
    { name: "blocked", input: { activity: null, state: { task: task({ openLoops: { blockers: ["blocked"], questions: [], nextIntent: null } }) } }, expected: ["verify 0/4", "⚠ blocked"], absent: ["active", "blocked"] },
    { name: "waiting human", input: { activity: null, state: { task: task({ humanGate: { kind: "approval", question: "Approve?" } }) } }, expected: ["verify 0/4", "⚠ gate: approval"], absent: ["active", "waiting", "waiting_human"] },
    { name: "stale active Run", input: { activity: null, runStale: true, state: { task: task({ verification: passed }) } }, expected: ["active", "✓ 4/4", "⚠ stale run"] },
  ];

  for (const scenario of cases) {
    const texts = deriveStatusSegments(snapshot({ consumption: null, ...scenario.input })).map(({ text }) => text);
    for (const expected of scenario.expected) assert.ok(texts.includes(expected), scenario.name);
    for (const absent of scenario.absent ?? []) assert.equal(texts.includes(absent), false, scenario.name);
  }

  const full = deriveStatusSegments(snapshot({
    activity: "reading",
    runStale: true,
    state: { task: task({ verification: { stale: true, checks: [] } }) },
  })).map(({ text }) => text);
  assert.ok(full.indexOf("reading") < full.indexOf("active"));
  assert.ok(full.indexOf("active") < full.indexOf("verify stale"));
  assert.ok(full.indexOf("verify stale") < full.indexOf("⚠ stale run"));
});

test("SIR-M09 attention precedence shows exactly one primary condition", () => {
  const attention = ["⚠ state unavailable", "⚠ gate: input", "⚠ stale run", "⚠ blocked"];
  const blocked = { blockers: ["blocked"], questions: [], nextIntent: null };
  const cases = [
    { name: "unavailable", input: { state: null, stateUnavailableReason: "missing", runStale: true }, expected: "⚠ state unavailable" },
    { name: "gate", input: { state: { task: task({ humanGate: { kind: "input", question: "Input?" }, openLoops: blocked }) }, runStale: true }, expected: "⚠ gate: input" },
    { name: "stale", input: { state: { task: task({ openLoops: blocked }) }, runStale: true }, expected: "⚠ stale run" },
    { name: "blocker", input: { state: { task: task({ openLoops: blocked }) } }, expected: "⚠ blocked" },
  ];

  for (const scenario of cases) {
    const texts = deriveStatusSegments(snapshot({ consumption: null, ...scenario.input })).map(({ text }) => text);
    assert.deepEqual(texts.filter((text) => attention.includes(text)), [scenario.expected], scenario.name);
  }
});

function usageLayout(windows: Array<{ usedPercent: number; windowMinutes: number; resetsAt?: number }>, creditExpiry?: number) {
  return deriveStatusLayout({
    ...snapshot(),
    subscriptionUsage: {
      fetchedAt: 1,
      windows,
      ...(creditExpiry === undefined ? {} : { resetCredits: {
        availableCount: 1,
        credits: [{ id: "credit", resetType: "codex_rate_limits", status: "available", expiresAt: creditExpiry }],
      } }),
    },
  }, now);
}

test("subscription status independently renders full, compact, and minimum quota variants", () => {
  const layout = usageLayout([
    { usedPercent: 20, windowMinutes: 300, resetsAt: now + 3 * 60 * 60 * 1_000 + 8 * 60 * 1_000 },
    { usedPercent: 30, windowMinutes: 10_080, resetsAt: countdownReset },
  ], now + 6 * 24 * 60 * 60 * 1_000);
  assert.deepEqual(layout.right, [
    { text: "5h 80%", tone: "dim" }, { text: "↻ 3h+", tone: "dim" },
    { text: "wk 70%", tone: "dim" }, { text: "↻ 6d+", tone: "dim" },
    { text: "⟳ 1", tone: "dim" },
  ]);
  assert.deepEqual(layout.compactRight?.map(({ text }) => text), ["5h 80%", "wk 70%", "⟳ 1"]);
  assert.deepEqual(layout.minimumRight?.map(({ text }) => text), ["5h 80%", "wk 70%"]);

  assert.deepEqual(usageLayout([{ usedPercent: 17, windowMinutes: 300, resetsAt: now + 4 * 60 * 60 * 1_000 }]).right.map(({ text }) => text), ["5h 83%", "↻ 4h+"]);
  assert.deepEqual(usageLayout([{ usedPercent: 30, windowMinutes: 10_080, resetsAt: countdownReset }]).right.map(({ text }) => text), ["wk 70%", "↻ 6d+"]);
  assert.deepEqual(usageLayout([]).right, []);
});

test("compact layout removes near-expiry detail even when its segment count matches full", () => {
  const layout = usageLayout([
    { usedPercent: 20, windowMinutes: 300 },
    { usedPercent: 30, windowMinutes: 10_080 },
  ], now + 2 * day);
  assert.deepEqual(layout.right.map(({ text }) => text), ["5h 80%", "wk 70%", "⟳ 1 · 2d"]);
  assert.deepEqual(layout.compactRight?.map(({ text }) => text), ["5h 80%", "wk 70%", "⟳ 1"]);

  const theme = { fg: (_tone: string, text: string) => text };
  const compactWidth = visibleWidth(renderStatusSegments(theme, layout.compactRight!));
  const rendered = renderStatusLayout(theme, {
    ...layout,
    left: [{ text: "run", tone: "text" }],
  }, visibleWidth("run") + 2 + compactWidth)!;
  assert.match(rendered, /5h 80% • wk 70% • ⟳ 1$/);
});

test("quota tones use displayed remaining-percent boundaries", () => {
  for (const [usedPercent, tone] of [[89, "dim"], [90, "warning"], [94, "warning"], [95, "error"], [100, "error"]] as const) {
    const layout = usageLayout([{ usedPercent, windowMinutes: 300 }, { usedPercent, windowMinutes: 10_080 }]);
    assert.deepEqual(layout.right.map(({ tone: actual }) => actual), [tone, tone]);
  }
});

test("credit expiry is shown only at or within the real five-day threshold", () => {
  const windows = [{ usedPercent: 32, windowMinutes: 10_080, resetsAt: countdownReset }];
  assert.deepEqual(usageLayout(windows, now + 5 * day + 1).right.map(({ text }) => text).at(-1), "⟳ 1");
  assert.deepEqual(usageLayout(windows, now + 5 * day).right.map(({ text }) => text).at(-1), "⟳ 1 · 5d");
  assert.deepEqual(usageLayout(windows, now + 2 * day + 7 * 60 * 60 * 1_000).right.map(({ text }) => text).at(-1), "⟳ 1 · 2d");

  const incomplete = deriveStatusLayout({ ...snapshot(), subscriptionUsage: {
    fetchedAt: 1, windows, resetCredits: { availableCount: 3, credits: [{ id: "one", resetType: "codex_rate_limits", status: "available", expiresAt: now + day }] },
  } }, now);
  assert.deepEqual(incomplete.right.map(({ text }) => text).at(-1), "⟳ 3");
});

test("attention quota resets survive compact degradation before reset credits", () => {
  const layout = usageLayout([
    { usedPercent: 92, windowMinutes: 300, resetsAt: now + 32 * 60 * 1_000 },
    { usedPercent: 75, windowMinutes: 10_080, resetsAt: now + 8 * 60 * 60 * 1_000 },
  ], now + day);
  assert.deepEqual(layout.compactRight?.map(({ text }) => text), ["5h 8%", "↻ 32m", "wk 25%", "⟳ 1"]);
  assert.deepEqual(layout.attentionRight?.map(({ text }) => text), ["5h 8%", "↻ 32m", "wk 25%"]);

  const rendered = renderStatusLayout({ fg: (_tone, text) => text }, { left: [{ text: "ordinary run information", tone: "text" }], ...layout }, 36)!;
  assert.ok(visibleWidth(rendered) <= 36);
  assert.match(rendered, /5h 8% • ↻ 32m • wk 25%$/);

  const waitingLayout = deriveStatusLayout({
    ...snapshot({ quotaResumeWaiting: true }),
    subscriptionUsage: {
      fetchedAt: 1,
      windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: now + 32 * 60 * 1_000 }],
    },
  }, now);
  const narrow = renderStatusLayout(
    { fg: (_tone, text) => text },
    waitingLayout,
    visibleWidth("5h 0% • ↻ 32m"),
  )!;
  assert.equal(narrow, "5h 0% • ↻ 32m");
});

test("Current Activity preserves right-aligned weekly usage", () => {
  const layout = usageLayout([{ usedPercent: 3, windowMinutes: 10_080, resetsAt: countdownReset }]);
  const rendered = renderStatusLayout({ fg: (_tone, text) => text }, layout, 60)!;
  assert.equal(visibleWidth(rendered), 60);
  assert.match(rendered, /wk 97% • ↻ 6d\+$/);
});

test("legacy thinking levels never render or reserve space at wide or narrow widths", () => {
  const theme = { fg: (_tone: string, text: string) => text };
  const input = {
    ...snapshot({ activity: "editing" }),
    subscriptionUsage: { fetchedAt: now, windows: [{ usedPercent: 20, windowMinutes: 300 }] },
  };
  const baseline = deriveStatusLayout(input, now);
  for (const thinkingLevel of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
    const layout = deriveStatusLayout({ ...input, reasoningMode: "manual", thinkingLevel }, now);
    assert.deepEqual(layout, baseline);
    for (const width of [undefined, ...Array.from({ length: 160 }, (_, index) => index + 1)]) {
      const rendered = renderStatusLayout(theme, layout, width)!;
      assert.equal(rendered, renderStatusLayout(theme, baseline, width));
      assert.doesNotMatch(rendered, /thinking/);
      if (width !== undefined) assert.ok(visibleWidth(rendered) <= width);
    }
  }
  const wide = renderStatusLayout(theme, baseline, 160)!;
  assert.match(wide, /task 2m 14s • \$0.000 • editing • active • verify 0\/4/);
  assert.match(wide, /5h 80%$/);
});

test("ANSI-aware layout aligns right usage, degrades narrowly, and falls back without width", () => {
  const theme = { fg: (tone: string, text: string) => `\u001b[${tone}m${text}\u001b[0m` } as any;
  const layout = {
    left: [{ text: "task 4m 27s", tone: "dim" as const }, { text: "verify 3/4", tone: "text" as const }],
    right: [{ text: "◉ 52%", tone: "dim" as const }, { text: "↻ 6d23h", tone: "dim" as const }],
  };
  const wide = renderStatusLayout(theme, layout, 50)!;
  assert.equal(visibleWidth(wide), 50);
  const narrow = renderStatusLayout(theme, layout, 18)!;
  assert.ok(visibleWidth(narrow) <= 18);
  assert.match(narrow, /◉ 52%/);
  assert.match(renderStatusLayout(theme, layout), /verify.*◉ 52%/);
});

test("theme rendering styles individual segments and dim separators without ANSI assertions", () => {
  const calls: Array<{ tone: StatusTone; text: string }> = [];
  const rendered = renderStatusSegments({
    fg: (tone, text) => {
      calls.push({ tone: tone as StatusTone, text });
      return `[${tone}:${text}]`;
    },
  }, [
    { text: "run 42s", tone: "dim" },
    { text: "verify 2/4", tone: "text" },
    { text: "⚠ blocked", tone: "warning" },
  ]);

  assert.equal(rendered, "[dim:run 42s][dim: • ][text:verify 2/4][dim: • ][warning:⚠ blocked]");
  assert.deepEqual(calls, [
    { tone: "dim", text: "run 42s" },
    { tone: "text", text: "verify 2/4" },
    { tone: "warning", text: "⚠ blocked" },
    { tone: "dim", text: " • " },
  ]);
});
