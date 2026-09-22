import {
  getTaskStatus,
  getVerificationStatus,
  validateState,
  type HumanGate,
  type PindieState,
  type PindieTask,
  type TaskStatus,
  type VerificationCheck,
  type VerificationStatus,
} from "./state.ts";
import {
  projectToolResult,
  type UiDisplayMode,
  type UiToolResultProjection,
} from "./ui-timeline.ts";

/** Renderer-independent semantic facts projected from one Pindie transition. */
export type UiSemanticLifecycle = "running" | "complete" | "failed";

export type UiSemanticToolName =
  | "pindie_task_start"
  | "pindie_task_replace"
  | "pindie_task_refine"
  | "pindie_task_progress"
  | "pindie_task_handoff"
  | "pindie_verification_record"
  | "pindie_task_complete"
  | "pindie_gate_open"
  | "pindie_gate_resolve";

export type UiSemanticTaskAction =
  | "start"
  | "replace"
  | "refine"
  | "progress"
  | "handoff";

export interface UiSemanticVerificationCheck {
  readonly name: string;
  readonly status: VerificationCheck["status"];
  readonly covers: readonly string[];
  readonly evidence: string;
}

export interface UiSemanticTaskHandoff {
  readonly progressSummary: string;
  readonly decisions: readonly string[];
  readonly nextIntent: string | null;
}

interface UiSemanticBlockBase {
  readonly type: "semantic";
  readonly id: string;
  readonly lifecycle: UiSemanticLifecycle;
  readonly defaultDisplayMode: UiDisplayMode;
}

export interface UiTaskSemanticBlock extends UiSemanticBlockBase {
  readonly category: "task";
  readonly action: UiSemanticTaskAction;
  readonly goal: string | null;
  readonly taskStatus: TaskStatus | null;
  readonly blockers: readonly string[];
  readonly questions: readonly string[];
  readonly nextIntent: string | null;
  readonly successCriterionCount: number | null;
  readonly handoff: UiSemanticTaskHandoff | null;
  /** Bounded diagnostic detail for a failed/degraded semantic transition. */
  readonly error: string | null;
}

export interface UiVerificationSemanticBlock extends UiSemanticBlockBase {
  readonly category: "verification";
  readonly verificationStatus: VerificationStatus | null;
  /** Criterion IDs covered by passing checks in the resulting State. */
  readonly coveredCriteria: readonly string[];
  readonly totalCriteria: number | null;
  readonly checks: readonly UiSemanticVerificationCheck[];
  /** Safe preview of the check currently being recorded, if any. */
  readonly pendingCheck: UiSemanticVerificationCheck | null;
  /** Bounded diagnostic detail for a failed/degraded semantic transition. */
  readonly error: string | null;
}

export interface UiHumanGateSemanticBlock extends UiSemanticBlockBase {
  readonly category: "human-gate";
  readonly gateKind: HumanGate["kind"] | null;
  readonly question: string | null;
  readonly options: readonly string[];
  readonly state: "open" | "resolved";
  /** Bounded diagnostic detail for a failed/degraded semantic transition. */
  readonly error: string | null;
}

export interface UiCompletionSemanticBlock extends UiSemanticBlockBase {
  readonly category: "completion";
  readonly summary: string;
  readonly verificationStatus: VerificationStatus | null;
  readonly checks: readonly UiSemanticVerificationCheck[];
  /** Bounded diagnostic detail for a failed/degraded semantic transition. */
  readonly error: string | null;
}

export type UiSemanticBlock =
  | UiTaskSemanticBlock
  | UiVerificationSemanticBlock
  | UiHumanGateSemanticBlock
  | UiCompletionSemanticBlock;

/** Reducer-only, disposable phase identities. Never persist or render these. */
export interface UiSemanticTimelineReducerState {
  readonly currentTaskBlockId: string | null;
  readonly currentVerificationBlockId: string | null;
  readonly openHumanGateBlockId: string | null;
}

