import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { UiTimelineBlock } from "./ui-projection.ts";
import { watchReadInput } from "./watch-presentation-data.ts";

export type MonitorWaitReason = "changed" | "settled" | "human_gate" | "timeout" | "binding_changed";
export interface MonitorSnapshot {
  readonly lease: string;
  readonly revision: number;
  readonly session: { readonly id: string; readonly displayIdentity: string };
  readonly runtime: { readonly idle: boolean; readonly pendingMessageCount: number; readonly automaticWorkSettled: boolean };
  readonly semantic: {
    readonly authority?: "coherent" | "stale" | "unavailable" | "presentation-unavailable";
    readonly taskStatus: string | null;
    readonly taskGoal?: string | null;
    readonly verificationStatus: string | null;
    readonly verificationProgress: { readonly covered: number; readonly total: number } | null;
    readonly humanGate: { readonly kind: "decision" | "approval" | "input"; readonly question: string } | null;
  };
  readonly executionConfig: { readonly model: { readonly modelId: string } | null; readonly thinkingLevel: string };
}
export type WorkspaceObservationLike =
  | { readonly state: "no_active_project"; readonly activeProject: null }
  | { readonly state: "active_project"; readonly activeProject: string; readonly control: MonitorSnapshot };
export interface TimelineResult {
  readonly sessionId: string;
  readonly revision: number;
  readonly hasMoreBefore: boolean;
  readonly timeline: readonly UiTimelineBlock[];
}
export interface MonitorWaitRequest {
  readonly lease: string;
  readonly until: "meaningful_change";
  readonly afterRevision: number;
  readonly timeoutSeconds: number;
}
export interface WaitResult { readonly reason: MonitorWaitReason; readonly snapshot: MonitorSnapshot | null }
export interface PindieControlMonitorPort {
  observe(): Promise<WorkspaceObservationLike>;
  readTimeline(limit?: number): Promise<TimelineResult>;
  wait(request: MonitorWaitRequest): Promise<WaitResult>;
  close(): Promise<void>;
}

const REQUIRED: Readonly<Record<string, { readonly properties: readonly string[]; readonly required: readonly string[] }>> = {
  pindie_observe: { properties: [], required: [] },
  pindie_read_timeline: { properties: ["limit"], required: [] },
  pindie_wait: { properties: ["lease", "until", "afterRevision", "timeoutSeconds"], required: ["lease", "until"] },
};

export function resolvePindieControlMonitorEndpoint(portValue = process.env.PINDIE_CONTROL_PORT): URL {
  const port = portValue === undefined ? 8765 : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (typeof portValue === "string" && !/^\d+$/u.test(portValue))) {
    throw new Error("PINDIE_CONTROL_PORT must be a valid local TCP port.");
  }
  return new URL(`http://127.0.0.1:${port}/mcp`);
}

export interface MonitorAdvertisedTool {
  readonly name: string;
  readonly annotations?: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
}
export function verifyMonitorToolSurface(tools: readonly MonitorAdvertisedTool[]): void {
  for (const [name, surface] of Object.entries(REQUIRED)) {
    const tool = tools.find((entry) => entry.name === name);
    const annotations = tool?.annotations;
    const schema = tool?.inputSchema;
    const properties = record(schema?.properties);
    const required = Array.isArray(schema?.required) ? schema.required : [];
    // The monitor still sends {}; accept only the known optional discovery view,
    // without broadening this observer's port or accepting arbitrary additions.
    const hasModelView = name === "pindie_observe" && properties !== null && Object.hasOwn(properties, "view");
    const propertyNames = Object.keys(properties ?? {}).filter((key) => !hasModelView || key !== "view");
    if (hasModelView && !validEnumSchema(properties!.view, ["snapshot", "models"])) fail();
    if (!tool || annotations?.readOnlyHint !== true || annotations.destructiveHint !== false || annotations.openWorldHint !== false ||
      !properties || propertyNames.sort().join("\\0") !== [...surface.properties].sort().join("\\0") ||
      required.slice().sort().join("\\0") !== [...surface.required].sort().join("\\0") || schema?.additionalProperties !== false ||
      (name === "pindie_read_timeline" && !validIntegerSchema(properties.limit, 1, 50)) ||
      (name === "pindie_wait" && (!validStringSchema(properties.lease) || !validEnumSchema(properties.until, ["meaningful_change", "settled", "human_gate"]) ||
        !validIntegerSchema(properties.afterRevision, 0) || !validIntegerSchema(properties.timeoutSeconds, 1, 30)))) fail();
  }
}

