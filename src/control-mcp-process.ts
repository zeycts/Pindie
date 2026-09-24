import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createPindieControlMcpServer } from "./control-mcp.ts";
import { PindieControlWorkspace, type PindieControlWorkspaceOptions, resolveControlWorkspaceRoot } from "./control-workspace.ts";

export { resolveControlWorkspaceRoot };

export interface ControlMcpProcessOptions extends PindieControlWorkspaceOptions {
  readonly port?: number;
}

/** The loopback MCP endpoint outlives each explicit active-project binding. */
export async function startControlMcpProcess(options: ControlMcpProcessOptions): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const workspace = await PindieControlWorkspace.create(options);
  let server: Server | undefined;
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  try {
    handler = createMcpHandler(() => createPindieControlMcpServer(workspace));
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
        await handler!.close();
        await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
        await workspace.close();
      })();
      return closed;
    };
    return { port: (listener.address() as { port: number }).port, close };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await handler?.close();
    await workspace.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await resolveControlWorkspaceRoot(process.env.PINDIE_WORKSPACE_ROOT);
  const port = process.env.PINDIE_CONTROL_PORT === undefined ? 8765 : Number(process.env.PINDIE_CONTROL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PINDIE_CONTROL_PORT must be a valid TCP port.");
  const processHandle = await startControlMcpProcess({ workspaceRoot, port });
  const shutdown = () => { void processHandle.close().catch((error: unknown) => console.error(error)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
