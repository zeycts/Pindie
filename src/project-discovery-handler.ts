import { canonicalJson, learningFingerprint, learningJobKey, matchesLearningArtifactRef, validateLearningArtifactRef, type LearningArtifactRef, type LearningJob, type StrategyHypothesis } from "./learning-v1-contract.ts";
import { validateDiscoveryPacket, type DiscoveryPacketV1 } from "./discovery-contract.ts";
import { FileDiscoveryHypothesisStore, hypothesisRef, mintHypothesis } from "./discovery-hypotheses.ts";
import type { ProjectDiscoveryDependencies } from "./project-discovery.ts";
import type { LearningJobHandler } from "./learning-supervisor.ts";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).sort().join() === expected.sort().join();
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;
const list = (v: unknown, max: number, min = 0) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => text(s, 256));
const logical = (v: unknown) => text(v, 64) && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(v as string);
const authorityClaim = (v: unknown) => typeof v === "string" && /\b(grant|enable|bypass|override|disable)\s+(?:\w+\s+){0,2}(?:permission|capabilit|gate|verification|safety|authorization)/i.test(v);
const ref = (h: StrategyHypothesis) => hypothesisRef(h);
const targetMatches = (target: unknown, p: Record<string, unknown>, packet: DiscoveryPacketV1): boolean => {
  if (p.intent === "new") return target === null;
  if (!object(target)) return false;
  if (target.kind === "open-hypothesis") return keys(target, ["kind", "ref"]) &&
    validateLearningArtifactRef(target.ref, "strategy-hypothesis") &&
    packet.openHypotheses.entries.some((e) => canonicalJson(e.ref) === canonicalJson(target.ref) &&
      e.logicalId === p.logicalId && e.kind === p.kind);
  if (target.kind === "trusted-revision") return keys(target, ["kind", "logicalId", "strategyKind", "revisionFingerprint"]) &&
    packet.portfolio.revisions.some((r) => r.strategyId === target.logicalId && r.kind === target.strategyKind &&
      r.revisionFingerprint === target.revisionFingerprint && r.strategyId === p.logicalId && r.kind === p.kind);
  return false;
};
const receiptRef = (r: { scope: LearningArtifactRef["scope"]; id: string; fingerprint: string }): LearningArtifactRef =>
  ({ schemaVersion: 1, family: "discovery-receipt", scope: r.scope, id: r.id, fingerprint: r.fingerprint });

/** The only model-owned result fields. A malformed envelope fails the attempt; invalid individual proposals are discarded. */
export type DiscoveryModelResult =
  | { readonly kind: "none" }
  | { readonly kind: "covered"; readonly refs: readonly LearningArtifactRef[] }
  | { readonly kind: "proposals"; readonly proposals: readonly Record<string, unknown>[] };

