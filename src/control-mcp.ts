import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { PindieControlError, type PindieControlClient } from "./control-client.ts";

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
    if (!(error instanceof PindieControlError)) throw error;
    const result = { code: error.code, message: error.message, snapshot: error.snapshot };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  }
}

export function createPindieControlMcpServer(client: PindieControlClient): McpServer {
  const server = new McpServer({ name: "pindie-control", version: "0.1.0" });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const consequential = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  server.registerTool("pindie_observe", {
    description: "Observe the bounded current Pindie Control snapshot.",
    inputSchema: noArgs, annotations: read,
  }, async () => invoke(() => client.observe()));
  server.registerTool("pindie_input", {
    description: "Deliver ordinary user intent; Pindie chooses the native delivery mode.",
    inputSchema: z.strictObject({ lease, text, timing: z.enum(["now", "after_current_run"]).optional() }),
    annotations: write,
  }, async (args) => invoke(() => client.input(args)));
  server.registerTool("pindie_respond", {
    description: "Answer the matching current Human Gate while safely idle.",
    inputSchema: z.strictObject({ lease, gateKey: text, response: text }),
    annotations: consequential,
  }, async (args) => invoke(() => client.respond(args)));
  server.registerTool("pindie_stop", {
    description: "Clear native queues and stop current work safely.",
    inputSchema: z.strictObject({ lease }), annotations: consequential,
  }, async (args) => invoke(() => client.stop(args)));
  server.registerTool("pindie_fresh_session", {
    description: "Explicitly replace the safely idle active Pi Session.",
    inputSchema: z.strictObject({ lease }), annotations: consequential,
  }, async (args) => invoke(() => client.freshSession(args)));
  server.registerTool("pindie_configure", {
    description: "Configure available model or fixed thinking level at a safe boundary.",
    inputSchema: z.strictObject({ lease, model: z.strictObject({ provider: text, modelId: text }).optional(), thinkingLevel: thinkingLevel.optional() }),
    annotations: write,
  }, async (args) => invoke(() => client.configure(args)));
  return server;
}
