import assert from "node:assert/strict";
import test from "node:test";

import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  aggregateSessionUsage,
  deriveEfficiencySnapshot,
  formatEfficiencyReport,
  formatTokenCount,
  getLatestCacheHitRate,
  getLatestRequestUsage,
} from "../src/efficiency.ts";

let nextId = 0;

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0) {
  return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function entry(type: string, value: Record<string, unknown>): SessionEntry {
  return {
    type,
    id: `${type}-${nextId++}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...value,
  } as unknown as SessionEntry;
}

function assistant(value = usage()): SessionEntry {
  return entry("message", { message: { role: "assistant", usage: value } });
}

function toolResult(value?: ReturnType<typeof usage>): SessionEntry {
  return entry("message", { message: { role: "toolResult", usage: value } });
}

function summary(type: "compaction" | "branch_summary", value?: ReturnType<typeof usage>): SessionEntry {
  return entry(type, { usage: value });
}

test("EI01-EI05 aggregate session usage mirrors Pi footer sources", () => {
  const totals = aggregateSessionUsage([
    assistant(usage(10, 2, 30, 4)),
    toolResult(usage(20, 3, 40, 5)),
    summary("compaction", usage(30, 4, 50, 6)),
    summary("branch_summary", usage(40, 5, 60, 7)),
    toolResult(),
    entry("custom", { data: usage(500, 500, 500, 500) }),
    entry("message", { message: { role: "user", usage: usage(500, 500, 500, 500) } }),
  ]);

  assert.deepEqual(totals, { input: 100, output: 14, cacheRead: 180, cacheWrite: 22 });
});

test("EI06-EI10 latest assistant request and CH follow Pi semantics", () => {
  const entries = [
    assistant(usage(100, 1, 900, 0)),
    toolResult(usage(2, 3, 4, 5)),
    assistant(usage(100, 1, 600, 300)),
  ];
  const latest = getLatestRequestUsage(entries);

  assert.deepEqual(latest, { input: 100, output: 1, cacheRead: 600, cacheWrite: 300 });
  assert.equal(getLatestCacheHitRate(latest), 60);
  assert.equal(getLatestCacheHitRate({ input: 100, output: 0, cacheRead: 600, cacheWrite: 300 }), 60);
  assert.equal(getLatestCacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(getLatestCacheHitRate(getLatestRequestUsage([
    assistant(usage(1, 0, 999, 0)),
    assistant(usage()),
  ])), null);
});

test("EI11-EI19 report formatting handles context, reasoning, run cost, and deterministic output", () => {
  const base = {
    entries: [assistant(usage(1_200, 20, 203_000, 0, 4.048))],
    reasoning: { mode: "auto" as const, requestedLevel: "low" as const, effectiveLevel: "low" as const },
    runCost: { cost: 0.94, active: true },
  };
  const known: ContextUsage = { tokens: 204_000, contextWindow: 272_000, percent: 74.8 };
  const report = formatEfficiencyReport(deriveEfficiencySnapshot({ ...base, contextUsage: known }));

  assert.equal(formatTokenCount(822), "822");
  assert.equal(formatTokenCount(1_200), "1.2k");
  assert.equal(formatTokenCount(22_000), "22k");
  assert.equal(formatTokenCount(822_000), "822k");
  assert.equal(formatTokenCount(1_800_000), "1.8M");
  assert.equal(formatTokenCount(11_000_000), "11M");
  assert.match(report, /Context: 204k \/ 272k · 74.8%/);
  assert.match(report, /Reasoning: auto · requested low · effective low/);
  assert.match(report, /current run \$0.94/);
  assert.equal(report, formatEfficiencyReport(deriveEfficiencySnapshot({ ...base, contextUsage: known })));
  assert.match(formatEfficiencyReport(deriveEfficiencySnapshot({ ...base, contextUsage: { ...known, tokens: null, percent: null } })), /Context: \? \/ 272k/);
  assert.match(formatEfficiencyReport(deriveEfficiencySnapshot({ ...base, contextUsage: undefined })), /Context: unavailable/);
  assert.match(formatEfficiencyReport(deriveEfficiencySnapshot({
    ...base,
    contextUsage: known,
    reasoning: { mode: "manual", requestedLevel: "max", effectiveLevel: "high" },
    runCost: { cost: 0.94, active: false },
  })), /Reasoning: manual · requested max · effective high[\s\S]*last run \$0.94/);
  assert.match(formatEfficiencyReport(deriveEfficiencySnapshot({ ...base, contextUsage: known, runCost: null })), /Cost: session \$4.048$/);
});