function validIntegerSchema(value: unknown, minimum: number, maximum?: number): boolean {
  const schema = record(value);
  return schema?.type === "integer" && schema.minimum === minimum &&
    (maximum === undefined || schema.maximum === maximum);
}
function validStringSchema(value: unknown): boolean { return record(value)?.type === "string"; }
function validEnumSchema(value: unknown, expected: readonly string[]): boolean {
  const schema = record(value);
  return schema?.type === "string" && Array.isArray(schema.enum) &&
    schema.enum.slice().sort().join("\\0") === [...expected].sort().join("\\0");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): value is string { return typeof value === "string"; }
const taskStatus = (value: unknown): boolean => value === null || ["idle", "active", "blocked", "waiting_human", "done"].includes(String(value));
const verificationStatus = (value: unknown, allowNone = false): boolean => value === null || ["pending", "stale", "failed", "passed", ...(allowNone ? ["none"] : [])].includes(String(value));
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function fail(): never { throw new Error("Incompatible Pindie Control service."); }

export class MonitorControlError extends Error {
  readonly code: "stale_control_lease" | "no_active_project";
  constructor(code: "stale_control_lease" | "no_active_project", message: string) {
    super(message);
    this.name = "MonitorControlError";
    this.code = code;
  }
}

function controlError(value: unknown): never {
  const error = record(value);
  if (!error || !string(error.code) || error.code.length < 1 || error.code.length > 128 ||
    !string(error.message) || error.message.length < 1 || error.message.length > 2_048) fail();
  if (error.code === "stale_control_lease" || error.code === "no_active_project") {
    throw new MonitorControlError(error.code, error.message);
  }
  return fail();
}

function snapshot(value: unknown): MonitorSnapshot {
  const o = record(value), session = record(o?.session), runtime = record(o?.runtime), semantic = record(o?.semantic);
  const config = record(o?.executionConfig), model = config?.model === null ? null : record(config?.model);
  const gate = semantic?.humanGate === null ? null : record(semantic?.humanGate);
  const progress = semantic?.verificationProgress === null ? null : record(semantic?.verificationProgress);
  if (!o || !string(o.lease) || !integer(o.revision) || !session || !string(session.id) || !string(session.displayIdentity) ||
    !runtime || typeof runtime.idle !== "boolean" || !integer(runtime.pendingMessageCount) || typeof runtime.automaticWorkSettled !== "boolean" ||
    !semantic || !taskStatus(semantic.taskStatus) || !verificationStatus(semantic.verificationStatus, true) ||
    !(semantic.verificationProgress === null || (progress !== null && integer(progress.covered) && integer(progress.total))) ||
    !(semantic.humanGate === null || (gate !== null && ["decision", "approval", "input"].includes(String(gate.kind)) && string(gate.question))) ||
    !config || !(config.model === null || (model !== null && string(model.modelId))) || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(config.thinkingLevel))) fail();
  return {
    lease: o.lease as string, revision: o.revision as number,
    session: { id: session.id as string, displayIdentity: session.displayIdentity as string },
    runtime: { idle: runtime.idle as boolean, pendingMessageCount: runtime.pendingMessageCount as number, automaticWorkSettled: runtime.automaticWorkSettled as boolean },
    semantic: {
      ...(["coherent", "stale", "unavailable", "presentation-unavailable"].includes(String(semantic.authority))
        ? { authority: semantic.authority as NonNullable<MonitorSnapshot["semantic"]["authority"]> } : {}),
      taskStatus: semantic.taskStatus as string | null, verificationStatus: semantic.verificationStatus as string | null,
      ...(semantic.taskGoal === null || (string(semantic.taskGoal) && semantic.taskGoal.length <= 50_000)
        ? { taskGoal: semantic.taskGoal } : {}),
      verificationProgress: progress === null ? null : { covered: progress.covered as number, total: progress.total as number },
      humanGate: gate === null ? null : { kind: gate.kind as "decision" | "approval" | "input", question: gate.question as string },
    },
    executionConfig: { model: model === null ? null : { modelId: model.modelId as string }, thinkingLevel: config.thinkingLevel as string },
  };
}

