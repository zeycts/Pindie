import type { IncomingMessage, ServerResponse } from "node:http";
import { PindieControlError, type PindieControlErrorCode } from "./control-client.ts";
import { PindieWorkspaceError, type PindieWorkspaceErrorCode } from "./control-workspace.ts";

// Public adapter vocabulary, never exception text. New domain codes require review.
const controlMessages = {
  invalid_request: "Pindie Control request is invalid.",
  stale_control_lease: "Pindie Control lease is stale. Observe the current Session before retrying.",
  semantic_unavailable: "Pindie semantic authority is unavailable; ordinary input is fail-closed.",
  human_gate_required: "Pindie requires a response to the current Human Gate.",
  human_gate_mismatch: "The Human Gate changed. Observe the current gate before responding.",
  unsafe_runtime_state: "Pindie Control requires an idle, settled Session with no pending messages.",
  model_unavailable: "The requested model is unavailable in the active registry.",
  delivery_failed: "Pindie could not confirm delivery. Observe before taking further action; do not automatically resend input.",
  delivery_uncertain: "Wait and observe; do not resend.",
  session_not_found: "The requested Session is unavailable in the active project.",
  session_ambiguous: "The requested Session ID is ambiguous in the active project.",
  session_switch_unsafe: "The current Session is not safe to replace.",
  session_switch_failed: "Pindie could not establish the requested Session. Observe the current binding.",
  dispatch_backlog_full: "Pindie Control dispatch backlog is full. Wait for pending work to settle.",
} satisfies Record<PindieControlErrorCode, string>;
const workspaceMessages = {
  no_active_project: "Open a project first.",
  invalid_project: "Project must be a direct workspace child directory.",
  project_not_found: "Project does not exist.",
  project_exists: "Project already exists.",
  project_create_failed: "Could not create project.",
  project_switch_unsafe: "Current project is not safe to leave.",
  project_open_failed: "Could not open project.",
} satisfies Record<PindieWorkspaceErrorCode, string>;

const internalError = () => ({ code: "internal_error", message:
  "Pindie Control could not complete the operation. Observe the current state; do not automatically resend input." });

/** Keep only reviewed public domain fields; never inspect arbitrary thrown values. */
export function publicControlMcpError(error: unknown): Record<string, unknown> {
  try {
    if (error instanceof PindieControlError && Object.hasOwn(controlMessages, error.code)) {
      const receipt = error.receipt;
      return { code: error.code, message: controlMessages[error.code], snapshot: error.snapshot,
        ...(receipt === undefined ? {} : { receipt: { dispatchId: receipt.dispatchId,
          delivery: receipt.delivery, nextAction: receipt.nextAction } }) };
    }
    if (error instanceof PindieWorkspaceError && Object.hasOwn(workspaceMessages, error.code)) {
      return { code: error.code, message: workspaceMessages[error.code] };
    }
  } catch { /* Malformed domain error: do not stringify it while reporting failure. */ }
  return internalError();
}

/** No exception argument: values, causes, request headers and paths cannot be logged here. */
export function logControlMcpFailure(phase: "startup" | "shutdown" | "transport"): void {
  console.error(`Pindie Control MCP ${phase} failed.`);
}

/** Last-resort Node adapter rejection boundary; never replay or fabricate a tool result. */
export async function handleControlMcpHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  try { await handler(req, res); }
  catch {
    logControlMcpFailure("transport");
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
  }
}
