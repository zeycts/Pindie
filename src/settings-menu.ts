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
  status: readonly string[];
  choices: readonly { value: Value; label: string }[];
  currentValue: Value;
  defaultValue: Value;
  initialValue?: Value;
  confirm: { hint: string; run: (value: Value) => void };
  save: { hint: string; run: (value: Value) => void };
  onCancel: () => void;
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
    this.addChild(new Spacer(1));
    text(this.theme.bold(this.options.title), "accent");
    text(this.options.description);
    this.addChild(new Spacer(1));
    for (const line of this.options.status) text(line);
    this.addChild(new Spacer(1));
    this.options.choices.forEach((choice, index) => {
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
      return keys.length ? [`${keys.map((key) => key.split("+").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+")).join("/")} ${label}`] : [];
    };
    for (const line of [
      ...hint("tui.select.up", "to move up"),
      ...hint("tui.select.down", "to move down"),
      ...hint("tui.select.confirm", this.options.confirm.hint),
      ...hint("app.models.save", this.options.save.hint),
      ...hint("tui.select.cancel", "to cancel (no changes)"),
    ]) text(line);
    this.addChild(new Spacer(1));
    border();
  }
}
