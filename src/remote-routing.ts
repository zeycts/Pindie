import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { getProjectId } from "./store.ts";

export interface RemoteSessionRouting {
  threadId: string;
  anchorMessageId: string;
  headerMessageId: string | null;
  lastMirroredEntryId: string | null;
}
export interface DiscordProjectRoutingV1 {
  version: 1;
  guildId: string;
  channelId: string;
  sessions: Record<string, RemoteSessionRouting>;
}

export interface RemoteRoutingStoreOptions { baseDir?: string; }

/** External delivery identity only; deliberately separate from PindieState. */
export class RemoteRoutingStore {
  private readonly baseDir: string;
  constructor(options: RemoteRoutingStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "remote", "discord", "projects");
  }
  path(projectRoot: string): string { return join(this.baseDir, `${getProjectId(projectRoot)}.json`); }
  async load(projectRoot: string): Promise<DiscordProjectRoutingV1 | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path(projectRoot), "utf8"));
      if (!isRouting(value)) throw new Error("invalid structure");
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Could not read Remote routing '${this.path(projectRoot)}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async save(projectRoot: string, routing: DiscordProjectRoutingV1): Promise<void> {
    if (!isRouting(routing)) throw new Error("Cannot save invalid Remote routing.");
    await mkdir(this.baseDir, { recursive: true });
    const path = this.path(projectRoot); const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(routing, null, 2)}\n`); await rename(temporary, path); }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }
  projectName(projectRoot: string): string { return basename(projectRoot).replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 90) || "project"; }
}

function isSession(value: unknown): value is RemoteSessionRouting {
  return !!value && typeof value === "object" && typeof (value as any).threadId === "string" &&
    typeof (value as any).anchorMessageId === "string" && ((value as any).headerMessageId === null || typeof (value as any).headerMessageId === "string") &&
    ((value as any).lastMirroredEntryId === null || typeof (value as any).lastMirroredEntryId === "string");
}
function isRouting(value: unknown): value is DiscordProjectRoutingV1 {
  return !!value && typeof value === "object" && (value as any).version === 1 && typeof (value as any).guildId === "string" &&
    typeof (value as any).channelId === "string" && !!(value as any).sessions && typeof (value as any).sessions === "object" &&
    Object.values((value as any).sessions).every(isSession);
}
