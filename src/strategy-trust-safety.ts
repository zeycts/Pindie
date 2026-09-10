import { homedir } from "node:os";
import { join } from "node:path";

import {
  FileStrategyDecisionStore,
  loadPromotedStrategyRevisionCatalog,
  loadPromotedStrategyRevisionCatalogByProjectId,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  FileStrategyDerivationDecisionStore,
  emptyPromotedDerivedStrategyCatalog,
  loadPromotedDerivedStrategyCatalog,
  loadPromotedDerivedStrategyCatalogByProjectId,
  type PromotedDerivedStrategyCatalog,
  type StrategyDerivationDecisionReader,
} from "./strategy-derivation-decisions.ts";
import {
  createTrustedStrategyPortfolio,
  createTrustedStrategyPortfolioForProjectId,
  type TrustedPortfolioGlobalEntry,
  type TrustedStrategyPortfolio,
} from "./strategy-portfolio.ts";
import {
  FileStrategyCandidateStore,
  type StrategyCandidateReader,
} from "./strategy-candidates.ts";
import {
  FileStrategyDerivationCandidateStore,
  type StrategyDerivationCandidateReader,
} from "./strategy-derivation-candidates.ts";
import {
  FileStrategyTrustScopeCandidateStore,
  type StrategyTrustScopeCandidateReader,
} from "./strategy-trust-scope-candidates.ts";
import {
  FileStrategyTrustScopeDecisionStore,
  type StrategyTrustScopeDecisionReader,
} from "./strategy-trust-scope-decisions.ts";
import {
  FileStrategySynthesisCandidateStore,
  type StrategySynthesisCandidateReader,
} from "./strategy-synthesis-candidates.ts";
import {
  FileStrategySynthesisDecisionStore,
  type StrategySynthesisDecisionReader,
} from "./strategy-synthesis-decisions.ts";
import type { StrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import {
  readScopeTrialGlobalArtifacts,
  validateStrategyTrustScopeGlobalArtifacts,
  type ScopeTrialGlobalArtifacts,
} from "./strategy-trust-scope-artifacts.ts";
import { FileStrategyTrustScopeSourceResolver } from "./strategy-trust-scope-resolution.ts";
import {
  loadUserGlobalTrustedDerivedStrategyProjection,
} from "./strategy-trust-scope-global.ts";
import { isCanonicalStrategyTrustScopeProjectId } from "./strategy-trust-scope-candidates.ts";

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
  /** User-global Synthesis authority is read even when CPL workflow is off. */
  readonly synthesisCandidateReader?: StrategySynthesisCandidateReader;
  readonly synthesisDecisionReader?: StrategySynthesisDecisionReader;
}

/** Narrow read-only trust access for an already-addressed project namespace. */
export interface ProjectTrustedStrategyPortfolioReader {
  readProjectId(projectId: string): Promise<TrustedStrategyPortfolio>;
}

export interface FileProjectTrustedStrategyPortfolioReaderOptions {
  /** User-local project namespace root, normally ~/.pindie/projects. */
  projectsBaseDir?: string;
  /** User-global trust namespace root, normally ~/.pindie/global. */
  globalBaseDir?: string;
}

/**
 * Reconstruct complete current trust by project ID. This reader never calls a
 * root-based loader with a project hash and never fabricates a repository root.
 */
export class FileProjectTrustedStrategyPortfolioReader implements ProjectTrustedStrategyPortfolioReader {
  private readonly revisionDecisionReader: FileStrategyDecisionStore;
  private readonly revisionCandidateReader: FileStrategyCandidateStore;
  private readonly derivationDecisionReader: FileStrategyDerivationDecisionStore;
  private readonly derivationCandidateReader: FileStrategyDerivationCandidateStore;
  private readonly globalCandidateReader: FileStrategyTrustScopeCandidateStore;
  private readonly globalDecisionReader: FileStrategyTrustScopeDecisionStore;
  private readonly synthesisCandidateReader: FileStrategySynthesisCandidateStore;
  private readonly synthesisDecisionReader: FileStrategySynthesisDecisionStore;
  private readonly sourceResolver: FileStrategyTrustScopeSourceResolver;

