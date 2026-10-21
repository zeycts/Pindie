# Native Watch v2 (Pi 1.3.0)

## Result-first overview and conservative activity grouping

The pinned overview separates **Current status** (only a connected, coherent,
Session-matching snapshot) from **Last recorded outcome (history)**. Stale or
unavailable authority says `Task state stale · current outcome unconfirmed`;
runtime activity remains separate. Historical selection scans only the visible
50-event chronological tail, choosing the latest terminal completion or
verification, or explicit failure (including failed observation members and
semantic errors). It is not “last green”, current Task truth, or an earlier-history
query. No outcome says `No recorded outcome in visible history`; disconnected
or mismatched-Session history supplies no overview outcome. Sticky Gates outrank
history; retained stale Gates remain last-observed notices.

`watch-activity-grouping.ts` is a pure bounded projection, retaining original
blocks and order. Only adjacent complete, successful ordinary work is grouped,
at most eight source events per group; singletons remain normal events. Messages,
semantic events, runtime, failures, missing results and running tools break groups.
Any failed observation member makes the entire observation a standalone red
failure, even if its parent lifecycle is inconsistent. Running tools remain
explicit active rows, never hidden behind a completed group.

Factual group titles count tool operations (including observation items), list
tool types and infer no intent from commands. Enter/double-click on the group
reveals compact child titles; on a child it reveals the existing bounded/native
card. Keyboard selection visits displayed headers only. Both group and event IDs
use disjoint encoded namespaces; group identity comes from its first child.
Expansion is ephemeral. Re-chunking/50-tail eviction maps selection and row anchors
through surviving children, opens replacement groups for previously visible
children, or clamps genuine eviction to the oldest retained row without resuming
LIVE. The component hit-tests that same displayed row map. Collapsed groups do
not instantiate native children; hidden-child caches are evicted.

Automated v2 tests use a synthetic 22-block stale-done/settled/history-completion
reproduction, not a read of private production history. Human fullscreen/SSH/tmux
visual acceptance remains outstanding; no production restart/deployment is implied.


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
  `{ handled: true }` suppresses renderer fallback. The pinned event types include
  `press`, `release`, `move`, `drag`, `click`, and `wheel`, with left/middle/right/none
  buttons. There is no `doubleClick` event. Fullscreen synthesizes `click` after
  an unmoved press/release, with an optional screen-cell `clickCount` cycling
  through triple-clicks; overlay dispatch supplies local coordinates and bounds.
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
- Current status: authoritative Task status, verification status/covered-total counts and bounded Task goal when available;
- separate remote runtime activity and model/thinking when available;
- Last recorded outcome (history), explicitly limited to the visible tail;
- sticky Human Gate and connection/error notices above the feed.

The current monitor contract provides `displayIdentity`, which can be a raw
first prompt, not a verified title. Watch deliberately uses an eight-character
Session ID fallback, never that prompt. No separately exposed native Session
name exists in the current Control snapshot. A future Session title needs a
distinguishable name field. The existing authoritative `taskGoal` may supply a
concise bounded Task title, never a Session name or a timeline-derived summary.

Only connected, coherently authoritative semantic metadata supplies Task and
verification status; otherwise these are explicitly **stale / current outcome unconfirmed**
(including missing authority and disconnected snapshots), without fabricated
`?/?` coverage. Runtime idle, pending and
automatic-work-settled remain distinct facts. Idle alone never implies Task
completion. Gates retained during disconnect/retry are labeled last observed;
the observer cannot answer them. Respond via ChatGPT / Pindie Control, not local
chat. A fresh authoritative snapshot can clear the Gate. The last connection
error remains labeled during retry until connected/waiting replaces it.

