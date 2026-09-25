import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_LEARNING_SIGNAL_REASON_LENGTH = 512;
export const LEARNING_SIGNAL_POLICY = "Learning opportunities are optional. Signal at most one reusable Strategy-level lesson from current real work using pindie_learning_signal. Silence is normal; ordinary errors, temporary workarounds, one-off repo facts, outages, trivial details and routine successful execution are not learning opportunities. A signal proposes semantic intent only; the Harness independently decides whether evidence suffices.";

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

export function createPindieLearningSignalTool(options: {
  holder: LearningSignalHolder;
  getGeneration: () => number | null;
  isOrdinary: () => boolean;
}) {
  return defineTool({
    name: "pindie_learning_signal",
    label: "Signal learning opportunity",
    description: "Optionally signal one reusable Strategy-level lesson in an ordinary Run. Silence is normal: ordinary errors, temporary workarounds, one-off repository facts, outages, trivial details and routine success are not learning opportunities. Supply only semantic intent; the Harness independently assesses evidence after the Run settles.",
    parameters: Parameters,
    executionMode: "sequential",
    async execute(_id, params) {
      const hasTarget = Object.prototype.hasOwnProperty.call(params, "targetStrategyId");
      const valid = params.intent === "revise-existing"
        ? hasTarget && typeof params.targetStrategyId === "string" && params.targetStrategyId.trim().length > 0
        : !hasTarget;
      if (!valid || params.reason.length > MAX_LEARNING_SIGNAL_REASON_LENGTH || !params.reason.trim() || !options.isOrdinary() ||
          !options.holder.accept(options.getGeneration(), params)) {
        return { content: [{ type: "text" as const, text: "Learning signal rejected: invalid intent/target, no ordinary Run, or a signal already exists." }], isError: true, details: undefined };
      }
      return { content: [{ type: "text" as const, text: "Learning opportunity noted for independent post-Run assessment. No learning Run or Candidate was started." }], details: undefined };
    },
  });
}
