import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { SettingsMenu, type SettingsMenuTheme, type SettingsMenuKeybindings } from "./settings-menu.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PINDIE_QUOTA_RESUME_PREFERENCE_TYPE = "pindie-quota-resume-preference";
export const QUOTA_RESUME_PREFERENCES_FILE_NAME = "preferences.json";

export interface QuotaResumePreferenceStore {
  loadDefault(): Promise<boolean>;
  saveDefault(enabled: boolean): Promise<void>;
}

export interface FileQuotaResumePreferenceStoreOptions {
  baseDir?: string;
  /** Test-only failure seam immediately before the atomic rename. */
  onBeforeRename?: () => Promise<void>;
}

interface QuotaResumePreferences {
  [key: string]: unknown;
  quotaAutoResume?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

export class FileQuotaResumePreferenceStore implements QuotaResumePreferenceStore {
  private readonly baseDir: string;
  private readonly onBeforeRename: (() => Promise<void>) | undefined;

  constructor(options: FileQuotaResumePreferenceStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), ".pindie", "global");
    this.onBeforeRename = options.onBeforeRename;
  }

  get storageBaseDir(): string {
    return this.baseDir;
  }

  preferencesPath(): string {
    return join(this.baseDir, QUOTA_RESUME_PREFERENCES_FILE_NAME);
  }

  async loadDefault(): Promise<boolean> {
    let contents: string;
    try {
      contents = await readFile(this.preferencesPath(), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return true;
      throw new Error(`Could not read quota resume preferences '${this.preferencesPath()}': ${errorMessage(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      return false;
    }
    if (!isRecord(parsed)) return false;
    if (parsed.quotaAutoResume === undefined) return true;
    return typeof parsed.quotaAutoResume === "boolean" ? parsed.quotaAutoResume : false;
  }

  async saveDefault(enabled: boolean): Promise<void> {
    const path = this.preferencesPath();
    let preferences: QuotaResumePreferences = {};
    try {
      const contents = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (!isRecord(parsed)) throw new Error("the root value must be an object");
      if (parsed.quotaAutoResume !== undefined && typeof parsed.quotaAutoResume !== "boolean") {
        throw new Error("quotaAutoResume must be a boolean");
      }
      preferences = { ...parsed };
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error(`Could not update quota resume preferences '${path}': ${errorMessage(error)}`);
      }
    }

    preferences.quotaAutoResume = enabled;
    const temporaryPath = join(this.baseDir, `.${QUOTA_RESUME_PREFERENCES_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify(preferences, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await this.onBeforeRename?.();
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error(`Could not save quota resume preferences '${path}': ${errorMessage(error)}`);
    }
  }
}

export interface QuotaResumePreferenceEntry {
  enabled: boolean;
}

export function isQuotaResumePreferenceEntry(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; customType: typeof PINDIE_QUOTA_RESUME_PREFERENCE_TYPE; data: QuotaResumePreferenceEntry } {
  return entry.type === "custom" &&
    entry.customType === PINDIE_QUOTA_RESUME_PREFERENCE_TYPE &&
    isRecord(entry.data) &&
    typeof entry.data.enabled === "boolean";
}

export function getBranchQuotaResumePreference(
  branch: readonly SessionEntry[],
  globalDefault: boolean,
): boolean {
  let effective = globalDefault;
  for (const entry of branch) {
    if (isQuotaResumePreferenceEntry(entry)) effective = entry.data.enabled;
  }
  return effective;
}

export interface QuotaResumeSelectorResult {
  readonly kind: "session" | "default";
  readonly enabled: boolean;
}

export class QuotaResumeSelectorComponent extends SettingsMenu<boolean> {

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: SettingsMenuTheme,
    keybindings: SettingsMenuKeybindings,
    sessionEnabled: boolean,
    globalDefault: boolean,
    onSelect: (result: QuotaResumeSelectorResult) => void,
    onCancel: () => void,
  ) {
    super(tui, theme, keybindings, {
      title: "Quota Resume",
      description: "Auto-resume after Codex quota resets. Save = default + Session.",
      status: sessionEnabled === globalDefault ? [] : [
        `Session: ${sessionEnabled ? "on" : "off"} · Default: ${globalDefault ? "on" : "off"}`,
      ],
      choices: [{ value: true, label: "on" }, { value: false, label: "off" }],
      currentValue: sessionEnabled,
      defaultValue: globalDefault,
      confirm: { hint: "Session", run: (enabled) => onSelect({ kind: "session", enabled }) },
      save: { hint: "Save", run: (enabled) => onSelect({ kind: "default", enabled }) },
      onCancel,
    });
  }
}

export interface QuotaResumeIntegration {
  readonly quotaAutoResumeEnabled: boolean;
  readonly quotaAutoResumeDefault: boolean;
  restoreSession(ctx: ExtensionContext): Promise<void>;
  restoreBranch(ctx: ExtensionContext): Promise<void>;
}

export interface QuotaResumeIntegrationOptions {
  readonly onPreferenceChanged?: (enabled: boolean, ctx: ExtensionContext) => void;
}

export function registerQuotaResumeIntegration(
  pi: ExtensionAPI,
  store: QuotaResumePreferenceStore,
  options: QuotaResumeIntegrationOptions = {},
): QuotaResumeIntegration {
  let globalDefault = true;
  let sessionEnabled = true;

  const restore = async (ctx: ExtensionContext, reloadGlobal: boolean): Promise<void> => {
    if (reloadGlobal) {
      try {
        globalDefault = await store.loadDefault();
      } catch (error) {
        globalDefault = false;
        console.warn(`[Pindie] Quota resume preferences unavailable: ${errorMessage(error)}`);
      }
    }
    if (typeof ctx.sessionManager?.getBranch !== "function") {
      sessionEnabled = false;
      return;
    }
    try {
      sessionEnabled = getBranchQuotaResumePreference(ctx.sessionManager.getBranch(), globalDefault);
    } catch (error) {
      sessionEnabled = false;
      console.warn(`[Pindie] Quota resume Session preference unavailable: ${errorMessage(error)}`);
    }
  };

  pi.registerCommand("quota-resume", {
    description: "Configure automatic resume after a quota reset",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /quota-resume", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The /quota-resume command requires TUI mode.", "warning");
        return;
      }

      const selected = await ctx.ui.custom<QuotaResumeSelectorResult | null>(
        (tui, theme, keybindings, done) => new QuotaResumeSelectorComponent(
          tui,
          theme,
          keybindings,
          sessionEnabled,
          globalDefault,
          done,
          () => done(null),
        ),
      );
      if (selected === null || selected === undefined) return;

      try {
        if (selected.kind === "default") {
          await store.saveDefault(selected.enabled);
          pi.appendEntry(PINDIE_QUOTA_RESUME_PREFERENCE_TYPE, { enabled: selected.enabled });
          globalDefault = selected.enabled;
          sessionEnabled = selected.enabled;
        } else {
          pi.appendEntry(PINDIE_QUOTA_RESUME_PREFERENCE_TYPE, { enabled: selected.enabled });
          sessionEnabled = selected.enabled;
        }
        options.onPreferenceChanged?.(sessionEnabled, ctx);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });

  return {
    restoreSession: (ctx: ExtensionContext): Promise<void> => restore(ctx, true),
    restoreBranch: (ctx: ExtensionContext): Promise<void> => restore(ctx, false),
    get quotaAutoResumeEnabled(): boolean {
      return sessionEnabled;
    },
    get quotaAutoResumeDefault(): boolean {
      return globalDefault;
    },
  };
}
