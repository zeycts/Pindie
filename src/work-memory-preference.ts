import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "./settings-menu.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parse(contents: string): Record<string, unknown> {
  const value: unknown = JSON.parse(contents);
  if (!isRecord(value) || (value.workMemory !== undefined && typeof value.workMemory !== "boolean")) {
    throw new Error("Work Memory preferences must be an object with an optional boolean workMemory.");
  }
  return value;
}

/** Global startup intent only; undefined preserves legacy selection. Never repairs invalid files. */
export class FileWorkMemoryPreferenceStore {
  readonly baseDir: string;
  constructor(baseDir: string) { this.baseDir = baseDir; }
  preferencesPath(): string { return join(this.baseDir, "preferences.json"); }
  loadDefault(): boolean | undefined {
    try { return parse(readFileSync(this.preferencesPath(), "utf8")).workMemory as boolean | undefined; }
    catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async saveDefault(enabled: boolean): Promise<void> {
    let preferences: Record<string, unknown> = {};
    try { preferences = parse(await readFile(this.preferencesPath(), "utf8")); }
    catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
    preferences.workMemory = enabled;
    const temporaryPath = join(this.baseDir, `.preferences.json.${randomUUID()}.tmp`);
    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, this.preferencesPath());
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function registerWorkMemoryPreferenceCommand(
  pi: ExtensionAPI, store: FileWorkMemoryPreferenceStore, startupEnabled: boolean,
  configuration: "configured" | "unconfigured" | "unchecked",
): void {
  pi.registerCommand("work-memory", {
    description: "Set global Work Memory (Notion) startup preference (requires Host restart)",
    handler: async (args, ctx) => {
      if (args.trim() !== "") { ctx.ui.notify("Usage: /work-memory", "warning"); return; }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The /work-memory command requires TUI mode. Configure workMemory in global preferences.json for headless Control.", "warning");
        return;
      }
      try {
        const saved = store.loadDefault() ?? startupEnabled;
        const status = [
          ...(startupEnabled === saved ? [] : [`Host: ${startupEnabled ? "on" : "off"} · Saved: ${saved ? "on" : "off"} · Restart required`]),
          ...(configuration === "unconfigured" ? ["Notion not configured"] : []),
          ...(configuration === "unchecked" ? ["Notion configuration unchecked while disabled"] : []),
          "Saved changes apply to next Host only.",
        ];
        const selected = await ctx.ui.custom<boolean | null>((tui, theme, keybindings, done) => new SettingsMenu(
          tui, theme, keybindings, {
            title: "Work Memory (Notion)", description: "Capture durable project knowledge in Notion",
            status, choices: [{ value: true, label: "on" }, { value: false, label: "off" }],
            currentValue: startupEnabled, defaultValue: saved, initialValue: saved,
            confirm: { hint: "Save", run: done }, save: { hint: "Save", run: done }, onCancel: () => done(null),
          },
        ));
        if (selected === null || selected === undefined) return;
        await store.saveDefault(selected);
        ctx.ui.notify(`Work Memory default saved: ${selected ? "on" : "off"}. Current Host unchanged; restart/recreate the Host to apply. Enabling still requires available Notion configuration and no environment veto.`, "info");
      } catch {
        ctx.ui.notify("Could not update Work Memory preferences. Existing configuration was preserved.", "error");
      }
    },
  });
}
