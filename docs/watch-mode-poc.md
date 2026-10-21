# Watch Mode UI PoC

## Scope and operation

With Presentation enabled in native Pi InteractiveMode, `/watch` opens a temporary
**Remote read-only** Control monitor overlay. Esc, q or Ctrl+C closes only that
observer and returns focus to the original local Pi editor. The local chat,
history, Session and agent execution are not replaced, aborted or resumed.

The remote Project/Session labels refer to the independently running loopback
Control service, **not** the local Pi Session hosting `/watch`. Respond to remote
Human Gates through ChatGPT / Pindie Control, not the local chat. No composer,
project/session selector, Control mutation or model invocation is added.

Navigation: j/k or arrows, PageUp/PageDown, G/End to follow live. The remote tail
remains limited to 50 blocks; each formatted block is bounded to 1,600 graphemes
and 12 rows. Older omitted blocks are labelled. Connection loss and Human Gates
use the existing monitor reconnect/wait state machine. `pnpm control:watch` and
its separate terminal implementation are unchanged.

## Stage A: pinned API findings (Pi coding-agent and pi-tui 1.3.0)

Inspected the installed package declarations, implementation and native overlay
example, not an assumed full-screen API:

- `core/extensions/types.d.ts`: `registerCommand(name, { description, handler })`
  supplies an `ExtensionCommandContext`. `mode === "tui"` **and** `hasUI` are
  required: RPC also has UI but does not support custom terminal components.
  Extension loading itself has no native UI context. Registration is therefore
  deferred to native `session_start`; the handler guards again. The loader's
  `registerCommand` writes the extension's command Map; the runner reads this
  Map dynamically. InteractiveMode builds autocomplete after binding extensions
  (including Session startup). Presentation-disabled startup adds no command.
- `ExtensionUIContext.custom<T>(factory, options?): Promise<T>` passes the
  existing `TUI`, `Theme`, `KeybindingsManager` and `done(result)` to the factory.
  The factory can return a component synchronously or asynchronously; components
  provide `render(width): string[]`, optional `handleInput` and `dispose`.
- `modes/interactive/interactive-mode.js`, `showExtensionCustom`: default custom
  UI replaces **only the editor container**, not the full interactive screen.
  It saves editor text and restores editor/text/focus on completion. With
  `overlay: true`, it instead mounts using the existing TUI's `showOverlay`.
  Calling `done` hides that exact overlay, resolves the promise, then invokes
  component `dispose`. We never call an overlay handle's `hide` ourselves.
- `pi-tui/dist/tui.js`, `showOverlay`: captures pre-overlay focus, focuses the
  visible overlay and restores the top remaining overlay or original component
  on hide. Input goes to the focused component; the PoC creates **no** terminal,
  alternate screen, process input listener or independent renderer. Another
  overlay already present is rejected before creating a monitor. Later Pi
  overlays retain Pi's native stacking/focus ownership.
- `OverlayOptions` supports percentage width and `maxHeight`, anchor and margins;
  `maxHeight` clips output, it does not allocate a component viewport. This PoC
  explicitly budgets `min(30, terminal.rows - 2)` rows (at least one) and uses a
  full-width centered overlay. It is **not** a fullscreen mode switch. It works
  within either Pi renderer's overlay support without changing terminal modes.
- ScrollView's public `render`, `updateLayout`, `scrollTop`, `viewportHeight`,
  `scrollBy`, `scrollToEnd` and `isFollowingEnd` provide scroll/follow state. The
  adapter explicitly budgets/slices its viewport because plain component render
  has width only, not height. Pi's `Key`/`matchesKey`, theme callback and
  `truncateToWidth` provide key parsing, styling and column-aware line fitting.
- `custom` has **no AbortSignal, automatic Esc action, session-lifetime disposal
  guarantee, or concurrency lock**. Its completion closure is idempotent. A
  factory that calls `done` before mounting can skip Pi's component disposal;
  this is why our factory is synchronous, observation starts in `onHandle`
  (after mount), and our own `finally`/Session shutdown cleanup is idempotent.
  Shutdown/reload/Session replacement closes the interaction and awaits the
  monitor's abort/client cleanup. Re-entry remains locked until cleanup settles.
  A late connect is closed before the next interaction is admitted.
- Normal exit does not use `ctx.abort`, `ctx.signal` (an agent-operation signal,
  often absent for commands), Session switching or Host disposal. Hard process
  death/SIGKILL cannot guarantee asynchronous cleanup; no new watchdog is added.

References: installed `docs/extensions.md` (UI/modes/lifecycle), `docs/tui.md`,
`docs/themes.md`, `examples/extensions/overlay-test.ts`; installed
`core/extensions/loader.js`, `core/agent-session.js` command dispatch,
`modes/interactive/interactive-mode.js` custom UI and extension binding;
`pi-tui/dist/tui.{js,d.ts}` and `components/scroll-view.{js,d.ts}`.
Repository boundaries: [architecture](architecture.md#11-runtime-only-presentation-and-external-projection),
[Control v0.2 D2](pindie-control-v0.2.md#206-slice-d2--local-read-only-monitor),
[Control v0.1](pindie-control-v0.1.md#10-headless-host-mode).

## Implementation and evidence

`watch-command.ts` owns one temporary observer interaction, not a Session or
Host. `watch-component.ts` adapts the existing `PindieControlMonitor` view port;
protocol validation, wait, reconnect and Gate handling remain unchanged.
`timeline-text.ts` remains the canonical formatter. Existing standalone monitor
source and entrypoint are untouched.

`tests/watch.test.ts` exercises the actual pinned `showExtensionCustom` and
Pi TUI overlay lifecycle using an inert local Session and fake terminal. It
checks registration/mode safety, exits, focus/draft preservation, re-entry,
parallel overlays, pre-mount shutdown, late client cleanup, disconnected/Gate
rendering, rapid updates, scroll/follow, resize and Chinese/emoji widths. The
fake-terminal smoke starts exactly one Pi main-screen renderer/input listener,
renders Watch, sends keys **only to that fake terminal**, and returns to the
original editor without an alternate-screen escape. Existing monitor/client
coverage verifies read-only protocol, Gate cadence, binding replacement and
reconnect. Extension integration tests check Presentation/native registration.
No live user terminal, real Session file, model, service restart or deployment
is part of this validation.

## Remaining PoC gaps

- This is a bounded overlay, not the eventual redesigned full-screen Watch UI.
  Tiny terminals truncate labels/Gate text; full details and older history are
  intentionally not navigable. No mouse UX or polished empty/error layouts.
- No global Pi dialog lock is invented. A later native dialog can take focus;
  Pi owns overlay stacking. The Watch lock covers its own open/closing lifetime.
- Automated smoke uses an isolated fake terminal plus real pinned renderer,
  not a human visual/PTY dogfood run or production Control connection. No claim
  is made about every terminal/IME/theme combination.
- The read-only connection uses the existing configured loopback endpoint. It
  does not discover/start the service or infer a relationship to the local Session.
