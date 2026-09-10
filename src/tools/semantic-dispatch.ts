import {
  PindieStateConflictError,
  PindieRuntime,
  PindieStateMutationUncertainError,
} from "../runtime.ts";
import { StateLockBusyError } from "../store.ts";
import type { PindieState } from "../state.ts";
import type { PindieEvent, TransitionResult } from "../transitions.ts";

export interface SemanticDispatchToolOptions {
  onStateChange?: () => void;
  onMutationUncertain?: (reason: string) => void;
}

export async function dispatchOrThrow(
  runtime: PindieRuntime,
  event: PindieEvent,
  signal: AbortSignal | undefined,
  options: SemanticDispatchToolOptions = {},
): Promise<PindieState> {
  let result: TransitionResult;
  try {
    result = await runtime.dispatchBounded(event, signal);
  } catch (error) {
    if (error instanceof PindieStateConflictError) {
      options.onStateChange?.();
      throw new Error("Pindie project State changed externally; the latest authoritative State was adopted. Return control and begin a new Agent Run before reconciling this semantic action.");
    }
    if (error instanceof StateLockBusyError) {
      throw new Error("Another Pindie process currently owns this project's State lock. Retry shortly.");
    }
    if (error instanceof PindieStateMutationUncertainError) {
      options.onMutationUncertain?.(error.message);
      throw error;
    }
    throw error;
  }
  if (!result.ok) {
    throw new Error(
      `Pindie transition rejected (${result.error.code}): ${result.error.message}`,
    );
  }

  options.onStateChange?.();
  return runtime.state;
}
