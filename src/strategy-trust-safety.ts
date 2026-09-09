import {
  loadPromotedStrategyRevisionCatalog,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  emptyPromotedDerivedStrategyCatalog,
  loadPromotedDerivedStrategyCatalog,
  type PromotedDerivedStrategyCatalog,
  type StrategyDerivationDecisionReader,
} from "./strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  type TrustedPortfolioGlobalEntry,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import type { StrategyCandidateReader } from "./strategy-candidates.ts";
import type { StrategyDerivationCandidateReader } from "./strategy-derivation-candidates.ts";
import type { StrategyTrustScopeCandidateReader } from "./strategy-trust-scope-candidates.ts";
import type { StrategyTrustScopeDecisionReader } from "./strategy-trust-scope-decisions.ts";
import type { StrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import {
  readScopeTrialGlobalArtifacts,
  validateStrategyTrustScopeGlobalArtifacts,
  type ScopeTrialGlobalArtifacts,
} from "./strategy-trust-scope-artifacts.ts";

export { readScopeTrialGlobalArtifacts, validateStrategyTrustScopeGlobalArtifacts };
export type { ScopeTrialGlobalArtifacts };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectTrustedStrategyPortfolioLoadDependencies {
  readonly decisionReader: StrategyRevisionDecisionReader;
  readonly candidateReader: StrategyCandidateReader;
  readonly derivationDecisionReader?: StrategyDerivationDecisionReader;
  readonly derivationCandidateReader?: StrategyDerivationCandidateReader;
}

export interface TrustedStrategyPortfolioLoadDependencies
  extends ProjectTrustedStrategyPortfolioLoadDependencies {
  readonly scopeCandidateReader?: StrategyTrustScopeCandidateReader;
  readonly scopeDecisionReader?: StrategyTrustScopeDecisionReader;
  readonly scopeSourceResolver?: StrategyTrustScopeSourceResolver;
}

function validateScopeDependencies(
  dependencies: Pick<TrustedStrategyPortfolioLoadDependencies, "scopeCandidateReader" | "scopeDecisionReader" | "scopeSourceResolver">,
): void {
  const scopeDependencies = [
    dependencies.scopeCandidateReader,
    dependencies.scopeDecisionReader,
    dependencies.scopeSourceResolver,
  ];
  if (
    scopeDependencies.some((dependency) => dependency !== undefined) &&
    scopeDependencies.some((dependency) => dependency === undefined)
  ) {
    throw new Error("User-global trusted Strategy projection dependencies are incomplete.");
  }
}

/**
 * Reconstruct only project-local trusted identity. It intentionally does not
 * read the user-global namespace and is the normal SI-only portfolio path.
 */
export async function loadProjectTrustedStrategyPortfolio(
  projectRoot: string,
  dependencies: ProjectTrustedStrategyPortfolioLoadDependencies,
): Promise<TrustedStrategyPortfolio> {
  const promotedCatalog = await loadPromotedStrategyRevisionCatalog(
    projectRoot,
    dependencies.decisionReader,
    dependencies.candidateReader,
  );
  const promotedDerivedCatalog = dependencies.derivationDecisionReader !== undefined &&
      dependencies.derivationCandidateReader !== undefined
    ? await loadPromotedDerivedStrategyCatalog(
      projectRoot,
      dependencies.derivationDecisionReader,
      dependencies.derivationCandidateReader,
      dependencies.candidateReader,
    )
    : emptyPromotedDerivedStrategyCatalog();
  if (
    (dependencies.derivationDecisionReader === undefined) !==
    (dependencies.derivationCandidateReader === undefined)
  ) {
    throw new Error("Project-local Derived trusted Strategy dependencies are incomplete.");
  }
  return createTrustedStrategyPortfolio(
    projectRoot,
    promotedCatalog,
    promotedDerivedCatalog,
  );
}

/**
 * Reconstruct the complete trusted portfolio, including valid user-global
 * trust. This is a trust-safety read as well as the CPL presentation path;
 * malformed relevant global authority is propagated to the caller.
 */
export async function loadTrustedStrategyPortfolio(
  projectRoot: string,
  dependencies: TrustedStrategyPortfolioLoadDependencies,
): Promise<TrustedStrategyPortfolio> {
  const promotedCatalog = await loadPromotedStrategyRevisionCatalog(
    projectRoot,
    dependencies.decisionReader,
    dependencies.candidateReader,
  );
  const promotedDerivedCatalog = dependencies.derivationDecisionReader !== undefined &&
      dependencies.derivationCandidateReader !== undefined
    ? await loadPromotedDerivedStrategyCatalog(
      projectRoot,
      dependencies.derivationDecisionReader,
      dependencies.derivationCandidateReader,
      dependencies.candidateReader,
    )
    : emptyPromotedDerivedStrategyCatalog();
  if (
    (dependencies.derivationDecisionReader === undefined) !==
    (dependencies.derivationCandidateReader === undefined)
  ) {
    throw new Error("Project-local Derived trusted Strategy dependencies are incomplete.");
  }

  validateScopeDependencies(dependencies);
  let userGlobalEntries: readonly TrustedPortfolioGlobalEntry[] = [];
  if (
    dependencies.scopeCandidateReader !== undefined &&
    dependencies.scopeDecisionReader !== undefined &&
    dependencies.scopeSourceResolver !== undefined
  ) {
    const { loadUserGlobalTrustedDerivedStrategyProjection } = await import("./strategy-trust-scope-global.ts");
    const projection = await loadUserGlobalTrustedDerivedStrategyProjection({
      candidateReader: dependencies.scopeCandidateReader,
      decisionReader: dependencies.scopeDecisionReader,
      sourceResolver: dependencies.scopeSourceResolver,
    });
    userGlobalEntries = projection.entries.map((entry): TrustedPortfolioGlobalEntry => ({
      sourceProjectId: entry.sourceStrategy.sourceProjectId,
      selection: entry.selection,
    }));
  }

  return createTrustedStrategyPortfolio(
    projectRoot,
    promotedCatalog,
    promotedDerivedCatalog,
    userGlobalEntries,
  );
}

/** Compatibility alias for callers that describe this operation as a safety read. */
export const loadCompleteTrustedStrategyPortfolio = loadTrustedStrategyPortfolio;

/** Keep the safety diagnostic bounded at feature boundaries. */
export function boundedTrustSafetyError(error: unknown, maxLength = 256): string {
  const reason = `trust-safety read failed: ${errorMessage(error)}`
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return reason.length <= maxLength ? reason : `${reason.slice(0, maxLength - 1)}…`;
}

/** Keep catalog types reachable to composition code without a second loader. */
export type {
  PromotedStrategyRevisionCatalog,
  PromotedDerivedStrategyCatalog,
};
