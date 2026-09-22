import assert from "node:assert/strict";
import test from "node:test";

import {
  contextualHintActions,
  declaredActionCollisions,
  paletteActions,
  PINDIE_ACTIONS,
  PINDIE_ACTION_REGISTRY,
  resolveActionForInput,
  type PindieActionAvailability,
  type PindieInteractionState,
} from "../src/tui/actions.ts";

const composer: PindieInteractionState = {
  focusMode: "composer",
  activeOverlay: null,
};
const timeline: PindieInteractionState = {
  focusMode: "timeline",
  activeOverlay: null,
};

function availability(
  overrides: Partial<PindieActionAvailability> = {},
): PindieActionAvailability {
  return {
    runActive: false,
    composerEmpty: true,
    hasSelectedBlock: false,
    activeOverlay: null,
    ...overrides,
  };
}

function alt(letter: string): string {
  return `\u001b${letter}`;
}

test("Action Registry IDs are unique and same-context bindings are collision-free", () => {
  const ids = PINDIE_ACTIONS.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(PINDIE_ACTION_REGISTRY.size, ids.length);
  assert.deepEqual(declaredActionCollisions(), []);
});

test("F1 uses only the approved sparse Alt namespace", () => {
  const reservedLeftHand = new Set(["q", "w", "e", "r", "t", "a", "s", "d", "f", "g", "z", "x", "c", "v", "b"]);
  const altBindings = PINDIE_ACTIONS.flatMap((action) =>
    action.keys.filter((binding) => binding.key.startsWith("alt+")));
  assert.ok(altBindings.some((binding) => binding.key === "alt+p"));
  assert.ok(altBindings.some((binding) => binding.key === "alt+h"));
  assert.ok(altBindings.some((binding) => binding.key === "alt+u"));
  assert.equal(altBindings.some((binding) => reservedLeftHand.has(binding.key.slice(4))), false);
  assert.equal(altBindings.some((binding) => binding.key === "alt+m"), false);
  assert.equal(altBindings.some((binding) => binding.key === "alt+n"), false);
});

test("right-hand global/composer actions resolve through the registry", () => {
  const data = availability({ runActive: true, composerEmpty: false });
  assert.equal(resolveActionForInput(data, composer, alt("p")), "palette.open");
  assert.equal(resolveActionForInput(data, composer, alt("h")), "timeline.toggle");
  assert.equal(resolveActionForInput(data, composer, alt("u")), "composer.follow-up");
});

test("Escape priority is overlay, Timeline, then Composer abort", () => {
  const running = availability({ runActive: true, hasSelectedBlock: true });
  assert.equal(
    resolveActionForInput(
      { ...running, activeOverlay: "block-viewer" },
      { ...timeline, activeOverlay: "block-viewer" },
      "\u001b",
    ),
    "overlay.close",
  );
  assert.equal(resolveActionForInput(running, timeline, "\u001b"), "timeline.back");
  assert.equal(resolveActionForInput(running, composer, "\u001b"), "run.abort");
  assert.equal(resolveActionForInput(availability(), composer, "\u001b"), null);
});

test("unavailable actions do not resolve", () => {
  assert.equal(resolveActionForInput(availability({ composerEmpty: false }), composer, "\u0004"), null);
  assert.equal(resolveActionForInput(availability(), timeline, "\r"), null);
  assert.equal(resolveActionForInput(availability(), composer, alt("u")), null);
});

test("palette entries and contextual hints are projections of the registry", () => {
  const data = availability({ runActive: true, composerEmpty: false, hasSelectedBlock: true });
  const composerPalette = paletteActions(data, composer);
  assert.deepEqual(
    composerPalette.map((action) => action.id),
    PINDIE_ACTIONS
      .filter((action) => action.palette &&
        (action.contexts.includes("composer") || action.contexts.includes("global")) &&
        action.id !== "app.exit")
      .map((action) => action.id),
  );
  const timelinePalette = paletteActions(data, timeline);
  assert.ok(timelinePalette.some((action) => action.id === "timeline.inspect"));
  assert.ok(timelinePalette.some((action) => action.id === "timeline.copy"));
  assert.ok(timelinePalette.some((action) => action.id === "run.abort"));
  assert.ok(contextualHintActions(data, composer).some((action) => action.id === "palette.open"));
  assert.ok(contextualHintActions(data, timeline).some((action) => action.id === "timeline.inspect"));
  assert.ok(contextualHintActions(data, timeline).some((action) => action.id === "timeline.back"));
});
