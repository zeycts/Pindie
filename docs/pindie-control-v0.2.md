# Pindie Control v0.2 — Workspace + Single Active Project

## 1. Why v0.2 exists

Pindie Control v0.1 successfully proved the end-to-end control path:

```text
ChatGPT
→ Personal MCP App
→ OpenAI Secure MCP Tunnel
→ private loopback Pindie MCP
→ PindieControlClient
→ Pi AgentSession
→ Pindie runtime
```

The first real multi-project dogfood exposed the next concrete limitation: the long-lived Control service is currently booted with one fixed `PINDIE_PROJECT_ROOT`, so ChatGPT can control only that project.

Real use begins one level earlier:

```text
user intent
→ choose an existing project OR create a new project
→ enter that project
→ then observe/configure/input/respond/stop/etc.
```

v0.2 adds that missing workspace-selection layer without turning Pindie into a multi-agent daemon.

## 2. Core decision

v0.2 supports:

```text
multiple discoverable projects
+
exactly zero or one active Pindie Host
```

It does **not** support multiple simultaneously active project Hosts.

Conceptually:

```text
Pindie Control Service
│
├── Workspace Root
│   └── /home/dev/projects
│       ├── Pindie
│       ├── Modeloom
│       └── ...
│
└── Active Project Slot
    └── none | one { PindieHost + PindieControlClient }
```

The workspace layer owns only project discovery and active-Host replacement.

It must not create:

- a second Agent Loop;
- a multi-agent scheduler;
- a project workflow engine;
- a second Task system;
- a second Session truth;
- persistent remote-control state;
- a background project queue.

Pi Session remains conversation truth for the active project. PindieState remains semantic truth for the active project.

## 3. Startup model

Replace the fixed-project startup contract:

```text
PINDIE_PROJECT_ROOT=/home/dev/projects/Pindie
```

with:

```text
PINDIE_WORKSPACE_ROOT=/home/dev/projects
```

On service boot:

```text
MCP server       running
Tunnel           running
workspace root   available
active project   none
Pindie Host      none
Control lease    none
```

The service must not silently choose a project.

The first project-scoped write/read workflow begins only after an explicit project open.

## 4. Workspace boundary

The workspace root is configured at process startup and is not caller-controlled.

v0.2 project discovery is intentionally narrow:

- enumerate direct child directories only;
- do not accept arbitrary filesystem paths from MCP callers;
- do not recursively scan;
- do not expose generic directory listing;
- do not follow a project symlink outside the workspace root;
- reject path traversal and absolute-path inputs;
- project identity is the direct child directory name.

A valid existing project must resolve to a real directory whose resolved parent is the resolved workspace root.

The workspace layer is a bounded project selector, not a filesystem API.

## 5. Transport-independent workspace manager

Introduce one narrow internal owner, conceptually:

```text
PindieControlWorkspace
```

It sits above `PindieControlClient`:

```text
Pindie Control MCP
        ↓
PindieControlWorkspace
        ↓
Active Project Slot
        ├── PindieHost
        └── PindieControlClient
              ↓
        PiRuntimeAdapter
```

The MCP adapter remains a schema/transport adapter.

Workspace/project lifecycle legality must live in the transport-independent workspace layer, not in MCP handlers.

The manager owns only:

- configured workspace root;
- project discovery;
- active project identity;
- active Host/ControlClient lifetime;
- serialized project replacement.

It must not persist active-project state in v0.2.

## 6. Project discovery

### 6.1 list projects

The workspace manager exposes a read-only operation conceptually:

```text
listProjects()
```

It returns a bounded projection such as:

```ts
interface PindieProjectList {
  workspaceRoot: string;
  activeProject: string | null;
  projects: readonly {
    name: string;
    active: boolean;
  }[];
}
```

Only direct child directories that pass the workspace-boundary checks are returned.

Ordering should be deterministic.

No file contents, nested paths, repository metadata, git state, or arbitrary filesystem facts are part of this operation.

## 7. Open project

The workspace manager exposes an explicit project replacement operation conceptually:

```text
openProject(name)
```

### 7.1 No active project

When no project is active:

```text
validate project name/path
→ create PindieHost(cwd = project root)
→ create PindieControlClient
→ bind headless Pi extensions
→ expose new active project + Control lease
```

If Host/Control bootstrap fails, the active project remains `none`.

### 7.2 Already active project

Opening the already-active project is idempotent and returns the current active-project/control projection without recreating the Host.

### 7.3 Switching projects

Switching from project A to project B is explicit and fail-closed.

Before disposing A, require:

