import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PindieControlMonitor, type PindieControlMonitorOptions } from "./control-monitor.ts";
import { WatchComponent } from "./watch-component.ts";

/** Register only after a native interactive context is known. No resources until /watch. */
export function createWatchCommand(
  pi: ExtensionAPI,
  monitorOptions: PindieControlMonitorOptions = {},
  beginWatchStatus: () => () => void = () => () => {},
) {
  let registered = false;
  let active: { close: () => void; stopped: Promise<void> | null } | null = null;
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    if (args.trim()) { ctx.ui.notify("Usage: /watch", "warning"); return; }
    if (active) { ctx.ui.notify("Watch is already open or closing.", "info"); return; }
    let monitor: PindieControlMonitor | undefined;
    let component: WatchComponent | undefined;
    let done: (() => void) | undefined;
    let closed = false;
    let releaseStatus: (() => void) | undefined;
    const interaction = {
      stopped: null as Promise<void> | null,
      close: () => {
        if (closed) return;
        closed = true;
        try {
          component?.stop();
          interaction.stopped = monitor?.stop() ?? Promise.resolve();
        } finally {
          releaseStatus?.();
          done?.();
        }
      },
    };
    active = interaction;
    try {
      await ctx.ui.custom<void>((tui, theme, _keys, finish) => {
        // Do not compete with another custom overlay. No global focus/input hooks.
        if (tui.hasOverlay()) throw new Error("Close the current Pi overlay before /watch.");
        done = () => finish();
        if (!closed) releaseStatus = beginWatchStatus();
        component = new WatchComponent(theme, () => tui.terminal.rows, () => tui.requestRender(), interaction.close, tui);
        monitor = new PindieControlMonitor(component, monitorOptions);
        return component;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
        // Start only after Pi has mounted and focused the synchronous component.
        onHandle: () => {
          if (closed) { done?.(); return; }
          void monitor!.start().then(() => interaction.close(), () => interaction.close());
        },
      });
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "Watch unavailable", "warning");
    } finally {
      try {
        interaction.close();
        await interaction.stopped;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Watch cleanup failed", "warning");
      } finally {
        releaseStatus?.();
        if (active === interaction) active = null;
      }
    }
  };
  return {
    sessionStart(ctx: ExtensionContext): void {
      active?.close();
      if (!registered && ctx.hasUI && ctx.mode === "tui") {
        pi.registerCommand("watch", { description: "Watch remote Pindie Control (read-only)", handler });
        registered = true;
      }
    },
    async shutdown(): Promise<void> {
      active?.close();
      await active?.stopped;
    },
  };
}
