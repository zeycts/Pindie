import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import type { ToolEffect } from "./execution-semantics.ts";
import {
  PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
  PindieLivenessAbortError,
  PindieLivenessTimeoutError,
  runBoundedOperation,
} from "./liveness.ts";
import {
  captureProjectFingerprint as defaultCaptureProjectFingerprint,
  type ProjectFingerprint,
} from "./project-mutation.ts";
import type { PindieCapability, SemanticRunFacts } from "./semantics.ts";
import type { PindieState } from "./state.ts";
import {
  advanceEvidenceGeneration,
  captureEvidenceCandidate,
  createVerificationEvidenceScope,
  resolveAndMaterializeEvidence,
  type VerificationEvidenceScope,
} from "./verification-evidence.ts";

interface MutationWindow {
  projectRoot: string;
  baseline: ProjectFingerprint;
  pendingToolCallIds: Set<string>;
}

export interface AuthorizedToolExecution {
  readonly effect: ToolEffect;
  readonly evidenceGenerationAtCall: number;
  readonly capabilitiesAtCall: ReadonlySet<PindieCapability> | null;
}

export type ProjectMutationSettlement =
  | "none"
  | "unchanged"
  | "invalidate"
  | "ignore";

export interface CapturedEvidenceResult {
  readonly content: ToolResultEvent["content"];
}

export interface ExecutionIntegrationOptions {
  captureProjectFingerprint?: (projectRoot: string) => Promise<ProjectFingerprint>;
}

/** Runtime-only execution bookkeeping for mutation freshness and evidence provenance. */
export class ExecutionIntegration {
  private readonly captureProjectFingerprint: (
    projectRoot: string,
  ) => Promise<ProjectFingerprint>;
  private mutationWindow: MutationWindow | null = null;
  private readonly authorizedToolExecutions = new Map<
    string,
    AuthorizedToolExecution
  >();
  private evidenceScope: VerificationEvidenceScope | null = null;
  private evidenceExternalStateEpoch = 0;

  constructor(options: ExecutionIntegrationOptions = {}) {
    this.captureProjectFingerprint =
      options.captureProjectFingerprint ?? defaultCaptureProjectFingerprint;
  }

  discardRuntime(): void {
    this.mutationWindow = null;
    this.authorizedToolExecutions.clear();
    this.evidenceScope = null;
    this.evidenceExternalStateEpoch = 0;
  }

  beginEvidenceScope(externalStateEpoch: number): void {
    this.evidenceScope = createVerificationEvidenceScope();
    this.evidenceExternalStateEpoch = externalStateEpoch;
  }

  semanticAuthorityUnavailable(): void {
    this.advanceEvidenceGeneration();
    this.discardRuntime();
  }

  semanticStateChanged(externalStateEpoch: number): void {
    if (
      this.evidenceScope === null ||
      this.evidenceExternalStateEpoch === externalStateEpoch
    ) {
      return;
    }
    advanceEvidenceGeneration(this.evidenceScope);
    this.evidenceExternalStateEpoch = externalStateEpoch;
  }

  advanceEvidenceGeneration(): void {
    if (this.evidenceScope !== null) {
      advanceEvidenceGeneration(this.evidenceScope);
    }
  }

  resolveVerificationEvidence(refs: readonly string[]): string {
    return resolveAndMaterializeEvidence(
      this.evidenceScope ?? createVerificationEvidenceScope(),
      refs,
    );
  }

  recordAuthorizedObservation(
    event: ToolCallEvent,
    effect: ToolEffect,
    capabilities?: ReadonlySet<PindieCapability>,
  ): void {
    this.recordAuthorizedExecution(event.toolCallId, effect, capabilities);
  }

