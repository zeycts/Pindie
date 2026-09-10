import { isDeepStrictEqual } from "node:util";

import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "./liveness.ts";
import { EMPTY_STATE, type PindieState } from "./state.ts";
import type { PindieStateStore } from "./store.ts";
import {
  reduceState,
  type PindieEvent,
  type TransitionResult,
} from "./transitions.ts";

export class PindieStateConflictError extends Error {
  constructor() {
    super("Project State changed externally. Pindie adopted the latest authoritative State; begin a new Agent Run before applying this semantic transition.");
    this.name = "PindieStateConflictError";
  }
}

export class PindieRuntimeStaleAuthorityError extends Error {
  constructor() {
    super("Pindie State read completed after its runtime authority context was invalidated.");
    this.name = "PindieRuntimeStaleAuthorityError";
  }
}

export class PindieStateMutationUncertainError extends Error {
  constructor() {
    super("Pindie semantic State mutation timed out/was aborted. Durable State outcome is currently uncertain; semantic authority is unavailable for this Run.");
    this.name = "PindieStateMutationUncertainError";
  }
}

export class PindieSemanticMutationPendingError extends Error {
  constructor() {
    super("Pindie semantic State mutation is still pending. Durable State outcome remains uncertain; semantic authority is unavailable until that mutation settles.");
    this.name = "PindieSemanticMutationPendingError";
  }
}

export class PindieRuntime {
  private readonly store: PindieStateStore;
  private currentProjectRoot: string | null = null;
  private currentState: PindieState = EMPTY_STATE;
  private currentExternalStateEpoch = 0;
  private authorityGeneration = 0;
  private pendingSemanticMutation: Promise<void> | null = null;

  constructor(store: PindieStateStore) { this.store = store; }
  get state(): PindieState { return this.currentState; }
  get projectRoot(): string | null { return this.currentProjectRoot; }
  get externalStateEpoch(): number { return this.currentExternalStateEpoch; }

  unload(): void {
    this.authorityGeneration += 1;
    this.currentProjectRoot = null;
    this.currentState = EMPTY_STATE;
    this.currentExternalStateEpoch = 0;
  }

  async load(projectRoot: string, signal?: AbortSignal): Promise<void> {
    this.assertNoPendingSemanticMutation();
    this.unload();
    const generation = this.authorityGeneration;
    const state = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(null, generation, signal);
    this.currentProjectRoot = projectRoot;
    this.currentState = state;
  }

  async refresh(signal?: AbortSignal): Promise<boolean> {
    this.assertNoPendingSemanticMutation();
    const projectRoot = this.requireProjectRoot();
    const generation = this.authorityGeneration;
    const latest = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(projectRoot, generation, signal);
    return this.adoptExternal(latest);
  }

  async dispatch(event: PindieEvent, signal?: AbortSignal): Promise<TransitionResult> {
    this.assertNoPendingSemanticMutation();
    const projectRoot = this.requireProjectRoot();
    const generation = this.authorityGeneration;
    const expectedState = this.currentState;
    signal?.throwIfAborted();
    return this.store.withProjectLock(projectRoot, async () => {
      this.assertCurrentAuthority(projectRoot, generation, signal);
      const latestState = await this.store.load(projectRoot, signal);
      this.assertCurrentAuthority(projectRoot, generation, signal);
      if (!isDeepStrictEqual(latestState, expectedState)) {
        this.adoptExternal(latestState);
        if (event.type !== "invalidate_verification") throw new PindieStateConflictError();
        return this.reduceSavePublish(projectRoot, generation, latestState, event, signal);
      }
      return this.reduceSavePublish(projectRoot, generation, expectedState, event, signal);
    }, signal);
  }

  async dispatchBounded(event: PindieEvent, signal?: AbortSignal): Promise<TransitionResult> {
    this.assertNoPendingSemanticMutation();
    let mutationStarted = false;
    let mutation: Promise<TransitionResult> | null = null;
    try {
      return await runBoundedOperation({
        label: "Pindie semantic State mutation",
        timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
        signal,
        run: (innerSignal) => {
          mutationStarted = true;
          const operation = this.dispatch(event, innerSignal);
          mutation = operation;
          return operation;
        },
      });
    } catch (error) {
      if (
        error instanceof PindieLivenessTimeoutError ||
        error instanceof PindieLivenessAbortError
      ) {
        if (!mutationStarted || mutation === null) throw error;
        this.installSemanticMutationFence(mutation);
        throw new PindieStateMutationUncertainError();
      }
      throw error;
    }
  }

  private async reduceSavePublish(
    projectRoot: string,
    generation: number,
    state: PindieState,
    event: PindieEvent,
    signal?: AbortSignal,
  ): Promise<TransitionResult> {
    this.assertCurrentAuthority(projectRoot, generation, signal);
    const result = reduceState(state, event);
    if (!result.ok) return result;
    if (result.state === state) return result;
    this.assertCurrentAuthority(projectRoot, generation, signal);
    await this.store.save(projectRoot, result.state, signal);
    this.assertCurrentAuthority(projectRoot, generation, signal);
    this.currentState = result.state;
    return result;
  }

  private adoptExternal(latest: PindieState): boolean {
    if (isDeepStrictEqual(latest, this.currentState)) return false;
    this.currentState = latest;
    this.currentExternalStateEpoch += 1;
    return true;
  }

  private installSemanticMutationFence(operation: Promise<TransitionResult>): void {
    const fence = operation.then(
      () => undefined,
      () => undefined,
    );
    this.pendingSemanticMutation = fence;
    void fence.finally(() => {
      if (this.pendingSemanticMutation === fence) {
        this.pendingSemanticMutation = null;
      }
    });
  }

  private assertNoPendingSemanticMutation(): void {
    if (this.pendingSemanticMutation !== null) {
      throw new PindieSemanticMutationPendingError();
    }
  }

  private assertCurrentAuthority(
    projectRoot: string | null,
    generation: number,
    signal?: AbortSignal,
  ): void {
    if (
      signal?.aborted ||
      generation !== this.authorityGeneration ||
      this.currentProjectRoot !== projectRoot
    ) {
      throw new PindieRuntimeStaleAuthorityError();
    }
  }

  private requireProjectRoot(): string {
    if (this.currentProjectRoot === null) throw new Error("PindieRuntime.load(projectRoot) must complete before dispatch().");
    return this.currentProjectRoot;
  }
}
