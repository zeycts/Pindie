import type { TaskContinuityV1 } from "./task-continuity.ts";

export interface CommittedRolloverRequest {
  readonly sourceSessionId: string;
  readonly checkpoint: TaskContinuityV1;
}

export type CommittedRolloverReceiver = (request: CommittedRolloverRequest) => void;
export type CommittedRolloverPublisher = (request: CommittedRolloverRequest) => void;

interface BridgeLease {
  readonly token: symbol;
  readonly receiver: CommittedRolloverReceiver;
}

interface BridgeState {
  activeLease: BridgeLease | null;
}

// Pi may evaluate an extension through its loader with a separate module
// cache. A symbol-backed process cell keeps Host ownership shared across those
// loader boundaries without making the bridge durable or configurable.
const BRIDGE_STATE_KEY = Symbol.for("pindie.long-task-control");
const processBridge = globalThis as typeof globalThis & {
  [key: symbol]: BridgeState | undefined;
};
const bridgeState = processBridge[BRIDGE_STATE_KEY] ??= { activeLease: null };

/** Install the one process-local receiver owned by the Pindie Host. */
export function installCommittedRolloverReceiver(
  receiver: CommittedRolloverReceiver,
): () => void {
  if (bridgeState.activeLease !== null) {
    throw new Error("A Pindie Host already owns the committed rollover control bridge.");
  }

  const lease: BridgeLease = { token: Symbol("pindie-host-control"), receiver };
  bridgeState.activeLease = lease;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (bridgeState.activeLease?.token === lease.token) bridgeState.activeLease = null;
  };
}

/** Return a publisher scoped to the currently installed Host lease, if any. */
export function getCommittedRolloverPublisher(): CommittedRolloverPublisher | null {
  const lease = bridgeState.activeLease;
  if (lease === null) return null;
  return (request) => {
    if (bridgeState.activeLease?.token !== lease.token) {
      throw new Error("Pindie Host committed rollover control bridge lease is no longer active.");
    }
    lease.receiver(request);
  };
}
