import {
  getVerificationStatus,
  validateState,
  type HumanGate,
  type PindieState,
  type PindieTask,
  type VerificationCheck,
} from "./state.ts";

export type PindieEvent =
  | {
      type: "start_task";
      goal: string;
      constraints: string[];
      successCriteria: string[];
      nextIntent?: string | null;
    }
  | {
      type: "refine_task";
      goal?: string;
      constraints?: string[];
      successCriteria?: string[];
    }
  | {
      type: "set_open_loops";
      blockers: string[];
      questions: string[];
      nextIntent: string | null;
    }
  | { type: "record_verification"; check: VerificationCheck }
  | { type: "invalidate_verification" }
  | { type: "complete_task" }
  | { type: "open_human_gate"; gate: HumanGate }
  | { type: "resolve_human_gate" };

export const TransitionErrorCode = {
  INVALID_STATE: "invalid_state",
  NO_CURRENT_TASK: "no_current_task",
  TASK_ALREADY_ACTIVE: "task_already_active",
  TASK_COMPLETED: "task_completed",
  UNKNOWN_SUCCESS_CRITERION: "unknown_success_criterion",
  VERIFICATION_PENDING: "verification_pending",
  VERIFICATION_FAILED: "verification_failed",
  VERIFICATION_STALE: "verification_stale",
  TASK_HAS_BLOCKERS: "task_has_blockers",
  UNRESOLVED_QUESTIONS: "unresolved_questions",
  HUMAN_GATE_OPEN: "human_gate_open",
  HUMAN_GATE_ALREADY_OPEN: "human_gate_already_open",
  NO_HUMAN_GATE: "no_human_gate",
} as const;

export type TransitionErrorCode =
  (typeof TransitionErrorCode)[keyof typeof TransitionErrorCode];

export interface TransitionError {
  code: TransitionErrorCode;
  message: string;
}

export type TransitionResult =
  | { ok: true; state: PindieState }
  | { ok: false; error: TransitionError };

function succeeded(state: PindieState): TransitionResult {
  return { ok: true, state };
}

function failed(
  code: TransitionErrorCode,
  message: string,
): TransitionResult {
  return { ok: false, error: { code, message } };
}

