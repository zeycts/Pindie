import { createHash } from "node:crypto";

import {
  loadPromotedStrategyRevisionCatalog,
  MAX_PROMOTED_STRATEGY_REVISIONS,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  loadPromotedDerivedStrategyCatalog,
  emptyPromotedDerivedStrategyCatalog,
  MAX_PROMOTED_DERIVED_STRATEGIES,
  type PromotedDerivedStrategyCatalog,
  type StrategyDerivationDecisionReader,
} from "./strategy-derivation-decisions.ts";
import {
  createStrategyRevisionSelection,
  isStrategyRevisionSelector,
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type StrategyRevisionSelection,
  type StrategyRevisionSelector,
} from "./policy.ts";
import type { StrategyDerivationCandidateReader } from "./strategy-derivation-candidates.ts";
import {
  getSeedStrategy,
  SEED_STRATEGIES,
  seedStrategyFingerprint,
  type SeedStrategyKind,
} from "./strategies.ts";
import {
  getProjectId,
} from "./store.ts";
import type { StrategyCandidateReader } from "./strategy-candidates.ts";

export const TRUSTED_PORTFOLIO_FINGERPRINT_VERSION = 1 as const;
/** Keep the portfolio-facing import compatible with the catalog's SSOT bound. */
export { MAX_PROMOTED_DERIVED_STRATEGIES };
/** Immutable Seeds + maximum promoted Seed revisions + promoted Derived identities. */
export const MAX_TRUSTED_PORTFOLIO_ENTRIES =
  SEED_STRATEGIES.length + MAX_PROMOTED_STRATEGY_REVISIONS + MAX_PROMOTED_DERIVED_STRATEGIES;

export type TrustedPortfolioOrigin =
  | "seed"
  | "promoted-seed-revision"
  | "promoted-derived";

/** The only identity facts in the canonical trusted-portfolio manifest. */
export interface TrustedPortfolioManifestEntry {
  readonly origin: TrustedPortfolioOrigin;
  readonly strategyId: string;
  readonly kind: SeedStrategyKind;
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
}

export interface TrustedPortfolioStrategySemantics {
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}

/** Runtime resolution of a manifest entry to its immutable source semantics. */
export interface TrustedPortfolioResolvedEntry {
  readonly manifest: TrustedPortfolioManifestEntry;
  readonly semantics: TrustedPortfolioStrategySemantics;
}

/**
 * Deterministic runtime projection of the currently trusted project-local
 * Strategy portfolio. `entries` is the canonical identity manifest; resolved
 * semantics are kept separately so the manifest cannot become a second source
 * of Strategy prose.
 */
