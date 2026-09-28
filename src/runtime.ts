import { isDeepStrictEqual } from "node:util";

import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "./liveness.ts";
import { EMPTY_STATE, type PindieState } from "./state.ts";
import type { PindieStateStore } from "./store.ts";
import type { WorkEpisodeLedger } from "./work-episode.ts";
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

interface ProcessSemanticMutationFenceState {
  readonly projects: Map<string, Set<symbol>>;
}

const PROCESS_SEMANTIC_MUTATION_FENCE = Symbol.for(
  "pindie.runtime.process-semantic-mutation-fence",
);

function processSemanticMutationFenceState(): ProcessSemanticMutationFenceState {
  const globalObject = globalThis as object;
  const existing = Reflect.get(globalObject, PROCESS_SEMANTIC_MUTATION_FENCE) as
    | ProcessSemanticMutationFenceState
    | undefined;
  if (existing !== undefined) return existing;
  const state: ProcessSemanticMutationFenceState = { projects: new Map() };
  Reflect.set(globalObject, PROCESS_SEMANTIC_MUTATION_FENCE, state);
  return state;
}

function hasProcessSemanticMutationFence(projectRoot: string): boolean {
  return (processSemanticMutationFenceState().projects.get(projectRoot)?.size ?? 0) > 0;
}

function installProcessSemanticMutationFence(
  projectRoot: string,
  operation: Promise<unknown>,
): void {
  const state = processSemanticMutationFenceState();
  let leases = state.projects.get(projectRoot);
  if (leases === undefined) {
    leases = new Set<symbol>();
    state.projects.set(projectRoot, leases);
  }
  const token = Symbol("pindie.semantic-mutation-fence-lease");
  leases.add(token);
  const release = (): void => {
    const current = state.projects.get(projectRoot);
    if (current === undefined || !current.delete(token)) return;
    if (current.size === 0) state.projects.delete(projectRoot);
  };
  // Observe both outcomes so a late old mutation cannot become unhandled.
  void operation.then(release, release);
}

export class PindieRuntime {
  private readonly store: PindieStateStore;
  readonly workEpisodes: WorkEpisodeLedger | undefined;
  private currentProjectRoot: string | null = null;
  private currentState: PindieState = EMPTY_STATE;
  private currentExternalStateEpoch = 0;
  private authorityGeneration = 0;

  constructor(store: PindieStateStore, workEpisodes?: WorkEpisodeLedger) { this.store = store; this.workEpisodes = workEpisodes; }
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
    this.assertNoPendingSemanticMutation(projectRoot);
    this.unload();
    const generation = this.authorityGeneration;
    const state = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(null, generation, signal);
    this.assertNoPendingSemanticMutation(projectRoot);
    this.currentProjectRoot = projectRoot;
    this.currentState = state;
    if (this.workEpisodes) {
      try { await this.workEpisodes.reconcile(projectRoot, state); }
      catch (error) { console.warn(`[Pindie] WorkEpisode reconciliation unavailable: ${String(error)}`); }
    }
  }

  async refresh(signal?: AbortSignal): Promise<boolean> {
    const projectRoot = this.requireProjectRoot();
    this.assertNoPendingSemanticMutation(projectRoot);
    const generation = this.authorityGeneration;
    const latest = await this.store.load(projectRoot, signal);
    this.assertCurrentAuthority(projectRoot, generation, signal);
    this.assertNoPendingSemanticMutation(projectRoot);
    return this.adoptExternal(latest);
  }

  async dispatch(event: PindieEvent, signal?: AbortSignal): Promise<TransitionResult> {
    const projectRoot = this.requireProjectRoot();
    this.assertNoPendingSemanticMutation(projectRoot);
    const generation = this.authorityGeneration;
    const expectedState = this.currentState;
    signal?.throwIfAborted();
    return this.store.withProjectLock(projectRoot, async () => {
      this.assertCurrentAuthority(projectRoot, generation, signal);
      this.assertNoPendingSemanticMutation(projectRoot);
      const latestState = await this.store.load(projectRoot, signal);
      this.assertCurrentAuthority(projectRoot, generation, signal);
      this.assertNoPendingSemanticMutation(projectRoot);
      if (!isDeepStrictEqual(latestState, expectedState)) {
        this.adoptExternal(latestState);
        if (event.type !== "invalidate_verification") throw new PindieStateConflictError();
        return this.reduceSavePublish(projectRoot, generation, latestState, event, signal);
      }
      return this.reduceSavePublish(projectRoot, generation, expectedState, event, signal);
    }, signal);
  }

  async dispatchBounded(event: PindieEvent, signal?: AbortSignal): Promise<TransitionResult> {
    const mutationProjectRoot = this.currentProjectRoot;
    this.assertNoPendingSemanticMutation(mutationProjectRoot);
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
        if (!mutationStarted || mutation === null || mutationProjectRoot === null) throw error;
        installProcessSemanticMutationFence(mutationProjectRoot, mutation);
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
    this.assertNoPendingSemanticMutation(projectRoot);
    const result = reduceState(state, event);
    if (!result.ok) return result;
    if (result.state === state) return result;
    this.assertCurrentAuthority(projectRoot, generation, signal);
    this.assertNoPendingSemanticMutation(projectRoot);
    if (this.workEpisodes) {
      try { await this.workEpisodes.prepared(projectRoot, state, event); }
      catch (error) { console.warn(`[Pindie] WorkEpisode preparation unavailable: ${String(error)}`); }
    }
    await this.store.save(projectRoot, result.state, signal);
    this.assertCurrentAuthority(projectRoot, generation, signal);
    this.assertNoPendingSemanticMutation(projectRoot);
    this.currentState = result.state;
    if (this.workEpisodes) {
      try { await this.workEpisodes.committed(projectRoot, state, result.state, event); }
      catch (error) { console.warn(`[Pindie] WorkEpisode binding unavailable: ${String(error)}`); }
    }
    return result;
  }

  private adoptExternal(latest: PindieState): boolean {
    if (isDeepStrictEqual(latest, this.currentState)) return false;
    this.currentState = latest;
    this.currentExternalStateEpoch += 1;
    return true;
  }

  private assertNoPendingSemanticMutation(projectRoot: string | null): void {
    if (projectRoot !== null && hasProcessSemanticMutationFence(projectRoot)) {
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
