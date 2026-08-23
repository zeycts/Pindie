import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { ReasoningSnapshot } from "./reasoning.ts";
import { formatRunCost, getSessionCost, type RunCost } from "./run-cost.ts";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface EfficiencySnapshot {
  reasoning: ReasoningSnapshot;
  contextUsage: ContextUsage | undefined;
  sessionUsage: TokenUsage;
  latestRequest: TokenUsage | null;
  latestCacheHitRate: number | null;
  sessionCost: number;
  runCost: RunCost | null;
}

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function toTokenUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage = value as Record<string, unknown>;
  return {
    input: tokenCount(usage.input),
    output: tokenCount(usage.output),
    cacheRead: tokenCount(usage.cacheRead),
    cacheWrite: tokenCount(usage.cacheWrite),
  };
}

function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
}

function entryUsage(entry: SessionEntry): unknown {
  if (entry.type === "message") {
    return entry.message.role === "assistant" || entry.message.role === "toolResult"
      ? entry.message.usage
      : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
}

/** Mirrors Pi footer's public cumulative session usage sources. */
export function aggregateSessionUsage(entries: readonly SessionEntry[]): TokenUsage {
  const total = { ...EMPTY_USAGE };
  for (const entry of entries) {
    const usage = toTokenUsage(entryUsage(entry));
    if (usage) addUsage(total, usage);
  }
  return total;
}

/** Returns the latest assistant request without falling back to an older request. */
export function getLatestRequestUsage(entries: readonly SessionEntry[]): TokenUsage | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return toTokenUsage(entry.message.usage);
    }
  }
  return null;
}

/** Mirrors Pi footer's latest-assistant-request cache-hit calculation. */
export function getLatestCacheHitRate(latestRequest: TokenUsage | null): number | null {
  if (!latestRequest) return null;
  const promptTokens =
    latestRequest.input + latestRequest.cacheRead + latestRequest.cacheWrite;
  return promptTokens > 0 ? (latestRequest.cacheRead / promptTokens) * 100 : null;
}

/** Formats counts with Pi-footer-compatible compact units. */
export function formatTokenCount(count: number): string {
  const safeCount = tokenCount(count);
  if (safeCount < 1_000) return safeCount.toString();
  if (safeCount < 10_000) return `${(safeCount / 1_000).toFixed(1)}k`;
  if (safeCount < 1_000_000) return `${Math.round(safeCount / 1_000)}k`;
  if (safeCount < 10_000_000) return `${(safeCount / 1_000_000).toFixed(1)}M`;
  return `${Math.round(safeCount / 1_000_000)}M`;
}

export function deriveEfficiencySnapshot(input: {
  entries: readonly SessionEntry[];
  contextUsage: ContextUsage | undefined;
  reasoning: ReasoningSnapshot;
  runCost: RunCost | null;
}): EfficiencySnapshot {
  const latestRequest = getLatestRequestUsage(input.entries);
  return {
    reasoning: input.reasoning,
    contextUsage: input.contextUsage,
    sessionUsage: aggregateSessionUsage(input.entries),
    latestRequest,
    latestCacheHitRate: getLatestCacheHitRate(latestRequest),
    sessionCost: getSessionCost(input.entries),
    runCost: input.runCost,
  };
}

function formatContext(contextUsage: ContextUsage | undefined): string {
  if (!contextUsage) return "Context: unavailable";
  if (contextUsage.tokens === null || contextUsage.percent === null) {
    return `Context: ? / ${formatTokenCount(contextUsage.contextWindow)}`;
  }
  return `Context: ${formatTokenCount(contextUsage.tokens)} / ${formatTokenCount(contextUsage.contextWindow)} · ${contextUsage.percent.toFixed(1)}%`;
}

function formatSessionCost(cost: number): string {
  return `$${Number.isFinite(cost) && cost >= 0 ? cost.toFixed(3) : "0.000"}`;
}

/** Formats one compact, read-only runtime efficiency report. */
export function formatEfficiencyReport(snapshot: EfficiencySnapshot): string {
  const { reasoning, latestRequest, latestCacheHitRate, sessionUsage, runCost } = snapshot;
  const latest = latestRequest ?? EMPTY_USAGE;
  const latestRequestLine = latestRequest
    ? `Latest request: input ${formatTokenCount(latest.input)} · cache read ${formatTokenCount(latest.cacheRead)} · cache write ${formatTokenCount(latest.cacheWrite)} · CH ${latestCacheHitRate === null ? "unavailable" : `${latestCacheHitRate.toFixed(1)}%`}`
    : "Latest request: unavailable";
  const costLine = runCost
    ? `Cost: session ${formatSessionCost(snapshot.sessionCost)} · ${runCost.active ? "current run" : "last run"} ${formatRunCost(runCost.cost)}`
    : `Cost: session ${formatSessionCost(snapshot.sessionCost)}`;

  return [
    "Efficiency",
    "",
    `Reasoning: ${reasoning.mode} · requested ${reasoning.requestedLevel} · effective ${reasoning.effectiveLevel}`,
    formatContext(snapshot.contextUsage),
    latestRequestLine,
    `Session: input ${formatTokenCount(sessionUsage.input)} · output ${formatTokenCount(sessionUsage.output)} · cache read ${formatTokenCount(sessionUsage.cacheRead)} · cache write ${formatTokenCount(sessionUsage.cacheWrite)}`,
    costLine,
  ].join("\n");
}
