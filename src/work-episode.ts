import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROJECT_ID, learningFingerprint, newWorkEpisodeId, validateWorkEpisodeBinding, type WorkEpisodeBinding } from "./learning-v1-contract.ts";
import { getProjectId, type PindieStateStore } from "./store.ts";
import type { PindieState } from "./state.ts";
import type { PindieEvent } from "./transitions.ts";
import type { RunExperienceReader } from "./experience-store.ts";

interface Ledger { schemaVersion: 1; projectId: string; current: WorkEpisodeBinding | null; lastClosed: WorkEpisodeBinding | null; transitionPending: boolean }
export interface WorkEpisodeLedger {
  reconcile(projectRoot: string, state: PindieState): Promise<string | null>;
  prepared(projectRoot: string, before: PindieState, event: PindieEvent): Promise<void>;
  committed(projectRoot: string, before: PindieState, after: PindieState, event: PindieEvent): Promise<string | null>;
  current(projectRoot: string, state: PindieState): Promise<string | null>;
}
const fingerprint = (state: PindieState): string => learningFingerprint(state.task);

/** Latest binding only: no Task truth, and no automatic deletion of historical Experience. */
export class FileWorkEpisodeLedger implements WorkEpisodeLedger {
  private readonly baseDir: string;
  constructor(options: { projectsBaseDir?: string; experienceReader: RunExperienceReader; stateStore: PindieStateStore; now?: () => string }) {
    this.baseDir = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    this.experienceReader = options.experienceReader;
    this.stateStore = options.stateStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }
  private readonly experienceReader: RunExperienceReader;
  private readonly stateStore: PindieStateStore;
  private readonly now: () => string;
  private path(root: string) { return join(this.baseDir, getProjectId(root), "work-episode.json"); }
  private async read(root: string): Promise<Ledger | null> {
    let text: string;
    try { text = await readFile(this.path(root), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Error("Corrupt WorkEpisode ledger."); }
    const id = getProjectId(root);
    if (typeof v !== "object" || v === null || !PROJECT_ID.test(id)) throw new Error("Corrupt WorkEpisode ledger.");
    const l = v as Ledger;
    if (l.schemaVersion !== 1 || l.projectId !== id ||
      Object.keys(l).sort().join() !== ["schemaVersion", "projectId", "current", "lastClosed", "transitionPending"].sort().join() ||
      typeof l.transitionPending !== "boolean" ||
      (l.current !== null && (!validateWorkEpisodeBinding(l.current, id) || l.current.closedAt !== null)) ||
      (l.lastClosed !== null && (!validateWorkEpisodeBinding(l.lastClosed, id) || l.lastClosed.closedAt === null)) ||
      (l.current !== null && l.lastClosed !== null && l.current.episodeId === l.lastClosed.episodeId))
      throw new Error("Corrupt WorkEpisode ledger.");
    return l;
  }
  private async save(root: string, value: Ledger): Promise<void> {
    const path = this.path(root), temp = `${path}.${randomUUID()}.tmp`;
    await mkdir(join(this.baseDir, value.projectId), { recursive: true });
    try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  /** Serialize with semantic transitions via the same project State lock; read-only load reconciliation also locks. */
  async reconcile(root: string, state: PindieState): Promise<string | null> {
    return this.stateStore.withProjectLock(root, async () => {
      const latest = await this.stateStore.load(root);
      if (fingerprint(latest) !== fingerprint(state)) return null;
      const ledger = await this.read(root);
      if (ledger?.transitionPending) return null;
      if (ledger === null) {
        if (state.task === null || state.task.completed) return null;
        const experience = await this.experienceReader.read(root);
        if (experience.invalid || experience.unsupportedSchema || experience.records.some((r) => r.experience.schemaVersion !== 4)) return null;
        const binding = this.open(root, state);
        await this.save(root, { schemaVersion: 1, projectId: getProjectId(root), current: binding, lastClosed: null, transitionPending: false });
        return binding.episodeId;
      }
      if (ledger.current === null) return null;
      if (ledger.current.observedStateFingerprint !== fingerprint(state)) {
        if (state.task === null || state.task.completed) {
          await this.save(root, { ...ledger, current: null, lastClosed: { ...ledger.current, closedAt: this.now() } });
        }
        return null;
      }
      if (state.task === null || state.task.completed) {
        await this.save(root, { ...ledger, current: null, lastClosed: { ...ledger.current, closedAt: this.now() } });
        return null;
      }
      return ledger.current.episodeId;
    });
  }
  private open(root: string, state: PindieState): WorkEpisodeBinding {
    return { schemaVersion: 1, projectId: getProjectId(root), episodeId: newWorkEpisodeId(),
      observedStateFingerprint: fingerprint(state), openedAt: this.now(), closedAt: null };
  }
  /** Persist an uncertainty marker before a replacement, including same-contract replacements. */
  async prepared(root: string, before: PindieState, event: PindieEvent): Promise<void> {
    if (event.type !== "replace_task") return;
    const ledger = await this.read(root);
    if (ledger && !ledger.transitionPending && ledger.current?.observedStateFingerprint === fingerprint(before)) {
      await this.save(root, { ...ledger, transitionPending: true });
    }
  }
  /** Called only after State save succeeds, under its project lock. Failure is isolated by runtime. */
  async committed(root: string, before: PindieState, after: PindieState, event: PindieEvent): Promise<string | null> {
    const ledger = await this.read(root);
    const id = getProjectId(root);
    const newOccurrence = event.type === "start_task" || event.type === "replace_task";
    if (!newOccurrence && ledger !== null && ledger.current !== null && ledger.current.observedStateFingerprint !== fingerprint(before)) return null;
    if (!newOccurrence && ledger === null) return null;
    if (newOccurrence) {
      // A fresh explicit transition is unambiguous even if an older binding was stale.
      const next = this.open(root, after);
      await this.save(root, { schemaVersion: 1, projectId: id, current: next, transitionPending: false,
        lastClosed: ledger?.current ? { ...ledger.current, closedAt: this.now() } : ledger?.lastClosed ?? null });
      return next.episodeId;
    }
    if (!ledger?.current) return null;
    if (event.type === "complete_task") {
      await this.save(root, { ...ledger, current: null, lastClosed: { ...ledger.current, observedStateFingerprint: fingerprint(after), closedAt: this.now() } });
      return ledger.current.episodeId;
    }
    await this.save(root, { ...ledger, current: { ...ledger.current, observedStateFingerprint: fingerprint(after) } });
    return ledger.current.episodeId;
  }
  async current(root: string, state: PindieState): Promise<string | null> {
    const ledger = await this.read(root);
    if (ledger?.transitionPending) return null;
    const binding = ledger?.current ?? ledger?.lastClosed;
    return binding?.observedStateFingerprint === fingerprint(state) ? binding.episodeId : null;
  }
}
