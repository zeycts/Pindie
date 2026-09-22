# Pindie TUI v0.1 — Architecture and Implementation Contract

Status: Slices A–E, F1, F2a, and F2b1 are implemented; F2b2 is next and G remains intentionally deferred.

Baseline: Pindie main after Pi 0.86.1 compatibility upgrade.

This document is the source of truth for Pindie's first owned Agent-native terminal UI. Implementation Slices must follow this contract unless a reviewed architecture change updates this document first.

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

TUI ownership becomes:

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

## 2. Target topology

The current production topology is:

```text
Pindie Host
   └─ Pi InteractiveMode
          ↓
      Pi AgentSessionRuntime
```

The target topology is:

```text
Pindie Host
   └─ PindieInteractiveMode
          │
          ├─ Projection / Views ─────────→ @earendil-works/pi-tui
          │
          ├─ Attention / Extension UI ──→ @earendil-works/pi-tui
          │
          └─ Action Dispatcher
                    ↓
             PiRuntimeAdapter
                    ↓
             Pi AgentSessionRuntime
                    ↓
             Agent Loop / Models / Tools / Skills
```

This is an ownership inversion at the interaction layer only.

Pi remains responsible for the active AgentSession, low-level execution, concrete tools, compaction, retries, steer/follow-up queues, and model/provider plumbing.

## 3. Screen anatomy

v0.1 has only four permanent screen regions:

```text
┌──────────────────────────────────────────────────────────────┐
│ Header                                                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Timeline                                                     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Composer / Attention                                         │
├──────────────────────────────────────────────────────────────┤
│ Status                                                       │
└──────────────────────────────────────────────────────────────┘
```

Overlay is transient and sits above the Timeline.

Do not add permanent sidebars, task panels, files panels, agent panels, queue panels, or tabs in v0.1.

### Header

Header answers: **where am I?**

Example:

```text
 Pindie · pindie                              Sol · High
 feat/notifications                         Task · active
```

It may contain:

- project/workspace identity;
- Git branch;
- model;
- reasoning level/mode;
- Task lifecycle.

It must not become a second status line for cost, elapsed time, quota, verification detail, or live activity.

### Timeline

Timeline answers:

> what happened, what is happening, and what matters?

It is a structured projection, not a raw ANSI transcript.

### Composer / Attention

Normal state shows the Composer.

When a hard human interaction is active, the same region becomes an Attention surface. Human Gate and runtime permission are allowed to own input; ordinary blocked/completed/stopped states are not.

### Status

Status contains ambient runtime information only, for example:

```text
running · 2m 31s · $0.08                  verify 2/3 · 5h 62%
```

Human Gate, verification failure, and blocker explanation must not be hidden only in the footer.

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
Header / Timeline / Status / Attention
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

Blocks support:

```text
Compact  → enough to know what happened, usually 1–2 lines
Preview  → enough to judge whether work is normal
Full     → explicit inspection detail
```

Default lifecycle policy:

```text
start
  ↓
Preview
  │
  ├─ routine success → Compact
  └─ failure         → Preview / Full
```

Manual expansion pins the user's choice. Automatic policy must not immediately undo an explicit human expand/collapse decision.

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

### 5.4 Edit

Mutations preserve identity.

Success may compact to:

```text
✓ Edited src/remote-notice.ts             +54 -11
```

Do not collapse the working history into a generic `Edited 8 files` group. Completion may summarize total changed files separately.

### 5.5 Command

Streaming stdout/stderr must not continuously grow the physical Timeline.

While running, use a bounded preview/tail. On successful completion, compact. On failure, preserve enough error context for diagnosis and allow explicit deep inspection.

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
Header                      fixed
Timeline / ScrollView       grow
Composer / Attention        fixed
Status                      fixed
```

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

## 12. Migration strategy

Migration must stay runnable and reversible after every PR.

Temporary topology:

```text
Pindie Host
   ├─ Pi InteractiveMode       ← stable fallback
   └─ PindieInteractiveMode    ← feature-gated while dogfooding
