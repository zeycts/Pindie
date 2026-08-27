import type { SemanticSnapshot } from "./semantics.ts";

export const PINDIE_CONTINUATION_PROBE_TYPE =
  "pindie-active-task-continuation";

export const PINDIE_CONTINUATION_PROBE_MESSAGE =
  "Pindie continuation probe — runtime-generated metadata, not user intent or a new request. Do not treat this probe as changing or extending the user's request. Re-evaluate the latest actual user intent. If it still calls for consequential execution, continue using the currently available actions. Otherwise return control without further consequential project action or restating the prior response.";

export interface ContinuationProbeFacts {
  readonly probeAlreadyAttempted: boolean;
  readonly hasPendingMessages: boolean;
  readonly stoppedNormally: boolean;
}

export function shouldProbeContinuation(
  snapshot: SemanticSnapshot,
  facts: ContinuationProbeFacts,
): boolean {
  return snapshot.authority === "coherent" &&
    snapshot.taskStatus === "active" &&
    !facts.probeAlreadyAttempted &&
    !facts.hasPendingMessages &&
    facts.stoppedNormally;
}

export function isPindieContinuationProbeMessage(
  message: unknown,
): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "customType" in message &&
    message.role === "custom" &&
    message.customType === PINDIE_CONTINUATION_PROBE_TYPE
  );
}
