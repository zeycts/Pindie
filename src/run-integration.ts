import {
  beginAgentRunFacts,
  deriveSemanticRunFacts,
  recordSuccessfulCapability,
  type AgentRunFactsContext,
} from "./run-facts.ts";
import { PindieRuntime } from "./runtime.ts";
import {
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticDerivationResult,
  type SemanticRunFacts,
} from "./semantics.ts";
import type { ToolEffect } from "./execution-semantics.ts";
import type { PindieState } from "./state.ts";
import { RunCounters, type RunExecutionCounters } from "./run-counters.ts";
/** Pi-facing ownership for runtime-only Agent Run authority state. */
export class RunIntegration {
  readonly runtime: PindieRuntime;
  private unavailableReason: string | null = null;
  private agentRunFactsContext: AgentRunFactsContext | null = null;
  private continuationAttempted = false;
  private agentRunActive = false;
  private agentRunGeneration = 0;
  private agentRunSettlementInProgress = false;
  private readonly counters = new RunCounters();

  constructor(runtime: PindieRuntime) {
    this.runtime = runtime;
  }

  get stateUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  get authoritativeState(): PindieState | null {
    return this.runtime.projectRoot === null || this.unavailableReason !== null
      ? null
      : this.runtime.state;
  }

  get semanticRunFacts(): SemanticRunFacts {
    return deriveSemanticRunFacts(
      this.agentRunFactsContext,
      this.authoritativeState,
      this.runtime.externalStateEpoch,
    );
  }

  get agentRunIsStale(): boolean {
    const facts = this.semanticRunFacts;
    return facts.stateAvailable && !facts.runCoherent;
  }

  get activeTaskContinuationAttempted(): boolean {
    return this.continuationAttempted;
  }

  get hasActiveAgentRun(): boolean {
    return this.agentRunActive;
  }

  get activeAgentRunGeneration(): number | null {
    return this.agentRunActive ? this.agentRunGeneration : null;
  }

  isAgentRunCurrent(generation: number): boolean {
    return this.agentRunActive && this.agentRunGeneration === generation;
  }

  claimAgentRunSettlement(): boolean {
    if (!this.agentRunActive || this.agentRunSettlementInProgress) return false;
    this.agentRunSettlementInProgress = true;
    return true;
  }

  get taskStatusAtRunStart(): AgentRunFactsContext["taskStatusAtRunStart"] | null {
    return this.agentRunFactsContext?.taskStatusAtRunStart ?? null;
  }

  get taskGoalAtRunStart(): string | null {
    return this.agentRunFactsContext?.taskAtRunStart?.goal ?? null;
  }

  get executionCounters(): RunExecutionCounters {
    return this.counters.execution;
  }

  resetAgentRun(): void {
    this.agentRunGeneration += 1;
    this.clearAgentRunBookkeeping();
    this.counters.reset();
  }

  deriveSnapshot(): SemanticDerivationResult {
    return deriveSemanticSnapshot(
      this.authoritativeState,
      this.semanticRunFacts,
    );
  }

  resetStateAuthority(): void {
    this.runtime.unload();
    this.unavailableReason = null;
  }

  async loadProject(projectRoot: string, signal?: AbortSignal): Promise<void> {
    await this.runtime.load(projectRoot, signal);
  }

  async refreshAuthoritativeState(signal?: AbortSignal): Promise<boolean> {
    return this.runtime.refresh(signal);
  }

  markUnavailable(reason: string): void {
    this.runtime.unload();
    this.unavailableReason = reason;
    this.clearAgentRunBookkeeping();
  }

  clearAgentRunBookkeeping(): void {
    this.agentRunFactsContext = null;
    this.continuationAttempted = false;
    this.agentRunActive = false;
    this.agentRunSettlementInProgress = false;
  }

  beginAgentRunFacts(): void {
    this.agentRunGeneration += 1;
    this.agentRunActive = true;
    this.agentRunSettlementInProgress = false;
    const state = this.authoritativeState;
    if (state === null) return;
    this.agentRunFactsContext = beginAgentRunFacts(
      state,
      this.runtime.externalStateEpoch,
    );
  }

  recordAuthorizedCall(toolCallId: string, effect: ToolEffect): void {
    this.counters.recordAuthorizedCall(toolCallId, effect);
  }

  recordDeniedCall(effect: ToolEffect): void {
    this.counters.recordDeniedCall(effect);
  }

  recordToolResult(
    toolCallId: string,
    isError: boolean,
  ): "execution" | "memory" | null {
    return this.counters.recordToolResult(toolCallId, isError);
  }

  recordSuccessfulCapability(capability: PindieCapability): void {
    if (this.agentRunFactsContext === null) return;
    this.agentRunFactsContext = recordSuccessfulCapability(
      this.agentRunFactsContext,
      capability,
    );
  }

  markContinuationAttempted(): void {
    this.continuationAttempted = true;
  }

}
