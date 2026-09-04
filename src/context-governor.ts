import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export type ContextPressure = "normal" | "elevated" | "high";

export type ContextCompactionReason = "manual" | "threshold" | "overflow";

export interface ContextGovernorTuning {
  readonly elevatedPercent: number;
  readonly highPercent: number;
  readonly postCompactionRegrowthDelta: number;
}

export const DEFAULT_CONTEXT_GOVERNOR_TUNING: ContextGovernorTuning = Object.freeze({
  elevatedPercent: 70,
  highPercent: 88,
  postCompactionRegrowthDelta: 25,
});

export interface ContextGovernorSnapshot {
  readonly pressure: ContextPressure;
  readonly contextPercent: number | null;
  readonly contextWindow: number | null;
  readonly successfulCompactions: number;
  readonly pressureCompactions: number;
  readonly postCompactionBaselinePercent: number | null;
}

export interface SuccessfulCompactionObservation {
  readonly id: string;
  readonly reason: ContextCompactionReason;
}

export const PINDIE_CONTEXT_LIFECYCLE_TYPE = "pindie-context-lifecycle";
export const PINDIE_CONTEXT_LIFECYCLE_START = "<PINDIE_CONTEXT_LIFECYCLE>";
export const PINDIE_CONTEXT_LIFECYCLE_END = "</PINDIE_CONTEXT_LIFECYCLE>";

function assertTuning(tuning: ContextGovernorTuning): void {
  if (
    !Number.isFinite(tuning.elevatedPercent) ||
    !Number.isFinite(tuning.highPercent) ||
    !Number.isFinite(tuning.postCompactionRegrowthDelta) ||
    !(0 < tuning.elevatedPercent) ||
    !(tuning.elevatedPercent < tuning.highPercent) ||
    !(tuning.highPercent <= 100) ||
    !(tuning.postCompactionRegrowthDelta > 0)
  ) {
    throw new Error(
      "Invalid Context Lifecycle Governor tuning: expected 0 < elevatedPercent < highPercent <= 100 and postCompactionRegrowthDelta > 0.",
    );
  }
}

function knownPercent(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function knownContextWindow(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Pure model-facing formatter for one current pressure state. */
export function formatContextLifecycleGuidance(
  pressure: ContextPressure,
): string | null {
  if (pressure === "normal") return null;

  const lines = [
    PINDIE_CONTEXT_LIFECYCLE_START,
    `Context Lifecycle Guidance: ${pressure}`,
    "This is runtime resource guidance, not new user intent.",
  ];

  if (pressure === "elevated") {
    lines.push(
      "Context has become a meaningful resource constraint.",
      "- Continue current bounded work.",
      "- Avoid unnecessary context-heavy expansion.",
      "- Look for a natural coherent handoff frontier.",
      "- Do not hand off solely because of this notice.",
    );
  } else {
    lines.push(
      "Converge the current work while preserving the necessary atomic frontier.",
      "- Do not open another major context-heavy branch.",
      "- Finish necessary atomic work first.",
      "- Once a stable frontier exists, use pindie_task_handoff.",
      "- Include compact progress, carried decisions, and next intent.",
    );
  }

  lines.push(PINDIE_CONTEXT_LIFECYCLE_END);
  return lines.join("\n");
}

/** Session-scoped, factual, deterministic context-pressure observer. */
export class ContextLifecycleGovernor {
  readonly tuning: ContextGovernorTuning;

  private currentPressure: ContextPressure = "normal";
  private currentPercent: number | null = null;
  private currentContextWindow: number | null = null;
  private successfulCompactionCount = 0;
  private pressureCompactionCount = 0;
  private postCompactionBaseline: number | null = null;
  private awaitingPostCompactionBaseline = false;
  private readonly successfulCompactionIds = new Set<string>();
  private readonly pressureCompactionIds = new Set<string>();

  constructor(tuning: ContextGovernorTuning = DEFAULT_CONTEXT_GOVERNOR_TUNING) {
    assertTuning(tuning);
    this.tuning = Object.freeze({ ...tuning });
  }

  get snapshot(): ContextGovernorSnapshot {
    return Object.freeze({
      pressure: this.currentPressure,
      contextPercent: this.currentPercent,
      contextWindow: this.currentContextWindow,
      successfulCompactions: this.successfulCompactionCount,
      pressureCompactions: this.pressureCompactionCount,
      postCompactionBaselinePercent: this.postCompactionBaseline,
    });
  }

  reset(): void {
    this.currentPressure = "normal";
    this.currentPercent = null;
    this.currentContextWindow = null;
    this.successfulCompactionCount = 0;
    this.pressureCompactionCount = 0;
    this.postCompactionBaseline = null;
    this.awaitingPostCompactionBaseline = false;
    this.successfulCompactionIds.clear();
    this.pressureCompactionIds.clear();
  }

  observeUsage(usage: ContextUsage | undefined): ContextGovernorSnapshot {
    if (usage === undefined) return this.snapshot;

    const contextWindow = knownContextWindow(usage.contextWindow);
    if (contextWindow === null) return this.snapshot;

    const windowChanged =
      this.currentContextWindow !== null &&
      this.currentContextWindow !== contextWindow;
    if (windowChanged) {
      this.currentContextWindow = contextWindow;
      this.resetComparisonHistory();
    } else if (this.currentContextWindow === null) {
      this.currentContextWindow = contextWindow;
    }

    const percent = knownPercent(usage.percent);
    this.currentPercent = percent;
    if (percent === null) return this.snapshot;

    if (this.awaitingPostCompactionBaseline) {
      this.postCompactionBaseline = percent;
      this.awaitingPostCompactionBaseline = false;
    }

    this.currentPressure = this.classify(percent);
    return this.snapshot;
  }

  observeSuccessfulCompaction(
    observation: SuccessfulCompactionObservation,
  ): ContextGovernorSnapshot {
    if (this.successfulCompactionIds.has(observation.id)) return this.snapshot;
    this.successfulCompactionIds.add(observation.id);
    this.successfulCompactionCount += 1;

    if (
      (observation.reason === "threshold" || observation.reason === "overflow") &&
      !this.pressureCompactionIds.has(observation.id)
    ) {
      this.pressureCompactionIds.add(observation.id);
      this.pressureCompactionCount += 1;
    }

    this.currentPercent = null;
    this.currentPressure = "normal";
    this.postCompactionBaseline = null;
    this.awaitingPostCompactionBaseline = true;
    return this.snapshot;
  }

  /** Failed or aborted compactions do not alter the successful epoch. */
  observeFailedCompaction(): ContextGovernorSnapshot {
    return this.snapshot;
  }

  private resetComparisonHistory(): void {
    this.currentPercent = null;
    this.currentPressure = "normal";
    this.postCompactionBaseline = null;
    this.awaitingPostCompactionBaseline = false;
    this.pressureCompactionCount = 0;
    this.pressureCompactionIds.clear();
  }

  private classify(percent: number): ContextPressure {
    if (percent >= this.tuning.highPercent) return "high";

    if (
      this.postCompactionBaseline !== null &&
      percent >= this.tuning.elevatedPercent &&
      percent - this.postCompactionBaseline >= this.tuning.postCompactionRegrowthDelta
    ) {
      return "high";
    }

    if (
      this.pressureCompactionCount >= 2 &&
      percent >= this.tuning.elevatedPercent
    ) {
      return "high";
    }

    if (percent >= this.tuning.elevatedPercent) return "elevated";
    return "normal";
  }
}