export const EMPTY_SEMANTIC_TIMELINE: UiSemanticTimelineReducerState = {
  currentTaskBlockId: null,
  currentVerificationBlockId: null,
  openHumanGateBlockId: null,
};

export interface UiSemanticStateSnapshot {
  readonly task: UiSemanticTaskStateSnapshot | null;
}

export interface UiSemanticTaskStateSnapshot {
  readonly goal: string;
  readonly taskStatus: TaskStatus;
  readonly blockers: readonly string[];
  readonly questions: readonly string[];
  readonly nextIntent: string | null;
  readonly successCriteria: readonly string[];
  readonly verificationStatus: VerificationStatus;
  readonly checks: readonly UiSemanticVerificationCheck[];
  readonly humanGate: UiSemanticGateSnapshot | null;
  readonly completed: boolean;
}

export interface UiSemanticGateSnapshot {
  readonly kind: HumanGate["kind"];
  readonly question: string;
  readonly options: readonly string[];
}

/** Structured result facts. No rendered semantic result prose is retained. */
export interface UiSemanticToolResult {
  readonly isError: boolean;
  readonly summary: string;
  readonly state: UiSemanticStateSnapshot | null;
  readonly stateError: string | null;
}

const MAX_TEXT_LENGTH = 4_000;
const MAX_DECISIONS = 8;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: string, limit = MAX_TEXT_LENGTH): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function fullString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown): string | null {
  const text = fullString(value);
  return text === null ? null : boundedText(text);
}

function requiredString(value: unknown): string | null {
  const text = stringValue(value);
  return text === null || text.length === 0 ? null : text;
}

function requiredFullString(value: unknown): string | null {
  const text = fullString(value);
  return text === null || text.length === 0 ? null : text;
}

/** Copy and structurally inspect every string in an authoritative array. */
function fullStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return null;
    values.push(candidate);
  }
  return values;
}

function fullOptionalStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  return fullStringArray(value);
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value);
}

function gateKind(value: unknown): HumanGate["kind"] | null {
  return value === "decision" || value === "approval" || value === "input"
    ? value
    : null;
}

function safeCheck(value: unknown): UiSemanticVerificationCheck | null {
  const source = record(value);
  if (source === null) return null;
  const name = requiredFullString(source.name);
  const covers = fullStringArray(source.covers);
  const evidence = fullString(source.evidence);
  if (
    name === null ||
    (source.status !== "passed" && source.status !== "failed") ||
    covers === null ||
    evidence === null
  ) return null;
  return {
    name,
    status: source.status,
    covers,
    evidence,
  };
}

function fullChecks(value: unknown): UiSemanticVerificationCheck[] | null {
  if (!Array.isArray(value)) return null;
  const checks: UiSemanticVerificationCheck[] = [];
  for (const candidate of value) {
    const check = safeCheck(candidate);
    if (check === null) return null;
    checks.push(check);
  }
  return checks;
}

function safeGate(value: unknown): UiSemanticGateSnapshot | null | undefined {
  if (value === null) return null;
  const source = record(value);
  if (source === null) return undefined;
  const kind = gateKind(source.kind);
  const question = requiredFullString(source.question);
  const options = fullOptionalStringArray(source.options);
  if (kind === null || question === null || options === null) return undefined;
  return { kind, question, options };
}

