import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  buildCrossProjectSynthesisPacket,
  formatCrossProjectSynthesisPacket,
  scanCrossProjectSynthesisEvidence,
  type CrossProjectSynthesisPacket,
} from "./cross-project-synthesis.ts";
import type { GlobalDerivationLease } from "./strategy-global-derivation.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import {
  createPindieStrategySynthesisCandidateTool,
} from "./tools/strategy-synthesis-candidate.ts";
import type {
  StrategySynthesisCandidateRunBinding,
  StrategySynthesisCandidateRuntimeAccess,
  StrategySynthesisCandidateStore,
} from "./strategy-synthesis-candidates.ts";
import type { StrategySynthesisDecisionStore } from "./strategy-synthesis-decisions.ts";
import type {
  CrossProjectLearningAttachment,
  SelfImprovementLearningAccess,
  SelfImprovementStrategyTrustAccess,
} from "./self-improvement-integration.ts";
import type { RunExperienceProjectReader } from "./experience-store.ts";
import {
  createStrategyTrustScopeCandidateForProject,
  createStrategyTrustScopeDecisionForHuman,
  filterTrustTransferCommandOptions,
  listTransferableDerivedStrategies,
  type StrategyTrustScopeCandidateCreationDependencies,
  type StrategyTrustScopeDecisionCreationDependencies,
} from "./strategy-trust-scope.ts";
import {
  filterScopeDecisionCommandOptions,
  filterScopeTrialReviewCommandOptions,
  buildScopeDecisionCommandProjection,
  buildScopeTrialReviewCommandProjection,
  deriveStrategyTrustScopeTrialReview,
  formatStrategyTrustScopeTrialReview,
  parseScopeTrialReviewCommandValue,
  type ScopeProjectTrustReader,
} from "./strategy-trust-scope-review.ts";
import {
  filterScopeTrialCommandOptions,
  listOpenScopeTrialCandidates,
  parseScopeTrialCommandValue,
  resolveScopeTrialBinding,
  revalidateScopeTrialBinding,
  sameScopeTrialBinding,
  type ScopeTrialBinding,
} from "./strategy-trust-scope-trial.ts";
import {
  buildSynthesisDecisionCommandProjection,
  buildSynthesisTrialReviewCommandProjection,
  createStrategySynthesisDecisionForHuman,
  filterSynthesisDecisionCommandOptions,
  filterSynthesisTrialReviewCommandOptions,
  formatStrategySynthesisTrialReview,
  parseSynthesisTrialReviewCommandValue,
  type StrategySynthesisDecisionCommand,
  type StrategySynthesisTrialReviewInput,
} from "./strategy-synthesis-review.ts";
import {
  createTrustedStrategyPortfolio,
  resolveTrustedPortfolioRevisionSelection,
  type TrustedStrategyPortfolio,
  type TrustedStrategyPortfolioPresentation,
} from "./strategy-portfolio.ts";
import { emptyPromotedDerivedStrategyCatalog } from "./strategy-derivation-decisions.ts";
import { emptyPromotedStrategyRevisionCatalog } from "./strategy-decisions.ts";
import type {
  StrategyTrustScopeCandidateV1,
} from "./strategy-trust-scope-candidates.ts";
import type {
  ScopeTrialLease,
  SynthesisTrialBinding,
  SynthesisTrialLease,
} from "./strategy-trial.ts";
import {
  filterSynthesisTrialCommandOptions,
  listOpenSynthesisTrialCandidates,
  parseSynthesisTrialCommandValue,
  resolveSynthesisTrialBinding,
  revalidateSynthesisTrialBinding,
  sameSynthesisTrialBinding,
} from "./strategy-synthesis-trial.ts";
import type {
  CandidateCommandName,
} from "./strategy-candidate-commands.ts";
import type {
  StrategyRevisionSelection,
  StrategyRevisionSelector,
} from "./policy.ts";

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

/** Explicit CPL dependencies; no whole SI or Extension object crosses here. */
export interface CrossProjectLearningIntegrationOptions {
  readonly pi: ExtensionAPI;
  readonly learning: SelfImprovementLearningAccess;
  readonly trust: SelfImprovementStrategyTrustAccess;
  readonly crossProjectExperienceReader: RunExperienceProjectReader;
  readonly crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader;
  readonly scopeProjectTrustReader: ScopeProjectTrustReader;
  readonly strategySynthesisCandidateStore: StrategySynthesisCandidateStore;
  readonly strategySynthesisDecisionStore: StrategySynthesisDecisionStore;
  readonly now?: () => number;
}

/**
 * Cross-Project Learning owns Scope workflow and global presentation while SI
 * owns the unified Trial lease and command entry points.
 */
