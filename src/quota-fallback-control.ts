import type { QuotaFallbackConfig } from "./quota-fallback-config.ts";
import type { QuotaFallbackPlan, FallbackModelSelection } from "./quota-fallback-supervisor.ts";

export interface QuotaFallbackController {
  request(plan: QuotaFallbackPlan): Promise<boolean> | boolean;
  canUseBackup(sessionId: string, config?: QuotaFallbackConfig): boolean;
  cancel(sessionId: string): void;
  observeModelSelect(event: FallbackModelSelection): boolean;
  backupFailed(sessionId: string): Promise<QuotaFallbackPlan | null>;
}

interface Lease {
  readonly token: symbol;
  readonly receiver: QuotaFallbackController;
}

const KEY = Symbol.for("pindie.quota-fallback-control");
const processBridge = globalThis as typeof globalThis & { [key: symbol]: { active: Lease | null } | undefined };
const state = processBridge[KEY] ??= { active: null };

/** Process-local Host lease; a captured old controller cannot target a later Host. */
export function installQuotaFallbackReceiver(receiver: QuotaFallbackController): () => void {
  if (state.active) throw new Error("A Pindie Host already owns the quota fallback control bridge.");
  const lease = { token: Symbol("pindie-quota-fallback-host"), receiver };
  state.active = lease;
  return () => { if (state.active?.token === lease.token) state.active = null; };
}

export function getQuotaFallbackController(): QuotaFallbackController | null {
  const lease = state.active;
  if (!lease) return null;
  const current = () => {
    if (state.active?.token !== lease.token) throw new Error("Pindie Host quota fallback control bridge lease is no longer active.");
    return lease.receiver;
  };
  return {
    request: (plan) => current().request(plan),
    canUseBackup: (sessionId, config) => current().canUseBackup(sessionId, config),
    cancel: (sessionId) => current().cancel(sessionId),
    observeModelSelect: (event) => current().observeModelSelect(event),
    backupFailed: (sessionId) => current().backupFailed(sessionId),
  };
}
