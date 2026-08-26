import type { PindieCapability, SemanticRunFacts } from "./semantics.ts";
import type { HumanGate, PindieState, PindieTask } from "./state.ts";

export interface AgentRunFactsContext {
  readonly taskAtRunStart: PindieTask | null;
  readonly gateAtRunStart: HumanGate | null;
  readonly externalStateEpochAtRunStart: number;
  readonly taskIntroducedDuringRun: boolean;
}

export function beginAgentRunFacts(
  state: PindieState,
  externalStateEpoch: number,
): AgentRunFactsContext {
  return {
    taskAtRunStart: state.task,
    gateAtRunStart: state.task?.humanGate ?? null,
    externalStateEpochAtRunStart: externalStateEpoch,
    taskIntroducedDuringRun: false,
  };
}

export function recordSuccessfulCapability(
  context: AgentRunFactsContext,
  capability: PindieCapability,
): AgentRunFactsContext {
  if (
    context.taskIntroducedDuringRun ||
    (capability !== "task.start" && capability !== "task.replace")
  ) {
    return context;
  }

  return { ...context, taskIntroducedDuringRun: true };
}

export function deriveSemanticRunFacts(
  context: AgentRunFactsContext | null,
  currentState: PindieState | null,
  currentExternalStateEpoch: number,
): SemanticRunFacts {
  if (currentState === null) return { stateAvailable: false };
  if (
    context === null ||
    currentExternalStateEpoch !== context.externalStateEpochAtRunStart
  ) {
    return { stateAvailable: true, runCoherent: false };
  }

  const task = currentState.task;
  if (task === null) {
    return {
      stateAvailable: true,
      runCoherent: true,
      taskRelation: "none",
      completionRelation: "not_completed",
      gateRelation: "none",
    };
  }

  const taskRelation = context.taskIntroducedDuringRun || context.taskAtRunStart === null
    ? "introduced_during_run"
    : task === context.taskAtRunStart
      ? "preexisting_untouched"
      : "preexisting_changed";

  const completionRelation = !task.completed
    ? "not_completed"
    : context.taskAtRunStart !== null &&
        context.taskAtRunStart.completed &&
        task === context.taskAtRunStart
      ? "completed_before_run"
      : "completed_during_run";

  const gateRelation = task.humanGate === null
    ? "none"
    : context.gateAtRunStart !== null && task.humanGate === context.gateAtRunStart
      ? "existed_before_run"
      : "opened_during_run";

  return {
    stateAvailable: true,
    runCoherent: true,
    taskRelation,
    completionRelation,
    gateRelation,
  };
}
