import {
  Key,
  matchesKey,
  type KeyId,
} from "@earendil-works/pi-tui";

export type PindieActionContext = "global" | "composer" | "timeline" | "attention" | "overlay";

export type PindieActionId =
  | "palette.open"
  | "timeline.toggle"
  | "composer.follow-up"
  | "run.abort"
  | "app.exit"
  | "timeline.next"
  | "timeline.previous"
  | "timeline.collapse"
  | "timeline.expand"
  | "timeline.toggle-fold"
  | "timeline.inspect"
  | "timeline.copy"
  | "timeline.back"
  | "attention.next"
  | "attention.previous"
  | "attention.submit"
  | "attention.escape"
  | "overlay.close"
  | "overlay.next"
  | "overlay.previous";

export interface PindieActionDefinition {
  readonly id: PindieActionId;
  readonly label: string;
  readonly description: string;
  readonly contexts: readonly PindieActionContext[];
  readonly keys: readonly {
    readonly key: KeyId;
    readonly label: string;
    /** Whether this binding still owns input when its action is unavailable. */
    readonly consumeWhenUnavailable?: boolean;
  }[];
  readonly palette: boolean;
  readonly hintPriority?: number;
  readonly hintContexts?: readonly PindieActionContext[];
}

/**
 * The only application-level shortcut metadata used by the F1 view.
 *
 * This registry deliberately contains no runtime or domain mutation closures.
 * The view resolves an ID here and remains the execution owner for the small
 * set of callbacks it already receives from PindieInteractiveMode.
 */
export const PINDIE_ACTIONS: readonly PindieActionDefinition[] = [
  {
    id: "palette.open",
    label: "Command Palette",
    description: "Search and run an available Pindie action.",
    contexts: ["global", "composer", "timeline", "attention"],
    keys: [{ key: Key.alt("p"), label: "Alt+P" }],
    palette: false,
    hintPriority: 120,
    hintContexts: ["composer"],
  },
  {
    id: "timeline.toggle",
    label: "Toggle Timeline Focus",
    description: "Move keyboard focus between the primary input surface and Timeline.",
    contexts: ["global", "composer", "timeline", "attention"],
    keys: [{ key: Key.alt("h"), label: "Alt+H" }],
    palette: true,
    hintPriority: 70,
  },
  {
    id: "composer.follow-up",
    label: "Send as Follow-up",
    description: "Place the Composer text in Pi's follow-up queue.",
    contexts: ["composer"],
    keys: [{ key: Key.alt("u"), label: "Alt+U" }],
    palette: true,
    hintPriority: 90,
  },
  {
    id: "run.abort",
    label: "Stop Run",
    description: "Abort the active Run and restore native queued input.",
    contexts: ["global", "composer"],
    keys: [{ key: Key.escape, label: "Esc" }],
    palette: true,
    hintPriority: 80,
    hintContexts: ["composer"],
  },
  {
    id: "app.exit",
    label: "Exit",
    description: "Exit Pindie when the Composer is empty.",
    contexts: ["composer"],
    keys: [{ key: Key.ctrl("d"), label: "Ctrl+D" }],
    palette: true,
    hintPriority: 20,
  },
  {
    id: "timeline.next",
    label: "Next Block",
    description: "Select the next Timeline Block.",
    contexts: ["timeline"],
    keys: [
      { key: "j", label: "j" },
      { key: Key.down, label: "↓" },
    ],
    palette: true,
    hintPriority: 100,
  },
  {
    id: "timeline.previous",
    label: "Previous Block",
    description: "Select the previous Timeline Block.",
    contexts: ["timeline"],
    keys: [
      { key: "k", label: "k" },
      { key: Key.up, label: "↑" },
    ],
    palette: true,
    hintPriority: 99,
  },
  {
    id: "timeline.collapse",
    label: "Collapse Block",
    description: "Show the selected Block at compact density.",
    contexts: ["timeline"],
    keys: [
      { key: "h", label: "h" },
      { key: Key.left, label: "←" },
    ],
    palette: true,
    hintPriority: 60,
  },
  {
    id: "timeline.expand",
    label: "Expand Block",
    description: "Show the selected Block at full density.",
    contexts: ["timeline"],
    keys: [
      { key: "l", label: "l" },
      { key: Key.right, label: "→" },
    ],
    palette: true,
    hintPriority: 59,
  },
  {
    id: "timeline.toggle-fold",
    label: "Toggle Block Fold",
    description: "Toggle the selected Block between compact and full density.",
    contexts: ["timeline"],
    keys: [{ key: "e", label: "e" }],
    palette: true,
    hintPriority: 58,
  },
  {
    id: "timeline.inspect",
    label: "Inspect Block",
    description: "Open the selected Block in a full-detail viewer.",
    contexts: ["timeline"],
    keys: [{ key: Key.enter, label: "Enter" }],
    palette: true,
    hintPriority: 95,
  },
  {
    id: "timeline.copy",
    label: "Copy Block",
    description: "Copy the selected Block's full human-readable representation.",
    contexts: ["timeline"],
    keys: [{ key: "y", label: "y" }],
    palette: true,
    hintPriority: 55,
  },
  {
    id: "timeline.back",
    label: "Return to Composer",
    description: "Return keyboard focus to the Composer.",
    contexts: ["timeline"],
    keys: [{ key: Key.escape, label: "Esc" }],
    palette: true,
    hintPriority: 115,
  },
  {
    id: "attention.next",
    label: "Next Option",
    description: "Select the next Attention response option.",
    contexts: ["attention"],
    keys: [
      { key: "j", label: "j", consumeWhenUnavailable: false },
      { key: Key.down, label: "↓", consumeWhenUnavailable: false },
    ],
    palette: false,
    hintPriority: 100,
  },
  {
    id: "attention.previous",
    label: "Previous Option",
    description: "Select the previous Attention response option.",
    contexts: ["attention"],
    keys: [
      { key: "k", label: "k", consumeWhenUnavailable: false },
      { key: Key.up, label: "↑", consumeWhenUnavailable: false },
    ],
    palette: false,
    hintPriority: 99,
  },
  {
    id: "attention.submit",
    label: "Confirm",
    description: "Send the selected or entered response to the Agent.",
    contexts: ["attention"],
    keys: [{ key: Key.enter, label: "Enter" }],
    palette: false,
    hintPriority: 110,
  },
  {
    id: "attention.escape",
    label: "Keep Decision Open",
    description: "Keep Attention open without changing semantic State.",
    contexts: ["attention"],
    keys: [{ key: Key.escape, label: "Esc" }],
    palette: false,
    hintPriority: 10,
  },
  {
    id: "overlay.close",
    label: "Close Overlay",
    description: "Close the active overlay and restore the underlying surface.",
    contexts: ["overlay"],
    keys: [{ key: Key.escape, label: "Esc" }],
    palette: false,
    hintPriority: 120,
  },
  {
    id: "overlay.next",
    label: "Viewer Down",
    description: "Scroll the Block Viewer down.",
    contexts: ["overlay"],
    keys: [
      { key: "j", label: "j" },
      { key: Key.down, label: "↓" },
    ],
    palette: false,
  },
  {
    id: "overlay.previous",
    label: "Viewer Up",
    description: "Scroll the Block Viewer up.",
    contexts: ["overlay"],
    keys: [
      { key: "k", label: "k" },
      { key: Key.up, label: "↑" },
    ],
    palette: false,
  },
];

