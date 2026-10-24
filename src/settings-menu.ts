import { DynamicBorder, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

export interface SettingsMenuTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
export type SettingsMenuKeybindings = Pick<KeybindingsManager, "matches" | "getKeys">;

/** Presentation only: callers own values, scope, persistence and activation. */
export interface SettingsMenuOptions<Value> {
  title: string;
  description: string;
  status: readonly (string | { text: string; color: "dim" | "warning" })[];
  choices: readonly { value: Value; label: string }[];
  currentValue: Value;
  defaultValue: Value;
  initialValue?: Value;
  /** Optional bounded window for a dynamic model sub-selector; boolean menus are unchanged. */
  maxVisibleChoices?: number;
  confirm: { hint: string; run: (value: Value) => void };
  save: { hint: string; run: (value: Value) => void };
  onCancel: () => void;
}

/** Abbreviate only actual bindings; never invent a default shortcut. */
function formatSettingsKey(key: string): string {
  if (key === "up") return "↑";
  if (key === "down") return "↓";
  if (key === "escape") return "Esc";
  return key.split("+").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+");
}

export class SettingsMenu<Value> extends Container {
  private selectedIndex: number;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: SettingsMenuTheme;
  private readonly keybindings: SettingsMenuKeybindings;
  private readonly options: SettingsMenuOptions<Value>;

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: SettingsMenuTheme,
    keybindings: SettingsMenuKeybindings,
    options: SettingsMenuOptions<Value>,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.options = options;
    if (options.choices.length === 0) throw new Error("SettingsMenu requires choices");
    this.selectedIndex = Math.max(0, options.choices.findIndex(
      (choice) => choice.value === (options.initialValue ?? options.currentValue),
    ));
    this.rebuild();
  }

  override invalidate(): void { super.invalidate(); this.rebuild(); }

  handleInput(data: string): void {
    const matches = (action: Parameters<SettingsMenuKeybindings["matches"]>[1]) => this.keybindings.matches(data, action);
    if (matches("tui.select.cancel")) { this.options.onCancel(); return; }
    if (matches("tui.select.up")) this.move(-1);
    else if (matches("tui.select.down")) this.move(1);
    else if (matches("tui.select.confirm")) this.options.confirm.run(this.options.choices[this.selectedIndex]!.value);
    else if (matches("app.models.save")) this.options.save.run(this.options.choices[this.selectedIndex]!.value);
  }

  private move(delta: number): void {
    this.selectedIndex = (this.selectedIndex + delta + this.options.choices.length) % this.options.choices.length;
    this.rebuild();
    this.tui.requestRender();
  }

  private rebuild(): void {
    this.clear();
    const text = (value: string, color = "dim") => this.addChild(new Text(this.theme.fg(color, value), 0, 0));
    const border = () => this.addChild(new DynamicBorder((value: string) => this.theme.fg("border", value)));
    border();
    text(this.theme.bold(this.options.title), "accent");
    text(this.options.description);
    for (const line of this.options.status) text(typeof line === "string" ? line : line.text, typeof line === "string" ? "warning" : line.color);
    const limit = Math.max(1, this.options.maxVisibleChoices ?? this.options.choices.length);
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(limit / 2), this.options.choices.length - limit));
    const end = Math.min(this.options.choices.length, start + limit);
    if (end - start < this.options.choices.length) text(`${start + 1}–${end} / ${this.options.choices.length}`);
    this.options.choices.slice(start, end).forEach((choice, offset) => {
      const index = start + offset;
      const selected = index === this.selectedIndex;
      const arrow = selected ? this.theme.fg("accent", "→ ") : "  ";
      const check = choice.value === this.options.currentValue ? this.theme.fg("accent", "✓ ") : "  ";
      const label = selected ? this.theme.fg("accent", choice.label) : choice.label;
      const marker = choice.value === this.options.defaultValue ? this.theme.fg("muted", " · default") : "";
      this.addChild(new Text(`${arrow}${check}${label}${marker}`, 0, 0));
    });
    this.addChild(new Spacer(1));
    const hint = (action: Parameters<SettingsMenuKeybindings["getKeys"]>[0], label: string): string[] => {
      const keys = this.keybindings.getKeys(action);
      return keys.length ? [`${keys.map(formatSettingsKey).join("/")} ${label}`] : [];
    };
    // One horizontal help row; native Text wraps ANSI-aware at the render width.
    const navigation = [hint("tui.select.up", ""), hint("tui.select.down", "")].flat().map((key) => key.trim());
    text([
      ...(navigation.length ? [`${navigation.join(navigation[0] === "↑" && navigation[1] === "↓" ? "" : "/")} Move`] : []),
      ...hint("tui.select.confirm", this.options.confirm.hint),
      ...hint("app.models.save", this.options.save.hint),
      ...hint("tui.select.cancel", "Back"),
    ].join(" · "));
    border();
  }
}
