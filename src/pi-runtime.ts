import type {
  AgentSession,
  AgentSessionRuntime,
  ContextUsage,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

export type SessionReplacementResult = Awaited<ReturnType<AgentSessionRuntime["newSession"]>>;
export type SessionReplacementOptions = NonNullable<Parameters<AgentSessionRuntime["newSession"]>[0]>;

export interface ActiveSessionFacts {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly pendingMessageCount: number;
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

  getContextUsage(): ContextUsage | undefined {
    return this.activeSession.getContextUsage();
  }

  getActiveSessionFacts(): ActiveSessionFacts {
    const session = this.activeSession;
    return {
      sessionId: session.sessionId,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessageCount: session.pendingMessageCount,
    };
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.activeSession.prompt(text, options);
  }

  steer(text: string, images?: ImageContent[]): Promise<void> {
    return this.activeSession.steer(text, images);
  }

  followUp(text: string, images?: ImageContent[]): Promise<void> {
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
