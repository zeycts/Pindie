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
  /** Frozen identity actually used for every attempt in this runner; operational audit only. */
  readonly modelIdentity: LearningModelPolicy;
  run(prompt: string, signal: AbortSignal): Promise<LearningSessionResult>;
}
export const LEARNING_THINKING_LEVELS = ["off", "low", "medium"] as const;
export const DEFAULT_LEARNING_THINKING_LEVEL = "low" as const;
/** Explicit isolated learning model identity, independent of the Human Session's mutable model/fallback. */
export interface LearningModelPolicy {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: "off" | "low" | "medium";
}
export function validateLearningModelPolicy(v: unknown): v is LearningModelPolicy {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(v).sort().join() === "modelId,provider,thinkingLevel" &&
    typeof (v as LearningModelPolicy).provider === "string" && (v as LearningModelPolicy).provider.trim().length > 0 &&
    typeof (v as LearningModelPolicy).modelId === "string" && (v as LearningModelPolicy).modelId.trim().length > 0 &&
    (LEARNING_THINKING_LEVELS as readonly string[]).includes((v as LearningModelPolicy).thinkingLevel);
}
export interface LearningSessionFactoryOptions {
  readonly cwd: string;
  /** Exact frozen model value; never a Human SessionManager or transcript. */
  readonly model: Model<any>;
  /** Explicit model identity that must match the supplied model value. */
  readonly policy: LearningModelPolicy;
  readonly createSession?: typeof createAgentSession;
  readonly onCreated?: (session: AgentSession) => void;
}
/** A fresh Pi Session per invocation. There are deliberately zero model-callable tools in F2. */
export function createLearningSessionRunner(options: LearningSessionFactoryOptions): LearningSessionRunner {
  const policy = options.policy;
  if (!validateLearningModelPolicy(policy) || options.model.provider !== policy.provider || options.model.id !== policy.modelId)
    throw new Error("Invalid isolated learning model policy.");
  const modelIdentity: LearningModelPolicy = Object.freeze({ provider: policy.provider, modelId: policy.modelId, thinkingLevel: policy.thinkingLevel });
  return {
    modelIdentity,
    async run(prompt, signal) {
      if (signal.aborted) throw new Error("Learning invocation aborted.");
      if (!prompt.trim() || prompt.length > 48_000) throw new Error("Invalid bounded learning packet.");
      const manager = SessionManager.inMemory(options.cwd);
      const { session } = await (options.createSession ?? createAgentSession)({
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: modelIdentity.thinkingLevel,
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
          // Pi's Session.prompt has no per-request maxTokens or full input+output cap.
          // No inferred token accounting: supervisor charges the full reservation.
          return { text };
        } finally { signal.removeEventListener("abort", abort); }
      } finally { session.dispose(); }
    },
  };
}
