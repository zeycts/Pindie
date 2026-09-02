import {
  SEED_STRATEGIES,
  type SeedStrategy,
} from "./strategies.ts";

/** The model-declared cognitive policy for one Agent Run. */
export interface PolicySnapshot {
  readonly approach: SeedStrategy;
  readonly modifiers: readonly SeedStrategy[];
}

function invalid(message: string): never {
  throw new Error(`Invalid pindie_policy_set input: ${message}`);
}

/** Stable identity for a Policy, independent of modifier declaration order. */
export function policySnapshotIdentity(snapshot: PolicySnapshot): string {
  const modifierIds = [...snapshot.modifiers]
    .map((modifier) => modifier.id)
    .sort();
  return JSON.stringify({
    approachId: snapshot.approach.id,
    modifierIds: [...new Set(modifierIds)],
  });
}

function seedStrategy(
  value: unknown,
  field: "approach" | "modifier",
): SeedStrategy {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(`${field} must be a Seed Strategy ID.`);
  }

  const strategy = SEED_STRATEGIES.find((candidate) => candidate.id === value);
  if (!strategy) {
    return invalid(`${field} '${value}' is not a Seed ${field} Strategy.`);
  }
  if (strategy.kind !== field) {
    return invalid(`${field} '${value}' must be a Seed ${field} Strategy.`);
  }
  return strategy;
}

/** Resolve one structured declaration against the immutable Seed catalog. */
export function createPolicySnapshot(input: unknown): PolicySnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("an approach is required.");
  }

  const declaration = input as {
    approach?: unknown;
    modifiers?: unknown;
  };
  const approach = seedStrategy(declaration.approach, "approach");
  const rawModifiers = declaration.modifiers;
  if (rawModifiers !== undefined && !Array.isArray(rawModifiers)) {
    return invalid("modifiers must be an array of Seed Strategy IDs.");
  }
  const modifierIds = rawModifiers ?? [];
  if (!modifierIds.every((modifier) => typeof modifier === "string")) {
    return invalid("modifiers must contain only Seed Strategy IDs.");
  }
  if (new Set(modifierIds).size !== modifierIds.length) {
    return invalid("modifiers must be unique.");
  }

  const modifiers = modifierIds.map((modifier) => seedStrategy(modifier, "modifier"));
  return Object.freeze({
    approach,
    modifiers: Object.freeze(modifiers),
  });
}
