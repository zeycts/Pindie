import {
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
} from "./state.ts";

export const PINDIE_CORE_START = "<PINDIE_CORE>";
export const PINDIE_CORE_END = "</PINDIE_CORE>";

export const PINDIE_CORE_POLICY = `Pindie Core Policy
- Latest user intent and observed project reality override stale Pindie State.
- Observe relevant reality before consequential changes.
- Maintain one semantic current task with a goal, constraints, and explicit success criteria.
- Constraints are durable task-wide boundaries governing execution; success criteria are final observable outcomes required for completion.
- Success criteria define the final, durable Definition of Done and should remain meaningful across sessions.
- Do not encode session-local sequencing or temporary checkpoint instructions as success criteria.
- Use nextIntent only for continuation intent when unfinished work needs a persisted next meaningful step.
- Choose the smallest safe next action and do not silently expand scope.
- Project mutation makes prior verification stale.
- Changed code is not complete until verified against current success criteria.
- Use a Human Gate for consequential human judgment.
- After session, gate, or blocker interruption, re-observe relevant reality before continuing.
- Never complete a task unless verification is currently passed and blockers, questions, and the Human Gate are cleared.`;

const PINDIE_CORE_PATTERN = /<PINDIE_CORE>[\s\S]*?<\/PINDIE_CORE>/g;

function renderCurrentState(state: PindieState): string {
  const lines = [
    "Pindie Current State",
    "",
    `Task status: ${getTaskStatus(state)}`,
  ];

  if (state.task) {
    lines.push(
      `Verification status: ${getVerificationStatus(state.task)}`,
    );
  }

  lines.push("", JSON.stringify(state, null, 2));
  return lines.join("\n");
}

function renderUnavailableState(reason: string | null): string {
  return [
    "Pindie State is unavailable:",
    reason ?? "No project State has been loaded for this session.",
    "",
    "Do not make consequential project changes until Pindie State is restored.",
  ].join("\n");
}

export function renderPindieCore(
  state: PindieState | null,
  unavailableReason: string | null = null,
): string {
  const currentState = state
    ? renderCurrentState(state)
    : renderUnavailableState(unavailableReason);

  return [
    PINDIE_CORE_START,
    PINDIE_CORE_POLICY,
    "",
    currentState,
    PINDIE_CORE_END,
  ].join("\n");
}

export function injectPindieCore(
  systemPrompt: string,
  state: PindieState | null,
  unavailableReason: string | null = null,
): string {
  const withoutOlderBlock = systemPrompt
    .replace(PINDIE_CORE_PATTERN, "")
    .trimEnd();
  const block = renderPindieCore(state, unavailableReason);

  return withoutOlderBlock ? `${withoutOlderBlock}\n\n${block}` : block;
}