- runtime idle;
- automatic work settled;
- pending message count = 0;
- no current Human Gate;
- no active quota-resume waiting state.

An explicit project switch may leave a durable active/blocked Task in project A because that Task belongs to project-local PindieState and can be revisited later. The Control layer must not mark it done, mutate it, or invent abandonment semantics.

If the current project is not safe to switch, return a stable workspace-level error such as:

```text
project_switch_unsafe
```

The caller may explicitly stop current work first when appropriate.

### 7.4 Replacement ordering

Pindie's Host currently owns process-global bridges, so v0.2 must not keep two live Hosts concurrently merely to implement atomic switching.

Use this bounded sequence:

```text
validate target
→ validate current project is safe to leave
→ dispose current ControlClient + Host
→ active project becomes none
→ create target Host
→ bind ControlClient
→ publish target as active
```

If target startup fails, fail closed with no active project.

Do not silently restore/reopen the previous project as hidden recovery behavior.

## 8. No-active-project state

Existing project-scoped Control operations must have a well-defined state when no project is active.

### 8.1 observe

`pindie_observe` should remain useful before project selection.

It should return a bounded workspace-aware union:

```text
state = no_active_project
workspaceRoot
activeProject = null
```

or, when active:

```text
state = active_project
workspaceRoot
activeProject
control = existing PindieControlSnapshot
```

Exact wire shape is an implementation detail, but it must be explicit and machine-readable.

### 8.2 project-scoped write tools

When there is no active project, these operations fail closed:

- `pindie_input`
- `pindie_respond`
- `pindie_stop`
- `pindie_fresh_session`
- `pindie_configure`

Use a stable error such as:

```text
no_active_project
```

Do not auto-open a default project.

## 9. MCP surface for Slice A

Keep the v0.1 six tools and add exactly two project-selection tools:

```text
pindie_observe
pindie_input
pindie_respond
pindie_stop
pindie_fresh_session
pindie_configure

pindie_list_projects
pindie_open_project
```

### pindie_list_projects

Read-only.

No caller-supplied path.

Returns only workspace-root direct projects and the current active project.

### pindie_open_project

Write / consequential.

Input:

```text
project: string
```

The project is a workspace child name, not a path.

The server owns validation and safe Host replacement.

## 10. Slice B — bounded project creation

Slice A has now been real-dogfood validated through:

```text
no active project
→ list projects
→ open Modeloom
→ observe Modeloom
→ safe switch to Pindie
→ observe Pindie
```

The next proven need is creation of a brand-new workspace project before normal Pindie work begins.

Add one bounded workspace operation:

```text
createProject(name)
```

and one MCP tool:

```text
pindie_create_project
```

This is **not** a generic filesystem API.

### 10.1 Input and boundary

Input is exactly one project name:

```text
project: string
```

Use the same direct-child name validation as `openProject`:

- no absolute paths;
- no `.` or `..`;
- no slash/backslash separators;
- no NUL;
- no caller-supplied parent/path;
- target is always derived as one direct child beneath the configured workspace root.

If any filesystem entry already exists at that direct-child name, fail with a stable error such as:

```text
project_exists
```

Do not overwrite, reuse, delete, or reinterpret an existing file/directory/symlink.

### 10.2 Semantics

Successful creation means exactly:

```text
create one empty direct-child directory
→ open that project using the existing single-active-project lifecycle
→ return active-project/control projection
```

It must **not** also:

- run `git init`;
- create README/AGENTS/package files;
- scaffold Next.js/React/Node/etc.;
- install dependencies;
- copy a template;
- execute shell commands;
- write project contents.

Those are ordinary development intents delivered later through `pindie_input`.

### 10.3 Safe-switch ordering

Because creation also opens the new project, creation from an existing active project must first prove the current slot is safe to leave using the same Slice A conditions:

- idle;
- automatic work settled;
- pending messages = 0;
- no Human Gate;
- no quota-resume waiting state.

If unsafe:

```text
project_switch_unsafe
```

and **no directory is created**.

After safety validation:

```text
validate name
→ verify target absent
→ create empty direct-child directory
→ dispose old ControlClient + Host if present
→ active slot = none
→ bootstrap new Host + ControlClient
→ publish new active project
```

Creation/open remains serialized by the existing workspace serialization boundary.

### 10.4 Failure after mkdir

Directory creation is the only filesystem mutation owned by this operation.

If mkdir succeeds but Host/Control bootstrap later fails:

- active project remains `none`;
- return a structured `project_open_failed`/equivalent error;
- **leave the newly created directory in place**;
- do not recursively delete it as automatic rollback;
- a later explicit `pindie_open_project` may retry opening it.