export const PINDIE_ACTION_REGISTRY: ReadonlyMap<PindieActionId, PindieActionDefinition> =
  new Map(PINDIE_ACTIONS.map((action) => [action.id, action]));

export type PindieOverlayKind = "command-palette" | "block-viewer";

export interface PindieInteractionState {
  readonly focusMode: "composer" | "timeline" | "attention";
  readonly activeOverlay: PindieOverlayKind | null;
}

/** Facts used for availability; callers derive run state from native Projection facts. */
export interface PindieActionAvailability {
  readonly runActive: boolean;
  readonly composerEmpty: boolean;
  readonly hasSelectedBlock: boolean;
  readonly activeOverlay: PindieOverlayKind | null;
  readonly attentionHasOptions: boolean;
  readonly attentionCanSubmit: boolean;
}

export function getPindieAction(
  id: PindieActionId,
): PindieActionDefinition {
  const action = PINDIE_ACTION_REGISTRY.get(id);
  if (action === undefined) throw new Error(`Unknown Pindie action: ${id}`);
  return action;
}

function actionMatchesInput(action: PindieActionDefinition, input: string): boolean {
  return action.keys.some((binding) => matchesKey(input, binding.key));
}

function contextsForInteraction(
  state: PindieInteractionState,
): readonly PindieActionContext[] {
  if (state.activeOverlay !== null) return ["overlay"];
  if (state.focusMode === "timeline") return ["timeline", "global"];
  return state.focusMode === "attention"
    ? ["attention", "global"]
    : ["composer", "global"];
}

function actionHasContext(
  action: PindieActionDefinition,
  context: PindieActionContext,
): boolean {
  return action.contexts.includes(context);
}