```

Use a temporary runtime gate such as:

```text
PINDIE_TUI=1
```

until the owned TUI has survived real dogfooding.

Do not combine initial TUI implementation with removal of Pi InteractiveMode.

After the new TUI is behaviorally complete:

```text
default  → PindieInteractiveMode
fallback → Pi InteractiveMode
```

Only remove the fallback after a separate stability period.

## 13. Implementation Slices

Implementation should proceed in this order.

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
- Status facts;
- Attention projection.

Tests should operate on plain data.

### Slice D — TUI Shell (implemented / feature-gated dogfood shell)

Introduce feature-gated `PindieInteractiveMode` using `TuiAltScreen`.

Minimum dogfoodable shell:

- Header;
- Timeline;
- Composer;
- Status;
- real Prompt / Steer / Follow-up / Abort;
- Session rebind correctness.

Implemented behind `PINDIE_TUI=1`; the default Pi `InteractiveMode` remains the fallback.
Semantic Attention interaction lands in Slice F2a. The full Extension UI compatibility surface remains in F2b.
Do not implement every advanced Block/Overlay before first dogfood.

### Slice E — Semantic Timeline (implemented)

Implementation status:

- E1 Work Timeline — implemented
- E2 Pindie Semantic Timeline — implemented

Implemented:

- stable live block identity;
- observation grouping;
- Edit/Command blocks;
- bounded streaming previews;
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

### Slice F2 — Attention and Extension UI (implementation in progress)

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

#### F2b — Extension UI + Pickers (implementation in progress)

##### F2b1 — Extension Interaction Bridge (implemented)

The owned TUI now binds a Session-scoped `ExtensionUIContext` and all six `ExtensionCommandContextActions`. Extension dialogs are ephemeral UI overlays, serialize behind one bridge-local queue, and are cancelled with their queued successors before Session invalidation. They never become Human Gates or semantic Timeline events. The active input priority is `Extension overlay → semantic Attention → Timeline → Composer → Global`.

Implemented `ExtensionUIContext` capabilities:

- `select`, `confirm`, `input`, and multiline `editor`, including cancel, `AbortSignal`, timeout, and overlay cleanup;
- `notify` with info/warning/error severity;
- `onTerminalInput` with consume/transform behavior below modal and semantic input ownership;
- keyed `setStatus` contributions rendered as a bounded secondary status;
- `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, and `setHiddenThinkingLabel` as UI-local ambient presentation;
- `pasteToEditor`, `setEditorText`, and `getEditorText` against the ordinary Composer;
- `setTitle` against the active terminal.

The command-context mapping is exact: `waitForIdle → AgentSession.waitForIdle`, `newSession → AgentSessionRuntime.newSession`, `fork → AgentSessionRuntime.fork`, `navigateTree → AgentSession.navigateTree`, `switchSession → AgentSessionRuntime.switchSession`, and `reload → AgentSession.reload`. Session-replacing actions rely exclusively on the existing runtime `beforeSessionInvalidate` / `rebindSession` lifecycle.

Explicitly deferred to F2b2 (each currently throws `UnsupportedExtensionUICapabilityError`; none is silently accepted):

- `setWidget`, `setFooter`, and `setHeader`;
- `custom`;
- `addAutocompleteProvider`, `setEditorComponent`, and `getEditorComponent`;
- `theme`, `getAllThemes`, `getTheme`, and `setTheme`;
- `getToolsExpanded` and `setToolsExpanded`.

##### F2b2 — UI Contributions + Pickers (next)

Implement:

- widget/header/footer and custom UI compatibility;
- theme, custom editor, autocomplete, and tools-expanded compatibility;
- model/session picker and their `Alt+M`/`Alt+N` bindings.

### Slice G — Human Signal Unification and Cutover

Unify local Attention and Discord notification decisions under one Human Signal Policy.

In particular, replace immediate `blocked → external attention` behavior with settled-blocked semantics.

After dogfood and compatibility closure, make PindieInteractiveMode the default and retain Pi InteractiveMode as temporary fallback.

## 14. Testing contract

The TUI work must be testable below the terminal level.

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

Do not rely primarily on terminal screenshots.

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
20. Migration stays reversible until the new TUI has been dogfooded and compatibility-closed.
