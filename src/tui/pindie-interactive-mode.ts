import type {
  AgentSessionEvent,
  InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";

import type { PindiePresentationReaderLease } from "../host.ts";
import {
  appendUserDelivery,
  createPindieUiProjection,
  reduceProjectionEvent,
  refreshProjectionFacts,
  type PindieUiProjection,
  type PindieUiProjectionInput,
  type UiUserDelivery,
} from "../ui-projection.ts";
import { PiRuntimeAdapter } from "../pi-runtime.ts";
import {
  PindieTuiView,
  type PindieTuiViewOptions,
  type PindieTuiViewPort,
} from "./view.ts";

export interface PindieInteractiveModeOptions extends Pick<
  InteractiveModeOptions,
  "startupDiagnostics" | "modelFallbackMessage" | "terminal"
> {
  readonly presentation: PindiePresentationReaderLease;
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly refreshIntervalMs?: number;
  readonly createView?: (options: PindieTuiViewOptions) => PindieTuiViewPort;
  readonly scheduleRefresh?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearRefresh?: (timer: ReturnType<typeof setInterval>) => void;
}

interface SessionBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly unsubscribe: () => void;
}

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startupNotices(options: PindieInteractiveModeOptions): string[] {
  return [
    ...(options.startupDiagnostics ?? []).map((diagnostic) =>
      `${diagnostic.type}: ${diagnostic.message}`),
    ...(options.modelFallbackMessage === undefined
      ? []
      : [`warning: ${options.modelFallbackMessage}`]),
  ];
}

/**
 * The first Pindie-owned interactive client. Pi still owns the Agent Loop and
 * native AgentSession; this class owns only the disposable projection/client
 * lifecycle and routes user gestures through PiRuntimeAdapter.
 */
export class PindieInteractiveMode {
  private readonly runtime: PiRuntimeAdapter;
  private readonly presentation: PindiePresentationReaderLease;
  private readonly view: PindieTuiViewPort;
  private readonly refreshIntervalMs: number;
  private readonly scheduleRefresh: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearRefresh: (timer: ReturnType<typeof setInterval>) => void;
  private projection: PindieUiProjection | null = null;
  private sessionBinding: SessionBinding | null = null;
  private bindingGeneration = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private userSequence = 1;
  private abortInFlight = false;
  private attentionResponseInFlight = false;
  private exitResolver: (() => void) | null = null;
  private exitRequested = false;
  private stopped = false;
  private runPromise: Promise<void> | null = null;

  constructor(runtime: PiRuntimeAdapter, options: PindieInteractiveModeOptions) {
    this.runtime = runtime;
    this.presentation = options.presentation;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.scheduleRefresh = options.scheduleRefresh ?? ((callback, delayMs) =>
      setInterval(callback, delayMs));
    this.clearRefresh = options.clearRefresh ?? ((timer) => clearInterval(timer));

    const viewOptions: PindieTuiViewOptions = {
      terminal: options.terminal,
      startupNotices: startupNotices(options),
      onSubmit: (text) => this.handleSubmit(text),
      onFollowUp: (text) => this.handleFollowUp(text),
      onAttentionResponse: (text) => this.handleAttentionResponse(text),
      onAbort: () => this.handleAbort(),
      onExit: () => this.requestExit(),
    };
    this.view = options.createView?.(viewOptions) ?? new PindieTuiView(viewOptions);
  }

  run(): Promise<void> {
    this.runPromise ??= this.runInternal();
    return this.runPromise;
  }

