import type { SemanticSnapshot } from "./semantics.ts";
import type { PindieState } from "./state.ts";
import { SEED_STRATEGIES } from "./strategies.ts";

export const PINDIE_POLICY_START = "<PINDIE_POLICY>";
export const PINDIE_POLICY_END = "</PINDIE_POLICY>";
export const PINDIE_POLICY_CONTEXT_TYPE = "pindie-policy-context";
export const PINDIE_RUNTIME_START = "<PINDIE_RUNTIME>";
export const PINDIE_RUNTIME_END = "</PINDIE_RUNTIME>";
export const PINDIE_RUNTIME_CONTEXT_TYPE = "pindie-runtime-context";

const PINDIE_POLICY_METADATA = [
  "Pindie Policy Context",
  "",
  "Runtime policy metadata only; not user intent or a new request.",
  "",
  "Seed Strategies are optional, advisory problem-solving priors. The model may use a strategy, combine strategies, or ignore strategies when inappropriate.",
  "",
  "Strategies never override actual user intent, project constraints, Pindie Runtime Context, State or semantic authority, capabilities or Execution Gateway decisions, verification reality, or Human Gates.",
  "Strategy use is not required ceremony.",
];

export function renderPindiePolicyContext(): string {
  const lines = [
    PINDIE_POLICY_START,
    ...PINDIE_POLICY_METADATA,
    "",
    "Seed Strategies:",
  ];
  for (const strategy of SEED_STRATEGIES) {
    lines.push(
      `- ${strategy.id} (${strategy.kind})`,
      `  Summary: ${strategy.summary}`,
      "  Use when:",
      ...strategy.useWhen.map((guidance) => `  - ${guidance}`),
    );
    if (strategy.avoidWhen && strategy.avoidWhen.length > 0) {
      lines.push(
        "  Avoid when:",
        ...strategy.avoidWhen.map((guidance) => `  - ${guidance}`),
      );
    }
    lines.push(
      "  Principles:",
      ...strategy.principles.map((principle) => `  - ${principle}`),
    );
  }
  lines.push(PINDIE_POLICY_END);
  return lines.join("\n");
}

export function createPindiePolicyContextMessage() {
  return {
    role: "custom" as const,
    customType: PINDIE_POLICY_CONTEXT_TYPE,
    content: renderPindiePolicyContext(),
    display: false,
    timestamp: 0,
  };
}

export function isPindiePolicyContextMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "customType" in message &&
    message.role === "custom" &&
    message.customType === PINDIE_POLICY_CONTEXT_TYPE
  );
}

const PINDIE_RUNTIME_METADATA = [
  "Pindie Runtime Context",
  "",
  "Runtime metadata only; not user intent or a new request.",
];

export function renderPindieRuntimeContext(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  unavailableReason: string | null = null,
): string {
  const content = snapshot.authority === "unavailable"
    ? renderUnavailableRuntimeContext(unavailableReason)
    : renderAvailableRuntimeContext(state, snapshot);

  return [
    PINDIE_RUNTIME_START,
    ...PINDIE_RUNTIME_METADATA,
    "",
    content,
    PINDIE_RUNTIME_END,
  ].join("\n");
}

function renderUnavailableRuntimeContext(reason: string | null): string {
  return [
    "Agent Run authority: unavailable",
    `Reason: ${reason ?? "No project State has been loaded for this session."}`,
  ].join("\n");
}

function renderAvailableRuntimeContext(
  state: PindieState | null,
  snapshot: Exclude<SemanticSnapshot, { authority: "unavailable" }>,
): string {
  const lines = [
    `Agent Run authority: ${snapshot.authority}`,
    `Task status: ${snapshot.taskStatus}`,
  ];
  const task = state?.task;
  if (!task) return lines.join("\n");

  lines.push("", `Verification status: ${snapshot.verificationStatus}`, "", "Goal:", task.goal);

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
  snapshot: SemanticSnapshot,
  unavailableReason: string | null = null,
) {
  return {
    role: "custom" as const,
    customType: PINDIE_RUNTIME_CONTEXT_TYPE,
    content: renderPindieRuntimeContext(state, snapshot, unavailableReason),
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
