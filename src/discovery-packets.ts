import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "./learning-v1-contract.ts";
import { validateDiscoveryPacket, type DiscoveryPacketV1 } from "./discovery-contract.ts";

/** Immutable frozen job input. Exclusive create avoids replacing a prior packet. */
export class FileDiscoveryPacketStore {
  private readonly root: string;
  constructor(projectsBaseDir = join(homedir(), ".pindie", "projects")) { this.root = projectsBaseDir; }
  private path(projectId: string, fingerprint: string) {
    if (!/^[0-9a-f]{64}$/.test(projectId) || !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid DiscoveryPacket identity.");
    return join(this.root, projectId, "learning-v1", "packets", `${fingerprint.slice(7)}.json`);
  }
  async read(projectId: string, fingerprint: string): Promise<DiscoveryPacketV1 | null> {
    let raw: string;
    try { raw = await readFile(this.path(projectId, fingerprint), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let packet: unknown;
    try { packet = JSON.parse(raw); } catch { throw new Error("Malformed DiscoveryPacket store."); }
    if (!validateDiscoveryPacket(packet) || packet.projectId !== projectId || packet.fingerprint !== fingerprint) throw new Error("Malformed DiscoveryPacket store.");
    return packet;
  }
  async publish(packet: DiscoveryPacketV1): Promise<void> {
    if (!validateDiscoveryPacket(packet)) throw new Error("Invalid DiscoveryPacket.");
    const path = this.path(packet.projectId, packet.fingerprint);
    await mkdir(join(this.root, packet.projectId, "learning-v1", "packets"), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(packet) + "\n", { flag: "wx" });
      // Atomic no-replace publication: a crash before link leaves no visible packet.
      try { await link(temp, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await rm(temp, { force: true }); }
    const stored = await this.read(packet.projectId, packet.fingerprint);
    if (!stored || canonicalJson(stored) !== canonicalJson(packet)) throw new Error("Conflicting DiscoveryPacket publication.");
  }
}
