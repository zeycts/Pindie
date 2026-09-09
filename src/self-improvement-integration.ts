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
  RunExperienceProjectReader,
  RunExperienceReader,
  RunExperienceStore,
} from "./experience-store.ts";
import {
  AdaptationRuntime,
  buildAdaptationPacket,
} from "./strategy-adaptation.ts";
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
  StrategyTrustScopeCandidateReader,
  StrategyTrustScopeCandidateStore,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionReader,
  StrategyTrustScopeDecisionStore,
} from "./strategy-trust-scope-decisions.ts";
import {
  createStrategyTrustScopeCandidateForProject,
  createStrategyTrustScopeDecisionForHuman,
  filterTrustTransferCommandOptions,
  listTransferableDerivedStrategies,
  type StrategyTrustScopeCandidateCreationDependencies,
  type StrategyTrustScopeDecisionCreationDependencies,
} from "./strategy-trust-scope.ts";
import {
  parseScopeTrialCommandValue,
  resolveScopeTrialBinding,
  revalidateScopeTrialBinding,
  sameScopeTrialBinding,
  type ScopeTrialBinding,
} from "./strategy-trust-scope-trial.ts";
import type {
  StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import {
  buildScopeDecisionCommandProjection,
  buildScopeTrialReviewCommandProjection,
  deriveStrategyTrustScopeTrialReview,
  filterScopeDecisionCommandOptions,
  filterScopeTrialReviewCommandOptions,
  formatStrategyTrustScopeTrialReview,
  parseScopeTrialReviewCommandValue,
  type ScopeProjectTrustReader,
} from "./strategy-trust-scope-review.ts";
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
  loadTrustedStrategyPortfolio,
  resolveTrustedPortfolioRevisionSelection,
  sameTrustedPortfolioSnapshot,
  trustedLogicalStrategyIds,
  type TrustedPortfolioGlobalLayer,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import { getSeedStrategy, SEED_STRATEGIES } from "./strategies.ts";
import {
  assembleRunExperience,
  isEligibleRunExperience,
} from "./run-experience.ts";
import {
  TrialRuntime,
  type DerivationTrialLease,
  type ScopeTrialLease,
  type TrialLease,
} from "./strategy-trial.ts";
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
import { createPindieStrategyCandidateTool } from "./tools/strategy-candidate.ts";
import { createPindieStrategyDerivationCandidateTool } from "./tools/strategy-derivation-candidate.ts";

type ProjectRootGetter = () => string | null;
type AgentRunGenerationGetter = () => number | null;

/** Narrow Core facts and lifecycle operations consumed by Self-Improvement. */
export interface SelfImprovementCorePort {
  readonly getProjectRoot: ProjectRootGetter;
  readonly getActiveAgentRunGeneration: AgentRunGenerationGetter;
  readonly isAgentRunCurrent: (generation: number) => boolean;
}

/** Explicit production/test dependencies owned by the SI composition path. */
export interface SelfImprovementIntegrationOptions {
  readonly pi: ExtensionAPI;
  readonly core: SelfImprovementCorePort;
  readonly experienceStore: RunExperienceStore;
  readonly experienceReader: RunExperienceReader;
  readonly crossProjectExperienceReader?: RunExperienceProjectReader;
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
  readonly scopeProjectTrustReader: ScopeProjectTrustReader;
  readonly now?: () => number;
}

export interface SelfImprovementRunPreparation {
  readonly adaptationLease: ReturnType<AdaptationRuntime["bind"]>;
  readonly trialLease: TrialLease | DerivationTrialLease | ScopeTrialLease | null;
  readonly derivationLease: ReturnType<DerivationRuntime["bind"]>;
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

  private readonly pi: ExtensionAPI;
  private readonly core: SelfImprovementCorePort;
  private readonly experienceStore: RunExperienceStore;
  private readonly experienceReader: RunExperienceReader;
  private readonly crossProjectExperienceReader: RunExperienceProjectReader | null;
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
  private readonly scopeProjectTrustReader: ScopeProjectTrustReader;
  private readonly now: () => number;
  private readonly strategyTrustScopeCandidateCreationDependencies: StrategyTrustScopeCandidateCreationDependencies;
  private currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
  private currentTrustedStrategyPortfolio: TrustedStrategyPortfolio | null = null;
  private adaptationRunGeneration: number | null = null;
  private derivationRunGeneration: number | null = null;

  constructor(options: SelfImprovementIntegrationOptions) {
    this.pi = options.pi;
    this.core = options.core;
    this.experienceStore = options.experienceStore;
    this.experienceReader = options.experienceReader;
    this.crossProjectExperienceReader = options.crossProjectExperienceReader ?? null;
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
    this.scopeProjectTrustReader = options.scopeProjectTrustReader;
    this.now = options.now ?? Date.now;
    this.strategyTrustScopeCandidateCreationDependencies = {
      candidateStore: this.strategyTrustScopeCandidateStore,
      decisionReader: this.strategyTrustScopeDecisionStore,
      sourceResolver: this.strategyTrustScopeSourceResolver,
      writerLock: this.strategyTrustScopeWriterLock,
    };
  }

  get promotedStrategyRevisionCatalog(): PromotedStrategyRevisionCatalog {
    return this.currentPromotedStrategyRevisionCatalog;
  }

  get trustedStrategyPortfolio(): TrustedStrategyPortfolio | null {
    return this.currentTrustedStrategyPortfolio;
  }

  get isAdaptationRunActive(): boolean {
    const generation = this.core.getActiveAgentRunGeneration();
    return generation !== null && this.adaptationRunGeneration === generation;
  }

  get isDerivationRunActive(): boolean {
    const generation = this.core.getActiveAgentRunGeneration();
    return generation !== null && this.derivationRunGeneration === generation;
  }

  isSelfImprovementRunForGeneration(generation: number | null): boolean {
    return generation !== null && (
      this.adaptationRunGeneration === generation ||
      this.derivationRunGeneration === generation
    );
  }

  hasPacketForGeneration(generation: number): boolean {
    return this.adaptation.isActiveForGeneration(generation) ||
      this.derivation.isActiveForGeneration(generation);
  }

  resetForSession(): void {
    this.adaptation.clear();
    this.trial.clear();
    this.derivation.clear();
    this.currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
    this.currentTrustedStrategyPortfolio = null;
    this.adaptationRunGeneration = null;
    this.derivationRunGeneration = null;
  }

  private async loadTrustedPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolio> {
    return loadTrustedStrategyPortfolio(
      projectRoot,
      this.strategyDecisionReader,
      this.strategyCandidateReader,
      this.strategyDerivationDecisionReader,
      this.strategyDerivationCandidateReader,
      this.strategyTrustScopeCandidateStore,
      this.strategyTrustScopeDecisionStore,
      this.strategyTrustScopeSourceResolver,
    );
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
      const globalLayer: TrustedPortfolioGlobalLayer = Object.freeze({
        available: false,
        reason: optionalGlobalUnavailableReason(error),
      });

      let portfolio: TrustedStrategyPortfolio;
      try {
        portfolio = createTrustedStrategyPortfolio(
          projectRoot,
          promotedCatalog,
          promotedDerivedCatalog,
        );
      } catch (fallbackError) {
        console.warn(
          `[Pindie] Trusted Strategy portfolio projection unavailable; using no Derived availability: ${errorMessage(fallbackError)}`,
        );
        promotedDerivedCatalog = emptyPromotedDerivedStrategyCatalog();
        portfolio = createTrustedStrategyPortfolio(projectRoot, promotedCatalog, promotedDerivedCatalog);
      }

      return this.core.getProjectRoot() === projectRoot
        ? { portfolio, promotedCatalog, globalLayer }
        : {
            portfolio: null,
            promotedCatalog: emptyPromotedStrategyRevisionCatalog(),
            globalLayer,
          };
    }
  }

  private async loadProjectTrustedPortfolio(projectRoot: string): Promise<TrustedStrategyPortfolio> {
    try {
      return await this.loadTrustedPortfolio(projectRoot);
    } catch (strictError) {
      const fallback = await this.loadNormalTrustedPortfolio(projectRoot);
      if (fallback.portfolio !== null) return fallback.portfolio;
      throw strictError;
    }
  }

  private async loadPresentationPortfolio(projectRoot: string): Promise<{
    readonly portfolio: TrustedStrategyPortfolio;
    readonly globalLayer: TrustedPortfolioGlobalLayer;
  }> {
    const loaded = await this.loadNormalTrustedPortfolio(projectRoot);
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
    let scopeTargetPortfolio: TrustedStrategyPortfolio | null = null;
    const activeScopeTrial = this.trial.activeScopeFor(
      sessionId,
      this.core.getActiveAgentRunGeneration(),
    );
    if (activeScopeTrial !== null) {
      const projectRoot = this.core.getProjectRoot();
      if (projectRoot === null) {
        throw new Error("Scope Candidate selector is unavailable: no current target project root is loaded.");
      }
      if (projectRoot !== activeScopeTrial.targetProjectRoot) {
        throw new Error("Scope Candidate selector is unavailable: the target project changed while the Scope Trial was active.");
      }
      const currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
      const currentBinding = await revalidateScopeTrialBinding(
        activeScopeTrial,
        currentPortfolio,
        {
          candidateReader: this.strategyTrustScopeCandidateStore,
          decisionReader: this.strategyTrustScopeDecisionStore,
          sourceResolver: this.strategyTrustScopeSourceResolver,
        },
      );
      if (!sameScopeTrialBinding(activeScopeTrial, currentBinding)) {
        throw new Error("Scope Candidate selector is unavailable: the source/global binding or target trust changed while the Scope Trial was active.");
      }
      scopeTargetPortfolio = currentPortfolio;
      if (selector.revisionIdentity === activeScopeTrial.sourceStrategy.revisionIdentity) {
        return this.trial.resolveScopeSelector(
          sessionId,
          this.core.getActiveAgentRunGeneration(),
          selector,
          kind,
          currentBinding.sourceCandidate,
        );
      }
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

    const portfolio = scopeTargetPortfolio ?? this.trustedStrategyPortfolio;
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
      getProjectRoot: this.core.getProjectRoot,
      getAgentRunGeneration: this.core.getActiveAgentRunGeneration,
    }));
    this.pi.registerTool(createPindieStrategyDerivationCandidateTool({
      derivation: this.derivation,
      experienceReader: this.experienceReader,
      candidateStore: this.strategyDerivationCandidateStore,
      getProjectRoot: this.core.getProjectRoot,
      getAgentRunGeneration: this.core.getActiveAgentRunGeneration,
      loadPortfolio: (projectRoot) => this.loadProjectTrustedPortfolio(projectRoot),
    }));
  }

  /** Return the exact SI read-only packet/context contribution for a Run. */
  async prepareAgentRun(
    ctx: ExtensionContext,
  ): Promise<SelfImprovementRunPreparation> {
    const trialWasArmed = this.trial.hasTrial;
    const derivationWasArmed = this.derivation.hasDerivation;
    let trialBound = false;
    let derivationBound = false;
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
      if (this.trial.hasTrial && this.derivation.hasDerivation) {
        this.trial.clear();
        this.derivation.clear();
        this.derivationRunGeneration = null;
        throw new Error("Pindie rejected this Agent Run: a Trial Packet and Derivation Packet cannot coexist.");
      }

      let adaptationLease = null;
      if (this.adaptation.hasAttempt) {
        try {
          adaptationLease = this.adaptation.bind(
            ctx.sessionManager.getSessionId(),
            this.core.getActiveAgentRunGeneration()!,
          );
        } catch (error) {
          this.adaptation.clear();
          this.adaptationRunGeneration = null;
          throw error;
        }
        this.adaptationRunGeneration = adaptationLease?.agentRunGeneration ?? null;
      } else {
        this.adaptationRunGeneration = null;
      }

      let trialLease: TrialLease | DerivationTrialLease | ScopeTrialLease | null = null;
      if (adaptationLease === null && this.trial.hasPendingTrial) {
        const sessionId = ctx.sessionManager.getSessionId();
        const pendingScopeTrial = this.trial.pendingScopeTrial;
        const pendingDerivationTrial = this.trial.pendingDerivationTrial;
        if (pendingScopeTrial !== null) {
          const projectRoot = this.core.getProjectRoot();
          try {
            if (projectRoot === null) throw new Error("no current project root is loaded");
            if (projectRoot !== pendingScopeTrial.targetProjectRoot) {
              throw new Error("the target project changed after the Scope Trial was armed");
            }
            const currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
            const currentBinding = await revalidateScopeTrialBinding(
              pendingScopeTrial,
              currentPortfolio,
              {
                candidateReader: this.strategyTrustScopeCandidateStore,
                decisionReader: this.strategyTrustScopeDecisionStore,
                sourceResolver: this.strategyTrustScopeSourceResolver,
              },
            );
            if (!sameScopeTrialBinding(pendingScopeTrial, currentBinding)) {
              throw new Error("the Scope Candidate, source binding, or target trust changed after /trial was armed");
            }
          } catch (error) {
            this.trial.clear();
            throw new Error(`Pindie rejected this Agent Run: the pending Scope Trial binding is stale or invalid: ${errorMessage(error)}`);
          }
          trialLease = this.trial.bindScope(sessionId, this.core.getActiveAgentRunGeneration()!);
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
            if (
              currentCandidateRef === null ||
              currentCandidateRef.kind !== "derivation" ||
              !isDeepStrictEqual(currentCandidateRef.candidate, pendingDerivationTrial.candidate)
            ) {
              throw new Error("the immutable Candidate artifact or its cross-store binding changed after /trial was armed");
            }
            const currentCandidate = currentCandidateRef.candidate;
            const currentDecision = await this.readDerivationDecisionForCandidate(projectRoot, currentCandidate);
            if (currentDecision !== null) throw new Error("a terminal Derivation Decision exists for the active Trial Candidate");
            const currentPortfolio = await this.loadTrustedPortfolio(projectRoot);
            validateStrategyDerivationCandidateBinding(currentCandidate, projectRoot, currentPortfolio);
            if (trustedLogicalStrategyIds(currentPortfolio).includes(currentCandidate.proposal.strategyId)) {
              throw new Error("the proposed logical Strategy ID is already trusted in the current portfolio");
            }
          } catch (error) {
            this.trial.clear();
            throw new Error(`Pindie rejected this Agent Run: the pending Derivation Trial binding is stale or invalid: ${errorMessage(error)}`);
          }
          trialLease = this.trial.bindDerivation(sessionId, this.core.getActiveAgentRunGeneration()!);
        } else {
          trialLease = this.trial.bind(sessionId, this.core.getActiveAgentRunGeneration()!);
        }
        if (trialLease === null) {
          this.trial.clear();
        } else {
          trialBound = true;
        }
      }

      let derivationLease = null;
      if (adaptationLease === null && trialLease === null && this.derivation.hasPendingDerivation) {
        const sessionId = ctx.sessionManager.getSessionId();
        derivationLease = this.derivation.bind(sessionId, this.core.getActiveAgentRunGeneration()!);
        if (derivationLease === null) {
          this.derivation.clear();
          this.derivationRunGeneration = null;
          throw new Error("Pindie rejected this Agent Run: the pending Derivation lease could not bind to the current Session.");
        }
        derivationBound = true;
        this.derivationRunGeneration = derivationLease.agentRunGeneration;
      }

      const packetLease = adaptationLease ?? trialLease ?? derivationLease;
      const normalTrust = await this.loadNormalTrustedPortfolio(this.core.getProjectRoot());
      this.currentPromotedStrategyRevisionCatalog = normalTrust.promotedCatalog;
      this.currentTrustedStrategyPortfolio = normalTrust.portfolio;
      const promotedContext = packetLease === null
        ? formatPromotedTrustedStrategyPortfolio(this.trustedStrategyPortfolio)
        : "";
      return {
        adaptationLease,
        trialLease,
        derivationLease,
        promptContributions: Object.freeze([
          ...(promotedContext === "" ? [] : [promotedContext]),
          ...(packetLease === null ? [] : [packetLease.renderedPacket]),
        ]),
      };
    } catch (error) {
      if (trialWasArmed || trialBound) this.trial.clear();
      if (derivationWasArmed || derivationBound) {
        this.derivation.clear();
        this.derivationRunGeneration = null;
      }
      throw error;
    }
  }

  restrictToolCall(effect: ToolEffect): string | null {
    const adaptationActive = this.isAdaptationRunActive;
    const derivationActive = this.isDerivationRunActive;
    if (!adaptationActive && !derivationActive) return null;
    const allowedCapability = derivationActive ? "policy.derive" : "policy.adapt";
    if (
      effect.requiredCapability === "observe.project" ||
      effect.requiredCapability === "observe.git" ||
      effect.requiredCapability === allowedCapability
    ) return null;
    return derivationActive
      ? "Pindie blocked this call: a Derivation Run is read-only and only permits observation or the active Derivation Candidate tool."
      : "Pindie blocked this call: an adaptation Run is read-only and only permits observation or the active Candidate tool.";
  }

  createSettlementObserver(): CoreSettlementObserver {
    let isAdaptationRun = false;
    let isDerivationRun = false;
    let isTrialRun = false;
    return {
      begin: (settlementGeneration) => {
        isAdaptationRun = settlementGeneration !== null && this.adaptationRunGeneration === settlementGeneration;
        isDerivationRun = settlementGeneration !== null && this.derivationRunGeneration === settlementGeneration;
        isTrialRun = settlementGeneration !== null && this.trial.isActiveForGeneration(settlementGeneration);
        this.adaptation.clear();
        this.derivation.clear();
        this.adaptationRunGeneration = null;
        this.derivationRunGeneration = null;
      },
      observe: async (facts: CoreSettlementFacts) => {
        if (
          !isAdaptationRun &&
          !isDerivationRun &&
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
            await this.experienceStore.save(facts.projectRoot!, experience);
          } catch (error) {
            console.warn(`[Pindie] Dropped Run Experience record: ${errorMessage(error)}`);
          }
        }
        if (isTrialRun) this.trial.clear();
        this.currentPromotedStrategyRevisionCatalog = emptyPromotedStrategyRevisionCatalog();
        this.currentTrustedStrategyPortfolio = null;
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
    this.pi.registerCommand("trust-transfer", {
      description: "Propose one project-local promoted Derived Strategy for user-global trust",
      getArgumentCompletions: (prefix) => this.trustTransferCommandCompletions(prefix),
      handler: async (args, ctx) => this.handleTrustTransferCommand(args, ctx),
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
      description: "Explicitly promote one eligible Strategy Revision Candidate",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("promote", prefix),
      handler: async (args, ctx) => this.handleStrategyDecisionCommand("promoted", args, ctx),
    });
    this.pi.registerCommand("reject", {
      description: "Explicitly reject one Strategy Revision Candidate",
      getArgumentCompletions: (prefix) => this.candidateCommandCompletions("reject", prefix),
      handler: async (args, ctx) => this.handleStrategyDecisionCommand("rejected", args, ctx),
    });
  }

  // Remaining command projections/handlers are intentionally kept on this
  // integration. They are moved here from Presentation without changing their
  // read, lease, trust, or notification semantics.

  private async handleScopeTrialReviewCommand(
    candidateId: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const candidateReader: StrategyTrustScopeCandidateReader = this.strategyTrustScopeCandidateStore;
    const decisionReader: StrategyTrustScopeDecisionReader = this.strategyTrustScopeDecisionStore;
    const sourceResolver = this.strategyTrustScopeSourceResolver;
    const experienceReader = this.crossProjectExperienceReader;
    const projectTrustReader = this.scopeProjectTrustReader;
    if (experienceReader === null) {
      ctx.ui.notify(
        "Pindie could not show Scope Trial review: the complete cross-project read-only authority projection is unavailable.",
        "warning",
      );
      return;
    }

    let candidate;
    try {
      candidate = await candidateReader.read(candidateId);
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: Candidate read failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidate === null) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: Scope Candidate '${candidateId}' was not found.`, "warning");
      return;
    }
    const currentProjectRoot = this.core.getProjectRoot();
    try {
      const review = await deriveStrategyTrustScopeTrialReview({
        candidate,
        candidateReader,
        decisionReader,
        sourceResolver,
        experienceReader,
        projectTrustReader,
        currentProjectRoot,
      });
      if (currentProjectRoot !== this.core.getProjectRoot()) {
        ctx.ui.notify(
          "Pindie could not show Scope Trial review: the current project changed while reading cross-project evidence.",
          "warning",
        );
        return;
      }
      ctx.ui.notify(formatStrategyTrustScopeTrialReview(review), "info");
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: evidence evaluation failed: ${errorMessage(error)}`, "warning");
    }
  }

  private async handleTrialReviewCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (requestedId.startsWith("scope:")) {
      try {
        const candidateId = parseScopeTrialReviewCommandValue(requestedId);
        if (candidateId === null) throw new Error("Scope review subject namespace is invalid.");
        await this.handleScopeTrialReviewCommand(candidateId, ctx);
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
      ctx.ui.notify("Usage: /trial-review <candidate-id>", "warning");
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
        scopeCandidateReader: this.strategyTrustScopeCandidateStore,
        scopeDecisionReader: this.strategyTrustScopeDecisionStore,
        scopeSourceResolver: this.strategyTrustScopeSourceResolver,
      });
      return filterTrialCommandOptions(projection, prefix);
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
      try {
        const scopeProjection = await buildScopeTrialReviewCommandProjection({
          candidateReader: this.strategyTrustScopeCandidateStore,
          decisionReader: this.strategyTrustScopeDecisionStore,
        });
        options.push(...filterScopeTrialReviewCommandOptions(scopeProjection, prefix));
      } catch {
        // Global completion is advisory and cannot hide local review options.
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
      try {
        const scopeProjection = await buildScopeDecisionCommandProjection({
          command,
          candidateReader: this.strategyTrustScopeCandidateStore,
          decisionReader: this.strategyTrustScopeDecisionStore,
          sourceResolver: this.strategyTrustScopeSourceResolver,
          experienceReader: this.crossProjectExperienceReader ?? undefined,
          projectTrustReader: this.scopeProjectTrustReader,
          currentProjectRoot: projectRoot,
        });
        options.push(...filterScopeDecisionCommandOptions(scopeProjection, prefix));
      } catch {
        // Global completion is advisory; dispatch repeats all authority checks.
      }
      return options.filter((option) => option.value.startsWith(prefix));
    } catch {
      return null;
    }
  }

  private async trustTransferCommandProjection(projectRoot: string) {
    const portfolio = await this.loadTrustedPortfolio(projectRoot);
    return listTransferableDerivedStrategies(
      projectRoot,
      portfolio,
      this.strategyTrustScopeSourceResolver,
    );
  }

  private async trustTransferCommandCompletions(prefix: string) {
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) return null;
    try {
      const projection = await this.trustTransferCommandProjection(projectRoot);
      return filterTrustTransferCommandOptions(projection, prefix);
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
          : (await this.unifiedCandidateCommandProjection(command, projectRoot)).options;
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

  private async handleTrustTransferCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (!requestedId) {
      const options = await this.trustTransferCommandCompletions("");
      if (options !== null && options.length === 0) {
        ctx.ui.notify(
          "No project-local promoted Derived Strategy is currently transferable to a user-global trust hypothesis.",
          "info",
        );
      } else {
        ctx.ui.notify(
          "No Strategy selected. Use /trust-transfer completion to choose a project-local promoted Derived Strategy.",
          "warning",
        );
      }
      return;
    }
    if (/\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trust-transfer <local-promoted-derived-strategy>", "warning");
      return;
    }
    const projectRoot = this.core.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not create a trust-transfer hypothesis: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not create a trust-transfer hypothesis: the Agent is busy.", "warning");
      return;
    }

    let projection;
    try {
      projection = await this.trustTransferCommandProjection(projectRoot);
    } catch (error) {
      ctx.ui.notify(
        `Pindie could not create a trust-transfer hypothesis: transferable Derived Strategies could not be resolved: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }
    const selected = projection.entries.find((entry) => entry.option.value === requestedId);
    if (selected === undefined) {
      ctx.ui.notify(
        `Pindie could not create a trust-transfer hypothesis: '${requestedId}' is not a currently transferable promoted Derived Strategy. Use completion to choose one exact revision.`,
        "warning",
      );
      return;
    }
    if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
      ctx.ui.notify(
        "Pindie could not create a trust-transfer hypothesis: the current project or Agent state changed while reading trust.",
        "warning",
      );
      return;
    }

    try {
      const candidate = await createStrategyTrustScopeCandidateForProject(
        {
          projectRoot,
          sourceStrategy: selected.sourceStrategy,
          createdAt: new Date(this.now()).toISOString(),
        },
        this.strategyTrustScopeCandidateCreationDependencies,
      );
      ctx.ui.notify(
        `Trust-transfer hypothesis created for '${candidate.sourceStrategy.strategyId}' (${candidate.sourceStrategy.kind}), revision ${candidate.sourceStrategy.revisionIdentity.slice(0, 8)}: project-local trusted Derived Strategy proposed for user-global trust.`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Pindie could not create a trust-transfer hypothesis: ${errorMessage(error)}`, "warning");
    }
  }

  private async handleAdaptationCommand(
    args: string,
    ctx: ExtensionCommandContext,
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
    let read;
    try {
      read = await this.experienceReader.read(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: Experience reading failed: ${errorMessage(error)}`, "warning");
      return;
    }
    let packet;
    try {
      packet = buildAdaptationPacket(target, read.records);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /adapt: evidence evaluation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (packet.evidence.eligibleRunCount < 2) {
      ctx.ui.notify(
        `Pindie could not start /adapt '${target.id}': only ${packet.evidence.eligibleRunCount} eligible attributable Run${packet.evidence.eligibleRunCount === 1 ? " is" : "s are"} available; at least 2 are required.`,
        "warning",
      );
      return;
    }
    if (this.core.getProjectRoot() !== projectRoot) {
      ctx.ui.notify("Pindie could not start /adapt: the current project changed while reading Experience.", "warning");
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
    if (!this.adaptation.establish(sessionId, target, packet)) {
      ctx.ui.notify("Pindie could not start /adapt: another adaptation attempt is already active.", "warning");
      return;
    }
    try {
      this.pi.sendUserMessage(
        `Begin the explicitly requested Self-Improvement adaptation for Seed Strategy '${target.id}'. Use the bounded Adaptation Packet supplied for this Run. This is optional hypothesis generation, not project implementation work.`,
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
      ctx.ui.notify(`Usage: ${command} <candidate-id> (or scope:<candidate-id>)`, "warning");
      return;
    }
    if (requestedId.startsWith("scope:")) {
      await this.handleScopeStrategyDecisionCommand(terminalDecision, requestedId, ctx);
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

  private async handleScopeStrategyDecisionCommand(
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedValue = args.trim();
    const verb = terminalDecision === "promoted" ? "promote" : "reject";
    const command = terminalDecision === "promoted" ? "/promote" : "/reject";
    const failure = (message: string): void => {
      ctx.ui.notify(`Pindie could not ${verb} Scope Candidate: ${message}`, "warning");
    };
    if (!requestedValue) {
      await this.notifyMissingCandidateCommandArgument(verb as CandidateCommandName, ctx);
      return;
    }
    if (/\s/.test(requestedValue)) {
      ctx.ui.notify(`Usage: ${command} scope:<candidate-id>`, "warning");
      return;
    }
    let candidateId: string | null;
    try {
      candidateId = parseScopeTrialCommandValue(requestedValue);
    } catch (error) {
      failure(errorMessage(error));
      return;
    }
    if (candidateId === null) {
      failure(requestedValue.includes(":")
        ? "unknown Candidate subject namespace."
        : "Scope Decisions require the namespaced value scope:<candidate-id>.");
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

    const dependencies: StrategyTrustScopeDecisionCreationDependencies = {
      candidateReader: this.strategyTrustScopeCandidateStore,
      decisionStore: this.strategyTrustScopeDecisionStore,
      sourceResolver: this.strategyTrustScopeSourceResolver,
      writerLock: this.strategyTrustScopeWriterLock,
      experienceReader: this.crossProjectExperienceReader ?? undefined,
      projectTrustReader: this.scopeProjectTrustReader,
    };
    try {
      const result = await createStrategyTrustScopeDecisionForHuman({
        candidateId,
        decision: terminalDecision,
        decidedAt: new Date(this.now()).toISOString(),
        currentProjectRoot: projectRoot,
      }, dependencies);
      if (terminalDecision === "promoted") {
        ctx.ui.notify(
          `Scope Candidate '${candidateId}' promoted: the exact Derived Strategy is trusted for explicit normal Policy selection as user-global trust. It is not a default or recommendation; ${result.decision.evidence.trialRefs.length} validated Trial evidence ref(s) were retained for audit provenance.`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Scope Candidate '${candidateId}' rejected: no user-global trust was granted. Rejection is a Human trust decision, not experimental falsification.`,
          "info",
        );
      }
    } catch (error) {
      failure(errorMessage(error));
    }
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
      ctx.ui.notify("Usage: /trial <candidate-id> (or scope:candidate-id)", "warning");
      return;
    }
    let scopeCandidateId: string | null = null;
    if (requestedId.startsWith("scope:")) {
      try {
        scopeCandidateId = parseScopeTrialCommandValue(requestedId);
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial: ${errorMessage(error)}`, "warning");
        return;
      }
    } else if (requestedId.includes(":")) {
      ctx.ui.notify("Pindie could not arm /trial: unknown Candidate subject namespace.", "warning");
      return;
    } else if (!isCanonicalStrategyCandidateId(requestedId)) {
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

    if (scopeCandidateId !== null) {
      const sessionId = ctx.sessionManager.getSessionId();
      let targetPortfolio: TrustedStrategyPortfolio;
      try {
        targetPortfolio = await this.loadTrustedPortfolio(projectRoot);
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: target trusted portfolio is unavailable: ${errorMessage(error)}`, "warning");
        return;
      }
      let binding: ScopeTrialBinding;
      try {
        binding = await resolveScopeTrialBinding({
          candidateId: scopeCandidateId,
          targetProjectRoot: projectRoot,
          targetPortfolio,
          candidateReader: this.strategyTrustScopeCandidateStore,
          decisionReader: this.strategyTrustScopeDecisionStore,
          sourceResolver: this.strategyTrustScopeSourceResolver,
        });
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: ${errorMessage(error)}`, "warning");
        return;
      }

      if (
        ctx.sessionManager.getSessionId() !== sessionId ||
        this.core.getProjectRoot() !== projectRoot ||
        !ctx.isIdle()
      ) {
        ctx.ui.notify("Pindie could not arm /trial Scope Candidate: the current Session, project, or Agent state changed while reading the binding.", "warning");
        return;
      }
      try {
        const latestPortfolio = await this.loadTrustedPortfolio(projectRoot);
        const latestBinding = await resolveScopeTrialBinding({
          candidateId: scopeCandidateId,
          targetProjectRoot: projectRoot,
          targetPortfolio: latestPortfolio,
          candidateReader: this.strategyTrustScopeCandidateStore,
          decisionReader: this.strategyTrustScopeDecisionStore,
          sourceResolver: this.strategyTrustScopeSourceResolver,
        });
        if (!sameScopeTrialBinding(binding, latestBinding)) {
          throw new Error("the Scope Candidate, source binding, or target trust changed before arming");
        }
        binding = latestBinding;
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: fresh binding validation failed: ${errorMessage(error)}`, "warning");
        return;
      }
      if (this.core.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
        ctx.ui.notify("Pindie could not arm /trial Scope Candidate: the current project or Agent state changed before arming.", "warning");
        return;
      }
      if (this.trial.hasTrial || this.adaptation.hasAttempt || this.derivation.hasDerivation) {
        ctx.ui.notify("Pindie could not arm /trial Scope Candidate: another Self-Improvement attempt or Candidate Trial is already pending or active.", "warning");
        return;
      }
      try {
        if (!this.trial.establishScope(sessionId, binding)) {
          ctx.ui.notify("Pindie could not arm /trial Scope Candidate: another Candidate Trial is already pending or active.", "warning");
          return;
        }
      } catch (error) {
        ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: invalid binding: ${errorMessage(error)}`, "warning");
        return;
      }
      ctx.ui.notify(`Scope Trial armed for the next Agent Run (Scope Candidate ${scopeCandidateId}).`, "info");
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
    ctx: ExtensionCommandContext,
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

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: ${errorMessage(error)}`, "warning");
      return;
    }

    let portfolio;
    try {
      portfolio = await this.loadProjectTrustedPortfolio(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: trusted Strategy portfolio validation failed: ${errorMessage(error)}`, "warning");
      return;
    }

    let read;
    try {
      read = await this.experienceReader.read(projectRoot);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: Experience reading failed: ${errorMessage(error)}`, "warning");
      return;
    }

    let packet;
    try {
      packet = buildDerivationPacket(projectRoot, portfolio, read.records);
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive: evidence evaluation failed: ${errorMessage(error)}`, "warning");
      return;
    }

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
      !ctx.isIdle()
    ) {
      ctx.ui.notify("Pindie could not start /derive: the current Session, project, or Agent state changed while reading evidence.", "warning");
      return;
    }
    if (this.adaptation.hasAttempt || this.trial.hasTrial || this.derivation.hasDerivation) {
      ctx.ui.notify("Pindie could not start /derive: another Self-Improvement attempt became active while reading evidence.", "warning");
      return;
    }
    if (!this.derivation.establish(sessionId, portfolio, packet)) {
      ctx.ui.notify("Pindie could not start /derive: another derivation attempt is already pending or active.", "warning");
      return;
    }
    try {
      this.pi.sendUserMessage(
        "Begin the explicitly requested Self-Improvement Strategy Derivation. Use the bounded Derivation Packet supplied for this Run. This is optional missing-abstraction hypothesis generation, not project implementation work.",
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
