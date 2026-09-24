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

## 10. Project creation is deliberately deferred

Real dogfood also exposed a likely future need:

```text
pindie_create_project
```

but it is **not part of Slice A**.

First prove:

```text
Pindie ↔ Modeloom
```

project discovery and switching using real existing projects.

Only after that dogfood should v0.2 add bounded creation.

The future creation operation should create exactly one direct workspace child directory and then open it. It must not also scaffold frameworks, run git init, write README/AGENTS, or perform coding setup; those are normal Pindie user intents after entering the project.

## 11. Security contract

Workspace support must not reintroduce the RDC filesystem trust model.

Explicit non-capabilities remain:

- no arbitrary path listing;
- no caller-supplied absolute paths;
- no recursive filesystem browsing;
- no generic mkdir in Slice A;
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

## 16. Follow-up only after dogfood

After Slice A is merged and real switching works, evaluate one follow-up:

```text
pindie_create_project
```

Do not add it before list/open has been exercised in real ChatGPT Control use.