const displayMode = (value: unknown): value is "compact" | "preview" | "full" => ["compact", "preview", "full"].includes(String(value));
const lifecycle = (value: unknown): value is "running" | "complete" | "failed" => ["running", "complete", "failed"].includes(String(value));
function plain(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return typeof value !== "string" || value.length <= 50_000;
  if (Array.isArray(value)) return value.length <= 2_000 && value.every((item) => plain(item, depth + 1));
  const object = record(value);
  return object !== null && Object.keys(object).length <= 2_000 && Object.values(object).every((item) => plain(item, depth + 1));
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => string(item) && item.length <= 50_000); }
function resultProjection(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  const result = record(value);
  if (!result || typeof result.isError !== "boolean" || !string(result.summary) || !plain(result.details)) return undefined;
  return { isError: result.isError, summary: result.summary, details: result.details,
    ...(typeof result.textContent === "string" && result.textContent.length <= 4_000 && result.textContent === result.summary
      ? { textContent: result.textContent } : {}),
  };
}
function safeCheck(value: unknown): Record<string, unknown> | null {
  const check = record(value);
  if (!check || !string(check.name) || (check.status !== "passed" && check.status !== "failed") || !stringArray(check.covers) || !string(check.evidence)) return null;
  return { name: check.name, status: check.status, covers: [...check.covers], evidence: check.evidence };
}
function safeChecks(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const checks = value.map(safeCheck);
  return checks.some((check) => check === null) ? null : checks as Record<string, unknown>[];
}
function decodeBlock(value: unknown): UiTimelineBlock | null {
  const b = record(value);
  if (!b || !string(b.id) || b.id.length > 50_000 || !displayMode(b.defaultDisplayMode)) return null;
  const base = { id: b.id, defaultDisplayMode: b.defaultDisplayMode };
  if (b.type === "message") {
    if (!["session", "live"].includes(String(b.source)) || !["user", "assistant", "custom"].includes(String(b.role)) || !string(b.text) ||
      !["streaming", "complete", "error"].includes(String(b.lifecycle)) || (b.delivery !== undefined && !["prompt", "steer", "followUp"].includes(String(b.delivery))) ||
      (b.customType !== undefined && !string(b.customType))) return null;
    return { type: "message", ...base, source: b.source, role: b.role, text: b.text, lifecycle: b.lifecycle,
      ...(b.delivery === undefined ? {} : { delivery: b.delivery }), ...(b.customType === undefined ? {} : { customType: b.customType }) } as UiTimelineBlock;
  }
  if (b.type === "runtime") {
    if (!["quota", "rollover", "stop", "retry", "permission", "generic"].includes(String(b.category)) || !string(b.title) || (b.detail !== undefined && !string(b.detail))) return null;
    return { type: "runtime", ...base, category: b.category, title: b.title, ...(b.detail === undefined ? {} : { detail: b.detail }) } as UiTimelineBlock;
  }
  if (b.type === "work") {
    if (!lifecycle(b.lifecycle) || !string(b.title) || !string(b.id)) return null;
    if (b.kind === "observation") {
      if (!Array.isArray(b.items)) return null;
      const items = b.items.map((candidate) => {
        const item = record(candidate), result = resultProjection(item?.result);
        if (!item || !string(item.toolCallId) || !string(item.toolName) || !string(item.label) || !lifecycle(item.lifecycle) || result === undefined) return null;
        return { toolCallId: item.toolCallId, toolName: item.toolName, input: item.toolName === "read" ? watchReadInput(item.input) : null, label: item.label, lifecycle: item.lifecycle, result };
      });
      if (items.some((item) => item === null)) return null;
      return { type: "work", ...base, kind: "observation", lifecycle: b.lifecycle, title: b.title, items } as UiTimelineBlock;
    }
    if (!["edit", "command", "external", "generic"].includes(String(b.kind)) || !string(b.toolCallId) || !string(b.toolName) || !(b.input === null || plain(b.input))) return null;
    const result = resultProjection(b.result);
    if (result === undefined) return null;
    return { type: "work", ...base, kind: b.kind, lifecycle: b.lifecycle, title: b.title, toolCallId: b.toolCallId, toolName: b.toolName, input: b.input, result } as UiTimelineBlock;
  }
  if (b.type === "semantic" && lifecycle(b.lifecycle)) {
    const common = { type: "semantic", ...base, lifecycle: b.lifecycle };
    if (b.category === "task") {
      if (!["start", "replace", "refine", "progress", "handoff"].includes(String(b.action)) || !(b.goal === null || string(b.goal)) ||
        !taskStatus(b.taskStatus) || !stringArray(b.blockers) || !stringArray(b.questions) || !(b.nextIntent === null || string(b.nextIntent)) ||
        !(b.successCriterionCount === null || integer(b.successCriterionCount)) || !(b.error === null || string(b.error))) return null;
      let handoff: Record<string, unknown> | null = null;
      if (b.handoff !== null) {
        const h = record(b.handoff);
        if (!h || !string(h.progressSummary) || !stringArray(h.decisions) || !(h.nextIntent === null || string(h.nextIntent))) return null;
        handoff = { progressSummary: h.progressSummary, decisions: [...h.decisions], nextIntent: h.nextIntent };
      }
      return { ...common, category: "task", action: b.action, goal: b.goal, taskStatus: b.taskStatus, blockers: [...b.blockers], questions: [...b.questions], nextIntent: b.nextIntent, successCriterionCount: b.successCriterionCount, handoff, error: b.error } as UiTimelineBlock;
    }
    if (b.category === "verification") {
      const checks = safeChecks(b.checks), pending = b.pendingCheck === null ? null : safeCheck(b.pendingCheck);
      if (!verificationStatus(b.verificationStatus) || !stringArray(b.coveredCriteria) || !(b.totalCriteria === null || integer(b.totalCriteria)) || checks === null ||
        !(b.pendingCheck === null || pending !== null) || !(b.error === null || string(b.error))) return null;
      return { ...common, category: "verification", verificationStatus: b.verificationStatus, coveredCriteria: [...b.coveredCriteria], totalCriteria: b.totalCriteria, checks, pendingCheck: pending, error: b.error } as unknown as UiTimelineBlock;
    }
    if (b.category === "human-gate") {
      if (!(b.gateKind === null || ["decision", "approval", "input"].includes(String(b.gateKind))) || !(b.question === null || string(b.question)) || !stringArray(b.options) ||
        !["open", "resolved"].includes(String(b.state)) || !(b.error === null || string(b.error))) return null;
      return { ...common, category: "human-gate", gateKind: b.gateKind, question: b.question, options: [...b.options], state: b.state, error: b.error } as UiTimelineBlock;
    }
    if (b.category === "completion") {
      const checks = safeChecks(b.checks);
      if (!string(b.summary) || !verificationStatus(b.verificationStatus) || checks === null || !(b.error === null || string(b.error))) return null;
      return { ...common, category: "completion", summary: b.summary, verificationStatus: b.verificationStatus, checks, error: b.error } as unknown as UiTimelineBlock;
    }
  }
  return null;
}
function timeline(value: unknown): TimelineResult {
  const r = record(value);
  if (!r || !string(r.sessionId) || !integer(r.revision) || typeof r.hasMoreBefore !== "boolean" || !Array.isArray(r.timeline)) fail();
  const blocks = r.timeline.map(decodeBlock);
  if (blocks.some((block) => block === null)) fail();
  return { sessionId: r.sessionId as string, revision: r.revision as number, hasMoreBefore: r.hasMoreBefore as boolean, timeline: blocks as UiTimelineBlock[] };
}
function observation(value: unknown): WorkspaceObservationLike {
  const o = record(value);
  if (o?.state === "no_active_project" && o.activeProject === null) return { state: "no_active_project", activeProject: null };
  if (o?.state === "active_project" && string(o.activeProject)) return { state: "active_project", activeProject: o.activeProject, control: snapshot(o.control) };
  return fail();
}
function waitResult(value: unknown): WaitResult {
  const r = record(value);
  if (!r || !["changed", "settled", "human_gate", "timeout", "binding_changed"].includes(String(r.reason)) ||
    (r.reason === "binding_changed" ? !(r.snapshot === null || record(r.snapshot) !== null) : r.snapshot === null)) fail();
  const decoded = r.snapshot === null ? null : snapshot(r.snapshot);
  if (r.reason === "human_gate" && decoded?.semantic.humanGate === null) fail();
  return { reason: r.reason as MonitorWaitReason, snapshot: decoded };
}

