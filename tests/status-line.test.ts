import assert from "node:assert/strict";
import test from "node:test";

import type { PindieState, PindieTask } from "../src/state.ts";
import {
  deriveStatusSegments,
  getVerificationProgress,
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

test("active Run presents dim timing and neutral pending verification", () => {
  assert.deepEqual(segments(), [
    { text: "⏱ 2m 14s", tone: "dim" },
    { text: "verify 0/4", tone: "text" },
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
