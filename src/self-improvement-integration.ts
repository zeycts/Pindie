import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type {
  CoreSettlementFacts,
  CoreSettlementObserver,
} from "./core-integration.ts";
import {
  deriveCandidateTrialReview,
  deriveExperienceEvaluation,
  deriveStrategyDerivationTrialReview,
  formatCandidateTrialReview,
  formatExperienceReport,
  formatStrategyDerivationTrialReview,
} from "./experience-evaluation.ts";
import type {
  RunExperienceReader,
  RunExperienceStore,
} from "./experience-store.ts";
import {
  AdaptationRuntime,
  buildAdaptationPacket,
} from "./strategy-adaptation.ts";
import {
  GlobalDerivationRuntime,
  PINDIE_STRATEGY_SYNTHESIS_CANDIDATE_CREATE_TOOL,
  type GlobalDerivationLease,
  type GlobalDerivationReservation,
  type GlobalDerivationReservationResult,
} from "./strategy-global-derivation.ts";
import {
  DerivationRuntime,
  buildDerivationPacket,
} from "./strategy-derivation.ts";
import {
  isCanonicalStrategyCandidateId,
  type StrategyCandidateReader,
  type StrategyCandidateStore,
} from "./strategy-candidates.ts";
import {
  hasExactTrustedStrategySemanticDuplicate,
  validateStrategyDerivationCandidateBinding,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateStore,
  type StrategyDerivationCandidateV1,
} from "./strategy-derivation-candidates.ts";
import type {
  StrategyTrustScopeCandidateStore,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionStore,
} from "./strategy-trust-scope-decisions.ts";
import type {
  StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import {
  buildCandidateCommandProjection,
  buildTrialCommandProjection,
  buildTrialReviewCommandProjection,
  buildUnifiedCandidateCommandProjection,
  filterCandidateCommandOptions,
  filterTrialCommandOptions,
  filterTrialReviewCommandOptions,
  type CandidateCommandName,
} from "./strategy-candidate-commands.ts";
import {
  createStrategyRevisionDecision,
  emptyPromotedStrategyRevisionCatalog,
  loadPromotedStrategyRevisionCatalog,
  validateStrategyRevisionDecisionBinding,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
  type StrategyRevisionDecisionStore,
} from "./strategy-decisions.ts";
import {
  createStrategyDerivationDecision,
  emptyPromotedDerivedStrategyCatalog,
  loadPromotedDerivedStrategyCatalog,
  validateStrategyDerivationDecisionBinding,
  validateStrategyDerivationDecisionProjectBinding,
  type StrategyDerivationDecisionReader,
  type StrategyDerivationDecisionStore,
} from "./strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  formatPromotedTrustedStrategyPortfolio,
  formatTrustedStrategyPortfolioPresentation,
  resolveTrustedPortfolioRevisionSelection,
  sameTrustedPortfolioSnapshot,
  trustedLogicalStrategyIds,
  type TrustedPortfolioGlobalLayer,
  type TrustedStrategyPortfolio,
  type TrustedStrategyPortfolioPresentation,
} from "./strategy-portfolio.ts";
import {
  loadProjectTrustedStrategyPortfolio,
  loadTrustedStrategyPortfolio,
} from "./strategy-trust-safety.ts";
import { getSeedStrategy, SEED_STRATEGIES } from "./strategies.ts";
import {
  assembleRunExperience,
  isEligibleRunExperience,
} from "./run-experience.ts";
import {
  TrialRuntime,
  type DerivationTrialLease,
  type ScopeTrialLease,
  type SynthesisTrialLease,
  type TrialLease,
} from "./strategy-trial.ts";
import type { SynthesisTrialBinding } from "./strategy-trial.ts";
import type { ScopeTrialBinding } from "./strategy-trust-scope-trial.ts";
import { resolveTrialCandidate } from "./strategy-candidate-resolution.ts";
import type {
  PolicySnapshot,
  StrategyRevisionSelection,
  StrategyRevisionSelector,
} from "./policy.ts";
import type { ToolEffect } from "./execution-semantics.ts";
import type {
  GlobalWriterLock,
} from "./store.ts";
import type { StrategySynthesisCandidateReader } from "./strategy-synthesis-candidates.ts";
import type { StrategySynthesisDecisionReader } from "./strategy-synthesis-decisions.ts";
import { createPindieStrategyCandidateTool } from "./tools/strategy-candidate.ts";
import { createPindieStrategyDerivationCandidateTool } from "./tools/strategy-derivation-candidate.ts";

type ProjectRootGetter = () => string | null;
type AgentRunGenerationGetter = () => number | null;
type StrategySynthesisDecisionCommand = "promote" | "reject";

/** Narrow Core facts and lifecycle operations consumed by Self-Improvement. */
export interface SelfImprovementCorePort {
  readonly getProjectRoot: ProjectRootGetter;
  readonly getActiveAgentRunGeneration: AgentRunGenerationGetter;
  readonly isAgentRunCurrent: (generation: number) => boolean;
}

/** The narrow shared Trial lease surface exposed to CPL. */
export interface SelfImprovementTrialAccess {
  readonly hasTrial: boolean;
  readonly hasPendingScopeTrial: boolean;
  readonly hasActiveScopeTrial: boolean;
  readonly pendingScopeTrial: ScopeTrialLease | null;
  readonly activeScopeTrial: ScopeTrialLease | null;
  readonly hasPendingSynthesisTrial: boolean;
  readonly hasActiveSynthesisTrial: boolean;
  readonly pendingSynthesisTrial: SynthesisTrialLease | null;
  readonly activeSynthesisTrial: SynthesisTrialLease | null;
  readonly establishScope: (sessionId: string, binding: ScopeTrialBinding) => boolean;
  readonly establishSynthesis: (sessionId: string, binding: SynthesisTrialBinding) => boolean;
  readonly activeScopeFor: (
    sessionId: string | null,
    agentRunGeneration: number | null,
  ) => ScopeTrialLease | null;
  readonly activeSynthesisFor: (
    sessionId: string | null,
    agentRunGeneration: number | null,
  ) => SynthesisTrialLease | null;
  readonly resolveScopeSelector: (
    sessionId: string | null,
    agentRunGeneration: number | null,
    selector: unknown,
    kind: "approach" | "modifier",
    currentSourceCandidate?: import("./strategy-derivation-candidates.ts").StrategyDerivationCandidateV1,
  ) => StrategyRevisionSelection;
  readonly resolveSynthesisSelector: (
    sessionId: string | null,
    agentRunGeneration: number | null,
    selector: unknown,
    kind: "approach" | "modifier",
    currentCandidate?: import("./strategy-trial.ts").SynthesisTrialCandidateSnapshot,
  ) => StrategyRevisionSelection;
}

/** SI learning facts and the one Trial lease CPL is allowed to use. */
export interface SelfImprovementGlobalDerivationAccess {
  readonly reserve: (
    sessionId: string,
    invocationRoot: string,
  ) => GlobalDerivationReservationResult;
  readonly isCurrent: (reservation: GlobalDerivationReservation) => boolean;
  readonly cancel: () => void;
}

export interface SelfImprovementLearningAccess {
  readonly getProjectRoot: ProjectRootGetter;
  readonly getActiveAgentRunGeneration: AgentRunGenerationGetter;
  readonly hasAdaptationAttempt: () => boolean;
  readonly hasDerivationAttempt: () => boolean;
  readonly hasGlobalDerivationAttempt: () => boolean;
  readonly globalDerivation: SelfImprovementGlobalDerivationAccess;
  readonly trial: SelfImprovementTrialAccess;
}

/** SI-owned trust readers and reconstruction operations exposed to CPL. */
export interface SelfImprovementStrategyTrustAccess {
  readonly loadTrustedPortfolio: (projectRoot: string) => Promise<TrustedStrategyPortfolio>;
  readonly loadProjectTrustedPortfolio: (projectRoot: string) => Promise<TrustedStrategyPortfolio>;
  readonly scopeCandidateStore: StrategyTrustScopeCandidateStore;
  readonly scopeDecisionStore: StrategyTrustScopeDecisionStore;
  readonly scopeSourceResolver: StrategyTrustScopeSourceResolver;
  readonly synthesisCandidateReader: StrategySynthesisCandidateReader;
  readonly synthesisDecisionReader: StrategySynthesisDecisionReader;
  readonly writerLock: GlobalWriterLock;
}