function fullTaskState(value: unknown): PindieTask | null | undefined {
  if (value === null) return null;
  const source = record(value);
  if (source === null) return undefined;

  const goal = requiredFullString(source.goal);
  const constraints = fullStringArray(source.constraints);
  const criteriaSource = Array.isArray(source.successCriteria)
    ? source.successCriteria
    : null;
  const openLoops = record(source.openLoops);
  const verification = record(source.verification);
  const humanGate = safeGate(source.humanGate);
  if (
    goal === null ||
    constraints === null ||
    criteriaSource === null ||
    openLoops === null ||
    verification === null ||
    humanGate === undefined ||
    typeof source.completed !== "boolean"
  ) return undefined;

  const successCriteria: PindieTask["successCriteria"] = [];
  for (const candidate of criteriaSource) {
    const criterion = record(candidate);
    const id = criterion === null ? null : requiredFullString(criterion.id);
    const description = criterion === null ? null : requiredFullString(criterion.description);
    if (id === null || description === null) return undefined;
    successCriteria.push({ id, description });
  }

  const blockers = fullStringArray(openLoops.blockers);
  const questions = fullStringArray(openLoops.questions);
  const nextIntentValue = openLoops.nextIntent;
  const nextIntent = fullString(nextIntentValue);
  const stale = verification.stale;
  const checks = fullChecks(verification.checks);
  if (
    blockers === null ||
    questions === null ||
    (nextIntentValue !== undefined && nextIntentValue !== null &&
      typeof nextIntentValue !== "string") ||
    typeof stale !== "boolean" ||
    checks === null
  ) return undefined;

  const safeState: PindieTask = {
    goal,
    constraints,
    successCriteria,
    openLoops: { blockers, questions, nextIntent },
    verification: {
      stale,
      checks: checks.map((check) => ({
        name: check.name,
        status: check.status,
        covers: [...check.covers],
        evidence: check.evidence,
      })),
    },
    humanGate: humanGate === null
      ? null
      : {
          kind: humanGate.kind,
          question: humanGate.question,
          ...(humanGate.options.length === 0 ? {} : { options: [...humanGate.options] }),
        },
    completed: source.completed,
  };
  return safeState;
}

function projectState(state: PindieState): UiSemanticStateSnapshot {
  const task = state.task;
  if (task === null) return { task: null };
  return {
    task: {
      goal: task.goal,
      taskStatus: getTaskStatus(state),
      blockers: [...task.openLoops.blockers],
      questions: [...task.openLoops.questions],
      nextIntent: task.openLoops.nextIntent,
      successCriteria: task.successCriteria.map((criterion) => criterion.id),
      verificationStatus: getVerificationStatus(task),
      checks: task.verification.checks.map((check) => ({
        name: check.name,
        status: check.status,
        covers: [...check.covers],
        evidence: check.evidence,
      })),
      humanGate: task.humanGate === null
        ? null
        : {
            kind: task.humanGate.kind,
            question: task.humanGate.question,
            options: task.humanGate.options === undefined
              ? []
              : [...task.humanGate.options],
          },
      completed: task.completed,
    },
  };
}

function readState(details: unknown): {
  readonly state: UiSemanticStateSnapshot | null;
  readonly error: string | null;
} {
  const detailsRecord = record(details);
  const stateRecord = detailsRecord === null ? null : record(detailsRecord.state);
  if (stateRecord === null || !("task" in stateRecord)) {
    return { state: null, error: "Semantic result did not include a valid details.state." };
  }

  const task = fullTaskState(stateRecord.task);
  if (task === undefined) {
    return { state: null, error: "Semantic result contained malformed Task State." };
  }
  const safeState: PindieState = { task };
  const validation = validateState(safeState);
  if (!validation.ok) {
    return {
      state: null,
      error: "Semantic result contained invalid Pindie State.",
    };
  }
  return { state: projectState(safeState), error: null };
}

function diagnosticResult(
  value: unknown,
  isError: boolean,
  toolName?: string,
): UiToolResultProjection {
  return projectToolResult(value, isError, toolName) ?? {
    isError,
    summary: "Semantic tool result was unavailable.",
    details: null,
  };
}

/** Safely projects only details.state and a bounded diagnostic summary. */
export function readSemanticToolResult(
  value: unknown,
  isError: boolean,
  toolName?: string,
): UiSemanticToolResult {
  const source = record(value);
  const details = source !== null && "details" in source ? source.details : undefined;
  const diagnostic = diagnosticResult(value, isError, toolName);
  const projected = readState(details);
  return {
    isError,
    summary: diagnostic.summary || (projected.error ?? "Semantic transition failed."),
    state: projected.state,
    stateError: projected.error,
  };
}

