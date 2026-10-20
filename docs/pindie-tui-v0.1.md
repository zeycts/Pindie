# Pindie TUI v0.1 — Architecture and Implementation Contract

Status: **Pindie owned TUI v0.1 experiment concluded.** Slices A–G1 / G2a and the G2b audit/dogfood work are retained as experiment history. Real G2b dogfood changed the architecture decision: G2c cutover is cancelled / not proceeding. Production continues to use Pi InteractiveMode by default; `PINDIE_TUI=1` remains an opt-in, frozen experimental implementation. This is not a temporary pause caused by implementation failure: real-world usability evidence showed that taking ownership of the interaction layer does not justify its engineering complexity and usability cost.

Baseline: Pindie main after Pi 0.86.1 compatibility upgrade.

This document records the architecture, implementation, and conclusion of Pindie's first owned Agent-native terminal UI experiment. Historical implementation contracts below describe the evaluated experiment; they are not an active roadmap to a default cutover.

The goal is not to build a prettier chat terminal. The goal is to make long-running Agent work legible with minimal monitoring:

> the human gives intent, the Agent works, routine activity recedes, and the UI asks for human cognition only when human judgment or intervention is actually required.

Pindie continues to use Pi as the low-level Agent runtime. This work changes interaction and presentation ownership, not Agent Harness ownership.

## 1. Ownership and non-goals

Current ownership remains:

```text
Human       → goals, taste, consequential judgment, approval
Model       → interpretation, planning, semantic choice, verification meaning/coverage
Pindie Host → process lifecycle, active AgentSessionRuntime ownership/replacement
Pindie      → durable semantic State, legality, capability, factual evidence/freshness
Pi          → active AgentSession implementation, LLM execution, tools, Skills,
              retries, compaction, message queues, low-level Agent Loop
```

The interaction-layer ownership model evaluated in the experiment was:

```text
PindieInteractiveMode
  → interaction model
  → UI projection
  → timeline/block presentation
  → focus and keyboard routing
  → local attention presentation
  → extension UI implementation
```

The TUI must not introduce:

- a second Agent Loop;
- a second Session runtime;
- a Task queue or workflow engine;
- duplicate durable semantic State;
- a transcript database;
- a second tool queue;
- another planner;
- UI-owned Task/verification/Human Gate truth;
- chain-of-thought storage or display;
- a custom terminal renderer when Pi's public terminal primitives already solve the problem.

The core invariant is:

```text
Facts have one owner.
The TUI projects facts; it does not become their authority.
```

## 2. Chosen production topology

```text
Pindie Host
    ↓
Pi InteractiveMode
    ↓
Pi AgentSessionRuntime
    ↑
Pindie extension/runtime integration
```

Pi continues to own the mature interactive terminal shell and low-level runtime. Pindie continues to own and provide through its extension/runtime integration:

- semantic State and policy / authority;
- Agent Harness and autonomous behavior;
- Human Signal;
- Remote / Discord;
- quota resume and long-task rollover;
- Work Memory, reasoning, and other Agent-native capabilities.

The following was the **experimental topology evaluated during the owned-TUI experiment**, not a target topology:

```text
Pindie Host
   └─ PindieInteractiveMode
          │
          ├─ Projection / Views ─────────→ @earendil-works/pi-tui
          ├─ Attention / Extension UI ──→ @earendil-works/pi-tui
          └─ Action Dispatcher
                    ↓
             PiRuntimeAdapter
                    ↓
             Pi AgentSessionRuntime
                    ↓
             Agent Loop / Models / Tools / Skills
```

## 3. Screen anatomy

The owned TUI keeps four structural regions, but ordinary content must not turn the fixed chrome into a second transcript:

```text
┌──────────────────────────────────────────────────────────────┐
│ one-line Header                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ scrollable Timeline; no permanent heading or empty text      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Composer/editor, or contextual hard Attention               │
├──────────────────────────────────────────────────────────────┤
│ one-line normal Footer                                       │
└──────────────────────────────────────────────────────────────┘
```

These labels describe layout ownership; Timeline and Composer are not permanent rendered headings. Overlay is transient and sits above the Timeline. Necessary active Extension/runtime actions may contribute bounded contextual rows, but ordinary idle chrome remains bounded.

Do not add permanent sidebars, task panels, files panels, agent panels, queue panels, or tabs in v0.1.

### Header

Header answers: **where am I?** Its normal target is one physical terminal row and it contains only:

- a bounded human-facing Session display identity;
- model id (not provider);
- thinking level.

Do not put duplicate Pindie/project identity, provider, Task status, or coherent/stale authority in persistent Header chrome. In particular, `getActiveSessionDisplayIdentity()` may use the first real user message when the Session has no explicit name; that fallback is content, not a safe fixed-width label. Bound the projected display identity at the presentation boundary to at most 48 Unicode grapheme clusters, including its truncation marker, without changing the underlying Session name, transcript, or picker data. Then clamp/ellipsis the final assembled Header against the current terminal's display width so it remains one physical row; a pre-truncated identity alone is not sufficient because model id and terminal width also vary. When the available width is too small for every field, prioritize a legible single-row truncation rather than wrapping.

Authority-unavailable remains a hard Attention condition rendered in the Attention surface. Chrome cleanup must not weaken or replace that fail-closed signal with a quiet footer badge. Soft settled-blocked remains distinct and must not become hard Attention.

### Timeline

Timeline answers:

> what happened, what is happening, and what matters?

It is a structured projection, not a raw ANSI transcript. The normal Timeline has no permanent heading; an empty Timeline stays blank rather than rendering a placeholder.

### Composer / Attention

Normal state shows the Pi Editor without a permanent `Composer` title. When a hard human interaction is active, the same region becomes a contextual Attention surface. Human Gate and runtime permission are allowed to own input; ordinary blocked/completed/stopped states are not. Removing the ordinary title must not alter Editor ownership or input semantics.

### Footer

The normal Footer is one physical row containing compact ambient runtime facts (for example idle/running, verification progress, queue/quota state when relevant) and, while idle, the primary discoverability cue `Alt+P Commands`. Do not render permanent `Status` / `Hints` labels or a standing list of `Alt+M`, `Alt+N`, or `Alt+H` shortcuts. The Command Palette is the normal shortcut-discovery surface; context-specific focus/Attention may show relevant hints. Preserve the registered actions and their dispatch semantics.

