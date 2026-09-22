import assert from "node:assert/strict";
import test from "node:test";

import {
  contextualHintActions,
  declaredActionCollisions,
  paletteActions,
  PINDIE_ACTIONS,
  PINDIE_ACTION_REGISTRY,
  resolveActionForInput,
  shouldConsumePindieInput,
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
    nativeIdle: true,
    composerEmpty: true,
    hasSelectedBlock: false,
    activeOverlay: null,
    attentionHasOptions: false,
    attentionCanSubmit: false,
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

test("F2 uses only the approved sparse Alt namespace", () => {
  const reservedLeftHand = new Set(["q", "w", "e", "r", "t", "a", "s", "d", "f", "g", "z", "x", "c", "v", "b"]);
  const altBindings = PINDIE_ACTIONS.flatMap((action) =>
    action.keys.filter((binding) => binding.key.startsWith("alt+")));
  assert.ok(altBindings.some((binding) => binding.key === "alt+p"));
  assert.ok(altBindings.some((binding) => binding.key === "alt+h"));
  assert.ok(altBindings.some((binding) => binding.key === "alt+u"));
  assert.equal(altBindings.some((binding) => reservedLeftHand.has(binding.key.slice(4))), false);
  assert.ok(altBindings.some((binding) => binding.key === "alt+m"));
  assert.ok(altBindings.some((binding) => binding.key === "alt+n"));
});

test("right-hand global/composer actions resolve through the registry", () => {
  const data = availability({ runActive: true, nativeIdle: false, composerEmpty: false });
  assert.equal(resolveActionForInput(data, composer, alt("p")), "palette.open");
  assert.equal(resolveActionForInput(data, composer, alt("h")), "timeline.toggle");
  assert.equal(resolveActionForInput(data, composer, alt("u")), "composer.follow-up");
  assert.equal(resolveActionForInput(data, composer, alt("m")), null);
  assert.equal(resolveActionForInput(data, composer, alt("n")), null);
  const idle = availability();
  assert.equal(resolveActionForInput(idle, composer, alt("m")), "model.pick");
  assert.equal(resolveActionForInput(idle, composer, alt("n")), "session.pick");
});

test("Attention actions own option navigation, submission, and non-destructive Escape", () => {
  const attention: PindieInteractionState = { focusMode: "attention", activeOverlay: null };
  const data = availability({ attentionHasOptions: true, attentionCanSubmit: true });
  assert.equal(resolveActionForInput(data, attention, "j"), "attention.next");
  assert.equal(resolveActionForInput(data, attention, "\u001b[A"), "attention.previous");
  assert.equal(resolveActionForInput(data, attention, "\r"), "attention.submit");
  assert.equal(resolveActionForInput(data, attention, "\u001b"), "attention.escape");
  assert.equal(resolveActionForInput(data, attention, alt("h")), "timeline.toggle");
  assert.equal(resolveActionForInput(data, attention, alt("p")), "palette.open");
  assert.equal(paletteActions(data, attention).some((action) => action.id === "composer.follow-up"), false);

  const freeForm = availability({ attentionHasOptions: false, attentionCanSubmit: false });
  for (const input of ["j", "k", "\u001b[A", "\u001b[B"]) {
    assert.equal(resolveActionForInput(freeForm, attention, input), null);
    assert.equal(shouldConsumePindieInput(freeForm, attention, input), false);
  }
  assert.equal(shouldConsumePindieInput(freeForm, attention, "\r"), true);
  assert.equal(shouldConsumePindieInput(availability(), composer, "\u001b"), true);
  assert.equal(shouldConsumePindieInput(availability({ composerEmpty: false }), composer, "\u0004"), true);
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
  const data = availability({ runActive: true, nativeIdle: false, composerEmpty: false, hasSelectedBlock: true });
  const composerPalette = paletteActions(data, composer);
  assert.deepEqual(
    composerPalette.map((action) => action.id),
    PINDIE_ACTIONS
      .filter((action) => action.palette &&
        (action.contexts.includes("composer") || action.contexts.includes("global")) &&
        action.id !== "app.exit" && action.id !== "model.pick" && action.id !== "session.pick")
      .map((action) => action.id),
  );
  const timelinePalette = paletteActions(data, timeline);
  assert.ok(timelinePalette.some((action) => action.id === "timeline.inspect"));
  assert.ok(timelinePalette.some((action) => action.id === "timeline.copy"));
  assert.ok(timelinePalette.some((action) => action.id === "run.abort"));
  assert.ok(contextualHintActions(data, composer).some((action) => action.id === "palette.open"));
  const idleHints = contextualHintActions(availability(), composer, 6);
  assert.ok(idleHints.some((action) => action.id === "model.pick"));
  assert.ok(idleHints.some((action) => action.id === "session.pick"));
  assert.ok(contextualHintActions(data, timeline).some((action) => action.id === "timeline.inspect"));
  assert.ok(contextualHintActions(data, timeline).some((action) => action.id === "timeline.back"));
});