export function semanticToolName(toolName: string): UiSemanticToolName | null {
  switch (toolName) {
    case "pindie_task_start":
    case "pindie_task_replace":
    case "pindie_task_refine":
    case "pindie_task_progress":
    case "pindie_task_handoff":
    case "pindie_verification_record":
    case "pindie_task_complete":
    case "pindie_gate_open":
    case "pindie_gate_resolve":
      return toolName;
    default:
      return null;
  }
}

export function semanticToolAction(
  toolName: string,
): UiSemanticTaskAction | "verification" | "completion" | "gate-open" | "gate-resolve" | null {
  switch (toolName) {
    case "pindie_task_start": return "start";
    case "pindie_task_replace": return "replace";
    case "pindie_task_refine": return "refine";
    case "pindie_task_progress": return "progress";
    case "pindie_task_handoff": return "handoff";
    case "pindie_verification_record": return "verification";
    case "pindie_task_complete": return "completion";
    case "pindie_gate_open": return "gate-open";
    case "pindie_gate_resolve": return "gate-resolve";
    default: return null;
  }
}

export function semanticBlockId(
  category: UiSemanticBlock["category"],
  toolCallId: string,
): string {
  return `semantic:${category}:${toolCallId}`;
}

function taskArguments(value: unknown): {
  readonly goal: string | null;
  readonly blockers: readonly string[];
  readonly questions: readonly string[];
  readonly nextIntent: string | null;
  readonly successCriterionCount: number | null;
  readonly handoff: UiSemanticTaskHandoff | null;
} {
  const source = record(value);
  const criteria = source === null ? null : fullStringArray(source.successCriteria);
  const blockers = source === null ? null : fullStringArray(source.blockers);
  const questions = source === null ? null : fullStringArray(source.questions);
  const decisions = source === null ? null : fullStringArray(source.decisions);
  const progressSummary = source === null ? null : requiredString(source.progressSummary);
  const nextIntent = source === null ? null : optionalString(source.nextIntent);
  const handoff = progressSummary === null || decisions === null
    ? null
    : {
        progressSummary,
        decisions: decisions.slice(0, MAX_DECISIONS),
        nextIntent,
      };
  return {
    goal: source === null ? null : stringValue(source.goal),
    blockers: blockers ?? [],
    questions: questions ?? [],
    nextIntent,
    successCriterionCount: criteria === null ? null : criteria.length,
    handoff,
  };
}

function verificationArguments(value: unknown): UiSemanticVerificationCheck | null {
  const source = record(value);
  const check = source === null ? null : record(source.check);
  return check === null ? null : safeCheck({
    ...check,
    // Tool arguments contain evidenceRefs, not authoritative evidence. Keep a
    // preview label without treating opaque refs as verification truth.
    evidence: "",
  });
}

function gateArguments(value: unknown): {
  readonly gateKind: HumanGate["kind"] | null;
  readonly question: string | null;
  readonly options: readonly string[];
} {
  const source = record(value);
  const options = source === null ? [] : fullOptionalStringArray(source.options);
  return {
    gateKind: source === null ? null : gateKind(source.kind),
    question: source === null ? null : stringValue(source.question),
    options: options ?? [],
  };
}

function completionSummary(value: unknown, state: UiSemanticStateSnapshot | null): string {
  const source = record(value);
  const summary = source === null ? null : requiredString(source.summary);
  return summary ?? state?.task?.goal ?? "Task completed";
}

function taskBlockDisplayMode(
  lifecycle: UiSemanticLifecycle,
  taskStatus: TaskStatus | null,
  action: UiSemanticTaskAction,
  handoff: UiSemanticTaskHandoff | null,
): UiDisplayMode {
  if (lifecycle === "failed") return "full";
  if (lifecycle === "running") return "preview";
  if (handoff !== null || action === "handoff") return "preview";
  return taskStatus === "blocked" || taskStatus === "waiting_human"
    ? "preview"
    : "compact";
}

