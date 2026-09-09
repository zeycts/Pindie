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
import {
  MAX_USER_GLOBAL_DERIVED_STRATEGIES,
} from "./strategy-trust-scope-constants.ts";
import type {
  StrategyTrustScopeCandidateReader,
} from "./strategy-trust-scope-candidates.ts";
import type {
  StrategyTrustScopeDecisionReader,
} from "./strategy-trust-scope-decisions.ts";
import type {
  StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
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
const CANONICAL_PROJECT_ID = /^[0-9a-f]{64}$/;
/** Keep the portfolio-facing import compatible with the catalog's SSOT bound. */
export { MAX_PROMOTED_DERIVED_STRATEGIES };
/**
 * Immutable Seeds + maximum promoted Seed revisions + project-local promoted
 * Derived identities + user-global promoted Derived identities.
 */
export const MAX_TRUSTED_PORTFOLIO_ENTRIES =
  SEED_STRATEGIES.length +
  MAX_PROMOTED_STRATEGY_REVISIONS +
  MAX_PROMOTED_DERIVED_STRATEGIES +
  MAX_USER_GLOBAL_DERIVED_STRATEGIES;

export type TrustedPortfolioOrigin =
  | "seed"
  | "promoted-seed-revision"
  | "promoted-derived";

/** Runtime-only trust provenance; never part of the canonical manifest. */
export type TrustedPortfolioTrustOrigin = "seed" | "project-local" | "user-global";

export interface TrustedPortfolioTrustMetadata {
  readonly origins: readonly TrustedPortfolioTrustOrigin[];
  readonly sourceProjectIds: readonly string[];
}

/** A validated exact Derived selection resolved from the user-global layer. */
export interface TrustedPortfolioGlobalEntry {
  readonly sourceProjectId: string;
  readonly selection: StrategyRevisionSelection;
}

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
  /** Optional for compatibility with frozen test seams; runtime entries set it. */
  readonly trust?: TrustedPortfolioTrustMetadata;
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

/** Runtime-only presentation state for the optional user-global layer. */
export type TrustedPortfolioGlobalLayer =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** A coherent local-or-complete portfolio plus optional-global diagnostics. */
export interface TrustedStrategyPortfolioPresentation {
  readonly portfolio: TrustedStrategyPortfolio;
  readonly globalLayer: TrustedPortfolioGlobalLayer;
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

const TRUST_ORIGIN_ORDER: Record<TrustedPortfolioTrustOrigin, number> = {
  seed: 0,
  "user-global": 1,
  "project-local": 2,
};

function trustMetadata(
  origins: readonly TrustedPortfolioTrustOrigin[],
  sourceProjectIds: readonly string[],
): TrustedPortfolioTrustMetadata {
  return Object.freeze({
    origins: Object.freeze([...new Set(origins)].sort((left, right) =>
      TRUST_ORIGIN_ORDER[left] - TRUST_ORIGIN_ORDER[right])),
    sourceProjectIds: Object.freeze([...new Set(sourceProjectIds)].sort(compareText)),
  });
}

function trustForManifest(
  manifest: TrustedPortfolioManifestEntry,
): TrustedPortfolioTrustMetadata {
  return manifest.origin === "seed"
    ? trustMetadata(["seed"], [])
    : trustMetadata(["project-local"], []);
}

function entryTrust(
  entry: TrustedPortfolioResolvedEntry,
): TrustedPortfolioTrustMetadata {
  return entry.trust ?? trustForManifest(entry.manifest);
}

function trustIdentityKey(entry: TrustedPortfolioManifestEntry): string {
  return [
    entry.strategyId,
    entry.kind,
    entry.revisionIdentity,
    entry.revisionFingerprint,
  ].join("\0");
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
    trust: trustMetadata(["seed"], []),
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
    trust: trustMetadata(["project-local"], []),
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
    trust: trustMetadata(["project-local"], []),
  });
}