interface SdkPort {
  connect(transport: StreamableHTTPClientTransport): Promise<void>;
  listTools(): Promise<{ tools: readonly { name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ isError?: boolean; structuredContent?: unknown }>;
  close(): Promise<void>;
}
const sdkFactory = () => {
  const client = new Client({ name: "pindie-control-monitor", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(resolvePindieControlMonitorEndpoint());
  return { client, transport };
};

/** Read-only typed adapter. Tool names are closed over this implementation. */
export class PindieControlMonitorClient implements PindieControlMonitorPort {
  readonly #client: SdkPort;
  readonly #transport: StreamableHTTPClientTransport;
  #closed = false;
  private constructor(client: SdkPort, transport: StreamableHTTPClientTransport) { this.#client = client; this.#transport = transport; }
  static async connect(signal?: AbortSignal): Promise<PindieControlMonitorClient> {
    const { client, transport } = sdkFactory();
    const adapter = new PindieControlMonitorClient(client, transport);
    const abort = () => { void Promise.allSettled([client.close(), transport.close()]); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("Monitor stopped");
      await client.connect(transport);
      if (signal?.aborted) throw new Error("Monitor stopped");
      const { tools } = await client.listTools();
      verifyMonitorToolSurface(tools as MonitorAdvertisedTool[]);
      if (signal?.aborted) throw new Error("Monitor stopped");
      return adapter;
    } catch (error) {
      await adapter.close();
      if (error instanceof Error && error.message === "Incompatible Pindie Control service.") throw error;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async #invoke(name: "pindie_observe" | "pindie_read_timeline" | "pindie_wait", args: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) throw new Error("Monitor client is closed.");
    const result = await this.#client.callTool({ name, arguments: args });
    if (result.isError === true) controlError(result.structuredContent);
    if (result.structuredContent === undefined) fail();
    return result.structuredContent;
  }
  async observe(): Promise<WorkspaceObservationLike> { return observation(await this.#invoke("pindie_observe", {})); }
  async readTimeline(limit = 50): Promise<TimelineResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Timeline limit must be between 1 and 50.");
    return timeline(await this.#invoke("pindie_read_timeline", { limit }));
  }
  async wait(request: MonitorWaitRequest): Promise<WaitResult> { return waitResult(await this.#invoke("pindie_wait", request as unknown as Record<string, unknown>)); }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([this.#client.close(), this.#transport.close()]);
  }
}