Clamp the final Footer to the current terminal width and keep ordinary idle Footer height to one row. Do not add Task lifecycle or coherent/stale authority as ambient Footer content. Clamp each active actionable Extension/runtime addition too; show only a bounded set of relevant additions and aggregate/omit overflow rather than letting long passive text or a burst of contributions create unbounded persistent chrome. These additions may use extra contextual rows when necessary without changing the normal-idle baseline. Human Gate, verification failure, and blocker explanation must not be hidden only in the Footer.

## 4. Projection contract

The TUI owns no semantic business state.

Conceptually:

```text
Persistent semantic truth = Pindie State
Runtime truth             = Pi runtime + Host runtime controllers
Historical transcript     = Pi Session entries
UI projection             = derived, disposable, rebuildable
UI-local state            = focus / selection / scroll / fold / draft / overlay
```

The read model is conceptually:

```text
Pindie semantic facts
        +
Pi runtime/session facts
        +
Host runtime facts
        +
Pi Session history/events
        ↓
UI Projection
        ↓
Header / Timeline / Footer / Composer-or-Attention
```

A future `UiProjection` may be incrementally maintained for performance, but it is non-authoritative and must be reconstructable from authoritative facts/history.

### 4.1 Fact ownership

At minimum:

| Fact | Owner |
| --- | --- |
| Task goal/status | Pindie State / existing semantic derivation |
| Human Gate | Pindie State |
| blockers/questions | Pindie State |
| verification status/coverage | existing Pindie semantic derivation |
| semantic authority | existing Run/Semantic Snapshot |
| Agent running/settled | Pi/Pindie Run lifecycle |
| thinking/reading/editing/running activity | Pi tool/runtime events |
| elapsed/cost/task consumption | existing runtime trackers |
| quota wait/resumeAt | Host quota-resume lease |
| model/thinking level | active Pi AgentSession |
| steer/follow-up queue | Pi queue state/events |
| assistant streaming | Pi session events |
| tool execution | Pi tool lifecycle events |
| Session transcript | Pi SessionManager |
| focus/selection/fold/scroll/draft/overlay | TUI only |

The TUI must never write a business fact directly. User actions go through Pindie/Pi runtime boundaries and the resulting authoritative fact is projected back.

### 4.2 Snapshot vs events

Keep current truth and historical transition separate:

```text
Snapshot  → what is true now
Events    → what happened
Attention → what human cognition is required now
```

Example: `Task done` is current truth; `Task just completed` is a transition that may create a Timeline block and external notification.

## 5. Timeline and Block model

The visible Timeline uses four block families:

```text
Timeline
│
├─ MessageBlock
│    ├─ User Intent
│    ├─ Steer
│    ├─ Follow-up
│    └─ Agent Message
│
├─ WorkBlock
│    ├─ Observe
│    ├─ Edit
│    ├─ Command
│    └─ External
│
├─ SemanticBlock
│    ├─ Task
│    ├─ Verification
│    ├─ Human Gate anchor
│    └─ Completion
│
└─ RuntimeBlock
     ├─ Quota
     ├─ Rollover
     ├─ Stop
     ├─ Retry when material
     └─ Permission anchor
```

The visible vocabulary should remain small even when the underlying Pi event vocabulary is large.

### 5.1 Display modes

Blocks support three distinct density layers:

```text
Compact  → routine/history awareness
Preview  → a bounded current-work or important-content working set
Full     → detail available only through explicit expansion/inspection
```

Density is role- and lifecycle-specific: user Messages default to Compact; streaming or completed assistant Messages and running Work use bounded Preview; successful routine Work recedes to Compact; failures retain bounded diagnostic Preview. For these routine blocks, Full is an explicit human choice (expand, inspect, or copy), not a default merely because content is complete. Semantic blocks are exempt from generic noise compaction: preserve domain-important Human Gate, Completion, and other meaningful outcomes in their semantic presentation. Manual expansion pins the user's choice; automatic lifecycle updates must not immediately undo an explicit human expand/collapse decision.

Every Preview intended for the normal Timeline must be bounded in both content length and rendered physical rows at the current terminal width. The v0.1 working budget is at most 320 Unicode grapheme clusters of projected content and at most four physical rows for the complete block including its marker/role/provenance; whichever limit is reached first wins. Emit a visible `…` truncation marker. Clamp metadata as well as body text when a narrow terminal cannot fit it; do not rely only on character-count truncation and then allow wrapping to defeat the row bound. Compact message previews use at most 120 grapheme clusters of first meaningful content and at most one physical row including metadata. A later reviewed tuning may reduce these budgets, but must preserve the bounds and tests.

#### MessageBlock policy

- User messages, including Prompt / Steer / Follow-up echoes, default to Compact in normal/history projection. Show role and available delivery provenance plus the first meaningful content; a long Prompt is never expanded in full by default.
- Streaming assistant messages use the bounded Preview budget as text grows.
- Completed assistant messages also default to bounded Preview, not Full; error messages use bounded diagnostic Preview. Completion does not silently expand dozens of lines.
- Explicit Full retains the complete projected text. In the normal Timeline it is available only after explicit expand; Block Viewer and copy also explicitly request Full.

The governing principle is:

> routine successful work recedes; exceptions, risks, and meaningful outcomes remain visible.

### 5.2 Thinking is not a persistent block by default

`thinking` is live activity, not durable Timeline content.

Do not create a persistent ThinkingBlock for every reasoning interval. Provider-visible reasoning summaries may be rendered as ordinary visible Agent content where appropriate, but internal chain of thought is never a Timeline data model.

### 5.3 Observation grouping

Read-only repetitive work is aggressively grouped.

Observation-class operations include existing read-only operations such as:

```text
read
grep
find
ls
web search/context
pindie_git_observe
```

Example:

```text
✓ Inspected project
  Read 4 files · Searched 2 patterns · Listed 1 dir
```

Group boundaries are strict. User input, Edit, Command, semantic transition, error, Attention, or Session boundary ends the current observation burst.

Grouping is a presentation construct only.

A running ObservationBlock renders a bounded current-work preview: one aggregate summary for the whole burst plus the current operation, or the latest useful operation when none is current. Do not map every item into a new visible line; observation bursts can be large, and Preview physical height must not grow linearly with item count. Keep the aggregate counts representative of all grouped items. A completed burst is a compact aggregate. A failed burst keeps bounded diagnostic detail for the relevant failure; Full inspection remains available explicitly.