This avoids turning failure recovery into a destructive filesystem operation.

### 10.5 MCP metadata

`pindie_create_project` is:

- write;
- non-destructive;
- closed-world;
- not read-only.

It must not be marked as a generic filesystem or shell tool.

## 11. Security contract

Workspace support must not reintroduce the RDC filesystem trust model.

Explicit non-capabilities remain:

- no arbitrary path listing;
- no caller-supplied absolute paths;
- no recursive filesystem browsing;
- no generic mkdir; only the bounded `pindie_create_project` direct-child creation operation;
- no generic read/write file;
- no shell;
- no tmux;
- no arbitrary git operations;
- no direct Task mutation;
- no direct Pi tool invocation.

All project names are resolved server-side beneath the fixed workspace root.

Symlink/path traversal escape must fail closed.

## 12. Concurrency

Project open/switch operations must be serialized.

Two concurrent open requests must not create two Hosts or interleave disposal/bootstrap.

v0.2 may use an in-process mutex/promise serialization primitive.

This synchronization is runtime bookkeeping only; it is not a persisted project scheduler.

All existing project-scoped operations must resolve against one stable active slot.

A project replacement invalidates the outgoing Control lease naturally by disposing the old `PindieControlClient`.

## 13. Process and systemd migration

The long-lived service remains one process and one loopback MCP endpoint.

Systemd changes from:

```text
Environment=PINDIE_PROJECT_ROOT=/home/dev/projects/Pindie
```

to:

```text
Environment=PINDIE_WORKSPACE_ROOT=/home/dev/projects
```

The service still owns one loopback HTTP MCP server, and Secure MCP Tunnel remains unchanged.

Do not restart Tunnel merely because the active project changes.

## 14. Slice A required tests

At minimum:

### Workspace discovery

- configured workspace root must exist and be a directory;
- direct project directories are listed deterministically;
- nested directories are not independently listed;
- symlinks escaping workspace root are excluded/rejected;
- arbitrary path input is impossible at the API boundary.

### Startup / no active project

- process starts successfully with workspace root and no Host;
- MCP discovery works without active project;
- observe returns explicit no-active-project state;
- project-scoped writes fail with `no_active_project`;
- no InteractiveMode/TUI is created before project open.

### Open first project

- opening an existing project creates exactly one Host;
- headless extension bootstrap completes before the project becomes active;
- the resulting project root/control snapshot is correct;
- opening the same project again is idempotent.

### Safe switch

- idle + settled + no pending + no Gate + no quota wait allows switch;
- busy/streaming rejects;
- unsettled rejects;
- pending messages reject;
- Human Gate rejects;
- quota waiting rejects;
- unsafe rejection does not dispose the active Host.

### Replacement / failure

- successful switch disposes old ControlClient + Host exactly once;
- old lease becomes stale;
- target bootstrap failure leaves no active project;
- no two live Hosts overlap in the replacement path;
- concurrent open requests are serialized.

### MCP

- exactly eight tools are registered for Slice A;
- list_projects is read-only;
- open_project is write/consequential;
- no shell/filesystem/path-generic tools appear.

## 15. Slice A Definition of Done

```text
✓ Control service boots with workspace root and no active project
✓ ChatGPT can list Pindie and Modeloom without filesystem access
✓ ChatGPT can explicitly open Pindie
✓ ChatGPT can explicitly switch Pindie → Modeloom at a safe boundary
✓ switching never creates two live Hosts
✓ unsafe switch fails closed
✓ target startup failure leaves no active project rather than partial authority
✓ existing six project-scoped tools continue to work after project open
✓ Control leases remain lifecycle-scoped
✓ MCP endpoint/Tunnel do not restart when project changes
✓ no multi-agent scheduler/project queue/persistent active-project state exists
✓ full pnpm run check is green
✓ real ChatGPT dogfood switches between existing projects successfully
```

## 16. Slice B required tests

At minimum:

### Create from no active project

- valid new name creates exactly one direct-child directory;
- no extra files are written;
- new project is opened and becomes active;
- resulting project root/control snapshot is correct;
- list_projects includes the new project as active.

### Name/existence safety

- absolute path, traversal, separators, NUL, `.`, and `..` fail closed;
- existing directory returns `project_exists`;
- existing file returns `project_exists`;
- existing symlink returns `project_exists`;
- no existing entry is modified or removed.

### Create while another project is active

- safe current project allows create+switch;
- busy/streaming rejects before mkdir;
- unsettled rejects before mkdir;
- pending messages reject before mkdir;
- Human Gate rejects before mkdir;
- quota waiting rejects before mkdir;
- unsafe rejection leaves active Host and filesystem unchanged.

