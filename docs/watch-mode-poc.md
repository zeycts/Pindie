# Native Watch v1 (Pi 1.3.0)

## Architecture and ownership

`/watch` is a temporary **Remote read-only** overlay inside native Pi
InteractiveMode, not another terminal, Agent, Session or Control surface:

```text
existing loopback Control → existing read-only monitor → WatchViewModel
                                                      → WatchComponent
                                                      → Pi-owned custom overlay
```

- `watch-command.ts` owns one observer interaction and idempotent shutdown.
  Registration requires Presentation plus native `mode === "tui"`/`hasUI`.
- `control-monitor-client.ts` exposes only observe/readTimeline/wait/close;
  startup verifies the three read-only MCP tool schemas and annotations.
- `control-monitor.ts` owns existing reconnect/wait/Gate cadence. There is no
  Session database, history reader, new status authority or model invocation.
- `watch-view-model.ts` owns ephemeral selection, expanded event IDs, live mode
  and an event-ID/local-row anchor. Header/status uses snapshot facts only.
- `watch-component.ts` owns bounded formatting and navigation. Its private
  ScrollView stores position; it is **not** mounted as a layout child. The
  adapter slices once. Fullscreen cannot discover a second scroll topology.
- `watch-native-presentation.ts` retains the audited presentation-only adapter
  for actual public Pi read/bash components. No new renderer/theme is added.

`pnpm control:watch` remains unchanged. No server tool, protocol output content,
service configuration, Pi dependency/version/lockfile or upstream Pi is changed.
The monitor additionally retains the already-exposed semantic authority field;
missing/unrecognized authority is unknown, not implicitly coherent.

## Fullscreen default and public API design gate

Pindie's interactive Host now resolves mode in this order:

1. Explicit `interactiveModeOptions.tuiMode`.
2. Explicit effective Pi setting `settingsManager.getSettings().tuiMode`.
3. Pindie fallback **`fullscreen`**.

Pi's `getTuiMode()` cannot distinguish an unset setting from its own fallback.
Only Pindie's interactive default changes; no setting is written and headless
Control/MCP does not construct InteractiveMode. To retain terminal-owned
scrollback, explicitly choose `"tuiMode": "regular"` in Pi settings. Regular
mode still supports Watch keyboard navigation, but does not enable native mouse.

Verified against the pinned installed declarations and implementation:

- `@earendil-works/pi-tui` root publicly exports `TuiAltScreen`, `TuiMouseEvent`
  and `TuiMouseEventResult` (`dist/index.d.ts`).
- `Component.handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined`
  is the real public signature (`dist/tui.d.ts`). Coordinates `x/y` are local,
  zero-based; `wheelDelta?: number` is logical rows, negative upward.
  `{ handled: true }` suppresses renderer fallback.
- `dist/tui-alt-screen.js` enables/restores mouse reporting, decodes SGR wheel
  input and dispatches to overlays before renderer scroll fallback.
  `dist/tui.js` translates terminal coordinates to overlay-local coordinates.
- Native InteractiveMode imports both public renderers and selects the requested
  mode; regular mode leaves mouse/scrollback to the terminal.
- The isolated design-gate test starts real `TuiAltScreen` on an in-memory fake
  Terminal, mounts an overlay and injects SGR wheel-up/down. It verifies signed
  deltas, local coordinates and mouse enable/restore writes **only in memory**.
  No mouse sequence, input or mode switch is sent to the user's active TUI.

SSH/tmux must pass mouse reporting through; tmux copy-mode or terminal settings
can intercept wheels. Human fullscreen/tmux/SSH visual acceptance is still
required. This work does not claim such acceptance or alter a running Host.

## First screen and interaction

Default events are one-row compact titles, not expanded logs. A normal-size
terminal shows multiple events without native syntax-highlighting work on first
paint. Metadata is bounded to one row each, using Pi width-aware truncation:

- connection and exit affordance;
- remote Project and short Session ID;
- Task status, verification status/covered-total counts and runtime activity;
- remote model/thinking when available;
- sticky Human Gate and connection/error notices above the feed.

The current monitor contract provides `displayIdentity`, which can be a raw
first prompt, not a verified title. Watch deliberately uses an eight-character
Session ID fallback, never that prompt. No Task summary is invented or parsed
from timeline text. A future title needs a distinguishable title field.

Only connected, coherently authoritative semantic metadata supplies Task and
verification status; otherwise these are **unknown**. Runtime idle, pending and
automatic-work-settled remain distinct facts. Idle alone never implies Task
completion. Gates retained during disconnect/retry are labeled last observed;
the observer cannot answer them. Respond via ChatGPT / Pindie Control, not local
chat. A fresh authoritative snapshot can clear the Gate. The last connection
error remains labeled during retry until connected/waiting replaces it.

