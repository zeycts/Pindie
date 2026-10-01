import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileGlobalWriterLock, type GlobalWriterLock } from "./store.ts";
import { canonicalJson, hypothesisFingerprint, learningFingerprint, matchesLearningArtifactRef, validateLearningArtifactRef,
  validateLearningModelProvenance, validateStrategyHypothesis, type LearningArtifactRef, type LearningModelProvenance,
  type StrategyHypothesis, type StrategyHypothesisV2 } from "./learning-v1-contract.ts";
import { hypothesisLeaves } from "./hypothesis-lineage.ts";
import { validateDiscoveryPacket, type DiscoveryPacketV1, type DiscoveryPacketV4 } from "./discovery-contract.ts";

// Immutable packet commit/receipt history is bounded independently of cognition
// capacity. Later Evaluation/Decision lifecycle projection will close hypotheses
// without deleting history, so this history bound must never be read as a
// lifetime hypothesis cap.
export const MAX_DISCOVERY_COMMITS = 2048;
// Bounds open leaves only; exact revised parents remain immutable history.
export const MAX_OPEN_HYPOTHESES = 64;
export type DiscoveryCommit = { readonly schemaVersion: 2; readonly packetFingerprint: string;
  readonly outcome: "covered" | "published"; readonly refs: readonly LearningArtifactRef[];
  readonly newHypotheses: readonly StrategyHypothesis[]; readonly modelIdentity: LearningModelProvenance;
  readonly fingerprint: string };
export const hypothesisRef = (h: StrategyHypothesis): LearningArtifactRef =>
  ({ schemaVersion: 1, family: "strategy-hypothesis", scope: h.scope, id: h.id, fingerprint: h.fingerprint });

