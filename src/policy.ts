import {
  SEED_STRATEGIES,
  seedStrategyFingerprint,
  seedStrategySemantics,
  type SeedStrategy,
  type SeedStrategyKind,
} from "./strategies.ts";

export type StrategyRevisionIdentity = "seed" | string;
export type StrategyRevisionStatusAtRun = "seed" | "trial" | "promoted";

/** Compact model-facing selector for one exact non-Seed revision. */
export interface StrategyRevisionSelector {
  readonly strategyId: string;
  readonly revisionIdentity: string;
  readonly revisionFingerprint: string;
}

export interface StrategyRevisionSemantics {
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}

/** Canonical serialized identity and semantics for one Strategy revision. */
export interface SerializedStrategyRevisionSelection {
  readonly strategyId: string;
  readonly kind: SeedStrategyKind;
  readonly revisionIdentity: StrategyRevisionIdentity;
  readonly revisionFingerprint: string;
  readonly revisionStatusAtRun: StrategyRevisionStatusAtRun;
  readonly semantics: StrategyRevisionSemantics;
}

/**
 * A revision-aware Strategy selection with a backwards-compatible Seed view.
 *
 * Seed selections created by createPolicySnapshot keep the old enumerable
 * `{ id, kind, summary, useWhen, avoidWhen, principles }` shape. Revision
 * identity and canonical serialized semantics are non-enumerable on that
 * runtime view. Candidate/future selections use the canonical serialized
 * fields and expose the legacy fields as non-enumerable aliases.
 */
export interface StrategyRevisionSelection extends SerializedStrategyRevisionSelection {
  /** Backwards-compatible logical Strategy ID. */
  readonly id: string;
  /** Backwards-compatible direct semantic fields. */
  readonly summary: string;
  readonly useWhen: readonly string[];
  readonly avoidWhen: readonly string[];
  readonly principles: readonly string[];
}

export type PolicyStrategySelection = SeedStrategy | StrategyRevisionSelection;

/** The model-declared cognitive policy for one Agent Run. */
export interface PolicySnapshot {
  readonly approach: PolicyStrategySelection;
  readonly modifiers: readonly PolicyStrategySelection[];
}

const CANONICAL_REVISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION_FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const REVISION_SELECTOR_FIELDS = [
  "strategyId",
  "revisionIdentity",
  "revisionFingerprint",
] as const;
const MAX_SUMMARY_LENGTH = 512;
const MAX_GUIDANCE_LENGTH = 256;
const MAX_GUIDANCE_ITEMS = 8;

function invalid(message: string): never {
  throw new Error(`Invalid Strategy revision: ${message}`);
}

