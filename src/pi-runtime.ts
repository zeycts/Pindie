import { availableFallbackModels, supportsFallbackConfig, type QuotaFallbackConfig } from "./quota-fallback-config.ts";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type ContextUsage,
  type PromptOptions,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

export const MAX_SESSION_LINEAGE_NAME_LENGTH = 96;
export const DEFAULT_LONG_TASK_SESSION_NAME = "Pindie Long Task";

const CANONICAL_CONTINUATION_PREFIX = /^cont\. ([2-9]|[1-9]\d+) · (.+)$/u;
const HISTORICAL_CONTINUATION_SUFFIX = /^(.+) · cont\. ([2-9]|[1-9]\d+)$/u;

interface ParsedContinuationLineage {
  readonly ordinal: bigint;
  readonly base: string;
}

function parseContinuationLineage(source: string): ParsedContinuationLineage | undefined {
  const canonical = CANONICAL_CONTINUATION_PREFIX.exec(source);
  if (canonical) {
    return {
      ordinal: BigInt(canonical[1]!),
      base: canonical[2]!,
    };
  }

  // Keep a small compatibility path for Sessions persisted before the leading
  // prefix became canonical. New names are always generated in leading form.
  const historical = HISTORICAL_CONTINUATION_SUFFIX.exec(source);
  if (!historical) return undefined;
  return {
    ordinal: BigInt(historical[2]!),
    base: historical[1]!,
  };
}

/** Normalize text used only for a human-facing Pi Session display name. */
export function normalizeSessionDisplayWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Format the next automatic Long Task Session display name without semantic Task data. */
export function formatLongTaskContinuationSessionName(
  sourceDisplayIdentity: string | null | undefined,
): string {
  const source = normalizeSessionDisplayWhitespace(
    typeof sourceDisplayIdentity === "string" ? sourceDisplayIdentity : "",
  ) || DEFAULT_LONG_TASK_SESSION_NAME;
  const continuation = parseContinuationLineage(source);
  const base = continuation?.base ?? source;
  const ordinal = continuation === undefined ? 2n : continuation.ordinal + 1n;
  const prefix = `cont. ${ordinal} · `;
  const availableBaseLength = MAX_SESSION_LINEAGE_NAME_LENGTH - prefix.length;

  // An unreasonably large ordinal can itself exceed the compact bound. Preserve
  // the canonical prefix rather than ever cutting its meaning.
  if (availableBaseLength <= 0) return prefix;
  if (base.length <= availableBaseLength) return `${prefix}${base}`;
  return `${prefix}${base.slice(0, Math.max(0, availableBaseLength - 1))}…`;
}

function extractTextualUserContent(content: unknown): string | undefined {
  const rawText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((part): part is { type?: unknown; text?: unknown } =>
          typeof part === "object" && part !== null,
        )
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join(" ")
      : "";
  const text = normalizeSessionDisplayWhitespace(rawText);
  return text || undefined;
}

function firstRealUserMessageText(entries: readonly SessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    const text = extractTextualUserContent(message.content);
    if (text) return text;
  }
  return undefined;
}

export type SessionReplacementResult = Awaited<ReturnType<AgentSessionRuntime["newSession"]>>;
export type SessionReplacementOptions = NonNullable<Parameters<AgentSessionRuntime["newSession"]>[0]>;

export interface ActiveSessionFacts {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isIdle: boolean;
  readonly pendingMessageCount: number;
}

export interface ActiveSessionClientLifecycle {
  beforeSessionInvalidate?: () => void;
  rebindSession?: () => Promise<void>;
}

export interface ActiveProjectSessionChoice {
  readonly path: string;
  readonly id: string;
  readonly name?: string;
  readonly created: Date;
  readonly modified: Date;
  readonly messageCount: number;
  readonly firstMessage: string;
  readonly current: boolean;
}

/**
 * Pindie's small ownership boundary around Pi's active session runtime.
 *
 * The adapter deliberately resolves the active session from the native runtime
 * for every operation. Pi remains responsible for session teardown, creation,
 * cancellation, and InteractiveMode rebinding.
 */
export class PiRuntimeAdapter {
  private readonly nativeRuntime: AgentSessionRuntime;
  private disposePromise: Promise<void> | undefined;

  constructor(nativeRuntime: AgentSessionRuntime) {
    this.nativeRuntime = nativeRuntime;
  }

