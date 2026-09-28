import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileGlobalWriterLock, type GlobalWriterLock } from "./store.ts";
import { learningArtifactFingerprint, learningJobKey, validateDiscoveryReceipt, validateLearningModelProvenance, type DiscoveryReceipt, type LearningArtifactRef, type LearningModelProvenance } from "./learning-v1-contract.ts";
import { validateDiscoveryPacket, type DiscoveryPacketV1 } from "./discovery-contract.ts";

/** Strict immutable receipts. Missing directory is empty; any malformed entry blocks discovery. */
export class FileDiscoveryReceiptStore {
  private readonly root: string;
  private readonly lock: GlobalWriterLock;
  constructor(options: { projectsBaseDir?: string; lock?: GlobalWriterLock } = {}) {
    this.root = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    this.lock = options.lock ?? new FileGlobalWriterLock({ baseDir: this.root });
  }
  private path(projectId: string) { return join(this.root, projectId, "learning-v1", "discovery-receipts.json"); }
  async read(projectId: string): Promise<readonly DiscoveryReceipt[]> {
    if (!/^[0-9a-f]{64}$/.test(projectId)) throw new Error("Invalid receipt namespace.");
    let raw: string;
    try { raw = await readFile(this.path(projectId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error("Malformed DiscoveryReceipt store."); }
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join() !== "receipts,schemaVersion" ||
      (data as any).schemaVersion !== 1 || !Array.isArray((data as any).receipts) || (data as any).receipts.length > 2048 ||
      !(data as any).receipts.every((r: unknown) => validateDiscoveryReceipt(r) && r.scope.kind === "project" && r.scope.projectId === projectId)) throw new Error("Malformed DiscoveryReceipt store.");
    const receipts = (data as { receipts: DiscoveryReceipt[] }).receipts;
    if (new Set(receipts.map((r) => r.jobKey)).size !== receipts.length || new Set(receipts.map((r) => r.id)).size !== receipts.length) throw new Error("Ambiguous DiscoveryReceipt store.");
    return receipts;
  }
  async find(projectId: string, jobKey: string, packetFingerprint: string): Promise<DiscoveryReceipt | null> {
    const found = (await this.read(projectId)).find((r) => r.jobKey === jobKey);
    if (found && found.packetFingerprint !== packetFingerprint) throw new Error("Conflicting DiscoveryReceipt packet.");
    return found ?? null;
  }
  async resolve(ref: LearningArtifactRef, jobKey: string, packetFingerprint: string): Promise<DiscoveryReceipt | null> {
    if (ref.family !== "discovery-receipt" || ref.scope.kind !== "project") return null;
    const receipt = await this.find(ref.scope.projectId, jobKey, packetFingerprint);
    return receipt?.id === ref.id && receipt.fingerprint === ref.fingerprint ? receipt : null;
  }
  /** Terminal outcomes assess only new sources and persist exact model provenance. */
  async publish(packet: DiscoveryPacketV1, outcome: DiscoveryReceipt["outcome"], hypotheses: readonly LearningArtifactRef[], modelIdentity: LearningModelProvenance): Promise<DiscoveryReceipt> {
    if (!validateDiscoveryPacket(packet) || !validateLearningModelProvenance(modelIdentity)) throw new Error("Invalid DiscoveryPacket or model provenance.");
    const scope = { kind: "project" as const, projectId: packet.projectId };
    const jobKey = learningJobKey("project-discovery", scope, packet.fingerprint, packet.policy.selectionVersion);
    const sources = packet.sources.map((s) => ({ ...s.ref, recordedAt: s.recordedAt, role: s.role }));
    return this.lock.withLock(async () => {
      const previous = await this.find(packet.projectId, jobKey, packet.fingerprint);
      const content = { schemaVersion: 3 as const, jobKey, packetFingerprint: packet.fingerprint, scope, outcome, hypotheses, sources, modelIdentity };
      if (previous) {
        if (JSON.stringify({ ...previous, id: null, fingerprint: null }) !== JSON.stringify({ ...content, id: null, fingerprint: null })) throw new Error("Conflicting DiscoveryReceipt publication.");
        return previous;
      }
      const unsigned = { ...content, id: randomUUID() };
      const receipt: DiscoveryReceipt = { ...unsigned, fingerprint: learningArtifactFingerprint(unsigned) };
      if (!validateDiscoveryReceipt(receipt)) throw new Error("Invalid DiscoveryReceipt.");
      const receipts = await this.read(packet.projectId);
      if (receipts.length >= 2048) throw new Error("DiscoveryReceipt capacity exceeded.");
      const path = this.path(packet.projectId);
      await mkdir(join(this.root, packet.projectId, "learning-v1"), { recursive: true });
      // Under the writer lock; atomic replacement uses a unique sibling.
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ schemaVersion: 1, receipts: [...receipts, receipt] }) + "\n", { flag: "wx" });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
      return receipt;
    });
  }
}
