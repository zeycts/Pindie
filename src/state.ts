export interface PindieState {
  task: PindieTask | null;
}

export interface PindieTask {
  goal: string;
  constraints: string[];
  successCriteria: SuccessCriterion[];
  openLoops: OpenLoops;
  verification: VerificationState;
  humanGate: HumanGate | null;
  completed: boolean;
}

export interface SuccessCriterion {
  id: string;
  description: string;
}

export interface OpenLoops {
  blockers: string[];
  questions: string[];
  nextIntent: string | null;
}

export interface VerificationState {
  stale: boolean;
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  name: string;
  status: "passed" | "failed";
  covers: string[];
  evidence: string;
}

export interface HumanGate {
  kind: "decision" | "approval" | "input";
  question: string;
  options?: string[];
}

export type TaskStatus =
  | "idle"
  | "active"
  | "blocked"
  | "waiting_human"
  | "done";

export type VerificationStatus = "pending" | "stale" | "failed" | "passed";

export const EMPTY_STATE: PindieState = Object.freeze({
  task: null,
});

export function getTaskStatus(state: PindieState): TaskStatus {
  const task = state.task;

  if (!task) return "idle";
  if (task.completed) return "done";
  if (task.humanGate) return "waiting_human";
  if (task.openLoops.blockers.length > 0) return "blocked";

  return "active";
}

export function getVerificationStatus(task: PindieTask): VerificationStatus {
  const { verification } = task;

  if (verification.stale) return "stale";
  if (verification.checks.length === 0) return "pending";
  if (verification.checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  const coveredCriteria = new Set(
    verification.checks
      .filter((check) => check.status === "passed")
      .flatMap((check) => check.covers),
  );

  const allCriteriaCovered = task.successCriteria.every((criterion) =>
    coveredCriteria.has(criterion.id),
  );

  return allCriteriaCovered ? "passed" : "pending";
}

export type StateValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validates hard State invariants only.
 *
 * It intentionally does not judge whether verification evidence is truthful;
 * evidence quality belongs to runtime/tool behavior rather than structural State.
 */
export function validateState(state: PindieState): StateValidationResult {
  const task = state.task;
  if (!task) return { ok: true };

  const errors: string[] = [];
  const criterionIds = task.successCriteria.map((criterion) => criterion.id);
  const criterionIdSet = new Set(criterionIds);
  const checkNames = task.verification.checks.map((check) => check.name);

  if (task.successCriteria.length === 0) {
    errors.push("A task requires at least one success criterion.");
  }

  if (criterionIdSet.size !== criterionIds.length) {
    errors.push("Success criterion IDs must be unique.");
  }

  if (new Set(checkNames).size !== checkNames.length) {
    errors.push("Verification check names must be unique.");
  }

  for (const check of task.verification.checks) {
    for (const criterionId of check.covers) {
      if (!criterionIdSet.has(criterionId)) {
        errors.push(
          `Verification check '${check.name}' references unknown success criterion '${criterionId}'.`,
        );
      }
    }
  }

  if (task.verification.stale && task.verification.checks.length > 0) {
    errors.push("Stale verification must not retain current checks.");
  }

  if (task.completed) {
    if (task.humanGate !== null) {
      errors.push("A completed task cannot have an open Human Gate.");
    }

    if (task.openLoops.blockers.length > 0) {
      errors.push("A completed task cannot have blockers.");
    }

    if (task.openLoops.questions.length > 0) {
      errors.push("A completed task cannot have unresolved questions.");
    }

    if (task.openLoops.nextIntent !== null) {
      errors.push("A completed task cannot have a next intent.");
    }

    if (getVerificationStatus(task) !== "passed") {
      errors.push("A completed task requires current passed verification.");
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
