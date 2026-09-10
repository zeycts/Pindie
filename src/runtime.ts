import { isDeepStrictEqual } from "node:util";

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

export class PindieRuntime {
  private readonly store: PindieStateStore;
  private currentProjectRoot: string | null = null;
  private currentState: PindieState = EMPTY_STATE;
  private currentExternalStateEpoch = 0;
  private authorityGeneration = 0;

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
    this.unload();
    const generation = this.authorityGeneration;
    const state = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(null, generation, signal);
    this.currentProjectRoot = projectRoot;
    this.currentState = state;
  }

  async refresh(signal?: AbortSignal): Promise<boolean> {
    const projectRoot = this.requireProjectRoot();
    const generation = this.authorityGeneration;
    const latest = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(projectRoot, generation, signal);
    return this.adoptExternal(latest);
  }

  async dispatch(event: PindieEvent): Promise<TransitionResult> {
    const projectRoot = this.requireProjectRoot();
    const expectedState = this.currentState;
    return this.store.withProjectLock(projectRoot, async () => {
      const latestState = await this.store.load(projectRoot);
      if (!isDeepStrictEqual(latestState, expectedState)) {
        this.adoptExternal(latestState);
        if (event.type !== "invalidate_verification") throw new PindieStateConflictError();
        return this.reduceSavePublish(projectRoot, latestState, event);
      }
      return this.reduceSavePublish(projectRoot, expectedState, event);
    });
  }

  private async reduceSavePublish(projectRoot: string, state: PindieState, event: PindieEvent): Promise<TransitionResult> {
    const result = reduceState(state, event);
    if (!result.ok) return result;
    if (result.state === state) return result;
    await this.store.save(projectRoot, result.state);
    this.currentState = result.state;
    return result;
  }

  private adoptExternal(latest: PindieState): boolean {
    if (isDeepStrictEqual(latest, this.currentState)) return false;
    this.currentState = latest;
    this.currentExternalStateEpoch += 1;
    return true;
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