function verificationBlockDisplayMode(
  lifecycle: UiSemanticLifecycle,
  status: VerificationStatus | null,
): UiDisplayMode {
  if (lifecycle === "running" || status === "pending") return "preview";
  return "full";
}

function gateBlockDisplayMode(
  lifecycle: UiSemanticLifecycle,
  state: UiHumanGateSemanticBlock["state"],
): UiDisplayMode {
  if (lifecycle === "failed") return "full";
  return state === "resolved" ? "compact" : "full";
}

function checksFromState(
  state: UiSemanticStateSnapshot | null,
): readonly UiSemanticVerificationCheck[] {
  return state?.task?.checks.map((check) => ({
    name: check.name,
    status: check.status,
    covers: [...check.covers],
    evidence: check.evidence,
  })) ?? [];
}

function taskFromState(
  id: string,
  action: UiSemanticTaskAction,
  lifecycle: UiSemanticLifecycle,
  state: UiSemanticStateSnapshot | null,
  args: ReturnType<typeof taskArguments>,
  error: string | null,
): UiTaskSemanticBlock {
  const task = state?.task;
  const taskStatus = task?.taskStatus ?? null;
  return {
    type: "semantic",
    id,
    category: "task",
    action,
    lifecycle,
    defaultDisplayMode: taskBlockDisplayMode(lifecycle, taskStatus, action, args.handoff) === "compact" &&
        (task?.questions.length ?? args.questions.length) > 0
      ? "preview"
      : taskBlockDisplayMode(lifecycle, taskStatus, action, args.handoff),
    goal: task?.goal ?? args.goal,
    taskStatus,
    blockers: task === undefined || task === null ? [...args.blockers] : [...task.blockers],
    questions: task === undefined || task === null ? [...args.questions] : [...task.questions],
    nextIntent: task === undefined || task === null ? args.nextIntent : task.nextIntent,
    successCriterionCount: task?.successCriteria.length ?? args.successCriterionCount,
    handoff: args.handoff,
    error,
  };
}

function verificationFromState(
  id: string,
  lifecycle: UiSemanticLifecycle,
  state: UiSemanticStateSnapshot | null,
  pendingCheck: UiSemanticVerificationCheck | null,
  error: string | null,
): UiVerificationSemanticBlock {
  const task = state?.task;
  const coveredCriteria = new Set<string>();
  for (const check of task?.checks ?? []) {
    if (check.status !== "passed") continue;
    for (const criterion of check.covers) coveredCriteria.add(criterion);
  }
  return {
    type: "semantic",
    id,
    category: "verification",
    lifecycle,
    defaultDisplayMode: verificationBlockDisplayMode(lifecycle, task?.verificationStatus ?? null),
    verificationStatus: task?.verificationStatus ?? null,
    coveredCriteria: [...coveredCriteria],
    totalCriteria: task?.successCriteria.length ?? null,
    checks: checksFromState(state),
    pendingCheck,
    error,
  };
}

function gateFromState(
  id: string,
  lifecycle: UiSemanticLifecycle,
  state: UiSemanticStateSnapshot | null,
  args: ReturnType<typeof gateArguments>,
  gateState: UiHumanGateSemanticBlock["state"],
  error: string | null,
): UiHumanGateSemanticBlock {
  const gate = state?.task?.humanGate;
  return {
    type: "semantic",
    id,
    category: "human-gate",
    lifecycle,
    defaultDisplayMode: gateBlockDisplayMode(lifecycle, gateState),
    gateKind: gate?.kind ?? args.gateKind,
    question: gate?.question ?? args.question,
    options: gate === undefined || gate === null ? [...args.options] : [...gate.options],
    state: gateState,
    error,
  };
}

