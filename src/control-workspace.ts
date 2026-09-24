import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { PindieControlClient, type PindieControlSnapshot } from "./control-client.ts";
import { createPindieHost, type PindieHost, type PindieHostOptions } from "./host.ts";

export type PindieWorkspaceErrorCode = "no_active_project" | "invalid_project" | "project_not_found" | "project_exists" | "project_create_failed" | "project_switch_unsafe" | "project_open_failed";

export class PindieWorkspaceError extends Error {
  readonly code: PindieWorkspaceErrorCode;
  constructor(code: PindieWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "PindieWorkspaceError";
    this.code = code;
  }
}

export async function resolveControlWorkspaceRoot(value: string | undefined): Promise<string> {
  if (!value?.trim()) throw new Error("PINDIE_WORKSPACE_ROOT must specify an existing workspace directory.");
  const root = await realpath(value);
  if (!(await stat(root)).isDirectory()) throw new Error("PINDIE_WORKSPACE_ROOT must be a directory.");
  return root;
}

type ActiveSlot = { name: string; host: PindieHost; client: PindieControlClient };
export type WorkspaceObservation =
  | { state: "no_active_project"; workspaceRoot: string; activeProject: null }
  | { state: "active_project"; workspaceRoot: string; activeProject: string; control: PindieControlSnapshot };

export interface PindieControlWorkspaceOptions {
  readonly workspaceRoot: string;
  readonly createHost?: (options: PindieHostOptions) => Promise<PindieHost>;
  readonly createClient?: (host: PindieHost) => PindieControlClient;
}

/** Runtime-only single active Host slot; all access and replacement share one serialization boundary. */
export class PindieControlWorkspace {
  private slot: ActiveSlot | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  readonly workspaceRoot: string;

  private readonly options: PindieControlWorkspaceOptions;
  private constructor(options: PindieControlWorkspaceOptions, root: string) {
    this.options = options;
    this.workspaceRoot = root;
  }

  static async create(options: PindieControlWorkspaceOptions): Promise<PindieControlWorkspace> {
    return new PindieControlWorkspace(options, await resolveControlWorkspaceRoot(options.workspaceRoot));
  }

  private serialize<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.closing) return Promise.reject(new PindieWorkspaceError("no_active_project", "Workspace is closed."));
    const result = this.tail.then(() => action());
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private childPath(name: string): string {
    if (typeof name !== "string" || !name || name === "." || name === ".." || isAbsolute(name) ||
        name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new PindieWorkspaceError("invalid_project", "Project must be a direct child name.");
    }
    return join(this.workspaceRoot, name);
  }

  private async target(name: string): Promise<string> {
    const child = this.childPath(name);
    try {
      const path = await realpath(child);
      if (dirname(path) !== this.workspaceRoot || !(await stat(path)).isDirectory()) {
        throw new PindieWorkspaceError("invalid_project", "Project must resolve to a direct workspace child directory.");
      }
      return path;
    } catch (error) {
      if (error instanceof PindieWorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PindieWorkspaceError("project_not_found", "Project does not exist.");
      }
      throw error;
    }
  }

  listProjects(): Promise<{ workspaceRoot: string; activeProject: string | null; projects: { name: string; active: boolean }[] }> {
    return this.serialize(async () => {
      const entries = await readdir(this.workspaceRoot, { withFileTypes: true });
      const names: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try { await this.target(entry.name); names.push(entry.name); } catch (error) {
          if (!(error instanceof PindieWorkspaceError)) throw error;
        }
      }
      names.sort();
      return { workspaceRoot: this.workspaceRoot, activeProject: this.slot?.name ?? null,
        projects: names.map((name) => ({ name, active: name === this.slot?.name })) };
    });
  }

  observe(): Promise<WorkspaceObservation> {
    return this.serialize(() => this.project());
  }

  private project(): WorkspaceObservation {
    const slot = this.slot;
    return slot === null
      ? { state: "no_active_project", workspaceRoot: this.workspaceRoot, activeProject: null }
      : { state: "active_project", workspaceRoot: this.workspaceRoot, activeProject: slot.name, control: slot.client.observe() };
  }

  withClient<T>(action: (client: PindieControlClient) => Promise<T> | T): Promise<T> {
    return this.serialize(() => {
      if (!this.slot) throw new PindieWorkspaceError("no_active_project", "Open a project first.");
      return action(this.slot.client);
    });
  }

  private assertSafeToLeave(): void {
    if (!this.slot) return;
    let snapshot: PindieControlSnapshot;
    try { snapshot = this.slot.client.observe(); } catch {
      throw new PindieWorkspaceError("project_switch_unsafe", "Current project cannot be observed safely.");
    }
    if (!snapshot.runtime.idle || !snapshot.runtime.automaticWorkSettled || snapshot.runtime.pendingMessageCount !== 0 ||
        snapshot.semantic.humanGate !== null || snapshot.recovery.quotaWaiting !== null) {
      throw new PindieWorkspaceError("project_switch_unsafe", "Current project is not safe to leave.");
    }
  }

  openProject(name: string): Promise<WorkspaceObservation> {
    return this.serialize(async () => {
      const target = await this.target(name);
      if (this.slot?.name === name) return this.project();
      this.assertSafeToLeave();
      return this.activate(name, target);
    });
  }

  createProject(name: string): Promise<WorkspaceObservation> {
    return this.serialize(async () => {
      const target = this.childPath(name);
      // Existence includes files and symlinks (including dangling symlinks).
      try {
        await lstat(target);
        throw new PindieWorkspaceError("project_exists", "Project already exists.");
      } catch (error) {
        if (error instanceof PindieWorkspaceError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new PindieWorkspaceError("project_create_failed", "Could not check project target.");
        }
      }
      this.assertSafeToLeave();
      try { await mkdir(target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PindieWorkspaceError("project_exists", "Project already exists.");
        }
        throw new PindieWorkspaceError("project_create_failed", `Could not create project: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.activate(name, target);
    });
  }

  private async activate(name: string, target: string): Promise<WorkspaceObservation> {
      if (this.slot) {
        const old = this.slot;
        // No second Host can be constructed until old Host disposal completes.
        this.slot = null;
        try {
          try { old.client.dispose(); } finally { await old.host.dispose(); }
        } catch (error) {
          throw new PindieWorkspaceError("project_open_failed", `Could not dispose the previous project: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      let host: PindieHost | undefined;
      let client: PindieControlClient | undefined;
      try {
        host = await (this.options.createHost ?? createPindieHost)({
          cwd: target,
          env: { ...process.env, PINDIE_TUI: "0" },
          dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
        });
        client = (this.options.createClient ?? ((h) => new PindieControlClient(h.runtime, h.presentation, {
          bindActiveSession: () => h.runtime.bindActiveSessionExtensions({ mode: "print" }),
        })))(host);
        await client.start();
        // Bootstrap and the initial projection must succeed before publication.
        const control = client.observe();
        this.slot = { name, host, client };
        return { state: "active_project", workspaceRoot: this.workspaceRoot, activeProject: name, control };
      } catch (error) {
        try { client?.dispose(); } catch { /* Preserve bootstrap failure. */ }
        try { if (host) await host.dispose(); } catch { /* Preserve bootstrap failure. */ }
        throw new PindieWorkspaceError("project_open_failed", `Could not open project: ${error instanceof Error ? error.message : String(error)}`);
      }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.tail;
      if (this.closed) return;
      this.closed = true;
      const slot = this.slot;
      this.slot = null;
      if (slot) { try { slot.client.dispose(); } finally { await slot.host.dispose(); } }
    })();
    return this.closePromise;
  }
}
