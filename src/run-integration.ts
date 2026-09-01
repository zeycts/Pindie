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
import type { PindieState } from "./state.ts";
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

  setPolicySnapshot(snapshot: PolicySnapshot): void {
    this.currentPolicySnapshot = snapshot;
  }

  clearPolicySnapshot(): void {
    this.currentPolicySnapshot = null;
  }

  resetAgentRun(): void {
    this.clearAgentRunBookkeeping();
    this.clearPolicySnapshot();
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
  }

  beginAgentRunFacts(): void {
    const state = this.authoritativeState;
    if (state === null) return;
    this.agentRunFactsContext = beginAgentRunFacts(
      state,
      this.runtime.externalStateEpoch,
    );
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
