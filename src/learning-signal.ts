import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MAX_LEARNING_SIGNAL_REASON_LENGTH = 512;
export const LEARNING_SIGNAL_POLICY = "Learning opportunities are optional. If current real work reveals a plausible reusable Strategy-level pattern, you may signal it once with pindie_learning_signal; recognize the lesson, not whether the evidence is sufficient. Do not wait to prove recurrence or evidence counts: the Harness independently decides evidence sufficiency. Silence is normal for routine success, one-off facts, temporary fixes, outages and trivial details.";

export const LEARNING_COMPLETION_CHECKPOINT = "Primary work is complete. If this Run revealed a reusable Strategy-level lesson, now is the moment to call pindie_learning_signal once before ending. You need not prove recurrence or evidence sufficiency from this Run alone; the Harness decides independently. Silence is normal for routine success, one-off facts, temporary fixes, outages and trivial details.";

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
