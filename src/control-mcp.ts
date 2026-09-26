import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { PindieControlError } from "./control-client.ts";
import { PindieWorkspaceError, type PindieControlWorkspace } from "./control-workspace.ts";

const lease = z.string().min(1);
const text = z.string().min(1);
const noArgs = z.strictObject({});
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

// Errors are tool results, not protocol exceptions: callers can recover from
// stale leases using the current bounded snapshot without parsing prose.
async function invoke(action: () => Promise<unknown> | unknown) {
  try {
    const result = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof PindieControlError) && !(error instanceof PindieWorkspaceError)) throw error;
    const result = error instanceof PindieControlError
      ? { code: error.code, message: error.message, snapshot: error.snapshot }
      : { code: error.code, message: error.message };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  }
}

export function createPindieControlMcpServer(workspace: PindieControlWorkspace): McpServer {
  const server = new McpServer({ name: "pindie-control", version: "0.1.0" });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const consequential = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool("pindie_observe", {
    description: "Observe the bounded current Pindie Control snapshot.",
    inputSchema: noArgs, annotations: read,
  }, async () => invoke(() => workspace.observe()));
  server.registerTool("pindie_input", {
    description: "Deliver ordinary user intent; Pindie chooses the native delivery mode.",
    inputSchema: z.strictObject({ lease, text, timing: z.enum(["now", "after_current_run"]).optional() }),
    annotations: write,
  }, async (args) => invoke(() => workspace.withClient((client) => client.input(args))));
  server.registerTool("pindie_respond", {
    description: "Answer the matching current Human Gate while safely idle.",
    inputSchema: z.strictObject({ lease, gateKey: text, response: text }),
    annotations: consequential,
  }, async (args) => invoke(() => workspace.withClient((client) => client.respond(args))));
  server.registerTool("pindie_stop", {
    description: "Clear native queues and stop current work safely.",
    inputSchema: z.strictObject({ lease }), annotations: consequential,
  }, async (args) => invoke(() => workspace.withClient((client) => client.stop(args))));
  server.registerTool("pindie_fresh_session", {
    description: "Explicitly replace the safely idle active Pi Session.",
    inputSchema: z.strictObject({ lease }), annotations: consequential,
  }, async (args) => invoke(() => workspace.withClient((client) => client.freshSession(args))));
  server.registerTool("pindie_configure", {
    description: "Configure available model or fixed thinking level at a safe boundary.",
    inputSchema: z.strictObject({ lease, model: z.strictObject({ provider: text, modelId: text }).optional(), thinkingLevel: thinkingLevel.optional() }),
    annotations: write,
  }, async (args) => invoke(() => workspace.withClient((client) => client.configure(args))));
  server.registerTool("pindie_list_projects", {
    description: "List existing direct-child workspace projects.",
    inputSchema: noArgs, annotations: read,
  }, async () => invoke(() => workspace.listProjects()));
  server.registerTool("pindie_open_project", {
    description: "Explicitly open or safely switch to an existing workspace project.",
    inputSchema: z.strictObject({ project: text }), annotations: consequential,
  }, async (args) => invoke(() => workspace.openProject(args.project)));
  server.registerTool("pindie_create_project", {
    description: "Create one empty direct-child workspace project and safely open it.",
    inputSchema: z.strictObject({ project: text }), annotations: write,
  }, async (args) => invoke(() => workspace.createProject(args.project)));
  server.registerTool("pindie_list_sessions", {
    description: "List a bounded page of native Pi Sessions in the active project.",
    inputSchema: z.strictObject({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() }),
    annotations: read,
  }, async (args) => invoke(() => workspace.withClient((client) => client.listSessions(args))));
  server.registerTool("pindie_switch_session", {
    description: "Switch the active project Host to one of its native Pi Sessions.",
    inputSchema: z.strictObject({ lease, sessionId: text }),
    annotations: consequential,
  }, async (args) => invoke(() => workspace.withClient((client) => client.switchSession(args))));
  return server;
}