function invalidPolicyInput(message: string): never {
  throw new Error(`Invalid pindie_policy_set input: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copySemantics(semantics: StrategyRevisionSemantics): StrategyRevisionSemantics {
  return Object.freeze({
    summary: semantics.summary,
    useWhen: Object.freeze([...semantics.useWhen]),
    avoidWhen: Object.freeze([...semantics.avoidWhen]),
    principles: Object.freeze([...semantics.principles]),
  });
}

function hasExactFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length &&
    actual.every((field, index) => field === expected[index]);
}

/** Validate the compact selector shape without resolving its revision. */
export function isStrategyRevisionSelector(
  value: unknown,
): value is StrategyRevisionSelector {
  return isRecord(value) &&
    hasExactFields(value, REVISION_SELECTOR_FIELDS) &&
    typeof value.strategyId === "string" &&
    value.strategyId.trim() !== "" &&
    typeof value.revisionIdentity === "string" &&
    CANONICAL_REVISION_ID.test(value.revisionIdentity) &&
    typeof value.revisionFingerprint === "string" &&
    REVISION_FINGERPRINT.test(value.revisionFingerprint);
}

function defineHidden<T extends object, K extends string, V>(
  target: T,
  key: K,
  value: V,
): void {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    writable: false,
    value,
  });
}

function legacySeedSelection(strategy: SeedStrategy): StrategyRevisionSelection {
  const semantics = copySemantics(seedStrategySemantics(strategy));
  const selection = {
    id: strategy.id,
    kind: strategy.kind,
    summary: semantics.summary,
    useWhen: semantics.useWhen,
    avoidWhen: semantics.avoidWhen,
    principles: semantics.principles,
  } as unknown as StrategyRevisionSelection;
  defineHidden(selection, "strategyId", strategy.id);
  defineHidden(selection, "revisionIdentity", "seed");
  defineHidden(selection, "revisionFingerprint", seedStrategyFingerprint(strategy));
  defineHidden(selection, "revisionStatusAtRun", "seed");
  defineHidden(selection, "semantics", semantics);
  return Object.freeze(selection);
}

function canonicalRevisionSelection(
  serialized: SerializedStrategyRevisionSelection,
): StrategyRevisionSelection {
  const semantics = copySemantics(serialized.semantics);
  const selection = {
    strategyId: serialized.strategyId,
    kind: serialized.kind,
    revisionIdentity: serialized.revisionIdentity,
    revisionFingerprint: serialized.revisionFingerprint,
    revisionStatusAtRun: serialized.revisionStatusAtRun,
    semantics,
  } as unknown as StrategyRevisionSelection;
  defineHidden(selection, "id", serialized.strategyId);
  defineHidden(selection, "summary", semantics.summary);
  defineHidden(selection, "useWhen", semantics.useWhen);
  defineHidden(selection, "avoidWhen", semantics.avoidWhen);
  defineHidden(selection, "principles", semantics.principles);
  return Object.freeze(selection);
}

function selectionId(selection: PolicyStrategySelection): string {
  const value = selection as Partial<StrategyRevisionSelection>;
  return typeof value.strategyId === "string" ? value.strategyId : selection.id;
}

function selectionKind(selection: PolicyStrategySelection): SeedStrategyKind {
  return selection.kind;
}

function selectionSemantics(selection: PolicyStrategySelection): StrategyRevisionSemantics {
  const value = selection as Partial<StrategyRevisionSelection>;
  if (value.semantics !== undefined) return copySemantics(value.semantics);
  return copySemantics({
    summary: selection.summary,
    useWhen: selection.useWhen,
    avoidWhen: selection.avoidWhen ?? [],
    principles: selection.principles,
  });
}

/** Return the logical Strategy ID independent of revision representation. */
export function strategySelectionId(selection: PolicyStrategySelection): string {
  return selectionId(selection);
}

/** Return the exact revision identity, defaulting legacy Seed objects to `seed`. */
export function strategySelectionRevisionIdentity(
  selection: PolicyStrategySelection,
): StrategyRevisionIdentity {
  const value = selection as Partial<StrategyRevisionSelection>;
  return typeof value.revisionIdentity === "string"
    ? value.revisionIdentity
    : "seed";
}

/** Return the exact revision fingerprint, deriving it for legacy Seed objects. */
export function strategySelectionRevisionFingerprint(
  selection: PolicyStrategySelection,
): string {
  const value = selection as Partial<StrategyRevisionSelection>;
  if (typeof value.revisionFingerprint === "string") return value.revisionFingerprint;
  const seed = SEED_STRATEGIES.find((candidate) =>
    candidate.id === selectionId(selection) && candidate.kind === selectionKind(selection));
  return seed === undefined ? "" : seedStrategyFingerprint(seed);
}

/** Return the status recorded for this revision in a Run. */
export function strategySelectionRevisionStatus(
  selection: PolicyStrategySelection,
): StrategyRevisionStatusAtRun {
  const value = selection as Partial<StrategyRevisionSelection>;
  return value.revisionStatusAtRun ?? "seed";
}

/** True only for the exact immutable Seed revision of a canonical Strategy. */
export function isSeedStrategySelection(
  selection: PolicyStrategySelection,
): boolean {
  const seed = SEED_STRATEGIES.find((candidate) =>
    candidate.id === selectionId(selection) && candidate.kind === selectionKind(selection));
  if (
    seed === undefined ||
    strategySelectionRevisionIdentity(selection) !== "seed" ||
    strategySelectionRevisionStatus(selection) !== "seed" ||
    strategySelectionRevisionFingerprint(selection) !== seedStrategyFingerprint(seed)
  ) return false;
  try {
    return JSON.stringify(selectionSemantics(selection)) === JSON.stringify({
      summary: seed.summary,
      useWhen: [...seed.useWhen],
      avoidWhen: [...(seed.avoidWhen ?? [])],
      principles: [...seed.principles],
    });
  } catch {
    return false;
  }
}

/** Convert a runtime selection to the bounded canonical v4 representation. */
export function serializeStrategyRevisionSelection(
  selection: PolicyStrategySelection,
): StrategyRevisionSelection {
  return createStrategyRevisionSelection({
    strategyId: selectionId(selection),
    kind: selectionKind(selection),
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
    revisionStatusAtRun: strategySelectionRevisionStatus(selection),
    semantics: selectionSemantics(selection),
  });
}

/** Convert a runtime Policy Snapshot to its bounded canonical v4 representation. */
export function serializePolicySnapshot(
  snapshot: PolicySnapshot,
): PolicySnapshot {
  return Object.freeze({
    approach: serializeStrategyRevisionSelection(snapshot.approach),
    modifiers: Object.freeze(snapshot.modifiers.map(serializeStrategyRevisionSelection)),
  });
}

/**
 * Construct a revision-aware selection for internal representation/evaluation.
 * This is not an activation path and does not make an inactive Candidate
 * selectable by the model-facing policy tool.
 */
export function createStrategyRevisionSelection(
  value: unknown,
): StrategyRevisionSelection {
  if (!isRecord(value)) return invalid("a Strategy revision selection is required.");
  const strategyId = value.strategyId;
  const kind = value.kind;
  const revisionIdentity = value.revisionIdentity;
  const revisionFingerprint = value.revisionFingerprint;
  const revisionStatusAtRun = value.revisionStatusAtRun;
  const semanticsValue = value.semantics;
  if (
    typeof strategyId !== "string" || strategyId.trim() === "" ||
    (kind !== "approach" && kind !== "modifier") ||
    typeof revisionIdentity !== "string" || revisionIdentity.trim() === "" ||
    typeof revisionFingerprint !== "string" ||
    (revisionStatusAtRun !== "seed" &&
      revisionStatusAtRun !== "trial" &&
      revisionStatusAtRun !== "promoted") ||
    !isRecord(semanticsValue)
  ) return invalid("selection identity and semantics are required.");

  const seed = SEED_STRATEGIES.find((candidate) =>
    candidate.id === strategyId && candidate.kind === kind);
  if (seed === undefined) {
    return invalid(`'${strategyId}' is not a canonical Seed ${kind} Strategy.`);
  }

  const summary = semanticsValue.summary;
  const useWhen = semanticsValue.useWhen;
  const avoidWhen = semanticsValue.avoidWhen;
  const principles = semanticsValue.principles;
  const arrays = [useWhen, avoidWhen, principles] as unknown as unknown[][];
  if (
    typeof summary !== "string" || summary.trim() === "" || summary.length > MAX_SUMMARY_LENGTH ||
    !Array.isArray(useWhen) || !Array.isArray(avoidWhen) || !Array.isArray(principles) ||
    useWhen.length < 1 || useWhen.length > MAX_GUIDANCE_ITEMS ||
    avoidWhen.length > MAX_GUIDANCE_ITEMS ||
    principles.length < 1 || principles.length > MAX_GUIDANCE_ITEMS ||
    arrays.some((items) => items.some((item: unknown) =>
      typeof item !== "string" || item.trim() === "" || item.length > MAX_GUIDANCE_LENGTH))
  ) return invalid("bounded revision semantics are invalid.");

  if (revisionIdentity === "seed") {
    if (
      revisionStatusAtRun !== "seed" ||
      revisionFingerprint !== seedStrategyFingerprint(seed) ||
      JSON.stringify({ summary, useWhen, avoidWhen, principles }) !==
        JSON.stringify({
          summary: seed.summary,
          useWhen: [...seed.useWhen],
          avoidWhen: [...(seed.avoidWhen ?? [])],
          principles: [...seed.principles],
        })
    ) return invalid("the Seed revision identity, fingerprint, or semantics do not match the catalog.");
  } else if (
    !CANONICAL_REVISION_ID.test(revisionIdentity) ||
    revisionStatusAtRun === "seed" ||
    !REVISION_FINGERPRINT.test(revisionFingerprint)
  ) {
    return invalid("non-Seed revisions require a UUID-v4 identity, SHA-256 fingerprint, and trial/promoted status.");
  }

  return canonicalRevisionSelection({
    strategyId,
    kind,
    revisionIdentity,
    revisionFingerprint,
    revisionStatusAtRun,
    semantics: {
      summary,
      useWhen: useWhen as string[],
      avoidWhen: avoidWhen as string[],
      principles: principles as string[],
    },
  });
}

/** Return the immutable Seed revision in the legacy-compatible runtime shape. */
export function createSeedStrategyRevisionSelection(
  strategy: SeedStrategy,
): StrategyRevisionSelection {
  const canonical = SEED_STRATEGIES.find((candidate) =>
    candidate.id === strategy.id && candidate.kind === strategy.kind);
  if (canonical === undefined) {
    return invalid(`'${strategy.id}' is not a canonical Seed ${strategy.kind} Strategy.`);
  }
  return legacySeedSelection(canonical);
}

function selectionForPolicy(
  value: unknown,
  expectedKind: SeedStrategyKind,
): StrategyRevisionSelection {
  if (typeof value === "string") {
    const seed = SEED_STRATEGIES.find((candidate) =>
      candidate.id === value && candidate.kind === expectedKind);
    if (seed === undefined) {
      return invalid(`${expectedKind} '${value}' is not a Seed ${expectedKind} Strategy.`);
    }
    return createSeedStrategyRevisionSelection(seed);
  }
  if (isRecord(value)) {
    const selection = createStrategyRevisionSelection(value);
    if (selection.kind !== expectedKind) {
      return invalid(`${expectedKind} selection has the wrong Strategy kind.`);
    }
    return selection;
  }
  return invalid(`${expectedKind} must be a Seed Strategy ID.`);
}

/**
 * Construct a Policy Snapshot from already validated revision selections.
 * This representation helper is intentionally separate from the ordinary
 * Seed-ID-only createPolicySnapshot/model tool path.
 */
export function createPolicySnapshotFromRevisions(
  input: unknown,
): PolicySnapshot {
  if (!isRecord(input)) return invalid("an approach is required.");
  const approach = selectionForPolicy(input.approach, "approach");
  const rawModifiers = input.modifiers;
  if (rawModifiers !== undefined && !Array.isArray(rawModifiers)) {
    return invalid("modifiers must be an array of Strategy revisions.");
  }
  const modifiers = (rawModifiers ?? []).map((modifier) =>
    selectionForPolicy(modifier, "modifier"));
  if (new Set(modifiers.map((modifier) => selectionId(modifier))).size !== modifiers.length) {
    return invalid("modifiers must be unique by logical Strategy identity.");
  }
  return Object.freeze({
    approach,
    modifiers: Object.freeze(modifiers),
  });
}

function seedStrategy(
  value: unknown,
  field: "approach" | "modifier",
): StrategyRevisionSelection {
  if (typeof value !== "string" || value.trim() === "") {
    return invalidPolicyInput(`${field} must be a Seed Strategy ID.`);
  }
  const strategy = SEED_STRATEGIES.find((candidate) => candidate.id === value);
  if (strategy === undefined) {
    return invalidPolicyInput(`${field} '${value}' is not a Seed ${field} Strategy.`);
  }
  if (strategy.kind !== field) {
    return invalidPolicyInput(`${field} '${value}' must be a Seed ${field} Strategy.`);
  }
  return createSeedStrategyRevisionSelection(strategy);
}

/** Stable identity for a complete revision-aware Policy. */
export function policySnapshotIdentity(snapshot: PolicySnapshot): string {
  const identity = (selection: PolicyStrategySelection) => ({
    strategyId: selectionId(selection),
    kind: selectionKind(selection),
    revisionIdentity: strategySelectionRevisionIdentity(selection),
    revisionFingerprint: strategySelectionRevisionFingerprint(selection),
  });
  const modifiers = [...snapshot.modifiers]
    .map(identity)
    .sort((left, right) => {
      const leftText = JSON.stringify(left);
      const rightText = JSON.stringify(right);
      return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
    });
  return JSON.stringify({
    approach: identity(snapshot.approach),
    modifiers,
  });
}

/** Resolve one structured Seed-only declaration against the immutable catalog. */
export function createPolicySnapshot(input: unknown): PolicySnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidPolicyInput("an approach is required.");
  }

  const declaration = input as {
    approach?: unknown;
    modifiers?: unknown;
  };
  const approach = seedStrategy(declaration.approach, "approach");
  const rawModifiers = declaration.modifiers;
  if (rawModifiers !== undefined && !Array.isArray(rawModifiers)) {
    return invalidPolicyInput("modifiers must be an array of Seed Strategy IDs.");
  }
  const modifierIds = rawModifiers ?? [];
  if (!modifierIds.every((modifier) => typeof modifier === "string")) {
    return invalidPolicyInput("modifiers must contain only Seed Strategy IDs.");
  }
  if (new Set(modifierIds).size !== modifierIds.length) {
    return invalidPolicyInput("modifiers must be unique.");
  }

  const modifiers = modifierIds.map((modifier) => seedStrategy(modifier, "modifier"));
  return Object.freeze({
    approach,
    modifiers: Object.freeze(modifiers),
  });
}

/**
 * Resolve a model declaration for a normal Run. Seed IDs retain the exact
 * ordinary syntax; object values are only compact exact selectors and must be
 * resolved by the Harness against a currently legal revision lease.
 */
export function createPolicySnapshotForRun(
  input: unknown,
  resolveRevisionSelector?: (
    selector: StrategyRevisionSelector,
    kind: SeedStrategyKind,
  ) => StrategyRevisionSelection,
): PolicySnapshot {
  // Preserve the pre-revision Seed-only behavior byte-for-byte for callers
  // that have no revision resolver (including ordinary legacy integrations).
  if (resolveRevisionSelector === undefined) return createPolicySnapshot(input);
  if (!isRecord(input)) return invalidPolicyInput("an approach is required.");

  const select = (
    value: unknown,
    expectedKind: SeedStrategyKind,
  ): StrategyRevisionSelection => {
    if (typeof value === "string") return seedStrategy(value, expectedKind);
    if (!isStrategyRevisionSelector(value)) {
      return invalidPolicyInput(
        `${expectedKind} must be a Seed Strategy ID or an exact Candidate revision selector.`,
      );
    }
    const selection = resolveRevisionSelector(value, expectedKind);
    if (selection.kind !== expectedKind) {
      return invalidPolicyInput(`${expectedKind} selection has the wrong Strategy kind.`);
    }
    return selection;
  };

  const approach = select(input.approach, "approach");
  if (input.modifiers !== undefined && !Array.isArray(input.modifiers)) {
    return invalidPolicyInput("modifiers must be an array of Seed IDs or exact Candidate revision selectors.");
  }
  const modifiers = (input.modifiers ?? []).map((modifier) =>
    select(modifier, "modifier"));
  if (new Set(modifiers.map((modifier) => selectionId(modifier))).size !== modifiers.length) {
    return invalidPolicyInput("modifiers must be unique by logical Strategy identity.");
  }
  return Object.freeze({
    approach,
    modifiers: Object.freeze(modifiers),
  });
}