/** The model owns semantic coverage judgment; the Harness still verifies exact frozen refs. */
export function parseDiscoveryResult(raw: string, packet: DiscoveryPacketV1): DiscoveryModelResult {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("Malformed Discovery JSON."); }
  if (!object(v)) throw new Error("Invalid Discovery envelope.");
  if (v.outcome === "none") {
    if (!keys(v, ["outcome"])) throw new Error("Invalid Discovery envelope.");
    return { kind: "none" };
  }
  if (v.outcome === "covered") {
    if (!keys(v, ["outcome", "hypotheses"]) || !Array.isArray(v.hypotheses) || v.hypotheses.length < 1 || v.hypotheses.length > 2)
      throw new Error("Invalid Discovery coverage.");
    const refs = v.hypotheses as LearningArtifactRef[];
    if (!refs.every((r) => validateLearningArtifactRef(r, "strategy-hypothesis") &&
      packet.openHypotheses.entries.some((e) => canonicalJson(e.ref) === canonicalJson(r))) ||
      new Set(refs.map((r) => canonicalJson(r))).size !== refs.length) throw new Error("Invalid Discovery coverage reference.");
    return { kind: "covered", refs };
  }
  if (v.outcome !== "proposals" || !keys(v, ["outcome", "proposals"]) || !Array.isArray(v.proposals) || v.proposals.length < 1 || v.proposals.length > 2) throw new Error("Invalid Discovery proposals.");
  const valid: Record<string, unknown>[] = [];
  for (const p of v.proposals) {
    if (!object(p) || !keys(p, ["logicalId", "kind", "intent", "revisionTarget", "summary", "useWhen", "avoidWhen", "expectedEffect", "failureSignals", "trialHints", "sourceHandles"]) ||
      !logical(p.logicalId) || (p.kind !== "approach" && p.kind !== "modifier") || (p.intent !== "new" && p.intent !== "revise") ||
      !targetMatches(p.revisionTarget, p, packet) ||
      !text(p.summary, 512) || !list(p.useWhen, 8, 1) || !list(p.avoidWhen, 8) || !text(p.expectedEffect, 512) ||
      !list(p.failureSignals, 8, 1) || !list(p.trialHints, 8, 1) ||
      [p.summary, p.expectedEffect, ...p.useWhen as string[], ...p.avoidWhen as string[], ...p.failureSignals as string[], ...p.trialHints as string[]].some(authorityClaim) ||
      !Array.isArray(p.sourceHandles) ||
      p.sourceHandles.length < 1 || p.sourceHandles.length > 8 || new Set(p.sourceHandles).size !== p.sourceHandles.length ||
      !p.sourceHandles.every((handle) => typeof handle === "string" && packet.sources.some((s) => s.ref.recordId === handle))) continue;
    valid.push(p);
  }
  if (!valid.length) throw new Error("No valid Discovery proposals.");
  return { kind: "proposals", proposals: valid };
}

