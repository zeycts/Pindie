import type { SemanticSnapshot } from "./semantics.ts";
import type { PindieState } from "./state.ts";
import { getTaskStatus, getVerificationStatus } from "./state.ts";
import { SEED_STRATEGIES } from "./strategies.ts";

export const PINDIE_SYSTEM_CONTRACT_START = "<PINDIE_SYSTEM_CONTRACT>";
export const PINDIE_SYSTEM_CONTRACT_END = "</PINDIE_SYSTEM_CONTRACT>";
export const PINDIE_RUN_BASELINE_START = "<PINDIE_RUN_BASELINE>";
export const PINDIE_RUN_BASELINE_END = "</PINDIE_RUN_BASELINE>";
export const PINDIE_RUN_BASELINE_TYPE = "pindie-run-baseline";
export const PINDIE_RUNTIME_UPDATE_START = "<PINDIE_RUNTIME_UPDATE>";
export const PINDIE_RUNTIME_UPDATE_END = "</PINDIE_RUNTIME_UPDATE>";

function renderSeedStrategies(lines: string[]): void {
  lines.push("", "Seed Strategies:");
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
}

/** Static Pindie instructions that are safe to reuse for every Agent Run. */
export function renderPindieSystemContract(): string {
  const lines = [
    PINDIE_SYSTEM_CONTRACT_START,
    "Pindie System Contract",
    "",
    "Pindie maintains durable semantic State and factual runtime authority for the current project.",
    "The user owns goals, taste, consequential judgment, and final approval; the model owns intent interpretation and semantic verification judgment within the legal capability space; Reality owns reconstructable facts.",
    "",
    "Authority rules:",
    "- Pindie State and deterministic semantic derivation are the source of truth for Task, verification, Human Gate, capability, and Run authority facts.",
    "- The Execution Gateway is authoritative for whether a concrete tool call may execute. It re-derives current authority and capabilities at the call boundary.",
    "- Tool visibility is not authorization. A visible tool may still be denied by the Pindie Gateway.",
    "- A Gateway denial is factual runtime feedback; do not retry the same denied action unchanged.",
    "",
    "Task, verification, and Human Gate interpretation:",
    "- Use the latest Pindie Run Baseline and later causal Pindie tool results/runtime updates as current semantic facts.",
    "- A later Pindie update supersedes conflicting fields in an earlier baseline or result; Pindie does not rewrite prior transcript history.",
    "- Verification status and criterion coverage are semantic judgments grounded in actual factual evidence. Fresh verification is required after authoritative project mutation invalidates prior checks.",
    "- An open Human Gate represents consequential human input that remains unresolved until its corresponding gate result is recorded.",
    "",
    "Append-only runtime updates:",
    "- The Run Baseline is authoritative metadata captured at Agent Run start, not user intent and not a new request.",
    "- Later Pindie tool results and runtime updates are appended at their causal location. Do not expect a later request to replace or reorder earlier transcript messages.",
    "",
    "Policy Snapshot semantics:",
    "- Seed Strategies are optional, advisory problem-solving priors. The model may use a strategy, combine strategies, or ignore strategies when inappropriate.",
    "- A current Policy Snapshot exists only after a successful pindie_policy_set declaration in this Agent Run; that tool result is the authoritative in-run Policy update.",
    "- Strategies never override actual user intent, project constraints, State or semantic authority, capabilities or Execution Gateway decisions, verification reality, or Human Gates.",
    "- Policy declaration is optional and is not required ceremony.",
  ];
  renderSeedStrategies(lines);
  lines.push(PINDIE_SYSTEM_CONTRACT_END);
  return lines.join("\n");
}

/** Append the stable Pindie contract without duplicating an earlier contribution. */
export function appendPindieSystemContract(systemPrompt: string): string {
  const contract = renderPindieSystemContract();
  if (systemPrompt.includes(contract)) return systemPrompt;
  return `${systemPrompt}${systemPrompt.length === 0 ? "" : "\n\n"}${contract}`;
}

function renderUnavailableState(reason: string | null): string {
  return [
    "Agent Run authority: unavailable",
    `Reason: ${reason ?? "No project State has been loaded for this session."}`,
  ].join("\n");
}

/** Canonical model-facing projection of current Pindie Task and verification State. */
export function renderCurrentPindieTaskState(
  state: PindieState | null,
  snapshot?: SemanticSnapshot,
): string {
  const task = state?.task;
  const taskStatus = snapshot && snapshot.authority !== "unavailable"
    ? snapshot.taskStatus
    : getTaskStatus(state ?? { task: null });
  const lines = [`Task status: ${taskStatus}`];
  if (!task) return lines.join("\n");

  const verificationStatus = snapshot && snapshot.authority !== "unavailable"
    ? snapshot.verificationStatus
    : getVerificationStatus(task);
  lines.push(
    `Verification status: ${verificationStatus}`,
    "",
    "Goal:",
    task.goal,
  );

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
    lines.push(
      "",
      "Human Gate:",
      `- Kind: ${task.humanGate.kind}`,
      `- Question: ${task.humanGate.question}`,
    );
    if (task.humanGate.options && task.humanGate.options.length > 0) {
      lines.push("- Options:", ...task.humanGate.options.map((option) => `  - ${option}`));
    }
  }

  return lines.join("\n");
}

export function appendCurrentPindieTaskState(
  message: string,
  state: PindieState,
  snapshot?: SemanticSnapshot,
): string {
  return [message, "", "Current Pindie State:", renderCurrentPindieTaskState(state, snapshot)].join("\n");
}

export function renderPindieRunBaseline(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  unavailableReason: string | null = null,
): string {
  const content = snapshot.authority === "unavailable"
    ? renderUnavailableState(unavailableReason)
    : [
        `Agent Run authority: ${snapshot.authority}`,
        renderCurrentPindieTaskState(state, snapshot),
      ].join("\n");

  return [
    PINDIE_RUN_BASELINE_START,
    "Pindie Run Baseline",
    "",
    "Authoritative runtime metadata captured at the beginning of this Agent Run.",
    "Not user intent and not a new request.",
    "Later Pindie tool results and runtime updates supersede fields in this baseline when they conflict.",
    "",
    content,
    PINDIE_RUN_BASELINE_END,
  ].join("\n");
}

export function createPindieRunBaselineMessage(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  unavailableReason: string | null = null,
) {
  return {
    customType: PINDIE_RUN_BASELINE_TYPE,
    content: renderPindieRunBaseline(state, snapshot, unavailableReason),
    display: false,
  };
}

export function isPindieRunBaselineMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "customType" in message &&
    message.role === "custom" &&
    message.customType === PINDIE_RUN_BASELINE_TYPE
  );
}

export function renderPindieProjectMutationUpdate(
  state: PindieState,
  snapshot?: SemanticSnapshot,
): string {
  return [
    PINDIE_RUNTIME_UPDATE_START,
    "Project mutation changed authoritative verification state.",
    `Verification status: ${snapshot && snapshot.authority !== "unavailable" ? snapshot.verificationStatus : getVerificationStatus(state.task!)}`,
    "Previous current verification checks were invalidated.",
    "Fresh factual verification is required before task completion.",
    PINDIE_RUNTIME_UPDATE_END,
  ].join("\n");
}