| Gesture | Behavior |
|---|---|
| ↑/↓, k/j | Select previous/next event and reveal its title; leave LIVE |
| Enter | Toggle selected event expansion; leave LIVE |
| PgUp/PgDn | Scroll feed one viewport page; leave LIVE |
| Wheel | Scroll feed by Pi's normalized delta; leave LIVE |
| G/End | Select latest event and resume LIVE tail follow |
| Esc/q/Ctrl+C | Close only observer, restore original editor/focus/draft |

Wheel over header/footer is consumed without movement, so it cannot scroll the
underlying chat. With unavailable coordinates the entire overlay is accepted.
Only LIVE auto-follows updates. SCROLLED preserves top event ID plus local row
offset across asynchronous content updates, bounded-tail shifts and resize;
selection/expansion are ID-based. If the anchor is evicted from the 50-event tail,
clamp to the oldest retained event without silently resuming LIVE. Project or
Session change resets view state; same-Session reconnect epochs preserve it.
Mismatched Session timeline data is hidden pending fresh data.

Overlay height follows terminal rows (minus two), not a fixed 30-row cap. On
very small terminals connection/exit and alerts outrank metadata/feed; all facts
cannot physically fit. Long notices/questions are truncated, not independently
scrollable. Unicode widths use Pi utilities and bounded grapheme formatting.
Remote metadata and fallback text strip terminal/bidi controls.

## Expansion fidelity and privacy

Enter expands only on demand. The adapter never assumes native
`setExpanded(false)` is a readable short title. Supported expanded read/bash use
stock `ToolExecutionComponent` plus public `createReadToolDefinition` /
`createBashToolDefinition` render callbacks. Components are cached by event ID
and serialized bounded content version, evicted on collapse/tail eviction and
cleared on invalidation/shutdown. No components are created for collapsed events.

Native adaptation requires bona fide complete/failed tools, validated arguments,
lifecycle/error agreement and genuine `textContent` identical to the existing
bounded summary. It forwards no execute callback, Session, cwd, image, duration,
raw details or extra arguments. It never marks execution started (no elapsed-time
timer), calls `setArgsComplete` or reads local files to fill missing remote data.
A neutral `/` is only a path-formatting base. Stock edit rendering is forbidden:
Pi's edit renderCall can asynchronously inspect the observer's filesystem.

Unchanged output privacy: read excerpts ≤4,000 UTF-16 units; bash ≤3,000 units /
last 25 lines. Native groups ≤8 cards and ≤160 rendered rows per event, followed
by an omission marker. All native cards are labeled **bounded projected text
excerpt**, never complete logs. Invalid/unsupported/running tools use labeled
bounded preview fallback (≤1,600 graphemes / 12 rows); other event types use the
same canonical `formatBlock` compact/preview modes. This is not full transcript
replay, full output, hidden reasoning, image support or older-history access.
Older omitted history is indicated. No new output bytes or redaction promises.

## Lifecycle, verification and limits

Pi's `ctx.ui.custom(..., { overlay: true })` owns mounting/stacking/completion and
focus restoration. Watch creates no terminal, input listener or second renderer.
A concurrent Watch is rejected until cleanup completes; an existing Pi overlay
prevents monitor creation. Later Pi dialogs retain Pi's stacking/focus ownership.
Session shutdown/reload/replacement closes the observer and awaits abort/client
cleanup. A late connect is closed before re-entry. Hard process death cannot
guarantee asynchronous cleanup; no watchdog is added.

Tests exercise the actual pinned custom-overlay implementation, real regular
and fullscreen renderers on fake Terminals, signed synthetic wheels, header/
footer exclusion, single-scroll topology, ID anchoring through tail changes,
Enter expansion/collapse, native read/bash snapshots, content privacy and
filesystem/process tripwires, fallback, Session mismatch/replacement, Gate/
error persistence, Unicode/resize, draft/focus, duplicate activation and cleanup.
Existing monitor tests cover reconnect, Gate cadence, read-only calls and
binding replacement; Host tests cover explicit options/settings and fallback.
These are automated fake-terminal tests, **not** PTY/human visual or production
Control dogfood. The ≤3-second readability goal remains a human acceptance check.

References: [architecture](architecture.md#11-runtime-only-presentation-and-external-projection),
[Control D2](pindie-control-v0.2.md#206-slice-d2--local-read-only-monitor),
[Control safety](pindie-control-v0.1.md#5-control-projection), and pinned Pi
`docs/tui.md`, `docs/extensions.md`, `dist/tui{,-alt-screen}.js`,
`dist/components/scroll-view.js`, `dist/modes/interactive/components/tool-execution.js`,
`dist/core/tools/renderers/{read,bash,edit}.js` (audit citations, not private imports).
