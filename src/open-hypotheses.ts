import { FileDiscoveryHypothesisStore, MAX_OPEN_HYPOTHESES } from "./discovery-hypotheses.ts";
import { matchesLearningArtifactRef, validateStrategyHypothesis, type StrategyHypothesis } from "./learning-v1-contract.ts";
import type { ProjectTrustedStrategyPortfolioReader } from "./strategy-trust-safety.ts";
import { MAX_TRUSTED_PORTFOLIO_ENTRIES, trustedPortfolioFingerprint } from "./strategy-portfolio.ts";

/** Lifecycle projection, not immutable history. Future Evaluation/Decision readers close entries here. */
export interface OpenHypothesisReader {
  readOpen(projectId: string): Promise<readonly StrategyHypothesis[]>;
}
/** D2 has no lifecycle closure yet. Never reads legacy SI/CPL Candidate stores. */
export class D2OpenHypothesisReader implements OpenHypothesisReader {
  private readonly history: Pick<FileDiscoveryHypothesisStore, "list">;
  private readonly portfolio: ProjectTrustedStrategyPortfolioReader | undefined;
  constructor(history: Pick<FileDiscoveryHypothesisStore, "list">, portfolio?: ProjectTrustedStrategyPortfolioReader) { this.history = history; this.portfolio = portfolio; }
  async readOpen(projectId: string): Promise<readonly StrategyHypothesis[]> {
    const entries = await this.history.list(projectId);
    validateOpenHypotheses(entries, projectId);
    validateD2HistoryLineage(entries);
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
      const bases = trust.entries.filter((entry) => entry.strategyId === h.logicalId);
      return h.baseRevisionFingerprint === null ? bases.length === 0 : bases.length === 1 &&
        bases[0]!.kind === h.kind && bases[0]!.revisionFingerprint === h.baseRevisionFingerprint;
    });
  }
}
export function validateOpenHypotheses(entries: readonly StrategyHypothesis[], projectId: string): void {
  if (!Array.isArray(entries) || entries.length > MAX_OPEN_HYPOTHESES ||
    entries.some((h) => !validateStrategyHypothesis(h) || h.scope.kind !== "project" || h.scope.projectId !== projectId) ||
    new Set(entries.map((h) => h.id)).size !== entries.length || new Set(entries.map((h) => h.fingerprint)).size !== entries.length)
    throw new Error("Malformed/ambiguous open hypothesis projection.");
}
// Integrity is the reader's job: future lifecycle readers can resolve CLOSED immutable parents
// without making those parents offerable or rewriting their artifacts.
function validateD2HistoryLineage(entries: readonly StrategyHypothesis[]): void {
  // Today all D2 parents are open.
  for (const h of entries) {
    const seen = new Set<string>();
    let current = h;
    while (current.parent !== null) {
      if (seen.has(current.id)) throw new Error("Cyclic hypothesis lineage.");
      seen.add(current.id);
      const parent = entries.find((p) => matchesLearningArtifactRef(current.parent, p));
      if (!parent || parent.logicalId !== h.logicalId || parent.kind !== h.kind || parent.baseRevisionFingerprint !== h.baseRevisionFingerprint)
        throw new Error("Unresolved hypothesis lineage.");
      current = parent;
    }
  }
}
/** Competing open revisions are not a Harness semantic choice. Omit the entire conflicted lineage. */
export function nonconflictingOpenHypotheses(entries: readonly StrategyHypothesis[]): readonly StrategyHypothesis[] {
  return entries.filter((h) => entries.filter((other) => other.logicalId === h.logicalId).length === 1);
}
