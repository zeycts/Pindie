import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { INVALID_FALLBACK_CONFIG, isAllowedFallbackModel, isFallbackThinking, DEFAULT_FALLBACK_CONFIG, availableFallbackModels, copyFallbackConfig, isRecord, parseFallbackConfig, supportsFallbackConfig, type FallbackModelChoice, type QuotaFallbackConfig } from "./quota-fallback-config.ts";
import type { TUI } from "@earendil-works/pi-tui";
import { SettingsMenu, type SettingsMenuTheme, type SettingsMenuKeybindings } from "./settings-menu.ts";
import { QUOTA_RESUME_PREFERENCES_FILE_NAME } from "./quota-resume.ts";

export const PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE = "pindie-quota-fallback-preference";
export const QUOTA_FALLBACK_UNAVAILABLE_MESSAGE =
  "Selected backup model or Thinking is unavailable in Pi. Check provider authentication/model support; configuration was not changed.";

export interface QuotaFallbackPreferenceStore {
  loadDefault(): Promise<boolean>;
  saveDefault(enabled: boolean): Promise<void>;
  loadConfig?(): Promise<QuotaFallbackConfig>;
  saveConfig?(config: QuotaFallbackConfig): Promise<void>;
}

export interface FileQuotaFallbackPreferenceStoreOptions {
  baseDir?: string;
  /** Test-only failure seam immediately before atomic rename. */
  onBeforeRename?: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Compatible fields in the shared preferences document; never stores credentials. */
export class FileQuotaFallbackPreferenceStore implements QuotaFallbackPreferenceStore {
  private readonly baseDir: string;
  private readonly onBeforeRename: (() => Promise<void>) | undefined;

  constructor(options: FileQuotaFallbackPreferenceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
    this.onBeforeRename = options.onBeforeRename;
  }

  get storageBaseDir(): string { return this.baseDir; }
  preferencesPath(): string { return join(this.baseDir, QUOTA_RESUME_PREFERENCES_FILE_NAME); }

  async loadDefault(): Promise<boolean> { return (await this.loadConfig()).enabled; }

  async loadConfig(): Promise<QuotaFallbackConfig> {
    let contents: string;
    try { contents = await readFile(this.preferencesPath(), "utf8"); }
    catch (error) {
      if (isMissingFile(error)) return copyFallbackConfig(DEFAULT_FALLBACK_CONFIG);
      throw new Error(`Could not read quota fallback preferences '${this.preferencesPath()}': ${errorMessage(error)}`);
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      return parseFallbackConfig(isRecord(parsed) ? {
        enabled: parsed.quotaFallback === undefined ? false : parsed.quotaFallback, model: parsed.quotaFallbackModel, thinking: parsed.quotaFallbackThinking,
      } : null);
    } catch { return copyFallbackConfig(INVALID_FALLBACK_CONFIG); }
  }

  async saveDefault(enabled: boolean): Promise<void> { await this.savePreferences(enabled); }

  async saveConfig(config: QuotaFallbackConfig): Promise<void> {
    if (typeof config.enabled !== "boolean" || !isAllowedFallbackModel(config.model) || !isFallbackThinking(config.thinking)) throw new Error("Invalid quota fallback configuration");
    await this.savePreferences(config.enabled, config);
  }

