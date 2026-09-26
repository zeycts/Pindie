# Pindie Control v0.1

## 1. Purpose

Pindie Control v0.1 makes the existing Host-owned Pindie runtime safely controllable by an external client such as ChatGPT without exposing a general shell, filesystem API, tmux automation, or a second Agent/Task system.

The target interaction is:

```text
Human
  ↓
ChatGPT
  ↓
MCP adapter
  ↓
Pindie Control Client
  ↓
existing Pindie Host / PiRuntimeAdapter
  ↓
same Pi AgentSession + same Pindie semantic runtime
```

The control path is a new client of the existing runtime. It is not a new runtime.

The first target transport is a private MCP server reached through OpenAI Secure MCP Tunnel. Transport is not semantic ownership and must remain replaceable.

## 2. Existing ownership remains authoritative

Pindie Control does not change the current ownership model:

```text
Human        → goals, consequential judgment, approval
ChatGPT      → external reasoning/orchestration client
Pindie Host  → process lifecycle and active AgentSessionRuntime ownership
Pi           → AgentSession, model execution, native queues, prompt/steer/followUp,
               low-level Agent Loop, tools, Skills, compaction
Pindie       → durable semantic State, capabilities, Gateway, verification,
               Human Gate semantics
Reality      → reconstructable facts
```

Conversation truth remains the native Pi Session. Semantic truth remains `PindieState`.

Pindie Control must not create:

- a Control Task;
- a Control Session identity separate from the active Pi Session;
- a second Agent Loop;
- a second message queue;
- a second semantic State;
- a persistent event database;
- a workflow/phase engine.

## 3. Evidence from the implemented system

The design is derived from existing Pindie behavior rather than an abstract remote-control API.

### 3.1 Host-owned runtime

`createPindieHost()` already creates and owns a `PiRuntimeAdapter` before the interactive client runs. The TUI is a client of that Host-owned runtime rather than its owner.

### 3.2 Existing runtime control primitives

`PiRuntimeAdapter` already provides the required native primitives:

```text
prompt / steer / followUp
abort / clear queue
active Session facts
Session event subscription / wait-for-idle
fresh Session replacement
model and thinking-level read/write
Session history projection
```

Pindie Control must reuse these primitives rather than automate the TUI.

### 3.3 Existing semantic projection

`PindiePresentationReader` and the renderer-independent `PindieUiProjection` already combine runtime and semantic facts such as:

- project/session identity;
- model and thinking level;
- runtime activity;
- Task/verification status;
- blockers/questions;
- semantic authority;
- Human Gate attention;
- quota waiting.

Control must derive from the same sources instead of recomputing semantic state.

### 3.4 Existing remote-input semantics

The owned TUI and Remote Companion already establish these product semantics:

```text
ordinary input:
  idle → prompt
  busy → steer

explicit after-current-work input:
  idle → prompt
  busy → followUp

stop:
  clear native steer/followUp queue
  → abort current run
```

A Human Gate response is not ordinary input.

### 3.5 Settlement is stronger than idle

`agent_settled` is the final automatic-work boundary. `agent_end` is not final because retries, compaction, quota recovery, continuation, or rollover may still follow.

Control therefore needs an explicit runtime-only `automaticWorkSettled` fact in addition to Pi's current idle/streaming facts.

## 4. Internal control boundary

Introduce one narrow transport-independent client, conceptually:

```text
PindieControlClient
```

It composes existing runtime/projection primitives and owns only disposable control bookkeeping.

Conceptual dependencies:

```text
Pindie Host
├── PiRuntimeAdapter
├── PindiePresentationReader lease
└── PindieControlClient
      ├── ControlProjection
      ├── current control lease
      ├── projection revision
      ├── automaticWorkSettled
      └── Session-scoped event subscription
```

The MCP server should be a thin schema/transport adapter over this client.

Safety and lifecycle semantics belong in `PindieControlClient`, not in the MCP transport.

## 5. Control Projection

The Control Projection is a bounded, control-oriented view over the existing runtime and semantic projections. It must not become another source of truth.

A v0.1 snapshot should expose only information needed to choose the next control action.

Conceptually:

```ts
interface PindieControlSnapshot {
  lease: string;
  revision: number;

  project: {
    root: string | null;
  };

  session: {
    id: string;
    displayIdentity: string;
  };

  runtime: {
    idle: boolean;
    streaming: boolean;
    compacting: boolean;
    pendingMessageCount: number;
    automaticWorkSettled: boolean;
    activity: RunActivity | null;
  };

  semantic: {
    authority: "coherent" | "stale" | "unavailable" | "presentation-unavailable";
    taskStatus: "idle" | "active" | "blocked" | "waiting_human" | "done" | null;
    taskGoal: string | null;
    blockers: readonly string[];
    questions: readonly string[];
    verificationStatus: "pending" | "stale" | "failed" | "passed" | "none" | null;
    verificationProgress: { covered: number; total: number } | null;
    humanGate: {
      key: string;
      kind: "decision" | "approval" | "input";
      question: string;
      options?: readonly string[];
    } | null;
    unavailableReason: string | null;
  };

  executionConfig: {
    model: { provider: string; modelId: string } | null;
    thinkingLevel: AgentSession["thinkingLevel"];
    reasoningMode: "auto" | "manual" | null;
  };

  recovery: {
    quotaWaiting: { sessionId: string; resumeAt: number } | null;
  };

  latestAssistant: (
    | { entryId: string; text: string; lifecycle: "streaming" | "complete" | "error"; source: "assistant" }
    | { entryId: string; text: string; lifecycle: "complete"; source: "task_completion" }
  ) | null;
}
```

The current MCP adapter serializes this bounded internal snapshot under `control` in the active-project observation; it does not reduce or transform nested fields. `project.root`, `executionConfig.model`, `executionConfig.reasoningMode`, `runtime.activity`, `semantic.taskStatus`, `semantic.verificationStatus`, `semantic.verificationProgress`, `semantic.humanGate`, `semantic.unavailableReason`, `recovery.quotaWaiting`, and `latestAssistant` can be null. The no-active-project observation has no `control` field. This is a control contract, not a requirement to serialize the complete TUI projection.

The implemented `latestAssistant` report field selects the latest visible assistant message or successful semantic Task completion in projected timeline order. Its `source` distinguishes `assistant` from `task_completion`; a completion uses the bounded semantic summary and completion block ID with `lifecycle: "complete"`, not a fabricated Pi assistant message. Failed completion blocks are not completion reports. Ordinary assistant replies (including errors) retain their own lifecycle and take precedence when later in the timeline.

The snapshot must not expose hidden reasoning, raw tool results, raw tool-call payloads, credentials, arbitrary files, or complete terminal output.

## 6. Lease and revision

### 6.1 Control lease

Every live binding has an opaque control lease.

A write request must include the current lease. The server rejects a request when the lease is stale.

A lease becomes stale after any lifecycle boundary that can invalidate the control client's assumptions, including:

- native Session replacement;
- reload/rebind;
- Host restart;
- control-client rebind/disposal.

The native Pi Session ID alone is insufficient because lifecycle replacement/reload can invalidate a client while preserving or reusing Session identity.

On stale lease, fail closed and return the current read-only snapshot when available.

### 6.2 Projection revision

Every meaningful control projection change increments a runtime-only revision.

The revision supports efficient observation:

```text
observe(after_revision = N)
→ changed snapshot if revision > N
→ otherwise unchanged / bounded wait
```

Revision is process-local presentation/control bookkeeping. It is never persisted in `PindieState`.

## 7. Control operations

These are internal product operations. MCP tool names are an adapter mapping, not the ownership model.

### 7.1 Observe

Read the current Control Projection.

It may support a bounded wait after a known revision so the caller can wait for a meaningful change without terminal-style polling.

Observation must remain read-only.

### 7.2 Deliver user intent

Deliver a new ordinary user intent to the active Session.

Server-selected native delivery:

```text
idle → prompt
busy → steer
```

The caller does not select prompt versus steer.

If a hard attention state is active, ordinary input fails closed rather than accidentally resolving it.

A requested `after_current_run` timing maps to:

```text
idle → prompt
busy → followUp
```

This remains the same user-intent operation with different delivery timing unless dogfood demonstrates that a separate tool improves safety or clarity.

### 7.3 Respond to Human Gate

