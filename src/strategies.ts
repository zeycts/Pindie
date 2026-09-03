import { createHash } from "node:crypto";

export type SeedStrategyKind = "approach" | "modifier";

export interface SeedStrategy {
  readonly id: string;
  readonly kind: SeedStrategyKind;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen?: readonly string[];
  readonly principles: readonly string[];
}

function immutableStrategy(
  strategy: Omit<SeedStrategy, "useWhen" | "avoidWhen" | "principles"> & {
    readonly useWhen: readonly string[];
    readonly avoidWhen?: readonly string[];
    readonly principles: readonly string[];
  },
): SeedStrategy {
  return Object.freeze({
    ...strategy,
    useWhen: Object.freeze([...strategy.useWhen]),
    ...(strategy.avoidWhen === undefined
      ? {}
      : { avoidWhen: Object.freeze([...strategy.avoidWhen]) }),
    principles: Object.freeze([...strategy.principles]),
  });
}

/** The immutable human-validated Seed Strategy portfolio for SI v0.1. */
export interface SeedStrategySemantics {
  readonly id: string;
  readonly kind: SeedStrategyKind;
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}

/** Stable canonical semantics used to bind artifacts to an immutable Seed. */
export function seedStrategySemantics(strategy: SeedStrategy): SeedStrategySemantics {
  return {
    id: strategy.id,
    kind: strategy.kind,
    summary: strategy.summary,
    useWhen: [...strategy.useWhen],
    avoidWhen: [...(strategy.avoidWhen ?? [])],
    principles: [...strategy.principles],
  };
}

/** Deterministic SHA-256 fingerprint of one Seed Strategy's semantics. */
export function seedStrategyFingerprint(strategy: SeedStrategy): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(seedStrategySemantics(strategy)))
    .digest("hex")}`;
}

export const SEED_STRATEGIES: readonly SeedStrategy[] = Object.freeze([
  immutableStrategy({
    id: "direct-action",
    kind: "approach",
    summary: "Prefer a focused change when the problem and likely fix are clear.",
    useWhen: ["the request is concrete and the relevant code path is known"],
    avoidWhen: ["the cause or affected surface is still uncertain"],
    principles: [
      "keep the move focused",
      "let current project evidence guide the change",
      "verify the result against the task",
    ],
  }),
  immutableStrategy({
    id: "reproduce-first",
    kind: "approach",
    summary: "Seek a small, reliable reproduction before changing unclear failing behavior.",
    useWhen: ["a bug or regression is observable but its cause is not yet clear"],
    avoidWhen: ["the behavior is already well understood or reproduction is disproportionate"],
    principles: [
      "make the failure observable",
      "separate observed behavior from hypotheses",
      "preserve a useful failing signal",
    ],
  }),
  immutableStrategy({
    id: "explore-first",
    kind: "approach",
    summary: "Survey relevant code, interfaces, and constraints before choosing a direction.",
    useWhen: ["the affected surface or available approaches are unfamiliar"],
    avoidWhen: ["the request is narrow and the path is already well established"],
    principles: [
      "bound exploration to the decision at hand",
      "prefer relevant project evidence",
      "stop exploring when uncertainty is reduced",
    ],
  }),
  immutableStrategy({
    id: "hypothesis-driven",
    kind: "approach",
    summary: "Use explicit, testable explanations to reduce uncertainty about cause or solution.",
    useWhen: ["several plausible causes or designs fit the current evidence"],
    avoidWhen: ["the change is routine and no meaningful uncertainty needs resolving"],
    principles: [
      "keep hypotheses distinct from facts",
      "seek evidence that separates plausible explanations",
      "update the explanation when evidence disagrees",
    ],
  }),
  immutableStrategy({
    id: "architecture-first",
    kind: "approach",
    summary: "Clarify ownership, boundaries, and invariants before changing a cross-cutting design.",
    useWhen: ["the request affects multiple components or established architecture"],
    avoidWhen: ["a local correction does not change an ownership or interface decision"],
    principles: [
      "preserve existing authority boundaries",
      "prefer the smallest coherent design",
      "align projections with their source of truth",
    ],
  }),
  immutableStrategy({
    id: "minimal-change",
    kind: "modifier",
    summary: "Bias toward the smallest change that satisfies the actual request.",
    useWhen: ["a focused patch can meet the goal without speculative infrastructure"],
    avoidWhen: ["a broader change is required by explicit constraints or evidence"],
    principles: [
      "preserve unrelated behavior",
      "avoid speculative surface area",
      "keep the implementation proportional to the request",
    ],
  }),
  immutableStrategy({
    id: "verify-as-you-go",
    kind: "modifier",
    summary: "Keep factual feedback close to changes so errors are found while context is fresh.",
    useWhen: ["fast relevant checks are available or changes have meaningful risk"],
    avoidWhen: ["a check is unavailable, misleading, or more disruptive than its information value"],
    principles: [
      "use factual project feedback",
      "keep checks relevant to current criteria",
      "treat failed feedback as information, not authority",
    ],
  }),
]);

/** Resolve only the immutable canonical Seed Strategy object. */
export function getSeedStrategy(strategyId: string): SeedStrategy | null {
  return SEED_STRATEGIES.find((strategy) => strategy.id === strategyId) ?? null;
}