export class CrossProjectLearningIntegration {
  private readonly pi: ExtensionAPI;
  private readonly learning: SelfImprovementLearningAccess;
  private readonly trust: SelfImprovementStrategyTrustAccess;
  private readonly crossProjectExperienceReader: RunExperienceProjectReader;
  private readonly crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader;
  private readonly scopeProjectTrustReader: ScopeProjectTrustReader;
  private readonly strategySynthesisCandidateStore: StrategySynthesisCandidateStore;
  private readonly strategySynthesisDecisionStore: StrategySynthesisDecisionStore;
  private readonly now: () => number;
  private pendingGlobalDerivation: {
    readonly attemptId: string;
    readonly sessionId: string;
    readonly invocationRoot: string;
    readonly projectId: string;
    readonly packet: CrossProjectSynthesisPacket;
    readonly candidateId: string;
    readonly createdAt: string;
  } | null = null;
  private activeGlobalDerivation: StrategySynthesisCandidateRunBinding | null = null;
  private globalPublication: "idle" | "publishing" | "published" = "idle";

  constructor(options: CrossProjectLearningIntegrationOptions) {
    this.pi = options.pi;
    this.learning = options.learning;
    this.trust = options.trust;
    this.crossProjectExperienceReader = options.crossProjectExperienceReader;
    this.crossProjectTrustReader = options.crossProjectTrustReader;
    this.scopeProjectTrustReader = options.scopeProjectTrustReader;
    this.strategySynthesisCandidateStore = options.strategySynthesisCandidateStore;
    this.strategySynthesisDecisionStore = options.strategySynthesisDecisionStore;
    this.now = options.now ?? Date.now;
  }

  registerCommands(): void {
    this.pi.registerCommand("derive-global", {
      description: "Start explicit cross-project Strategy Synthesis discovery",
      handler: async (args, ctx) => this.handleGlobalDerivationCommand(args, ctx),
    });
    this.pi.registerCommand("trust-transfer", {
      description: "Propose one project-local promoted Derived Strategy for user-global trust",
      getArgumentCompletions: (prefix) => this.trustTransferCommandCompletions(prefix),
      handler: async (args, ctx) => this.handleTrustTransferCommand(args, ctx),
    });
  }

  registerTools(): void {
    this.pi.registerTool(createPindieStrategySynthesisCandidateTool({
      runtime: this.synthesisCandidateRuntimeAccess(),
      candidateStore: this.strategySynthesisCandidateStore,
      getProjectRoot: this.learning.getProjectRoot,
      getAgentRunGeneration: this.learning.getActiveAgentRunGeneration,
    }));
  }

  private synthesisCandidateRuntimeAccess(): StrategySynthesisCandidateRuntimeAccess {
    return {
      activeFor: (sessionId, invocationRoot, agentRunGeneration) => {
        const active = this.activeGlobalDerivation;
        if (
          active === null ||
          agentRunGeneration === null ||
          active.sessionId !== sessionId ||
          active.invocationRoot !== invocationRoot ||
          active.agentRunGeneration !== agentRunGeneration
        ) return null;
        return active;
      },
      claimPublication: (attemptId) => {
        const active = this.activeGlobalDerivation;
        if (
          active === null ||
          active.attemptId !== attemptId ||
          this.globalPublication !== "idle"
        ) return false;
        this.globalPublication = "publishing";
        return true;
      },
      releasePublication: (attemptId) => {
        if (
          this.activeGlobalDerivation?.attemptId === attemptId &&
          this.globalPublication === "publishing"
        ) this.globalPublication = "idle";
      },
      completePublication: (attemptId) => {
        if (
          this.activeGlobalDerivation?.attemptId !== attemptId ||
          this.globalPublication !== "publishing"
        ) return false;
        this.globalPublication = "published";
        return true;
      },
    };
  }

  private clearGlobalDerivationPreparation(): void {
    this.pendingGlobalDerivation = null;
    this.activeGlobalDerivation = null;
    this.globalPublication = "idle";
  }

  /** Abort a pending or active synthesis Run without touching Core State. */
  abortGlobalDerivationRun(): void {
    this.clearGlobalDerivationPreparation();
  }

  /** Clear only an active synthesis preparation owned by one Run generation. */
  abortGlobalDerivationRunForGeneration(agentRunGeneration: number): void {
    if (this.activeGlobalDerivation?.agentRunGeneration !== agentRunGeneration) return;
    this.clearGlobalDerivationPreparation();
  }

