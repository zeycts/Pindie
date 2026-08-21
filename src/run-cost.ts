import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface RunCost {
  cost: number;
  active: boolean;
}

function validCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageCost(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const cost = (value as { cost?: unknown }).cost;
  if (typeof cost !== "object" || cost === null) return null;
  return validCost((cost as { total?: unknown }).total);
}

/** Mirrors Pi's cumulative footer cost sources using public session entries. */
export function getSessionCost(entries: readonly SessionEntry[]): number {
  let total = 0;

  for (const entry of entries) {
    const usage = entry.type === "message"
      ? entry.message.role === "assistant"
        ? entry.message.usage
        : entry.message.role === "toolResult"
          ? entry.message.usage
          : undefined
      : entry.type === "compaction" || entry.type === "branch_summary"
        ? entry.usage
        : undefined;
    const cost = usageCost(usage);
    if (cost === null || !Number.isFinite(total + cost)) continue;
    total += cost;
  }

  return total;
}

/** Returns a safe non-negative incremental cost from two cumulative totals. */
export function getRunCost(currentSessionCost: number, baselineSessionCost: number): number {
  const current = validCost(currentSessionCost);
  const baseline = validCost(baselineSessionCost);
  if (current === null || baseline === null) return 0;
  const cost = current - baseline;
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const rounded = Math.round(cost * 1_000_000_000_000) / 1_000_000_000_000;
  return Number.isFinite(rounded) ? rounded : cost;
}

/** Compact display formatting for Pi-reported model-equivalent Run Cost. */
export function formatRunCost(cost: number): string {
  const safeCost = validCost(cost) ?? 0;
  return safeCost < 0.01 ? `$${safeCost.toFixed(3)}` : `$${safeCost.toFixed(2)}`;
}

/** Runtime-only cost tracker with the same Run boundary as RunTimer. */
export class RunCostTracker {
  private baselineSessionCost: number | null = null;
  private finalizedCost: number | null = null;

  get active(): boolean {
    return this.baselineSessionCost !== null;
  }

  start(entries: readonly SessionEntry[]): void {
    this.baselineSessionCost = getSessionCost(entries);
    this.finalizedCost = null;
  }

  snapshot(entries: readonly SessionEntry[]): RunCost | null {
    if (this.baselineSessionCost !== null) {
      return {
        cost: getRunCost(getSessionCost(entries), this.baselineSessionCost),
        active: true,
      };
    }
    return this.finalizedCost === null
      ? null
      : { cost: this.finalizedCost, active: false };
  }

  finish(entries: readonly SessionEntry[]): RunCost | null {
    if (this.baselineSessionCost === null) return this.snapshot(entries);
    this.finalizedCost = getRunCost(
      getSessionCost(entries),
      this.baselineSessionCost,
    );
    this.baselineSessionCost = null;
    return { cost: this.finalizedCost, active: false };
  }

  reset(): void {
    this.baselineSessionCost = null;
    this.finalizedCost = null;
  }
}