export interface TrustedStrategyPortfolio {
  readonly projectId: string;
  readonly fingerprintVersion: typeof TRUSTED_PORTFOLIO_FINGERPRINT_VERSION;
  readonly fingerprint: string;
  readonly entries: readonly TrustedPortfolioManifestEntry[];
  readonly resolvedEntries: readonly TrustedPortfolioResolvedEntry[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestSortKey(entry: TrustedPortfolioManifestEntry): string {
  return [
    entry.origin,
    entry.strategyId,
    entry.kind,
    entry.revisionIdentity,
    entry.revisionFingerprint,
  ].join("\0");
}

function compareManifestEntries(
  left: TrustedPortfolioManifestEntry,
  right: TrustedPortfolioManifestEntry,
): number {
  return compareText(manifestSortKey(left), manifestSortKey(right));
}

function copySemantics(
  semantics: TrustedPortfolioStrategySemantics,
): TrustedPortfolioStrategySemantics {
  return Object.freeze({
    summary: semantics.summary,
    useWhen: Object.freeze([...semantics.useWhen]),
    avoidWhen: Object.freeze([...semantics.avoidWhen]),
    principles: Object.freeze([...semantics.principles]),
  });
}

function seedResolvedEntry(
  strategy: (typeof SEED_STRATEGIES)[number],
): TrustedPortfolioResolvedEntry {
  const manifest = Object.freeze({
    origin: "seed" as const,
    strategyId: strategy.id,
    kind: strategy.kind,
    revisionIdentity: "seed",
    revisionFingerprint: seedStrategyFingerprint(strategy),
  });
  return Object.freeze({
    manifest,
    semantics: copySemantics({
      summary: strategy.summary,
      useWhen: strategy.useWhen,
      avoidWhen: strategy.avoidWhen ?? [],
      principles: strategy.principles,
    }),
  });
}

function promotedResolvedEntry(
  entry: PromotedStrategyRevisionCatalog["entries"][number],
): TrustedPortfolioResolvedEntry {
  const selection = entry.selection;
  if (
    selection.revisionStatusAtRun !== "promoted" ||
    getSeedStrategy(selection.strategyId) === null ||
    entry.candidate.target.strategyId !== selection.strategyId ||
    entry.candidate.target.kind !== selection.kind ||
    entry.candidate.candidateId !== selection.revisionIdentity ||
    entry.candidate.target.baseFingerprint === ""
  ) {
    throw new Error("Promoted Seed revision cannot be resolved into the trusted portfolio.");
  }
  const manifest = Object.freeze({
    origin: "promoted-seed-revision" as const,
    strategyId: strategySelectionId(selection),
    kind: selection.kind,
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
  });
  return Object.freeze({
    manifest,
    semantics: copySemantics({
      summary: selection.semantics.summary,
      useWhen: selection.semantics.useWhen,
      avoidWhen: selection.semantics.avoidWhen,
      principles: selection.semantics.principles,
    }),
  });
}

function promotedDerivedResolvedEntry(
  entry: PromotedDerivedStrategyCatalog["entries"][number],
): TrustedPortfolioResolvedEntry {
  const selection = entry.selection;
  if (
    selection.revisionStatusAtRun !== "promoted" ||
    getSeedStrategy(selection.strategyId) !== null ||
    entry.candidate.proposal.strategyId !== selection.strategyId ||
    entry.candidate.proposal.kind !== selection.kind ||
    entry.candidate.candidateId !== selection.revisionIdentity
  ) {
    throw new Error("Promoted Derived Strategy cannot be resolved into the trusted portfolio.");
  }
  return Object.freeze({
    manifest: Object.freeze({
      origin: "promoted-derived" as const,
      strategyId: selection.strategyId,
      kind: selection.kind,
      revisionIdentity: selection.revisionIdentity,
      revisionFingerprint: selection.revisionFingerprint,
    }),
    semantics: copySemantics({
      summary: selection.semantics.summary,
      useWhen: selection.semantics.useWhen,
      avoidWhen: selection.semantics.avoidWhen,
      principles: selection.semantics.principles,
    }),
  });
}

/**
 * Hash the canonical project-local manifest projection. Sorting here as well
 * as in the portfolio constructor keeps the exported fingerprint helper
 * deterministic for callers that hold the same manifest in another order.
 */
export function trustedPortfolioFingerprint(
  projectId: string,
  entries: readonly TrustedPortfolioManifestEntry[],
): string {
  const canonical = {
    fingerprintVersion: TRUSTED_PORTFOLIO_FINGERPRINT_VERSION,
    projectId,
    entries: [...entries].sort(compareManifestEntries).map((entry) => ({
      origin: entry.origin,
      strategyId: entry.strategyId,
      kind: entry.kind,
      revisionIdentity: entry.revisionIdentity,
      revisionFingerprint: entry.revisionFingerprint,
    })),
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

export const computeTrustedPortfolioFingerprint = trustedPortfolioFingerprint;
export const projectTrustedPortfolioFingerprint = trustedPortfolioFingerprint;

/** Construct the current trusted portfolio from immutable Seeds and v0.6 trust. */
export function createTrustedStrategyPortfolio(
  projectRoot: string,
  promotedCatalog: PromotedStrategyRevisionCatalog,
  promotedDerivedCatalog: PromotedDerivedStrategyCatalog = emptyPromotedDerivedStrategyCatalog(),
): TrustedStrategyPortfolio {
  const projectId = getProjectId(projectRoot);
  const resolved = [
    ...SEED_STRATEGIES.map(seedResolvedEntry),
    ...promotedCatalog.entries.map(promotedResolvedEntry),
    ...promotedDerivedCatalog.entries.map(promotedDerivedResolvedEntry),
  ].sort((left, right) => compareManifestEntries(left.manifest, right.manifest));

  if (resolved.length > MAX_TRUSTED_PORTFOLIO_ENTRIES) {
    throw new Error("Trusted Strategy portfolio exceeds its bounded manifest.");
  }
  const seen = new Set<string>();
  const derivedLogicalIds = new Set<string>();
  for (const entry of resolved) {
    const key = manifestSortKey(entry.manifest);
    if (seen.has(key)) throw new Error("Trusted Strategy portfolio contains duplicate manifest entries.");
    seen.add(key);
    if (entry.manifest.origin === "promoted-derived") {
      if (derivedLogicalIds.has(entry.manifest.strategyId) ||
        SEED_STRATEGIES.some((seed) => seed.id === entry.manifest.strategyId)) {
        throw new Error("Trusted Strategy portfolio contains a duplicate Derived logical Strategy identity.");
      }
      derivedLogicalIds.add(entry.manifest.strategyId);
    }
  }

  const entries = Object.freeze(resolved.map((entry) => entry.manifest));
  const fingerprint = trustedPortfolioFingerprint(projectId, entries);
  return Object.freeze({
    projectId,
    fingerprintVersion: TRUSTED_PORTFOLIO_FINGERPRINT_VERSION,
    fingerprint,
    entries,
    resolvedEntries: Object.freeze(resolved),
  });
}

export const buildTrustedStrategyPortfolio = createTrustedStrategyPortfolio;
export const createTrustedPortfolio = createTrustedStrategyPortfolio;

/** Reconstruct the trusted portfolio; trust-artifact failures are propagated. */
export async function loadTrustedStrategyPortfolio(
  projectRoot: string,
  decisionReader: StrategyRevisionDecisionReader,
  candidateReader: StrategyCandidateReader,
  derivationDecisionReader?: StrategyDerivationDecisionReader,
  derivationCandidateReader?: StrategyDerivationCandidateReader,
): Promise<TrustedStrategyPortfolio> {
  const promotedCatalog = await loadPromotedStrategyRevisionCatalog(
    projectRoot,
    decisionReader,
    candidateReader,
  );
  const promotedDerivedCatalog = derivationDecisionReader !== undefined &&
      derivationCandidateReader !== undefined
    ? await loadPromotedDerivedStrategyCatalog(
      projectRoot,
      derivationDecisionReader,
      derivationCandidateReader,
      candidateReader,
    )
    : emptyPromotedDerivedStrategyCatalog();
  return createTrustedStrategyPortfolio(projectRoot, promotedCatalog, promotedDerivedCatalog);
}

function semanticsEqual(
  left: TrustedPortfolioStrategySemantics,
  right: TrustedPortfolioStrategySemantics,
): boolean {
  return JSON.stringify({
    summary: left.summary,
    useWhen: [...left.useWhen],
    avoidWhen: [...left.avoidWhen],
    principles: [...left.principles],
  }) === JSON.stringify({
    summary: right.summary,
    useWhen: [...right.useWhen],
    avoidWhen: [...right.avoidWhen],
    principles: [...right.principles],
  });
}

/** Resolve an exact Run selection against this captured trusted portfolio. */
export function resolveTrustedPortfolioSelection(
  selection: StrategyRevisionSelection,
  portfolio: TrustedStrategyPortfolio,
): TrustedPortfolioResolvedEntry | null {
  const status = strategySelectionRevisionStatus(selection);
  if (status !== "seed" && status !== "promoted") return null;
  const origins = status === "seed"
    ? ["seed"]
    : ["promoted-seed-revision", "promoted-derived"];
  if (status === "seed" && strategySelectionRevisionIdentity(selection) !== "seed") return null;
  const found = portfolio.resolvedEntries.find((entry) => {
    const manifest = entry.manifest;
    return origins.includes(manifest.origin) &&
      manifest.strategyId === strategySelectionId(selection) &&
      manifest.kind === selection.kind &&
      manifest.revisionIdentity === strategySelectionRevisionIdentity(selection) &&
      manifest.revisionFingerprint === strategySelectionRevisionFingerprint(selection);
  });
  if (found === undefined) return null;

  const semantics = selection.semantics;
  return semanticsEqual(found.semantics, {
    summary: semantics.summary,
    useWhen: semantics.useWhen,
    avoidWhen: semantics.avoidWhen,
    principles: semantics.principles,
  }) ? found : null;
}

export function trustedLogicalStrategyIds(
  portfolio: TrustedStrategyPortfolio,
): readonly string[] {
  return Object.freeze([...new Set(portfolio.entries.map((entry) => entry.strategyId))]
    .sort(compareText));
}

export function trustedPortfolioSemanticEntries(
  portfolio: TrustedStrategyPortfolio,
): readonly TrustedPortfolioResolvedEntry[] {
  return portfolio.resolvedEntries;
}

/** Resolve an exact trusted selection with all semantics/status supplied by the Harness. */
export function resolveTrustedPortfolioRevisionSelection(
  selection: StrategyRevisionSelection | StrategyRevisionSelector,
  portfolio: TrustedStrategyPortfolio,
  expectedKind?: SeedStrategyKind,
): StrategyRevisionSelection | null {
  const resolved = isStrategyRevisionSelector(selection)
    ? expectedKind === undefined
      ? null
      : (() => {
          const selector = selection as StrategyRevisionSelector;
          return portfolio.resolvedEntries.find((entry) =>
            entry.manifest.origin !== "seed" &&
            entry.manifest.kind === expectedKind &&
            entry.manifest.strategyId === selector.strategyId &&
            entry.manifest.revisionIdentity === selector.revisionIdentity &&
            entry.manifest.revisionFingerprint === selector.revisionFingerprint) ?? null;
        })()
    : resolveTrustedPortfolioSelection(selection, portfolio);
  if (resolved === null || (expectedKind !== undefined && resolved.manifest.kind !== expectedKind)) return null;
  return createStrategyRevisionSelection({
    strategyId: resolved.manifest.strategyId,
    kind: resolved.manifest.kind,
    revisionIdentity: resolved.manifest.revisionIdentity,
    revisionFingerprint: resolved.manifest.revisionFingerprint,
    revisionStatusAtRun: resolved.manifest.origin === "seed" ? "seed" : "promoted",
    semantics: resolved.semantics,
  });
}

/** Render the bounded promoted Seed-revision and Derived catalog for normal context. */
export function formatPromotedTrustedStrategyPortfolio(
  portfolio: TrustedStrategyPortfolio | null,
): string {
  if (portfolio === null) return "";
  const promoted = portfolio.resolvedEntries.filter((entry) => entry.manifest.origin !== "seed");
  if (promoted.length === 0) return "";
  const lines = [
    "<PINDIE_PROMOTED_STRATEGIES>",
    "Project-local promoted Strategies available for explicit normal Policy declaration:",
    "Promotion means only that the exact immutable revision is trusted enough to be selectable; it is not a default, recommendation, superiority claim, or causal finding.",
    "Seed revisions remain selectable by their existing shorthand.",
    "",
  ];
  for (const entry of promoted) {
    const manifest = entry.manifest;
    lines.push(
      `- ${manifest.strategyId} (${manifest.kind}) · promoted ${manifest.revisionIdentity.slice(0, 8)}`,
      `  Origin: ${manifest.origin}`,
      `  Revision fingerprint: ${manifest.revisionFingerprint}`,
      "  Revision status: promoted",
      "  Exact selector:",
      JSON.stringify({
        strategyId: manifest.strategyId,
        revisionIdentity: manifest.revisionIdentity,
        revisionFingerprint: manifest.revisionFingerprint,
      }, null, 2),
      `  Summary: ${entry.semantics.summary}`,
      "  Use when:",
      ...entry.semantics.useWhen.map((value) => `  - ${value}`),
      "  Avoid when:",
      ...(entry.semantics.avoidWhen.length > 0
        ? entry.semantics.avoidWhen.map((value) => `  - ${value}`)
        : ["  - none"]),
      "  Principles:",
      ...entry.semantics.principles.map((value) => `  - ${value}`),
      "",
    );
  }
  lines.push(
    "The Harness supplies validated kind, semantics, fingerprint, and revisionStatusAtRun = promoted from immutable trust artifacts.",
    "Inactive and rejected Candidates are not included in normal context.",
    "</PINDIE_PROMOTED_STRATEGIES>",
  );
  return lines.join("\n");
}

export const renderPromotedTrustedStrategyPortfolio = formatPromotedTrustedStrategyPortfolio;

/** Compare only the canonical identity snapshot retained by a Candidate. */
export function sameTrustedPortfolioSnapshot(
  left: Pick<TrustedStrategyPortfolio, "projectId" | "fingerprintVersion" | "fingerprint" | "entries">,
  right: Pick<TrustedStrategyPortfolio, "projectId" | "fingerprintVersion" | "fingerprint" | "entries">,
): boolean {
  return left.projectId === right.projectId &&
    left.fingerprintVersion === right.fingerprintVersion &&
    left.fingerprint === right.fingerprint &&
    JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

/** A small exact identity helper for callers that need no semantic lookup. */
export function trustedManifestEntryIdentity(
  entry: TrustedPortfolioManifestEntry,
): string {
  return `${entry.origin}\0${entry.strategyId}\0${entry.kind}\0${entry.revisionIdentity}\0${entry.revisionFingerprint}`;
}