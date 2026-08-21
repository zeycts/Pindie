import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  RunCostTracker,
  formatRunCost,
  getRunCost,
  getSessionCost,
} from "../src/run-cost.ts";

function usage(total: unknown) {
  return { cost: { total } };
}

let entryId = 0;

function message(role: "assistant" | "toolResult", total?: unknown): SessionEntry {
  return {
    type: "message",
    id: `message-${entryId++}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: role === "assistant"
      ? { role, usage: usage(total) }
      : { role, usage: total === undefined ? undefined : usage(total) },
  } as unknown as SessionEntry;
}

function summary(type: "compaction" | "branch_summary", total?: unknown): SessionEntry {
  return {
    type,
    id: `${type}-${entryId++}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    usage: total === undefined ? undefined : usage(total),
  } as unknown as SessionEntry;
}

test("session cost mirrors Pi footer sources and ignores missing or malformed usage", () => {
  const entries: SessionEntry[] = [
    message("assistant", 0.12),
    message("toolResult", 0.03),
    summary("compaction", 0.04),
    summary("branch_summary", 0.02),
    message("toolResult"),
    message("assistant", Number.NaN),
    summary("compaction", -0.01),
  ];

  assert.equal(getSessionCost(entries), 0.21);
});

test("RunCostTracker measures the new Run against an existing session baseline", () => {
  const entries: SessionEntry[] = [message("assistant", 4.8)];
  const tracker = new RunCostTracker();

  tracker.start(entries);
  assert.deepEqual(tracker.snapshot(entries), { cost: 0, active: true });

  entries.push(message("assistant", 0.12), message("toolResult", 0.03));
  assert.deepEqual(tracker.snapshot(entries), { cost: 0.15, active: true });

  assert.deepEqual(tracker.finish(entries), { cost: 0.15, active: false });
  assert.deepEqual(tracker.snapshot([]), { cost: 0.15, active: false });
});

test("a next Run starts at zero and does not include the previous Run", () => {
  const entries: SessionEntry[] = [message("assistant", 1)];
  const tracker = new RunCostTracker();

  tracker.start(entries);
  entries.push(message("assistant", 0.47));
  assert.equal(tracker.finish(entries)?.cost, 0.47);

  tracker.start(entries);
  assert.deepEqual(tracker.snapshot(entries), { cost: 0, active: true });
  entries.push(message("assistant", 0.03));
  assert.equal(tracker.finish(entries)?.cost, 0.03);

  tracker.reset();
  assert.equal(tracker.snapshot(entries), null);
});

test("run cost clamps floating-point negative noise and invalid totals", () => {
  assert.equal(getRunCost(1, 1 + Number.EPSILON), 0);
  assert.equal(getRunCost(Number.NaN, 1), 0);
  assert.equal(getRunCost(1, Number.POSITIVE_INFINITY), 0);
});

test("formatRunCost uses compact fixed dollar values", () => {
  assert.equal(formatRunCost(0), "$0.000");
  assert.equal(formatRunCost(0.0032), "$0.003");
  assert.equal(formatRunCost(0.0096), "$0.010");
  assert.equal(formatRunCost(0.17), "$0.17");
  assert.equal(formatRunCost(0.873), "$0.87");
  assert.equal(formatRunCost(1.529), "$1.53");
  assert.equal(formatRunCost(12.4), "$12.40");
  assert.equal(formatRunCost(-Number.EPSILON), "$0.000");
});
