import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_FALLBACK_CONFIG as defaults, type QuotaFallbackConfig } from "../src/quota-fallback-config.ts";
import { QuotaFallbackConfigSelectorComponent } from "../src/quota-fallback.ts";
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const models = [
  { ...defaults.model, name: "Stale V4.1 Flash alias", thinkingLevels: ["off", "high"] as const },
  { provider: "deepseek", modelId: "deepseek-v4-pro", name: "Stale Pro alias", thinkingLevels: ["off"] as const },
];
const down = "\u001b[B", enter = "\r", esc = "\u001b", save = "\u0013";
function harness(current = defaults, saved = current) {
  const results: unknown[] = [], colors: [string, string][] = [];
  let cancels = 0;
  const menu = new QuotaFallbackConfigSelectorComponent({ requestRender() {} }, {
    fg: (color, text) => { colors.push([color, text]); return `\u001b[${color === "warning" ? 33 : 2}m${text}\u001b[0m`; }, bold: (text) => text,
  }, new KeybindingsManager(), current, saved, models, (result) => results.push(result), () => { cancels++; });
  const screen = () => menu.render(300).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()).join("\n");
  const open = (index: number) => { for (let i = 0; i < index; i++) menu.handleInput(down); menu.handleInput(enter); };
  return { menu, results, colors, screen, open, cancels: () => cancels };
}

test("Phase2.1 root render: stable IDs, one dim Current/Saved, short bound footer, explicit default diff", () => {
  const h = harness();
  const screen = h.screen();
  assert.deepEqual(screen.split("\n").slice(1, -1), [
    "Quota Fallback",
    "Paid backup for Codex quota. Save all = default + Session; Back discards draft.",
    "Current/Saved: off · deepseek/deepseek-flash · Follow source",
    "→   Enabled: off", "    Model: deepseek/deepseek-flash", "    Thinking: Follow source", "    Apply to Session", "",
    "↑↓ Move · Enter Edit/Apply · Ctrl+S Save all · Esc/Ctrl+C Back",
  ]);
  assert.doesNotMatch(screen, /Stale|Same as source|modified|differs/);
  assert.ok(h.colors.some(([color, text]) => color === "dim" && text.startsWith("Current/Saved:")));
  assert.ok(!h.colors.some(([color]) => color === "warning"));
  const diff = harness({ ...defaults, enabled: true }, defaults);
  assert.match(diff.screen(), /Current: on.*\nSaved default differs: off/);
  assert.ok(diff.colors.some(([color, text]) => color === "warning" && text.startsWith("Saved default differs:")));
  assert.doesNotMatch(diff.screen(), /modified/);
});

test("Phase2.1 each field Back discards selection, root Ctrl+C discards whole modified draft", () => {
  for (const field of [0, 1, 2]) {
    const h = harness(); h.open(field);
    assert.match(h.screen(), /Save all = default \+ Session/);
    assert.match(h.screen(), /↑↓ Move · Enter Choose · Ctrl\+S Save all · Esc\/Ctrl\+C Back/);
    h.menu.handleInput(down); h.menu.handleInput(esc);
    assert.doesNotMatch(h.screen(), /modified/);
    assert.deepEqual(h.results, []); assert.equal(h.cancels(), 0);
  }
  const h = harness(); h.open(0); h.menu.handleInput(down); h.menu.handleInput(enter);
  assert.match(h.screen(), /Enabled: on · modified/);
  assert.match(h.screen(), /Current\/Saved: off/);
  h.menu.handleInput("\u0003");
  assert.equal(h.cancels(), 1); assert.deepEqual(h.results, []);
});

test("Phase2.1 model edits retain incompatible fixed Thinking; Apply/Save cannot submit until explicit Thinking choice", () => {
  const current: QuotaFallbackConfig = { ...defaults, enabled: true, thinking: "high" };
  const h = harness(current); h.open(1); h.menu.handleInput(down); h.menu.handleInput(enter);
  assert.match(h.screen(), /Model: deepseek\/deepseek-v4-pro · modified/);
  assert.match(h.screen(), /Thinking: high\n/);
  assert.match(h.screen(), /Thinking incompatible with backup; choose Thinking again/);
  h.menu.handleInput(save); h.open(3);
  assert.deepEqual(h.results, []);
  h.open(2); assert.match(h.screen(), /Uses source Thinking; Pi may adjust for backup model/);
  assert.doesNotMatch(h.screen(), /high|Stale/);
  h.menu.handleInput(save); // highlighted Follow source, save whole draft, not just Thinking
  assert.deepEqual(h.results, [{ kind: "default", config: { ...current, model: { provider: "deepseek", modelId: "deepseek-v4-pro" }, thinking: "source" } }]);
});

test("Phase2.1 sub-selector Save takes highlighted field plus all prior draft edits; source stays source", () => {
  const h = harness(); h.open(0); h.menu.handleInput(down); h.menu.handleInput(enter); // enabled draft
  h.open(1); h.menu.handleInput(down); h.menu.handleInput(save); // selected model + whole draft
  assert.deepEqual(h.results, [{ kind: "default", config: { enabled: true, model: { provider: "deepseek", modelId: "deepseek-v4-pro" }, thinking: "source" } }]);
});

test("Phase2.1 ANSI narrow root/submenus and incompatible warning never overflow; unavailable identity stays exact", () => {
  const h = harness({ ...defaults, thinking: "high" }, { ...defaults, enabled: true });
  for (const field of [-1, 0, 1, 2]) {
    if (field >= 0) h.open(field);
    for (const width of [1, 2, 3, 8, 16, 24, 40, 80]) {
      h.menu.invalidate();
      for (const line of h.menu.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
    if (field >= 0) h.menu.handleInput(esc);
  }
  h.open(1); h.menu.handleInput(down); h.menu.handleInput(enter);
  for (const line of h.menu.render(8)) assert.ok(visibleWidth(line) <= 8);
  const unavailable = harness({ ...defaults, enabled: true, model: { provider: "fixture", modelId: "missing-id" } });
  assert.match(unavailable.screen(), /fixture\/missing-id \(unavailable\)/);
  assert.match(unavailable.screen(), /Backup unavailable; check Pi model\/auth/);
  unavailable.menu.handleInput(save); unavailable.open(3);
  assert.deepEqual(unavailable.results, []);
  // Disabling an unchanged unavailable target remains legal, as in the command preflight.
  unavailable.open(0); unavailable.menu.handleInput(down); unavailable.menu.handleInput(save);
  assert.equal(unavailable.results.length, 1);
});
