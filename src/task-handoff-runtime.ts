import type { PindieTask } from "./state.ts";
import {
  assertTaskContinuityContent,
  taskContractFingerprint,
} from "./task-continuity.ts";

export const PINDIE_TASK_HANDOFF_TOOL = "pindie_task_handoff";

export interface PendingHandoff {
  readonly sourceSessionId: string;
  readonly agentRunGeneration: number;
  readonly taskFingerprint: string;
  readonly progressSummary: string;
  readonly decisions: readonly string[];
}

export interface HandoffRuntimeBinding {
  readonly sessionId: string;
  readonly agentRunGeneration: number;
}

export type HandoffAdmission =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "terminal_latch" | "work_in_flight" | "no_run";
    };

export type HandoffToolResult =
  | "handoff_succeeded"
  | "handoff_failed"
  | "handoff_invalidated"
  | "normal_released"
  | "ignored";

/** Runtime-only handoff reservation and terminal-frontier ownership. */
export class TaskHandoffRuntime {
  private sessionId: string | null = null;
  private agentRunGeneration: number | null = null;
  private readonly inFlightToolCallIds = new Set<string>();
  private readonly blockedToolCallIds = new Set<string>();
  private handoffReservation: {
    readonly toolCallId: string;
    readonly sourceSessionId: string;
    readonly agentRunGeneration: number;
  } | null = null;
  private terminalLatch = false;
  private stagedPendingHandoff: PendingHandoff | null = null;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get pendingHandoff(): PendingHandoff | null {
    return this.stagedPendingHandoff;
  }

  get hasTerminalLatch(): boolean {
    return this.terminalLatch;
  }

  get inFlightToolCallCount(): number {
    return this.inFlightToolCallIds.size;
  }

  startSession(sessionId: string): void {
    this.clear();
    this.sessionId = sessionId;
  }

  shutdownSession(): void {
    this.clear();
    this.sessionId = null;
  }

  beginAgentRun(sessionId: string, agentRunGeneration: number): void {
    this.clear();
    this.sessionId = sessionId;
    this.agentRunGeneration = agentRunGeneration;
  }

  /** Start tracking a normal call before any async authorization work. */
  beginNormalToolCall(toolCallId: string): boolean {
    if (this.terminalLatch) {
      this.blockedToolCallIds.add(toolCallId);
      return false;
    }
    this.inFlightToolCallIds.add(toolCallId);
    return true;
  }

  cancelNormalToolCall(toolCallId: string): void {
    this.inFlightToolCallIds.delete(toolCallId);
  }

  admitHandoff(toolCallId: string): HandoffAdmission {
    const admission = this.checkHandoffAdmission();
    if (!admission.allowed) {
      this.blockedToolCallIds.add(toolCallId);
      return admission;
    }

    // The check and reservation are synchronous, so no later tool_call can
    // cross this frontier between authorization and terminal-latch arming.
    this.handoffReservation = {
      toolCallId,
      sourceSessionId: this.sessionId!,
      agentRunGeneration: this.agentRunGeneration!,
    };
    this.terminalLatch = true;
    return { allowed: true };
  }

  checkHandoffAdmission(): HandoffAdmission {
    if (this.terminalLatch) return { allowed: false, reason: "terminal_latch" };
    if (this.sessionId === null || this.agentRunGeneration === null) {
      return { allowed: false, reason: "no_run" };
    }
    if (this.inFlightToolCallIds.size > 0) {
      return { allowed: false, reason: "work_in_flight" };
    }
    return { allowed: true };
  }

  stageHandoff(
    toolCallId: string,
    task: PindieTask,
    progressSummary: string,
    decisions: readonly string[],
  ): void {
    assertTaskContinuityContent({ progressSummary, decisions });
    const reservation = this.handoffReservation;
    if (
      reservation === null ||
      reservation.toolCallId !== toolCallId ||
      !this.terminalLatch ||
      this.sessionId !== reservation.sourceSessionId ||
      this.agentRunGeneration !== reservation.agentRunGeneration
    ) {
      throw new Error("Pindie rejected this handoff: its Session or Agent Run reservation is stale.");
    }
    if (task.completed || task.humanGate !== null || task.openLoops.blockers.length > 0) {
      throw new Error("Pindie rejected this handoff: the Task is not at an active, unblocked work frontier.");
    }
    this.stagedPendingHandoff = Object.freeze({
      sourceSessionId: reservation.sourceSessionId,
      agentRunGeneration: reservation.agentRunGeneration,
      taskFingerprint: taskContractFingerprint(task),
      progressSummary,
      decisions: Object.freeze([...decisions]),
    });
  }

  /** Release normal work, or fail closed on an unexpected late result. */
  handleToolResult(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    binding?: HandoffRuntimeBinding | null,
  ): HandoffToolResult {
    if (toolName === PINDIE_TASK_HANDOFF_TOOL && this.handoffReservation?.toolCallId === toolCallId) {
      if (
        binding === null ||
        (binding !== undefined && (
          binding.sessionId !== this.handoffReservation.sourceSessionId ||
          binding.agentRunGeneration !== this.handoffReservation.agentRunGeneration
        ))
      ) return "ignored";
      if (isError) {
        this.clearHandoff();
        return "handoff_failed";
      }
      if (this.stagedPendingHandoff === null) {
        this.clearHandoff();
        return "handoff_invalidated";
      }
      return "handoff_succeeded";
    }

    if (this.blockedToolCallIds.delete(toolCallId)) return "ignored";
    if (this.inFlightToolCallIds.delete(toolCallId)) {
      if (this.terminalLatch) {
        this.clearHandoff();
        return "handoff_invalidated";
      }
      return "normal_released";
    }
    if (this.terminalLatch) {
      this.clearHandoff();
      return "handoff_invalidated";
    }
    return "ignored";
  }

  shouldSuppressContinuation(binding?: HandoffRuntimeBinding | null): boolean {
    if (binding === null) return false;
    if (
      binding !== undefined &&
      (binding.sessionId !== this.sessionId || binding.agentRunGeneration !== this.agentRunGeneration)
    ) return false;
    return this.handoffReservation !== null && this.terminalLatch;
  }

  isPendingFor(sessionId: string, agentRunGeneration: number): boolean {
    const pending = this.stagedPendingHandoff;
    return pending !== null &&
      pending.sourceSessionId === sessionId &&
      pending.agentRunGeneration === agentRunGeneration &&
      this.sessionId === sessionId &&
      this.agentRunGeneration === agentRunGeneration &&
      this.terminalLatch;
  }

  clearHandoff(): void {
    this.handoffReservation = null;
    this.stagedPendingHandoff = null;
    this.terminalLatch = false;
    this.blockedToolCallIds.clear();
  }

  clear(): void {
    this.inFlightToolCallIds.clear();
    this.blockedToolCallIds.clear();
    this.handoffReservation = null;
    this.stagedPendingHandoff = null;
    this.terminalLatch = false;
    this.agentRunGeneration = null;
  }
}
