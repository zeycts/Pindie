import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface FallbackModelIdentity { readonly provider: string; readonly modelId: string; }
export type FallbackThinking = "source" | AgentSession["thinkingLevel"];
export interface QuotaFallbackConfig {
  readonly enabled: boolean;
  readonly model: FallbackModelIdentity;
  readonly thinking: FallbackThinking;
}
export const DEFAULT_FALLBACK_CONFIG: QuotaFallbackConfig = Object.freeze({
  enabled: false, model: Object.freeze({ provider: "deepseek", modelId: "deepseek-flash" }), thinking: "source",
});
// Invalid documents keep an unusable identity; legacy ON cannot revive another paid target.
export const INVALID_FALLBACK_CONFIG: QuotaFallbackConfig = Object.freeze({
  enabled: false, model: Object.freeze({ provider: "", modelId: "" }), thinking: "source",
});
export const FALLBACK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Identity validation is provider-neutral; availability/explicit user selection authorize use. */
export function isAllowedFallbackModel(value: unknown): value is FallbackModelIdentity {
  return isRecord(value) && typeof value.provider === "string" && value.provider.trim().length > 0 && value.provider.trim() === value.provider && value.provider !== "openai-codex" && typeof value.modelId === "string" &&
    value.modelId.length > 0 && value.modelId.trim() === value.modelId;
}
export function isFallbackThinking(value: unknown): value is FallbackThinking {
  return value === "source" || FALLBACK_THINKING_LEVELS.some((level) => level === value);
}
export function copyFallbackConfig(config: QuotaFallbackConfig): QuotaFallbackConfig {
  return Object.freeze({ enabled: config.enabled, model: Object.freeze({ ...config.model }), thinking: config.thinking });
}
/** Missing fields are legacy only; present invalid fields never substitute another paid model. */
export function parseFallbackConfig(value: unknown, inherited = DEFAULT_FALLBACK_CONFIG): QuotaFallbackConfig {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return copyFallbackConfig(INVALID_FALLBACK_CONFIG);
  if ((value.model !== undefined && !isAllowedFallbackModel(value.model)) ||
      (value.thinking !== undefined && !isFallbackThinking(value.thinking))) {
    return copyFallbackConfig(INVALID_FALLBACK_CONFIG);
  }
  const config = { enabled: value.enabled, model: value.model ?? inherited.model, thinking: value.thinking ?? inherited.thinking } as QuotaFallbackConfig;
  return copyFallbackConfig({ ...config, enabled: config.enabled && isAllowedFallbackModel(config.model) && isFallbackThinking(config.thinking) });
}
export interface FallbackModelChoice extends FallbackModelIdentity {
  readonly name: string;
  readonly thinkingLevels: readonly AgentSession["thinkingLevel"][];
}
export function fallbackModelChoice(model: Model<Api>): FallbackModelChoice {
  return { provider: model.provider, modelId: model.id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) };
}
/** Snapshot-only queries: no credentials returned, refresh, discovery or provider invocation. */
export function availableFallbackModels(registry: ModelRegistry): FallbackModelChoice[] {
  return registry.getAvailable().filter((model) => isAllowedFallbackModel({ provider: model.provider, modelId: model.id }) &&
    model.input.includes("text") && model.api !== "pi-virtual" && registry.hasConfiguredAuth(model) &&
    registry.getProviderAuthStatus(model.provider).configured).map(fallbackModelChoice);
}
export function supportsFallbackConfig(config: QuotaFallbackConfig, choices: readonly FallbackModelChoice[]): boolean {
  if (!isAllowedFallbackModel(config.model) || !isFallbackThinking(config.thinking)) return false;
  const model = choices.find((choice) => choice.provider === config.model.provider && choice.modelId === config.model.modelId);
  return model !== undefined && (config.thinking === "source" || model.thinkingLevels.includes(config.thinking));
}
