import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { QUOTA_RESUME_PREFERENCES_FILE_NAME } from "./quota-resume.ts";

export const PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE = "pindie-quota-fallback-preference";
export const QUOTA_FALLBACK_UNAVAILABLE_MESSAGE =
  "DeepSeek V4.1 Flash is not currently available in Pi. Configure DeepSeek provider authentication, then retry.";

export interface QuotaFallbackPreferenceStore {
  loadDefault(): Promise<boolean>;
  saveDefault(enabled: boolean): Promise<void>;
}

export interface FileQuotaFallbackPreferenceStoreOptions {
  baseDir?: string;
  /** Test-only failure seam immediately before atomic rename. */
  onBeforeRename?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** One boolean in the existing global preferences document; never stores provider credentials. */
export class FileQuotaFallbackPreferenceStore implements QuotaFallbackPreferenceStore {
  private readonly baseDir: string;
  private readonly onBeforeRename: (() => Promise<void>) | undefined;

  constructor(options: FileQuotaFallbackPreferenceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
    this.onBeforeRename = options.onBeforeRename;
  }

  get storageBaseDir(): string { return this.baseDir; }
  preferencesPath(): string { return join(this.baseDir, QUOTA_RESUME_PREFERENCES_FILE_NAME); }

  async loadDefault(): Promise<boolean> {
    let contents: string;
    try { contents = await readFile(this.preferencesPath(), "utf8"); }
    catch (error) {
      if (isMissingFile(error)) return false;
      throw new Error(`Could not read quota fallback preferences '${this.preferencesPath()}': ${errorMessage(error)}`);
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      return isRecord(parsed) && parsed.quotaFallback === true;
    } catch { return false; }
  }

