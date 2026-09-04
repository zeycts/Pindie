import assert from "node:assert/strict";
import test from "node:test";

import type { ContextUsage } from "@earendil-works/pi-coding-agent";

import {
  ContextLifecycleGovernor,
  formatContextLifecycleGuidance,
  type ContextCompactionReason,
  type ContextGovernorTuning,
} from "../src/context-governor.ts";

function usage(percent: number | null, contextWindow = 100): ContextUsage {
  return {
    tokens: percent === null ? null : percent,
    contextWindow,
    percent,
  };
}

function compaction(
  id: string,
  reason: ContextCompactionReason,
): { id: string; reason: ContextCompactionReason } {
  return { id, reason };
}

function tuning(overrides: Partial<ContextGovernorTuning> = {}): ContextGovernorTuning {
  return {
    elevatedPercent: 70,
    highPercent: 99,
    postCompactionRegrowthDelta: 25,
    ...overrides,
  };
}

test("Context Lifecycle Governor classifies low, elevated, and high usage", () => {
  const governor = new ContextLifecycleGovernor();

  governor.observeUsage(usage(25));
  assert.equal(governor.snapshot.pressure, "normal");

  governor.observeUsage(usage(70));
  assert.equal(governor.snapshot.pressure, "elevated");

  governor.observeUsage(usage(88));
  assert.equal(governor.snapshot.pressure, "high");
});

test("successful compaction resets pressure and starts an unknown baseline epoch", () => {
  const governor = new ContextLifecycleGovernor();
  governor.observeUsage(usage(90));

  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));

  assert.deepEqual(governor.snapshot, {
    pressure: "normal",
    contextPercent: null,
    contextWindow: 100,
    successfulCompactions: 1,
    pressureCompactions: 1,
    postCompactionBaselinePercent: null,
  });
});

test("unknown post-compaction usage does not fabricate a baseline or reset pressure history", () => {
  const governor = new ContextLifecycleGovernor();
  governor.observeUsage(usage(90));
  governor.observeSuccessfulCompaction(compaction("compact-1", "overflow"));
  governor.observeUsage(usage(null));

  assert.equal(governor.snapshot.pressure, "normal");
  assert.equal(governor.snapshot.contextPercent, null);
  assert.equal(governor.snapshot.postCompactionBaselinePercent, null);
  assert.equal(governor.snapshot.pressureCompactions, 1);

  const highBeforeUnknown = new ContextLifecycleGovernor();
  highBeforeUnknown.observeUsage(usage(90));
  highBeforeUnknown.observeUsage(usage(null));
  assert.equal(highBeforeUnknown.snapshot.pressure, "high");
});

test("first known post-compaction usage captures a baseline without regrowth", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeUsage(usage(60));
  governor.observeSuccessfulCompaction(compaction("compact-1", "manual"));
  governor.observeUsage(usage(60));

  assert.equal(governor.snapshot.postCompactionBaselinePercent, 60);
  assert.equal(governor.snapshot.pressure, "normal");
});

test("later meaningful post-compaction regrowth becomes high", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));
  governor.observeUsage(usage(60));
  governor.observeUsage(usage(86));

  assert.equal(governor.snapshot.postCompactionBaselinePercent, 60);
  assert.equal(governor.snapshot.pressure, "high");
});

test("insufficient post-compaction regrowth follows absolute pressure", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));
  governor.observeUsage(usage(60));
  governor.observeUsage(usage(84));

  assert.equal(governor.snapshot.pressure, "elevated");
});

test("a second pressure-driven compaction plus elevated usage becomes high", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));
  governor.observeUsage(usage(60));
  governor.observeSuccessfulCompaction(compaction("compact-2", "overflow"));
  governor.observeUsage(usage(75));

  assert.equal(governor.snapshot.pressureCompactions, 2);
  assert.equal(governor.snapshot.pressure, "high");
});

test("manual compaction starts an epoch without increasing pressure-driven count", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeUsage(usage(75));
  governor.observeSuccessfulCompaction(compaction("manual-1", "manual"));
  governor.observeUsage(usage(50));

  assert.equal(governor.snapshot.successfulCompactions, 1);
  assert.equal(governor.snapshot.pressureCompactions, 0);
  assert.equal(governor.snapshot.postCompactionBaselinePercent, 50);
});

test("failed compaction is ignored and duplicate compaction IDs are not counted twice", () => {
  const governor = new ContextLifecycleGovernor();
  governor.observeUsage(usage(90));
  const beforeFailure = governor.snapshot;

  governor.observeFailedCompaction();
  assert.deepEqual(governor.snapshot, beforeFailure);

  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));
  governor.observeUsage(usage(40));
  const afterFirstSuccess = governor.snapshot;
  governor.observeSuccessfulCompaction(compaction("compact-1", "overflow"));

  assert.deepEqual(governor.snapshot, afterFirstSuccess);
});

test("context-window changes reset incompatible comparison and pressure history", () => {
  const governor = new ContextLifecycleGovernor(tuning());
  governor.observeUsage(usage(60, 100));
  governor.observeSuccessfulCompaction(compaction("compact-1", "threshold"));
  governor.observeUsage(usage(60, 100));
  governor.observeUsage(usage(86, 100));
  assert.equal(governor.snapshot.pressure, "high");

  governor.observeUsage(usage(75, 200));

  assert.equal(governor.snapshot.contextWindow, 200);
  assert.equal(governor.snapshot.contextPercent, 75);
  assert.equal(governor.snapshot.pressureCompactions, 0);
  assert.equal(governor.snapshot.postCompactionBaselinePercent, null);
  assert.equal(governor.snapshot.pressure, "elevated");
});

test("invalid Context Lifecycle Governor tuning is rejected", () => {
  const invalidTunings: ContextGovernorTuning[] = [
    tuning({ elevatedPercent: 0 }),
    tuning({ elevatedPercent: 90, highPercent: 90 }),
    tuning({ highPercent: 101 }),
    tuning({ postCompactionRegrowthDelta: 0 }),
    tuning({ postCompactionRegrowthDelta: Number.NaN }),
  ];

  for (const invalid of invalidTunings) {
    assert.throws(
      () => new ContextLifecycleGovernor(invalid),
      /Invalid Context Lifecycle Governor tuning/,
    );
  }
});

test("context lifecycle formatter is bounded advisory guidance", () => {
  assert.equal(formatContextLifecycleGuidance("normal"), null);

  const elevated = formatContextLifecycleGuidance("elevated");
  assert.ok(elevated);
  assert.match(elevated, /runtime resource guidance/i);
  assert.match(elevated, /not new user intent/i);
  assert.match(elevated, /do not hand off solely/i);

  const high = formatContextLifecycleGuidance("high");
  assert.ok(high);
  assert.match(high, /converge/i);
  assert.match(high, /pindie_task_handoff/);
  assert.match(high, /compact progress, carried decisions, and next intent/i);
  assert.doesNotMatch(high, /Goal|Verification|tokens|threshold|elevatedPercent|highPercent/);
});

test("reset clears all Session-scoped Governor facts", () => {
  const governor = new ContextLifecycleGovernor();
  governor.observeUsage(usage(90));
  governor.observeSuccessfulCompaction(compaction("compact-1", "overflow"));
  governor.reset();

  assert.deepEqual(governor.snapshot, {
    pressure: "normal",
    contextPercent: null,
    contextWindow: null,
    successfulCompactions: 0,
    pressureCompactions: 0,
    postCompactionBaselinePercent: null,
  });
});
