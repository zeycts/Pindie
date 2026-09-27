import type { PindieControlMonitorPort, MonitorSnapshot, TimelineResult, WaitResult } from "./control-monitor-client.ts";
import { MonitorControlError, PindieControlMonitorClient } from "./control-monitor-client.ts";

export type MonitorConnection = "connecting" | "connected" | "waiting" | "disconnected" | "incompatible";
export interface PindieControlMonitorState {
  readonly connection: MonitorConnection;
  readonly project: string | null;
  readonly snapshot: MonitorSnapshot | null;
  readonly timeline: TimelineResult | null;
  readonly message: string | null;
  readonly epoch?: number;
}
export interface PindieControlMonitorViewPort {
  start(): void;
  apply(state: PindieControlMonitorState): void;
  stop(): void;
}
export interface PindieControlMonitorOptions {
  readonly createClient?: (signal: AbortSignal) => Promise<PindieControlMonitorPort>;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Error("Monitor stopped"));
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Monitor stopped")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
  timer.unref?.();
});
const backoff = [250, 500, 1_000, 2_000, 5_000];

/** Observation/reconnect state machine. It owns no Host, Session, or semantic state. */
export class PindieControlMonitor {
  private readonly view: PindieControlMonitorViewPort;
  private readonly createClient: (signal: AbortSignal) => Promise<PindieControlMonitorPort>;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly abort = new AbortController();
  private client: PindieControlMonitorPort | null = null;
  private stopped = false;
  private epoch = 0;
  private runPromise: Promise<void> | null = null;
  private state: PindieControlMonitorState = { connection: "connecting", project: null, snapshot: null, timeline: null, message: null };

  constructor(view: PindieControlMonitorViewPort, options: PindieControlMonitorOptions = {}) {
    this.view = view;
    this.createClient = options.createClient ?? ((signal) => PindieControlMonitorClient.connect(signal));
    this.sleep = options.sleep ?? defaultSleep;
  }
  start(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.view.start();
    this.publish({ connection: "connecting", project: null, snapshot: null, timeline: null, message: null });
    this.runPromise = this.loop();
    return this.runPromise;
  }
  stop(): Promise<void> {
    if (this.stopped) return this.runPromise ?? Promise.resolve();
    this.stopped = true;
    this.abort.abort();
    const closing = this.closeClient();
    this.view.stop();
    return (this.runPromise ?? Promise.resolve()).then(() => closing);
  }
  private publish(state: PindieControlMonitorState): void {
    const next = { ...state, epoch: this.epoch };
    this.state = next;
    this.view.apply(next);
  }
  private async readTimeline(snapshot: MonitorSnapshot): Promise<{ readonly timeline: TimelineResult; readonly snapshot: MonitorSnapshot }> {
    const timeline = await this.client!.readTimeline(50);
    if (timeline.sessionId !== snapshot.session.id) throw new Error("Incompatible Pindie Control service.");
    return { timeline, snapshot: { ...snapshot, revision: Math.max(snapshot.revision, timeline.revision) } };
  }
  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => {});
  }
  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        this.publish({ ...this.state, connection: "connecting", message: null });
        this.client = await this.createClient(this.abort.signal);
        await this.attachLoop(() => { failures = 0; });
      } catch (error) {
        if (this.stopped) break;
        await this.closeClient();
        const incompatible = error instanceof Error && error.message.includes("Incompatible Pindie Control service");
        this.publish({ ...this.state, connection: incompatible ? "incompatible" : "disconnected", message: incompatible ? error.message : "DISCONNECTED · Reconnecting..." });
        if (incompatible) {
          await new Promise<void>((resolve) => this.abort.signal.addEventListener("abort", () => resolve(), { once: true }));
          break;
        }
        const delay = backoff[Math.min(failures, backoff.length - 1)]!;
        failures++;
        try { await this.sleep(delay, this.abort.signal); } catch { break; }
      }
    }
    await this.closeClient();
  }
  private async attachLoop(onAttached: () => void): Promise<void> {
    let project: string | null = null;
    let current: MonitorSnapshot | null = null;
    let timeline: TimelineResult | null = null;
    let inGate = false;
    while (!this.stopped && this.client) {
      try {
      if (current === null || inGate) {
        const observed = await this.client.observe();
        if (observed.state === "no_active_project") {
          if (this.state.project !== null) this.epoch++;
          project = null; current = null; timeline = null; inGate = false;
          this.publish({ connection: "waiting", project: null, snapshot: null, timeline: null, message: "No active project.\nWaiting for ChatGPT / Pindie Control to open one..." });
          onAttached();
          await this.sleep(1_000, this.abort.signal);
          continue;
        }
        const previous = current;
        const epochChanged = this.state.project !== observed.activeProject || project !== observed.activeProject || previous?.session.id !== observed.control.session.id || previous?.lease !== observed.control.lease;
        if (epochChanged) this.epoch++;
        project = observed.activeProject;
        current = observed.control;
        const gateOpen = current.semantic.humanGate !== null;
        if (inGate && !epochChanged && gateOpen) {
          this.publish({ connection: "connected", project, snapshot: current, timeline, message: "HUMAN GATE · Respond from ChatGPT / Pindie Control. This monitor is read-only." });
          await this.sleep(1_000, this.abort.signal);
          continue;
        }
        if (timeline === null || epochChanged || previous?.revision !== current.revision || inGate) {
          const refreshed = await this.readTimeline(current);
          timeline = refreshed.timeline;
          current = refreshed.snapshot;
        }
        inGate = gateOpen;
        this.publish({ connection: "connected", project, snapshot: current, timeline, message: gateOpen ? "HUMAN GATE · Respond from ChatGPT / Pindie Control. This monitor is read-only." : null });
        onAttached();
        if (inGate) {
          await this.sleep(1_000, this.abort.signal);
          continue;
        }
      }
      const timeoutSeconds = current.runtime.idle ? 30 : 2;
      const result: WaitResult = await this.client!.wait({ lease: current.lease, until: "meaningful_change", afterRevision: current.revision, timeoutSeconds });
      if (result.snapshot !== null) current = result.snapshot;
      if (result.reason === "binding_changed") { current = null; timeline = null; inGate = false; continue; }
      if (result.reason === "human_gate") {
        const refreshed = await this.readTimeline(current);
        timeline = refreshed.timeline;
        current = refreshed.snapshot;
        inGate = true;
        this.publish({ connection: "connected", project, snapshot: current, timeline, message: "HUMAN GATE · Respond from ChatGPT / Pindie Control. This monitor is read-only." });
        continue;
      }
      if (result.reason === "changed" || result.reason === "settled" || (result.reason === "timeout" && !current.runtime.idle)) {
        const refreshed = await this.readTimeline(current);
        timeline = refreshed.timeline;
        current = refreshed.snapshot;
        this.publish({ connection: "connected", project, snapshot: current, timeline, message: null });
      } else if (result.reason === "timeout") {
        this.publish({ connection: "connected", project, snapshot: current, timeline, message: null });
      }
      } catch (error) {
        if (!(error instanceof MonitorControlError)) throw error;
        current = null; timeline = null; inGate = false; project = null;
        if (error.code === "no_active_project") {
          if (this.state.project !== null) this.epoch++;
          this.publish({ connection: "waiting", project: null, snapshot: null, timeline: null, message: "No active project.\nWaiting for ChatGPT / Pindie Control to open one..." });
          await this.sleep(1_000, this.abort.signal);
        } else {
          this.epoch++;
          this.publish({ connection: "connecting", project: null, snapshot: null, timeline: null, message: null });
        }
      }
    }
  }
}
