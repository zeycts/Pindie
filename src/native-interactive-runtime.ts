import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Pi 1.3 InteractiveMode awaits runtime.dispose() before its native process.exit.
 * Only that consumer gets this facade; PiRuntimeAdapter retains the original
 * runtime, so Host disposal delegates back to Pi without recursion. No global
 * exit interception, prototype changes, Session proxy, or second lifecycle loop.
 */
export function createNativeInteractiveRuntime(
  runtime: AgentSessionRuntime,
  disposeHost: () => Promise<void>,
): AgentSessionRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "dispose") return disposeHost;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
