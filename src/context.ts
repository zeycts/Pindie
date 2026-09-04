import {
  deriveCapabilities,
  type PindieCapability,
  type SemanticSnapshot,
} from "./semantics.ts";
import {
  formatStrategySelectionLabel,
  type PolicySnapshot,
} from "./policy.ts";
import {
  getTaskStatus,
  getVerificationStatus,
  type PindieState,
  type PindieTask,
  type VerificationCheck,
} from "./state.ts";
import { SEED_STRATEGIES } from "./strategies.ts";

export const PINDIE_SYSTEM_CONTRACT_START = "<PINDIE_SYSTEM_CONTRACT>";
export const PINDIE_SYSTEM_CONTRACT_END = "</PINDIE_SYSTEM_CONTRACT>";
export const PINDIE_RUN_BASELINE_START = "<PINDIE_RUN_BASELINE>";
export const PINDIE_RUN_BASELINE_END = "</PINDIE_RUN_BASELINE>";
export const PINDIE_RUN_BASELINE_TYPE = "pindie-run-baseline";
export const PINDIE_STATE_CHECKPOINT_START = "<PINDIE_STATE_CHECKPOINT>";
export const PINDIE_STATE_CHECKPOINT_END = "</PINDIE_STATE_CHECKPOINT>";
export const PINDIE_STATE_CHECKPOINT_TYPE = "pindie-state-checkpoint";
export const PINDIE_RUNTIME_UPDATE_START = "<PINDIE_RUNTIME_UPDATE>";
export const PINDIE_RUNTIME_UPDATE_END = "</PINDIE_RUNTIME_UPDATE>";

const ACTION_ELIGIBILITY: readonly (readonly [string, PindieCapability])[] = [
  ["project mutation", "project.mutate"],
  ["policy declaration", "policy.declare"],
  ["task start", "task.start"],
  ["task replace", "task.replace"],
  ["task refine", "task.refine"],
  ["task progress", "task.progress"],
  ["verification record", "verification.record"],
  ["task complete", "task.complete"],
  ["gate open", "gate.open"],
  ["gate resolve", "gate.resolve"],
];

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
    "- Use current Task, verification, Human Gate, and runtime facts to decide when an action is semantically eligible.",
    "- A Gateway denial is factual runtime feedback; do not retry the same denied action unchanged.",
    "",
    "Task, verification, and Human Gate interpretation:",
    "- task.start establishes a new Task when idle (no current Task) or after a completed Task; task.replace supersedes a different unfinished Task.",
    "- When the current Task is completed and the user requests new durable work, begin a new Task with pindie_task_start; a completed Task is terminal and is not replaced.",
    "- A follow-up question, inspecting an old result, or discussing a completed Task does not by itself require starting a new durable Task; the model owns interpretation of user intent.",
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
    "- Strategy Revision Candidates are inactive hypotheses; creation is valid only during explicitly entered /adapt <strategy-id> work.",
    "- Candidate revisions remain unavailable to normal Policy declarations; only an explicitly armed /trial <candidate-id> Run may select its exact Candidate revision.",
    "- Project-local promoted revisions may be listed in a bounded normal Run catalog and are selectable only by their exact selector; promotion never changes the default Policy or replaces the Seed.",
    "- Candidates never override State, the Execution Gateway, Verification, or Task authority; receiving a Trial Packet does not create Policy attribution.",
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

/** Render the current model-facing affordance from the Gateway capability source. */
export function renderCurrentPindieActionEligibility(
  snapshot: SemanticSnapshot,
): string {
  const capabilities = deriveCapabilities(snapshot);
  return [
    "Current Pindie Action Eligibility:",
    ...ACTION_ELIGIBILITY.map(([label, capability]) =>
      `- ${label}: ${capabilities.has(capability) ? "allowed" : "not eligible"}`,
    ),
  ].join("\n");
}

function renderCurrentPindiePolicySnapshot(
  policySnapshot: PolicySnapshot | null,
): string[] {
  if (policySnapshot === null) return [];
  return [
    "",
    "Current Policy Snapshot:",
    `- Approach: ${formatStrategySelectionLabel(policySnapshot.approach)} (${policySnapshot.approach.kind})`,
    "  Modifiers:",
    ...(policySnapshot.modifiers.length > 0
      ? policySnapshot.modifiers.map((strategy) =>
        `  - ${formatStrategySelectionLabel(strategy)} (${strategy.kind})`)
      : ["  - none"]),
  ];
}

function renderUnavailableState(reason: string | null): string {
  return [
    "Agent Run authority: unavailable",
    `Reason: ${reason ?? "No project State has been loaded for this session."}`,
  ].join("\n");
}

function taskStatusFor(
  state: PindieState | null,
  snapshot?: SemanticSnapshot,
): string {
  return snapshot && snapshot.authority !== "unavailable"
    ? snapshot.taskStatus
    : getTaskStatus(state ?? { task: null });
}

function verificationStatusFor(
  task: PindieTask,
  snapshot?: SemanticSnapshot,
): string {
  return snapshot && snapshot.authority !== "unavailable"
    ? snapshot.verificationStatus
    : getVerificationStatus(task);
}

