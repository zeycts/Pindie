import { matchesLearningArtifactRef, validateStrategyHypothesis, type StrategyHypothesis } from "./learning-v1-contract.ts";

/** Strict immutable-history integrity and exact leaf projection. No trust or semantic winner selection. */
export function hypothesisLeaves(history: readonly StrategyHypothesis[], projectId: string): readonly StrategyHypothesis[] {
  if (!Array.isArray(history) || history.some((h) => !validateStrategyHypothesis(h) || h.scope.kind !== "project" || h.scope.projectId !== projectId) ||
    new Set(history.map((h) => h.id)).size !== history.length || new Set(history.map((h) => h.fingerprint)).size !== history.length)
    throw new Error("Malformed/ambiguous hypothesis history.");
  const byId = new Map(history.map((h) => [h.id, h]));
  const closed = new Set<string>();
  const parents = new Map<string, StrategyHypothesis>();
  for (const h of history) if (h.parent !== null) {
    const parent = byId.get(h.parent.id);
    if (!parent || !matchesLearningArtifactRef(h.parent, parent) || parent.logicalId !== h.logicalId ||
      parent.kind !== h.kind || parent.baseRevisionFingerprint !== h.baseRevisionFingerprint)
      throw new Error("Unresolved hypothesis lineage.");
    parents.set(h.id, parent); closed.add(parent.id);
  }
  const validated = new Set<string>();
  for (const h of history) {
    const seen = new Set<string>();
    let current: StrategyHypothesis | undefined = h;
    while (current && !validated.has(current.id)) {
      if (seen.has(current.id)) throw new Error("Cyclic hypothesis lineage.");
      seen.add(current.id); current = parents.get(current.id);
    }
    for (const id of seen) validated.add(id);
  }
  return history.filter((h) => !closed.has(h.id)).sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.id.localeCompare(b.id));
}