### 5.4 Edit

Mutations preserve identity.

Success may compact to:

```text
✓ Edited src/remote-notice.ts             +54 -11
```

Do not collapse the working history into a generic `Edited 8 files` group. Completion may summarize total changed files separately.

### 5.5 Command

Streaming stdout/stderr must not continuously grow the physical Timeline. While running, keep the existing bounded tail. On successful completion, compact. On failure, preserve bounded diagnostic context; the Full viewer can show the available projected detail. Do not let long command labels or result summaries bypass the normal Preview row/character bounds.

### 5.6 Semantic tools project domain meaning

Do not expose Pindie semantic implementation mechanics such as:

```text
Called pindie_verification_record
Called pindie_task_complete
```

Project them as:

```text
● Verification · 2/3
✓ Verification · 3/3
✓ Completed
◇ Task refined
```

Repeated updates to the same semantic phase should update one semantic block where possible rather than append reducer/tool noise.

### 5.7 Completion

Completion remains visible and does not auto-collapse merely because it is successful.

Example:

```text
✓ Completed

  Proactive lifecycle notifications implemented

  Verification
  ✓ typecheck
  ✓ tests
  ✓ build

  Changes
  7 files · +132 -47

  PR #42
```

## 6. Input, focus, and actions

The focus vocabulary is deliberately small:

```text
composer
timeline
attention
overlay
```

Composer is the normal focus. Timeline focus is entered only when the human wants to inspect work.

Input dispatch follows:

```text
Overlay
  ↓ if unhandled
Attention
  ↓ if unhandled
Focused surface
  ↓
Workspace
  ↓
Global
```

The same key may have different actions at different ownership layers, but one resolved key press must map to at most one action.

### 6.1 Action Registry

All shortcuts, command palette entries, contextual hints, and key dispatch derive from one Action Registry.

Do not maintain separate command definitions for:

- keyboard handling;
- palette;
- shortcut bar;
- help.

Conceptually:

```text
Action Registry
   ├─ Key Dispatch
   ├─ Command Palette
   ├─ Shortcut Hints
   └─ Help
```

Separate:

```text
context      = which surface owns input
availability = whether current reality allows the action
```

### 6.2 Composer delivery semantics

Preserve Pi's delivery model:

```text
Idle Enter        → Prompt
Working Enter     → Steer
Working follow-up → Pi Follow-up queue
Escape while running → Abort
```

Steer and Follow-up remain visually distinguishable in Timeline because their provenance matters when reviewing a long Session.

### 6.3 Default keymap for the current VS Code → SSH → tmux workflow

Pindie commonly runs through:

```text
Keyboard → VS Code → Integrated Terminal/SSH → tmux → Pindie
```

Therefore global Pindie shortcuts should avoid claiming common Ctrl combinations used by VS Code, shell, or tmux.

The current workstation also reserves most Alt + left-hand letters for external application switching. Pindie therefore uses a sparse right-hand Alt namespace.

Default v0.1 profile:

```text
Composer
Enter       Send Intent / Steer
Alt+U       Follow-up / After
Shift+Enter New line
Alt+Enter   New line (Pi Editor; not a Pindie action)
Esc         Stop active Run

Global
Alt+P       Command Palette
Alt+H       History / Timeline
Alt+M       Model Picker (reserved for F2; not bound in F1)
Alt+N       Session Picker (reserved for F2; not bound in F1)
```

Do not add more global bindings merely because keys are available.

Within Timeline focus, use ordinary navigation keys:

```text
j / ↓       next block
k / ↑       previous block
h / ←       collapse
l / →       expand
e           toggle fold
Enter       inspect
y           copy
Esc         return
```

Low-frequency actions belong in the Command Palette.

All bindings must remain configurable. A future keyboard diagnostic may show which key sequence actually reached Pindie; it must not pretend to know which upstream layer swallowed an unseen key.

F1 registers only Pindie application actions. Pi's public `Editor` remains the owner of text editing, including Enter/newline handling, cursor movement, paste, IME, autocomplete, and undo. The F1 input listener consumes declared Pindie bindings and forwards undeclared input to the Editor; it does not register an Alt+Enter Follow-up alias.

## 7. Attention and notification policy

Attention is not a Task status.

> Attention means the system is requesting human cognition.

Local Attention and external notification are separate projections of a higher-level Human Signal Policy.

```text
Semantic / Runtime Reality
        ↓
Human Signal Policy
        ↓
        ├─ Local TUI Attention
        ├─ Timeline
        └─ External Notification
                 ↓
              Discord
```

v0.1 policy:

| Situation | Timeline | Local Attention | External notify |
| --- | --- | --- | --- |
| normal working | live | no | no |
| recovering blocker | yes | no | no |
| ordinary tool failure | expanded | no | no |
| verification failed while Agent continues | expanded | no | no |
| Human Gate | anchor | strong | yes |
| runtime permission | anchor | strong | yes |
| settled blocked with no automatic successor | yes | soft / Composer usable | yes |
| semantic authority unavailable | yes | strong | yes |
| quota auto-resume waiting | yes | no | no |
| successful Session rollover | optional | no | no |
| completed | yes | no modal | yes |
| stopped while Task remains active | yes | no modal | yes |

### 7.1 Blocked is not automatically Attention

```text
Task blocked + Agent still recovering
→ no external notification
→ no hard local Attention

Run settled + Task still blocked + no automatic successor
→ human signal
```

### 7.2 Human Gate

Human Gate is durable semantic Attention. It persists until the semantic Gate is resolved; closing or navigating away from UI must never dismiss the Gate.

The human may temporarily inspect Timeline context while a Gate remains active, but Composer must not bypass the unresolved Gate.

### 7.3 Completed and stopped

Completed and stopped are meaningful outcomes that may call the human back externally, but they must not create a local confirmation modal.

```text
Run stopped != Task failed
Run stopped != Task blocked
Run stopped != Task completed
```

### 7.4 Quota wait and rollover

Successful autonomous continuity mechanisms are intentionally quiet.

If quota auto-resume is successfully scheduled or Long Task rollover is successfully committed, no human action is required and no external mention is sent.

### 7.5 Notification delivery

Persistent local Attention is derived from current Reality.

