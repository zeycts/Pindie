import { Type, type Static } from "typebox";

/** Pure completion input shape; SI owns validation and signal lifecycle. */
export const MAX_LEARNING_SIGNAL_REASON_LENGTH = 512;
export const LearningSignalSchema = Type.Object({
  intent: Type.Union([
    Type.Literal("revise-existing"),
    Type.Literal("derive-local"),
    Type.Literal("derive-global"),
  ]),
  targetStrategyId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  reason: Type.String({ minLength: 1, maxLength: MAX_LEARNING_SIGNAL_REASON_LENGTH }),
}, { additionalProperties: false });

export const LearningDispositionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("none") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("signal"), signal: LearningSignalSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("already-signaled") }, { additionalProperties: false }),
], { description: "Runtime-only ordinary-Run learning judgment; required for SI-enabled ordinary completion. Use already-signaled only after an accepted signal in this Run." });

export type LearningDisposition = Static<typeof LearningDispositionSchema>;

/** Staging occurs before Task dispatch; rollback is called only if dispatch fails. */
export interface LearningDispositionSeam {
  isRequired(): boolean;
  stage(disposition: LearningDisposition): (() => void) | null;
}
