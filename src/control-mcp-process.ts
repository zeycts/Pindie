import { realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

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
  readonly port?: number;
  readonly createHost?: (options: PindieHostOptions) => Promise<PindieHost>;
  readonly createClient?: (host: PindieHost) => PindieControlClient;
}

/** One headless Host and Control binding outlive all private tunnel connections. */
export async function startControlMcpProcess(options: ControlMcpProcessOptions): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const root = await resolveControlProjectRoot(options.projectRoot);
  const host = await (options.createHost ?? createPindieHost)({
    cwd: root,
    // The Host chooses the owned TUI via env before calling either mode factory.
    // Suppress it explicitly even if the parent process prefers PINDIE_TUI=1.
    env: { ...process.env, PINDIE_TUI: "0" },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  let client: PindieControlClient | undefined;
  let server: Server | undefined;
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  try {
    client = (options.createClient ?? ((h) => new PindieControlClient(h.runtime, h.presentation, {
      bindActiveSession: () => h.runtime.bindActiveSessionExtensions({ mode: "print" }),
    })))(host);
    await client.start();
    // The SDK creates a fresh protocol instance per request; all instances
    // delegate to the SAME Host-owned Control client and current lease.
    handler = createMcpHandler(() => createPindieControlMcpServer(client!));
    const nodeHandler = toNodeHandler(handler);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    server = createServer((req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (req.url?.split("?", 1)[0] !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      void nodeHandler(req, res);
    });
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(options.port ?? 8765, "127.0.0.1", () => {
        listener.removeListener("error", reject);
        resolve();
      });
    });
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        // Only explicit process shutdown owns Host lifetime. HTTP request
        // disconnects and tunnel restarts never stop the Agent.
        await handler!.close();
        await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
        client!.dispose();
        await host.dispose();
      })();
      return closed;
    };
    return { port: (listener.address() as { port: number }).port, close };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await handler?.close();
    client?.dispose();
    await host.dispose();
    throw error;
  }
}

async function main(): Promise<void> {
  const projectRoot = await resolveControlProjectRoot(process.env.PINDIE_PROJECT_ROOT);
  const port = process.env.PINDIE_CONTROL_PORT === undefined ? 8765 : Number(process.env.PINDIE_CONTROL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PINDIE_CONTROL_PORT must be a valid TCP port.");
  const processHandle = await startControlMcpProcess({ projectRoot, port });
  const shutdown = () => { void processHandle.close().catch((error: unknown) => console.error(error)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