### Failure isolation

- mkdir failure returns a structured create error and keeps the current safe Host active when disposal has not started;
- after mkdir succeeds, old Host is disposed before new Host construction so Hosts never overlap;
- target bootstrap failure leaves no active project and leaves the new directory intact;
- concurrent create/open requests remain serialized.

### MCP

- exactly nine tools are registered after Slice B;
- `pindie_create_project` accepts only `project`;
- annotations are write + non-destructive + closed-world;
- no generic path/mkdir/file/shell tools appear.

## 17. Slice B Definition of Done

```text
✓ ChatGPT can create one new direct-child project by name
✓ create automatically opens the new project
✓ creation writes only the directory itself
✓ existing paths are never overwritten/reused
✓ unsafe active-project state prevents mkdir
✓ bootstrap failure leaves the new directory but no partial active authority
✓ existing list/open and six project-scoped tools remain unchanged
✓ total MCP tool surface = 9
✓ no shell/filesystem API is introduced
✓ no git/scaffold/template behavior is hidden inside create_project
✓ full pnpm run check is green
✓ real ChatGPT dogfood creates and enters a disposable new project successfully
```

## 18. After Slice B

Do not add additional project-management tools merely for symmetry.

Further workspace capabilities must be driven by real dogfood failures or explicit product needs.


## 19. Slice C — Session Discovery & Switch

Real dogfood now proves that project selection alone is not enough. ChatGPT must also be able to select the correct persisted Pi Session inside the active project before continuing work.

Slice C adds exactly two project-scoped tools:

```text
pindie_list_sessions
pindie_switch_session
```

After Slice C the MCP surface contains 11 tools.

### 19.1 Session authority

Pi remains the sole Session authority.

Pindie Control must reuse the existing native runtime seams:

```text
PiRuntimeAdapter.getActiveProjectSessionChoices()
PiRuntimeAdapter.switchActiveSession(...)
```

Do not introduce a second Session registry, copied Session metadata store, or synthetic conversation identity. Session lifecycle/control logic belongs to `PindieControlClient` and the existing `PiRuntimeAdapter` seams, not `PindieControlWorkspace`; the Workspace continues to own only project/Host selection and serializes calls through `withClient(...)`.

### 19.2 pindie_list_sessions

Read-only and project-scoped.

If no project is active, return the existing structured `no_active_project` error.

Accept only `offset` (integer ≥ 0, default 0) and `limit` (integer 1–50, default 20). Return a bounded page sorted by modified time descending and then Session ID ascending:

```text
total
offset
limit
hasMore
```

Return a bounded projection of Sessions belonging to the active project's native Pi Session directory:

```text
activeSessionId

sessions:
  - id
  - name/display identity when available
  - created
  - modified
  - messageCount
  - firstMessage preview
  - current
```

The underlying Session file path is internal routing data and must **never** appear in a public result, MCP structured content, error details, or user-visible output. Normalize whitespace and bound display names and first-message previews.

Do not expose arbitrary Session directories or caller-provided paths. Listing is read-only and does not require a Control lease.

### 19.3 pindie_switch_session

Write/consequential and project-scoped.

Input:

```text
lease
sessionId
```

The caller supplies a native Session ID, never a path.

On every call:

```text
validate current Control lease
→ enumerate current project's native Session choices
→ resolve sessionId only against this fresh current-project choice list
→ reject missing/ambiguous IDs
→ if already current, return the current snapshot without native replacement or lease rotation
→ otherwise verify safe Session-replacement boundary
→ native switchSession(path)
→ existing beforeSessionInvalidate lifecycle
→ existing headless bindExtensions/session_start lifecycle
→ publish fresh Control binding/lease
```

Never trust a stale cached Session path.

### 19.4 Safe Session switch

Require:

- runtime idle;
- automatic work settled;
- pending messages = 0;
- no current Human Gate;
- no quota-resume waiting state.

If unsafe, fail closed with a stable error such as:

```text
session_switch_unsafe
```

Do not use semantic Task status as a switch prohibition. A durable project Task may legitimately span multiple Pi Sessions.

Switching to the already-active Session is idempotent and is checked before the safe-replacement conditions, so it remains legal while runtime activity is busy:

- no native replacement;
- no new lease;
- return the current snapshot.

A real Session replacement must invalidate the old lease and expose a new lease only after extension bootstrap and Control projection succeed.

### 19.5 Failure behavior

