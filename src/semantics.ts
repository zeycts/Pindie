import {
  getTaskStatus,
  getVerificationStatus,
  validateState,
  type PindieState,
  type TaskStatus,
  type VerificationStatus,
} from "./state.ts";

export type TaskRunRelation =
  | "none"
  | "preexisting_untouched"
  | "preexisting_changed"
  | "introduced_during_run";

export type CompletionRunRelation =
  | "not_completed"
  | "completed_before_run"
  | "completed_during_run";

export type GateRunRelation =
  | "none"
  | "existed_before_run"
  | "opened_during_run";

export type SemanticRunFacts = { readonly memoryCaptureAvailable?: boolean } & (
  | {
      readonly stateAvailable: false;
    }
  | {
      readonly stateAvailable: true;
      readonly runCoherent: false;
    }
  | {
      readonly stateAvailable: true;
      readonly runCoherent: true;
      readonly taskRelation: TaskRunRelation;
      readonly completionRelation: CompletionRunRelation;
      readonly gateRelation: GateRunRelation;
    });

interface AvailableSemanticSnapshot {
  readonly memoryCaptureAvailable?: boolean;
  readonly taskStatus: TaskStatus;
  readonly verificationStatus: VerificationStatus | "none";
  readonly hasBlockers: boolean;
  readonly hasQuestions: boolean;
  readonly completionReady: boolean;
}

export type SemanticSnapshot =
  | {
      readonly authority: "unavailable";
    }
  | (AvailableSemanticSnapshot & {
      readonly authority: "stale";
    })
  | (AvailableSemanticSnapshot & {
      readonly authority: "coherent";
      readonly taskRelation: TaskRunRelation;
      readonly completionRelation: CompletionRunRelation;
      readonly gateRelation: GateRunRelation;
    });

