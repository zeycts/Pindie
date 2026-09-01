import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  beginAgentRunFacts,
  deriveSemanticRunFacts,
  recordSuccessfulCapability,
  type AgentRunFactsContext,
} from "./run-facts.ts";
import { PindieRuntime } from "./runtime.ts";
import type { PolicySnapshot } from "./policy.ts";
import {
  deriveCapabilities,
  deriveSemanticSnapshot,
  type PindieCapability,
  type SemanticDerivationResult,
  type SemanticRunFacts,
} from "./semantics.ts";
import type { ToolEffect } from "./execution-semantics.ts";
import type { PindieState } from "./state.ts";
import {
  type RunExperienceExecution,
  type RunExperiencePolicy,
  RunExperienceTracker,
} from "./run-experience.ts";
import { deriveEffectiveToolNames } from "./tool-surface.ts";

function sameToolNames(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((name, index) => name === right[index]);
}

/** Pi-facing ownership for runtime-only Agent Run authority and Tool Surface state. */
export class RunIntegration {
  private readonly pi: ExtensionAPI;
  readonly runtime: PindieRuntime;
  private unavailableReason: string | null = null;
  private agentRunFactsContext: AgentRunFactsContext | null = null;
  private runToolBaseline: readonly string[] | null = null;
  private continuationAttempted = false;
  private currentPolicySnapshot: PolicySnapshot | null = null;
  private agentRunActive = false;
  private agentRunGeneration = 0;
  private agentRunSettlementInProgress = false;
  readonly experience = new RunExperienceTracker();

  constructor(pi: ExtensionAPI, runtime: PindieRuntime) {
    this.pi = pi;
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

  get executionCounters(): RunExperienceExecution {
    return this.experience.execution;
  }

  get policyAttribution(): RunExperiencePolicy {
    return this.experience.policy;
  }

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    this.currentPolicySnapshot = snapshot;
    this.experience.setPolicySnapshot(snapshot);
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

  async loadProject(projectRoot: string): Promise<void> {
    await this.runtime.load(projectRoot);
  }

  async refreshAuthoritativeState(): Promise<boolean> {
    return this.runtime.refresh();
  }

  markUnavailable(reason: string): void {
    this.runtime.unload();
    this.unavailableReason = reason;
    this.clearAgentRunBookkeeping();
    this.applyToolSurface(deriveCapabilities({ authority: "unavailable" }));
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

  recordToolResult(toolCallId: string, isError: boolean): "execution" | "policy" | null {
    return this.experience.recordToolResult(toolCallId, isError);
  }

  recordSuccessfulPolicyDeclaration(): void {
    this.experience.recordSuccessfulPolicyDeclaration();
  }

  recordFailedPolicyDeclaration(): void {
    this.currentPolicySnapshot = this.experience.recordFailedPolicyDeclaration();
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

  captureRunToolBaseline(): void {
    if (this.runToolBaseline === null) {
      this.runToolBaseline = [...this.pi.getActiveTools()];
    }
  }

  applyToolSurface(capabilities: ReadonlySet<PindieCapability>): void {
    if (this.runToolBaseline === null) return;
    const effective = deriveEffectiveToolNames(
      this.runToolBaseline,
      capabilities,
    );
    if (!sameToolNames(this.pi.getActiveTools(), effective)) {
      this.pi.setActiveTools(effective);
    }
  }

  refreshToolSurface(): SemanticDerivationResult {
    const derivation = this.deriveSnapshot();
    if (derivation.ok) {
      this.applyToolSurface(deriveCapabilities(derivation.snapshot));
    }
    return derivation;
  }

  restoreRunToolBaseline(bestEffort = false): void {
    const baseline = this.runToolBaseline;
    if (baseline === null) return;
    try {
      if (!sameToolNames(this.pi.getActiveTools(), baseline)) {
        this.pi.setActiveTools([...baseline]);
      }
      this.runToolBaseline = null;
    } catch (error) {
      if (!bestEffort) throw error;
      this.runToolBaseline = null;
    }
  }
}