External notification is an edge-triggered side effect and uses runtime-only delivery deduplication. Do not persist UI `read/unread/acknowledged` state into Pindie semantic State.

## 8. Renderer choice

Pindie TUI v0.1 uses:

```text
@earendil-works/pi-tui
+
TuiAltScreen
```

It does not use Ink/React and does not implement its own ANSI renderer.

Reason:

- Pi already solves terminal input decoding, differential rendering, resize, cursor, IME, mouse/selection, SSH/tmux quirks, overlays, scrolling, and editor primitives;
- Pindie already depends on Pi;
- adding another renderer stack would duplicate infrastructure without improving semantic/product ownership.

The boundary is:

```text
pi-tui           = terminal rendering infrastructure
Pindie TUI       = product interaction and presentation
Pi runtime       = Agent execution infrastructure
```

Use public Pi/pi-tui APIs only. Do not deep-import private InteractiveMode implementation files.

### 8.1 Full-screen layout

Use `TuiAltScreen` because v0.1 needs application-owned layout:

```text
Header                      fixed, one physical row
Timeline / ScrollView       grow; no permanent heading
Composer / Attention        fixed, no ordinary Composer title
Footer                      fixed, one normal physical row
```

Header and normal Footer are width-clamped before rendering so they cannot wrap and consume the Timeline/Composer viewport. Timeline growth/shrinkage must not change Pi Editor ownership.

### 8.2 Editor

Do not reimplement text editing.

Use Pi's public `CustomEditor` / keybinding primitives where appropriate so multiline editing, paste handling, IME behavior, autocomplete, and terminal input details remain upstream-owned.

F1 uses Pi's public `Editor` directly. Pindie owns submission semantics and application-action routing, not text-editor mechanics; F2's Extension UI bridge must preserve the same ownership boundary.

## 9. Extension UI boundary

A Pindie-owned interactive mode must implement Pi's public extension UI contract rather than depending on Pi InteractiveMode.

Pi extensions may request operations such as:

```text
select
confirm
input
editor
notify
custom
status/widget/header/footer contributions
```

PindieInteractiveMode must bind the active AgentSession with its own `ExtensionUIContext` and command context actions.

Semantic distinction remains:

```text
Human Gate        = Pindie semantic human-decision boundary
Runtime Permission = Pi/runtime execution authorization
```

They may share the same visual Attention region without becoming one domain concept.

## 10. Session lifecycle and runtime seam

Pi 0.86.1 public APIs support the required custom client lifecycle:

```text
AgentSessionRuntime.setBeforeSessionInvalidate()
AgentSessionRuntime.setRebindSession()
AgentSession.bindExtensions()
AgentSession.subscribe()
```

Session-local subscriptions and extension UI bindings must be torn down and rebound whenever the active AgentSession is replaced.

Conceptual lifecycle:

```text
startup
  ↓
bind active Session extensions
  ↓
subscribe active AgentSession
  ↓
rebuild projection
  ↓
render

Session replacement
  ↓
beforeSessionInvalidate
  ├─ unsubscribe old Session
  ├─ detach old extension UI components
  └─ invalidate old presentation lease
  ↓
Pi installs new AgentSession
  ↓
rebind callback
  ├─ bind extensions
  ├─ subscribe new Session
  └─ rebuild projection
```

Never retain a stale Session-local ExtensionContext or subscription after replacement.

## 11. Presentation Read Port

The Host-owned TUI needs semantic facts that currently live inside the Pindie extension/Core integration.

Do not solve this by parsing transcript text or creating another State bridge.

The existing extension registration already creates a `PindieExtensionIntegration`; production composition should expose a narrow read-only presentation port for the current Session.

The port must provide structured, renderer-independent facts only.

Conceptually:

```ts
interface PindiePresentationReader {
  snapshot(): PindiePresentationSnapshot;
}

interface PindiePresentationSnapshot {
  semantic: SemanticDerivationResult;
  status: PindieStatusSnapshot;
  quotaResumeWaiting: QuotaResumeWaitingStatus | null;
  projectRoot: string | null;
}
```

Exact implementation types may evolve, but these rules are fixed:

- semantic derivation comes from the existing RunIntegration/Semantic Snapshot path;
- legacy Pi footer rendering and the new TUI consume the same presentation facts during migration;
- exact quota waiting includes `resumeAt`, not only a boolean;
- the reader performs no UI calls and no external I/O;
- it is not persisted;
- it exposes no mutable Core internals.

## 12. Experiment topology and disposition

During the experiment, both shells remained runnable and `PINDIE_TUI=1` opted into the owned implementation. That reversible arrangement is retained as historical context. The experiment concluded without cutover: production remains on Pi InteractiveMode, and the owned TUI is frozen rather than an active product path. No default switch or Pi fallback removal is planned.

## 13. Implementation Slices

The following records the experiment's implementation sequence and outcomes; it is not an active implementation roadmap.

### Slice A — Presentation Read Port (implemented)

Goal:

```text
authoritative Pindie facts
        ↓
renderer-independent presentation reader
```

Work:

- expose one structured presentation snapshot from existing Integration/Presentation;
- refactor legacy status rendering to consume the same facts;
- expose current integration reader from configured extension registration;
- no TUI files or Host switching required.

Acceptance:

- implementation complete; behavior-neutral;
- existing Pi InteractiveMode unchanged;
- no duplicate semantic derivation;
- exact quota wait projection;
- focused tests and full check green.

### Slice B — Runtime Client Seam (implemented)

Goal: give a future Host-owned interactive client only the Pi runtime controls it needs.

Likely public Adapter surface includes:

- active-session event subscription;
- active-session replacement/rebind lifecycle;
- abort;
- queue clear/restore facts required for abort UX;
- prompt / steer / follow-up;
- active model/thinking/session facts.

Do not move Pi Agent Loop ownership into the Adapter.

### Slice C — Projection Core (implemented)

Implement pure/reconstructable projection logic without terminal rendering.

Inputs:

- Presentation Read Port;
- Pi Session history/events;
- Host runtime facts.

Outputs:

- Header facts;
- Timeline block model;
- Footer facts;
- Attention projection.

Tests should operate on plain data.

### Slice D — TUI Shell (experimental implementation retained; frozen)

Introduce feature-gated `PindieInteractiveMode` using `TuiAltScreen`.

The initial shell provides:

