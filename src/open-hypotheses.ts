import { FileDiscoveryHypothesisStore, MAX_OPEN_HYPOTHESES } from "./discovery-hypotheses.ts";
import { validateStrategyHypothesis, type StrategyHypothesis } from "./learning-v1-contract.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import { MAX_TRUSTED_PORTFOLIO_ENTRIES, trustedPortfolioFingerprint, type TrustedStrategyPortfolio } from "./strategy-portfolio.ts";

import { hypothesisLeaves } from "./hypothesis-lineage.ts";

/** Lifecycle projection, not immutable history. Future Evaluation/Decision readers close entries here. */
export interface OpenHypothesisReader {
  readOpen(projectId: string): Promise<readonly StrategyHypothesis[]>;
}
/** Exact revise parents close in the leaf projection; no Evaluation/Decision closure yet. Never reads legacy SI/CPL Candidate stores. */
export class D2OpenHypothesisReader implements OpenHypothesisReader {
  private readonly history: Pick<FileDiscoveryHypothesisStore, "list">;
  private readonly portfolio: ProjectTrustedStrategyPortfolioReader | undefined;
  constructor(history: Pick<FileDiscoveryHypothesisStore, "list">, portfolio?: ProjectTrustedStrategyPortfolioReader) {
    this.history = history; this.portfolio = portfolio;
  }
  async readOpen(projectId: string): Promise<readonly StrategyHypothesis[]> {
    const entries = hypothesisLeaves(await this.history.list(projectId), projectId);
    validateOpenHypotheses(entries, projectId);
    if (!this.portfolio || entries.length === 0) return entries;
    const trust = await this.portfolio.readProjectId(projectId);
    if (trust.projectId !== projectId || trust.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES ||
      trust.entries.length !== trust.resolvedEntries.length || trust.fingerprint !== trustedPortfolioFingerprint(projectId, trust.entries))
      throw new Error("Incoherent offer lineage trust facts.");
    // This is offer eligibility, NOT lifecycle closure: never offer a changed trusted-base
    // revision or a new hypothesis colliding with an already-active trusted logical ID.
    return entries.filter((h) => {
      // Preserve all competing entries so the deterministic selector omits the WHOLE
      // lineage, even when one competing revision also has a stale trusted base.
      if (entries.filter((other) => other.logicalId === h.logicalId).length > 1) return true;
      return matchesCurrentTrustedBase(h, trust);
    });
  }
}
/** Pure check against an already-observed coherent current portfolio; no storage access. */
export function matchesCurrentTrustedBase(h: StrategyHypothesis, trust: TrustedStrategyPortfolio): boolean {
  if (trust.projectId !== (h.scope.kind === "project" ? h.scope.projectId : null) ||
    trust.fingerprint !== trustedPortfolioFingerprint(trust.projectId, trust.entries) || trust.entries.length !== trust.resolvedEntries.length) return false;
  const bases = trust.entries.filter((entry) => entry.strategyId === h.logicalId);
  return h.baseRevisionFingerprint === null ? bases.length === 0 : bases.length === 1 &&
    bases[0]!.kind === h.kind && bases[0]!.revisionFingerprint === h.baseRevisionFingerprint;
}
export function validateOpenHypotheses(entries: readonly StrategyHypothesis[], projectId: string): void {
  if (!Array.isArray(entries) || entries.length > MAX_OPEN_HYPOTHESES ||
    entries.some((h) => !validateStrategyHypothesis(h) || h.scope.kind !== "project" || h.scope.projectId !== projectId) ||
    new Set(entries.map((h) => h.id)).size !== entries.length || new Set(entries.map((h) => h.fingerprint)).size !== entries.length)
    throw new Error("Malformed/ambiguous open hypothesis projection.");
}
/** Shared Discovery comparison projection: strict leaves, then trusted-base and conflict gates. */
export function discoveryOpenHypotheses(history: readonly StrategyHypothesis[], projectId: string, trust: TrustedStrategyPortfolio): readonly StrategyHypothesis[] {
  const leaves = hypothesisLeaves(history, projectId);
  validateOpenHypotheses(leaves, projectId);
  if (trust.projectId !== projectId || trust.entries.length > MAX_TRUSTED_PORTFOLIO_ENTRIES ||
    trust.entries.length !== trust.resolvedEntries.length || trust.fingerprint !== trustedPortfolioFingerprint(projectId, trust.entries))
    throw new Error("Incoherent discovery lineage trust facts.");
  return nonconflictingOpenHypotheses(leaves).filter((h) => matchesCurrentTrustedBase(h, trust));
}
/** Competing open revisions are not a Harness semantic choice. Omit the entire conflicted lineage. */
export function nonconflictingOpenHypotheses(entries: readonly StrategyHypothesis[]): readonly StrategyHypothesis[] {
  return entries.filter((h) => entries.filter((other) => other.logicalId === h.logicalId).length === 1);
}