export type SemanticDerivationResult =
  | {
      readonly ok: true;
      readonly snapshot: SemanticSnapshot;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type PindieCapability =
  | "observe.project"
  | "observe.git"
  | "memory.capture"
  | "project.mutate"
  | "policy.declare"
  | "policy.adapt"
  | "policy.derive"
  | "task.start"
  | "task.refine"
  | "task.replace"
  | "task.progress"
  | "task.complete"
  | "verification.record"
  | "gate.open"
  | "gate.resolve";

function failed(error: string): SemanticDerivationResult {
  return { ok: false, error };
}

function deriveAvailableSnapshot(
  state: PindieState,
): AvailableSemanticSnapshot {
  const task = state.task;
  const verificationStatus = task ? getVerificationStatus(task) : "none";
  const hasBlockers = task !== null && task.openLoops.blockers.length > 0;
  const hasQuestions = task !== null && task.openLoops.questions.length > 0;
  const completionReady =
    task !== null &&
    !task.completed &&
    verificationStatus === "passed" &&
    !hasBlockers &&
    !hasQuestions &&
    task.humanGate === null;

  return {
    taskStatus: getTaskStatus(state),
    verificationStatus,
    hasBlockers,
    hasQuestions,
    completionReady,
  };
}

function validateCoherentRelationship(
  state: PindieState,
  facts: Extract<SemanticRunFacts, { runCoherent: true }>,
): string | null {
  const task = state.task;

  if (task === null) {
    if (facts.taskRelation !== "none") {
      return "A State without a Task requires taskRelation 'none'.";
    }
    if (facts.completionRelation !== "not_completed") {
      return "A State without a Task requires completionRelation 'not_completed'.";
    }
    if (facts.gateRelation !== "none") {
      return "A State without a Task requires gateRelation 'none'.";
    }
    return null;
  }

  if (facts.taskRelation === "none") {
    return "A State with a Task requires a non-'none' taskRelation.";
  }

  if (task.completed && facts.completionRelation === "not_completed") {
    return "A completed Task requires a completed Run relation.";
  }
  if (!task.completed && facts.completionRelation !== "not_completed") {
    return "An unfinished Task requires completionRelation 'not_completed'.";
  }

  if (task.humanGate === null && facts.gateRelation !== "none") {
    return "A Task without a Human Gate requires gateRelation 'none'.";
  }
  if (task.humanGate !== null && facts.gateRelation === "none") {
    return "A Task with a Human Gate requires a non-'none' gateRelation.";
  }

  if (
    facts.completionRelation === "completed_before_run" &&
    facts.taskRelation !== "preexisting_untouched"
  ) {
    return "A Task completed before the Run must be preexisting and untouched.";
  }
  if (
    facts.completionRelation === "completed_during_run" &&
    facts.taskRelation === "preexisting_untouched"
  ) {
    return "A Task completed during the Run cannot be preexisting and untouched.";
  }
  if (
    facts.gateRelation === "existed_before_run" &&
    facts.taskRelation === "introduced_during_run"
  ) {
    return "A Gate that existed before the Run cannot belong to a Task introduced during the Run.";
  }
  if (
    facts.gateRelation === "opened_during_run" &&
    facts.taskRelation === "preexisting_untouched"
  ) {
    return "Opening a Gate during the Run changes a preexisting Task.";
  }

  return null;
}

export function deriveSemanticSnapshot(
  state: PindieState | null,
  facts: SemanticRunFacts,
): SemanticDerivationResult {
  if (!facts.stateAvailable) {
    if (state !== null) {
      return failed(
        "State cannot be supplied when Run Facts report it as unavailable.",
      );
    }
    return { ok: true, snapshot: { authority: "unavailable" } };
  }

  if (state === null) {
    return failed("Run Facts report State as available, but no State was supplied.");
  }

  const validation = validateState(state);
  if (!validation.ok) {
    return failed(`Invalid PindieState: ${validation.errors.join(" ")}`);
  }

  const availableSnapshot = deriveAvailableSnapshot(state);
  if (!facts.runCoherent) {
    return {
      ok: true,
      snapshot: { authority: "stale", ...availableSnapshot },
    };
  }

  const relationshipError = validateCoherentRelationship(state, facts);
  if (relationshipError !== null) {
    return failed(relationshipError);
  }

  return {
    ok: true,
    snapshot: {
      authority: "coherent",
      ...availableSnapshot,
      memoryCaptureAvailable: facts.memoryCaptureAvailable === true,
      taskRelation: facts.taskRelation,
      completionRelation: facts.completionRelation,
      gateRelation: facts.gateRelation,
    },
  };
}

const OBSERVATION_CAPABILITIES: readonly PindieCapability[] = [
  "observe.project",
  "observe.git",
];

export function deriveCapabilities(
  snapshot: SemanticSnapshot,
): ReadonlySet<PindieCapability> {
  const capabilities = new Set<PindieCapability>([
    ...OBSERVATION_CAPABILITIES,
  ]);

  if (snapshot.authority !== "coherent") {
    return capabilities;
  }

  if (snapshot.memoryCaptureAvailable === true) capabilities.add("memory.capture");

  switch (snapshot.taskStatus) {
    case "idle":
      capabilities.add("task.start");
      break;

    case "done":
      if (snapshot.completionRelation === "completed_before_run") {
        capabilities.add("task.start");
      }
      break;

    case "waiting_human":
      if (snapshot.gateRelation === "existed_before_run") {
        capabilities.add("task.refine");
        capabilities.add("gate.resolve");
        if (snapshot.taskRelation === "preexisting_untouched") {
          capabilities.add("task.replace");
        }
      }
      break;

    case "blocked":
      capabilities.add("project.mutate");
      capabilities.add("task.refine");
      capabilities.add("task.progress");
      capabilities.add("verification.record");
      capabilities.add("gate.open");
      if (snapshot.taskRelation === "preexisting_untouched") {
        capabilities.add("task.replace");
      }
      break;

    case "active":
      capabilities.add("project.mutate");
      capabilities.add("task.refine");
      capabilities.add("task.progress");
      capabilities.add("verification.record");
      capabilities.add("gate.open");
      if (snapshot.taskRelation === "preexisting_untouched") {
        capabilities.add("task.replace");
      }
      if (snapshot.completionReady) {
        capabilities.add("task.complete");
      }
      break;
  }

  return capabilities;
}
