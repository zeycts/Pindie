import { EMPTY_STATE, type PindieState } from "./state.ts";
import type { PindieStateStore } from "./store.ts";
import {
  reduceState,
  type PindieEvent,
  type TransitionResult,
} from "./transitions.ts";

export class PindieRuntime {
  private readonly store: PindieStateStore;
  private currentProjectRoot: string | null = null;
  private currentState: PindieState = EMPTY_STATE;

  constructor(store: PindieStateStore) {
    this.store = store;
  }

  get state(): PindieState {
    return this.currentState;
  }

  get projectRoot(): string | null {
    return this.currentProjectRoot;
  }

  unload(): void {
    this.currentProjectRoot = null;
    this.currentState = EMPTY_STATE;
  }

  async load(projectRoot: string): Promise<void> {
    this.unload();

    const state = await this.store.load(projectRoot);

    this.currentProjectRoot = projectRoot;
    this.currentState = state;
  }

  async dispatch(event: PindieEvent): Promise<TransitionResult> {
    if (this.currentProjectRoot === null) {
      throw new Error("PindieRuntime.load(projectRoot) must complete before dispatch().");
    }

    const result = reduceState(this.currentState, event);
    if (!result.ok) return result;

    await this.store.save(this.currentProjectRoot, result.state);
    this.currentState = result.state;

    return result;
  }
}
