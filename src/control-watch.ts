import { pathToFileURL } from "node:url";
import { PindieControlMonitor } from "./control-monitor.ts";
import { PindieControlMonitorView } from "./control-monitor-view.ts";

export async function runControlWatch(): Promise<void> {
  let monitor: PindieControlMonitor;
  const view = new PindieControlMonitorView({ onExit: () => { void monitor.stop(); } });
  monitor = new PindieControlMonitor(view);
  const shutdown = () => { void monitor.stop(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try { await monitor.start(); }
  finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await monitor.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runControlWatch().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
