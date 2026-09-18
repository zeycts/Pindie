import type { QuotaResumePlan } from "./quota-resume-incident.ts";

export type QuotaResumeControlEvent =
  | { readonly type: "schedule"; readonly plan: QuotaResumePlan }
  | { readonly type: "cancel"; readonly sessionId: string };

export interface QuotaResumeWaitingStatus {
  readonly sessionId: string;
  readonly resumeAt: number;
}

export type QuotaResumeReceiver = (event: QuotaResumeControlEvent) => void;
export type QuotaResumePublisher = (event: QuotaResumeControlEvent) => void;

export interface QuotaResumeHostLease {
  release(): void;
  publishWaitingStatus(status: QuotaResumeWaitingStatus | null): void;
}

export interface QuotaResumeStatusObserver {
  getSnapshot(): QuotaResumeWaitingStatus | null;
  subscribe(listener: (status: QuotaResumeWaitingStatus | null) => void): () => void;
}

interface BridgeLease {
  readonly token: symbol;
  readonly receiver: QuotaResumeReceiver;
  readonly listeners: Set<(status: QuotaResumeWaitingStatus | null) => void>;
  waitingStatus: QuotaResumeWaitingStatus | null;
  released: boolean;
}

interface BridgeState {
  activeLease: BridgeLease | null;
}

const BRIDGE_STATE_KEY = Symbol.for("pindie.quota-resume-control");
const processBridge = globalThis as typeof globalThis & {
  [key: symbol]: BridgeState | undefined;
};
const bridgeState = processBridge[BRIDGE_STATE_KEY] ??= { activeLease: null };

function leaseIsActive(lease: BridgeLease): boolean {
  return !lease.released && bridgeState.activeLease?.token === lease.token;
}

export function installQuotaResumeReceiver(receiver: QuotaResumeReceiver): QuotaResumeHostLease {
  if (bridgeState.activeLease !== null) {
    throw new Error("A Pindie Host already owns the quota resume control bridge.");
  }
  const lease: BridgeLease = {
    token: Symbol("pindie-quota-host-control"),
    receiver,
    listeners: new Set(),
    waitingStatus: null,
    released: false,
  };
  bridgeState.activeLease = lease;
  return {
    release: () => {
      if (lease.released) return;
      lease.released = true;
      lease.waitingStatus = null;
      lease.listeners.clear();
      if (bridgeState.activeLease?.token === lease.token) bridgeState.activeLease = null;
    },
    publishWaitingStatus: (status) => {
      if (!leaseIsActive(lease)) return;
      lease.waitingStatus = status;
      for (const listener of [...lease.listeners]) {
        try { listener(status); } catch { /* Status observation is best effort. */ }
      }
    },
  };
}

export function getQuotaResumePublisher(): QuotaResumePublisher | null {
  const lease = bridgeState.activeLease;
  if (lease === null) return null;
  return (event) => {
    if (!leaseIsActive(lease)) {
      throw new Error("Pindie Host quota resume control bridge lease is no longer active.");
    }
    lease.receiver(event);
  };
}

export function getQuotaResumeStatusObserver(): QuotaResumeStatusObserver | null {
  const lease = bridgeState.activeLease;
  if (lease === null) return null;
  return {
    getSnapshot: () => leaseIsActive(lease) ? lease.waitingStatus : null,
    subscribe: (listener) => {
      if (!leaseIsActive(lease)) return () => undefined;
      lease.listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        lease.listeners.delete(listener);
      };
    },
  };
}
