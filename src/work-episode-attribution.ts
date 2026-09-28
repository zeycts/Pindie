import type { PindieState } from "./state.ts";

/** Bounded Run-only operational binding; never persisted or added to prompts. */
export interface RunStartEpisodeBinding {
  readonly projectRoot: string;
  readonly episodeId: string | null;
  readonly taskWasOpen: boolean;
  readonly occurrenceEpoch: number;
  readonly externalStateEpoch: number;
}
export function exactRunWorkEpisodeId(
  start: RunStartEpisodeBinding | null,
  end: { projectRoot: string; state: PindieState; episodeId: string | null; occurrenceEpoch: number; externalStateEpoch: number },
): string | null {
  if (!start || !end.episodeId || start.projectRoot !== end.projectRoot ||
    start.externalStateEpoch !== end.externalStateEpoch) return null;
  const introduced = end.occurrenceEpoch - start.occurrenceEpoch;
  if (start.taskWasOpen) return introduced === 0 && start.episodeId === end.episodeId ? end.episodeId : null;
  return start.episodeId === null && introduced === 1 && end.state.task !== null ? end.episodeId : null;
}