  private async runInternal(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });

    try {
      this.view.start();
      this.runtime.setActiveSessionClientLifecycle({
        beforeSessionInvalidate: () => this.beforeSessionInvalidate(),
        rebindSession: () => this.rebindSession(),
      });
      await this.rebindSession();
      this.refreshTimer = this.scheduleRefresh(
        () => this.refreshCurrentFacts(),
        this.refreshIntervalMs,
      );
      if (this.exitRequested) return;
      await exited;
    } finally {
      this.shutdown();
    }
  }

  private buildProjectionInput(): PindieUiProjectionInput {
    const sessionId = this.runtime.activeSessionId;
    const runtimeFacts = this.runtime.getActiveSessionFacts();
    return {
      presentation: this.presentation.current()?.snapshot() ?? null,
      session: {
        sessionId,
        displayIdentity: this.runtime.getActiveSessionDisplayIdentity(),
        model: this.runtime.getActiveSessionModelIdentity(),
        thinkingLevel: this.runtime.getActiveSessionThinkingLevel(),
        runtime: runtimeFacts,
        branch: this.runtime.getActiveSessionBranch(),
      },
    };
  }

  private extensionBindings() {
    return {
      // F2a owns semantic Pindie Attention and intentionally omits uiContext.
      // F2b owns Pi ExtensionUIContext and runtime-permission compatibility.
      mode: "tui" as const,
      abortHandler: () => this.handleAbort(),
      shutdownHandler: () => this.requestExit(),
      onError: (error: { error: string }) => {
        this.view.showNotice(`Extension error: ${error.error}`);
      },
    };
  }

  private async rebindSession(): Promise<void> {
    const generation = ++this.bindingGeneration;
    this.userSequence = 1;
    await this.runtime.bindActiveSessionExtensions(this.extensionBindings());

    const sessionId = this.runtime.activeSessionId;
    const unsubscribe = this.runtime.subscribeActiveSession((event) => {
      this.handleSessionEvent(sessionId, generation, event);
    });
    this.sessionBinding = { sessionId, generation, unsubscribe };

    try {
      const projection = createPindieUiProjection(this.buildProjectionInput());
      this.projection = projection;
      this.view.apply(projection);
    } catch (error) {
      this.sessionBinding = null;
      unsubscribe();
      throw error;
    }
  }

  private beforeSessionInvalidate(): void {
    this.unsubscribeSession();
    this.projection = null;
    this.bindingGeneration += 1;
    this.userSequence = 1;
    this.attentionResponseInFlight = false;
  }

  private unsubscribeSession(): void {
    const binding = this.sessionBinding;
    this.sessionBinding = null;
    if (binding === null) return;
    binding.unsubscribe();
  }

  private handleSessionEvent(
    sessionId: string,
    generation: number,
    event: AgentSessionEvent,
  ): void {
    const binding = this.sessionBinding;
    if (
      binding === null ||
      binding.sessionId !== sessionId ||
      binding.generation !== generation ||
      this.runtime.activeSessionId !== sessionId ||
      this.projection === null
    ) return;

    this.projection = reduceProjectionEvent(this.projection, event);
    this.view.apply(this.projection);
  }

  private refreshCurrentFacts(): void {
    const current = this.projection;
    if (current === null || this.sessionBinding === null) return;
    try {
      const refreshed = refreshProjectionFacts(current, this.buildProjectionInput());
      this.projection = refreshed;
      this.view.apply(refreshed);
    } catch (error) {
      this.view.showNotice(`Refresh failed: ${errorMessage(error)}`);
    }
  }

  private currentSessionBinding(): SessionBinding | null {
    const binding = this.sessionBinding;
    const projection = this.projection;
    if (
      binding === null ||
      projection === null ||
      binding.sessionId !== this.runtime.activeSessionId ||
      projection.header.sessionId !== binding.sessionId
    ) return null;
    return binding;
  }

  private appendLocalUserDelivery(text: string, delivery: UiUserDelivery): void {
    const projection = this.projection;
    const binding = this.currentSessionBinding();
    if (projection === null || binding === null) return;
    const id = `live:${binding.sessionId}:user:${this.userSequence}`;
    this.userSequence += 1;
    this.projection = appendUserDelivery(projection, { id, text, delivery });
    this.view.apply(this.projection);
  }

  private handleSubmit(text: string): void {
    this.deliverUserText(text, "normal");
  }

  private handleFollowUp(text: string): void {
    this.deliverUserText(text, "followUp");
  }

  private deliverUserText(text: string, source: "normal" | "followUp"): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;

    const attention = this.projection?.attention ?? null;
    if (attention !== null) {
      this.view.setEditorText(text);
      this.view.showNotice(attention.kind === "human-gate"
        ? "Decision required; respond through Attention."
        : "Semantic authority unavailable; input kept in Composer.");
      return;
    }

    if (this.currentSessionBinding() === null) {
      this.view.setEditorText(text);
      this.view.showNotice("Session switching; input kept in Composer.");
      return;
    }

    let facts;
    try {
      facts = this.runtime.getActiveSessionFacts();
    } catch (error) {
      this.view.showNotice(`Unable to read active Session: ${errorMessage(error)}`);
      return;
    }
    const delivery: UiUserDelivery = source === "followUp"
      ? facts.isIdle ? "prompt" : "followUp"
      : facts.isIdle ? "prompt" : "steer";

    this.view.clearEditor();
    this.appendLocalUserDelivery(trimmed, delivery);

    try {
      const request = delivery === "prompt"
        ? this.runtime.prompt(trimmed)
        : delivery === "steer"
          ? this.runtime.steer(trimmed)
          : this.runtime.followUp(trimmed);
      void Promise.resolve(request).catch((error: unknown) => {
        this.view.showNotice(`Delivery failed: ${errorMessage(error)}`);
      });
    } catch (error) {
      this.view.showNotice(`Delivery failed: ${errorMessage(error)}`);
    }
  }

  private handleAttentionResponse(text: string): void {
    const response = text.trim();
    if (response.length === 0 || this.attentionResponseInFlight) return;
    if (this.currentSessionBinding() === null) {
      this.view.showNotice("Session switching; Attention response kept.");
      return;
    }
    if (this.projection?.attention?.kind !== "human-gate") {
      this.view.showNotice("Decision is no longer current; response kept.");
      return;
    }

    let facts;
    try {
      facts = this.runtime.getActiveSessionFacts();
    } catch (error) {
      this.view.showNotice(`Unable to read active Session: ${errorMessage(error)}`);
      return;
    }
    if (!facts.isIdle) {
      this.view.showNotice("Agent is not safely idle; Attention response kept.");
      return;
    }

    this.attentionResponseInFlight = true;
    this.appendLocalUserDelivery(response, "prompt");
    try {
      void Promise.resolve(this.runtime.prompt(response))
        .catch((error: unknown) => {
          this.view.showNotice(`Attention delivery failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          this.attentionResponseInFlight = false;
        });
    } catch (error) {
      this.attentionResponseInFlight = false;
      this.view.showNotice(`Attention delivery failed: ${errorMessage(error)}`);
    }
  }

  private handleAbort(): void {
    if (this.abortInFlight) return;

    if (this.currentSessionBinding() === null) {
      this.view.showNotice("Session switching; abort ignored.");
      return;
    }

    let facts;
    try {
      facts = this.runtime.getActiveSessionFacts();
    } catch (error) {
      this.view.showNotice(`Unable to read active Session: ${errorMessage(error)}`);
      return;
    }
    if (facts.isIdle) return;

    this.abortInFlight = true;
    try {
      const queued = this.runtime.clearActiveSessionQueue();
      const currentText = this.view.getEditorText();
      const restored = [
        ...queued.steering,
        ...queued.followUp,
        currentText,
      ].filter((text) => text.length > 0).join("\n\n");
      this.view.setEditorText(restored);
      void Promise.resolve(this.runtime.abortActiveSession())
        .catch((error: unknown) => {
          this.view.showNotice(`Abort failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          this.abortInFlight = false;
        });
    } catch (error) {
      this.abortInFlight = false;
      this.view.showNotice(`Abort failed: ${errorMessage(error)}`);
    }
  }

  private requestExit(): void {
    if (this.exitRequested) return;
    this.exitRequested = true;
    this.exitResolver?.();
  }

  private shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeSession();
    this.projection = null;
    this.exitResolver = null;

    try {
      this.runtime.setActiveSessionClientLifecycle();
    } finally {
      const timer = this.refreshTimer;
      this.refreshTimer = null;
      if (timer !== null) {
        try {
          this.clearRefresh(timer);
        } finally {
          this.view.stop();
        }
      } else {
        this.view.stop();
      }
    }
  }
}

/** Expose the default interval for focused controller tests and diagnostics. */
export const PINDIE_TUI_REFRESH_INTERVAL_MS = DEFAULT_REFRESH_INTERVAL_MS;
