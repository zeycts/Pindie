import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SettingsMenu } from "./settings-menu.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Startup preference only. No credentials, routing or Session entries. */
export class FileDiscordRemotePreferenceStore {
  readonly baseDir: string;
  constructor(baseDir: string) { this.baseDir = baseDir; }
  preferencesPath(): string { return join(this.baseDir, "preferences.json"); }

  // Composition is synchronous; read before any optional adapter is constructed.
  loadDefault(): boolean {
    let contents: string;
    try { contents = readFileSync(this.preferencesPath(), "utf8"); }
    catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return true;
      throw new Error("Could not read Discord Remote preferences; Discord Remote remains disabled.");
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (!isRecord(parsed)) return false;
      return parsed.discordRemote === undefined || parsed.discordRemote === true;
    } catch { return false; }
  }

  async saveDefault(enabled: boolean): Promise<void> {
    let preferences: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(this.preferencesPath(), "utf8"));
      if (!isRecord(parsed)) throw new Error("the root value must be an object");
      if (parsed.discordRemote !== undefined && typeof parsed.discordRemote !== "boolean") {
        throw new Error("discordRemote must be a boolean");
      }
      preferences = { ...parsed };
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    preferences.discordRemote = enabled;
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

/** Configuration UI remains available even when the optional Remote is absent. */
export function registerDiscordRemotePreferenceCommand(
  pi: ExtensionAPI, store: FileDiscordRemotePreferenceStore, startupEnabled: boolean,
): void {
  pi.registerCommand("discord-remote", {
    description: "Set global Discord Remote startup preference (requires Host restart)",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /discord-remote", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The /discord-remote command requires TUI mode. Configure discordRemote in global preferences.json for headless Control.", "warning");
        return;
      }
      try {
        const saved = store.loadDefault();
        const selected = await ctx.ui.custom<boolean | null>((tui, theme, keybindings, done) => new SettingsMenu(
          tui, theme, keybindings, {
            title: "Discord Remote",
            description: "Discord Remote access · saved changes apply to next Host.",
            status: startupEnabled === saved ? [] : [
              `Host: ${startupEnabled ? "on" : "off"} · Saved: ${saved ? "on" : "off"} · Restart required`,
            ],
            choices: [{ value: true, label: "on" }, { value: false, label: "off" }],
            currentValue: startupEnabled,
            defaultValue: saved,
            initialValue: saved,
            confirm: { hint: "Save default (next Host)", run: done },
            save: { hint: "Save default (next Host)", run: done },
            onCancel: () => done(null),
          },
        ));
        if (selected === null || selected === undefined) return;
        await store.saveDefault(selected);
        ctx.ui.notify(`Discord Remote default saved: ${selected ? "on" : "off"}. Current Host unchanged; restart/recreate the Host to apply.`, "info");
      } catch {
        ctx.ui.notify("Could not update Discord Remote preferences. Existing configuration was preserved.", "error");
      }
    },
  });
}
