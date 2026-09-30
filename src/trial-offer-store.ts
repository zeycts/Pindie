import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileGlobalWriterLock, type GlobalWriterLock } from "./store.ts";
import { canonicalJson, learningArtifactFingerprint, matchesLearningArtifactRef, PROJECT_ID, UUID_V4, validateTrialAssignment, type TrialAssignment } from "./learning-v1-contract.ts";
import { validateTrialOfferReceipt, type TrialOfferReceipt } from "./trial-offer-contract.ts";

/** A durable scheduling hold, NOT an assignment, receipt or WorkEpisode. */
export type TrialOfferReservation = Omit<TrialAssignment, "workEpisodeId" | "comparison" | "status">;
export function validateTrialOfferReservation(v: unknown): v is TrialOfferReservation {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as TrialOfferReservation;
  if (Object.keys(r).sort().join() !== "authorityGeneration,createdAt,expiresAt,fingerprint,hostId,hypothesis,id,offerPolicyFingerprint,offerPolicyVersion,projectId,schemaVersion,sessionId") return false;
  const a = { ...r, workEpisodeId: "00000000-0000-4000-8000-000000000000", comparison: [], status: "untrusted-advisory" as const };
  return r.fingerprint === learningArtifactFingerprint(r) && validateTrialAssignment({ ...a, fingerprint: learningArtifactFingerprint(a) });
}