/** Startup attachment points supplied by the optional CPL integration. */
export interface CrossProjectLearningAttachment {
  readonly bindGlobalDerivationRun: (lease: GlobalDerivationLease) => {
    readonly promptContribution: string;
  };
  readonly abortGlobalDerivationRun: () => void;
  readonly abortGlobalDerivationRunForGeneration: (agentRunGeneration: number) => void;
  readonly settleGlobalDerivationRun: (agentRunGeneration: number) => void;
  readonly resetForSession: () => void;
  readonly validatePendingScopeTrial: (binding: ScopeTrialBinding) => Promise<void>;
  readonly validatePendingSynthesisTrial: (binding: SynthesisTrialBinding) => Promise<void>;
  readonly resolveScopeRevisionSelector: (
    lease: ScopeTrialLease,
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    sessionId: string,
    agentRunGeneration: number | null,
  ) => Promise<StrategyRevisionSelection>;
  readonly resolveSynthesisRevisionSelector: (
    lease: SynthesisTrialLease,
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    sessionId: string,
    agentRunGeneration: number | null,
  ) => Promise<StrategyRevisionSelection>;
  readonly handleSynthesisTrialCommand: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly synthesisTrialCommandCompletions: (
    projectRoot: string,
    prefix: string,
  ) => Promise<readonly { readonly value: string; readonly label: string }[]>;
  readonly handleSynthesisTrialReviewCommand: (
    candidateId: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly handleSynthesisDecisionCommand: (
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly synthesisReviewCommandCompletions: (
    command: "trial-review" | StrategySynthesisDecisionCommand,
    projectRoot: string,
    prefix: string,
  ) => Promise<readonly { readonly value: string; readonly label: string }[]>;
  readonly handleScopeTrialCommand: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly handleScopeTrialReviewCommand: (
    candidateId: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly handleScopeDecisionCommand: (
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly scopeCommandCompletions: (
    command: CandidateCommandName,
    projectRoot: string,
    prefix: string,
  ) => Promise<readonly { readonly value: string; readonly label: string }[]>;
  readonly handleTrustTransferCommand: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
  readonly trustTransferCommandCompletions: (
    prefix: string,
  ) => Promise<Array<{ readonly value: string; readonly label: string }> | null>;
  readonly loadPresentationPortfolio: (
    projectRoot: string,
  ) => Promise<TrustedStrategyPortfolioPresentation>;
}

/** Explicit production/test dependencies owned by the SI composition path. */
export interface SelfImprovementIntegrationOptions {
  readonly pi: ExtensionAPI;
  readonly core: SelfImprovementCorePort;
  readonly experienceStore: RunExperienceStore;
  readonly experienceReader: RunExperienceReader;
  readonly strategyCandidateStore: StrategyCandidateStore;
  readonly strategyCandidateReader: StrategyCandidateReader;
  readonly strategyDerivationCandidateStore: StrategyDerivationCandidateStore;
  readonly strategyDerivationCandidateReader: StrategyDerivationCandidateReader;
  readonly strategyDecisionStore: StrategyRevisionDecisionStore;
  readonly strategyDecisionReader: StrategyRevisionDecisionReader;
  readonly strategyDerivationDecisionStore: StrategyDerivationDecisionStore;
  readonly strategyDerivationDecisionReader: StrategyDerivationDecisionReader;
  readonly strategyTrustScopeCandidateStore: StrategyTrustScopeCandidateStore;
  readonly strategyTrustScopeDecisionStore: StrategyTrustScopeDecisionStore;
  readonly strategyTrustScopeSourceResolver: StrategyTrustScopeSourceResolver;
  readonly strategyTrustScopeWriterLock: GlobalWriterLock;
  /** Read-only Synthesis authority used by SI trust safety even with CPL off. */
  readonly strategySynthesisCandidateReader: StrategySynthesisCandidateReader;
  readonly strategySynthesisDecisionReader: StrategySynthesisDecisionReader;
  readonly now?: () => number;
}

export interface SelfImprovementRunPreparation {
  readonly adaptationLease: ReturnType<AdaptationRuntime["bind"]>;
  readonly trialLease: TrialLease | DerivationTrialLease | ScopeTrialLease | SynthesisTrialLease | null;
  readonly derivationLease: ReturnType<DerivationRuntime["bind"]>;
  readonly globalDerivationLease: GlobalDerivationLease | null;
  readonly promptContributions: readonly string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH = 256;

function optionalGlobalUnavailableReason(error: unknown): string {
  const reason = `optional user-global layer unavailable: ${errorMessage(error)}`
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return reason.length <= MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH
    ? reason
    : `${reason.slice(0, MAX_OPTIONAL_GLOBAL_DIAGNOSTIC_LENGTH - 1)}…`;
}

export class SelfImprovementIntegration {
  readonly adaptation = new AdaptationRuntime();
  readonly trial = new TrialRuntime();
  readonly derivation = new DerivationRuntime();
  readonly globalDerivation = new GlobalDerivationRuntime();

  private readonly pi: ExtensionAPI;
  private readonly core: SelfImprovementCorePort;
  private readonly experienceStore: RunExperienceStore;
  private readonly experienceReader: RunExperienceReader;
  private readonly strategyCandidateStore: StrategyCandidateStore;
  private readonly strategyCandidateReader: StrategyCandidateReader;
  private readonly strategyDerivationCandidateStore: StrategyDerivationCandidateStore;
  private readonly strategyDerivationCandidateReader: StrategyDerivationCandidateReader;
  private readonly strategyDecisionStore: StrategyRevisionDecisionStore;
  private readonly strategyDecisionReader: StrategyRevisionDecisionReader;
  private readonly strategyDerivationDecisionStore: StrategyDerivationDecisionStore;
  private readonly strategyDerivationDecisionReader: StrategyDerivationDecisionReader;
  private readonly strategyTrustScopeCandidateStore: StrategyTrustScopeCandidateStore;
  private readonly strategyTrustScopeDecisionStore: StrategyTrustScopeDecisionStore;
  private readonly strategyTrustScopeSourceResolver: StrategyTrustScopeSourceResolver;
  private readonly strategyTrustScopeWriterLock: GlobalWriterLock;
  private readonly strategySynthesisCandidateReader: StrategySynthesisCandidateReader;
  private readonly strategySynthesisDecisionReader: StrategySynthesisDecisionReader;
  private readonly now: () => number;
  private crossProjectLearning: CrossProjectLearningAttachment | null = null;
  private currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
  private currentTrustedStrategyPortfolio: TrustedStrategyPortfolio | null = null;
  private trustProjectionRunGeneration: number | null = null;
  private adaptationRunGeneration: number | null = null;
  private derivationRunGeneration: number | null = null;

  constructor(options: SelfImprovementIntegrationOptions) {
    this.pi = options.pi;
    this.core = options.core;
    this.experienceStore = options.experienceStore;
    this.experienceReader = options.experienceReader;
    this.strategyCandidateStore = options.strategyCandidateStore;
    this.strategyCandidateReader = options.strategyCandidateReader;
    this.strategyDerivationCandidateStore = options.strategyDerivationCandidateStore;
    this.strategyDerivationCandidateReader = options.strategyDerivationCandidateReader;
    this.strategyDecisionStore = options.strategyDecisionStore;
    this.strategyDecisionReader = options.strategyDecisionReader;
    this.strategyDerivationDecisionStore = options.strategyDerivationDecisionStore;
    this.strategyDerivationDecisionReader = options.strategyDerivationDecisionReader;
    this.strategyTrustScopeCandidateStore = options.strategyTrustScopeCandidateStore;
    this.strategyTrustScopeDecisionStore = options.strategyTrustScopeDecisionStore;
    this.strategyTrustScopeSourceResolver = options.strategyTrustScopeSourceResolver;
    this.strategyTrustScopeWriterLock = options.strategyTrustScopeWriterLock;
    this.strategySynthesisCandidateReader = options.strategySynthesisCandidateReader;
    this.strategySynthesisDecisionReader = options.strategySynthesisDecisionReader;
    this.now = options.now ?? Date.now;
  }

  attachCrossProjectLearning(attachment: CrossProjectLearningAttachment): void {
    if (this.crossProjectLearning !== null) {
      throw new Error("Cross-Project Learning is already attached to Self-Improvement.");
    }
    this.crossProjectLearning = attachment;
  }

  get learningAccess(): SelfImprovementLearningAccess {
    return Object.freeze({
      getProjectRoot: this.core.getProjectRoot,
      getActiveAgentRunGeneration: this.core.getActiveAgentRunGeneration,
      hasAdaptationAttempt: () => this.adaptation.hasAttempt,
      hasDerivationAttempt: () => this.derivation.hasDerivation,
      hasGlobalDerivationAttempt: () => this.globalDerivation.hasAttempt,
      globalDerivation: Object.freeze({
        reserve: (sessionId: string, invocationRoot: string): GlobalDerivationReservationResult =>
          this.reserveGlobalDerivation(sessionId, invocationRoot),
        isCurrent: (reservation: GlobalDerivationReservation): boolean =>
          this.globalDerivation.isCurrent(reservation),
        cancel: () => this.globalDerivation.clear(),
      }),
      trial: this.trial,
    });
  }

  get strategyTrustAccess(): SelfImprovementStrategyTrustAccess {
    return Object.freeze({
      loadTrustedPortfolio: (projectRoot: string) => this.loadTrustedPortfolio(projectRoot),
      loadProjectTrustedPortfolio: (projectRoot: string) => loadProjectTrustedStrategyPortfolio(projectRoot, {
        decisionReader: this.strategyDecisionReader,
        candidateReader: this.strategyCandidateReader,
        derivationDecisionReader: this.strategyDerivationDecisionReader,
        derivationCandidateReader: this.strategyDerivationCandidateReader,
      }),
      scopeCandidateStore: this.strategyTrustScopeCandidateStore,
      scopeDecisionStore: this.strategyTrustScopeDecisionStore,
      scopeSourceResolver: this.strategyTrustScopeSourceResolver,
      synthesisCandidateReader: this.strategySynthesisCandidateReader,
      synthesisDecisionReader: this.strategySynthesisDecisionReader,
      writerLock: this.strategyTrustScopeWriterLock,
    });
  }

  get promotedStrategyRevisionCatalog(): PromotedStrategyRevisionCatalog {
    return this.currentPromotedStrategyRevisionCatalog;
  }

  get trustedStrategyPortfolio(): TrustedStrategyPortfolio | null {
    return this.currentTrustedStrategyPortfolio;
  }

  get hasConflictingLearningPath(): boolean {
    return this.adaptation.hasAttempt || this.derivation.hasDerivation ||
      this.globalDerivation.hasAttempt || this.trial.hasTrial;
  }

  get isAdaptationRunActive(): boolean {
    const generation = this.core.getActiveAgentRunGeneration();
    return generation !== null && this.adaptationRunGeneration === generation;
  }

  get isDerivationRunActive(): boolean {
    const generation = this.core.getActiveAgentRunGeneration();
    return generation !== null && this.derivationRunGeneration === generation;
  }

  get isGlobalDerivationRunActive(): boolean {
    const generation = this.core.getActiveAgentRunGeneration();
    return generation !== null && this.globalDerivation.isActiveForGeneration(generation);
  }

  isSelfImprovementRunForGeneration(generation: number | null): boolean {
    return generation !== null && (
      this.adaptationRunGeneration === generation ||
      this.derivationRunGeneration === generation ||
      this.globalDerivation.isActiveForGeneration(generation)
    );
  }

  hasPacketForGeneration(generation: number): boolean {
    return this.adaptation.isActiveForGeneration(generation) ||
      this.derivation.isActiveForGeneration(generation) ||
      this.globalDerivation.isActiveForGeneration(generation);
  }

  resetForSession(): void {
    this.crossProjectLearning?.resetForSession();
    this.adaptation.clear();
    this.trial.clear();
    this.derivation.clear();
    this.globalDerivation.clear();
    this.currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
    this.currentTrustedStrategyPortfolio = null;
    this.trustProjectionRunGeneration = null;
    this.adaptationRunGeneration = null;
    this.derivationRunGeneration = null;
  }

  /**
   * Remove only runtime state that was published or bound by one failed Run
   * preparation. Pending user intent is left untouched unless the preparation
   * itself is still the current generation and its existing failure cleanup
   * owns that pending attempt.
   */
  abortAgentRunPreparation(agentRunGeneration: number): void {
    if (!this.core.isAgentRunCurrent(agentRunGeneration)) return;
    if (this.adaptation.isActiveForGeneration(agentRunGeneration)) {
      this.adaptation.clear();
      this.adaptationRunGeneration = null;
    }
    if (this.trial.isActiveForGeneration(agentRunGeneration)) this.trial.clear();
    if (this.derivation.isActiveForGeneration(agentRunGeneration)) {
      this.derivation.clear();
      this.derivationRunGeneration = null;
    }
    if (this.globalDerivation.isActiveForGeneration(agentRunGeneration)) {
      this.crossProjectLearning?.abortGlobalDerivationRunForGeneration(agentRunGeneration);
      this.globalDerivation.clear();
    }
    if (this.trustProjectionRunGeneration === agentRunGeneration) {
      this.currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
      this.currentTrustedStrategyPortfolio = null;
      this.trustProjectionRunGeneration = null;
    }
  }

  private reserveGlobalDerivation(
    sessionId: string,
    invocationRoot: string,
  ): GlobalDerivationReservationResult {
    if (this.adaptation.hasAttempt) return { allowed: false, reason: "adaptation" };
    if (this.derivation.hasDerivation) return { allowed: false, reason: "derivation" };
    if (this.trial.hasTrial) return { allowed: false, reason: "trial" };
    if (this.globalDerivation.hasAttempt) return { allowed: false, reason: "global-derivation" };
    const reservation = this.globalDerivation.reserve(sessionId, invocationRoot);
    return reservation === null
      ? { allowed: false, reason: "global-derivation" }
      : { allowed: true, reservation };
  }

  /** Abort a failed global preparation without touching Core State. */
  abortGlobalDerivationRun(): void {
    this.crossProjectLearning?.abortGlobalDerivationRun();
    this.globalDerivation.clear();
  }

  private async loadTrustedPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolio> {
    return loadTrustedStrategyPortfolio(projectRoot, {
      decisionReader: this.strategyDecisionReader,
      candidateReader: this.strategyCandidateReader,
      derivationDecisionReader: this.strategyDerivationDecisionReader,
      derivationCandidateReader: this.strategyDerivationCandidateReader,
      scopeCandidateReader: this.strategyTrustScopeCandidateStore,
      scopeDecisionReader: this.strategyTrustScopeDecisionStore,
      scopeSourceResolver: this.strategyTrustScopeSourceResolver,
      synthesisCandidateReader: this.strategySynthesisCandidateReader,
      synthesisDecisionReader: this.strategySynthesisDecisionReader,
    });
  }

  private async readDerivationDecisionForCandidate(
    projectRoot: string,
    candidate: StrategyDerivationCandidateV1,
  ) {
    const decision = await this.strategyDerivationDecisionReader.read(
      projectRoot,
      candidate.candidateId,
    );
    if (decision !== null) {
      validateStrategyDerivationDecisionProjectBinding(decision, projectRoot);
      validateStrategyDerivationDecisionBinding(decision, candidate);
    }
    return decision;
  }

  private async loadNormalTrustedPortfolio(
    projectRoot: string | null,
    includeUserGlobal = true,
  ): Promise<{
    readonly portfolio: TrustedStrategyPortfolio | null;
    readonly promotedCatalog: PromotedStrategyRevisionCatalog;
    readonly globalLayer: TrustedPortfolioGlobalLayer;
  }> {
    if (projectRoot === null) {
      return {
        portfolio: null,
        promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
        globalLayer: Object.freeze({ available: true as const }),
      };
    }

    let promotedCatalog = emptyPromotedStrategyRevisionCatalog();
    try {
      promotedCatalog = await loadPromotedStrategyRevisionCatalog(
        projectRoot,
        this.strategyDecisionReader,
        this.strategyCandidateReader,
      );
    } catch (error) {
      console.warn(
        `[Pindie] Promoted Strategy catalog unavailable; using Seed-only v0.6 availability: ${errorMessage(error)}`,
      );
    }

    let promotedDerivedCatalog = emptyPromotedDerivedStrategyCatalog();
    try {
      promotedDerivedCatalog = await loadPromotedDerivedStrategyCatalog(
        projectRoot,
        this.strategyDerivationDecisionReader,
        this.strategyDerivationCandidateReader,
        this.strategyCandidateReader,
      );
    } catch (error) {
      console.warn(
        `[Pindie] Promoted Derived Strategy catalog unavailable; using no Derived availability: ${errorMessage(error)}`,
      );
    }

    let localPortfolio: TrustedStrategyPortfolio;
    try {
      localPortfolio = createTrustedStrategyPortfolio(
        projectRoot,
        promotedCatalog,
        promotedDerivedCatalog,
      );
    } catch (error) {
      console.warn(
        `[Pindie] Trusted Strategy portfolio projection unavailable; using no Derived availability: ${errorMessage(error)}`,
      );
      localPortfolio = createTrustedStrategyPortfolio(
        projectRoot,
        promotedCatalog,
        emptyPromotedDerivedStrategyCatalog(),
      );
    }

    if (this.crossProjectLearning === null) {
      if (!includeUserGlobal) {
        return this.core.getProjectRoot() === projectRoot
          ? {
              portfolio: localPortfolio,
              promotedCatalog,
              globalLayer: Object.freeze({ available: true as const }),
            }
          : {
              portfolio: null,
              promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
              globalLayer: Object.freeze({ available: true as const }),
            };
      }
      try {
        const completePortfolio = await this.loadTrustedPortfolio(projectRoot);
        return this.core.getProjectRoot() === projectRoot
          ? {
              portfolio: completePortfolio,
              promotedCatalog,
              globalLayer: Object.freeze({ available: true as const }),
            }
          : {
              portfolio: null,
              promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
              globalLayer: Object.freeze({ available: true as const }),
            };
      } catch (error) {
        console.warn(
          `[Pindie] User-global trusted Strategy projection unavailable; using project-local trust only: ${errorMessage(error)}`,
        );
        return this.core.getProjectRoot() === projectRoot
          ? {
              portfolio: localPortfolio,
              promotedCatalog,
              globalLayer: Object.freeze({
                available: false,
                reason: optionalGlobalUnavailableReason(error),
              }),
            }
          : {
              portfolio: null,
              promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
              globalLayer: Object.freeze({
                available: false,
                reason: optionalGlobalUnavailableReason(error),
              }),
            };
      }
    }

    try {
      const presentation = await this.crossProjectLearning.loadPresentationPortfolio(projectRoot);
      return this.core.getProjectRoot() === projectRoot
        ? {
            portfolio: presentation.portfolio,
            promotedCatalog,
            globalLayer: presentation.globalLayer,
          }
        : {
            portfolio: null,
            promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
            globalLayer: presentation.globalLayer,
          };
    } catch (error) {
      console.warn(
        `[Pindie] User-global trusted Strategy projection unavailable; using project-local trust only: ${errorMessage(error)}`,
      );
      return this.core.getProjectRoot() === projectRoot
        ? {
            portfolio: localPortfolio,
            promotedCatalog,
            globalLayer: Object.freeze({
              available: false,
              reason: optionalGlobalUnavailableReason(error),
            }),
          }
        : {
            portfolio: null,
            promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
            globalLayer: Object.freeze({
              available: false,
              reason: optionalGlobalUnavailableReason(error),
            }),
          };
    }
  }

  private async loadProjectTrustedPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolio> {
    try {
      return await loadProjectTrustedStrategyPortfolio(projectRoot, {
        decisionReader: this.strategyDecisionReader,
        candidateReader: this.strategyCandidateReader,
        derivationDecisionReader: this.strategyDerivationDecisionReader,
        derivationCandidateReader: this.strategyDerivationCandidateReader,
      });
    } catch (strictError) {
      const fallback = await this.loadNormalTrustedPortfolio(projectRoot, false);
      if (fallback.portfolio !== null) return fallback.portfolio;
      throw strictError;
    }
  }

  private async loadPresentationPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolioPresentation> {
    if (this.crossProjectLearning !== null) {
      return this.crossProjectLearning.loadPresentationPortfolio(projectRoot);
    }
    const loaded = await this.loadNormalTrustedPortfolio(projectRoot, false);
    if (loaded.portfolio === null) {
      throw new Error("the current project changed while reading the trusted Strategy portfolio");
    }
    return Object.freeze({
      portfolio: loaded.portfolio,
      globalLayer: loaded.globalLayer,
    });
  }

  /** Resolve exact learned selectors; Core supplies Seed-only behavior when SI is absent. */
  async resolveRevisionSelector(
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    ctx: ExtensionContext,
  ): Promise<StrategyRevisionSelection> {
    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      throw new Error(`Candidate revision selector could not resolve the current Session: ${errorMessage(error)}`);
    }
    const activeSynthesisTrial = this.trial.activeSynthesisFor(
      sessionId,
      this.core.getActiveAgentRunGeneration(),
    );
    if (activeSynthesisTrial !== null) {
      if (this.crossProjectLearning === null) {
        throw new Error("Synthesis Candidate selector is unavailable because Cross-Project Learning is disabled.");
      }
      return this.crossProjectLearning.resolveSynthesisRevisionSelector(
        activeSynthesisTrial,
        selector,
        kind,
        sessionId,
        this.core.getActiveAgentRunGeneration(),
      );
    }

    const activeScopeTrial = this.trial.activeScopeFor(
      sessionId,
      this.core.getActiveAgentRunGeneration(),
    );
    if (activeScopeTrial !== null) {
      if (this.crossProjectLearning === null) {
        throw new Error("Scope Candidate selector is unavailable because Cross-Project Learning is disabled.");
      }
      return this.crossProjectLearning.resolveScopeRevisionSelector(
        activeScopeTrial,
        selector,
        kind,
        sessionId,
        this.core.getActiveAgentRunGeneration(),
      );
    }

    if (this.trial.activeFor(sessionId, this.core.getActiveAgentRunGeneration()) !== null) {
      return this.trial.resolveRevisionSelector(
        sessionId,
        this.core.getActiveAgentRunGeneration(),
        selector,
        kind,
      );
    }

    const activeDerivationTrial = this.trial.activeDerivationFor(
      sessionId,
      this.core.getActiveAgentRunGeneration(),
    );
    if (activeDerivationTrial !== null) {
      const projectRoot = this.core.getProjectRoot();
      if (projectRoot === null) {
        throw new Error("Derivation Candidate selector is unavailable: no current project root is loaded.");
      }
      const currentCandidateRef = await resolveTrialCandidate({
        projectRoot,
        candidateId: activeDerivationTrial.candidate.candidateId,
        revisionReader: this.strategyCandidateReader,
        derivationReader: this.strategyDerivationCandidateReader,
      });
      if (
        currentCandidateRef === null ||
        currentCandidateRef.kind !== "derivation" ||
        !isDeepStrictEqual(currentCandidateRef.candidate, activeDerivationTrial.candidate)
      ) {
        throw new Error("Derivation Candidate selector is unavailable: the immutable Candidate artifact or its cross-store binding changed after the Trial lease was activated.");
      }
      const currentCandidate = currentCandidateRef.candidate;
      const currentPortfolio = await this.loadProjectTrustedPortfolio(projectRoot);
      validateStrategyDerivationCandidateBinding(
        currentCandidate,
        projectRoot,
        currentPortfolio,
      );
      if (trustedLogicalStrategyIds(currentPortfolio).includes(currentCandidate.proposal.strategyId)) {
        throw new Error("Derivation Candidate selector is unavailable: its logical Strategy ID is trusted in the current portfolio.");
      }
      if (selector.revisionIdentity === activeDerivationTrial.candidate.candidateId) {
        return this.trial.resolveDerivationSelector(
          sessionId,
          this.core.getActiveAgentRunGeneration(),
          selector,
          kind,
          currentCandidate,
        );
      }
    }

    const portfolio = this.trustedStrategyPortfolio;
    if (portfolio === null || this.core.getProjectRoot() === null) {
      throw new Error("Candidate revision selector is unavailable without a captured trusted Strategy portfolio for this Agent Run.");
    }
    const resolved = resolveTrustedPortfolioRevisionSelection(selector, portfolio, kind);
    if (resolved === null) {
      throw new Error("Candidate revision selector is unavailable without an active Candidate Trial or a promoted revision in the current trusted project catalog, or it has the wrong role.");
    }
    return resolved;
  }

  registerTools(): void {
    this.pi.registerTool(createPindieStrategyCandidateTool({
      adaptation: this.adaptation,
      experienceReader: this.experienceReader,
      candidateStore: this.strategyCandidateStore,
      candidateReader: this.strategyCandidateReader,
      getProjectRoot: this.core.getProjectRoot,
      getAgentRunGeneration: this.core.getActiveAgentRunGeneration,
    }));
    this.pi.registerTool(createPindieStrategyDerivationCandidateTool({
      derivation: this.derivation,
      experienceReader: this.experienceReader,
      candidateStore: this.strategyDerivationCandidateStore,
      candidateReader: this.strategyDerivationCandidateReader,
      getProjectRoot: this.core.getProjectRoot,
      getAgentRunGeneration: this.core.getActiveAgentRunGeneration,
      loadPortfolio: (projectRoot) => this.loadProjectTrustedPortfolio(projectRoot),
    }));
  }

  private assertPreparationCurrent(
    ctx: ExtensionContext,
    sessionId: string | null,
    projectRoot: string | null,
    agentRunGeneration: number,
    signal?: AbortSignal,
  ): void {
    signal?.throwIfAborted();
    if (!this.core.isAgentRunCurrent(agentRunGeneration)) {
      throw new Error("Pindie Self-Improvement Run preparation became stale after Agent Run replacement.");
    }
    if (this.core.getProjectRoot() !== projectRoot) {
      throw new Error("Pindie Self-Improvement Run preparation became stale after project replacement.");
    }
    if (sessionId === null) return;
    let currentSessionId: string;
    try {
      currentSessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      throw new Error(`Pindie Self-Improvement Run preparation could not verify the current Session: ${errorMessage(error)}`);
    }
    if (currentSessionId !== sessionId) {
      throw new Error("Pindie Self-Improvement Run preparation became stale after Session replacement.");
    }
  }

  private cleanupFailedPreparation(
    agentRunGeneration: number,
    trialWasArmed: boolean,
    trialBound: boolean,
    derivationWasArmed: boolean,
    derivationBound: boolean,
    globalDerivationWasArmed: boolean,
    globalDerivationBound: boolean,
  ): void {
    // A late old preparation must not clear leases created by a newer Run.
    if (!this.core.isAgentRunCurrent(agentRunGeneration)) return;
    if (trialWasArmed || trialBound) this.trial.clear();
    if (derivationWasArmed || derivationBound) {
      this.derivation.clear();
      this.derivationRunGeneration = null;
    }
    if (globalDerivationWasArmed || globalDerivationBound) {
      this.abortGlobalDerivationRun();
    }
  }

  /** Return the exact SI read-only packet/context contribution for a Run. */
  async prepareAgentRun(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<SelfImprovementRunPreparation> {
    const agentRunGeneration = this.core.getActiveAgentRunGeneration();
    if (agentRunGeneration === null) {
      throw new Error("Pindie rejected this Agent Run: Self-Improvement preparation requires an active Agent Run generation.");
    }
    const preparationSessionId = typeof ctx.sessionManager.getSessionId === "function"
      ? ctx.sessionManager.getSessionId()
      : null;
    const preparationProjectRoot = this.core.getProjectRoot();
    this.assertPreparationCurrent(
      ctx,
      preparationSessionId,
      preparationProjectRoot,
      agentRunGeneration,
      signal,
    );
    const trialWasArmed = this.trial.hasTrial;
    const derivationWasArmed = this.derivation.hasDerivation;
    const globalDerivationWasArmed = this.globalDerivation.hasAttempt;
    let trialBound = false;
    let derivationBound = false;
    let globalDerivationBound = false;
    try {
      if (this.trial.hasActiveTrial) this.trial.clear();
      if (this.derivation.hasActiveDerivation) this.derivation.clear();
      this.derivationRunGeneration = null;

      if (this.adaptation.hasAttempt && this.trial.hasTrial) {
        this.resetForSession();
        throw new Error("Pindie rejected this Agent Run: an Adaptation Packet and Trial Packet cannot coexist.");
      }
      if (this.adaptation.hasAttempt && this.derivation.hasDerivation) {
        this.resetForSession();
        throw new Error("Pindie rejected this Agent Run: an Adaptation Packet and Derivation Packet cannot coexist.");
      }
      if (this.adaptation.hasAttempt && this.globalDerivation.hasAttempt) {
        this.resetForSession();
        throw new Error("Pindie rejected this Agent Run: an Adaptation Packet and Global Derivation Packet cannot coexist.");
      }
      if (this.trial.hasTrial && this.derivation.hasDerivation) {
        this.trial.clear();
        this.derivation.clear();
        this.derivationRunGeneration = null;
        throw new Error("Pindie rejected this Agent Run: a Trial Packet and Derivation Packet cannot coexist.");
      }
      if (this.trial.hasTrial && this.globalDerivation.hasAttempt) {
        this.resetForSession();
        throw new Error("Pindie rejected this Agent Run: a Trial Packet and Global Derivation Packet cannot coexist.");
      }
      if (this.derivation.hasDerivation && this.globalDerivation.hasAttempt) {
        this.resetForSession();
        throw new Error("Pindie rejected this Agent Run: a Derivation Packet and Global Derivation Packet cannot coexist.");
      }

      let adaptationLease = null;
      if (this.adaptation.hasAttempt) {
        try {
          this.assertPreparationCurrent(
            ctx,
            preparationSessionId,
            preparationProjectRoot,
            agentRunGeneration,
            signal,
          );
          adaptationLease = this.adaptation.bind(
            preparationSessionId!,
            agentRunGeneration,
          );
        } catch (error) {
          this.adaptation.clear();
          this.adaptationRunGeneration = null;
          throw error;
        }
        this.adaptationRunGeneration = adaptationLease?.agentRunGeneration ?? null;
        this.assertPreparationCurrent(
          ctx,
          preparationSessionId,
          preparationProjectRoot,
          agentRunGeneration,
          signal,
        );
      } else {
        this.adaptationRunGeneration = null;
      }

      let trialLease: TrialLease | DerivationTrialLease | ScopeTrialLease | SynthesisTrialLease | null = null;
      if (adaptationLease === null && this.trial.hasPendingTrial) {
        const sessionId = ctx.sessionManager.getSessionId();
        const pendingScopeTrial = this.trial.pendingScopeTrial;
        const pendingSynthesisTrial = this.trial.pendingSynthesisTrial;
        const pendingDerivationTrial = this.trial.pendingDerivationTrial;
        if (pendingScopeTrial !== null) {
          try {
            if (this.crossProjectLearning === null) {
              throw new Error("Cross-Project Learning is disabled");
            }
            await this.crossProjectLearning.validatePendingScopeTrial(pendingScopeTrial);
            this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          } catch (error) {
            if (this.core.isAgentRunCurrent(agentRunGeneration)) this.trial.clear();
            throw new Error(`Pindie rejected this Agent Run: the pending Scope Trial binding is stale or invalid: ${errorMessage(error)}`);
          }
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          trialLease = this.trial.bindScope(preparationSessionId!, agentRunGeneration);
        } else if (pendingSynthesisTrial !== null) {
          try {
            if (this.crossProjectLearning === null) {
              throw new Error("Cross-Project Learning is disabled");
            }
            await this.crossProjectLearning.validatePendingSynthesisTrial(pendingSynthesisTrial);
            this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          } catch (error) {
            if (this.core.isAgentRunCurrent(agentRunGeneration)) this.trial.clear();
            throw new Error(`Pindie rejected this Agent Run: the pending Synthesis Trial binding is stale or invalid: ${errorMessage(error)}`);
          }
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          const bound = this.trial.bindSynthesis(
            preparationSessionId!,
            agentRunGeneration,
          );
          if (bound === null) {
            if (this.core.isAgentRunCurrent(agentRunGeneration)) this.trial.clear();
            throw new Error("Pindie rejected this Agent Run: the pending Synthesis Trial could not bind to the current Session/generation.");
          }
          trialLease = bound;
        } else if (pendingDerivationTrial !== null) {
          const projectRoot = this.core.getProjectRoot();
          try {
            if (projectRoot === null) throw new Error("no current project root is loaded");
            const currentCandidateRef = await resolveTrialCandidate({
              projectRoot,
              candidateId: pendingDerivationTrial.candidate.candidateId,
              revisionReader: this.strategyCandidateReader,
              derivationReader: this.strategyDerivationCandidateReader,
            });
            this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
            if (
              currentCandidateRef === null ||
              currentCandidateRef.kind !== "derivation" ||
              !isDeepStrictEqual(currentCandidateRef.candidate, pendingDerivationTrial.candidate)
            ) {
              throw new Error("the immutable Candidate artifact or its cross-store binding changed after /trial was armed");
            }
            const currentCandidate = currentCandidateRef.candidate;
            const currentDecision = await this.readDerivationDecisionForCandidate(projectRoot, currentCandidate);
            this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
            if (currentDecision !== null) throw new Error("a terminal Derivation Decision exists for the active Trial Candidate");
            const currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
            this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
            validateStrategyDerivationCandidateBinding(currentCandidate, projectRoot, currentPortfolio);
            if (trustedLogicalStrategyIds(currentPortfolio).includes(currentCandidate.proposal.strategyId)) {
              throw new Error("the proposed logical Strategy ID is already trusted in the current portfolio");
            }
          } catch (error) {
            if (this.core.isAgentRunCurrent(agentRunGeneration)) this.trial.clear();
            throw new Error(`Pindie rejected this Agent Run: the pending Derivation Trial binding is stale or invalid: ${errorMessage(error)}`);
          }
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          trialLease = this.trial.bindDerivation(preparationSessionId!, agentRunGeneration);
        } else {
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          trialLease = this.trial.bind(preparationSessionId!, agentRunGeneration);
        }
        if (trialLease === null) {
          this.trial.clear();
        } else {
          trialBound = true;
        }
      }

      let derivationLease = null;
      if (adaptationLease === null && trialLease === null && this.derivation.hasPendingDerivation) {
        this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
        derivationLease = this.derivation.bind(preparationSessionId!, agentRunGeneration);
        if (derivationLease === null) {
          this.derivation.clear();
          this.derivationRunGeneration = null;
          throw new Error("Pindie rejected this Agent Run: the pending Derivation lease could not bind to the current Session.");
        }
        derivationBound = true;
        this.derivationRunGeneration = derivationLease.agentRunGeneration;
      }

      let globalDerivationLease: GlobalDerivationLease | null = null;
      let globalPromptContribution: string | null = null;
      if (this.globalDerivation.hasActive) {
        throw new Error("Pindie rejected this Agent Run: a previous Global Derivation Run is still active and has not settled.");
      }
      if (
        adaptationLease === null &&
        trialLease === null &&
        derivationLease === null &&
        this.globalDerivation.hasPending
      ) {
        this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
        const sessionId = preparationSessionId;
        const invocationRoot = preparationProjectRoot;
        const reservation = this.globalDerivation.pendingReservation;
        if (
          reservation === null ||
          invocationRoot === null ||
          reservation.sessionId !== sessionId ||
          reservation.invocationRoot !== invocationRoot
        ) {
          this.globalDerivation.clear();
          throw new Error("Pindie rejected this Agent Run: the pending Global Derivation reservation is stale or no longer addresses the current Session/project.");
        }
        this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
        globalDerivationLease = this.globalDerivation.bind(
          reservation,
          sessionId,
          invocationRoot,
          agentRunGeneration,
        );
        if (globalDerivationLease === null) {
          this.globalDerivation.clear();
          throw new Error("Pindie rejected this Agent Run: the pending Global Derivation reservation could not bind to the current Session/project.");
        }
        globalDerivationBound = true;
        try {
          if (this.crossProjectLearning === null) {
            throw new Error("Cross-Project Learning is disabled");
          }
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
          globalPromptContribution = this.crossProjectLearning.bindGlobalDerivationRun(
            globalDerivationLease,
          ).promptContribution;
          this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
        } catch (error) {
          this.crossProjectLearning?.abortGlobalDerivationRun();
          this.globalDerivation.clear();
          throw new Error(`Pindie rejected this Agent Run: the Global Derivation packet could not bind: ${errorMessage(error)}`);
        }
      }

      const packetLease = adaptationLease ?? trialLease ?? derivationLease;
      const synthesisTrialRun = trialLease !== null &&
        "candidateType" in trialLease &&
        trialLease.candidateType === "cross-project-synthesis";
      const restrictedRun = globalDerivationLease !== null ||
        adaptationLease !== null ||
        derivationLease !== null ||
        (packetLease !== null && !synthesisTrialRun);
      const normalTrust = await this.loadNormalTrustedPortfolio(preparationProjectRoot);
      this.assertPreparationCurrent(ctx, preparationSessionId, preparationProjectRoot, agentRunGeneration, signal);
      // Build all async-derived trust state locally, then publish it once the
      // Run/session/project identity has crossed the final commit frontier.
      this.currentPromotedStrategyRevisionCatalog = normalTrust.promotedCatalog;
      this.currentTrustedStrategyPortfolio = normalTrust.portfolio;
      this.trustProjectionRunGeneration = agentRunGeneration;
      const promotedContext = !restrictedRun
        ? formatPromotedTrustedStrategyPortfolio(normalTrust.portfolio)
        : "";
      return {
        adaptationLease,
        trialLease,
        derivationLease,
        globalDerivationLease,
        promptContributions: Object.freeze([
          ...(promotedContext === "" ? [] : [promotedContext]),
          ...(packetLease === null ? [] : [packetLease.renderedPacket]),
          ...(globalPromptContribution === null ? [] : [globalPromptContribution]),
        ]),
      };
    } catch (error) {
      this.cleanupFailedPreparation(
        agentRunGeneration,
        trialWasArmed,
        trialBound,
        derivationWasArmed,
        derivationBound,
        globalDerivationWasArmed,
        globalDerivationBound,
      );
      throw error;
    }
  }

  restrictToolCall(effect: ToolEffect, toolName?: string): string | null {
    const adaptationActive = this.isAdaptationRunActive;
    const derivationActive = this.isDerivationRunActive;
    const globalDerivationActive = this.isGlobalDerivationRunActive;
    if (globalDerivationActive) {
      if (
        toolName === PINDIE_STRATEGY_SYNTHESIS_CANDIDATE_CREATE_TOOL &&
        effect.requiredCapability === "policy.derive"
      ) return null;
      return "Pindie blocked this call: a Global Derivation Run is packet-only and permits only the exact Strategy Synthesis Candidate creation tool.";
    }
    if (!adaptationActive && !derivationActive) return null;
    if (derivationActive) {
      if (
        effect.requiredCapability === "observe.project" ||
        effect.requiredCapability === "observe.git" ||
        toolName === "pindie_strategy_derivation_candidate_create"
      ) return null;
      return "Pindie blocked this call: a Derivation Run is read-only and only permits observation or the active Derivation Candidate tool.";
    }
    if (
      effect.requiredCapability === "observe.project" ||
      effect.requiredCapability === "observe.git" ||
      toolName === "pindie_strategy_candidate_create"
    ) return null;
    return "Pindie blocked this call: an adaptation Run is read-only and only permits observation or the active Candidate tool.";
  }

  createSettlementObserver(): CoreSettlementObserver {
    let isAdaptationRun = false;
    let isDerivationRun = false;
    let isGlobalDerivationRun = false;
    let isTrialRun = false;
    return {
      begin: (settlementGeneration) => {
        isAdaptationRun = settlementGeneration !== null && this.adaptationRunGeneration === settlementGeneration;
        isDerivationRun = settlementGeneration !== null && this.derivationRunGeneration === settlementGeneration;
        isGlobalDerivationRun = settlementGeneration !== null && this.globalDerivation.isActiveForGeneration(settlementGeneration);
        isTrialRun = settlementGeneration !== null && this.trial.isActiveForGeneration(settlementGeneration);

        // Every live Self-Improvement identity mutation belongs to the exact
        // Run being settled and must happen before any awaited observer work.
        if (settlementGeneration === null) return;
        if (isGlobalDerivationRun) {
          this.crossProjectLearning?.settleGlobalDerivationRun(settlementGeneration);
          this.globalDerivation.clear();
        }
        if (this.adaptationRunGeneration === settlementGeneration) {
          this.adaptation.clear();
          this.adaptationRunGeneration = null;
        }
        if (this.derivationRunGeneration === settlementGeneration) {
          this.derivation.clear();
          this.derivationRunGeneration = null;
        }
        if (isTrialRun) this.trial.clear();
        if (this.trustProjectionRunGeneration === settlementGeneration) {
          this.currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
          this.currentTrustedStrategyPortfolio = null;
          this.trustProjectionRunGeneration = null;
        }
      },
      observe: async (facts: CoreSettlementFacts, signal?: AbortSignal) => {
        if (
          !isAdaptationRun &&
          !isDerivationRun &&
          !isGlobalDerivationRun &&
          this.experienceStore !== null &&
          facts.settlementGeneration !== null &&
          isEligibleRunExperience(
            facts.projectRoot,
            facts.snapshot,
            facts.task,
            facts.execution,
          ) &&
          facts.runStartTaskStatus !== null
        ) {
          try {
            const experience = assembleRunExperience({
              task: facts.task!,
              runStart: {
                taskStatus: facts.runStartTaskStatus,
                taskGoal: facts.runStartTaskGoal,
              },
              snapshot: facts.snapshot!,
              policy: facts.policy,
              execution: facts.execution,
              durationMs: facts.durationMs,
              cost: facts.cost,
            });
            await this.experienceStore.save(facts.projectRoot!, experience, signal);
          } catch (error) {
            console.warn(`[Pindie] Dropped Run Experience record: ${errorMessage(error)}`);
          }
        }
      },
    };
  }

  /** Register all SI commands; no Presentation integration is involved. */
  registerCommands(): void {
    this.pi.registerCommand("experience", {
      description: "Show read-only Run Experience evidence",
      handler: async (args, ctx) => this.handleExperienceCommand(args, ctx),
    });
    this.pi.registerCommand("strategies", {
      description: "Show the read-only trusted Strategy portfolio",
      getArgumentCompletions: (prefix) => this.getStrategyArgumentCompletions(prefix),
      handler: async (args, ctx) => this.handleStrategiesCommand(args, ctx),
    });
    this.pi.registerCommand("adapt", {
      description: "Start explicit Strategy Revision Candidate adaptation for a Seed Strategy",
      getArgumentCompletions: (prefix) => SEED_STRATEGIES
        .map((strategy) => strategy.id)
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => this.handleAdaptationCommand(args, ctx),
    });
    this.pi.registerCommand("derive", {
      description: "Start explicit Strategy Derivation from bounded trusted-policy Experience",
      handler: async (args, ctx) => this.handleDerivationCommand(args, ctx),
    });
    this.pi.registerCommand("trial", {
      description: "Arm one explicit Strategy Candidate Trial for the next Agent Run",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("trial", prefix),
      handler: async (args, ctx) => this.handleTrialCommand(args, ctx),
    });
    this.pi.registerCommand("trial-review", {
      description: "Show read-only evidence and Promotion Eligibility for one Candidate Trial",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("trial-review", prefix),
      handler: async (args, ctx) => {
        if (!args.trim()) {
          await this.notifyMissingCandidateCommandArgument("trial-review", ctx);
          return;
        }
        return this.handleTrialReviewCommand(args, ctx);
      },
    });
    this.pi.registerCommand("promote", {
      description: "Explicitly promote one eligible Strategy Candidate (local, scope, or synthesis)",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("promote", prefix),
      handler: async (args, ctx) => this.handleStrategyDecisionCommand("promoted", args, ctx),
    });
    this.pi.registerCommand("reject", {
      description: "Explicitly reject one Strategy Candidate (local, scope, or synthesis)",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("reject", prefix),
      handler: async (args, ctx) => this.handleStrategyDecisionCommand("rejected", args, ctx),
    });
  }

  // Unified Trial/Decision command entry points stay on SI. Scope subjects
  // are delegated to the attached CPL integration without registering a
  // second command or a generic router.

  private async handleTrialReviewCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (requestedId.startsWith("synthesis:")) {
      if (this.crossProjectLearning === null) {
        ctx.ui.notify("Pindie could not show Trial review: unknown Candidate subject namespace.", "warning");
        return;
      }
      try {
        const candidateId = requestedId.slice("synthesis:".length);
        await this.crossProjectLearning.handleSynthesisTrialReviewCommand(candidateId, ctx);
      } catch (error) {
        ctx.ui.notify(`Pindie could not show Synthesis Trial review: ${errorMessage(error)}`, "warning");
      }
      return;
    }
    if (requestedId.startsWith("scope:")) {
      if (this.crossProjectLearning === null) {
        ctx.ui.notify("Pindie could not show Trial review: unknown Candidate subject namespace.", "warning");
        return;
      }
      try {
        const candidateId = requestedId.slice("scope:".length);
        await this.crossProjectLearning.handleScopeTrialReviewCommand(candidateId, ctx);
      } catch (error) {
        ctx.ui.notify(`Pindie could not show Scope Trial review: ${errorMessage(error)}`, "warning");
      }
      return;
    }
    if (requestedId.includes(":")) {
      ctx.ui.notify("Pindie could not show Trial review: unknown Candidate subject namespace.", "warning");
      return;
    }
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trial-review <candidate-id> | /trial-review scope:<candidate-id> | /trial-review synthesis:<candidate-id>", "warning");
      return;
    }
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      ctx.ui.notify("Pindie could not show Trial review: candidate-id must be a canonical lowercase UUID-v4.", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not show Trial review: no current project root is loaded.", "warning");
      return;
    }

    let candidateRef;
    try {
      candidateRef = await resolveTrialCandidate({
        projectRoot,
        candidateId: requestedId,
        revisionReader: this.strategyCandidateReader,
        derivationReader: this.strategyDerivationCandidateReader,
      });
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Trial review: Candidate resolution failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidateRef === null) {
      ctx.ui.notify(`Pindie could not show Trial review: Candidate '${requestedId}' was not found for this project.`, "warning");
      return;
    }

    let read;
    try {
      read = await this.experienceReader.read(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Trial review: Experience reading failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (this.core.getProjectRoot() !== projectRoot) {
      ctx.ui.notify("Pindie could not show Trial review: the current project changed while reading evidence.", "warning");
      return;
    }

    if (candidateRef.kind === "revision") {
      const candidate = candidateRef.candidate;
      let priorTerminalDecision = false;
      try {
        const decision = await this.strategyDecisionReader.read(projectRoot, requestedId);
        if (decision !== null) {
          validateStrategyRevisionDecisionBinding(decision, candidate);
          priorTerminalDecision = true;
        }
      } catch (error) {
        ctx.ui.notify(`Pindie could not show Trial review: Decision read/binding failed: ${errorMessage(error)}`, "warning");
        return;
      }
      try {
        const review = deriveCandidateTrialReview(candidate, read.records, {
          currentProjectMatch: true,
          priorTerminalDecision,
        });
        ctx.ui.notify(formatCandidateTrialReview(read, review), "info");
      } catch (error) {
        ctx.ui.notify(`Pindie could not show Trial review: evidence evaluation failed: ${errorMessage(error)}`, "warning");
      }
      return;
    }

    let priorTerminalDecision = false;
    try {
      const decision = await this.strategyDerivationDecisionReader.read(projectRoot, requestedId);
      if (decision !== null) {
        validateStrategyDerivationDecisionProjectBinding(decision, projectRoot);
        validateStrategyDerivationDecisionBinding(decision, candidateRef.candidate);
        priorTerminalDecision = true;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Trial review: Derivation Decision read/binding failed: ${errorMessage(error)}`, "warning");
      return;
    }

    let currentPortfolio: TrustedStrategyPortfolio | null = null;
    try {
      currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
    } catch {
      currentPortfolio = null;
    }
    if (this.core.getProjectRoot() !== projectRoot) {
      ctx.ui.notify("Pindie could not show Trial review: the current project changed while reading trust artifacts.", "warning");
      return;
    }
    try {
      const review = await deriveStrategyDerivationTrialReview(
        candidateRef.candidate,
        read.records,
        {
          projectRoot,
          currentPortfolio,
          revisionCandidateReader: this.strategyCandidateReader,
          revisionDecisionReader: this.strategyDecisionReader,
          derivationCandidateReader: this.strategyDerivationCandidateReader,
          derivationDecisionReader: this.strategyDerivationDecisionReader,
          priorTerminalDecision,
        },
      );
      ctx.ui.notify(formatStrategyDerivationTrialReview(read, review), "info");
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Trial review: evidence evaluation failed: ${errorMessage(error)}`, "warning");
    }
  }

  private async handleExperienceCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (args.trim()) {
      ctx.ui.notify("Usage: /experience", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not show /experience: no current project root is loaded.", "warning");
      return;
    }
    try {
      const read = await this.experienceReader.read(projectRoot);
      ctx.ui.notify(formatExperienceReport(read, deriveExperienceEvaluation(read.records)), "info");
    } catch (error) {
      ctx.ui.notify(`Could not read Pindie Experience: ${errorMessage(error)}`, "warning");
    }
  }

  private async getStrategyArgumentCompletions(prefix: string): Promise<Array<{ value: string; label: string }> | null> {
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) return null;
    let presentation: Awaited<ReturnType<SelfImprovementIntegration["loadPresentationPortfolio"]>>;
    try {
      presentation = await this.loadPresentationPortfolio(projectRoot);
    } catch {
      return null;
    }
    if (this.core.getProjectRoot() !== projectRoot) return null;
    return trustedLogicalStrategyIds(presentation.portfolio)
      .filter((strategyId) => strategyId.startsWith(prefix))
      .map((strategyId) => ({ value: strategyId, label: strategyId }));
  }

  private async handleStrategiesCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const requestedId = args.trim();
    if (requestedId !== "" && /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /strategies [strategy-id]", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not show /strategies: no current project root is loaded; no complete portfolio can be shown.", "warning");
      return;
    }
    let presentation;
    try {
      presentation = await this.loadPresentationPortfolio(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not show /strategies: trusted Strategy portfolio could not be reconstructed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (this.core.getProjectRoot() !== projectRoot) {
      ctx.ui.notify("Pindie could not show /strategies: the current project changed while reading the trusted Strategy portfolio.", "warning");
      return;
    }
    if (requestedId !== "" && !trustedLogicalStrategyIds(presentation.portfolio).includes(requestedId)) {
      ctx.ui.notify(`Pindie could not show /strategies: '${requestedId}' is not a currently trusted logical Strategy ID.`, "warning");
      return;
    }
    ctx.ui.notify(
      formatTrustedStrategyPortfolioPresentation(presentation, requestedId === "" ? undefined : requestedId),
      "info",
    );
  }

  private async candidateCommandProjection(
    command: CandidateCommandName,
    projectRoot: string,
  ) {
    return buildCandidateCommandProjection({
      projectRoot,
      command,
      candidateReader: this.strategyCandidateReader,
      decisionReader: this.strategyDecisionReader,
      experienceReader: this.experienceReader,
    });
  }

  private async unifiedCandidateCommandProjection(
    command: "promote" | "reject",
    projectRoot: string,
  ) {
    let trustedPortfolio: TrustedStrategyPortfolio | null = null;
    try {
      trustedPortfolio = await this.loadProjectTrustedPortfolio(projectRoot);
    } catch {
      // Current trust is needed for Derived promotion eligibility, but not to
      // expose valid Revision commands or reject a valid hypothesis.
    }
    return buildUnifiedCandidateCommandProjection({
      projectRoot,
      command,
      candidateReader: this.strategyCandidateReader,
      derivationCandidateReader: this.strategyDerivationCandidateReader,
      decisionReader: this.strategyDecisionReader,
      derivationDecisionReader: this.strategyDerivationDecisionReader,
      experienceReader: this.experienceReader,
      trustedPortfolio,
    });
  }

  private async trialCommandCompletions(prefix: string) {
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) return null;
    try {
      const trustedPortfolio = await this.loadProjectTrustedPortfolio(projectRoot);
      const projection = await buildTrialCommandProjection({
        projectRoot,
        candidateReader: this.strategyCandidateReader,
        derivationCandidateReader: this.strategyDerivationCandidateReader,
        decisionReader: this.strategyDecisionReader,
        experienceReader: this.experienceReader,
        derivationDecisionReader: this.strategyDerivationDecisionReader,
        trustedPortfolio,
      });
      const options = filterTrialCommandOptions(projection, prefix);
      if (this.crossProjectLearning !== null) {
        try {
          options.push(...await this.crossProjectLearning.synthesisTrialCommandCompletions(projectRoot, prefix));
        } catch {
          // Synthesis completion is advisory and cannot hide local Trial options.
        }
        try {
          options.push(...await this.crossProjectLearning.scopeCommandCompletions("trial", projectRoot, prefix));
        } catch {
          // Global completion is advisory and cannot hide local Trial options.
        }
      }
      return options;
    } catch {
      return null;
    }
  }

  private async trialReviewCommandCompletions(prefix: string) {
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) return null;
    let trustedPortfolio: TrustedStrategyPortfolio | null = null;
    try {
      trustedPortfolio = await this.loadProjectTrustedPortfolio(projectRoot);
    } catch {
      // A stale or malformed portfolio must not hide historical review options.
    }
    try {
      const projection = await buildTrialReviewCommandProjection({
        projectRoot,
        candidateReader: this.strategyCandidateReader,
        derivationCandidateReader: this.strategyDerivationCandidateReader,
        decisionReader: this.strategyDecisionReader,
        experienceReader: this.experienceReader,
        derivationDecisionReader: this.strategyDerivationDecisionReader,
        trustedPortfolio,
      });
      const options = filterTrialReviewCommandOptions(projection, prefix);
      if (this.crossProjectLearning !== null) {
        try {
          options.push(...await this.crossProjectLearning.synthesisReviewCommandCompletions("trial-review", projectRoot, prefix));
        } catch {
          // Synthesis completion is advisory and cannot hide local review options.
        }
        try {
          options.push(...await this.crossProjectLearning.scopeCommandCompletions("trial-review", projectRoot, prefix));
        } catch {
          // Transfer completion is advisory and cannot hide local review options.
        }
      }
      return options;
    } catch {
      return null;
    }
  }

  private async candidateCommandCompletions(
    command: CandidateCommandName,
    prefix: string,
  ) {
    if (command === "trial") return this.trialCommandCompletions(prefix);
    if (command === "trial-review") return this.trialReviewCommandCompletions(prefix);
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) return null;
    try {
      const projection = await this.unifiedCandidateCommandProjection(command, projectRoot);
      const options = [...projection.options];
      if (this.crossProjectLearning !== null) {
        try {
          options.push(...await this.crossProjectLearning.synthesisReviewCommandCompletions(command, projectRoot, prefix));
        } catch {
          // Synthesis completion is advisory; dispatch repeats all authority checks.
        }
        try {
          options.push(...await this.crossProjectLearning.scopeCommandCompletions(command, projectRoot, prefix));
        } catch {
          // Transfer completion is advisory; dispatch repeats all authority checks.
        }
      }
      return options.filter((option) => option.value.startsWith(prefix));
    } catch {
      return null;
    }
  }

  private async notifyMissingCandidateCommandArgument(
    command: CandidateCommandName,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const projectRoot = this.core.getProjectRoot();
    const commandText = `/${command}`;
    if (projectRoot === null) {
      ctx.ui.notify(`Pindie could not run ${commandText}: no current project root is loaded.`, "warning");
      return;
    }
    try {
      const options = command === "trial"
        ? await this.trialCommandCompletions("")
        : command === "trial-review"
          ? await this.trialReviewCommandCompletions("")
          : await this.candidateCommandCompletions(command, "");
      if (options !== null && options.length === 0) {
        const message = command === "trial"
          ? "No Candidates are currently available for Trial."
          : command === "trial-review"
            ? "No Candidates are currently available for Trial review."
            : command === "promote"
              ? "No Candidates are currently eligible for Promotion."
              : "No Candidates are currently available for Rejection.";
        ctx.ui.notify(message, "info");
        return;
      }
    } catch {
      // A failed read cannot prove that the project has no Candidates.
    }
    ctx.ui.notify("No Candidate selected. Use command completion to choose one.", "warning");
  }

  async prepareTrustedLearningPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolio> {
    return this.loadTrustedPortfolio(projectRoot);
  }

  /** Read-only eligibility shared by explicit adaptation and the post-Run Gate. */
  async prepareAdaptationEvidence(projectRoot: string, targetId: string) {
    const target = getSeedStrategy(targetId);
    if (target === null) throw new Error("Target is not an immutable Seed Strategy.");
    const read = await this.experienceReader.read(projectRoot);
    const packet = buildAdaptationPacket(target, read.records);
    if (packet.evidence.eligibleRunCount < 2) {
      throw new Error(`only ${packet.evidence.eligibleRunCount} eligible attributable Run${packet.evidence.eligibleRunCount === 1 ? " is" : "s are"} available; at least 2 are required`);
    }
    return { target, packet };
  }

  /** Read-only eligibility shared by explicit derivation and the post-Run Gate. */
  async prepareDerivationEvidence(projectRoot: string) {
    const portfolio = await this.loadProjectTrustedPortfolio(projectRoot);
    const read = await this.experienceReader.read(projectRoot);
    const packet = buildDerivationPacket(projectRoot, portfolio, read.records);
    return { portfolio, packet };
  }

  async admitAutonomousLearning(
    intent: "revise-existing" | "derive-local",
    targetId: string | undefined,
    ctx: ExtensionContext,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    if (intent === "revise-existing") {
      await this.handleAdaptationCommand(targetId ?? "", ctx, "autonomous-signal", isCurrent);
      return this.adaptation.hasAttempt;
    }
    await this.handleDerivationCommand("", ctx, "autonomous-signal", isCurrent);
    return this.derivation.hasDerivation;
  }

  private async handleAdaptationCommand(
    args: string,
    ctx: ExtensionContext,
    origin: "human-command" | "autonomous-signal" = "human-command",
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const requestedId = args.trim();
    if (!requestedId || /\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /adapt <strategy-id>", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not start /adapt: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not start /adapt: the Agent is busy.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /adapt: another adaptation attempt is already active.", "warning");
      return;
    }
    if (this.trial.hasTrial) {
      ctx.ui.notify("Pindie could not start /adapt: a Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not start /adapt: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /adapt: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }
    const target = getSeedStrategy(requestedId);
    if (target === null) {
      ctx.ui.notify(`Pindie could not start /adapt: '${requestedId}' is not a valid Seed Strategy ID.`, "warning");
      return;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: ${errorMessage(error)}`, "warning");
      return;
    }
    let packet;
    try {
      ({ packet } = await this.prepareAdaptationEvidence(projectRoot, target.id));
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: evidence preparation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (!isCurrent() || this.core.getProjectRoot() !== projectRoot || ctx.sessionManager.getSessionId() !== sessionId) {
      ctx.ui.notify("Pindie could not start /adapt: the current Session or project changed while reading Experience.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not start /adapt: the Agent became busy while reading Experience.", "warning");
      return;
    }
    if (this.trial.hasTrial) {
      ctx.ui.notify("Pindie could not start /adapt: a Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not start /adapt: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /adapt: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (!isCurrent() || !this.adaptation.establish(sessionId, target, packet)) {
      ctx.ui.notify("Pindie could not start /adapt: another adaptation attempt is already active.", "warning");
      return;
    }
    try {
      this.pi.sendUserMessage(
        `Begin the ${origin === "human-command" ? "explicitly requested" : "autonomously admitted"} Self-Improvement adaptation for Seed Strategy '${target.id}'. Use the bounded Adaptation Packet supplied for this Run. This is optional hypothesis generation, not project implementation work.`,
      );
    } catch (error) {
      this.adaptation.clear();
      this.adaptationRunGeneration = null;
      ctx.ui.notify(`Pindie could not launch the /adapt Agent Run: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(
      `Self-Improvement adaptation Run started for '${target.id}' with ${packet.evidence.eligibleRunCount} eligible attributable Runs. Candidate generation is optional.`,
      "info",
    );
  }

  private async handleStrategyDecisionCommand(
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    const commandName: CandidateCommandName = terminalDecision === "promoted" ? "promote" : "reject";
    const command = terminalDecision === "promoted" ? "/promote" : "/reject";
    const verb = terminalDecision === "promoted" ? "promote" : "reject";
    const failure = (message: string): void => {
      ctx.ui.notify(`Pindie could not ${verb} Candidate: ${message}`, "warning");
    };
    if (!requestedId) {
      await this.notifyMissingCandidateCommandArgument(commandName, ctx);
      return;
    }
    if (/\s/.test(requestedId)) {
      ctx.ui.notify(`Usage: ${command} <candidate-id> | ${command} scope:<candidate-id> | ${command} synthesis:<candidate-id>`, "warning");
      return;
    }
    if (requestedId.startsWith("synthesis:")) {
      if (this.crossProjectLearning === null) {
        failure("unknown Candidate subject namespace.");
        return;
      }
      await this.crossProjectLearning.handleSynthesisDecisionCommand(terminalDecision, requestedId, ctx);
      return;
    }
    if (requestedId.startsWith("scope:")) {
      if (this.crossProjectLearning === null) {
        failure("unknown Candidate subject namespace.");
        return;
      }
      await this.crossProjectLearning.handleScopeDecisionCommand(terminalDecision, requestedId, ctx);
      return;
    }
    if (requestedId.includes(":")) {
      failure("unknown Candidate subject namespace.");
      return;
    }
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      failure("candidate-id must be a canonical lowercase UUID-v4.");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      failure("no current project root is loaded.");
      return;
    }
    if (!ctx.isIdle()) {
      failure("the Agent is busy.");
      return;
    }

    let candidateRef;
    try {
      candidateRef = await resolveTrialCandidate({
        projectRoot,
        candidateId: requestedId,
        revisionReader: this.strategyCandidateReader,
        derivationReader: this.strategyDerivationCandidateReader,
      });
    } catch (error) {
      failure(`Candidate resolution failed: ${errorMessage(error)}`);
      return;
    }
    if (candidateRef === null) {
      failure(`Candidate '${requestedId}' was not found for this project.`);
      return;
    }

    if (candidateRef.kind === "revision") {
      const candidate = candidateRef.candidate;
      let existingDecision;
      try {
        existingDecision = await this.strategyDecisionReader.read(projectRoot, requestedId);
      } catch (error) {
        failure(`Decision read failed; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      if (existingDecision !== null) {
        try {
          validateStrategyRevisionDecisionBinding(existingDecision, candidate);
        } catch (error) {
          failure(`existing Decision binding is invalid; no trust transition occurred: ${errorMessage(error)}`);
          return;
        }
        failure("an immutable terminal Decision already exists; duplicate or conflicting Decisions are rejected.");
        return;
      }

      let read;
      try {
        read = await this.experienceReader.read(projectRoot);
      } catch (error) {
        failure(`Experience reading failed; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
        failure("the current project or Agent state changed while reading evidence; no trust transition occurred.");
        return;
      }

      let review;
      try {
        review = deriveCandidateTrialReview(candidate, read.records, {
          currentProjectMatch: true,
          priorTerminalDecision: false,
        });
      } catch (error) {
        failure(`evidence evaluation failed; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }

      let promotedCatalog: PromotedStrategyRevisionCatalog;
      try {
        promotedCatalog = await loadPromotedStrategyRevisionCatalog(
          projectRoot,
          this.strategyDecisionReader,
          this.strategyCandidateReader,
        );
      } catch (error) {
        failure(`trust Decision storage could not be validated; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
        failure("the current project or Agent state changed while validating trust; no trust transition occurred.");
        return;
      }
      if (terminalDecision === "promoted" && promotedCatalog.entries.some((entry) =>
        entry.candidate.target.strategyId === candidate.target.strategyId &&
        entry.candidate.target.kind === candidate.target.kind &&
        entry.candidate.target.baseFingerprint === candidate.target.baseFingerprint
      )) {
        ctx.ui.notify(
          `Pindie could not promote Candidate '${requestedId}': this Seed Strategy already has one promoted Candidate revision in this project.`,
          "warning",
        );
        return;
      }
      if (terminalDecision === "promoted" && !review.promotionEligibility.eligible) {
        const reasons = review.promotionEligibility.reasons.length > 0
          ? ` Reasons: ${review.promotionEligibility.reasons.join("; ")}.`
          : "";
        failure(`the exact Promotion Eligibility gate is not satisfied.${reasons}`);
        return;
      }

      let decision;
      try {
        decision = createStrategyRevisionDecision({
          candidate,
          decision: terminalDecision,
          trialRecordIds: review.candidateProfile.sourceRecordIds,
          decidedAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        failure(`Decision construction failed; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      try {
        await this.strategyDecisionStore.save(projectRoot, decision);
      } catch (error) {
        failure(`Decision was not persisted; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      ctx.ui.notify(
        terminalDecision === "promoted"
          ? `Candidate '${requestedId}' promoted for explicit normal Policy selection. The Seed remains selectable and the promoted revision is not a default.`
          : `Candidate '${requestedId}' rejected as a historical hypothesis. Its immutable Decision preserves ${decision.evidence.trialRecordIds.length} eligible Trial Experience ID${decision.evidence.trialRecordIds.length === 1 ? "" : "s"}.`,
        "info",
      );
      return;
    }

    const candidate = candidateRef.candidate;
    let existingDecision;
    try {
      existingDecision = await this.readDerivationDecisionForCandidate(projectRoot, candidate);
    } catch (error) {
      failure(`Derivation Decision read/binding failed; no trust transition occurred: ${errorMessage(error)}`);
      return;
    }
    if (existingDecision !== null) {
      failure("an immutable terminal Derivation Decision already exists; duplicate or conflicting Decisions are rejected.");
      return;
    }

    let read;
    try {
      read = await this.experienceReader.read(projectRoot);
    } catch (error) {
      failure(`Experience reading failed; no trust transition occurred: ${errorMessage(error)}`);
      return;
    }
    if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
      failure("the current project or Agent state changed while reading evidence; no trust transition occurred.");
      return;
    }

    let currentPortfolio: TrustedStrategyPortfolio | null = null;
    try {
      currentPortfolio = terminalDecision === "promoted"
        ? await this.loadTrustedPortfolio(projectRoot)
        : await this.loadProjectTrustedPortfolio(projectRoot);
    } catch (error) {
      if (terminalDecision === "promoted") {
        failure(`trusted Strategy portfolio could not be validated; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
    }
    if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
      failure("the current project or Agent state changed while validating trust; no trust transition occurred.");
      return;
    }

    let review;
    try {
      review = await deriveStrategyDerivationTrialReview(candidate, read.records, {
        projectRoot,
        currentPortfolio,
        revisionCandidateReader: this.strategyCandidateReader,
        revisionDecisionReader: this.strategyDecisionReader,
        derivationCandidateReader: this.strategyDerivationCandidateReader,
        derivationDecisionReader: this.strategyDerivationDecisionReader,
        priorTerminalDecision: false,
      });
    } catch (error) {
      failure(`evidence evaluation failed; no trust transition occurred: ${errorMessage(error)}`);
      return;
    }

    if (terminalDecision === "promoted" && !review.promotionEligibility.eligible) {
      const reasons = review.promotionEligibility.reasons.length > 0
        ? ` Reasons: ${review.promotionEligibility.reasons.join("; ")}.`
        : "";
      failure(`the exact Derivation Promotion Eligibility gate is not satisfied.${reasons}`);
      return;
    }

    const trialRecordIds = review.candidateTrialEvidence.eligibleEvaluations
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.source.recordedAt);
        const rightTime = Date.parse(right.source.recordedAt);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        if (left.source.recordedAt !== right.source.recordedAt) {
          return left.source.recordedAt < right.source.recordedAt ? -1 : 1;
        }
        return left.source.recordId < right.source.recordId ? -1 : left.source.recordId > right.source.recordId ? 1 : 0;
      })
      .slice(0, 1024)
      .map((evaluation) => evaluation.source.recordId);

    if (terminalDecision === "promoted") {
      let decision: Awaited<ReturnType<typeof createStrategyDerivationDecision>>;
      try {
        decision = await this.strategyTrustScopeWriterLock.withLock(async () => {
          if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
            throw new Error("the current project or Agent state changed before the lock-held trust revalidation");
          }

          const latestCandidateRef = await resolveTrialCandidate({
            projectRoot,
            candidateId: requestedId,
            revisionReader: this.strategyCandidateReader,
            derivationReader: this.strategyDerivationCandidateReader,
          });
          if (latestCandidateRef === null || latestCandidateRef.kind !== "derivation") {
            throw new Error("the exact Derivation Candidate is unavailable or changed before the Decision write");
          }
          const latestCandidate = latestCandidateRef.candidate;
          if (!isDeepStrictEqual(latestCandidate, candidate)) {
            throw new Error("the exact Derivation Candidate changed while reviewing");
          }

          const terminal = await this.readDerivationDecisionForCandidate(projectRoot, latestCandidate);
          if (terminal !== null) {
            throw new Error("an immutable terminal Derivation Decision already exists; no replacement Decision was written");
          }
          const latestPortfolio = await this.loadTrustedPortfolio(projectRoot);
          if (!sameTrustedPortfolioSnapshot(latestPortfolio, currentPortfolio!)) {
            throw new Error("the trusted Strategy portfolio changed while reviewing the Candidate");
          }
          validateStrategyDerivationCandidateBinding(latestCandidate, projectRoot, latestPortfolio);
          if (trustedLogicalStrategyIds(latestPortfolio).includes(latestCandidate.proposal.strategyId)) {
            throw new Error("the proposed logical Strategy ID is already trusted in the current portfolio");
          }
          if (hasExactTrustedStrategySemanticDuplicate(latestCandidate.proposal, latestPortfolio)) {
            throw new Error("the proposal is an exact semantic duplicate of a trusted Strategy");
          }
          if (!review.promotionEligibility.eligible) {
            throw new Error("the exact Derivation Promotion Eligibility gate is no longer satisfied");
          }
          if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
            throw new Error("the current project or Agent state changed before the Decision write");
          }

          const promotedDecision = createStrategyDerivationDecision({
            candidate: latestCandidate,
            decision: "promoted",
            trialRecordIds,
            decidedAt: new Date(this.now()).toISOString(),
          });
          await this.strategyDerivationDecisionStore.save(projectRoot, promotedDecision);
          return promotedDecision;
        });
      } catch (error) {
        failure(`Derived trust revalidation or Decision write failed; no trust transition occurred: ${errorMessage(error)}`);
        return;
      }
      ctx.ui.notify(
        `Candidate '${requestedId}' promoted for explicit normal Policy selection. The Derived Strategy is selectable but is not a default.`,
        "info",
      );
      return;
    }

    let decision;
    try {
      decision = createStrategyDerivationDecision({
        candidate,
        decision: terminalDecision,
        trialRecordIds,
        decidedAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      failure(`Derivation Decision construction failed; no trust transition occurred: ${errorMessage(error)}`);
      return;
    }
    try {
      await this.strategyDerivationDecisionStore.save(projectRoot, decision);
    } catch (error) {
      failure(`Derivation Decision was not persisted; no trust transition occurred: ${errorMessage(error)}`);
      return;
    }
    ctx.ui.notify(
      `Candidate '${requestedId}' rejected as a historical hypothesis. Its immutable Derivation Decision preserves ${decision.evidence.trialRecordIds.length} eligible Trial Experience ID${decision.evidence.trialRecordIds.length === 1 ? "" : "s"}.`,
      "info",
    );
  }

  private async handleTrialCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (!requestedId) {
      await this.notifyMissingCandidateCommandArgument("trial", ctx);
      return;
    }
    if (/\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trial <candidate-id> | /trial scope:<candidate-id> | /trial synthesis:<candidate-id>", "warning");
      return;
    }
    if (requestedId.startsWith("synthesis:")) {
      if (this.crossProjectLearning === null) {
        ctx.ui.notify("Pindie could not arm /trial: unknown Candidate subject namespace.", "warning");
        return;
      }
      await this.crossProjectLearning.handleSynthesisTrialCommand(requestedId, ctx);
      return;
    }
    if (requestedId.startsWith("scope:")) {
      if (this.crossProjectLearning === null) {
        ctx.ui.notify("Pindie could not arm /trial: unknown Candidate subject namespace.", "warning");
        return;
      }
      await this.crossProjectLearning.handleScopeTrialCommand(requestedId, ctx);
      return;
    }
    if (requestedId.includes(":")) {
      ctx.ui.notify("Pindie could not arm /trial: unknown Candidate subject namespace.", "warning");
      return;
    }
    if (!isCanonicalStrategyCandidateId(requestedId)) {
      ctx.ui.notify("Pindie could not arm /trial: candidate-id must be a canonical lowercase UUID-v4.", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not arm /trial: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not arm /trial: the Agent is busy.", "warning");
      return;
    }
    if (this.trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    if (this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not arm /trial: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    let candidateRef;
    try {
      candidateRef = await resolveTrialCandidate({
        projectRoot,
        candidateId: requestedId,
        revisionReader: this.strategyCandidateReader,
        derivationReader: this.strategyDerivationCandidateReader,
      });
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: invalid Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidateRef === null) {
      ctx.ui.notify(`Pindie could not arm /trial: Candidate '${requestedId}' was not found for this project.`, "warning");
      return;
    }

    if (candidateRef.kind === "revision") {
      try {
        const existingDecision = await this.strategyDecisionReader.read(projectRoot, requestedId);
        if (existingDecision !== null) {
          validateStrategyRevisionDecisionBinding(existingDecision, candidateRef.candidate);
          ctx.ui.notify("Pindie could not arm /trial: an immutable terminal Decision already exists for this Candidate.", "warning");
          return;
        }
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial: Decision read failed: ${errorMessage(error)}`, "warning");
        return;
      }
    } else {
      try {
        const existingDecision = await this.readDerivationDecisionForCandidate(projectRoot, candidateRef.candidate);
        if (existingDecision !== null) throw new Error("an immutable terminal Derivation Decision already exists for this Candidate");
        const portfolio = await this.loadProjectTrustedPortfolio(projectRoot);
        validateStrategyDerivationCandidateBinding(candidateRef.candidate, projectRoot, portfolio);
        if (trustedLogicalStrategyIds(portfolio).includes(candidateRef.candidate.proposal.strategyId)) {
          throw new Error("the proposed logical Strategy ID is already trusted in the current portfolio");
        }
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial: Derivation Candidate binding is stale or invalid: ${errorMessage(error)}`, "warning");
        return;
      }
    }

    if (
      ctx.sessionManager.getSessionId() !== sessionId ||
      this.core.getProjectRoot() !== projectRoot ||
      !ctx.isIdle()
    ) {
      ctx.ui.notify("Pindie could not arm /trial: the current Session, project, or Agent state changed while reading the Candidate.", "warning");
      return;
    }
    if (this.trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    if (this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not arm /trial: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not arm /trial: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (candidateRef.kind === "derivation") {
      try {
        const latestCandidateRef = await resolveTrialCandidate({
          projectRoot,
          candidateId: requestedId,
          revisionReader: this.strategyCandidateReader,
          derivationReader: this.strategyDerivationCandidateReader,
        });
        if (
          latestCandidateRef === null ||
          latestCandidateRef.kind !== "derivation" ||
          !isDeepStrictEqual(latestCandidateRef.candidate, candidateRef.candidate)
        ) {
          throw new Error("the immutable Candidate artifact or its cross-store binding changed before arming");
        }
        candidateRef = latestCandidateRef;
        const latestDecision = await this.readDerivationDecisionForCandidate(projectRoot, candidateRef.candidate);
        if (latestDecision !== null) throw new Error("an immutable terminal Derivation Decision was recorded before arming");
        const portfolio = await this.loadProjectTrustedPortfolio(projectRoot);
        validateStrategyDerivationCandidateBinding(candidateRef.candidate, projectRoot, portfolio);
        if (trustedLogicalStrategyIds(portfolio).includes(candidateRef.candidate.proposal.strategyId)) {
          throw new Error("the proposed logical Strategy ID is already trusted in the current portfolio");
        }
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial: Derivation Candidate binding changed before arming: ${errorMessage(error)}`, "warning");
        return;
      }
    }
    try {
      const established = candidateRef.kind === "revision"
        ? this.trial.establish(sessionId, candidateRef.candidate)
        : this.trial.establishDerivation(sessionId, candidateRef.candidate);
      if (!established) {
        ctx.ui.notify("Pindie could not arm /trial: another Candidate Trial is already pending or active.", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial: invalid Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(`Trial armed for the next Agent Run (Candidate ${candidateRef.candidate.candidateId}).`, "info");
  }

  private async handleDerivationCommand(
    args: string,
    ctx: ExtensionContext,
    origin: "human-command" | "autonomous-signal" = "human-command",
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (args.trim() !== "") {
      ctx.ui.notify("Usage: /derive", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not start /derive: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not start /derive: the Agent is busy.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /derive: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    if (this.trial.hasTrial) {
      ctx.ui.notify("Pindie could not start /derive: a Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not start /derive: another derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /derive: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: ${errorMessage(error)}`, "warning");
      return;
    }

    let prepared;
    try {
      prepared = await this.prepareDerivationEvidence(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: evidence preparation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    const { portfolio, packet } = prepared;

    let currentSessionId: string;
    try {
      currentSessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: ${errorMessage(error)}`, "warning");
      return;
    }
    if (
      currentSessionId !== sessionId ||
      this.core.getProjectRoot() !== projectRoot ||
      !ctx.isIdle() || !isCurrent()
    ) {
      ctx.ui.notify("Pindie could not start /derive: the current Session, project, or Agent state changed while reading evidence.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt || this.trial.hasTrial || this.derivation.hasDerivation || this.globalDerivation.hasAttempt) {
      ctx.ui.notify("Pindie could not start /derive: another Self-Improvement attempt became active while reading evidence.", "warning");
      return;
    }
    if (!isCurrent() || !this.derivation.establish(sessionId, portfolio, packet)) {
      ctx.ui.notify("Pindie could not start /derive: another derivation attempt is already pending or active.", "warning");
      return;
    }
    try {
      this.pi.sendUserMessage(
        `Begin the ${origin === "human-command" ? "explicitly requested" : "autonomously admitted"} Self-Improvement Strategy Derivation. Use the bounded Derivation Packet supplied for this Run. This is optional missing-abstraction hypothesis generation, not project implementation work.`,
      );
    } catch (error) {
      this.derivation.clear();
      this.derivationRunGeneration = null;
      ctx.ui.notify(`Pindie could not launch the /derive Agent Run: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(
      `Self-Improvement derivation Run started with ${packet.evidence.eligibleRunCount} eligible trusted-policy source Runs. Candidate creation is optional.`,
      "info",
    );
  }
}