  constructor(options: FileProjectTrustedStrategyPortfolioReaderOptions = {}) {
    const projectsBaseDir = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    const globalBaseDir = options.globalBaseDir ?? join(homedir(), ".pindie", "global");
    this.revisionDecisionReader = new FileStrategyDecisionStore({ baseDir: projectsBaseDir });
    this.revisionCandidateReader = new FileStrategyCandidateStore({ baseDir: projectsBaseDir });
    this.derivationDecisionReader = new FileStrategyDerivationDecisionStore({ baseDir: projectsBaseDir });
    this.derivationCandidateReader = new FileStrategyDerivationCandidateStore({ baseDir: projectsBaseDir });
    this.globalCandidateReader = new FileStrategyTrustScopeCandidateStore({ baseDir: globalBaseDir });
    this.globalDecisionReader = new FileStrategyTrustScopeDecisionStore({ baseDir: globalBaseDir });
    this.synthesisCandidateReader = new FileStrategySynthesisCandidateStore({ baseDir: globalBaseDir });
    this.synthesisDecisionReader = new FileStrategySynthesisDecisionStore({ baseDir: globalBaseDir });
    this.sourceResolver = new FileStrategyTrustScopeSourceResolver({ projectsBaseDir });
  }

  async readProjectId(projectId: string): Promise<TrustedStrategyPortfolio> {
    if (!isCanonicalStrategyTrustScopeProjectId(projectId)) {
      throw new Error("Trusted Strategy portfolio reads require a canonical project identity.");
    }
    const [promotedCatalog, promotedDerivedCatalog, globalProjection] = await Promise.all([
      loadPromotedStrategyRevisionCatalogByProjectId(
        projectId,
        this.revisionDecisionReader,
        this.revisionCandidateReader,
      ),
      loadPromotedDerivedStrategyCatalogByProjectId(
        projectId,
        this.derivationDecisionReader,
        this.derivationCandidateReader,
        this.revisionCandidateReader,
      ),
      loadUserGlobalTrustedDerivedStrategyProjection({
        candidateReader: this.globalCandidateReader,
        decisionReader: this.globalDecisionReader,
        sourceResolver: this.sourceResolver,
        synthesisCandidateReader: this.synthesisCandidateReader,
        synthesisDecisionReader: this.synthesisDecisionReader,
      }),
    ]);
    return createTrustedStrategyPortfolioForProjectId(
      projectId,
      promotedCatalog,
      promotedDerivedCatalog,
      globalProjection.entries.map((entry): TrustedPortfolioGlobalEntry => entry.origin === "synthesis"
        ? { origin: "synthesis", sourceProjectIds: [], selection: entry.selection }
        : { origin: "transfer", sourceProjectId: entry.sourceStrategy!.sourceProjectId, selection: entry.selection }),
    );
  }
}

function validateScopeDependencies(
  dependencies: Pick<TrustedStrategyPortfolioLoadDependencies, "scopeCandidateReader" | "scopeDecisionReader" | "scopeSourceResolver" | "synthesisCandidateReader" | "synthesisDecisionReader">,
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
  const synthesisDependencies = [
    dependencies.synthesisCandidateReader,
    dependencies.synthesisDecisionReader,
  ];
  if (
    synthesisDependencies.some((dependency) => dependency !== undefined) &&
    synthesisDependencies.some((dependency) => dependency === undefined)
  ) {
    throw new Error("User-global Synthesis authority dependencies are incomplete.");
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
      synthesisCandidateReader: dependencies.synthesisCandidateReader,
      synthesisDecisionReader: dependencies.synthesisDecisionReader,
    });
    userGlobalEntries = projection.entries.map((entry): TrustedPortfolioGlobalEntry => entry.origin === "synthesis"
      ? { origin: "synthesis", sourceProjectIds: [], selection: entry.selection }
      : { origin: "transfer", sourceProjectId: entry.sourceStrategy!.sourceProjectId, selection: entry.selection });
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