/** Bounded retained operational decisions; capacity blocks new offers, never deletes dedupe identity. */
export const MAX_RETAINED_TRIAL_OFFER_DECISIONS = 2048;
export interface TrialOfferCommit { readonly schemaVersion: 1; readonly receipt: TrialOfferReceipt; readonly assignment: TrialAssignment | null }
export interface TrialOfferStore {
  find(projectId: string, episodeId: string): Promise<TrialOfferCommit | null>;
  reserve(projectId: string, now: number, select: (history: readonly TrialOfferCommit[], held: readonly TrialOfferReservation[]) => Promise<TrialOfferReservation | null>, signal: AbortSignal, isCurrent: () => boolean): Promise<TrialOfferReservation | null>;
  commitReserved(commit: TrialOfferCommit, signal: AbortSignal, isCurrent?: () => boolean): Promise<TrialOfferCommit>;
  releaseUnusedReservation(reservation: TrialOfferReservation): Promise<void>;
  decide(interrupted: TrialOfferReceipt, select: (history: readonly TrialOfferCommit[]) => Promise<TrialOfferCommit>, signal: AbortSignal, isCurrent?: () => boolean): Promise<TrialOfferCommit>;
}
export function validateTrialOfferCommit(v: unknown): v is TrialOfferCommit {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "assignment,receipt,schemaVersion") return false;
  const c = v as TrialOfferCommit;
  if (c.schemaVersion !== 1 || !validateTrialOfferReceipt(c.receipt)) return false;
  const a = c.assignment, r = c.receipt;
  return r.outcome === "no-offer" ? a === null : a !== null && validateTrialAssignment(a) &&
    matchesLearningArtifactRef(r.assignment, a) && a.projectId === r.projectId && a.workEpisodeId === r.workEpisodeId &&
    a.offerPolicyVersion === r.offerPolicyVersion && a.offerPolicyFingerprint === r.offerPolicyFingerprint && a.createdAt === r.createdAt;
}
export class FileTrialOfferStore implements TrialOfferStore {
  private readonly root: string;
  readonly lock: GlobalWriterLock;
  private readonly onBeforeCommit: (() => Promise<void>) | undefined;
  constructor(options: { projectsBaseDir?: string; lock?: GlobalWriterLock; onBeforeCommit?: () => Promise<void> } = {}) {
    this.root = options.projectsBaseDir ?? join(homedir(), ".pindie", "projects");
    this.lock = options.lock ?? new FileGlobalWriterLock({ baseDir: this.root });
    this.onBeforeCommit = options.onBeforeCommit;
  }
  private dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error("Invalid offer namespace.");
    return join(this.root, projectId, "learning-v1", "trial-offers");
  }
  private path(projectId: string, episodeId: string, pending = false): string {
    if (!UUID_V4.test(episodeId)) throw new Error("Invalid offer episode identity.");
    return join(this.dir(projectId), `${episodeId}${pending ? ".pending" : ""}.json`);
  }
  private async json(path: string): Promise<unknown | null> {
    let text: string;
    try { text = await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    if (text.length > 16_384) throw new Error("Oversized offer artifact.");
    const value: unknown = JSON.parse(text);
    if (value === null) throw new Error("Malformed null offer artifact.");
    return value;
  }
  private async readCommit(projectId: string, episodeId: string): Promise<TrialOfferCommit | null> {
    const c = await this.json(this.path(projectId, episodeId));
    if (c === null) return null;
    if (!validateTrialOfferCommit(c) || c.receipt.projectId !== projectId || c.receipt.workEpisodeId !== episodeId) throw new Error("Malformed offer commit.");
    return c;
  }
  async find(projectId: string, episodeId: string): Promise<TrialOfferCommit | null> {
    const committed = await this.readCommit(projectId, episodeId);
    const intent = await this.pending(projectId, episodeId);
    if (committed) {
      if (!intent || committed.receipt.offerPolicyFingerprint !== intent.offerPolicyFingerprint || committed.receipt.createdAt !== intent.createdAt)
        throw new Error("Ambiguous committed offer intent.");
      return committed;
    }
    if (!intent) return null;
    return this.lock.withLock(async () => {
      const current = await this.readCommit(projectId, episodeId);
      if (current) return current;
      const intent = await this.pending(projectId, episodeId);
      if (!intent) throw new Error("Offer intent disappeared.");
      return this.publishUnlocked({ schemaVersion: 1, receipt: intent, assignment: null });
    });
  }
  private async pending(projectId: string, episodeId: string): Promise<TrialOfferReceipt | null> {
    const r = await this.json(this.path(projectId, episodeId, true));
    if (r === null) return null;
    if (!validateTrialOfferReceipt(r) || r.projectId !== projectId || r.workEpisodeId !== episodeId || r.reason !== "interrupted" || r.outcome !== "no-offer") throw new Error("Malformed offer intent.");
    return r;
  }
  private async history(projectId: string): Promise<readonly TrialOfferCommit[]> {
    let names: string[];
    try { names = await readdir(this.dir(projectId)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const uuid = "[0-9a-f-]{36}";
    names = names.filter((n) => n !== "reservations");
    if (names.length > MAX_RETAINED_TRIAL_OFFER_DECISIONS * 3 || names.some((n) => !new RegExp(`^${uuid}(?:\\.pending)?\\.json(?:\\.${uuid}\\.tmp)?$`).test(n))) throw new Error("Malformed/capacity offer history.");
    const episodes = [...new Set(names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, 36)))].sort();
    if (episodes.length > MAX_RETAINED_TRIAL_OFFER_DECISIONS) throw new Error("Offer history capacity.");
    const commits: TrialOfferCommit[] = [];
    for (const id of episodes) {
      const c = await this.readCommit(projectId, id), intent = await this.pending(projectId, id);
      if (!intent || (c && (c.receipt.offerPolicyFingerprint !== intent.offerPolicyFingerprint || c.receipt.createdAt !== intent.createdAt))) throw new Error("Ambiguous offer history.");
      // Every interrupted prior attempt becomes a terminal no-offer, never a fairness attempt.
      if (!c) await this.publishUnlocked({ schemaVersion: 1, receipt: intent, assignment: null });
      commits.push(c ?? { schemaVersion: 1, receipt: intent, assignment: null });
    }
    return commits;
  }
  private reservationPath(projectId: string, id: string): string {
    if (!UUID_V4.test(id)) throw new Error("Invalid reservation identity.");
    return join(this.dir(projectId), "reservations", `${id}.json`);
  }
  private async reservations(projectId: string): Promise<readonly TrialOfferReservation[]> {
    let names: string[];
    try { names = await readdir(join(this.dir(projectId), "reservations")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    if (names.length > MAX_RETAINED_TRIAL_OFFER_DECISIONS * 2 || names.some((n) => !/^[0-9a-f-]{36}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(n))) throw new Error("Malformed reservation history.");
    const entries: TrialOfferReservation[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const r = await this.json(join(this.dir(projectId), "reservations", name));
      if (!validateTrialOfferReservation(r) || r.projectId !== projectId || `${r.id}.json` !== name) throw new Error("Malformed reservation.");
      entries.push(r);
    }
    return entries;
  }
  /** All disk-backed selection happens ahead of the Task boundary, under the existing writer lock. */
  async reserve(projectId: string, now: number, select: (history: readonly TrialOfferCommit[], held: readonly TrialOfferReservation[]) => Promise<TrialOfferReservation | null>, signal: AbortSignal, isCurrent: () => boolean): Promise<TrialOfferReservation | null> {
    return this.lock.withLock(async () => {
      signal.throwIfAborted();
      const history = await this.history(projectId), reservations = await this.reservations(projectId);
      if (history.length >= MAX_RETAINED_TRIAL_OFFER_DECISIONS || reservations.length >= MAX_RETAINED_TRIAL_OFFER_DECISIONS) throw new Error("Retained preparation capacity.");
      const held = reservations.filter((r) => now < r.expiresAt && !history.some((c) => c.assignment?.id === r.id));
      const r = await select(history, held);
      if (!r) return null;
      if (!validateTrialOfferReservation(r) || r.projectId !== projectId) throw new Error("Invalid reservation.");
      await this.atomic(this.reservationPath(projectId, r.id), r, signal, isCurrent);
      return r;
    });
  }
  /** Only a known never-claimed runtime slot may be released; episode dedupe/commits are never deleted. */
  async releaseUnusedReservation(reservation: TrialOfferReservation): Promise<void> {
    if (!validateTrialOfferReservation(reservation)) throw new Error("Invalid hold release.");
    await this.lock.withLock(async () => {
      const history = await this.history(reservation.projectId);
      if (history.some((c) => c.assignment?.id === reservation.id)) return;
      const path = this.reservationPath(reservation.projectId, reservation.id), existing = await this.json(path);
      if (existing === null) return;
      if (canonicalJson(existing) !== canonicalJson(reservation)) throw new Error("Conflicting hold release.");
      await rm(path);
    });
  }
  /** A single-use scheduling hold binds only AFTER a genuine committed Task occurrence. */
  async commitReserved(commit: TrialOfferCommit, signal: AbortSignal, isCurrent?: () => boolean): Promise<TrialOfferCommit> {
    if (!validateTrialOfferCommit(commit) || !commit.assignment) throw new Error("Invalid reserved commit.");
    const a = commit.assignment;
    const { workEpisodeId: _episode, comparison: _comparison, status: _status, fingerprint: _fp, createdAt: _created, expiresAt: _expiry, ...content } = a;
    const interrupted = fingerprintOfferReceipt({ ...commit.receipt, outcome: "no-offer", reason: "interrupted", assignment: null });
    return this.decide(interrupted, async (history) => {
      const r = await this.json(this.reservationPath(a.projectId, a.id));
      if (!validateTrialOfferReservation(r)) throw new Error("Malformed scheduling hold.");
      const { fingerprint: _hash, createdAt: _at, expiresAt: _until, ...reserved } = r;
      if (canonicalJson(reserved) !== canonicalJson(content) || a.createdAt < r.createdAt || a.createdAt >= r.expiresAt || a.expiresAt !== r.expiresAt ||
        history.some((c) => c.assignment?.id === a.id)) throw new Error("Stale/reused scheduling hold.");
      return commit;
    }, signal, isCurrent);
  }
  private async atomic(path: string, value: unknown, signal?: AbortSignal, canCommit?: () => boolean): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value) + "\n", { flag: "wx", signal });
      if (canCommit) await this.onBeforeCommit?.(); // Test-only barrier at the exact publication frontier.
      signal?.throwIfAborted();
      if (canCommit && !canCommit()) throw new Error("Stale offer publication authority.");
      // No await between final abort/authority validation and unique publication.
      linkSync(tmp, path);
    } finally { await rm(tmp, { force: true }); }
  }
  private async publishUnlocked(commit: TrialOfferCommit, signal?: AbortSignal, isCurrent?: () => boolean): Promise<TrialOfferCommit> {
    if (!validateTrialOfferCommit(commit)) throw new Error("Invalid offer publication.");
    const r = commit.receipt;
    const previous = await this.readCommit(r.projectId, r.workEpisodeId);
    if (previous) {
      if (canonicalJson(previous) !== canonicalJson(commit)) throw new Error("Conflicting WorkEpisode decision.");
      return previous;
    }
    // Receipt + assignment share ONE atomic immutable commit: no exposed assignment-only state.
    await this.atomic(this.path(r.projectId, r.workEpisodeId), commit, signal, () => commit.assignment === null || (isCurrent?.() ?? true));
    return commit;
  }
  /** Exact duplicate publication is idempotent; policy changes cannot create another episode decision. */
  async publish(commit: TrialOfferCommit): Promise<TrialOfferCommit> {
    return this.lock.withLock(async () => {
      if (!validateTrialOfferCommit(commit)) throw new Error("Invalid offer publication.");
      if (!await this.readCommit(commit.receipt.projectId, commit.receipt.workEpisodeId)) throw new Error("New publication requires decide protocol.");
      return this.publishUnlocked(commit);
    });
  }
  async decide(interrupted: TrialOfferReceipt, select: (history: readonly TrialOfferCommit[]) => Promise<TrialOfferCommit>, signal: AbortSignal, isCurrent?: () => boolean): Promise<TrialOfferCommit> {
    if (!validateTrialOfferReceipt(interrupted) || interrupted.reason !== "interrupted") throw new Error("Invalid offer intent.");
    return this.lock.withLock(async () => {
      signal.throwIfAborted();
      const r = interrupted;
      const history = await this.history(r.projectId);
      const old = await this.readCommit(r.projectId, r.workEpisodeId);
      if (old) return old;
      if (history.length >= MAX_RETAINED_TRIAL_OFFER_DECISIONS) throw new Error("Retained offer capacity.");
      await this.atomic(this.path(r.projectId, r.workEpisodeId, true), r, signal);
      signal.throwIfAborted();
      const commit = await select(history);
      signal.throwIfAborted(); // Timeout cannot publish a late offer after Task context froze without one.
      if (commit.receipt.projectId !== r.projectId || commit.receipt.workEpisodeId !== r.workEpisodeId ||
        commit.receipt.offerPolicyFingerprint !== r.offerPolicyFingerprint || commit.receipt.createdAt !== r.createdAt) throw new Error("Offer intent mismatch.");
      return this.publishUnlocked(commit, signal, isCurrent);
    });
  }
}
export const fingerprintOfferReceipt = (value: Omit<TrialOfferReceipt, "fingerprint">): TrialOfferReceipt =>
  ({ ...value, fingerprint: learningArtifactFingerprint(value) });