  /** Bind CPL's frozen packet after SI has bound the generic reservation. */
  bindGlobalDerivationRun(lease: GlobalDerivationLease): {
    readonly promptContribution: string;
  } {
    const prepared = this.pendingGlobalDerivation;
    if (
      prepared === null ||
      prepared.attemptId !== lease.attemptId ||
      prepared.sessionId !== lease.sessionId ||
      prepared.invocationRoot !== lease.invocationRoot ||
      prepared.projectId !== lease.projectId
    ) {
      throw new Error("the frozen cross-project packet is absent or does not match the active Global Derivation reservation");
    }
    const active = Object.freeze({
      ...lease,
      candidateId: prepared.candidateId,
      createdAt: prepared.createdAt,
      packet: prepared.packet,
    });
    this.pendingGlobalDerivation = null;
    this.activeGlobalDerivation = active;
    this.globalPublication = "idle";
    return Object.freeze({
      promptContribution: [
        formatCrossProjectSynthesisPacket(active.packet),
        "",
        "<PINDIE_GLOBAL_DERIVATION_RUN>",
        "This is one native, read-only cross-project synthesis Run; it is not a project implementation Task.",
        "The frozen packet above is the complete project evidence supplied to this Run. Do not call project, git, shell, web, trust, memory, Policy, Task, Gate, Verification, or any other tool.",
        "If a bounded missing-abstraction hypothesis is justified, call only pindie_strategy_synthesis_candidate_create, at most once. Candidate creation is optional.",
        "The Candidate remains inactive and grants no Trial, Policy, Decision, or Promotion authority.",
        "</PINDIE_GLOBAL_DERIVATION_RUN>",
      ].join("\n"),
    });
  }

  /** Clear only the exact active synthesis Run at settlement. */
  settleGlobalDerivationRun(agentRunGeneration: number): void {
    if (this.activeGlobalDerivation?.agentRunGeneration !== agentRunGeneration) return;
    this.clearGlobalDerivationPreparation();
  }

  resetForSession(): void {
    this.clearGlobalDerivationPreparation();
  }

  /** Read-only discovery preparation; reservation/launch remain explicit-command only. */
  async prepareGlobalDerivationEvidence(capturedAt: string): Promise<CrossProjectSynthesisPacket> {
    const scan = await scanCrossProjectSynthesisEvidence({
      experienceReader: this.crossProjectExperienceReader,
      trustedPortfolioReader: this.crossProjectTrustReader,
    });
    return buildCrossProjectSynthesisPacket({ scan, capturedAt });
  }

  private async handleGlobalDerivationCommand(
    args: string,
    ctx: ExtensionContext,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (args.trim() !== "") {
      ctx.ui.notify("Usage: /derive-global", "warning");
      return;
    }
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not start /derive-global: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle() || !isCurrent()) {
      ctx.ui.notify("Pindie could not start /derive-global: the Agent is busy.", "warning");
      return;
    }

