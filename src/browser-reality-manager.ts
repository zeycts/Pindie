import { DevToolsClient } from "@amaster.ai/pi-browser-use";
import {
  assertBrowserToolDeclarations, browserClientConfig, browserToolCatalogCompatibility,
} from "./browser-tool-catalog.ts";
import {
  createBrowserRealityRuntime,
  type BrowserRealityConfig, type BrowserRealityRuntime, type BrowserRealityToolClient,
} from "./browser-reality.ts";

export type BrowserRealityPhase = "idle" | "starting" | "ready" | "releasing" | "failed" | "disposed";
export interface BrowserRealityManager {
  status(): { phase: BrowserRealityPhase; inFlight: number; reason: string | null };
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): ReturnType<BrowserRealityToolClient["callTool"]>;
  release(): Promise<void>;
  dispose(): Promise<void>;
  touch(): void;
}
export interface BrowserRealityManagerOptions {
  createRuntime?: (config: BrowserRealityConfig) => BrowserRealityRuntime;
  createClient?: (url: string) => BrowserRealityToolClient;
  canIdleRelease(): boolean;
  idleMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => number;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Host-local resources only. Session replacement neither creates nor releases them. */
export function createBrowserRealityManager(
  config: BrowserRealityConfig,
  options: BrowserRealityManagerOptions,
): BrowserRealityManager {
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? 15 * 60_000;
  let phase: BrowserRealityPhase = "idle";
  let reason: string | null = null;
  let runtime: BrowserRealityRuntime | undefined;
  let client: BrowserRealityToolClient | undefined;
  let closingClient: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let disposed = false;
  let lastActivity = now();
  let timer: NodeJS.Timeout | undefined;
  const calls = new Set<AbortController>();
  let onDrained: (() => void) | undefined;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Browser Reality shutdown was not confirmed before its deadline.")), options.shutdownTimeoutMs ?? 5_000);
      })]);
    } finally { clearTimeout(timeout); }
  };
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const arm = () => {
    clearTimer();
    if (disposed || phase !== "ready") return;
    timer = setTimeout(() => {
      let safe = false;
      try { safe = options.canIdleRelease() === true; } catch { /* Unknown authority fails closed. */ }
      if (calls.size === 0 && now() - lastActivity >= idleMs && safe) {
        void release().catch(() => { /* Failure remains visible through status. */ });
      } else arm();
    }, Math.max(1, now() - lastActivity < idleMs ? idleMs - (now() - lastActivity) : Math.min(idleMs, 1_000)));
    timer.unref();
  };
  const touch = () => { lastActivity = now(); arm(); };
  const closeClient = async () => {
    if (!client) return;
    const closing = client;
    // Some clients make a second close() a no-op even while their first close
    // is pending/rejected. Only the original operation can confirm termination.
    closingClient ??= Promise.resolve().then(() => closing.close());
    await bounded(closingClient);
    client = undefined;
    closingClient = undefined;
  };
  const cleanup = async () => {
    // Never remove a browser/profile after an unconfirmed bridge stop.
    await closeClient();
    if (runtime) { await runtime.dispose(); runtime = undefined; }
  };
  const ensure = async () => {
    if (disposed) throw new Error("Browser Reality Host is disposed.");
    if (releasing) await releasing;
    if (disposed) throw new Error("Browser Reality Host is disposed.");
    if (phase === "ready") return;
    if (phase === "failed") throw new Error(reason ?? "Browser Reality cleanup requires Host disposal.");
    if (!starting) {
      phase = "starting";
      starting = (async () => {
        try {
          if (!config.enabled) throw new Error("Browser Reality is disabled.");
          const mismatch = browserToolCatalogCompatibility();
          if (mismatch) throw new Error(mismatch);
          runtime = (options.createRuntime ?? createBrowserRealityRuntime)(config);
          const status = await runtime.start();
          if (!status.available) throw new Error(status.reason ?? "Browser Reality unavailable.");
          if (disposed) throw new Error("Browser Reality Host is disposed.");
          client = (options.createClient ?? ((url) => new DevToolsClient(browserClientConfig(url))))(runtime.config.browserUrl!);
          assertBrowserToolDeclarations(await client.listAllTools(AbortSignal.timeout(15_000)));
          if (disposed) throw new Error("Browser Reality Host is disposed.");
          phase = "ready";
          reason = null;
          touch();
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          phase = "failed";
          try { await cleanup(); if (!disposed) phase = "idle"; }
          catch (cleanupError) { reason += ` Cleanup failed: ${String(cleanupError)}`; }
          throw error;
        }
      })().finally(() => { starting = undefined; });
    }
    await starting;
  };
  const release = (): Promise<void> => {
    if (disposed) return disposing ?? Promise.resolve();
    if (calls.size || starting) return Promise.reject(new Error("Browser Reality has in-flight tools; release refused."));
    if (releasing) return releasing;
    clearTimer();
    phase = "releasing";
    releasing = cleanup().then(() => { phase = "idle"; reason = null; }, (error: unknown) => {
      phase = "failed"; reason = String(error); throw error;
    }).finally(() => { releasing = undefined; });
    return releasing;
  };
  return {
    status: () => ({ phase, inFlight: calls.size, reason }),
    touch,
    async callTool(name, args, signal) {
      if (disposed) throw new Error("Browser Reality Host is disposed.");
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal!.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      if (signal?.aborted) forwardAbort();
      calls.add(controller);
      touch();
      try {
        controller.signal.throwIfAborted();
        await waitFor(ensure(), controller.signal);
        controller.signal.throwIfAborted();
        return await client!.callTool(name, args, controller.signal);
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
        calls.delete(controller);
        if (calls.size === 0) onDrained?.();
        touch();
      }
    },
    release,
    dispose() {
      if (!disposing) {
        disposed = true;
        clearTimer();
        for (const call of calls) call.abort(new Error("Browser Reality Host is disposing."));
        disposing = (async () => {
          try {
            try { await starting; } catch { /* Startup owns its failure cleanup. */ }
            await releasing;
            // Closing the bridge unblocks calls even when upstream ignores abort.
            await closeClient();
            if (calls.size) await bounded(new Promise<void>((resolve) => { onDrained = resolve; }));
            await cleanup();
            phase = "disposed";
          } catch (error) {
            phase = "failed";
            reason = String(error);
            throw error;
          } finally { onDrained = undefined; }
        })();
      }
      return disposing;
    },
  };
}