Use structured Session-specific errors: `session_not_found`, `session_ambiguous`, `session_switch_unsafe`, and `session_switch_failed`. If native Pi `switchSession` reports cancellation, preserve/revalidate the old binding and lease. If native switch/bootstrap fails after invalidation, remain fail-closed with no partially authorized binding or synthetic lease. Do not silently switch to another Session.

Do not add Session delete, rename, fork, or tree-navigation tools in Slice C.

### 19.6 Slice C tests

At minimum:

- list returns only active-project native Sessions;
- no Session file paths are exposed;
- no-active-project fails closed;
- current Session is correctly marked;
- switch accepts Session ID only;
- unknown/stale Session ID fails;
- busy/unsettled/pending/Human Gate/quota wait reject before replacement;
- active durable Task does not by itself block switching;
- same-Session switch is idempotent and preserves lease;
- real switch rotates lease;
- old lease becomes stale;
- extension bootstrap completes before new lease publication;
- switch/bootstrap failure leaves no partially authorized binding;
- total MCP surface = 11;
- no fork/delete/rename/tree/path-generic Session tools appear.

## 20. Slice D — Live Work Observation

Real ChatGPT-driven work exposed a second problem: when the Control Host owns the running Pi AgentSession, opening the same persisted Session in another Pi TUI process only shows the persisted snapshot at resume time. It is not a live observer of the Control Host.

The desired model is:

```text
one runtime owner
+
multiple read-only observers
```

Do not solve this by having a second Pi AgentSession repeatedly reload the same Session file.

Slice D is split into two parts.

### 20.1 Slice D1 — Control-side live observation

D1 adds two read-only Control tools:

```text
pindie_read_timeline
pindie_wait
```

These two tools are a pair:

- `read_timeline` removes the black-box view of what Pindie has actually been doing;
- `wait` lets ChatGPT remain in the orchestration loop without requiring the human to watch Pindie and send “继续”.

After D1 the MCP surface contains 13 tools.

### 20.2 pindie_read_timeline

Read-only and project/Session scoped.

It must expose only the existing **human-visible Pindie UI projection**, never raw Session storage.

Authoritative source is one disposable `PindieUiProjection` retained by `PindieControlClient` for each Session epoch:

```text
Session bind/bootstrap succeeds
→ rebuildProjection(native branch + current facts)
→ one existing AgentSession subscription
→ reduceProjectionEvent + refreshProjectionFacts
→ bounded current timeline tail
```

Explicit observation refreshes current facts while preserving live timeline blocks. Session replacement discards the old projection and rebuilds after the new extension `session_start`; no lease is published before that bootstrap and initial projection succeed. Control deliveries append through the existing `appendUserDelivery` helper until native persistence reconciles them. This projection is runtime-only and is not a second event store.

The result may contain human-visible projected blocks such as:

- user/assistant visible text;
- projected tool/work blocks;
- projected tool results;
- semantic Task/verification blocks;
- projected runtime blocks when available.

It must never expose:

- assistant hidden reasoning/thinking;
- hidden custom messages;
- raw Session JSONL;
- arbitrary Session file paths;
- raw extension/runtime secrets;
- content intentionally filtered out by the UI projection.

The initial implementation should favor a bounded current tail over inventing a second persistent event store.

Conceptual input:

```text
limit?: integer
```

with default 20 and maximum 50. The result returns only the current tail of the existing human-visible `UiTimelineBlock` projection and sets `hasMoreBefore` when earlier in-memory blocks exist. There is no historical cursor or raw Session/storage exposure.

Conceptual result:

```text
sessionId
revision
timeline: [...human-visible projected blocks...]
hasMoreBefore
```

The exact pagination cursor may be added only if required by real dogfood. Do not persist a duplicate timeline database.

### 20.3 pindie_wait

Read-only, project/Session scoped, and bounded-duration.

Purpose:

```text
observe snapshot
→ submit/steer work
→ wait for a meaningful runtime/control boundary
→ inspect timeline/snapshot
→ continue automatically or return to human
```

Conceptual input:

```text
lease
afterRevision
until: meaningful_change | settled | human_gate
timeoutSeconds?
```

Timeout defaults to 20 seconds, has a 30-second maximum, and is a normal result, not a protocol error. `settled` requires all of: runtime idle, automatic work settled, zero pending messages, and no quota wait; Task completion is not required. A current Human Gate interrupts every wait mode, and Session binding replacement interrupts with `binding_changed`.

Wait is event-driven over the one existing ControlClient AgentSession subscription; it does not poll, persist wait state, or create per-wait subscriptions. Workspace captures the active client inside its serialization boundary and waits after releasing that boundary so project replacement/stop are not blocked by a long observation.