  private async savePreferences(enabled: boolean, config?: QuotaFallbackConfig): Promise<void> {
    const path = this.preferencesPath();
    let preferences: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(parsed)) throw new Error("the root value must be an object");
      if (parsed.quotaFallback !== undefined && typeof parsed.quotaFallback !== "boolean") {
        throw new Error("quotaFallback must be a boolean");
      }
      preferences = { ...parsed };
    } catch (error) {
      if (!isMissingFile(error)) throw new Error(`Could not update quota fallback preferences '${path}': ${errorMessage(error)}`);
    }
    preferences.quotaFallback = enabled;
    if (config) {
      preferences.quotaFallbackModel = { ...config.model };
      preferences.quotaFallbackThinking = config.thinking;
    }
    const temporaryPath = join(this.baseDir, `.${QUOTA_RESUME_PREFERENCES_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.onBeforeRename?.();
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(`Could not save quota fallback preferences '${path}': ${errorMessage(error)}`);
    }
  }
}

export interface QuotaFallbackPreferenceEntry { enabled: boolean; model?: QuotaFallbackConfig["model"]; thinking?: QuotaFallbackConfig["thinking"]; }
export function getBranchQuotaFallbackConfig(branch: readonly SessionEntry[], globalDefault: QuotaFallbackConfig): QuotaFallbackConfig {
  let effective = copyFallbackConfig(globalDefault);
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE) continue;
    if (!isRecord(entry.data) || typeof entry.data.enabled !== "boolean") continue;
    effective = parseFallbackConfig(entry.data, globalDefault);
  }
  return effective;
}
export function isQuotaFallbackPreferenceEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; customType: typeof PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE; data: QuotaFallbackPreferenceEntry } {
  return entry.type === "custom" && entry.customType === PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE &&
    isRecord(entry.data) && typeof entry.data.enabled === "boolean";
}

export function getBranchQuotaFallbackPreference(branch: readonly SessionEntry[], globalDefault: boolean): boolean {
  return getBranchQuotaFallbackConfig(branch, { ...DEFAULT_FALLBACK_CONFIG, enabled: globalDefault }).enabled;
}

export interface QuotaFallbackConfigSelectorResult { readonly kind: "session" | "default"; readonly config: QuotaFallbackConfig; }

/** Local draft + sub-selectors, all rendered by the same lightweight SettingsMenu. */
export class QuotaFallbackConfigSelectorComponent extends Container {
  private menu!: SettingsMenu<string>;
  private draft: QuotaFallbackConfig;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: SettingsMenuTheme;
  private readonly keys: SettingsMenuKeybindings;
  private readonly current: QuotaFallbackConfig;
  private readonly defaults: QuotaFallbackConfig;
  private readonly models: readonly FallbackModelChoice[];
  private readonly selected: (result: QuotaFallbackConfigSelectorResult) => void;
  private readonly cancelled: () => void;
  constructor(
    tui: Pick<TUI, "requestRender">, theme: SettingsMenuTheme, keys: SettingsMenuKeybindings,
    current: QuotaFallbackConfig, defaults: QuotaFallbackConfig, models: readonly FallbackModelChoice[],
    selected: (result: QuotaFallbackConfigSelectorResult) => void, cancelled: () => void,
  ) {
    super(); this.tui = tui; this.theme = theme; this.keys = keys; this.current = current;
    this.defaults = defaults; this.models = models; this.selected = selected; this.cancelled = cancelled;
    this.draft = copyFallbackConfig(current); this.root();
  }
  handleInput(data: string): void { this.menu.handleInput(data); }
  private name(config: QuotaFallbackConfig): string {
    const identity = `${config.model.provider}/${config.model.modelId}`;
    return this.models.some((m) => m.provider === config.model.provider && m.modelId === config.model.modelId) ? identity : `${identity} (unavailable)`;
  }
  private thinking(config: QuotaFallbackConfig): string { return config.thinking === "source" ? "Follow source" : config.thinking; }
  private show(options: ConstructorParameters<typeof SettingsMenu<string>>[3]): void {
    this.clear(); this.menu = new SettingsMenu(this.tui, this.theme, this.keys, options); this.addChild(this.menu); this.tui.requestRender();
  }
  private finish(kind: "session" | "default"): void {
    const changedTarget = JSON.stringify(this.draft.model) !== JSON.stringify(this.current.model) || this.draft.thinking !== this.current.thinking;
    // Presentation preflight only; the command still rechecks fresh Pi authority before either write.
    if ((this.draft.enabled || changedTarget) && !supportsFallbackConfig(this.draft, this.models)) { this.root(); return; }
    this.selected({ kind, config: copyFallbackConfig(this.draft) });
  }
  private root(): void {
    const summary = (config: QuotaFallbackConfig) => `${config.enabled ? "on" : "off"} · ${this.name(config)} · ${this.thinking(config)}`;
    const modified = (field: "enabled" | "model" | "thinking") =>
      (field === "model" ? this.name(this.draft) !== this.name(this.current) : this.draft[field] !== this.current[field]) ? " · modified" : "";
    const same = summary(this.current) === summary(this.defaults);
    const status: ConstructorParameters<typeof SettingsMenu<string>>[3]["status"][number][] = [
      { text: `${same ? "Current/Saved" : "Current"}: ${summary(this.current)}`, color: "dim" },
    ];
    if (!same) status.push({ text: `Saved default differs: ${summary(this.defaults)}`, color: "warning" });
    const modelAvailable = this.models.some((m) => m.provider === this.draft.model.provider && m.modelId === this.draft.model.modelId);
    if (!modelAvailable) status.push({ text: "Backup unavailable; check Pi model/auth before applying changes.", color: "warning" });
    else if (!supportsFallbackConfig(this.draft, this.models)) status.push({ text: "Thinking incompatible with backup; choose Thinking again before Apply/Save.", color: "warning" });
    this.show({ title: "Quota Fallback", description: "Paid backup for Codex quota. Save all = default + Session; Back discards draft.",
      status,
      choices: [{ value: "enabled", label: `Enabled: ${this.draft.enabled ? "on" : "off"}${modified("enabled")}` },
        { value: "model", label: `Model: ${this.name(this.draft)}${modified("model")}` }, { value: "thinking", label: `Thinking: ${this.thinking(this.draft)}${modified("thinking")}` },
        { value: "apply", label: "Apply to Session" }], currentValue: "", defaultValue: "",
      confirm: { hint: "Edit/Apply", run: (field) => field === "apply" ? this.finish("session") : this.sub(field) },
      save: { hint: "Save all", run: () => this.finish("default") }, onCancel: this.cancelled });
  }
  private sub(field: string): void {
    let choices: { value: string; label: string }[];
    let currentValue: string; let defaultValue: string;
    const identity = (c: QuotaFallbackConfig) => `${c.model.provider}/${c.model.modelId}`;
    if (field === "enabled") {
      choices = [{ value: "on", label: "on" }, { value: "off", label: "off" }];
      currentValue = this.current.enabled ? "on" : "off"; defaultValue = this.defaults.enabled ? "on" : "off";
    } else if (field === "model") {
      choices = this.models.map((m) => ({ value: `${m.provider}/${m.modelId}`, label: `${m.provider}/${m.modelId}` }));
      currentValue = identity(this.current); defaultValue = identity(this.defaults);
    } else {
      const model = this.models.find((m) => `${m.provider}/${m.modelId}` === identity(this.draft));
      choices = [{ value: "source", label: "Follow source" }, ...(model?.thinkingLevels ?? []).map((level) => ({ value: level, label: level }))];
      currentValue = this.current.thinking; defaultValue = this.defaults.thinking;
    }
    if (!choices.length) choices = [{ value: "", label: "No authenticated allowed backup models available" }];
    const choose = (value: string) => {
      if (field === "enabled") this.draft = { ...this.draft, enabled: value === "on" };
      else if (field === "model") {
        const model = this.models.find((m) => `${m.provider}/${m.modelId}` === value);
        if (model) this.draft = { ...this.draft, model: { provider: model.provider, modelId: model.modelId } };
      } else this.draft = { ...this.draft, thinking: value as QuotaFallbackConfig["thinking"] };
      this.root();
    };
    const description = field === "model" ? "Choose backup for draft; Back keeps model." : field === "enabled" ?
      "Enable future fallback in draft; Back keeps value." : "Uses source Thinking; Pi may adjust for backup model.";
    this.show({ title: `Quota Fallback · ${field}`, description: `${description} Save all = default + Session.`,
      status: [], choices, maxVisibleChoices: 8,
      currentValue, defaultValue, initialValue: field === "enabled" ? (this.draft.enabled ? "on" : "off") : field === "model" ? identity(this.draft) : this.draft.thinking,
      confirm: { hint: "Choose", run: choose }, save: { hint: "Save all", run: (value) => { choose(value); this.finish("default"); } }, onCancel: () => this.root() });
  }
}

export interface QuotaFallbackIntegration {
  readonly quotaFallbackEnabled: boolean;
  readonly quotaFallbackDefault: boolean;
  readonly quotaFallbackConfig: QuotaFallbackConfig;
  invalidateSession(): void;
  restoreSession(ctx: ExtensionContext): Promise<void>;
  restoreBranch(ctx: ExtensionContext): Promise<void>;
}

export function registerQuotaFallbackIntegration(
  pi: ExtensionAPI,
  store: QuotaFallbackPreferenceStore,
  options: { readonly canEnable: (sessionId: string, config?: QuotaFallbackConfig) => boolean },
): QuotaFallbackIntegration {
  let globalDefault = false;
  let sessionEnabled = false;
  let globalConfig = copyFallbackConfig(DEFAULT_FALLBACK_CONFIG);
  let sessionConfig = copyFallbackConfig(DEFAULT_FALLBACK_CONFIG);
  let revision = 0;
  const restore = async (ctx: ExtensionContext, reloadGlobal: boolean): Promise<void> => {
    ++revision;
    if (reloadGlobal) {
      try {
        globalConfig = store.loadConfig ? await store.loadConfig() : { ...DEFAULT_FALLBACK_CONFIG, enabled: await store.loadDefault() };
        globalDefault = globalConfig.enabled;
      }
      catch (error) {
        globalDefault = false;
        globalConfig = copyFallbackConfig(INVALID_FALLBACK_CONFIG);
        console.warn(`[Pindie] Quota fallback preferences unavailable: ${errorMessage(error)}`);
      }
    }
    if (typeof ctx.sessionManager?.getBranch !== "function") {
      sessionEnabled = false;
      sessionConfig = copyFallbackConfig({ ...globalConfig, enabled: false });
      return;
    }
    try {
      sessionConfig = getBranchQuotaFallbackConfig(ctx.sessionManager.getBranch(), globalConfig);
      sessionEnabled = sessionConfig.enabled;
    } catch (error) {
      sessionEnabled = false;
      sessionConfig = copyFallbackConfig({ ...globalConfig, enabled: false });
      console.warn(`[Pindie] Quota fallback Session preference unavailable: ${errorMessage(error)}`);
    }
  };

  pi.registerCommand("quota-fallback", {
    description: "Configure backup model and thinking after Codex quota exhaustion",
    handler: async (args, ctx) => {
      if (args.trim() !== "") { ctx.ui.notify("Usage: /quota-fallback", "warning"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("The /quota-fallback command requires TUI mode.", "warning"); return; }
      const commandRevision = revision;
      const sessionId = ctx.sessionManager.getSessionId();
      const leafId = ctx.sessionManager.getLeafId();
      let models: FallbackModelChoice[];
      try { models = availableFallbackModels(ctx.modelRegistry); }
      catch { ctx.ui.notify(QUOTA_FALLBACK_UNAVAILABLE_MESSAGE, "error"); return; }
      const selected = await ctx.ui.custom<QuotaFallbackConfigSelectorResult | null>(
        (tui, theme, keybindings, done) => new QuotaFallbackConfigSelectorComponent(
          tui, theme, keybindings, sessionConfig, globalConfig, models, done, () => done(null),
        ),
      );
      if (selected === null || selected === undefined) return;
      try {
        // Preflight before either write. Unchanged OFF never needs auth.
        if (revision !== commandRevision || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) throw new Error("Session/branch changed; reopen /quota-fallback.");
        const config = copyFallbackConfig(selected.config);
        const changedTarget = JSON.stringify(config.model) !== JSON.stringify(sessionConfig.model) || config.thinking !== sessionConfig.thinking;
        if (config.enabled || changedTarget) {
          let available = false;
          try { available = options.canEnable(sessionId, config) && supportsFallbackConfig(config, availableFallbackModels(ctx.modelRegistry)); } catch { /* Fail closed. */ }
          if (!available) {
            ctx.ui.notify(QUOTA_FALLBACK_UNAVAILABLE_MESSAGE, "error");
            return;
          }
        }
        if (selected.kind === "default") {
          if (!store.saveConfig) throw new Error("Fallback configuration storage is unavailable");
          await store.saveConfig(config);
          globalConfig = config; globalDefault = config.enabled;
        }
        if (revision !== commandRevision || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) throw new Error("Session/branch changed while saving; current Session was not modified.");
        pi.appendEntry(PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, config);
        sessionConfig = config;
        sessionEnabled = config.enabled;
        ++revision;
        // Turning OFF controls future incidents, not an already committed fallback lease.
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  return {
    invalidateSession: () => { ++revision; },
    restoreSession: (ctx) => restore(ctx, true), restoreBranch: (ctx) => restore(ctx, false),
    get quotaFallbackConfig() { return copyFallbackConfig(sessionConfig); },
    get quotaFallbackEnabled() { return sessionEnabled; },
    get quotaFallbackDefault() { return globalDefault; },
  };
}