function completionFromState(
  id: string,
  lifecycle: UiSemanticLifecycle,
  summary: string,
  state: UiSemanticStateSnapshot | null,
  error: string | null,
): UiCompletionSemanticBlock {
  return {
    type: "semantic",
    id,
    category: "completion",
    lifecycle,
    defaultDisplayMode: "full",
    summary,
    verificationStatus: state?.task?.verificationStatus ?? null,
    checks: checksFromState(state),
    error,
  };
}

function mergeFailure(
  existing: UiSemanticBlock | null,
  id: string,
  toolName: UiSemanticToolName,
  argumentsValue: unknown,
  result: UiSemanticToolResult,
): UiSemanticBlock {
  const error = boundedText(
    result.isError
      ? result.summary || result.stateError || "Semantic transition failed."
      : result.stateError || "Semantic transition result was inconsistent.",
  );
  if (existing?.category === "task") {
    return { ...existing, lifecycle: "failed", defaultDisplayMode: "full", error };
  }
  if (existing?.category === "verification") {
    return { ...existing, lifecycle: "failed", defaultDisplayMode: "full", error };
  }
  if (existing?.category === "human-gate") {
    return { ...existing, lifecycle: "failed", defaultDisplayMode: "full", error };
  }
  if (existing?.category === "completion") {
    return { ...existing, lifecycle: "failed", defaultDisplayMode: "full", error };
  }

  const action = semanticToolAction(toolName);
  if (action === "verification") {
    return verificationFromState(id, "failed", null, verificationArguments(argumentsValue), error);
  }
  if (action === "completion") {
    return completionFromState(id, "failed", completionSummary(argumentsValue, result.state), result.state, error);
  }
  if (action === "gate-open" || action === "gate-resolve") {
    return gateFromState(id, "failed", null, gateArguments(argumentsValue), "open", error);
  }
  const taskAction = action === "start" || action === "replace" || action === "refine" ||
      action === "progress" || action === "handoff"
    ? action
    : "progress";
  return taskFromState(id, taskAction, "failed", null, taskArguments(argumentsValue), error);
}

export interface ProjectSemanticToolCallInput {
  readonly id: string;
  readonly toolName: string;
  readonly arguments: unknown;
  readonly lifecycle: UiSemanticLifecycle;
  readonly result: UiSemanticToolResult | null;
  readonly existing: UiSemanticBlock | null;
}

/**
 * Build/update one semantic block. The caller owns chronological placement and
 * phase reducer metadata; this function owns structured semantic extraction.
 */