A Human Gate response is a separate consequential operation.

The request must identify the current gate using a stable projection key and must include the current control lease.

Before delivery the server must revalidate:

- the control lease is current;
- the same gate is still current;
- the active Session is safely idle;
- semantic authority is suitable for a new user-driven Run.

Any mismatch fails closed.

The response becomes a real Pi user message. Existing Pindie semantics decide whether/how the Gate is resolved.

### 7.4 Stop current work

"Stop" is a product operation, not a raw `abort()` passthrough.

Safe behavior:

```text
validate live lease
→ clear native steer/followUp queues
→ abort active run
→ wait for safe idle/settlement boundary as appropriate
→ return current snapshot
```

If already idle, it is a no-op with an explicit result.

### 7.5 Fresh Session

Create a fresh native Pi Session using Host-owned Session replacement.

This operation exists because real dogfood demonstrated stale Agent Run authority that correctly required a fresh Run/Session before consequential implementation work could continue.

Fresh Session must not:

- bypass semantic authority;
- copy stale run authority;
- mutate `PindieState` directly;
- silently occur as a hidden fallback for a rejected mutation.

The operation returns a new live lease.

### 7.6 Configure execution

Read/write explicit execution configuration only at a safe boundary.

v0.1 candidates:

- active model;
- thinking level.

Mutation requires:

- current lease;
- current Session binding;
- safely idle runtime;
- no unresolved hard attention interaction;
- requested model available in Pi's current model registry.

The control layer does not invent an autonomous model-selection policy in v0.1.

## 8. Candidate MCP surface

After the internal contract passes the architecture spikes, the initial MCP adapter is expected to expose:

```text
pindie_observe
pindie_input
pindie_respond
pindie_stop
pindie_fresh_session
pindie_configure
```

Candidate semantics:

```text
pindie_observe
  read-only current snapshot
  optionally wait after revision for a bounded interval

pindie_input
  ordinary user intent
  timing: now | after_current_run
  server selects prompt / steer / followUp

pindie_respond
  current Human Gate response
  fail closed on stale gate/lease

pindie_stop
  clear queue + abort current work safely

pindie_fresh_session
  explicit native Session replacement

pindie_configure
  safe-idle model/thinking mutation
```

This tool surface is approved as the current v0.1 candidate, not as an implementation constraint. Architecture spikes or subsequent dogfood may remove/merge a tool before MCP implementation.

## 9. Explicit non-capabilities

Pindie Control v0.1 must not expose:

- arbitrary shell execution;
- generic file read/write;
- tmux control;
- arbitrary Git commands;
- arbitrary Pi tool invocation;
- direct `PindieState` mutation;
- direct semantic `task.start/refine/progress/complete` APIs;
- raw hidden reasoning;
- raw tool stdout/stderr streams;
- raw tool-call payload streams;
- GitHub PR/CI/merge operations;
- deployment operations;
- arbitrary historical Session switching;
- Session fork/tree navigation;
- a multi-project runtime manager;
- a multi-agent scheduler.

GitHub delivery/review remains a separate ChatGPT/GitHub integration concern.

## 10. Headless Host mode

Pindie Control must control the Host-owned runtime directly and must not automate `InteractiveMode` or a terminal UI.

The intended v0.1 mode is:

```text
Pindie Host
├── active Pi AgentSessionRuntime
├── existing Pindie extension
└── one Control client
```

The owned TUI and MCP Control client are separate client modes in v0.1.

Do not run both as independent lifecycle clients simultaneously because Pi's active-session client lifecycle currently exposes single callback slots for invalidation/rebind.

If future dogfood requires simultaneous TUI + MCP control, add one explicit Host-level lifecycle multiplexer rather than allowing clients to overwrite each other's callbacks.

## 11. Single-project scope

v0.1 binds one Control Host to one configured project root.

Do not add a project registry, background multi-project daemon, or parallel Host scheduler.

The first dogfood target is the Pindie repository itself.

Multi-project control is considered only after a concrete workflow requires it.

## 12. MCP transport and security

The first transport target is:

```text
ChatGPT
  ↓
Personal MCP App
  ↓
OpenAI Secure MCP Tunnel
  ↓
private pindie-control-mcp
  ↓
PindieControlClient
```

