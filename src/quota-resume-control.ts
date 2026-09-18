import type { QuotaResumePlan } from "./quota-resume-incident.ts";

export type QuotaResumeControlEvent =
  | { readonly type: "schedule"; readonly plan: QuotaResumePlan }
  | { readonly type: "cancel"; readonly sessionId: string };

export type QuotaResumeReceiver = (event: QuotaResumeControlEvent) => void;
export type QuotaResumePublisher = (event: QuotaResumeControlEvent) => void;

interface BridgeLease {
  readonly token: symbol;
  readonly receiver: QuotaResumeReceiver;
}

interface BridgeState {
  activeLease: BridgeLease | null;
}

const BRIDGE_STATE_KEY = Symbol.for("pindie.quota-resume-control");
const processBridge = globalThis as typeof globalThis & {
  [key: symbol]: BridgeState | undefined;
};
const bridgeState = processBridge[BRIDGE_STATE_KEY] ??= { activeLease: null };

export function installQuotaResumeReceiver(receiver: QuotaResumeReceiver): () => void {
  if (bridgeState.activeLease !== null) {
    throw new Error("A Pindie Host already owns the quota resume control bridge.");
  }
  const lease = { token: Symbol("pindie-quota-host-control"), receiver };
  bridgeState.activeLease = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (bridgeState.activeLease?.token === lease.token) bridgeState.activeLease = null;
  };
}

export function getQuotaResumePublisher(): QuotaResumePublisher | null {
  const lease = bridgeState.activeLease;
  if (lease === null) return null;
  return (event) => {
    if (bridgeState.activeLease?.token !== lease.token) {
      throw new Error("Pindie Host quota resume control bridge lease is no longer active.");
    }
    lease.receiver(event);
  };
}