/** Render the current Task Contract without historical verification evidence. */
export function renderCurrentPindieTaskContract(
  state: PindieState | null,
  snapshot?: SemanticSnapshot,
): string {
  const task = state?.task;
  const lines = [`Task status: ${taskStatusFor(state, snapshot)}`];
  if (!task) return lines.join("\n");

  lines.push(
    `Verification status: ${verificationStatusFor(task, snapshot)}`,
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
  return lines.join("\n");
}

/** Canonical model-facing projection of current Pindie Task and verification State. */
export function renderCurrentPindieTaskState(
  state: PindieState | null,
  snapshot?: SemanticSnapshot,
): string {
  const task = state?.task;
  const lines = [renderCurrentPindieTaskContract(state, snapshot)];
  if (!task) return lines.join("\n");

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

/** Render only the open-loop facts changed by pindie_task_progress. */
export function renderCurrentPindieTaskProgress(
  state: PindieState,
  snapshot?: SemanticSnapshot,
): string {
  const task = state.task;
  const lines = [`Task status: ${taskStatusFor(state, snapshot)}`];
  if (!task) return lines.join("\n");
  lines.push(
    "",
    "Blockers:",
    ...(task.openLoops.blockers.length > 0
      ? task.openLoops.blockers.map((blocker) => `- ${blocker}`)
      : ["- none"]),
    "",
    "Questions:",
    ...(task.openLoops.questions.length > 0
      ? task.openLoops.questions.map((question) => `- ${question}`)
      : ["- none"]),
    "",
    "Next intent:",
    task.openLoops.nextIntent ?? "none",
  );
  return lines.join("\n");
}

/** Render the semantic verification result without copying materialized evidence. */
export function renderCurrentPindieVerificationRecord(
  state: PindieState,
  check: Pick<VerificationCheck, "name" | "status" | "covers">,
): string {
  const task = state.task;
  if (!task) return "Verification status: unavailable";
  const covered = new Set(
    task.verification.checks
      .filter((current) => current.status === "passed")
      .flatMap((current) => current.covers),
  );
  const coveredCriteria = task.successCriteria
    .map((criterion) => criterion.id)
    .filter((criterionId) => covered.has(criterionId));
  return [
    "Recorded verification check:",
    `- Name: ${check.name}`,
    `- Status: ${check.status}`,
    `- Covers: ${check.covers.length > 0 ? check.covers.join(", ") : "none"}`,
    "",
    `Verification status: ${getVerificationStatus(task)}`,
    `Criterion coverage: ${coveredCriteria.length}/${task.successCriteria.length}`,
    `Covered criteria: ${coveredCriteria.length > 0 ? coveredCriteria.join(", ") : "none"}`,
  ].join("\n");
}

/** Render the resulting Human Gate without unrelated Task verification State. */
export function renderCurrentPindieGate(
  state: PindieState,
  snapshot?: SemanticSnapshot,
): string {
  const task = state.task;
  if (!task) return `Task status: ${taskStatusFor(state, snapshot)}`;
  if (!task.humanGate) {
    return [
      `Task status: ${taskStatusFor(state, snapshot)}`,
      "Human Gate: none",
    ].join("\n");
  }
  const lines = [
    `Task status: ${taskStatusFor(state, snapshot)}`,
    "",
    "Human Gate:",
    `- Kind: ${task.humanGate.kind}`,
    `- Question: ${task.humanGate.question}`,
  ];
  if (task.humanGate.options && task.humanGate.options.length > 0) {
    lines.push("- Options:", ...task.humanGate.options.map((option) => `  - ${option}`));
  }
  return lines.join("\n");
}

function renderPindieRunState(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  policySnapshot: PolicySnapshot | null = null,
  unavailableReason: string | null = null,
): string {
  const lines = snapshot.authority === "unavailable"
    ? renderUnavailableState(unavailableReason)
    : [
        `Agent Run authority: ${snapshot.authority}`,
        renderCurrentPindieTaskState(state, snapshot),
      ].join("\n");
  return [
    lines,
    renderCurrentPindieActionEligibility(snapshot),
    ...renderCurrentPindiePolicySnapshot(policySnapshot),
  ].join("\n");
}

export function renderPindieRunBaseline(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  unavailableReason: string | null = null,
): string {
  const content = renderPindieRunState(state, snapshot, null, unavailableReason);

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

export function renderPindieStateCheckpoint(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  policySnapshot: PolicySnapshot | null = null,
  unavailableReason: string | null = null,
): string {
  const content = renderPindieRunState(
    state,
    snapshot,
    policySnapshot,
    unavailableReason,
  );
  return [
    PINDIE_STATE_CHECKPOINT_START,
    "Pindie State Checkpoint",
    "",
    "Authoritative Pindie runtime metadata re-established after context compaction.",
    "Not user intent and not a new request.",
    "This checkpoint supersedes conflicting older summarized Pindie state.",
    "",
    content,
    PINDIE_STATE_CHECKPOINT_END,
  ].join("\n");
}

export function createPindieStateCheckpointMessage(
  state: PindieState | null,
  snapshot: SemanticSnapshot,
  policySnapshot: PolicySnapshot | null = null,
  unavailableReason: string | null = null,
) {
  return {
    customType: PINDIE_STATE_CHECKPOINT_TYPE,
    content: renderPindieStateCheckpoint(
      state,
      snapshot,
      policySnapshot,
      unavailableReason,
    ),
    display: false,
  };
}

export function isPindieStateCheckpointMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    "customType" in message &&
    message.role === "custom" &&
    message.customType === PINDIE_STATE_CHECKPOINT_TYPE
  );
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
  hadCurrentChecks = true,
): string {
  const verificationStatus = snapshot && snapshot.authority !== "unavailable"
    ? snapshot.verificationStatus
    : state.task
      ? getVerificationStatus(state.task)
      : "unavailable";
  return [
    PINDIE_RUNTIME_UPDATE_START,
    "Project mutation changed authoritative verification state.",
    `Verification status: ${verificationStatus}`,
    hadCurrentChecks
      ? "Previous current verification checks were invalidated."
      : "Verification freshness was invalidated before any current checks were recorded.",
    "Fresh factual verification is required before task completion.",
    PINDIE_RUNTIME_UPDATE_END,
  ].join("\n");
}