    let sessionId: string;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      ctx.ui.notify(`Pindie could not start /derive-global: ${errorMessage(error)}`, "warning");
      return;
    }

    // This synchronous reservation is the admission boundary. No cross-project
    // Experience or trust scan occurs before it succeeds.
    const admission = this.learning.globalDerivation.reserve(sessionId, projectRoot);
    if (!admission.allowed) {
      const reason = admission.reason === "adaptation"
        ? "an adaptation attempt is already pending or active"
        : admission.reason === "derivation"
          ? "a local /derive attempt is already pending or active"
          : admission.reason === "trial"
            ? "a Candidate Trial is already pending or active"
            : "another /derive-global attempt is already pending or active";
      ctx.ui.notify(`Pindie could not start /derive-global: ${reason}.`, "warning");
      return;
    }
    const reservation = admission.reservation;
    try {
      const packet = await this.prepareGlobalDerivationEvidence(new Date(this.now()).toISOString());
      if (
        !this.learning.globalDerivation.isCurrent(reservation) ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        this.learning.getProjectRoot() !== projectRoot ||
        !ctx.isIdle() || !isCurrent()
      ) throw new Error("the current Session, project, Agent state, or Global Derivation reservation changed while scanning evidence");

      if (
        !this.learning.globalDerivation.isCurrent(reservation) ||
        ctx.sessionManager.getSessionId() !== sessionId ||
        this.learning.getProjectRoot() !== projectRoot ||
        !ctx.isIdle() || !isCurrent()
      ) throw new Error("the current Session, project, Agent state, or Global Derivation reservation changed before launch");

      const candidateId = randomUUID().toLowerCase();
      const createdAt = new Date(this.now()).toISOString();
      this.pendingGlobalDerivation = Object.freeze({
        attemptId: reservation.attemptId,
        sessionId,
        invocationRoot: projectRoot,
        projectId: reservation.projectId,
        packet,
        candidateId,
        createdAt,
      });
      try {
        this.pi.sendUserMessage(
          `Begin the explicitly requested cross-project Strategy Synthesis discovery Run. Use only the frozen Cross-Project Synthesis Packet supplied for this Run. Candidate creation is optional missing-abstraction hypothesis generation, not project implementation work.`,
        );
      } catch (error) {
        this.clearGlobalDerivationPreparation();
        this.learning.globalDerivation.cancel();
        throw error;
      }
      ctx.ui.notify(
        `Cross-project Strategy Synthesis Run started with ${packet.evidence.eligibleRunCount} eligible Runs from ${packet.inventory.projectCount} project namespace${packet.inventory.projectCount === 1 ? "" : "s"}. Candidate creation is optional.`,
        "info",
      );
    } catch (error) {
      this.clearGlobalDerivationPreparation();
      this.learning.globalDerivation.cancel();
      const message = errorMessage(error);
      if (/insufficient/i.test(message)) {
        ctx.ui.notify(`Pindie could not start /derive-global: discovery evidence is insufficient; no Agent Run was started.`, "warning");
      } else {
        ctx.ui.notify(`Pindie could not start /derive-global: ${message}`, "warning");
      }
    }
  }

  async validatePendingScopeTrial(binding: ScopeTrialBinding): Promise<void> {
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) throw new Error("no current project root is loaded");
    if (projectRoot !== binding.targetProjectRoot) {
      throw new Error("the target project changed after the Scope Trial was armed");
    }
    const currentPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    const currentBinding = await revalidateScopeTrialBinding(
      binding,
      currentPortfolio,
      {
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
      },
    );
    if (!sameScopeTrialBinding(binding, currentBinding)) {
      throw new Error("the Scope Candidate, source binding, or target trust changed after /trial was armed");
    }
  }

  async validatePendingSynthesisTrial(binding: SynthesisTrialBinding): Promise<void> {
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) throw new Error("no current project root is loaded");
    if (projectRoot !== binding.targetProjectRoot) {
      throw new Error("the target project changed after the Synthesis Trial was armed");
    }
    const currentPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    const currentBinding = await revalidateSynthesisTrialBinding(
      binding,
      currentPortfolio,
      this.strategySynthesisCandidateStore,
      this.strategySynthesisDecisionStore,
    );
    if (!sameSynthesisTrialBinding(binding, currentBinding)) {
      throw new Error("the Synthesis Candidate or target trust changed after /trial was armed");
    }
  }

  async resolveScopeRevisionSelector(
    activeScopeTrial: ScopeTrialLease,
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    sessionId: string,
    agentRunGeneration: number | null,
  ): Promise<StrategyRevisionSelection> {
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      throw new Error("Scope Candidate selector is unavailable: no current target project root is loaded.");
    }
    if (projectRoot !== activeScopeTrial.targetProjectRoot) {
      throw new Error("Scope Candidate selector is unavailable: the target project changed while the Scope Trial was active.");
    }
    const currentPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    const currentBinding = await revalidateScopeTrialBinding(
      activeScopeTrial,
      currentPortfolio,
      {
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
      },
    );
    if (!sameScopeTrialBinding(activeScopeTrial, currentBinding)) {
      throw new Error("Scope Candidate selector is unavailable: the source/global binding or target trust changed while the Scope Trial was active.");
    }
    if (selector.revisionIdentity === activeScopeTrial.sourceStrategy.revisionIdentity) {
      return this.learning.trial.resolveScopeSelector(
        sessionId,
        agentRunGeneration,
        selector,
        kind,
        currentBinding.sourceCandidate,
      );
    }
    const resolved = resolveTrustedPortfolioRevisionSelection(selector, currentPortfolio, kind);
    if (resolved === null) {
      throw new Error("Candidate revision selector is unavailable without an active Candidate Trial or a promoted revision in the current trusted project catalog, or it has the wrong role.");
    }
    return resolved;
  }

  async resolveSynthesisRevisionSelector(
    activeSynthesisTrial: SynthesisTrialLease,
    selector: StrategyRevisionSelector,
    kind: "approach" | "modifier",
    sessionId: string,
    agentRunGeneration: number | null,
  ): Promise<StrategyRevisionSelection> {
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      throw new Error("Synthesis Candidate selector is unavailable: no current target project root is loaded.");
    }
    if (projectRoot !== activeSynthesisTrial.targetProjectRoot) {
      throw new Error("Synthesis Candidate selector is unavailable: the target project changed while the Trial was active.");
    }
    const currentPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    const currentBinding = await revalidateSynthesisTrialBinding(
      activeSynthesisTrial,
      currentPortfolio,
      this.strategySynthesisCandidateStore,
      this.strategySynthesisDecisionStore,
    );
    if (!sameSynthesisTrialBinding(activeSynthesisTrial, currentBinding)) {
      throw new Error("Synthesis Candidate selector is unavailable: the Candidate artifact or target trust changed while the Trial was active.");
    }
    if (selector.revisionIdentity === activeSynthesisTrial.candidate.candidateId) {
      return this.learning.trial.resolveSynthesisSelector(
        sessionId,
        agentRunGeneration,
        selector,
        kind,
        currentBinding.candidate,
      );
    }
    const resolved = resolveTrustedPortfolioRevisionSelection(selector, currentPortfolio, kind);
    if (resolved === null) {
      throw new Error("Candidate revision selector is unavailable without the exact active Synthesis Candidate Trial or a trusted revision in the current project catalog, or it has the wrong role.");
    }
    return resolved;
  }

  async loadPresentationPortfolio(
    projectRoot: string,
  ): Promise<TrustedStrategyPortfolioPresentation> {
    try {
      const portfolio = await this.trust.loadTrustedPortfolio(projectRoot);
      return Object.freeze({
        portfolio,
        globalLayer: Object.freeze({ available: true as const }),
      });
    } catch (error) {
      let portfolio: TrustedStrategyPortfolio;
      try {
        portfolio = await this.trust.loadProjectTrustedPortfolio(projectRoot);
      } catch {
        // Presentation is optional; if local trust readers are also
        // unavailable, retain the immutable Seed-only view rather than
        // preventing ordinary SI startup.
        portfolio = createTrustedStrategyPortfolio(
          projectRoot,
          emptyPromotedStrategyRevisionCatalog(),
          emptyPromotedDerivedStrategyCatalog(),
        );
      }
      return Object.freeze({
        portfolio,
        globalLayer: Object.freeze({
          available: false,
          reason: optionalGlobalUnavailableReason(error),
        }),
      });
    }
  }

  async synthesisTrialCommandCompletions(
    projectRoot: string,
    prefix: string,
  ): Promise<readonly { readonly value: string; readonly label: string }[]> {
    const targetPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    const projection = await listOpenSynthesisTrialCandidates({
      targetProjectRoot: projectRoot,
      targetPortfolio,
      candidateReader: this.strategySynthesisCandidateStore,
      decisionReader: this.strategySynthesisDecisionStore,
    });
    return filterSynthesisTrialCommandOptions(projection.entries, prefix);
  }

  private synthesisReviewInput(): Omit<StrategySynthesisTrialReviewInput, "candidate"> {
    return {
      candidateReader: this.strategySynthesisCandidateStore,
      decisionReader: this.strategySynthesisDecisionStore,
      experienceReader: this.crossProjectExperienceReader,
      projectTrustReader: this.scopeProjectTrustReader,
      scopeCandidateReader: this.trust.scopeCandidateStore,
      scopeDecisionReader: this.trust.scopeDecisionStore,
      sourceResolver: this.trust.scopeSourceResolver,
    };
  }

  async synthesisReviewCommandCompletions(
    command: "trial-review" | StrategySynthesisDecisionCommand,
    projectRoot: string,
    prefix: string,
  ): Promise<readonly { readonly value: string; readonly label: string }[]> {
    if (command === "trial-review") {
      const projection = await buildSynthesisTrialReviewCommandProjection({
        candidateReader: this.strategySynthesisCandidateStore,
        decisionReader: this.strategySynthesisDecisionStore,
      });
      return filterSynthesisTrialReviewCommandOptions(projection, prefix);
    }
    const projection = await buildSynthesisDecisionCommandProjection({
      ...this.synthesisReviewInput(),
      command,
    });
    return filterSynthesisDecisionCommandOptions(projection, prefix);
  }

  async scopeCommandCompletions(
    command: CandidateCommandName,
    projectRoot: string,
    prefix: string,
  ): Promise<readonly { readonly value: string; readonly label: string }[]> {
    if (command === "trial") {
      const targetPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
      const projection = await listOpenScopeTrialCandidates({
        targetProjectRoot: projectRoot,
        targetPortfolio,
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
      });
      return filterScopeTrialCommandOptions(projection.entries, prefix);
    }
    if (command === "trial-review") {
      const projection = await buildScopeTrialReviewCommandProjection({
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
      });
      return filterScopeTrialReviewCommandOptions(projection, prefix);
    }
    const projection = await buildScopeDecisionCommandProjection({
      command,
      candidateReader: this.trust.scopeCandidateStore,
      decisionReader: this.trust.scopeDecisionStore,
      sourceResolver: this.trust.scopeSourceResolver,
      experienceReader: this.crossProjectExperienceReader,
      projectTrustReader: this.scopeProjectTrustReader,
      synthesisCandidateReader: this.trust.synthesisCandidateReader,
      synthesisDecisionReader: this.trust.synthesisDecisionReader,
      currentProjectRoot: projectRoot,
    });
    return filterScopeDecisionCommandOptions(projection, prefix);
  }

  async handleScopeTrialReviewCommand(
    candidateValue: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let candidateId: string | null;
    try {
      candidateId = parseScopeTrialReviewCommandValue(`scope:${candidateValue}`);
      if (candidateId === null) throw new Error("Scope review subject namespace is invalid.");
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: ${errorMessage(error)}`, "warning");
      return;
    }

    let candidate: StrategyTrustScopeCandidateV1 | null;
    try {
      candidate = await this.trust.scopeCandidateStore.read(candidateId);
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: Candidate read failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidate === null) {
      ctx.ui.notify(`Pindie could not show Scope Trial review: Scope Candidate '${candidateId}' was not found.`, "warning");
      return;
    }
    const currentProjectRoot = this.learning.getProjectRoot();
    try {
      const review = await deriveStrategyTrustScopeTrialReview({
        candidate,
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
        experienceReader: this.crossProjectExperienceReader,
        projectTrustReader: this.scopeProjectTrustReader,
        synthesisCandidateReader: this.trust.synthesisCandidateReader,
        synthesisDecisionReader: this.trust.synthesisDecisionReader,
        currentProjectRoot,
      });
      if (currentProjectRoot !== this.learning.getProjectRoot()) {
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

  async handleSynthesisTrialReviewCommand(
    candidateValue: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    let candidateId: string | null;
    try {
      candidateId = parseSynthesisTrialReviewCommandValue(`synthesis:${candidateValue}`);
      if (candidateId === null) throw new Error("Synthesis review subject namespace is invalid.");
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Synthesis Trial review: ${errorMessage(error)}`, "warning");
      return;
    }
    let candidate;
    try {
      candidate = await this.strategySynthesisCandidateStore.read(candidateId);
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Synthesis Trial review: Candidate read failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (candidate === null) {
      ctx.ui.notify(`Pindie could not show Synthesis Trial review: Synthesis Candidate '${candidateId}' was not found.`, "warning");
      return;
    }
    const projectRoot = this.learning.getProjectRoot();
    try {
      const review = await (await import("./strategy-synthesis-review.ts")).deriveStrategySynthesisTrialReview({
        ...this.synthesisReviewInput(),
        candidate,
        currentProjectRoot: projectRoot,
      });
      if (projectRoot !== this.learning.getProjectRoot()) {
        ctx.ui.notify("Pindie could not show Synthesis Trial review: the current project changed while reading cross-project evidence.", "warning");
        return;
      }
      ctx.ui.notify(formatStrategySynthesisTrialReview(review), "info");
    } catch (error) {
      ctx.ui.notify(`Pindie could not show Synthesis Trial review: evidence evaluation failed: ${errorMessage(error)}`, "warning");
    }
  }

  async handleSynthesisDecisionCommand(
    terminalDecision: "promoted" | "rejected",
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedValue = args.trim();
    const verb = terminalDecision === "promoted" ? "promote" : "reject";
    const command = terminalDecision === "promoted" ? "/promote" : "/reject";
    if (!requestedValue || /\s/.test(requestedValue)) {
      ctx.ui.notify(`Usage: ${command} synthesis:<candidate-id>`, "warning");
      return;
    }
    let candidateId: string | null;
    try {
      candidateId = parseSynthesisTrialReviewCommandValue(requestedValue);
      if (candidateId === null) throw new Error("Synthesis Decisions require the namespaced value synthesis:<candidate-id>.");
    } catch (error) {
      ctx.ui.notify(`Pindie could not ${verb} Synthesis Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify(`Pindie could not ${verb} Synthesis Candidate: no current project root is loaded.`, "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify(`Pindie could not ${verb} Synthesis Candidate: the Agent is busy.`, "warning");
      return;
    }
    try {
      const result = await createStrategySynthesisDecisionForHuman({
        candidateId,
        decision: terminalDecision,
        decidedAt: new Date(this.now()).toISOString(),
        currentProjectRoot: projectRoot,
      }, {
        ...this.synthesisReviewInput(),
        writerLock: this.trust.writerLock,
        decisionStore: this.strategySynthesisDecisionStore,
      });
      if (terminalDecision === "promoted") {
        ctx.ui.notify(
          `Synthesis Candidate '${candidateId}' promoted: the exact synthesized revision is trusted for explicit normal Policy selection as user-global trust. It is not a default or recommendation; ${result.decision.evidence.trialRefs.length} validated Trial evidence ref(s) were retained for audit provenance.`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Synthesis Candidate '${candidateId}' rejected: no user-global trust was granted. Rejection is a Human trust decision, not experimental falsification.`,
          "info",
        );
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not ${verb} Synthesis Candidate: ${errorMessage(error)}`, "warning");
    }
  }

  async handleScopeDecisionCommand(
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
      ctx.ui.notify(`Usage: ${command} scope:<candidate-id>`, "warning");
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
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      failure("no current project root is loaded.");
      return;
    }
    if (!ctx.isIdle()) {
      failure("the Agent is busy.");
      return;
    }

    const dependencies: StrategyTrustScopeDecisionCreationDependencies = {
      candidateReader: this.trust.scopeCandidateStore,
      decisionStore: this.trust.scopeDecisionStore,
      sourceResolver: this.trust.scopeSourceResolver,
      writerLock: this.trust.writerLock,
      experienceReader: this.crossProjectExperienceReader,
      projectTrustReader: this.scopeProjectTrustReader,
      synthesisCandidateReader: this.trust.synthesisCandidateReader,
      synthesisDecisionReader: this.trust.synthesisDecisionReader,
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

  async handleSynthesisTrialCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedValue = args.trim();
    if (!requestedValue || /\s/.test(requestedValue)) {
      ctx.ui.notify("Usage: /trial synthesis:<candidate-id>", "warning");
      return;
    }
    let candidateId: string | null;
    try {
      candidateId = parseSynthesisTrialCommandValue(requestedValue);
      if (candidateId === null) {
        ctx.ui.notify("Pindie could not arm /trial: Synthesis Trials require the synthesis:<candidate-id> subject namespace.", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Synthesis Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: the Agent is busy.", "warning");
      return;
    }
    if (this.learning.trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasAdaptationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasDerivationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasGlobalDerivationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    let binding: SynthesisTrialBinding;
    try {
      const targetPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
      binding = await resolveSynthesisTrialBinding({
        candidateId,
        targetProjectRoot: projectRoot,
        targetPortfolio,
        candidateReader: this.strategySynthesisCandidateStore,
        decisionReader: this.strategySynthesisDecisionStore,
      });
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Synthesis Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    if (
      ctx.sessionManager.getSessionId() !== sessionId ||
      this.learning.getProjectRoot() !== projectRoot ||
      !ctx.isIdle()
    ) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: the current Session, project, or Agent state changed while reading the binding.", "warning");
      return;
    }
    try {
      const latestPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
      const latestBinding = await resolveSynthesisTrialBinding({
        candidateId,
        targetProjectRoot: projectRoot,
        targetPortfolio: latestPortfolio,
        candidateReader: this.strategySynthesisCandidateStore,
        decisionReader: this.strategySynthesisDecisionStore,
      });
      if (!sameSynthesisTrialBinding(binding, latestBinding)) {
        throw new Error("the Synthesis Candidate or target trust changed before arming");
      }
      binding = latestBinding;
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Synthesis Candidate: fresh binding validation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (
      ctx.sessionManager.getSessionId() !== sessionId ||
      this.learning.getProjectRoot() !== projectRoot ||
      !ctx.isIdle() ||
      this.learning.trial.hasTrial ||
      this.learning.hasAdaptationAttempt() ||
      this.learning.hasDerivationAttempt() ||
      this.learning.hasGlobalDerivationAttempt()
    ) {
      ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: the current project, Agent, or Self-Improvement state changed before arming.", "warning");
      return;
    }
    try {
      if (!this.learning.trial.establishSynthesis(sessionId, binding)) {
        ctx.ui.notify("Pindie could not arm /trial Synthesis Candidate: another Candidate Trial is already pending or active.", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Synthesis Candidate: invalid binding: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(`Synthesis Trial armed for the next Agent Run (Synthesis Candidate ${candidateId}).`, "info");
  }

  async handleScopeTrialCommand(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    const requestedId = args.trim();
    if (!requestedId) {
      ctx.ui.notify("Usage: /trial scope:<candidate-id>", "warning");
      return;
    }
    if (/\s/.test(requestedId)) {
      ctx.ui.notify("Usage: /trial scope:<candidate-id>", "warning");
      return;
    }
    let scopeCandidateId: string | null;
    try {
      scopeCandidateId = parseScopeTrialCommandValue(requestedId);
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: ${errorMessage(error)}`, "warning");
      return;
    }
    if (scopeCandidateId === null) {
      ctx.ui.notify("Pindie could not arm /trial: unknown Candidate subject namespace.", "warning");
      return;
    }
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: no current project root is loaded.", "warning");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: the Agent is busy.", "warning");
      return;
    }
    if (this.learning.trial.hasTrial) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: another Candidate Trial is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasAdaptationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: an adaptation attempt is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasDerivationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: a Strategy Derivation attempt is already pending or active.", "warning");
      return;
    }
    if (this.learning.hasGlobalDerivationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: a Global Derivation attempt is already pending or active.", "warning");
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    let targetPortfolio: TrustedStrategyPortfolio;
    try {
      targetPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
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
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
      });
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: ${errorMessage(error)}`, "warning");
      return;
    }

    if (
      ctx.sessionManager.getSessionId() !== sessionId ||
      this.learning.getProjectRoot() !== projectRoot ||
      !ctx.isIdle()
    ) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: the current Session, project, or Agent state changed while reading the binding.", "warning");
      return;
    }
    try {
      const latestPortfolio = await this.trust.loadTrustedPortfolio(projectRoot);
      const latestBinding = await resolveScopeTrialBinding({
        candidateId: scopeCandidateId,
        targetProjectRoot: projectRoot,
        targetPortfolio: latestPortfolio,
        candidateReader: this.trust.scopeCandidateStore,
        decisionReader: this.trust.scopeDecisionStore,
        sourceResolver: this.trust.scopeSourceResolver,
      });
      if (!sameScopeTrialBinding(binding, latestBinding)) {
        throw new Error("the Scope Candidate, source binding, or target trust changed before arming");
      }
      binding = latestBinding;
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: fresh binding validation failed: ${errorMessage(error)}`, "warning");
      return;
    }
    if (this.learning.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: the current project or Agent state changed before arming.", "warning");
      return;
    }
    if (this.learning.trial.hasTrial || this.learning.hasAdaptationAttempt() || this.learning.hasDerivationAttempt() || this.learning.hasGlobalDerivationAttempt()) {
      ctx.ui.notify("Pindie could not arm /trial Scope Candidate: another Self-Improvement attempt or Candidate Trial is already pending or active.", "warning");
      return;
    }
    try {
      if (!this.learning.trial.establishScope(sessionId, binding)) {
        ctx.ui.notify("Pindie could not arm /trial Scope Candidate: another Candidate Trial is already pending or active.", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`Pindie could not arm /trial Scope Candidate: invalid binding: ${errorMessage(error)}`, "warning");
      return;
    }
    ctx.ui.notify(`Scope Trial armed for the next Agent Run (Scope Candidate ${scopeCandidateId}).`, "info");
  }

  private async trustTransferCommandProjection(projectRoot: string) {
    const portfolio = await this.trust.loadTrustedPortfolio(projectRoot);
    return listTransferableDerivedStrategies(
      projectRoot,
      portfolio,
      this.trust.scopeSourceResolver,
      this.trust.scopeCandidateStore,
      this.trust.scopeDecisionStore,
    );
  }

  async trustTransferCommandCompletions(
    prefix: string,
  ): Promise<Array<{ readonly value: string; readonly label: string }> | null> {
    const projectRoot = this.learning.getProjectRoot();
    if (projectRoot === null) return null;
    try {
      const projection = await this.trustTransferCommandProjection(projectRoot);
      return filterTrustTransferCommandOptions(projection, prefix);
    } catch {
      return null;
    }
  }

  async handleTrustTransferCommand(
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
    const projectRoot = this.learning.getProjectRoot();
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
    if (this.learning.getProjectRoot() !== projectRoot || !ctx.isIdle()) {
      ctx.ui.notify(
        "Pindie could not create a trust-transfer hypothesis: the current project or Agent state changed while reading trust.",
        "warning",
      );
      return;
    }

    const dependencies: StrategyTrustScopeCandidateCreationDependencies = {
      candidateStore: this.trust.scopeCandidateStore,
      decisionReader: this.trust.scopeDecisionStore,
      sourceResolver: this.trust.scopeSourceResolver,
      writerLock: this.trust.writerLock,
    };
    try {
      const candidate = await createStrategyTrustScopeCandidateForProject(
        {
          projectRoot,
          sourceStrategy: selected.sourceStrategy,
          createdAt: new Date(this.now()).toISOString(),
        },
        dependencies,
      );
      ctx.ui.notify(
        `Trust-transfer hypothesis created for '${candidate.sourceStrategy.strategyId}' (${candidate.sourceStrategy.kind}), revision ${candidate.sourceStrategy.revisionIdentity.slice(0, 8)}: project-local trusted Derived Strategy proposed for user-global trust.`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Pindie could not create a trust-transfer hypothesis: ${errorMessage(error)}`, "warning");
    }
  }

  /** Keep the attachment shape explicit and limited to SI-owned ports. */
  asAttachment(): CrossProjectLearningAttachment {
    return {
      bindGlobalDerivationRun: (lease) => this.bindGlobalDerivationRun(lease),
      abortGlobalDerivationRun: () => this.abortGlobalDerivationRun(),
      abortGlobalDerivationRunForGeneration: (generation) => this.abortGlobalDerivationRunForGeneration(generation),
      settleGlobalDerivationRun: (generation) => this.settleGlobalDerivationRun(generation),
      resetForSession: () => this.resetForSession(),
      validatePendingScopeTrial: (binding) => this.validatePendingScopeTrial(binding),
      validatePendingSynthesisTrial: (binding) => this.validatePendingSynthesisTrial(binding),
      resolveScopeRevisionSelector: (lease, selector, kind, sessionId, generation) =>
        this.resolveScopeRevisionSelector(lease, selector, kind, sessionId, generation),
      resolveSynthesisRevisionSelector: (lease, selector, kind, sessionId, generation) =>
        this.resolveSynthesisRevisionSelector(lease, selector, kind, sessionId, generation),
      handleSynthesisTrialCommand: (args, ctx) => this.handleSynthesisTrialCommand(args, ctx),
      synthesisTrialCommandCompletions: (projectRoot, prefix) =>
        this.synthesisTrialCommandCompletions(projectRoot, prefix),
      handleSynthesisTrialReviewCommand: (candidateId, ctx) =>
        this.handleSynthesisTrialReviewCommand(candidateId, ctx),
      handleSynthesisDecisionCommand: (decision, args, ctx) =>
        this.handleSynthesisDecisionCommand(decision, args, ctx),
      synthesisReviewCommandCompletions: (command, projectRoot, prefix) =>
        this.synthesisReviewCommandCompletions(command, projectRoot, prefix),
      handleScopeTrialCommand: (args, ctx) => this.handleScopeTrialCommand(args, ctx),
      handleScopeTrialReviewCommand: (candidateId, ctx) => this.handleScopeTrialReviewCommand(candidateId, ctx),
      handleScopeDecisionCommand: (decision, args, ctx) => this.handleScopeDecisionCommand(decision, args, ctx),
      scopeCommandCompletions: (command, projectRoot, prefix) => this.scopeCommandCompletions(command, projectRoot, prefix),
      handleTrustTransferCommand: (args, ctx) => this.handleTrustTransferCommand(args, ctx),
      trustTransferCommandCompletions: (prefix) => this.trustTransferCommandCompletions(prefix),
      loadPresentationPortfolio: (projectRoot) => this.loadPresentationPortfolio(projectRoot),
    };
  }
}
