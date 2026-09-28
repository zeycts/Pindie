import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileGlobalWriterLock, type GlobalWriterLock } from "./store.ts";
import type { LearningBudgetPolicy } from "./learning-v1-contract.ts";

interface Reservation { readonly id: string; readonly day: string; readonly tokens: number; readonly timeMs: number }
interface BudgetState { readonly schemaVersion: 1; readonly reservations: Reservation[] }
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
const valid = (v: unknown): v is BudgetState => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const state = v as BudgetState;
  return Object.keys(state).sort().join() === "reservations,schemaVersion" && state.schemaVersion === 1 &&
    Array.isArray(state.reservations) && state.reservations.length <= 10000 && state.reservations.every((r) =>
      typeof r === "object" && r !== null && Object.keys(r).sort().join() === "day,id,timeMs,tokens" &&
      typeof r.id === "string" && /^[0-9a-f-]{36}$/.test(r.id) &&
      typeof r.day === "string" && /^\d{4}-\d\d-\d\d$/.test(r.day) &&
      Number.isSafeInteger(r.tokens) && r.tokens > 0 && Number.isSafeInteger(r.timeMs) && r.timeMs > 0) &&
    new Set(state.reservations.map((r) => r.id)).size === state.reservations.length;
};

/** Conservative accounting: the full reservation is charged even on abort/crash/unknown Pi usage.
 * This prevents a crash or duplicate claim from refunding tokens that may have been spent. */
export class FileLearningBudgetLedger {
  private readonly root: string;
  private readonly lock: GlobalWriterLock;
  constructor(options: { globalBaseDir?: string; lock?: GlobalWriterLock } = {}) {
    this.root = options.globalBaseDir ?? join(homedir(), ".pindie", "global");
    this.lock = options.lock ?? new FileGlobalWriterLock({ baseDir: this.root });
  }
  private path() { return join(this.root, "learning-v1", "budget.json"); }
  async read(): Promise<BudgetState> {
    let text: string;
    try { text = await readFile(this.path(), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, reservations: [] };
      throw error;
    }
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error("Malformed learning budget ledger."); }
    if (!valid(data)) throw new Error("Malformed learning budget ledger.");
    return data;
  }
  async reserve(now: number, policy: LearningBudgetPolicy): Promise<Reservation | null> {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid budget time.");
    return this.lock.withLock(async () => {
      const state = await this.read();
      const day = dayOf(now);
      // A backwards clock cannot reopen a pruned day's ceiling.
      if (state.reservations.some((r) => r.day > day)) return null;
      const today = state.reservations.filter((r) => r.day === day);
      if (today.reduce((n, r) => n + r.tokens, 0) + policy.perJobTokenCap > policy.dailyTokenCeiling ||
        today.reduce((n, r) => n + r.timeMs, 0) + policy.perJobTimeMsCap > policy.dailyTimeMsCeiling) return null;
      const reservation = { id: randomUUID(), day, tokens: policy.perJobTokenCap, timeMs: policy.perJobTimeMsCap };
      // Retain today's entries only. Previous days have already been charged and cannot be refunded.
      const next: BudgetState = { schemaVersion: 1, reservations: [...today, reservation] };
      if (!valid(next)) throw new Error("Learning budget capacity exceeded.");
      const path = this.path();
      const temp = `${path}.${randomUUID()}.tmp`;
      await mkdir(join(this.root, "learning-v1"), { recursive: true });
      try {
        await writeFile(temp, `${JSON.stringify(next)}\n`, { flag: "wx" });
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
      return reservation;
    });
  }
  /** Exact usage is optional; unknown is charged at the full cap, never estimated or refunded. */
  account(reservation: Reservation, usage?: { tokens: number; timeMs: number }): void {
    if (usage && (!Number.isSafeInteger(usage.tokens) || usage.tokens < 0 || usage.tokens > reservation.tokens ||
      !Number.isSafeInteger(usage.timeMs) || usage.timeMs < 0 || usage.timeMs > reservation.timeMs)) {
      throw new Error("Learning usage exceeds reserved cap.");
    }
  }
}
