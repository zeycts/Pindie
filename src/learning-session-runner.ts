import {
  createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type AgentSession, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";

/** No default discovery: no project/user extensions, Task tools, skills, context files or templates. */
export function learningResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are an internal bounded learning assistant. Return only the requested structured response.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
export interface LearningSessionResult { readonly text: string; readonly usage?: { readonly tokens: number; readonly timeMs: number } }
export interface LearningSessionRunner {
  run(prompt: string, signal: AbortSignal): Promise<LearningSessionResult>;
}
export interface LearningSessionFactoryOptions {
  readonly cwd: string;
  /** Model identity/value only; never a Human SessionManager or transcript. */
  readonly model: Model<any>;
  readonly createSession?: typeof createAgentSession;
  readonly onCreated?: (session: AgentSession) => void;
}
/** A fresh Pi Session per invocation. There are deliberately zero model-callable tools in F2. */
export function createLearningSessionRunner(options: LearningSessionFactoryOptions): LearningSessionRunner {
  return {
    async run(prompt, signal) {
      if (signal.aborted) throw new Error("Learning invocation aborted.");
      if (!prompt.trim() || prompt.length > 48_000) throw new Error("Invalid bounded learning packet.");
      const manager = SessionManager.inMemory(options.cwd);
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: "off",
        tools: [],
        noTools: "all",
        customTools: [],
        resourceLoader: learningResourceLoader(),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        sessionManager: manager,
      });
      try {
        if (session.sessionManager !== manager || session.getActiveToolNames().length !== 0) {
          throw new Error("Pi learning Session isolation unavailable.");
        }
        options.onCreated?.(session);
        if (signal.aborted) throw new Error("Learning invocation aborted.");
        const abort = () => { void session.abort(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(prompt, { expandPromptTemplates: false });
          if (signal.aborted) throw new Error("Learning invocation aborted.");
          const text = session.getLastAssistantText();
          if (text === undefined || text.length > 32_000) throw new Error("Unbounded or absent learning response.");
          // No inferred Pi token accounting: caller charges the full durable reservation.
          return { text };
        } finally { signal.removeEventListener("abort", abort); }
      } finally { session.dispose(); }
    },
  };
}
