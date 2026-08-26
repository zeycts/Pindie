# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie carries one development task from intent to verified completion while keeping consequential human judgment explicit. Pi remains responsible for the low-level model/tool agent loop; Pindie adds a minimal semantic operating layer above it.

## Core ownership

```text
Human  → goals, taste, consequential judgment, approval
Model  → interpretation, planning, semantic choice
Pindie → durable semantic State, legality, capability, verification, lifecycle
Pi     → LLM execution, tools, sessions, low-level agent loop
```

Pindie's v0.2 design principle is simple:

> Eliminate meaningless choices, preserve meaningful choices.

Authoritative facts that uniquely determine legality should be closed by the Harness. Choices that genuinely require understanding user intent or project meaning remain model-owned.

## v0.2 architecture

```text
Reality
  ↓
Persistent State + Run Facts
  ↓
Semantic Snapshot
  ↓
Capabilities
  ├─ Knowledge Surface
  ├─ Tool Surface
  └─ Execution Authorization
          ↓
         LLM
          ↓
   Execution Gateway
          ↓
       Reducer
          ↓
          Pi
          ↓
       Reality
```

The semantic layer is deliberately small and pure. It is not a second Agent Loop or workflow engine.

See:

- `docs/architecture.md` — approved target v0.2 architecture;
- `docs/behavior.md` — approved semantic/behavioral contract;
- `AGENTS.md` — repository instructions and migration authority.

## Migration status

The repository has a working v0.1 Runtime baseline and is migrating incrementally to the v0.2 architecture.

Migration sequence:

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — next
M2 Semantic Gateway Cutover
M3 Model Tool Surface
M4 Policy Reduction
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M0 established pure `Run Facts → Semantic Snapshot → Capabilities` derivation without changing Runtime behavior. M1 adds a pure Tool Effect Model and capability-authorization layer, still without changing the live `tool_call` path. M2 is the first intentional runtime semantic cutover: real Agent-run facts are adapted into the semantic model and live execution authorization begins consuming the v0.2 capability truth.

This staging avoids maintaining two competing semantic rule systems. Target capability semantics may intentionally differ from legacy v0.1 Guard/tool affordances until M2 moves that live responsibility onto v0.2.

## Current implemented baseline

The repository already includes:

- minimal persistent current-Task State;
- deterministic State reducer and invariants;
- project-scoped Runtime persistence and conflict handling;
- v0.2 Semantic Foundation (`SemanticRunFacts`, `SemanticSnapshot`, capability derivation);
- current legacy `pindie_state`, `pindie_gate`, and `pindie_git_observe` model-facing tools;
- verification invalidation from known/observed project mutation;
- Human Gate lifecycle;
- runtime-only Current Activity, Run Timer, Run Cost, status presentation, and adaptive reasoning;
- `/efficiency` inspection;
- bundled `git-workflow` Skill through Pi's Skill runtime.

Some model-facing/runtime mechanisms are intentionally legacy v0.1 shapes that later v0.2 milestones will reshape. Target semantics in the v0.2 docs should not be redesigned back toward those legacy shapes merely to match current implementation.

## Development

Requires Node.js 22.19+.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run check
```

Load the local extension using the Pi version pinned by this repository's package dependencies:

```bash
pi -e ./src/extension.ts
```

The package scripts are package-manager agnostic; pnpm is the recommended package manager for Pindie.