export function projectSemanticToolCall(
  input: ProjectSemanticToolCallInput,
): UiSemanticBlock | null {
  const toolName = semanticToolName(input.toolName);
  if (toolName === null) return null;
  const action = semanticToolAction(toolName);
  if (action === null) return null;

  if (input.lifecycle === "running" || input.result === null) {
    if (input.existing?.category === "task" &&
        (action === "refine" || action === "progress" || action === "handoff")) {
      const args = taskArguments(input.arguments);
      return {
        ...input.existing,
        lifecycle: "running",
        defaultDisplayMode: "preview",
        action,
        goal: args.goal ?? input.existing.goal,
        blockers: args.blockers.length === 0 ? input.existing.blockers : args.blockers,
        questions: args.questions.length === 0 ? input.existing.questions : args.questions,
        nextIntent: args.nextIntent ?? input.existing.nextIntent,
        successCriterionCount: args.successCriterionCount ?? input.existing.successCriterionCount,
        handoff: args.handoff,
        error: null,
      };
    }
    if (input.existing?.category === "verification" && action === "verification") {
      return {
        ...input.existing,
        lifecycle: "running",
        defaultDisplayMode: "preview",
        pendingCheck: verificationArguments(input.arguments),
        error: null,
      };
    }
    if (input.existing?.category === "human-gate" && action === "gate-resolve") {
      return { ...input.existing, lifecycle: "running", defaultDisplayMode: "full", error: null };
    }

    if (action === "verification") {
      return verificationFromState(
        input.id,
        "running",
        null,
        verificationArguments(input.arguments),
        null,
      );
    }
    if (action === "completion") {
      return completionFromState(
        input.id,
        "running",
        completionSummary(input.arguments, null),
        null,
        null,
      );
    }
    if (action === "gate-open" || action === "gate-resolve") {
      return gateFromState(
        input.id,
        "running",
        null,
        gateArguments(input.arguments),
        action === "gate-resolve" ? "open" : "open",
        null,
      );
    }
    return taskFromState(
      input.id,
      action,
      "running",
      null,
      taskArguments(input.arguments),
      null,
    );
  }

  const result = input.result;
  if (result.isError || result.stateError !== null) {
    return mergeFailure(input.existing, input.id, toolName, input.arguments, result);
  }
  if (result.state?.task === null || result.state?.task === undefined) {
    return mergeFailure(input.existing, input.id, toolName, input.arguments, {
      ...result,
      stateError: "Resulting State did not contain a current Task.",
    });
  }

  if (action === "verification") {
    return verificationFromState(
      input.id,
      "complete",
      result.state,
      null,
      null,
    );
  }
  if (action === "completion") {
    const completed = result.state.task.completed === true &&
      result.state.task.taskStatus === "done";
    const summary = input.arguments === null || input.arguments === undefined
      ? input.existing?.category === "completion"
        ? input.existing.summary
        : completionSummary(input.arguments, result.state)
      : completionSummary(input.arguments, result.state);
    return completionFromState(
      input.id,
      completed ? "complete" : "failed",
      summary,
      result.state,
      completed ? null : "Resulting State did not mark the Task completed.",
    );
  }
  if (action === "gate-open") {
    const hasGate = result.state?.task?.humanGate !== null &&
      result.state?.task?.humanGate !== undefined;
    return gateFromState(
      input.id,
      hasGate ? "complete" : "failed",
      result.state,
      gateArguments(input.arguments),
      "open",
      hasGate ? null : "Resulting State did not contain the opened Human Gate.",
    );
  }
  if (action === "gate-resolve") {
    const resolved = result.state?.task !== null &&
      result.state?.task !== undefined &&
      result.state.task.humanGate === null;
    if (input.existing?.category === "human-gate") {
      return {
        ...input.existing,
        lifecycle: resolved ? "complete" : "failed",
        defaultDisplayMode: gateBlockDisplayMode(resolved ? "complete" : "failed", resolved ? "resolved" : "open"),
        state: resolved ? "resolved" : "open",
        error: resolved ? null : "Resulting State still contains an open Human Gate.",
      };
    }
    return gateFromState(
      input.id,
      resolved ? "complete" : "failed",
      result.state,
      gateArguments(input.arguments),
      resolved ? "resolved" : "open",
      resolved ? null : "Resulting State still contains an open Human Gate.",
    );
  }

  const args = taskArguments(input.arguments);
  const taskArgs = input.existing?.category === "task" && args.handoff === null
    ? { ...args, handoff: input.existing.handoff }
    : args;
  return taskFromState(
    input.id,
    action as UiSemanticTaskAction,
    "complete",
    result.state,
    taskArgs,
    null,
  );
}

/** Historical running calls are truthful failures when no result was saved. */
export function finalizeSemanticBlock(block: UiSemanticBlock): UiSemanticBlock {
  if (block.lifecycle !== "running") return block;
  const error = block.error ?? "Semantic tool result was not persisted; transition may be incomplete.";
  return { ...block, lifecycle: "failed", defaultDisplayMode: "full", error };
}

export function semanticStateHasVerification(
  state: UiSemanticStateSnapshot | null,
): boolean {
  return state?.task !== null && state?.task !== undefined &&
    state.task.verificationStatus !== "stale" && state.task.checks.length > 0;
}
