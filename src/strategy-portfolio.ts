import { createHash } from "node:crypto";

import {
  loadPromotedStrategyRevisionCatalog,
  type PromotedStrategyRevisionCatalog,
  type StrategyRevisionDecisionReader,
} from "./strategy-decisions.ts";
import {
  strategySelectionId,
  strategySelectionRevisionFingerprint,
  strategySelectionRevisionIdentity,
  strategySelectionRevisionStatus,
  type StrategyRevisionSelection,
} from "./policy.ts";
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
/** 7 immutable Seeds + 7 frozen v0.6 promoted Seed revisions + future room. */
export const MAX_TRUSTED_PORTFOLIO_ENTRIES = 22;

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
): TrustedStrategyPortfolio {
  const projectId = getProjectId(projectRoot);
  const resolved = [
    ...SEED_STRATEGIES.map(seedResolvedEntry),
    ...promotedCatalog.entries.map(promotedResolvedEntry),
  ].sort((left, right) => compareManifestEntries(left.manifest, right.manifest));

  if (resolved.length > MAX_TRUSTED_PORTFOLIO_ENTRIES) {
    throw new Error("Trusted Strategy portfolio exceeds its bounded manifest.");
  }
  const seen = new Set<string>();
  for (const entry of resolved) {
    const key = manifestSortKey(entry.manifest);
    if (seen.has(key)) throw new Error("Trusted Strategy portfolio contains duplicate manifest entries.");
    seen.add(key);
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
): Promise<TrustedStrategyPortfolio> {
  const promotedCatalog = await loadPromotedStrategyRevisionCatalog(
    projectRoot,
    decisionReader,
    candidateReader,
  );
  return createTrustedStrategyPortfolio(projectRoot, promotedCatalog);
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
  const origin = status === "seed" ? "seed" : undefined;
  if (status === "seed" && strategySelectionRevisionIdentity(selection) !== "seed") return null;
  const found = portfolio.resolvedEntries.find((entry) => {
    const manifest = entry.manifest;
    return (origin === undefined || manifest.origin === origin) &&
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