function globalDerivedResolvedEntry(
  entry: TrustedPortfolioGlobalEntry,
): TrustedPortfolioResolvedEntry {
  const selection = entry.selection;
  if (
    typeof entry.sourceProjectId !== "string" ||
    !CANONICAL_PROJECT_ID.test(entry.sourceProjectId) ||
    selection.revisionStatusAtRun !== "promoted" ||
    getSeedStrategy(selection.strategyId) !== null ||
    selection.revisionIdentity === "seed"
  ) {
    throw new Error("User-global Derived Strategy cannot be resolved into the trusted portfolio.");
  }
  return Object.freeze({
    manifest: Object.freeze({
      origin: "promoted-derived" as const,
      strategyId: selection.strategyId,
      kind: selection.kind,
      revisionIdentity: selection.revisionIdentity,
      revisionFingerprint: selection.revisionFingerprint,
    }),
    semantics: copySemantics(selection.semantics),
    trust: trustMetadata(["user-global"], [entry.sourceProjectId]),
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

/** Construct the current trusted portfolio from immutable trust projections. */
export function createTrustedStrategyPortfolio(
  projectRoot: string,
  promotedCatalog: PromotedStrategyRevisionCatalog,
  promotedDerivedCatalog: PromotedDerivedStrategyCatalog = emptyPromotedDerivedStrategyCatalog(),
  userGlobalEntries: readonly TrustedPortfolioGlobalEntry[] = [],
): TrustedStrategyPortfolio {
  const projectId = getProjectId(projectRoot);
  if (userGlobalEntries.length > MAX_USER_GLOBAL_DERIVED_STRATEGIES) {
    throw new Error(`User-global Derived Strategy capacity exceeds ${MAX_USER_GLOBAL_DERIVED_STRATEGIES}.`);
  }
  const rawResolved = [
    ...SEED_STRATEGIES.map(seedResolvedEntry),
    ...promotedCatalog.entries.map(promotedResolvedEntry),
    ...promotedDerivedCatalog.entries.map(promotedDerivedResolvedEntry),
    ...userGlobalEntries.map(globalDerivedResolvedEntry),
  ].sort((left, right) => compareManifestEntries(left.manifest, right.manifest));

  if (rawResolved.length > MAX_TRUSTED_PORTFOLIO_ENTRIES) {
    throw new Error("Trusted Strategy portfolio exceeds its bounded manifest.");
  }

  // Global and local trust have equal advisory status. Exact identity is the
  // only deduplication key; a different revision under one logical ID is an
  // ambiguity, never a precedence decision.
  const resolvedByIdentity = new Map<string, TrustedPortfolioResolvedEntry>();
  for (const entry of rawResolved) {
    const key = trustIdentityKey(entry.manifest);
    const prior = resolvedByIdentity.get(key);
    if (prior === undefined) {
      resolvedByIdentity.set(key, entry);
      continue;
    }
    if (!semanticsEqual(prior.semantics, entry.semantics)) {
      throw new Error("Trusted Strategy portfolio contains conflicting semantics for one exact revision.");
    }
    const priorTrust = entryTrust(prior);
    const currentTrust = entryTrust(entry);
    resolvedByIdentity.set(key, Object.freeze({
      manifest: prior.manifest,
      semantics: prior.semantics,
      trust: trustMetadata(
        [...priorTrust.origins, ...currentTrust.origins],
        [...priorTrust.sourceProjectIds, ...currentTrust.sourceProjectIds],
      ),
    }));
  }

  const resolved = [...resolvedByIdentity.values()]
    .sort((left, right) => compareManifestEntries(left.manifest, right.manifest));
  if (resolved.length > MAX_TRUSTED_PORTFOLIO_ENTRIES) {
    throw new Error("Trusted Strategy portfolio exceeds its bounded manifest.");
  }
  const derivedLogicalIds = new Map<string, TrustedPortfolioManifestEntry>();
  for (const entry of resolved) {
    if (entry.manifest.origin !== "promoted-derived") continue;
    const prior = derivedLogicalIds.get(entry.manifest.strategyId);
    if (prior !== undefined ||
      SEED_STRATEGIES.some((seed) => seed.id === entry.manifest.strategyId)) {
      if (prior !== undefined && trustIdentityKey(prior) === trustIdentityKey(entry.manifest)) {
        continue;
      }
      throw new Error("Trusted Strategy portfolio contains a duplicate or conflicting Derived logical Strategy identity.");
    }
    derivedLogicalIds.set(entry.manifest.strategyId, entry.manifest);
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
  scopeCandidateReader?: StrategyTrustScopeCandidateReader,
  scopeDecisionReader?: StrategyTrustScopeDecisionReader,
  scopeSourceResolver?: StrategyTrustScopeSourceResolver,
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
  const scopeDependencies = [scopeCandidateReader, scopeDecisionReader, scopeSourceResolver];
  if (scopeDependencies.some((dependency) => dependency !== undefined) &&
    scopeDependencies.some((dependency) => dependency === undefined)) {
    throw new Error("User-global trusted Strategy projection dependencies are incomplete.");
  }
  const userGlobalEntries = scopeCandidateReader !== undefined &&
      scopeDecisionReader !== undefined && scopeSourceResolver !== undefined
    ? (await (async () => {
        const { loadUserGlobalTrustedDerivedStrategyProjection } = await import("./strategy-trust-scope-global.ts");
        return loadUserGlobalTrustedDerivedStrategyProjection({
          candidateReader: scopeCandidateReader,
          decisionReader: scopeDecisionReader,
          sourceResolver: scopeSourceResolver,
        });
      })()).entries.map((entry): TrustedPortfolioGlobalEntry => ({
      sourceProjectId: entry.sourceStrategy.sourceProjectId,
      selection: entry.selection,
    }))
    : [];
  return createTrustedStrategyPortfolio(
    projectRoot,
    promotedCatalog,
    promotedDerivedCatalog,
    userGlobalEntries,
  );
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

const TRUSTED_PORTFOLIO_ORIGIN_LABELS: Record<TrustedPortfolioOrigin, string> = {
  seed: "seed",
  "promoted-seed-revision": "promoted Seed revision",
  "promoted-derived": "promoted Derived Strategy",
};

const TRUSTED_PORTFOLIO_ORIGIN_ORDER: Record<TrustedPortfolioOrigin, number> = {
  seed: 0,
  "promoted-seed-revision": 1,
  "promoted-derived": 2,
};

function formatTrustOrigins(
  entry: TrustedPortfolioResolvedEntry,
): string {
  const trust = entryTrust(entry);
  if (trust.origins.length === 0) return "unavailable";
  return trust.origins.join(" + ");
}

function formatTrustSourceProjects(
  entry: TrustedPortfolioResolvedEntry,
): string | null {
  const sourceProjectIds = entryTrust(entry).sourceProjectIds;
  return sourceProjectIds.length === 0
    ? null
    : sourceProjectIds.map((projectId) => projectId.slice(0, 8)).join(", ");
}

function compareHumanPortfolioEntries(
  left: TrustedPortfolioResolvedEntry,
  right: TrustedPortfolioResolvedEntry,
): number {
  const leftManifest = left.manifest;
  const rightManifest = right.manifest;
  const leftKey = [
    leftManifest.strategyId,
    TRUSTED_PORTFOLIO_ORIGIN_ORDER[leftManifest.origin],
    leftManifest.revisionIdentity,
    leftManifest.revisionFingerprint,
  ].join("\0");
  const rightKey = [
    rightManifest.strategyId,
    TRUSTED_PORTFOLIO_ORIGIN_ORDER[rightManifest.origin],
    rightManifest.revisionIdentity,
    rightManifest.revisionFingerprint,
  ].join("\0");
  return compareText(leftKey, rightKey);
}

function formatTrustedStrategyList(
  portfolio: TrustedStrategyPortfolio,
): string {
  const lines = [
    "Trusted Strategy Portfolio",
    "",
  ];
  const entries = [...portfolio.resolvedEntries].sort(compareHumanPortfolioEntries);
  for (const [kind, heading] of [
    ["approach", "Approaches"],
    ["modifier", "Modifiers"],
  ] as const) {
    lines.push(heading, "");
    const grouped = entries.filter((entry) => entry.manifest.kind === kind);
    if (grouped.length === 0) {
      lines.push("  (none)", "");
      continue;
    }
    for (const entry of grouped) {
      const manifest = entry.manifest;
      const identity = manifest.origin === "seed"
        ? manifest.strategyId
        : `${manifest.strategyId} · promoted ${manifest.revisionIdentity.slice(0, 8)}`;
      const sourceProjects = formatTrustSourceProjects(entry);
      lines.push(
        `  ${identity}`,
        `    ${TRUSTED_PORTFOLIO_ORIGIN_LABELS[manifest.origin]}`,
        `    Trust: ${formatTrustOrigins(entry)}`,
        ...(sourceProjects === null ? [] : [`    Source project: ${sourceProjects}`]),
        `    ${entry.semantics.summary}`,
        "",
      );
    }
  }
  lines.push(
    `Trusted entries: ${portfolio.entries.length}`,
    `Logical Strategy identities: ${trustedLogicalStrategyIds(portfolio).length}`,
  );
  return lines.join("\n");
}

function formatTrustedStrategyDetails(
  portfolio: TrustedStrategyPortfolio,
  strategyId: string,
): string {
  const entries = [...portfolio.resolvedEntries]
    .filter((entry) => entry.manifest.strategyId === strategyId)
    .sort(compareHumanPortfolioEntries);
  const lines = [
    `Trusted Strategy: ${strategyId}`,
    `Trusted entries: ${entries.length}`,
    "",
  ];
  for (const [index, entry] of entries.entries()) {
    const manifest = entry.manifest;
    const semantics = entry.semantics;
    if (entries.length > 1) lines.push(`Entry ${index + 1}`, "");
    lines.push(
      `Logical Strategy ID: ${manifest.strategyId}`,
      `Kind: ${manifest.kind}`,
      `Origin: ${TRUSTED_PORTFOLIO_ORIGIN_LABELS[manifest.origin]}`,
      `Trust: ${formatTrustOrigins(entry)}`,
      ...(formatTrustSourceProjects(entry) === null
        ? []
        : [`Source project: ${formatTrustSourceProjects(entry)}`]),
      `Revision identity: ${manifest.revisionIdentity}`,
      `Revision status: ${manifest.origin === "seed" ? "seed" : "promoted"}`,
      `Revision fingerprint: ${manifest.revisionFingerprint}`,
      `Summary: ${semantics.summary}`,
      "Use when:",
      ...semantics.useWhen.map((value) => `  - ${value}`),
      "Avoid when:",
      ...(semantics.avoidWhen.length > 0
        ? semantics.avoidWhen.map((value) => `  - ${value}`)
        : ["  - none"]),
      "Principles:",
      ...semantics.principles.map((value) => `  - ${value}`),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

/** Render the complete trusted portfolio or one trusted logical identity for Humans. */
export function formatTrustedStrategyPortfolio(
  portfolio: TrustedStrategyPortfolio,
  strategyId?: string,
): string {
  return strategyId === undefined
    ? formatTrustedStrategyList(portfolio)
    : formatTrustedStrategyDetails(portfolio, strategyId);
}

const MAX_TRUSTED_PORTFOLIO_DIAGNOSTIC_LENGTH = 256;

function boundedTrustedPortfolioDiagnostic(reason: string): string {
  const normalized = reason.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length <= MAX_TRUSTED_PORTFOLIO_DIAGNOSTIC_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_TRUSTED_PORTFOLIO_DIAGNOSTIC_LENGTH - 1)}…`;
}

/** Render a coherent portfolio while explaining loss of optional global trust. */
export function formatTrustedStrategyPortfolioPresentation(
  presentation: TrustedStrategyPortfolioPresentation,
  strategyId?: string,
): string {
  const report = formatTrustedStrategyPortfolio(presentation.portfolio, strategyId);
  if (presentation.globalLayer.available) return report;
  return [
    report,
    "",
    "Optional user-global layer: unavailable",
    `  Reason: ${boundedTrustedPortfolioDiagnostic(presentation.globalLayer.reason)}`,
    "  Project-local and immutable Seed Strategies remain available; no unavailable global revision is shown as trusted.",
  ].join("\n");
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
    "Project-local and user-global promoted Strategies available for explicit normal Policy declaration:",
    "Promotion means only that the exact immutable revision is trusted enough to be selectable; it is not a default, recommendation, superiority claim, or causal finding.",
    "Seed revisions remain selectable by their existing shorthand.",
    "",
  ];
  for (const entry of promoted) {
    const manifest = entry.manifest;
    lines.push(
      `- ${manifest.strategyId} (${manifest.kind}) · promoted ${manifest.revisionIdentity.slice(0, 8)}`,
      `  Origin: ${manifest.origin}`,
      `  Trust: ${formatTrustOrigins(entry)}`,
      ...(formatTrustSourceProjects(entry) === null
        ? []
        : [`  Source project: ${formatTrustSourceProjects(entry)}`]),
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
    "The Harness supplies validated kind, semantics, fingerprint, trust-origin presentation, and revisionStatusAtRun = promoted from immutable trust artifacts.",
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