| Gesture | Behavior |
|---|---|
| ↑/↓, k/j | Select previous/next displayed group/event/child title; leave LIVE |
| Enter | Toggle selected group or event/child expansion; leave LIVE |
| Left double-click feed card | Toggle that displayed group or event/child; leave LIVE |
| PgUp/PgDn | Scroll feed one viewport page; leave LIVE |
| Wheel | Scroll feed by Pi's normalized delta; leave LIVE |
| G/End | Select latest event and resume LIVE tail follow |
| Esc/q/Ctrl+C | Close only observer, restore original editor/focus/draft |

Double-click uses one bounded Pindie-local pair of completed left clicks within
400ms, matching stable event ID, event-local rendered row and pointer cell.
Single clicks do not toggle or select. Hit testing uses the painted feed row map,
including wrapped previews/native card rows and overlay-local coordinates; no
second scroll topology or Pi patch is introduced. Motion/drag, modifiers, other
buttons, wheel/keyboard navigation, resize/reflow, async updates and Session
replacement cancel pending gestures. Header/footer, blank rows, outside-feed
coordinates and the reserved rightmost/scrollbar column cannot toggle; one-column
terminals retain keyboard-only expansion. Stale/unpainted layouts fail closed.

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

## Semantic color and hierarchy

Watch uses the active Pi theme, not a separate palette. User/assistant role
prefixes use `accent`; ordinary tool titles and all prompt/command bodies retain
neutral foreground. Work markers alone show running (`accent`), complete
(`success`) or failed (`error`). Semantic headings are bold: Task uses accent
(or warning for blocked/waiting-human), Verification uses its recorded status,
and successful Completed events use success. Failed semantic operations take
precedence over status colors. These are **historical event facts**, never a
replacement for the live snapshot authority in the header.

Exactly one selected title uses Pi's `selectedBg` plus a bold accent `>`; `+`/`−`
and lifecycle icons remain meaningful without color. Metadata, preview notices
and ordinary fallback details recede; failed work/semantic diagnostics retain
normal text contrast. Native read/bash card lines keep Pi's own rendering,
without an outer Watch color wrapper. Current/last-observed sticky alerts and
stale semantic metadata use warning, preserving their existing factual labels.
Remote data is sanitized and bounded before styling; colors add no rows or
hit-test geometry. Theme/terminal palettes determine actual hues and selection
contrast. Narrow terminals still truncate content, and no-color terminals rely
on markers, labels and selection rather than hue. Human screenshot acceptance
is still required after an approved deployment.

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

While Watch is active, a runtime-only Presentation lease replaces Pindie's
local lifecycle/verification/activity/Gate/blocker/cost/time status with
`WATCH · remote read-only`. Account subscription/quota windows remain in the
right side of the shared status line. This strip never claims remote Task
truth; native Pi model/thinking presentation stays Pi-owned. Local semantic
State, measurements and quota observation continue unchanged. The lease
releases on close, errors, monitor termination, Session start/replacement and
shutdown, before asynchronous client cleanup; final cleanup is idempotent and
repaints only the current Presentation context, never a captured old Session.

Pi's public `ui.setStatus(key, text | undefined)` supports replacing Pindie's
own status entry without owning the native footer or editing Pi. Its
`ctx.ui.custom(..., { overlay: true })` owns mounting/stacking/completion and
focus restoration. Watch creates no terminal, input listener or second renderer.
A concurrent Watch is rejected until cleanup completes; an existing Pi overlay
prevents monitor creation. Later Pi dialogs retain Pi's stacking/focus ownership.
Session shutdown/reload/replacement closes the observer and awaits abort/client
cleanup. A late connect is closed before re-entry. Hard process death cannot
guarantee asynchronous cleanup; no watchdog is added.

Tests exercise the actual pinned custom-overlay implementation, real regular
and fullscreen renderers on fake Terminals, signed synthetic wheels, header/
footer exclusion, single-scroll topology, ID anchoring through tail changes,
Enter and deterministic left-double-click expansion/collapse, actual fullscreen
SGR press/release/click dispatch and native body-row hit tests, native read/bash
snapshots, content privacy and
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