function criteriaFrom(descriptions: string[]): PindieTask["successCriteria"] {
  return descriptions.map((description, index) => ({
    id: `c${index + 1}`,
    description,
  }));
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function taskRequired(state: PindieState): PindieTask | TransitionResult {
  if (!state.task) {
    return failed(
      TransitionErrorCode.NO_CURRENT_TASK,
      "Start a task before applying this transition.",
    );
  }

  return state.task;
}

function mutableTaskRequired(state: PindieState): PindieTask | TransitionResult {
  const task = taskRequired(state);
  if ("ok" in task) return task;

  if (task.completed) {
    return failed(
      TransitionErrorCode.TASK_COMPLETED,
      "The completed task is terminal. Start a new task instead of changing it.",
    );
  }

  return task;
}

function isFailure(value: PindieTask | TransitionResult): value is TransitionResult {
  return "ok" in value;
}

function withTask(state: PindieState, task: PindieTask): TransitionResult {
  const nextState = { ...state, task };
  const validation = validateState(nextState);

  if (!validation.ok) {
    return failed(
      TransitionErrorCode.INVALID_STATE,
      `Transition would create invalid State: ${validation.errors.join(" ")}`,
    );
  }

  return succeeded(nextState);
}

/**
 * Applies one semantic event to Pindie State without mutating the input.
 * Expected invalid transitions are returned as actionable errors.
 */
export function reduceState(
  state: PindieState,
  event: PindieEvent,
): TransitionResult {
  const validation = validateState(state);
  if (!validation.ok) {
    return failed(
      TransitionErrorCode.INVALID_STATE,
      `Cannot apply a transition to invalid State: ${validation.errors.join(" ")}`,
    );
  }

  switch (event.type) {
    case "start_task": {
      if (state.task && !state.task.completed) {
        return failed(
          TransitionErrorCode.TASK_ALREADY_ACTIVE,
          "Complete the current task before starting a new one.",
        );
      }

      return withTask(state, {
        goal: event.goal,
        constraints: [...event.constraints],
        successCriteria: criteriaFrom(event.successCriteria),
        openLoops: {
          blockers: [],
          questions: [],
          nextIntent: event.nextIntent ?? null,
        },
        verification: { stale: false, checks: [] },
        humanGate: null,
        completed: false,
      });
    }

    case "refine_task": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      const nextGoal = event.goal ?? task.goal;
      const nextConstraints = event.constraints ?? task.constraints;
      const currentDescriptions = task.successCriteria.map(
        ({ description }) => description,
      );
      const nextDescriptions = event.successCriteria ?? currentDescriptions;
      const goalChanged = nextGoal !== task.goal;
      const constraintsChanged = !sameStrings(
        nextConstraints,
        task.constraints,
      );
      const criteriaChanged = !sameStrings(
        nextDescriptions,
        currentDescriptions,
      );

      if (!goalChanged && !constraintsChanged && !criteriaChanged) {
        return succeeded(state);
      }

      return withTask(state, {
        ...task,
        goal: nextGoal,
        constraints: [...nextConstraints],
        successCriteria: criteriaChanged
          ? criteriaFrom(nextDescriptions)
          : task.successCriteria,
        verification: { stale: true, checks: [] },
      });
    }

    case "set_open_loops": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      if (
        sameStrings(event.blockers, task.openLoops.blockers) &&
        sameStrings(event.questions, task.openLoops.questions) &&
        event.nextIntent === task.openLoops.nextIntent
      ) {
        return succeeded(state);
      }

      return withTask(state, {
        ...task,
        openLoops: {
          blockers: [...event.blockers],
          questions: [...event.questions],
          nextIntent: event.nextIntent,
        },
      });
    }

    case "record_verification": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      const criterionIds = new Set(
        task.successCriteria.map((criterion) => criterion.id),
      );
      const unknownIds = event.check.covers.filter(
        (criterionId) => !criterionIds.has(criterionId),
      );
      if (unknownIds.length > 0) {
        return failed(
          TransitionErrorCode.UNKNOWN_SUCCESS_CRITERION,
          `Verification check '${event.check.name}' references unknown success criterion ${unknownIds.map((id) => `'${id}'`).join(", ")}. Use only IDs from the current task contract.`,
        );
      }

      const check: VerificationCheck = {
        ...event.check,
        covers: [...event.check.covers],
      };
      const currentChecks = task.verification.stale
        ? []
        : task.verification.checks;
      const existingIndex = currentChecks.findIndex(
        (current) => current.name === check.name,
      );
      const checks = [...currentChecks];
      if (existingIndex === -1) {
        checks.push(check);
      } else {
        checks[existingIndex] = check;
      }

      return withTask(state, {
        ...task,
        verification: { stale: false, checks },
      });
    }

    case "invalidate_verification": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      if (task.verification.stale) return succeeded(state);

      return withTask(state, {
        ...task,
        verification: { stale: true, checks: [] },
      });
    }

    case "complete_task": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      const verificationStatus = getVerificationStatus(task);
      if (verificationStatus === "stale") {
        return failed(
          TransitionErrorCode.VERIFICATION_STALE,
          "Run fresh verification against every success criterion before completing the task.",
        );
      }
      if (verificationStatus === "failed") {
        return failed(
          TransitionErrorCode.VERIFICATION_FAILED,
          "Fix the failed verification checks and record fresh passing evidence before completing the task.",
        );
      }
      if (verificationStatus === "pending") {
        const passedCoverage = new Set(
          task.verification.checks
            .filter((check) => check.status === "passed")
            .flatMap((check) => check.covers),
        );
        const missing = task.successCriteria.filter(
          (criterion) => !passedCoverage.has(criterion.id),
        );
        return failed(
          TransitionErrorCode.VERIFICATION_PENDING,
          `Record passing verification for the remaining success criteria: ${missing.map((criterion) => `${criterion.id} (${criterion.description})`).join(", ")}.`,
        );
      }
      if (task.openLoops.blockers.length > 0) {
        return failed(
          TransitionErrorCode.TASK_HAS_BLOCKERS,
          `Resolve all blockers before completing the task: ${task.openLoops.blockers.join("; ")}.`,
        );
      }
      if (task.openLoops.questions.length > 0) {
        return failed(
          TransitionErrorCode.UNRESOLVED_QUESTIONS,
          `Resolve all open questions before completing the task: ${task.openLoops.questions.join("; ")}.`,
        );
      }
      if (task.humanGate) {
        return failed(
          TransitionErrorCode.HUMAN_GATE_OPEN,
          `Resolve the open Human Gate before completing the task: ${task.humanGate.question}`,
        );
      }

      return withTask(state, {
        ...task,
        openLoops: { ...task.openLoops, nextIntent: null },
        completed: true,
      });
    }

    case "open_human_gate": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      if (task.humanGate) {
        return failed(
          TransitionErrorCode.HUMAN_GATE_ALREADY_OPEN,
          `Resolve the current Human Gate before opening another: ${task.humanGate.question}`,
        );
      }

      return withTask(state, {
        ...task,
        humanGate: {
          ...event.gate,
          ...(event.gate.options
            ? { options: [...event.gate.options] }
            : {}),
        },
      });
    }

    case "resolve_human_gate": {
      const task = mutableTaskRequired(state);
      if (isFailure(task)) return task;

      if (!task.humanGate) {
        return failed(
          TransitionErrorCode.NO_HUMAN_GATE,
          "Open a Human Gate before attempting to resolve one.",
        );
      }

      return withTask(state, { ...task, humanGate: null });
    }
  }
}
