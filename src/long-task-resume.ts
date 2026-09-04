import type { TaskContinuityV1 } from "./task-continuity.ts";

export const PINDIE_LONG_TASK_RESUME_TYPE = "pindie-long-task-resume";

/** Format only the bounded, advisory working-memory carried across Sessions. */
export function formatLongTaskResume(checkpoint: TaskContinuityV1): string {
  const decisions = checkpoint.decisions.length === 0
    ? "- (none)"
    : checkpoint.decisions.map((decision) => `- ${decision}`).join("\n");
  return `<PINDIE_LONG_TASK_RESUME>

Runtime continuation of the current durable Pindie Task.
This is not new user intent.

CURRENT PROGRESS
${checkpoint.progressSummary}

CARRIED DECISIONS
${decisions}

PindieState and current project Reality remain authoritative.
Continue from the authoritative current nextIntent and re-observe project Reality where needed.

</PINDIE_LONG_TASK_RESUME>`;
}
