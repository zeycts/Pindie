import {
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
} from "./state.ts";

export const PINDIE_CORE_START = "<PINDIE_CORE>";
export const PINDIE_CORE_END = "</PINDIE_CORE>";
export const PINDIE_RUNTIME_START = "<PINDIE_RUNTIME>";
export const PINDIE_RUNTIME_END = "</PINDIE_RUNTIME>";
export const PINDIE_RUNTIME_CONTEXT_TYPE = "pindie-runtime-context";

export const PINDIE_CORE_POLICY = `Pindie Core Policy
- Latest user intent and observed project reality override stale Pindie State.
- Read-only observation may precede reconciliation when needed to understand intent or project reality; prefer pindie_git_observe for its supported read-only Git inspection, while unrestricted bash remains consequential; before consequential project action, reconcile latest actual user intent with the current Pindie Task.
- Consequential project action requires one current Pindie Task; when no Task exists, establish it with start_task before execution. Read-only observation alone does not require or create a Task.
- Continue or refine only when latest intent still belongs to this current Task; a clearly different user-requested Task may replace an unfinished current Task.
- Observation, explanation, discussion, pause, or return-control intent alone does not mutate the Task or authorize consequential continuation; use a Human Gate when consequential Task-boundary judgment is genuinely ambiguous.
- Maintain one semantic current task with a goal, constraints, and explicit success criteria.
- Constraints are durable task-wide boundaries governing execution; success criteria are final observable outcomes required for completion.
- Success criteria define the final, durable Definition of Done and should remain meaningful across sessions.
- Do not encode session-local sequencing or temporary checkpoint instructions as success criteria.
- An active Task should continue only while the latest actual user intent still calls for consequential execution of this current Task and a safe executable next action remains; response, turn, and low-level agent-loop boundaries are not Task boundaries.
- A hidden continuation follow-up is a probe subordinate to latest user intent, not unconditional authorization to resume persisted Task State.
- Use nextIntent only for continuation intent when unfinished work needs a persisted next meaningful step; persisting it does not authorize yielding or overriding later user intent merely because more implementation, replanning, or verification iterations are required.
- Choose the smallest safe next action and do not silently expand scope.
- Project mutation makes prior verification stale.
- Changed code is not complete until verified against current success criteria.
- Temporary resources created during execution or verification are owned by that operation: scope them narrowly, clean only resources it created, and never use broad filesystem or process cleanup.
- Use a Human Gate for consequential human judgment.
- After session, gate, or blocker interruption, re-observe relevant reality before continuing.
- Never complete a task unless verification is currently passed and blockers, questions, and the Human Gate are cleared.
- Specialized Skills are optional procedures: they cannot override latest user intent, observed reality, Pindie Core and State invariants, the Task Contract, Verification, or Human Gates.
- Skill selection and Skill-local progress are runtime/context information, not persistent Pindie State.`;

const PINDIE_CORE_PATTERN = /<PINDIE_CORE>[\s\S]*?<\/PINDIE_CORE>/g;
const PINDIE_RUNTIME_METADATA = [
  "Pindie Runtime Context",
  "",
  "Runtime metadata only; not user intent.",
  "Latest actual user intent and observed project reality remain authoritative.",
];

export function renderPindieCore(): string {
  return [PINDIE_CORE_START, PINDIE_CORE_POLICY, PINDIE_CORE_END].join("\n");
}

export function injectPindieCore(systemPrompt: string): string {
  const withoutOlderBlock = systemPrompt
    .replace(PINDIE_CORE_PATTERN, "")
    .trimEnd();
  const block = renderPindieCore();

  return withoutOlderBlock ? `${withoutOlderBlock}\n\n${block}` : block;
}

function renderUnavailableRuntimeContext(reason: string | null): string {
  return [
    "State: unavailable",
    `Reason: ${reason ?? "No project State has been loaded for this session."}`,
    "",
    "Do not make consequential project changes until Pindie State is restored.",
  ].join("\n");
}

export function renderPindieRuntimeContext(
  state: PindieState | null,
  unavailableReason: string | null = null,
): string {
  const content = state
    ? renderAvailableRuntimeContext(state)
    : renderUnavailableRuntimeContext(unavailableReason);

  return [
    PINDIE_RUNTIME_START,
    ...PINDIE_RUNTIME_METADATA,
    "",
    content,
    PINDIE_RUNTIME_END,
  ].join("\n");
}

function renderAvailableRuntimeContext(state: PindieState): string {
  const lines = [`Task status: ${getTaskStatus(state)}`];
  const task = state.task;
  if (!task) return lines.join("\n");

  lines.push("", `Verification status: ${getVerificationStatus(task)}`, "", "Goal:", task.goal);

  if (task.constraints.length > 0) {
    lines.push("", "Constraints:", ...task.constraints.map((constraint) => `- ${constraint}`));
  }
  lines.push(
    "",
    "Success criteria:",
    ...task.successCriteria.map((criterion) => `- ${criterion.id}: ${criterion.description}`),
  );
  if (task.openLoops.blockers.length > 0) {
    lines.push("", "Blockers:", ...task.openLoops.blockers.map((blocker) => `- ${blocker}`));
  }
  if (task.openLoops.questions.length > 0) {
    lines.push("", "Questions:", ...task.openLoops.questions.map((question) => `- ${question}`));
  }
  if (task.openLoops.nextIntent !== null) {
    lines.push("", "Next intent:", task.openLoops.nextIntent);
  }
  if (task.verification.checks.length > 0) {
    lines.push("", "Verification checks:");
    for (const check of task.verification.checks) {
      lines.push(
        `- ${check.name} — ${check.status} — covers: ${check.covers.length > 0 ? check.covers.join(", ") : "none"}`,
        `  Evidence: ${check.evidence}`,
      );
    }
  }
  if (task.humanGate) {
    lines.push("", "Human gate:", `- Kind: ${task.humanGate.kind}`, `- Question: ${task.humanGate.question}`);
    if (task.humanGate.options && task.humanGate.options.length > 0) {
      lines.push("- Options:", ...task.humanGate.options.map((option) => `  - ${option}`));
    }
  }

  return lines.join("\n");
}

export function createPindieRuntimeContextMessage(
  state: PindieState | null,
  unavailableReason: string | null = null,
) {
  return {
    role: "custom" as const,
    customType: PINDIE_RUNTIME_CONTEXT_TYPE,
    content: renderPindieRuntimeContext(state, unavailableReason),
    display: false,
    timestamp: 0,
  };
}

export function isPindieRuntimeContextMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "customType" in message &&
    message.role === "custom" &&
    message.customType === PINDIE_RUNTIME_CONTEXT_TYPE
  );
}