export function isPindieActionAvailable(
  id: PindieActionId,
  data: PindieActionAvailability,
): boolean {
  switch (id) {
    case "palette.open":
      return data.activeOverlay === null;
    case "timeline.toggle":
      return data.activeOverlay === null;
    case "composer.follow-up":
      return data.activeOverlay === null && !data.composerEmpty;
    case "run.abort":
      return data.activeOverlay === null && data.runActive;
    case "app.exit":
      return data.activeOverlay === null && data.composerEmpty;
    case "timeline.next":
    case "timeline.previous":
    case "timeline.collapse":
    case "timeline.expand":
    case "timeline.toggle-fold":
    case "timeline.inspect":
    case "timeline.copy":
      return data.activeOverlay === null && data.hasSelectedBlock;
    case "timeline.back":
      return data.activeOverlay === null;
    case "attention.next":
    case "attention.previous":
      return data.activeOverlay === null && data.attentionHasOptions;
    case "attention.submit":
      return data.activeOverlay === null && data.attentionCanSubmit;
    case "attention.escape":
      return data.activeOverlay === null;
    case "overlay.close":
      return data.activeOverlay !== null;
    case "overlay.next":
    case "overlay.previous":
      return data.activeOverlay === "block-viewer";
  }
}

/** Resolve one input to at most one available action using surface priority. */
export function resolveActionForInput(
  data: PindieActionAvailability,
  interactionState: PindieInteractionState,
  input: string,
): PindieActionId | null {
  for (const context of contextsForInteraction(interactionState)) {
    for (const action of PINDIE_ACTIONS) {
      if (!actionHasContext(action, context) || !actionMatchesInput(action, input)) continue;
      // A declared binding owns this input at its current context even when
      // reality makes the action unavailable. Do not fall through and execute
      // a lower-priority action for the same key press.
      return isPindieActionAvailable(action.id, data) ? action.id : null;
    }
  }
  return null;
}

/** Whether the highest-priority declared binding owns this input now. */
export function shouldConsumePindieInput(
  data: PindieActionAvailability,
  interactionState: PindieInteractionState,
  input: string,
): boolean {
  for (const context of contextsForInteraction(interactionState)) {
    for (const action of PINDIE_ACTIONS) {
      if (!actionHasContext(action, context)) continue;
      const binding = action.keys.find((candidate) => matchesKey(input, candidate.key));
      if (binding === undefined) continue;
      return isPindieActionAvailable(action.id, data) ||
        binding.consumeWhenUnavailable !== false;
    }
  }
  return false;
}

function paletteContext(
  state: PindieInteractionState,
): PindieActionContext {
  return state.focusMode;
}

function usableInContext(
  action: PindieActionDefinition,
  context: PindieActionContext,
): boolean {
  return actionHasContext(action, context) || actionHasContext(action, "global");
}

export function paletteActions(
  data: PindieActionAvailability,
  interactionState: PindieInteractionState,
): readonly PindieActionDefinition[] {
  if (interactionState.activeOverlay !== null) return [];
  const context = paletteContext(interactionState);
  return PINDIE_ACTIONS.filter((action) =>
    action.palette &&
    usableInContext(action, context) &&
    isPindieActionAvailable(action.id, data));
}

export function contextualHintActions(
  data: PindieActionAvailability,
  interactionState: PindieInteractionState,
  limit = 4,
): readonly PindieActionDefinition[] {
  if (interactionState.activeOverlay !== null) return [];
  const context = paletteContext(interactionState);
  return PINDIE_ACTIONS
    .filter((action) =>
      (action.hintContexts === undefined
        ? usableInContext(action, context)
        : action.hintContexts.includes(context)) &&
      isPindieActionAvailable(action.id, data) &&
      action.hintPriority !== undefined)
    .sort((left, right) => (right.hintPriority ?? 0) - (left.hintPriority ?? 0))
    .slice(0, Math.max(0, limit));
}

/** Exposed for focused registry tests and diagnostics. */
export function declaredActionCollisions(): readonly {
  readonly context: PindieActionContext;
  readonly key: KeyId;
  readonly actionIds: readonly PindieActionId[];
}[] {
  const collisions: Array<{
    readonly context: PindieActionContext;
    readonly key: KeyId;
    readonly actionIds: readonly PindieActionId[];
  }> = [];
  const contexts: readonly PindieActionContext[] = ["global", "composer", "timeline", "attention", "overlay"];
  for (const context of contexts) {
    const byKey = new Map<KeyId, PindieActionId[]>();
    for (const action of PINDIE_ACTIONS) {
      if (!actionHasContext(action, context)) continue;
      for (const binding of action.keys) {
        const ids = byKey.get(binding.key) ?? [];
        ids.push(action.id);
        byKey.set(binding.key, ids);
      }
    }
    for (const [key, actionIds] of byKey) {
      if (actionIds.length > 1) collisions.push({ context, key, actionIds });
    }
  }
  return collisions;
}
