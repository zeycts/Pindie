import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_LEARNING_SIGNAL_REASON_LENGTH = 512;
export const LEARNING_SIGNAL_POLICY = "Learning opportunities are optional. A project-local engineering or procedural rule can be Strategy-level if it generalizes across future similar tasks; it need not be cross-domain or broadly abstract. If current work reveals a plausible reusable decision rule, you may signal it once with pindie_learning_signal; recognize the lesson, not whether the evidence is sufficient. Do not wait to prove recurrence or evidence counts: the Harness independently decides evidence sufficiency. Silence is normal for routine success, one-off facts, temporary fixes, outages and trivial details.";

export type LearningSignal = Readonly<{
  intent: "revise-existing" | "derive-local" | "derive-global";
  targetStrategyId?: string;
  reason: string;
}>;

/** An accepted signal is a single-Run observation, not semantic or durable State. */
export class LearningSignalHolder {
  private generation: number | null = null;
  private accepted: LearningSignal | null = null;

  begin(generation: number | null): void {
    this.generation = generation;
    this.accepted = null;
  }

  has(generation: number | null): boolean {
    return generation !== null && this.generation === generation && this.accepted !== null;
  }

  take(generation: number | null): LearningSignal | null {
    if (generation === null || this.generation !== generation) return null;
    const signal = this.accepted;
    this.begin(null);
    return signal;
  }

  accept(generation: number | null, signal: LearningSignal): boolean {
    if (generation === null || generation !== this.generation || this.accepted !== null) return false;
    this.accepted = Object.freeze({ ...signal });
    return true;
  }
}

const Parameters = Type.Object({
  intent: Type.Union([
    Type.Literal("revise-existing"),
    Type.Literal("derive-local"),
    Type.Literal("derive-global"),
  ]),
  targetStrategyId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  reason: Type.String({ minLength: 1, maxLength: MAX_LEARNING_SIGNAL_REASON_LENGTH }),
}, { additionalProperties: false });

export function isValidLearningSignal(value: unknown): value is LearningSignal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const signal = value as Record<string, unknown>;
  const hasTarget = Object.prototype.hasOwnProperty.call(signal, "targetStrategyId");
  return (signal.intent === "revise-existing"
    ? hasTarget && typeof signal.targetStrategyId === "string" &&
      signal.targetStrategyId.length <= 64 && signal.targetStrategyId.trim().length > 0
    : (signal.intent === "derive-local" || signal.intent === "derive-global") && !hasTarget) &&
    typeof signal.reason === "string" && signal.reason.length <= MAX_LEARNING_SIGNAL_REASON_LENGTH &&
    signal.reason.trim().length > 0 &&
    Object.keys(signal).every((key) => key === "intent" || key === "targetStrategyId" || key === "reason");
}

export const LearningSignalParameters = Parameters;

export function createPindieLearningSignalTool(options: {
  holder: LearningSignalHolder;
  getGeneration: () => number | null;
  isOrdinary: () => boolean;
}) {
  return defineTool({
    name: "pindie_learning_signal",
    label: "Signal learning opportunity",
    description: "Optionally signal one reusable decision rule or pattern that would change how a future similar task is approached in an ordinary Run. A project-local engineering or procedural rule qualifies as Strategy-level when it generalizes across future similar tasks; it need not be cross-domain or broadly abstract. Silence is normal: ordinary errors, temporary workarounds, one-off repository facts, outages, trivial details and routine success are not learning opportunities. Supply only semantic intent; do not wait for recurrence proof or evidence counts. The Harness independently assesses evidence after the Run settles.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_id, params) {
      if (!isValidLearningSignal(params) || !options.isOrdinary() ||
          !options.holder.accept(options.getGeneration(), params)) {
        return { content: [{ type: "text" as const, text: "Learning signal rejected: invalid intent/target, no ordinary Run, or a signal already exists." }], isError: true, details: undefined };
      }
      return { content: [{ type: "text" as const, text: "Learning opportunity noted for independent post-Run assessment. No learning Run or Candidate was started." }], details: undefined };
    },
  });
}