  async recordAuthorizedConsequentialCall(
    event: ToolCallEvent,
    effect: ToolEffect,
    projectRoot: string,
    capabilities?: ReadonlySet<PindieCapability>,
  ): Promise<void> {
    if (effect.projectMutation === "ambiguous") {
      if (this.mutationWindow === null) {
        let baseline: ProjectFingerprint;
        baseline = await this.captureProjectFingerprintBounded(
          projectRoot,
          "Pindie project mutation baseline fingerprint",
        );
        this.mutationWindow = {
          projectRoot,
          baseline,
          pendingToolCallIds: new Set(),
        };
      } else if (this.mutationWindow.projectRoot !== projectRoot) {
        this.mutationWindow.baseline = {
          kind: "unknown",
          reason: "Mutation window project root changed.",
        };
      }
      this.mutationWindow.pendingToolCallIds.add(event.toolCallId);
    }

    this.recordAuthorizedExecution(event.toolCallId, effect, capabilities);
  }

  takeAuthorizedExecution(
    toolCallId: string,
  ): AuthorizedToolExecution | null {
    const execution = this.authorizedToolExecutions.get(toolCallId) ?? null;
    if (execution !== null) {
      this.authorizedToolExecutions.delete(toolCallId);
    }
    return execution;
  }

  async settleProjectMutation(
    event: ToolResultEvent,
    execution: AuthorizedToolExecution,
  ): Promise<ProjectMutationSettlement> {
    const { effect } = execution;
    if (effect.projectMutation === "known") {
      return event.isError ? "none" : "invalidate";
    }
    if (effect.projectMutation !== "ambiguous") return "none";

    const window = this.mutationWindow;
    if (!window || !window.pendingToolCallIds.delete(event.toolCallId)) {
      return "ignore";
    }
    if (window.pendingToolCallIds.size === 0) this.mutationWindow = null;
    if (window.baseline.kind === "unknown") return "invalidate";

    const after = await this.captureProjectFingerprintBounded(
      window.projectRoot,
      "Pindie project mutation settlement fingerprint",
    );
    return after.kind === "known" && after.digest === window.baseline.digest
      ? "unchanged"
      : "invalidate";
  }

  captureEvidenceIfEligible(
    execution: AuthorizedToolExecution,
    event: ToolResultEvent,
    state: PindieState | null,
    facts: SemanticRunFacts,
  ): CapturedEvidenceResult | undefined {
    const scope = this.evidenceScope;
    if (
      scope === null ||
      execution.evidenceGenerationAtCall !== scope.generation ||
      !facts.stateAvailable ||
      !facts.runCoherent ||
      state?.task === null ||
      state?.task.completed
    ) {
      return;
    }
    const { effect } = execution;
    if (
      effect.requiredCapability !== "observe.project" &&
      effect.requiredCapability !== "observe.git" &&
      effect.projectMutation !== "ambiguous"
    ) {
      return;
    }

    const candidate = captureEvidenceCandidate(scope, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      content: event.content,
      isError: event.isError,
    });
    return {
      content: [
        ...event.content,
        {
          type: "text",
          text: `[Pindie evidence ref: ${candidate.ref}]`,
        },
      ],
    };
  }

  private async captureProjectFingerprintBounded(
    projectRoot: string,
    label: string,
  ): Promise<ProjectFingerprint> {
    try {
      return await runBoundedOperation({
        label,
        timeoutMs: PINDIE_TOOL_LIVENESS_TIMEOUT_MS,
        run: () => this.captureProjectFingerprint(projectRoot),
      });
    } catch (error) {
      if (error instanceof PindieLivenessTimeoutError) {
        return { kind: "unknown", reason: "Project fingerprint capture timed out." };
      }
      if (error instanceof PindieLivenessAbortError) {
        return { kind: "unknown", reason: "Project fingerprint capture was aborted." };
      }
      return { kind: "unknown", reason: "Project fingerprint capture failed." };
    }
  }

  private recordAuthorizedExecution(
    toolCallId: string,
    effect: ToolEffect,
    capabilities?: ReadonlySet<PindieCapability>,
  ): void {
    this.authorizedToolExecutions.set(toolCallId, {
      effect,
      evidenceGenerationAtCall: this.evidenceScope?.generation ?? -1,
      capabilitiesAtCall: capabilities === undefined
        ? null
        : new Set(capabilities),
    });
  }
}