- Header region (awaiting G2a bounds);
- scrollable Timeline;
- Composer / Attention region;
- normal Footer;
- real Prompt / Steer / Follow-up / Abort;
- Session rebind correctness.

Implemented behind `PINDIE_TUI=1`; the default remains Pi `InteractiveMode`. Subsequent G2a/G2b work and real dogfood concluded the experiment without cutover. Semantic Attention interaction landed in Slice F2a; the implemented Extension UI surface and its explicit limitations are recorded in F2b. The shell is frozen experimental code, not an active product path.

### Slice E — Semantic Timeline (implemented)

Implementation status:

- E1 Work Timeline — implemented
- E2 Pindie Semantic Timeline — implemented

Implemented:

- stable live block identity;
- observation grouping;
- Edit/Command blocks;
- bounded running command-output tails;
- automatic success compaction;
- failure persistence;
- semantic Task/Verification/Completion projection;
- structured Human Gate anchors and completion truth checks.

### Slice F1 — Interaction Core (implemented)

Implemented in the feature-gated Pindie TUI:

- renderer-light Action Registry for Pindie application actions, key resolution, palette entries, and contextual hints;
- default sparse right-hand Alt bindings (`Alt+P`, `Alt+H`, and `Alt+U`);
- Composer/Timeline focus, stable Block selection, visibility scrolling, and UI-local fold overrides;
- searchable registry-derived Command Palette;
- full Block Viewer and copy;
- Session-epoch reset of selection, folds, overlays, and focus.

F1 deliberately does not bind model/session pickers or `Alt+M`/`Alt+N`, and it does not implement interactive Attention or the Extension UI bridge. Pi's public Editor remains the owner of all text-editing mechanics.

### Slice F2 — Attention and Extension UI (implemented)

#### F2a — Semantic Attention Interaction (implemented)

Implemented:

- first-class Attention focus derived from current `projection.attention`;
- interactive Human Gate options and Pi `Editor`-owned free-form responses;
- persistent Gate ownership with Timeline inspection and non-destructive Escape;
- authority-unavailable Attention that blocks ordinary Composer work;
- Session-epoch and Projection-driven reset/preservation of UI-local Attention mechanics;
- controller-side current-Session, current-Gate, native-idle, and duplicate-delivery guards;
- ordinary prompt delivery and local user Timeline echo for Human Gate responses.

A Human Gate response is ordinary user input to the Agent. The TUI never calls `pindie_gate_resolve` or mutates Gate State directly; the Agent interprets the response and resolves the semantic Gate through the existing Pindie tool/runtime path.

#### F2b — Extension UI + Pickers (experiment implementation status recorded below)

##### F2b1 — Extension Interaction Bridge (implemented)

The owned TUI now binds a Session-scoped `ExtensionUIContext` and all six `ExtensionCommandContextActions`. Extension dialogs are ephemeral UI overlays, serialize behind one bridge-local queue, and are cancelled with their queued successors before Session invalidation. They never become Human Gates or semantic Timeline events. The active input priority is `Extension overlay → semantic Attention → Timeline → Composer → Global`: an Extension dialog preempts the Command Palette or Block Viewer, while newly appearing semantic Attention remains authoritative underneath and does not cancel the dialog.

Implemented `ExtensionUIContext` capabilities:

- `select`, `confirm`, `input`, and multiline `editor`, including cancel, `AbortSignal`, timeout, and overlay cleanup;
- `notify` with info/warning/error severity;
- `onTerminalInput` with consume/transform behavior below modal and semantic input ownership;
- keyed `setStatus` contributions rendered as a bounded secondary status;
- `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, and `setHiddenThinkingLabel` as UI-local ambient presentation;
- `pasteToEditor`, `setEditorText`, and `getEditorText` against the ordinary Composer;
- `setTitle` against the active terminal, restored to the Pindie-owned `Pindie` baseline when the Extension Session is cleared.

The command-context mapping is exact: `waitForIdle → AgentSession.waitForIdle`, `newSession → AgentSessionRuntime.newSession`, `fork → AgentSessionRuntime.fork`, `navigateTree → AgentSession.navigateTree`, `switchSession → AgentSessionRuntime.switchSession`, and `reload → AgentSession.reload`. Session-replacing actions rely exclusively on the existing runtime `beforeSessionInvalidate` / `rebindSession` lifecycle.

F2b1 deliberately left the remaining contribution and picker compatibility surface to F2b2. Its final status is recorded below.

##### F2b2 — UI Contributions + Pickers (implemented)

Implemented:

- keyed, ordered `string[]` widgets above/below the ordinary Composer, clipped to a bounded contribution region;
- stacked ordinary-Composer autocomplete providers over the public `CombinedAutocompleteProvider([], cwd)` baseline, preserving its completion-application and file/path behavior without recreating private `InteractiveMode` command setup;
- Session-scoped global WorkBlock expansion, with precedence `per-Block fold override → tools-expanded → Projection default`;
- searchable Model and current-project Session overlays, sourced and mutated only through public Pi Session/runtime APIs; direct Model selection delegates only to `AgentSession.setModel()`, so Pi owns the resulting thinking-level policy;
- shared Action Registry bindings `Alt+M → model.pick` and `Alt+N → session.pick`;
- current-Session, native-idle, semantic-Attention, Extension-interaction, and Session-epoch guards both after asynchronous Picker loading and again before selection mutation.

Pindie's Extension contribution interpretation keeps its mandatory semantic Header and normal Footer authoritative. A future public-compatible header/footer contribution would be additive rather than replacing those regions.

Final Pi 0.86.1 `ExtensionUIContext` capability matrix:

| Capability | F2 status |
| --- | --- |
| `select`, `confirm`, `input`, `editor` | implemented through the shared Session-scoped Extension interaction serializer |
| `notify`, terminal input, status/working/title, Composer text/paste | implemented |
| `setWidget(key, string[], options)` | implemented; keyed replacement/removal, insertion order, above/below placement, bounded rendering |
| `setWidget(key, componentFactory, options)` | explicitly unsupported: package-root exports no active `Theme` instance required by the factory |
| `setHeader` | explicitly unsupported: package-root exports no active `Theme` instance; Pindie would treat it as an additive Header contribution |
| `setFooter` | explicitly unsupported: package-root exports neither an active `Theme` instance nor a constructible public `FooterDataProvider`; Pindie would treat it as an additive Footer contribution |
| `custom` | explicitly unsupported: package-root exports neither active `Theme` nor app `KeybindingsManager` values required by the factory contract |
| `addAutocompleteProvider` | implemented for the ordinary Composer; providers stack in registration order over the public `CombinedAutocompleteProvider([], cwd)` file/path and completion-application baseline |
| `setEditorComponent`, `getEditorComponent` | explicitly unsupported: package-root does not export `getEditorTheme()` or a runtime app `KeybindingsManager` value/constructor needed for faithful factory construction |
| `theme` | explicitly unsupported: `Theme` class is public but the active singleton is not exported |
| `getAllThemes`, `getTheme`, `setTheme` | explicitly unsupported: enumeration, lookup, and switching helpers are not package-root exports |
| `getToolsExpanded`, `setToolsExpanded` | implemented as Session-scoped UI-local WorkBlock density preference |

All contribution state is owned by the active Extension UI bridge/View and is cleared on Session invalidation. No contribution mutates `PindieState`, `PindieUiProjection`, or semantic Timeline. Unsupported paths throw `UnsupportedExtensionUICapabilityError`; none silently no-op.

### Slice G — Human Signal and Owned-TUI Experiment Conclusion

Slice G established Human Signal behavior and evaluated whether Pindie should own the interactive terminal layer. G1 and G2a are completed experiment history; G2b concluded with an architecture decision, and G2c is cancelled / not proceeding:

```text
G1 — Human Signal Policy
     completed