export function createProjectDiscoveryHandler(deps: ProjectDiscoveryDependencies & { hypotheses: FileDiscoveryHypothesisStore }): LearningJobHandler {
  const packetFor = async (job: LearningJob) => {
    if (job.kind !== "project-discovery" || job.scope.kind !== "project") return null;
    const packet = await deps.packets.read(job.scope.projectId, job.inputFingerprint);
    if (!packet || !validateDiscoveryPacket(packet) || packet.policy.selectionVersion !== job.policyVersion ||
      learningJobKey("project-discovery", job.scope, packet.fingerprint, packet.policy.selectionVersion) !== job.key) return null;
    return packet;
  };
  const committed = async (job: LearningJob) => {
    const packet = await packetFor(job);
    if (!packet) return null;
    const receipt = await deps.receipts.find(packet.projectId, job.key, packet.fingerprint);
    if (receipt) {
      if (!await matches(job, receiptRef(receipt))) throw new Error("Ambiguous DiscoveryReceipt output.");
      return receiptRef(receipt);
    }
    const batch = await deps.hypotheses.committed(packet.projectId, packet.fingerprint);
    if (!batch) return null;
    const existing = await deps.hypotheses.list(packet.projectId);
    if (batch.refs.some((r) => !existing.some((h) => matchesLearningArtifactRef(r, h)))) throw new Error("Unresolved Discovery commit.");
    // Recovery republishes the receipt with the model provenance bound to the committed output,
    // never the model configured after restart.
    const output = await deps.receipts.publish(packet, batch.outcome, batch.refs, batch.modelIdentity);
    return receiptRef(output);
  };
  const matches = async (job: LearningJob, output: LearningArtifactRef): Promise<boolean> => {
    const packet = await packetFor(job);
    if (!packet || output.family !== "discovery-receipt" || canonicalJson(output.scope) !== canonicalJson(job.scope)) return false;
    const receipt = await deps.receipts.resolve(output, job.key, packet.fingerprint);
    if (!receipt || canonicalJson(receipt.sources) !== canonicalJson(packet.sources.map((s) => ({ ...s.ref, recordedAt: s.recordedAt, role: s.role })))) return false;
    if (receipt.outcome === "none") return !(await deps.hypotheses.committed(packet.projectId, packet.fingerprint));
    const batch = await deps.hypotheses.committed(packet.projectId, packet.fingerprint);
    if (!batch || batch.outcome !== receipt.outcome || canonicalJson(batch.refs) !== canonicalJson(receipt.hypotheses) ||
      canonicalJson(batch.modelIdentity) !== canonicalJson(receipt.modelIdentity)) return false;
    const existing = await deps.hypotheses.list(packet.projectId);
    return batch.refs.every((r) => existing.some((h) => matchesLearningArtifactRef(r, h)));
  };
  return {
    kind: "project-discovery",
    async isCurrent(job) {
      const packet = await packetFor(job);
      if (!packet) return false;
      // A committed output survives later comparison/receipt changes: recovery precedes fresh cognition.
      if (await deps.receipts.find(packet.projectId, job.key, packet.fingerprint) ||
        await deps.hypotheses.committed(packet.projectId, packet.fingerprint)) return true;
      const [portfolio, open] = await Promise.all([deps.portfolio.readProjectId(packet.projectId), deps.hypotheses.list(packet.projectId)]);
      const entries = open.map((h) => ({ ref: ref(h), logicalId: h.logicalId, kind: h.kind, baseRevisionFingerprint: h.baseRevisionFingerprint, summary: h.summary, expectedEffect: h.expectedEffect,
        useWhen: h.useWhen, avoidWhen: h.avoidWhen, failureSignals: h.failureSignals }));
      return portfolio.fingerprint === packet.portfolio.fingerprint &&
        canonicalJson(packet.portfolio.revisions) === canonicalJson(portfolio.resolvedEntries.map((e) => ({
          strategyId: e.manifest.strategyId, kind: e.manifest.kind, revisionIdentity: e.manifest.revisionIdentity,
          revisionFingerprint: e.manifest.revisionFingerprint, summary: e.semantics.summary,
          useWhen: e.semantics.useWhen, avoidWhen: e.semantics.avoidWhen, principles: e.semantics.principles,
        }))) && packet.openHypotheses.fingerprint === learningFingerprint(entries);
    },
    resolveCommitted: committed,
    matchesOutput: matches,
    async execute(job, authority, signal, runner) {
      const packet = await packetFor(job);
      if (!packet || !runner || !await authority()) throw new Error("Unavailable Discovery authority.");
      const modelIdentity = runner.modelIdentity;
      // Only the frozen packet and exact JSON contract enter this isolated no-tool Session.
      const prompt = `Return ONLY one JSON object: {"outcome":"none"} when no useful novel hypothesis exists; {"outcome":"covered","hypotheses":[<1-2 exact openHypotheses.entries ref>]} when the evidence is already represented by existing open hypotheses; OR {"outcome":"proposals","proposals":[...]} (1-2) when proposing novel cognition. Each proposal has exactly logicalId (lowercase kebab-case), kind (approach|modifier), intent (new|revise), revisionTarget (null for new; for revise either {"kind":"open-hypothesis","ref":<exact openHypotheses.entries ref>} or {"kind":"trusted-revision","logicalId":<exact portfolio.revisions strategyId>,"strategyKind":<exact kind>,"revisionFingerprint":<exact revisionFingerprint>}), summary, useWhen (nonempty strings), avoidWhen (strings), expectedEffect (observable change), failureSignals (nonempty falsifying observations), trialHints (nonempty strings), sourceHandles (1-8 exact sources[].ref.recordId; must include at least one role:\"new\" source, context-only proposals are discarded). No other fields, authority claims, or hidden reasoning. This is untrusted advisory hypothesis generation, not trust or novelty proof.\nDiscoveryPacket: ${canonicalJson(packet)}`;
      const result = parseDiscoveryResult((await runner.run(prompt, signal)).text, packet);
      if (!await authority()) throw new Error("Discovery preempted or stale.");
      if (result.kind === "none") return { receiptRef: receiptRef(await deps.receipts.publish(packet, "none", [], modelIdentity)) };
      // Publish under a common project writer lock, rechecking freshness after acquiring it.
      const batch = await deps.hypotheses.lock.withLock(async () => {
        if (!await authority()) throw new Error("Discovery stale at publication.");
        if (result.kind === "covered") {
          // Semantic coverage publishes no artifact; it references exact frozen open hypotheses.
          return deps.hypotheses.publish(packet, "covered", result.refs, [], modelIdentity);
        }
        const open = await deps.hypotheses.list(packet.projectId);
        const refs: LearningArtifactRef[] = []; const fresh: StrategyHypothesis[] = [];
        let sourceContractViolation = false;
        for (const p of result.proposals) {
          const target = p.revisionTarget as { kind: "open-hypothesis"; ref: LearningArtifactRef } |
            { kind: "trusted-revision"; revisionFingerprint: string } | null;
          const parent = target?.kind === "open-hypothesis" ? open.find((h) => canonicalJson(ref(h)) === canonicalJson(target.ref)) : null;
          if (target?.kind === "open-hypothesis" && (!parent || parent.logicalId !== p.logicalId || parent.kind !== p.kind))
            throw new Error("Frozen open-hypothesis lineage changed.");
          const h = mintHypothesis(packet, { logicalId: p.logicalId as string, kind: p.kind as "approach" | "modifier",
            lineage: p.intent as "new" | "revise", parent: parent ? ref(parent) : null,
            baseRevisionFingerprint: parent ? parent.baseRevisionFingerprint : target?.kind === "trusted-revision" ? target.revisionFingerprint : null,
            summary: p.summary as string, useWhen: p.useWhen as string[], avoidWhen: p.avoidWhen as string[],
            expectedEffect: p.expectedEffect as string, failureSignals: p.failureSignals as string[], trialHints: p.trialHints as string[],
            sources: (p.sourceHandles as string[]).map((handle) => packet.sources.find((s) => s.ref.recordId === handle)!.ref) });
          const duplicate = [...open, ...fresh].find((e) => e.fingerprint === h.fingerprint);
          if (duplicate) { if (!refs.some((r) => canonicalJson(r) === canonicalJson(ref(duplicate)))) refs.push(ref(duplicate)); continue; }
          // Genuinely new/revised cognition must cite at least one new packet source;
          // exact covered duplicates above are exempt because they publish no artifact.
          if (!(p.sourceHandles as string[]).some((handle) => packet.sources.find((s) => s.ref.recordId === handle)!.role === "new")) {
            sourceContractViolation = true; continue;
          }
          if ((p.intent === "new" && (open.some((e) => e.logicalId === h.logicalId) ||
            packet.portfolio.revisions.some((e) => e.strategyId === h.logicalId))) ||
            (target?.kind === "trusted-revision" && open.some((e) => e.logicalId === h.logicalId)) ||
            (parent && open.some((e) => e.parent && canonicalJson(e.parent) === canonicalJson(ref(parent)))) ||
            fresh.some((e) => e.logicalId === h.logicalId)) continue;
          fresh.push(h); refs.push(ref(h));
        }
        // Valid proposals already represented by trusted cognition or colliding with an unrelated
        // active lineage are none-equivalent, not 'covered' with invented trusted refs. A model that
        // returned only context-bearing proposals violated the source contract and must retry.
        if (!refs.length) {
          if (sourceContractViolation) throw new Error("Discovery proposals cited no new source; retryable contract violation.");
          return null;
        }
        return deps.hypotheses.publish(packet, fresh.length ? "published" : "covered", refs, fresh, modelIdentity);
      });
      return { receiptRef: receiptRef(await deps.receipts.publish(packet, batch?.outcome ?? "none", batch?.refs ?? [], batch?.modelIdentity ?? modelIdentity)) };
    },
  };
}