  async saveDefault(enabled: boolean): Promise<void> {
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

export interface QuotaFallbackPreferenceEntry { enabled: boolean; }
export function isQuotaFallbackPreferenceEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; customType: typeof PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE; data: QuotaFallbackPreferenceEntry } {
  return entry.type === "custom" && entry.customType === PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE &&
    isRecord(entry.data) && typeof entry.data.enabled === "boolean";
}

export function getBranchQuotaFallbackPreference(branch: readonly SessionEntry[], globalDefault: boolean): boolean {
  let effective = globalDefault;
  for (const entry of branch) if (isQuotaFallbackPreferenceEntry(entry)) effective = entry.data.enabled;
  return effective;
}

export interface QuotaFallbackSelectorResult {
  readonly kind: "session" | "default";
  readonly enabled: boolean;
}
interface SelectorTheme { fg(color: string, text: string): string; bold(text: string): string; }
type SelectorKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;
function displayKey(bindings: SelectorKeybindings, key: "tui.select.confirm" | "app.models.save" | "tui.select.cancel"): string {
  return bindings.getKeys(key).map((binding) => binding.split("+").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+")).join("/");
}

export class QuotaFallbackSelectorComponent extends Container {
  private selectedIndex: number;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: SelectorTheme;
  private readonly keybindings: SelectorKeybindings;
  private readonly sessionEnabled: boolean;
  private readonly globalDefault: boolean;
  private readonly onSelect: (result: QuotaFallbackSelectorResult) => void;
  private readonly onCancel: () => void;
  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: SelectorTheme,
    keybindings: SelectorKeybindings,
    sessionEnabled: boolean,
    globalDefault: boolean,
    onSelect: (result: QuotaFallbackSelectorResult) => void,
    onCancel: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.sessionEnabled = sessionEnabled;
    this.globalDefault = globalDefault;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.selectedIndex = sessionEnabled ? 0 : 1;
    this.rebuild();
  }
  override invalidate(): void { super.invalidate(); this.rebuild(); }
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = 1 - this.selectedIndex;
      this.rebuild(); this.tui.requestRender();
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.onSelect({ kind: "session", enabled: this.selectedIndex === 0 });
    } else if (this.keybindings.matches(data, "app.models.save")) {
      this.onSelect({ kind: "default", enabled: this.selectedIndex === 0 });
    } else if (this.keybindings.matches(data, "tui.select.cancel")) this.onCancel();
  }
  private rebuild(): void {
    this.clear();
    this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold("Quota Fallback · DeepSeek V4.1 Flash")), 0, 0));
    this.addChild(new Text(this.theme.fg("dim", "Pay-as-you-go backup after Codex quota exhaustion"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.renderRow(true), 0, 0));
    this.addChild(new Text(this.renderRow(false), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", `${displayKey(this.keybindings, "tui.select.confirm")} to select · ${displayKey(this.keybindings, "app.models.save")} to set as default · ${displayKey(this.keybindings, "tui.select.cancel")} to cancel`), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder((text: string) => this.theme.fg("border", text)));
  }
  private renderRow(enabled: boolean): string {
    const selected = (enabled ? 0 : 1) === this.selectedIndex;
    const marker = this.globalDefault === enabled ? this.theme.fg("muted", " · default") : "";
    const arrow = selected ? this.theme.fg("accent", "→ ") : "  ";
    const check = this.sessionEnabled === enabled ? this.theme.fg("accent", "✓ ") : "  ";
    const label = enabled ? "on" : "off";
    return `${arrow}${check}${selected ? this.theme.fg("accent", label) : label}${marker}`;
  }
}

export interface QuotaFallbackIntegration {
  readonly quotaFallbackEnabled: boolean;
  readonly quotaFallbackDefault: boolean;
  restoreSession(ctx: ExtensionContext): Promise<void>;
  restoreBranch(ctx: ExtensionContext): Promise<void>;
}

export function registerQuotaFallbackIntegration(
  pi: ExtensionAPI,
  store: QuotaFallbackPreferenceStore,
  options: { readonly canEnable: (sessionId: string) => boolean },
): QuotaFallbackIntegration {
  let globalDefault = false;
  let sessionEnabled = false;
  const restore = async (ctx: ExtensionContext, reloadGlobal: boolean): Promise<void> => {
    if (reloadGlobal) {
      try { globalDefault = await store.loadDefault(); }
      catch (error) {
        globalDefault = false;
        console.warn(`[Pindie] Quota fallback preferences unavailable: ${errorMessage(error)}`);
      }
    }
    if (typeof ctx.sessionManager?.getBranch !== "function") {
      sessionEnabled = false;
      return;
    }
    try {
      sessionEnabled = getBranchQuotaFallbackPreference(ctx.sessionManager.getBranch(), globalDefault);
    } catch (error) {
      sessionEnabled = false;
      console.warn(`[Pindie] Quota fallback Session preference unavailable: ${errorMessage(error)}`);
    }
  };

  pi.registerCommand("quota-fallback", {
    description: "Configure paid DeepSeek fallback after Codex quota exhaustion",
    handler: async (args, ctx) => {
      if (args.trim() !== "") { ctx.ui.notify("Usage: /quota-fallback", "warning"); return; }
      if (ctx.mode !== "tui") { ctx.ui.notify("The /quota-fallback command requires TUI mode.", "warning"); return; }
      const selected = await ctx.ui.custom<QuotaFallbackSelectorResult | null>(
        (tui, theme, keybindings, done) => new QuotaFallbackSelectorComponent(
          tui, theme, keybindings, sessionEnabled, globalDefault, done, () => done(null),
        ),
      );
      if (selected === null || selected === undefined) return;
      try {
        // Preflight before either global or Session mutation. OFF never needs auth.
        if (selected.enabled) {
          let available = false;
          try { available = options.canEnable(ctx.sessionManager.getSessionId()); } catch { /* Fail closed. */ }
          if (!available) {
            ctx.ui.notify(QUOTA_FALLBACK_UNAVAILABLE_MESSAGE, "error");
            return;
          }
        }
        if (selected.kind === "default") await store.saveDefault(selected.enabled);
        pi.appendEntry(PINDIE_QUOTA_FALLBACK_PREFERENCE_TYPE, { enabled: selected.enabled });
        if (selected.kind === "default") globalDefault = selected.enabled;
        sessionEnabled = selected.enabled;
        // Turning OFF controls future incidents, not an already committed fallback lease.
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
  return {
    restoreSession: (ctx) => restore(ctx, true), restoreBranch: (ctx) => restore(ctx, false),
    get quotaFallbackEnabled() { return sessionEnabled; },
    get quotaFallbackDefault() { return globalDefault; },
  };
}
