import type { ActiveSessionFacts } from "./pi-runtime.ts";
import type { PindiePresentationSnapshot } from "./presentation-integration.ts";

/** Factual, runtime-only release authority; absent UI/State facts fail closed. */
export function canReleaseBrowserIdle(input: {
  session: ActiveSessionFacts;
  presentation: PindiePresentationSnapshot | null;
  uiIdle: boolean;
  bashRunning: boolean;
}): boolean {
  const { session, presentation, uiIdle, bashRunning } = input;
  return uiIdle === true && bashRunning === false && session.isIdle === true &&
    session.isStreaming === false && session.isCompacting === false && session.pendingMessageCount === 0 &&
    presentation !== null && presentation.status.state !== null &&
    presentation.status.state.task?.humanGate == null && presentation.quotaResumeWaiting === null;
}