The MCP adapter must remain narrow and must not gain shell/filesystem escape hatches.

Use MCP tool annotations consistently:

- observation is read-only;
- input/respond/configure/fresh-session are writes;
- stop is destructive/consequential.

Host-side validation remains authoritative regardless of client metadata or model behavior.

No public inbound server is required for the private v0.1 tunnel path.

## 13. Architecture Spike A — Headless Host

Before MCP implementation, prove the existing Pindie Host can run correctly without starting an InteractiveMode client.

The focused test/spike must establish:

```text
create Host
→ use Host-owned PiRuntimeAdapter directly
→ deliver a prompt
→ existing Pindie extension receives normal lifecycle
→ Task / Gateway / Verification semantics remain intact
→ agent_settled is observable
→ dispose is clean
```

It must also check that Host-owned quota/rollover supervisors remain functional or explicitly identify which behavior currently depends on an interactive client.

The spike must not add production behavior merely to make the test pass.

## 14. Architecture Spike B — Control Projection

Build a focused internal prototype around existing projection/runtime sources.

The prototype must prove it can derive:

- current Session identity;
- model/thinking level;
- idle/streaming/compacting/pending;
- automatic-work-settled;
- semantic authority;
- Task/verification state;
- Human Gate / authority-unavailable attention;
- quota waiting;
- bounded latest visible assistant output;
- lease invalidation;
- monotonically changing runtime revision.

The spike must not implement MCP, Tunnel configuration, authentication, or persistent control state.

## 15. Required safety tests before MCP

At minimum verify:

### Lease / lifecycle

- current lease authorizes a write;
- Session replacement invalidates the old lease;
- lifecycle rebind/reload invalidates stale client assumptions even when native Session identity is reused;
- Host restart creates a fresh lease;
- stale writes fail closed.

### Input

- ordinary idle input uses prompt;
- ordinary busy input uses steer;
- after-current-run busy input uses followUp;
- hard attention blocks ordinary input;
- Human Gate response is accepted only for the matching current gate while safely idle.

### Stop

- stop clears native queues before/with abort;
- stop cannot accidentally execute queued steer/followUp work afterward;
- idle stop is harmless.

### Configuration

- model/thinking mutation requires safe idle;
- stale lease cannot configure;
- unavailable model is rejected.

### Projection

- hidden reasoning and hidden/custom runtime metadata are absent;
- raw tool results are absent;
- semantic state comes from the existing projection/runtime truth;
- `agent_end` does not claim final settlement;
- `agent_settled` updates automatic-work-settled.

### Failure isolation

- MCP/control projection failure does not corrupt Pindie semantic State;
- failed observation does not grant write authority;
- transport disconnect does not mutate or stop the Agent by itself.

## 16. Implementation sequence

Do not start with the MCP server.

The intended sequence is:

```text
A. Headless Host architecture spike
B. Control Projection / lease / settlement spike
C. Review spike results against this contract
D. Implement PindieControlClient
E. Add focused tests
F. Add thin MCP adapter
G. Connect through Secure MCP Tunnel
H. Dogfood ChatGPT → Pindie on real development work
I. Change the tool surface only when real dogfood exposes a concrete need
```

## 17. Definition of Done for v0.1

Pindie Control v0.1 is complete only when:

```text
✓ ChatGPT can observe one live Pindie Host without terminal scraping
✓ ChatGPT can deliver ordinary intent without choosing prompt vs steer
✓ Human Gate responses use a separate fail-closed path
✓ ChatGPT can stop current work safely
✓ ChatGPT can explicitly obtain a fresh Session after a stale/lifecycle boundary
✓ explicit model/thinking configuration is safe-idle only
✓ meaningful settlement/attention can be observed without raw event/log polling
✓ every write is bound to a current control lease
✓ PindieState remains the only semantic truth
✓ Pi Session remains the only conversation truth
✓ existing Gateway / Task Boundary / Mutation Freshness semantics remain authoritative
✓ no shell/filesystem/tmux escape hatch exists
✓ no second Agent, Task system, Session truth, queue, or event database exists
✓ full repository check remains green
✓ real ChatGPT Control dogfood completes a PR-quality development loop
```