G2a — Pre-dogfood Readiness
      completed

G2b — Real Dogfood
      concluded with architecture decision:
      do not proceed to owned-TUI cutover

G2c — Cutover
      cancelled / not proceeding
```

Real dogfood changed the architecture decision. This is not an implementation-failure pause; the expected benefit of owning the full interaction layer did not justify its complexity and usability cost.

#### G1 — Human Signal Policy (implemented and merged)

Local and remote behavior now consume one transport-independent Human Signal Policy. A running blocked Task remains recoverable work; Discord attention for settled-blocked is classified only at the final settlement boundary after successor decisions.

G1 introduces one pure, renderer/transport-independent policy boundary.

Conceptually:

```text
Authoritative semantic facts
  + Pi runtime/settlement facts
  + autonomous-successor outcome
        ↓
Human Signal Policy
        ↓
  ┌───────────────┬──────────────────────┐
  ↓               ↓                      ↓
Local hard     Local soft           External
Attention      human signal         attention edge
```

The policy owns classification only. It does not own semantic State, Session lifecycle, Discord transport, or TUI interaction state.

A useful implementation shape is conceptually:

```ts
type HumanSignalKind =
  | "human-gate"
  | "authority-unavailable"
  | "settled-blocked"
  | "completed"
  | "stopped";

interface HumanSignalDecision {
  key: string;
  kind: HumanSignalKind;
  summary: string;
  detail?: readonly string[];
  local: "none" | "soft" | "hard";
  external: "none" | "attention";
}
```

Exact names may differ. The required property is that both local and external projections consume the same classification result rather than re-implementing status tests independently.

##### G1 fact ownership

The policy may read:

- semantic authority from the existing Run/Semantic Snapshot path;
- Task status, Human Gate, blockers, and completion truth from existing Pindie semantic State/derivation;
- native running/settled/pending-message facts from Pi runtime;
- settlement outcome from the existing `core.settleAgentRun()` path;
- whether an automatic successor was actually committed;
- quota-successor scheduling result;
- current Session/run generation for stale-settlement suppression.

It must not infer facts from rendered text, Discord messages, or Timeline prose.

It must not persist a second Task status or Human Gate.

##### G1 policy table

| Reality | Local | External |
| --- | --- | --- |
| normal working | none | none |
| blocker while Agent is still running/recovering | none | none |
| Human Gate | hard | attention |
| semantic authority unavailable | hard | attention |
| Run settled, Task still blocked, no Human Gate, no pending work, no committed automatic successor | soft | attention |
| quota wait with successful auto-resume scheduled | none | none |
| successful Long Task/session rollover | none | none |
| Task completed and settlement is current | no modal | attention |
| Run stopped with Task still active and no automatic successor | no modal | attention |

`blocked` by itself is never enough to summon the human.

The canonical blocked rule is:

```text
Task blocked
+
Agent Run still active
        ↓
autonomous recovery
        ↓
NO human signal

Task blocked
+
Run settled
+
same current Session/run
+
no Human Gate
+
no pending message
+
no committed automatic successor
        ↓
SETTLED BLOCKED
        ↓
soft local signal + external attention
```

##### G1 local projection

Hard local signals are:

- Human Gate;
- semantic authority unavailable.

They continue to own the Attention input surface and ordinary Composer work remains fail-closed.

Settled-blocked is intentionally soft. It must be prominent, but the human needs the Composer in order to provide the missing information or new direction.

Do not model soft settled-blocked by pretending it is a Human Gate.

A valid UI shape is:

```text
┌ Blocked ─────────────────────────────────────────────────────┐
│ Could not continue without staging credentials.              │
│ Missing access to STAGING_DATABASE_URL.                      │
└──────────────────────────────────────────────────────────────┘

> _
```

The exact projection shape may be a separate Human Signal field or an Attention variant with explicit soft semantics. What is forbidden is preserving the current invariant that every non-null `projection.attention` disables ordinary Composer input and then inserting settled-blocked into it without changing that invariant.

The TUI must derive the visible blocker summary from structured blockers, not from a Discord message string.

##### G1 external projection

External notification remains edge-triggered.

Discord transport receives a classified Human Signal and performs delivery/deduplication; Discord must not independently decide that `taskStatus === "blocked"` means attention.

Remove the current immediate rule equivalent to:

```ts
if (taskStatus === "blocked")
  remote.milestone(..., { attention: true })
