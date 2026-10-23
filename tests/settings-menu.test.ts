import assert from "node:assert/strict";
import test from "node:test";
// Pinned native implementation: Pi exports the manager type, not its constructor.
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import { visibleWidth } from "@earendil-works/pi-tui";
import { SettingsMenu } from "../src/settings-menu.ts";

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
  assert.match(initial, /Ctrl\+Q\/Alt\+C to cancel \(no changes\)/);
  assert.match(initial, /Alt\+K to move up/);
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
  for (const width of [16, 40, 100]) {
    menu.invalidate();
    for (const line of menu.render(width)) assert.ok(visibleWidth(line) <= width);
  }
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
