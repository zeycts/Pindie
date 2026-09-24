import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { PindieControlClient } from "./control-client.ts";
import { createPindieControlMcpServer } from "./control-mcp.ts";
import { createPindieHost, type PindieHost, type PindieHostOptions } from "./host.ts";

export async function resolveControlProjectRoot(value: string | undefined): Promise<string> {
  if (!value?.trim()) throw new Error("PINDIE_PROJECT_ROOT must specify an existing project directory.");
  const root = await realpath(value);
  if (!(await stat(root)).isDirectory()) throw new Error("PINDIE_PROJECT_ROOT must be a directory.");
  return root;
}

export interface ControlMcpProcessOptions {
  readonly projectRoot: string;
  readonly createHost?: (options: PindieHostOptions) => Promise<PindieHost>;
  readonly createClient?: (host: PindieHost) => PindieControlClient;
  readonly serve?: typeof serveStdio;
}

/** One headless Host and one disposable Control binding per local stdio process. */
export async function startControlMcpProcess(options: ControlMcpProcessOptions): Promise<{ close(): Promise<void> }> {
  const root = await resolveControlProjectRoot(options.projectRoot);
  const host = await (options.createHost ?? createPindieHost)({
    cwd: root,
    // Host constructs a mode client even when run() is never called. MCP mode
    // must not construct either InteractiveMode or the owned TUI.
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  let client: PindieControlClient | undefined;
  try {
    client = (options.createClient ?? ((h) => new PindieControlClient(h.runtime, h.presentation)))(host);
    await client.start();
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        client!.dispose();
        await host.dispose();
      })();
      return closed;
    };
    const server = createPindieControlMcpServer(client);
    // The SDK owns stdio framing and era negotiation; its close event covers
    // disconnect/EOF without stopping or mutating the underlying Session.
    server.server.onclose = () => { void close().catch((error: unknown) => console.error(error)); };
    const transport = (options.serve ?? serveStdio)(() => server);
    return { close: async () => { await transport.close(); await close(); } };
  } catch (error) {
    client?.dispose();
    await host.dispose();
    throw error;
  }
}

async function main(): Promise<void> {
  const projectRoot = await resolveControlProjectRoot(process.env.PINDIE_PROJECT_ROOT);
  const processHandle = await startControlMcpProcess({ projectRoot });
  const shutdown = () => { void processHandle.close().catch((error: unknown) => console.error(error)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