```

Human Gate and authority-unavailable may emit as soon as the durable/current condition exists.

Settled-blocked, completed, and stopped must be emitted only from a current settlement boundary after autonomous-successor decisions are known.

Current settlement guards remain mandatory:

- Session identity still matches;
- run/lifecycle generation still matches;
- no new Agent Run has started;
- no pending Pi message appeared;
- Remote Session lease is still current.

##### G1 completion and stopped

Completion and stopped remain external call-back signals, not local confirmation modals.

Existing truths remain:

```text
Run stopped != Task failed
Run stopped != Task blocked
Run stopped != Task completed
```

A completed Task emits one current-settlement external attention edge.

A stopped signal is emitted only when the Task remains active after settlement and neither an ordinary automatic successor nor quota successor was committed.

Do not send `stopped` for settled-blocked; those are distinct Human Signal kinds.

##### G1 runtime permission boundary

Runtime permission / Extension dialogs remain separate from semantic Human Signal State.

The existing generic Pi `ui_prompt_start/ui_prompt_end` signal is not sufficient to synthesize a transport-independent Discord permission alert because it also covers locally initiated Extension dialogs such as model/reasoning UI.

G1 therefore does not manufacture an external permission notification from generic `ui_prompt_start`.

Local runtime permission remains a strong Extension interaction above semantic Attention. A future transport-neutral permission event may be added separately if Pi exposes enough identity and intent.

##### G1 deduplication and persistence

Persistent local signals are re-derived from current Reality.

External signals use runtime-only edge deduplication keyed by stable Human Signal identity and current Session/run generation.

Do not add:

- read/unread state to Pindie semantic State;
- acknowledged flags to Task;
- a notification database;
- Discord delivery truth to semantic State.

Session replacement invalidates old runtime delivery leases.

##### G1 acceptance

G1 is complete when tests prove at minimum:

1. running blocked Task → no local soft signal and no external attention;
2. same Task settles blocked with no successor → exactly one soft local signal and one external attention edge;
3. Human Gate → hard local Attention + external attention;
4. authority unavailable → hard local Attention + external attention;
5. completed → Timeline completion remains, no local modal, one current-settlement external attention edge;
6. stopped active Task with no successor → no local modal, one external attention edge;
7. successful quota successor suppresses stopped/blocked attention;
8. successful automatic rollover/successor suppresses stopped/blocked attention;
9. stale/replaced settlement cannot notify the new Session;
10. repeated status refreshes do not duplicate an already-delivered external Human Signal.

Do not change the TUI default in G1.

#### G2a — Pre-dogfood Readiness (completed experiment history)

G2a-A bounded chrome and G2a-B bounded Timeline density were completed as readiness work before the real dogfood. The requirements below document that historical scope; they are not a continuing cutover gate.

##### G2a-A — Bounded Chrome

The first VS Code → SSH → tmux → `PINDIE_TUI=1` launch exposed that an unnamed Session can use the first real user message as its display identity. `PiRuntimeAdapter.getActiveSessionDisplayIdentity()` then returned that fallback without a display-length bound; `formatHeader()` placed the full value in persistent chrome. A long Prompt could therefore wrap the Header to dozens of rows and displace the Timeline and Composer. G2a-A addressed this observed failure as part of the experiment.

Acceptance contract:

- Header is persistent chrome, targets one physical row, and contains only bounded human-facing Session identity, model id, and thinking level.
- Apply an explicit Session-display-identity cap at the presentation boundary (at most 48 Unicode grapheme clusters including the truncation marker); do not mutate the Session name, transcript, or picker identity to achieve it.
- Clamp/ellipsis the final assembled Header at the actual terminal display width. A fixed character cap alone is insufficient; long model ids and narrow terminal widths must not wrap the Header.
- Remove duplicate project/Pindie identity, provider, Task status, and coherent/stale authority from persistent Header content. Authority-unavailable remains prominent hard Attention in its existing input-owning surface.
- Remove permanent Timeline and Composer headings. Empty Timeline remains blank; do not add a placeholder.
- Normal Footer is one width-clamped row, with Command Palette as the ordinary shortcut-discovery surface and contextual hints only for special focus/Attention. No permanent `Status` / `Hints` labels or standing `Alt+M` / `Alt+N` / `Alt+H` list.
- Preserve the existing Action Registry, Attention/soft-signal distinctions, Extension UI ownership and additions, and Pi Editor behavior. Necessary active Extension/runtime actions may add contextual rows without changing the bounded normal-idle baseline.

##### G2a-B — Bounded Timeline Density

The Projection may retain complete projected history, but ordinary Timeline rendering must never turn one large routine block into an unbounded viewport occupant. Compact, Preview, and Full have distinct purposes and Preview has both character and physical-row bounds as specified in §5.1.

Acceptance contract:

- User Prompt / Steer / Follow-up blocks default to Compact with role, available delivery provenance, and bounded first meaningful content; long prompts do not default to full text.
- Streaming assistant content uses bounded Preview. Completed assistant content also defaults to bounded Preview (not Full); errors retain bounded diagnostic Preview. Full is available only by explicit expand/inspect/copy.
- Running Observation groups render one aggregate summary plus the current/latest useful operation, not one row per item. Complete groups compact to the aggregate; failed groups retain bounded diagnosis, with more projected detail available through explicit Full inspection.
- Running Tool / Command output keeps its existing bounded stdout/stderr tail; successful commands remain compact; failures preserve bounded diagnosis; Full viewer can inspect the available projected detail.
- Do not apply routine-noise compression to Human Gate, Completion, or another meaningful semantic outcome merely for visual uniformity. Semantic importance outranks tool-noise density.

#### G2b — Real Dogfood (concluded)

Real dogfood was performed on the actual deployment path:

```text
VS Code → SSH → tmux → PINDIE_TUI=1 → PindieInteractiveMode
```

Automated tests cannot prove upstream key delivery, Chinese IME, terminal resize quality, tmux detach/reattach, or sustained usability. The intended G2b dogfood checklist was:

- Prompt / Steer / Follow-up;
- Abort and queue restoration;
- Timeline navigation, fold, inspect, and copy;
- Command Palette;
- Model and Session picker;
- `/reasoning` Extension dialog;
- Human Gate options and free-form response;
- authority-unavailable fail-closed Attention;
- settled-blocked soft signal;
- completed/stopped Remote attention;
- quota wait/resume;
- Chinese IME;
- multiline input and paste;
- terminal resize and narrow terminal width;
- tmux detach/reattach;
- Session replacement/rebind.

The experiment was concluded before every checklist item was exercised. The observed usability evidence was already sufficient to reject cutover, so the remaining items are historical unexecuted coverage rather than active work.

**Outcome:** The first real dogfood exposed unbounded Header identity, unbounded Timeline density, and persistent chrome hierarchy issues. Those were subsequently addressed through G2a work and the Header/Footer zoning fix. A second real dogfood round still showed substantial day-to-day friction, interaction/rendering rough edges, and an overall experience materially worse than Pi InteractiveMode; the user did not want to continue using the owned TUI. The full static audit also made clear that this shell owns a broad terminal lifecycle surface—IME, paste, focus, resize, tmux, overlays, and Session replacement—that require real lifecycle validation.

The conclusion is that further investment would primarily recreate mature terminal interaction infrastructure rather than strengthen Pindie's differentiated Agent capabilities. The experiment ends here; the remaining audit checklist is not an active fix backlog or a prerequisite for cutover.

#### G2c — No Cutover Decision (cancelled / not proceeding)

The production selection remains:

```text
default       → Pi InteractiveMode
PINDIE_TUI=1  → frozen experimental PindieInteractiveMode
```

There is no plan to change the default, remove Pi fallback, complete the old G2b checklist as a cutover gate, or add tests/features for cutover. Owned TUI code remains in the repository as experimental output; it is frozen, not an active product path. If a future Pi upgrade makes its maintenance burden concrete, removal may be proposed as a separate cleanup rather than extending the compatibility work.

#### Re-entry rule

Reconsider owned/custom UI work only when all of the following hold:

1. Daily use of Pi InteractiveMode repeatedly exposes a specific, stable problem.
2. That problem materially affects a core Pindie Agent workflow.
3. A small incremental Pi extension/runtime integration cannot solve it.
4. The expected benefit of taking on more interaction ownership clearly exceeds its maintenance cost.

Otherwise, prefer Pi UI plus minimal Pindie integration. Do not start another full-TUI roadmap merely to pursue an idealized Agent-native UI.

## 14. Experiment testing record

The owned-TUI experiment used the following testing principles; they are historical contracts, not active cutover gates.

Prefer:

```text
authoritative facts/events
        ↓
