import { isDeepStrictEqual } from "node:util";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

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
import type { ScopeTrialLease } from "./strategy-trial.ts";
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
  readonly scopeProjectTrustReader: ScopeProjectTrustReader;
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
  private readonly scopeProjectTrustReader: ScopeProjectTrustReader;
  private readonly now: () => number;

  constructor(options: CrossProjectLearningIntegrationOptions) {
    this.pi = options.pi;
    this.learning = options.learning;
    this.trust = options.trust;
    this.crossProjectExperienceReader = options.crossProjectExperienceReader;
    this.scopeProjectTrustReader = options.scopeProjectTrustReader;
    this.now = options.now ?? Date.now;
  }

  registerCommands(): void {
    this.pi.registerCommand("trust-transfer", {
      description: "Propose one project-local promoted Derived Strategy for user-global trust",
      getArgumentCompletions: (prefix) => this.trustTransferCommandCompletions(prefix),
      handler: async (args, ctx) => this.handleTrustTransferCommand(args, ctx),
    });
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
    if (this.learning.trial.hasTrial || this.learning.hasAdaptationAttempt() || this.learning.hasDerivationAttempt()) {
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
      validatePendingScopeTrial: (binding) => this.validatePendingScopeTrial(binding),
      resolveScopeRevisionSelector: (lease, selector, kind, sessionId, generation) =>
        this.resolveScopeRevisionSelector(lease, selector, kind, sessionId, generation),
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