Conceptual result:

```text
reason: changed | settled | human_gate | timeout | binding_changed
snapshot
```

Semantics:

- `meaningful_change`: return after Control revision advances beyond `afterRevision`;
- `settled`: return once automatic work is settled at a safe idle boundary;
- `human_gate`: return once a current Human Gate exists;
- if the Session/lease changes while waiting, return `binding_changed` with the current safe snapshot when available;
- on timeout, refresh once and return the current snapshot.

Waiting must subscribe to the existing live Control/AgentSession lifecycle. Do not create a second polling daemon or persist wait state.

A wait call must never hold or create semantic authority. It is observation only.

### 20.4 Meaningful revision boundary

D1 may extend Control's observation bookkeeping so that human-visible timeline changes can wake `pindie_wait(until=meaningful_change)`.

Do not use high-frequency activity-only churn as the primary wake boundary.

A meaningful change includes, at minimum:

- a new visible assistant episode and assistant completion/error (not each streaming token);
- projected work start and completion/failure (not partial tool-result updates);
- Task/verification/Human-Gate visible state/lifecycle change;
- Agent Run start/settle;
- Session binding replacement and other existing Control snapshot semantic/runtime changes.

Activity-only churn is excluded. The fingerprint and waiter bookkeeping are disposable in-memory state, not a second durable event log.

### 20.5 D1 orchestration goal

The target ChatGPT loop is:

```text
pindie_input
→ pindie_wait
→ pindie_read_timeline
→ inspect current snapshot
→ if ordinary continuation is clear, continue through Pindie Control
→ if Human Gate or real judgment is required, return to user
```

This is specifically intended to eliminate the human pattern:

```text
watch Pindie
→ guess it may be done
→ send “继续”
```

### 20.6 Slice D2 — Local read-only monitor

D1 has now been real-dogfood validated: ChatGPT can submit a task, wait across repeated bounded timeouts, inspect the live timeline, continue waiting, and return only after the runtime is truly settled without requiring the human to monitor Pindie or send “继续”.

D2 adds a local read-only observer for the same Control Host:

\`\`\`text
pnpm control:watch
\`\`\`

The monitor is not another Pindie runtime. It is a loopback MCP client over the already-running Control service.

Target ownership:

\`\`\`text
                         OpenAI Secure Tunnel
                               ↑
                         ChatGPT Control
                               │
                   ┌───────────┴───────────┐
                   │ Pindie Control Host   │
                   │ single runtime owner  │
                   │ 127.0.0.1:8765/mcp   │
                   └───────────┬───────────┘
                               │
                          loopback MCP
                               │
                     pnpm control:watch
                               │
                      read-only monitor
\`\`\`

The invariant remains:

\`\`\`text
one runtime owner
+
multiple read-only observers
\`\`\`

#### 20.6.1 Process boundary

The monitor MUST NOT:

- create \`PindieControlWorkspace\`;
- create \`PindieHost\`;
- create/resume/switch a Pi AgentSession directly;
- read Session JSONL or native Session paths;
- subscribe directly to Pi runtime events;
- call filesystem/shell/Git APIs;
- call any write/consequential Pindie Control tool;
- own or restart the Control service.

It connects only to the existing loopback MCP endpoint:

\`\`\`text
http://127.0.0.1:\${PINDIE_CONTROL_PORT ?? 8765}/mcp
\`\`\`

D2 v0.1 does not accept an arbitrary remote MCP URL.

The Control MCP tool surface remains exactly 13 tools. D2 adds no server protocol capability.

#### 20.6.2 Narrow monitor client

Introduce a transport adapter conceptually:

\`\`\`text
PindieControlMonitorClient
\`\`\`

Its public capability surface is limited to:

\`\`\`text
observe()
readTimeline(limit?)
wait(...)
close()
\`\`\`

It must not expose a generic \`callTool(name, args)\` method to monitor orchestration/view code.

At startup the transport may use MCP \`listTools\` only for compatibility verification. Require these tools:

\`\`\`text
pindie_observe
pindie_read_timeline
pindie_wait
\`\`\`

and verify that each is advertised as read-only, non-destructive, and closed-world.

If the required read-only surface is unavailable or incorrectly annotated, fail closed with a clear incompatible-service message. Do not fall back to private endpoints or write tools.

#### 20.6.3 View boundary

D2 uses a dedicated read-only monitor view with neutral timeline/text rendering helpers, not an interactive shell with empty callbacks.

The monitor view contains only:

\`\`\`text
Header
Timeline
Footer/status
\`\`\`

There is no composer, attention editor, model/session picker, abort action, extension dialog, or mutation command.

Reuse existing renderer-independent presentation semantics wherever practical. In particular, the current \`formatBlock(UiTimelineBlock)\` formatting should remain the canonical textual representation instead of duplicating message/work/semantic formatting rules.

A large refactor of the existing TUI is not required merely to make D2 aesthetically pure. Extract only a narrow shared formatter/component seam if the real import graph requires it.

#### 20.6.4 Attach and observation loop

Startup:

\`\`\`text
connect loopback MCP
→ verify read-only capabilities
→ pindie_observe
\`\`\`

If no project is active:

\`\`\`text
state = no_active_project
\`\`\`

render a waiting state. Because there is no Control lease, bounded bootstrap observation may re-run \`pindie_observe\` approximately once per second until an active project appears. This is the only intended polling fallback and it does not inspect Pi/Session storage.

When a project is active:

\`\`\`text
observe
→ obtain lease + revision
→ read_timeline(limit = 50)
→ render
→ wait(meaningful_change, afterRevision = revision)
\`\`\`

The monitor's normal observation loop is driven by \`pindie_wait\`, not generic interval polling.

#### 20.6.5 Streaming sampling

D1 deliberately suppresses revision churn for assistant token streaming, partial tool-result updates, and activity-only changes.

The monitor still needs visually useful streaming progress.

Therefore, while the current snapshot is running/not idle:

\`\`\`text
wait meaningful_change with a short bounded timeout (~2s)
\`\`\`

- on \`changed\`: refresh timeline immediately;
- on \`timeout\` while still running: sample \`read_timeline(50)\` once to show the latest streaming text/tool output;
- continue waiting.

While safely idle, use the normal longer Control wait timeout (up to the D1 server maximum) and do not re-read the timeline on idle timeout.

This gives immediate lifecycle updates while sampling token-level progress at low frequency.

Do not create a separate streaming protocol, WebSocket/SSE endpoint, or per-token MCP wake mechanism in D2.

#### 20.6.6 Project/Session replacement

A project or Session replacement invalidates the old Control binding and wakes the old wait with:

\`\`\`text
binding_changed
\`\`\`

The monitor must then:

\`\`\`text
observe workspace again
→ obtain the new active project/binding when present
→ read current timeline
→ reset local monitor epoch/view state
→ resume wait
\`\`\`

Project and Session switching therefore require no monitor restart.

#### 20.6.7 Human Gate behavior

Because every D1 wait mode is interrupted by a current Human Gate, repeatedly calling \`pindie_wait\` while a Gate remains open would create an immediate-return busy loop.

When a wait returns \`human_gate\`:

- render the Gate prominently;
- remain read-only;
- do not call \`pindie_respond\`;
- enter a temporary bounded observation mode (for example, \`pindie_observe\` about once per second) until the Gate is resolved or the binding changes;
- then return to the normal wait loop.

The monitor should tell the user to respond through ChatGPT / Pindie Control rather than implying the local monitor can answer.

#### 20.6.8 Connection loss and restart

The monitor must treat the Control service as independently restartable infrastructure.

On transport closure, connection refusal, or MCP call failure:

- show a disconnected/reconnecting state;
- close/discard the failed transport;
- retry connection with bounded exponential backoff, conceptually:
  \`250ms → 500ms → 1s → 2s → 5s max\`;
- after reconnect, repeat capability verification, observe, and timeline attach.

The monitor must never invoke \`systemctl\`, spawn \`control:mcp\`, restart Pindie, or otherwise self-heal the server.

#### 20.6.9 Exit semantics

\`Ctrl+C\` and an optional local \`q\` gesture mean only:

\`\`\`text
cancel/close outstanding monitor request
→ close MCP client/transport
→ stop monitor TUI
→ restore terminal
→ exit
\`\`\`

They MUST NOT:

- call \`pindie_stop\`;
- abort the Agent;
- clear native queues;
- dispose the Pindie Host;
- mutate the current project or Session.

Closing the observer must have zero effect on Pindie execution.

#### 20.6.10 Local interaction scope

D2 v0.1 may provide only read-only navigation:

- \`j/k\` or arrow keys for timeline scroll;
- PageUp/PageDown;
- End or \`G\` to return to the live tail;
- \`q\` / Ctrl+C to exit.

Do not add a composer, Session/project picker, model picker, Human Gate response, stop button, or other Control action.

The monitor is a window into Control, not a second Control surface.

#### 20.6.11 Rendering

Use the existing \`@earendil-works/pi-tui\` primitives and terminal diff rendering rather than repeatedly printing/clearing the full timeline.

Maintain a small monitor view model and update Header/Timeline/Footer components in place.

The first D2 implementation may show only the bounded tail already returned by D1:

\`\`\`text
pindie_read_timeline(limit = 50)
\`\`\`

If earlier content exists, indicate that older timeline blocks are omitted. Do not add a historical timeline cursor, archive reader, or durable monitor event database in D2.

#### 20.6.12 D2 implementation shape

Prefer a small explicit structure:

\`\`\`text
src/control-watch.ts
src/control-monitor-client.ts
src/control-monitor-view.ts
\`\`\`

and:

\`\`\`json
"control:watch": "node --experimental-strip-types src/control-watch.ts"
\`\`\`

Equivalent names are acceptable if the ownership remains the same.

No systemd unit is required for the monitor. It is an on-demand local client.

#### 20.6.13 D2 required tests

At minimum:

**Transport/security**
- monitor endpoint is loopback-only;
- startup verifies the three required read-only MCP tools;
- incompatible/mis-annotated tool surface fails closed;
- orchestration/view code cannot issue generic MCP tool names;
- no write/consequential tool is invoked.

**Attach lifecycle**
- no active project renders waiting state;
- active project loads initial snapshot + timeline;
- meaningful change refreshes timeline immediately;
- running timeout samples streaming timeline;
- idle timeout avoids unnecessary timeline reads;
- project replacement auto-reattaches after \`binding_changed\`;
- Session replacement auto-reattaches after \`binding_changed\`;
- Human Gate does not create a tight immediate-wait loop.

**Coexistence**
- ChatGPT waiter and monitor waiter can coexist;
- monitor creates no Pi AgentSession/runtime subscription;
- a monitor wait does not block project or Session replacement.

**Resilience**
- transport failure renders disconnected state;
- reconnect uses bounded backoff;
- successful reconnect repeats capability check + attach.

**Terminal**
- Ctrl+C/\`q\` exits only the monitor;
- no \`pindie_stop\` or mutation tool is called on exit;
- terminal/view is cleaned up;
- manual scroll is preserved across updates;
- End/\`G\` restores follow-tail.

### 20.7 Slice D2 Definition of Done

\`\`\`text
✓ pnpm control:watch connects only to loopback Pindie Control
✓ no second Host/AgentSession/Session reader is created
✓ current project + Session + human-visible timeline are visible
✓ meaningful lifecycle changes render immediately
✓ streaming progress becomes visible within the short sampling window
✓ idle monitor has low request overhead
✓ project/Session replacement auto-reattaches
✓ Human Gate is visible but cannot be answered locally
✓ Control service restart auto-reconnects
✓ Ctrl+C/q closes only the monitor and does not affect Agent execution
✓ bounded timeline tail uses existing presentation formatting
✓ MCP Control surface remains exactly 13 tools
✓ no new server protocol/systemd/Tunnel change is required
✓ full pnpm run check is green
✓ real dogfood watches a ChatGPT-controlled task without opening/resuming Pi TUI
\`\`\`

## 21. Slice D1 required tests

At minimum:

### Timeline safety

- returns current human-visible projected timeline;
- hidden reasoning/thinking is absent;
- hidden custom messages are absent;
- raw Session file path/storage is absent;
- result is server-bounded;
- no-active-project fails closed.

### Live projection

- assistant streaming/complete lifecycle is reflected;
- visible tool call/result lifecycle changes are reflected;
- semantic Task/verification/Human Gate changes are reflected;
- activity-only churn does not create unbounded wake noise.

### Wait

- meaningful_change waits until revision advances and requires `afterRevision`;
- settled returns immediately when already safely settled using the full idle/settled/empty-queue/no-quota definition;
- settled waits through a running Agent Run and returns on settle;
- human_gate waits until a Gate appears;
- timeout returns normally with current snapshot;
- Session replacement returns binding_changed/stale-safe result;
- disposal releases all waiters;
- multiple waiters do not create multiple Agent owners or subscriptions that mutate runtime.

### MCP

- D1 adds exactly two read-only closed-world tools;
- total MCP surface = 13;
- wait has a server-side timeout cap;
- no raw log/file/session-path API is introduced.

## 22. Implementation order

Proceed strictly:

```text
Slice C
Session discovery + switch
↓ real dogfood

Slice D1
read-only live timeline + pindie_wait
↓ real dogfood

Slice D2
local read-only control:watch monitor
↓ real dogfood
```

Further observability/control features must be driven by real failures after these slices.
