import { platform } from "node:os";

import { REST, Routes } from "discord.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent } from "undici";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { DiscordClientSeam } from "./discord-remote.ts";

type GatewaySocket = Pick<WebSocket, "close" | "on" | "readyState" | "send" | "terminate">;
export type GatewaySocketFactory = (url: string, options: ClientOptions) => GatewaySocket;

export interface DiscordGatewayClientOptions {
  proxyUrl?: string;
  createSocket?: GatewaySocketFactory;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type Listener = (...args: any[]) => void;
type GatewayPayload = { op: number; d?: any; s?: number | null; t?: string };

const GATEWAY_INTENTS = 1 | 512 | 32_768;
const OPEN = 1;

/** Minimal single-process Discord Gateway client. Discord REST remains owned by discord.js. */
export class DiscordGatewayClient implements DiscordClientSeam {
  readonly rest: REST;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly createSocket: GatewaySocketFactory;
  private readonly setTimer: NonNullable<DiscordGatewayClientOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<DiscordGatewayClientOptions["clearTimer"]>;
  private readonly restProxyAgent: ProxyAgent | null;
  private socket: GatewaySocket | null = null;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private token: string | null = null;
  private gatewayUrl: string | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private destroyed = false;
  private loginResolve: (() => void) | null = null;
  private loginReject: ((error: Error) => void) | null = null;

  constructor(options: DiscordGatewayClientOptions = {}) {
    this.restProxyAgent = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : null;
    this.rest = new REST({ version: "10", ...(this.restProxyAgent ? { agent: this.restProxyAgent } : {}) });
    const gatewayProxyAgent = options.proxyUrl ? new HttpsProxyAgent(options.proxyUrl) : undefined;
    this.createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.socketOptions = gatewayProxyAgent ? { agent: gatewayProxyAgent, handshakeTimeout: 30_000 } : { handshakeTimeout: 30_000 };
  }

  private readonly socketOptions: ClientOptions;

  once(event: "ready", listener: () => void): void {
    const wrapper = () => { this.remove(event, wrapper); listener(); };
    this.add(event, wrapper);
  }

  on(event: "messageCreate" | "shardResume" | "error", listener: Listener): void { this.add(event, listener); }

  async login(token: string): Promise<void> {
    this.destroyed = false;
    this.token = token;
    this.rest.setToken(token);
    const gateway = await this.rest.get(Routes.gatewayBot()) as { url?: unknown };
    if (typeof gateway.url !== "string") throw new Error("Discord Gateway discovery failed.");
    this.gatewayUrl = gateway.url;
    const ready = new Promise<void>((resolve, reject) => { this.loginResolve = resolve; this.loginReject = reject; });
    this.connect();
    return ready;
  }

  destroy(): void {
    this.destroyed = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket; this.socket = null;
    try { socket?.close(1_000); } catch { socket?.terminate(); }
    this.loginReject?.(new Error("Discord Gateway client stopped."));
    this.loginResolve = null; this.loginReject = null; this.token = null;
    void this.restProxyAgent?.close().catch(() => undefined);
  }

  private connect(): void {
    if (this.destroyed || !this.gatewayUrl || !this.token) return;
    const base = this.resumeUrl ?? this.gatewayUrl;
    const url = `${base.replace(/\/$/, "")}/?v=10&encoding=json`;
    let socket: GatewaySocket;
    try { socket = this.createSocket(url, this.socketOptions); }
    catch (error) { this.fail(error); return; }
    this.socket = socket;
    socket.on("message", (data: RawData) => this.message(socket, data));
    socket.on("error", (error: Error) => this.emit("error", error));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.clearHeartbeat();
      if (!this.destroyed) this.reconnectTimer = this.setTimer(() => this.connect(), 1_000);
    });
  }

  private message(socket: GatewaySocket, raw: RawData): void {
    let payload: GatewayPayload;
    try { payload = JSON.parse(raw.toString()) as GatewayPayload; }
    catch { this.emit("error", new Error("Discord Gateway payload was invalid.")); return; }
    if (typeof payload.s === "number") this.sequence = payload.s;
    if (payload.op === 10) {
      this.scheduleHeartbeat(Number(payload.d?.heartbeat_interval));
      if (this.sessionId) this.send(socket, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.sequence } });
      else this.send(socket, { op: 2, d: { token: this.token, intents: GATEWAY_INTENTS, properties: { os: platform(), browser: "pindie", device: "pindie" } } });
      return;
    }
    if (payload.op === 1) { this.send(socket, { op: 1, d: this.sequence }); return; }
    if (payload.op === 7) { try { socket.close(4_000); } catch { socket.terminate(); } return; }
    if (payload.op === 9) {
      this.sessionId = null; this.resumeUrl = null; this.sequence = null;
      try { socket.close(4_000); } catch { socket.terminate(); }
      return;
    }
    if (payload.op !== 0) return;
    if (payload.t === "READY") {
      this.sessionId = typeof payload.d?.session_id === "string" ? payload.d.session_id : null;
      this.resumeUrl = typeof payload.d?.resume_gateway_url === "string" ? payload.d.resume_gateway_url : null;
      this.loginResolve?.(); this.loginResolve = null; this.loginReject = null;
      this.emit("ready");
    } else if (payload.t === "RESUMED") this.emit("shardResume");
    else if (payload.t === "MESSAGE_CREATE") {
      const data = payload.d;
      this.emit("messageCreate", {
        guildId: data?.guild_id ?? null,
        channelId: data?.channel_id,
        author: { id: data?.author?.id, bot: data?.author?.bot === true },
        content: data?.content ?? "",
        channel: { isThread: () => true },
      });
    }
  }

  private scheduleHeartbeat(interval: number): void {
    this.clearHeartbeat();
    if (!Number.isFinite(interval) || interval <= 0) return;
    const beat = () => {
      const socket = this.socket;
      if (!socket || socket.readyState !== OPEN) return;
      this.send(socket, { op: 1, d: this.sequence });
      this.heartbeatTimer = this.setTimer(beat, interval);
    };
    this.heartbeatTimer = this.setTimer(beat, Math.floor(Math.random() * interval));
  }

  private clearHeartbeat(): void { if (this.heartbeatTimer) this.clearTimer(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  private send(socket: GatewaySocket, payload: GatewayPayload): void { if (socket.readyState === OPEN) socket.send(JSON.stringify(payload)); }
  private fail(error: unknown): void { const failure = error instanceof Error ? error : new Error("Discord Gateway connection failed."); this.loginReject?.(failure); this.loginResolve = null; this.loginReject = null; this.emit("error", failure); }
  private add(event: string, listener: Listener): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
  private remove(event: string, listener: Listener): void { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener)); }
  private emit(event: string, ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
}