pure projection tests
        ↓
action resolution tests
        ↓
view/render snapshot tests where useful
        ↓
small terminal integration tests
        ↓
manual dogfood in VS Code → SSH → tmux
```

Do not rely primarily on terminal screenshots. Replace old existence-only assertions for permanent `Timeline`, `Composer`, `Status`, or `Hints` chrome with assertions for bounded normal rendering and preserved interaction behavior.

### G2a usability acceptance (historical)

Before dogfood, the readiness work required focused projection/view tests to prove the following:

1. A 1,000+ character Session fallback identity cannot make the Header taller than one physical row; it is presentation-bounded and visibly truncated.
2. At narrow terminal widths, Header and normal Footer remain bounded single rows, are clamped to available display width, and do not consume the Composer's reserved space. Normal idle chrome has no permanent Timeline/Composer heading, no `Status` / `Hints` labels, and an empty Timeline has no placeholder.
3. A 1,000+ character user Prompt defaults to Compact and does not fill the Timeline viewport; role and available delivery provenance remain identifiable.
4. Streaming assistant output remains within both Preview character and rendered-row bounds as successive updates grow.
5. A completed assistant message with dozens of lines is not automatically rendered in Full or left permanently expanded.
6. A large running Observation burst (for example, 100+ items) has bounded physical height independent of item count, retains an aggregate summary for the burst, and shows the current/latest useful operation.
7. Explicit Full expansion / inspect still exposes the complete projected message or available projected work detail; copy continues to use Full.
8. Density cleanup does not change Human Signal or Extension UI semantics: authority-unavailable remains hard/fail-closed, settled-blocked remains soft with an editable Composer, Human Gate persistence/input ownership remains intact, and Extension dialogs/contributions retain their existing ownership and priority.
9. Pi Editor ownership is unchanged: Chinese IME, multiline input, paste, and draft behavior continue to work without a Pindie text-editor replacement.
10. Timeline next/previous navigation, fold, selection visibility, and per-Block line-range bookkeeping remain correct after removing the Timeline heading, including after wrapped Preview changes and fold toggles.

These were experiment acceptance invariants, not permission to redesign adjacent interaction behavior. G2a changed presentation density only; it did not change the Action Registry, Human Signal policy, Extension semantics, Session/Model picker behavior, or Editor ownership.

At minimum preserve coverage for:

- Session replacement/rebinding;
- Prompt vs Steer vs Follow-up delivery;
- Abort and queue restoration;
- Human Gate persistence;
- quota waiting;
- Long Task rollover;
- completed/stopped lifecycle;
- Remote/Discord correctness;
- semantic authority unavailable;
- tool streaming and failure;
- narrow terminal widths;
- keyboard delivery through the real VS Code/SSH/tmux environment.

## 15. Architectural invariants

1. Pindie TUI is a projection/client, not semantic authority.
2. Pi remains the sole low-level Agent Loop and Session implementation.
3. Pindie Host remains the active AgentSessionRuntime owner.
4. Pindie State remains the only durable current Task authority.
5. UI Projection is disposable and rebuildable.
6. UI-local state is limited to interaction concerns such as focus, selection, scroll, fold, draft, and overlay.
7. Timeline is structured human-meaningful history, not raw tool/runtime logging.
8. Routine success recedes; failure, risk, and meaningful outcomes remain visible.
9. Internal model chain of thought is not a Pindie Timeline surface.
10. Attention means human cognition is required; it is not another name for Task status.
11. Local Attention and external notification are separate projections of one Human Signal Policy.
12. A blocked Task may continue autonomous recovery; blocked does not by itself summon the human.
13. Successful quota resume and Session rollover are silent continuity mechanisms.
14. Human Gate remains semantic and persistent until resolved.
15. Runtime permission remains separate from Human Gate even if both use the same visual region.
16. All keyboard dispatch, palette actions, hints, and help derive from one Action Registry.
17. Pindie defaults must respect the real VS Code → SSH → tmux keyboard path.
18. `@earendil-works/pi-tui` is infrastructure, not product ownership.
19. Pindie must not deep-import Pi InteractiveMode private implementation.
20. The owned-TUI experiment ended without cutover; Pi InteractiveMode remains the production interaction shell.
21. Normal persistent chrome is bounded: Header is one width-clamped row with only Session identity/model id/thinking level, and normal Footer is one width-clamped row.
22. Full projected history remains inspectable, while routine Message and running Observation previews have explicit character and physical-row bounds.
23. Density cleanup preserves semantic Human Signal, Extension UI, Pi Editor, and Timeline navigation/fold ownership.
