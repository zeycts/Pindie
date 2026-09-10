import { randomUUID } from "node:crypto";

import { getProjectId } from "./store.ts";

/** Exact model-callable tool permitted by a global synthesis Run. */
export const PINDIE_STRATEGY_SYNTHESIS_CANDIDATE_CREATE_TOOL =
  "pindie_strategy_synthesis_candidate_create" as const;

export interface GlobalDerivationReservation {
  readonly attemptId: string;
  readonly sessionId: string;
  /** Native invocation/project root captured before asynchronous preparation. */
  readonly invocationRoot: string;
  readonly projectId: string;
  readonly agentRunGeneration: number | null;
}

export interface GlobalDerivationLease extends GlobalDerivationReservation {
  readonly agentRunGeneration: number;
}

export type GlobalDerivationReservationReason =
  | "adaptation"
  | "derivation"
  | "trial"
  | "global-derivation";

export type GlobalDerivationReservationResult =
  | {
      readonly allowed: true;
      readonly reservation: GlobalDerivationReservation;
    }
  | {
      readonly allowed: false;
      readonly reason: GlobalDerivationReservationReason;
    };

function validSessionId(value: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function validRoot(value: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** SI-owned runtime-only reservation for the one global derivation attempt. */
export class GlobalDerivationRuntime {
  private pending: GlobalDerivationReservation | null = null;
  private active: GlobalDerivationLease | null = null;

  get hasAttempt(): boolean {
    return this.pending !== null || this.active !== null;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  get hasActive(): boolean {
    return this.active !== null;
  }

  get pendingReservation(): GlobalDerivationReservation | null {
    return this.pending;
  }

  get activeReservation(): GlobalDerivationLease | null {
    return this.active;
  }

  /** Reserve synchronously; no asynchronous preparation occurs in this method. */
  reserve(
    sessionId: string,
    invocationRoot: string,
  ): GlobalDerivationReservation | null {
    if (
      !validSessionId(sessionId) ||
      !validRoot(invocationRoot) ||
      this.hasAttempt
    ) return null;
    const reservation = Object.freeze({
      attemptId: randomUUID(),
      sessionId,
      invocationRoot,
      projectId: getProjectId(invocationRoot),
      agentRunGeneration: null,
    });
    this.pending = reservation;
    return reservation;
  }

  bind(
    reservation: GlobalDerivationReservation,
    sessionId: string,
    invocationRoot: string,
    agentRunGeneration: number,
  ): GlobalDerivationLease | null {
    if (
      this.pending === null ||
      this.active !== null ||
      !validGeneration(agentRunGeneration) ||
      this.pending.attemptId !== reservation.attemptId ||
      this.pending.sessionId !== sessionId ||
      this.pending.sessionId !== reservation.sessionId ||
      this.pending.invocationRoot !== invocationRoot ||
      this.pending.invocationRoot !== reservation.invocationRoot ||
      this.pending.projectId !== reservation.projectId
    ) return null;
    const active = Object.freeze({
      ...this.pending,
      agentRunGeneration,
    });
    this.pending = null;
    this.active = active;
    return active;
  }

  /** Check an exact pending or active reservation without changing it. */
  isCurrent(
    reservation: GlobalDerivationReservation,
  ): boolean {
    const current = reservation.agentRunGeneration === null
      ? this.pending
      : this.active;
    return current !== null &&
      current.attemptId === reservation.attemptId &&
      current.sessionId === reservation.sessionId &&
      current.invocationRoot === reservation.invocationRoot &&
      current.projectId === reservation.projectId &&
      current.agentRunGeneration === reservation.agentRunGeneration;
  }

  isActiveForGeneration(agentRunGeneration: number | null): boolean {
    return this.active !== null &&
      agentRunGeneration !== null &&
      this.active.agentRunGeneration === agentRunGeneration;
  }

  activeFor(
    sessionId: string | null,
    invocationRoot: string | null,
    agentRunGeneration: number | null,
  ): GlobalDerivationLease | null {
    if (
      this.active === null ||
      sessionId === null ||
      invocationRoot === null ||
      agentRunGeneration === null ||
      this.active.sessionId !== sessionId ||
      this.active.invocationRoot !== invocationRoot ||
      this.active.agentRunGeneration !== agentRunGeneration
    ) return null;
    return this.active;
  }

  clear(): void {
    this.pending = null;
    this.active = null;
  }
}