  get activeSession(): AgentSession {
    return this.nativeRuntime.session;
  }

  get activeSessionId(): string {
    return this.activeSession.sessionId;
  }

  /** Read the current Session's presentation identity, never semantic Task state. */
  getActiveSessionDisplayIdentity(): string {
    let sessionManager: AgentSession["sessionManager"];
    try {
      sessionManager = this.activeSession.sessionManager;
    } catch {
      return DEFAULT_LONG_TASK_SESSION_NAME;
    }

    try {
      const explicitName = sessionManager.getSessionName();
      const normalizedName = typeof explicitName === "string"
        ? normalizeSessionDisplayWhitespace(explicitName)
        : "";
      if (normalizedName) return normalizedName;
    } catch {
      // Continue to the textual fallback when explicit metadata is unavailable.
    }

    try {
      const userMessage = firstRealUserMessageText(sessionManager.getEntries());
      if (userMessage) return userMessage;
    } catch {
      // Session metadata is best-effort presentation information. The fallback
      // must not make Host-owned rollover unavailable.
    }
    return DEFAULT_LONG_TASK_SESSION_NAME;
  }

  /** Set the name on whichever native Session is active at call time. */
  setActiveSessionName(name: string): void {
    this.activeSession.setSessionName(name);
  }

  /**
   * Capture only the current setup-only Session, without opening any Session file.
   * The returned one-shot action is for a started prompt's preflight callback.
   * Unknown/custom history is deliberately ineligible, even without user text.
   */
  prepareInitialSessionName(name: string): (() => void) | undefined {
    const session = this.activeSession;
    const manager = session.sessionManager;
    const id = session.sessionId;
    const file = session.sessionFile;
    const header = manager.getHeader();
    if (!header || header.id !== id || manager.getSessionName() !== undefined || header.parentSession ||
      manager.getEntries().some((entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
      return undefined;
    }
    let attempted = false;
    return () => {
      if (attempted) return;
      attempted = true;
      if (this.activeSession !== session || session.sessionManager !== manager ||
        session.sessionId !== id || session.sessionFile !== file || manager.getSessionName() !== undefined) return;
      // Before started preflight, Pi may append system/custom setup messages.
      // A real conversation or explicit title/clear appearing meanwhile closes eligibility.
      if (manager.getEntries().some((entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change" &&
        entry.type !== "custom_message" && !(entry.type === "message" && entry.message.role === "system"))) return;
      session.setSessionName(name);
    };
  }

  getContextUsage(): ContextUsage | undefined {
    return this.activeSession.getContextUsage();
  }

  getActiveSessionFacts(): ActiveSessionFacts {
    const session = this.activeSession;
    return {
      sessionId: session.sessionId,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isIdle: session.isIdle,
      pendingMessageCount: session.pendingMessageCount,
    };
  }

  /**
   * Subscribe to the native Session active at call time.
   *
   * The returned unsubscribe function is scoped to that Session and does not
   * migrate when the native runtime replaces it. A custom interactive client
   * must unsubscribe before invalidation and subscribe again after rebind.
   */
  subscribeActiveSession(
    listener: Parameters<AgentSession["subscribe"]>[0],
  ): ReturnType<AgentSession["subscribe"]> {
    return this.activeSession.subscribe(listener);
  }

  /** Abort the native Session active at call time and await Pi's completion. */
  abortActiveSession(): Promise<void> {
    return this.activeSession.abort();
  }

  /** Clear Pi's native queues for the Session active at call time. */
  clearActiveSessionQueue(): ReturnType<AgentSession["clearQueue"]> {
    return this.activeSession.clearQueue();
  }

  /** Bind extension UI and command bindings on the Session active at call time. */
  bindActiveSessionExtensions(
    bindings: Parameters<AgentSession["bindExtensions"]>[0],
  ): ReturnType<AgentSession["bindExtensions"]> {
    return this.activeSession.bindExtensions(bindings);
  }

  /** Wait for whichever native Session is active at call time to settle. */
  waitForActiveSessionIdle(): Promise<void> {
    return this.activeSession.waitForIdle();
  }

  switchActiveSession(
    sessionPath: Parameters<AgentSessionRuntime["switchSession"]>[0],
    options?: Pick<NonNullable<Parameters<AgentSessionRuntime["switchSession"]>[1]>, "withSession">,
  ): ReturnType<AgentSessionRuntime["switchSession"]> {
    return this.nativeRuntime.switchSession(sessionPath, options);
  }

  /** Read Pi's native thinking level for the Session active at call time. */
  getActiveSessionThinkingLevel(): AgentSession["thinkingLevel"] {
    return this.activeSession.thinkingLevel;
  }

  /** Let Pi apply the requested level and report the current Session's effective level. */
  setActiveSessionThinkingLevel(level: AgentSession["thinkingLevel"]): AgentSession["thinkingLevel"] {
    const session = this.activeSession;
    session.setThinkingLevel(level);
    return session.thinkingLevel;
  }

  /**
   * Bind the one custom interactive client's Session lifecycle callbacks.
   *
   * AgentSessionRuntime exposes single callback slots, not a multi-subscriber
   * lifecycle event bus. Host/InteractiveMode ownership must install or clear
   * this binding as one coherent client; the rebind callback reads
   * adapter.activeSession after Pi applies the replacement.
   */
  setActiveSessionClientLifecycle(
    lifecycle?: ActiveSessionClientLifecycle,
  ): void {
    this.nativeRuntime.setBeforeSessionInvalidate(lifecycle?.beforeSessionInvalidate);
    this.nativeRuntime.setRebindSession(
      lifecycle?.rebindSession === undefined
        ? undefined
        : async () => lifecycle.rebindSession!(),
    );
  }

  isFallbackConfigAvailable(config: QuotaFallbackConfig): boolean {
    return supportsFallbackConfig(config, availableFallbackModels(this.activeSession.extensionRunner.getModelRegistry()));
  }

  getActiveSessionModelIdentity(): { provider: string; modelId: string } | null {
    const model = this.activeSession.model;
    return model ? { provider: model.provider, modelId: model.id } : null;
  }

  /** Check exact model availability in Pi's registry, independent of picker scope. */
  isActiveSessionModelAvailable(provider: string, modelId: string): boolean {
    const registry = this.activeSession.extensionRunner.getModelRegistry();
    return registry.find(provider, modelId) !== undefined && registry.getAvailable().some((model) =>
      model.provider === provider && model.id === modelId);
  }

  async setActiveSessionModel(provider: string, modelId: string): Promise<void> {
    const session = this.activeSession;
    const registry = session.extensionRunner.getModelRegistry();
    const model = registry.find(provider, modelId);
    if (model === undefined || !registry.getAvailable().some((candidate) =>
      candidate.provider === provider && candidate.id === modelId)) {
      throw new Error(`Model is no longer available: ${provider}/${modelId}`);
    }
    await session.setModel(model);
  }

  async getActiveProjectSessionChoices(): Promise<readonly ActiveProjectSessionChoice[]> {
    const session = this.activeSession;
    const manager = session.sessionManager;
    const sessions = await SessionManager.list(manager.getCwd(), manager.getSessionDir());
    return sessions.map((candidate) => ({
      path: candidate.path,
      id: candidate.id,
      ...(candidate.name === undefined ? {} : { name: candidate.name }),
      created: new Date(candidate.created),
      modified: new Date(candidate.modified),
      messageCount: candidate.messageCount,
      firstMessage: candidate.firstMessage,
      current: candidate.path === session.sessionFile || candidate.id === session.sessionId,
    }));
  }

  getActiveSessionBranch(): readonly SessionEntry[] {
    return this.activeSession.sessionManager.getBranch();
  }

  sendCustomMessage(
    message: Parameters<AgentSession["sendCustomMessage"]>[0],
    options?: Parameters<AgentSession["sendCustomMessage"]>[1],
  ): Promise<void> {
    return this.activeSession.sendCustomMessage(message, options);
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.activeSession.prompt(text, options);
  }

  steer(text: string, images?: ImageContent[]): ReturnType<AgentSession["steer"]> {
    return this.activeSession.steer(text, images);
  }

  followUp(text: string, images?: ImageContent[]): ReturnType<AgentSession["followUp"]> {
    return this.activeSession.followUp(text, images);
  }

  replaceWithFreshSession(options?: SessionReplacementOptions): Promise<SessionReplacementResult> {
    return this.nativeRuntime.newSession(options);
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.nativeRuntime.dispose();
    return this.disposePromise;
  }
}
