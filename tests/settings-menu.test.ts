import assert from "node:assert/strict";
import test from "node:test";
// Pinned native implementation: Pi exports the manager type, not its constructor.
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import { visibleWidth } from "@earendil-works/pi-tui";
import { SettingsMenu } from "../src/settings-menu.ts";
import { DEFAULT_FALLBACK_CONFIG } from "../src/quota-fallback-config.ts";
import { QuotaFallbackConfigSelectorComponent } from "../src/quota-fallback.ts";
import { QuotaResumeSelectorComponent } from "../src/quota-resume.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };

test("SettingsMenu separates cursor/current/default, wraps choices and uses real remapped Pi keys", () => {
  const results: string[] = [];
  let renders = 0;
  const menu = new SettingsMenu({ requestRender: () => { renders++; } }, theme,
    new KeybindingsManager({
      "tui.select.up": "alt+k", "tui.select.down": "alt+j",
      "tui.select.confirm": "alt+enter", "tui.select.cancel": ["ctrl+q", "alt+c"],
      "app.models.save": ["ctrl+x", "alt+s"],
    }), {
      title: "Startup switch", description: "A reusable choice field", status: ["Current != saved"],
      choices: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }],
      currentValue: "a", defaultValue: "b", initialValue: "b",
      confirm: { hint: "to apply locally", run: (value) => results.push(`local:${value}`) },
      save: { hint: "to save globally", run: (value) => results.push(`global:${value}`) },
      onCancel: () => results.push("cancel"),
    });
  const initial = menu.render(160).join("\n");
  assert.match(initial, /  ✓ Alpha/);
  assert.match(initial, /→   Beta · default/);
  assert.match(initial, /Alt\+Enter to apply locally/);
  assert.match(initial, /Ctrl\+X\/Alt\+S to save globally/);
  assert.match(initial, /Ctrl\+Q\/Alt\+C Cancel \(no save\)/);
  assert.match(initial, /Alt\+K\/Alt\+J Move/);
  for (const key of ["\r", "\u0013", "\u001b", "\u001b[B"]) menu.handleInput(key);
  assert.deepEqual(results, []); // no hardcoded Enter, Ctrl+S, Escape or arrows
  menu.handleInput("\u001bj");
  menu.handleInput("\u001bj"); // wrap to Alpha
  assert.match(menu.render(160).join("\n"), /→ ✓ Alpha/);
  menu.handleInput("\u001bk"); // wrap to Gamma
  menu.handleInput("\u001b\r");
  menu.handleInput("\u0018");
  menu.handleInput("\u001bs");
  menu.handleInput("\u0011");
  menu.handleInput("\u001bc");
  assert.deepEqual(results, ["local:c", "global:c", "global:c", "cancel", "cancel"]);
  assert.equal(renders, 3);
  assert.equal(menu.render(200).length, 10); // borders, title, description, status, three choices, spacer, one help row
  for (const width of [1, 2, 8, 16, 40, 80, 100, 200]) {
    menu.invalidate();
    for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});

test("quota menus preserve boolean styling and wrap fallback fields without width overflow", () => {
  for (const Component of [QuotaFallbackConfigSelectorComponent, QuotaResumeSelectorComponent]) {
    for (const current of [true, false]) for (const saved of [true, false]) {
      const fallback = Component === QuotaFallbackConfigSelectorComponent;
      const menu = fallback ? new QuotaFallbackConfigSelectorComponent({ requestRender() {} }, theme, new KeybindingsManager(),
        { ...DEFAULT_FALLBACK_CONFIG, enabled: current }, { ...DEFAULT_FALLBACK_CONFIG, enabled: saved }, [], () => {}, () => {}) :
        new QuotaResumeSelectorComponent({ requestRender() {} }, theme, new KeybindingsManager(), current, saved, () => {}, () => {});
      if (fallback) menu.handleInput("\r"); // Enabled sub-selector uses identical shared presentation.
      const lines = menu.render(200);
      const screen = lines.join("\n");
      assert.equal(lines.length, fallback || current === saved ? 8 : 9);
      assert.equal(lines[1]!.trim(), fallback ? "Quota Fallback · enabled" : "Quota Resume");
      assert.match(screen, new RegExp(`✓ ${current ? "on" : "off"}`));
      assert.match(screen, new RegExp(`${saved ? "on" : "off"} · default`));
      if (fallback || current === saved) assert.doesNotMatch(screen, /Session:|Default:/);
      else assert.match(screen, new RegExp(`Session: ${current ? "on" : "off"} · Default: ${saved ? "on" : "off"}`));
      assert.match(screen, fallback ? /Enter Choose/ : /Enter Session/);
      assert.match(screen, /Save default \+ Session/);
      assert.match(screen, /Escape\/Ctrl\+C Cancel \(no save\)/);
      assert.doesNotMatch(screen, /V4\.1|source thinking|Current Session/);
      for (const width of [1, 2, 8, 16, 40, 80, 120]) {
        for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      }
    }
  }
});

test("SettingsMenu optionally windows long model lists while preserving cursor/current/default and wrap", () => {
  const results: number[] = [];
  const menu = new SettingsMenu({ requestRender() {} }, theme, new KeybindingsManager(), {
    title: "Models", description: "Dynamic choices", status: [],
    choices: Array.from({ length: 100 }, (_, value) => ({ value, label: `Fixture ${value}` })),
    currentValue: 50, defaultValue: 51, maxVisibleChoices: 8,
    confirm: { hint: "Choose", run: (v) => results.push(v) }, save: { hint: "Save", run() {} }, onCancel() {},
  });
  assert.match(menu.render(150).join("\n"), /→ ✓ Fixture 50/);
  assert.match(menu.render(150).join("\n"), /Fixture 51 · default/);
  assert.equal(menu.render(150).filter((line) => /Fixture/.test(line)).length, 8);
  for (let i = 0; i < 50; i++) menu.handleInput("\u001b[B");
  assert.match(menu.render(150).join("\n"), /→   Fixture 0/);
  menu.handleInput("\u001b[A"); menu.handleInput("\r");
  assert.deepEqual(results, [99]);
  assert.match(menu.render(150).join("\n"), /→   Fixture 99/);
});

test("SettingsMenu rebuilds theme colors and hides unbound actions without invented shortcuts", () => {
  let prefix = "old";
  const colors: string[] = [];
  const menu = new SettingsMenu({ requestRender() {} }, {
    fg: (color, text) => { colors.push(color); return `${prefix}:${text}`; }, bold: (text) => text,
  }, new KeybindingsManager({ "app.models.save": [] }), {
    title: "Field", description: "Description", status: ["Status"],
    choices: [{ value: false, label: "off" }], currentValue: false, defaultValue: false,
    confirm: { hint: "to confirm", run() {} }, save: { hint: "to save", run() {} }, onCancel() {},
  });
  assert.doesNotMatch(menu.render(100).join("\n"), /to save|Ctrl\+S/);
  prefix = "new";
  menu.invalidate();
  const rendered = menu.render(100).join("\n");
  assert.match(rendered, /new:Field/);
  assert.doesNotMatch(rendered, /old:/);
  for (const color of ["accent", "border", "dim", "muted"]) assert.ok(colors.includes(color));
});
