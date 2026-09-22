import type { CoreSettlementFacts } from "./core-integration.ts";
import { getTaskStatus, type HumanGate, type PindieTask, type TaskStatus } from "./state.ts";

export type HumanSignalKind =
  | "human-gate"
  | "authority-unavailable"
  | "settled-blocked"
  | "completed"
  | "stopped";

export interface HumanSignalDecision {
  readonly key: string;
  readonly kind: HumanSignalKind;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly local: "none" | "soft" | "hard";
  readonly external: "none" | "attention";
}

interface CurrentHumanSignalInput {
  readonly phase: "current";
  readonly sessionId: string;
  readonly authority: "coherent" | "stale" | "unavailable" | "presentation-unavailable";
  readonly authorityUnavailableReason: string | null;
  readonly taskStatus: TaskStatus | null;
  readonly task: PindieTask | null;
  readonly isIdle: boolean;
  readonly automaticWorkSettled: boolean;
  readonly pendingMessageCount: number;
  readonly quotaResumeWaiting: boolean;
}

interface SettlementHumanSignalInput {
  readonly phase: "settlement";
  readonly sessionId: string;
  readonly settlementGeneration: number | null;
  readonly facts: CoreSettlementFacts;
  readonly automaticSuccessorCommitted: boolean;
  readonly quotaSuccessorCommitted: boolean;
}

export type HumanSignalInput = CurrentHumanSignalInput | SettlementHumanSignalInput;

function gateIdentity(gate: HumanGate): string {
  return JSON.stringify([gate.kind, gate.question, gate.options ?? []]);
}

function humanGateSignal(sessionId: string, gate: HumanGate): HumanSignalDecision {
  return {
    key: `human-gate:${sessionId}:${gateIdentity(gate)}`,
    kind: "human-gate",
    summary: "HUMAN GATE",
    detail: [gate.question, ...(gate.options === undefined || gate.options.length === 0 ? [] : [gate.options.join(" · ")])],
    local: "hard",
    external: "attention",
  };
}

function authoritySignal(
  sessionId: string,
  reason: string | null,
): HumanSignalDecision {
  const detail = reason ?? "Pindie semantic authority is unavailable.";
  return {
    key: `authority-unavailable:${sessionId}:${JSON.stringify(detail)}`,
    kind: "authority-unavailable",
    summary: "PINDIE AUTHORITY UNAVAILABLE",
    detail: [detail],
    local: "hard",
    external: "attention",
  };
}

function settlementKey(
  kind: "settled-blocked" | "completed" | "stopped",
  generation: number,
  detail: readonly string[] = [],
): string {
  return `${kind}:${generation}:${JSON.stringify(detail)}`;
}

/** Pure transport- and renderer-independent policy for current and settled human signals. */
export function classifyHumanSignal(input: HumanSignalInput): HumanSignalDecision | null {
  if (input.phase === "current") {
    if (input.authority === "unavailable") {
      return authoritySignal(input.sessionId, input.authorityUnavailableReason);
    }
    const gate = input.task?.humanGate ?? null;
    if (gate !== null) return humanGateSignal(input.sessionId, gate);
    if (
      input.authority === "coherent" &&
      input.taskStatus === "blocked" &&
      input.task !== null &&
      input.isIdle &&
      input.automaticWorkSettled &&
      input.pendingMessageCount === 0 &&
      !input.quotaResumeWaiting
    ) {
      const blockers = [...input.task.openLoops.blockers];
      return {
        key: `current-settled-blocked:${input.sessionId}:${JSON.stringify(blockers)}`,
        kind: "settled-blocked",
        summary: "Could not continue autonomously.",
        detail: blockers,
        local: "soft",
        external: "none",
      };
    }
    return null;
  }

  const { facts } = input;
  if (facts.snapshot?.authority === "unavailable") {
    return authoritySignal(input.sessionId, "Pindie semantic authority is unavailable.");
  }
  const gate = facts.task?.humanGate ?? null;
  if (gate !== null) return humanGateSignal(input.sessionId, gate);
  if (
    facts.settlementGeneration === null ||
    facts.snapshot?.authority !== "coherent" ||
    facts.task === null
  ) return null;

  const status = getTaskStatus({ task: facts.task });
  if (status === "blocked") {
    if (input.automaticSuccessorCommitted || input.quotaSuccessorCommitted) return null;
    const blockers = [...facts.task.openLoops.blockers];
    return {
      key: settlementKey("settled-blocked", facts.settlementGeneration, blockers),
      kind: "settled-blocked",
      summary: "TASK BLOCKED",
      detail: blockers,
      local: "soft",
      external: "attention",
    };
  }
  if (status === "done") {
    return {
      key: settlementKey("completed", facts.settlementGeneration),
      kind: "completed",
      summary: "TASK COMPLETED",
      detail: [],
      local: "none",
      external: "attention",
    };
  }
  if (status === "active") {
    if (input.automaticSuccessorCommitted || input.quotaSuccessorCommitted) return null;
    return {
      key: settlementKey("stopped", facts.settlementGeneration),
      kind: "stopped",
      summary: "PINDIE STOPPED",
      detail: ["Task remains active. No automatic continuation is scheduled."],
      local: "none",
      external: "attention",
    };
  }
  return null;
}
