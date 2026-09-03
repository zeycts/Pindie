import type {
  AgentSession,
  AgentSessionRuntime,
  ContextUsage,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai/compat";

export type SessionReplacementResult = Awaited<ReturnType<AgentSessionRuntime["newSession"]>>;

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

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.activeSession.prompt(text, options);
  }

  steer(text: string, images?: ImageContent[]): Promise<void> {
    return this.activeSession.steer(text, images);
  }

  followUp(text: string, images?: ImageContent[]): Promise<void> {
    return this.activeSession.followUp(text, images);
  }

  replaceWithFreshSession(): Promise<SessionReplacementResult> {
    return this.nativeRuntime.newSession();
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.nativeRuntime.dispose();
    return this.disposePromise;
  }
}