/** One immutable file per packet is the transaction boundary. No partial hypothesis set is visible. */
export class FileDiscoveryHypothesisStore {
  private readonly root: string;
  readonly lock: GlobalWriterLock;
  constructor(options: { projectsBaseDir?: string; lock?: GlobalWriterLock } = {}) {
    this.root = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    this.lock = options.lock ?? new FileGlobalWriterLock({ baseDir: this.root });
  }
  private dir(projectId: string) {
    if (!/^[0-9a-f]{64}$/.test(projectId)) throw new Error("Invalid hypothesis namespace.");
    return join(this.root, projectId, "learning-v1", "hypotheses");
  }
  private path(projectId: string, fingerprint: string) {
    if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid packet fingerprint.");
    return join(this.dir(projectId), `${fingerprint.slice(7)}.json`);
  }
  async committed(projectId: string, packetFingerprint: string): Promise<DiscoveryCommit | null> {
    let text: string;
    try { text = await readFile(this.path(projectId, packetFingerprint), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("Malformed hypothesis commit."); }
    if (!this.valid(data, projectId) || data.packetFingerprint !== packetFingerprint) throw new Error("Conflicting hypothesis commit.");
    return data;
  }
  private valid(v: unknown, projectId: string): v is DiscoveryCommit {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const d = v as DiscoveryCommit;
    if (Object.keys(d).sort().join() !== "fingerprint,modelIdentity,newHypotheses,outcome,packetFingerprint,refs,schemaVersion" ||
      d.schemaVersion !== 2 || !validateLearningModelProvenance(d.modelIdentity) || !/^sha256:[0-9a-f]{64}$/.test(d.packetFingerprint) ||
      !["covered", "published"].includes(d.outcome) || !Array.isArray(d.refs) || !Array.isArray(d.newHypotheses) ||
      !d.refs.length || d.refs.length > 2 || d.newHypotheses.length > 2 ||
      (d.outcome === "covered" ? d.newHypotheses.length !== 0 : d.newHypotheses.length === 0) ||
      !d.refs.every((r) => validateLearningArtifactRef(r, "strategy-hypothesis") && r.scope.kind === "project" && r.scope.projectId === projectId) ||
      !d.newHypotheses.every((h) => validateStrategyHypothesis(h) && h.scope.kind === "project" && h.scope.projectId === projectId && h.discoveryPacketFingerprint === d.packetFingerprint &&
        d.refs.some((r) => matchesLearningArtifactRef(r, h))) ||
      new Set(d.refs.map((r) => canonicalJson(r))).size !== d.refs.length) return false;
    const { fingerprint, ...content } = d;
    return fingerprint === learningFingerprint(content);
  }
  async list(projectId: string): Promise<readonly StrategyHypothesis[]> {
    let names: string[];
    try { names = await readdir(this.dir(projectId)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    if (names.length > MAX_DISCOVERY_COMMITS + MAX_OPEN_HYPOTHESES || names.some((n) => !/^[0-9a-f]{64}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(n)))
      throw new Error("Hypothesis store capacity or corruption.");
    // An interrupted exclusive-create before the atomic link is not a committed output.
    const published = names.filter((n) => n.endsWith(".json")).sort();
    if (published.length > MAX_DISCOVERY_COMMITS) throw new Error("Discovery commit history capacity exceeded.");
    const commits = await Promise.all(published.map((n) => this.committed(projectId, `sha256:${n.slice(0, -5)}`)));
    const hypotheses = commits.flatMap((c) => c!.newHypotheses);
    if (new Set(hypotheses.map((h) => h.id)).size !== hypotheses.length ||
      new Set(hypotheses.map((h) => h.fingerprint)).size !== hypotheses.length) throw new Error("Ambiguous hypothesis identity.");
    for (const commit of commits) for (const ref of commit!.refs) {
      if (!hypotheses.some((h) => matchesLearningArtifactRef(ref, h))) throw new Error("Unresolved hypothesis reference.");
    }
    hypothesisLeaves(hypotheses, projectId); // strict history integrity, not open capacity
    return hypotheses.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.id.localeCompare(b.id));
  }
  async publish(packet: DiscoveryPacketV1, outcome: DiscoveryCommit["outcome"], refs: readonly LearningArtifactRef[], newHypotheses: readonly StrategyHypothesis[], modelIdentity: LearningModelProvenance): Promise<DiscoveryCommit> {
    if (!validateLearningModelProvenance(modelIdentity)) throw new Error("Invalid hypothesis publication model provenance.");
    const content = { schemaVersion: 2 as const, packetFingerprint: packet.fingerprint, outcome, refs, newHypotheses, modelIdentity };
    const commit: DiscoveryCommit = { ...content, fingerprint: learningFingerprint(content) };
    if (!validateDiscoveryPacket(packet) || packet.schemaVersion !== 4 || newHypotheses.some((h) => h.schemaVersion !== 2) ||
      !this.valid(commit, packet.projectId) ||
      (outcome === "covered" && refs.some((r) => !packet.openHypotheses.entries.some((e) => e.hypothesisSchemaVersion === 2 && canonicalJson(e.ref) === canonicalJson(r)))) ||
      refs.some((r) => !newHypotheses.some((h) => matchesLearningArtifactRef(r, h)) &&
        !packet.openHypotheses.entries.some((e) => canonicalJson(e.ref) === canonicalJson(r))) ||
      newHypotheses.some((h) => h.sources.some((s) => !packet.sources.some((p) => canonicalJson(p.ref) === canonicalJson(s))) ||
        !h.sources.some((s) => packet.sources.some((p) => canonicalJson(p.ref) === canonicalJson(s) && p.role === "new")) ||
        (h.lineage === "revise" && !(h.parent === null
          ? packet.portfolio.revisions.some((r) => r.strategyId === h.logicalId && r.kind === h.kind &&
              r.revisionFingerprint === h.baseRevisionFingerprint)
          : packet.openHypotheses.entries.some((e) => canonicalJson(e.ref) === canonicalJson(h.parent) &&
              e.logicalId === h.logicalId && e.kind === h.kind && e.baseRevisionFingerprint === h.baseRevisionFingerprint)))))
      throw new Error("Invalid hypothesis publication.");
    const previous = await this.committed(packet.projectId, packet.fingerprint);
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(commit)) throw new Error("Conflicting hypothesis publication.");
      return previous;
    }
    const existing = await this.list(packet.projectId);
    const leaves = hypothesisLeaves(existing, packet.projectId);
    if (refs.some((r) => !newHypotheses.some((h) => matchesLearningArtifactRef(r, h)) &&
        !leaves.some((h) => h.schemaVersion === 2 && matchesLearningArtifactRef(r, h))) ||
      newHypotheses.some((h) => h.parent !== null && !leaves.some((parent) => matchesLearningArtifactRef(h.parent, parent))))
      throw new Error("Publication references non-open cognition.");
    await mkdir(this.dir(packet.projectId), { recursive: true });
    const history = await readdir(this.dir(packet.projectId));
    if (history.filter((n) => n.endsWith(".json")).length >= MAX_DISCOVERY_COMMITS)
      throw new Error("Discovery commit history capacity exceeded.");
    if (hypothesisLeaves([...existing, ...newHypotheses], packet.projectId).length > MAX_OPEN_HYPOTHESES) throw new Error("Open hypothesis capacity exceeded.");
    if (newHypotheses.some((h) => existing.some((e) => e.id === h.id || e.fingerprint === h.fingerprint))) throw new Error("Conflicting hypothesis identity.");
    const path = this.path(packet.projectId, packet.fingerprint);
    await mkdir(this.dir(packet.projectId), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(commit) + "\n", { flag: "wx" });
      await link(temp, path);
    } finally { await rm(temp, { force: true }); }
    return commit;
  }
}

export function mintHypothesis(packet: DiscoveryPacketV4, fields: Omit<StrategyHypothesisV2, "schemaVersion" | "id" | "fingerprint" | "scope" | "discoveryPacketFingerprint">): StrategyHypothesisV2 {
  if (packet.schemaVersion !== 4) throw new Error("New cognition requires DiscoveryPacket v4.");
  const semantic = { schemaVersion: 2 as const, scope: { kind: "project" as const, projectId: packet.projectId }, ...fields, discoveryPacketFingerprint: packet.fingerprint };
  const hypothesis = { ...semantic, id: randomUUID(), fingerprint: hypothesisFingerprint(semantic) };
  if (!validateStrategyHypothesis(hypothesis) || hypothesis.sources.some((s) => !packet.sources.some((p) => canonicalJson(p.ref) === canonicalJson(s))))
    throw new Error("Invalid proposed hypothesis.");
  return hypothesis;
}
