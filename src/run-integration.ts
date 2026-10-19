import {
  beginAgentRunFacts,
  deriveSemanticRunFacts,
  recordSuccessfulCapability,
  type AgentRunFactsContext,
} from "./run-facts.ts";
import { PindieRuntime } from "./runtime.ts";
import type { PolicySnapshot } from "./policy.ts";
import {
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticDerivationResult,
  type SemanticRunFacts,
} from "./semantics.ts";
import type { ToolEffect } from "./execution-semantics.ts";
import type { PindieState } from "./state.ts";
import type { RunExperiencePolicy } from "./run-experience.ts";
import { RunCounters, type RunExecutionCounters } from "./run-counters.ts";
/** Pi-facing ownership for runtime-only Agent Run authority state. */
export class RunIntegration {
  readonly runtime: PindieRuntime;
  private unavailableReason: string | null = null;
  private agentRunFactsContext: AgentRunFactsContext | null = null;
  private continuationAttempted = false;
  private currentPolicySnapshot: PolicySnapshot | null = null;
  private agentRunActive = false;
  private agentRunGeneration = 0;
  private agentRunSettlementInProgress = false;
  readonly experience = new RunCounters();

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

  get policySnapshot(): PolicySnapshot | null {
    return this.currentPolicySnapshot;
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
    return this.experience.execution;
  }

  get policyAttribution(): RunExperiencePolicy {
    return { finalSnapshot: null, declarationCount: 0, finalPolicyDeclarationCount: 0,
      finalPolicyFirstDeclaredAfter: null, finalPolicyLastDeclaredAfter: null };
  }

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    // Retired compatibility seam. Policy cannot affect ordinary Runs.
    void snapshot;
  }

  clearPolicySnapshot(): void {
    this.currentPolicySnapshot = null;
  }

  resetAgentRun(): void {
    this.agentRunGeneration += 1;
    this.clearAgentRunBookkeeping();
    this.clearPolicySnapshot();
    this.experience.reset();
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
    this.experience.recordAuthorizedCall(toolCallId, effect);
  }

  recordDeniedCall(effect: ToolEffect): void {
    this.experience.recordDeniedCall(effect);
  }

  recordToolResult(
    toolCallId: string,
    isError: boolean,
  ): "execution" | "policy" | "self-improvement" | "memory" | null {
    return this.experience.recordToolResult(toolCallId, isError);
  }

  recordSuccessfulPolicyDeclaration(): void {
    // Retired; no attribution is collected.
  }

  recordFailedPolicyDeclaration(): void {
    this.currentPolicySnapshot = null;
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
