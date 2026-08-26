# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie carries one development task from intent to verified completion while keeping consequential human judgment explicit. Pi remains responsible for the low-level model/tool Agent Loop; Pindie adds a minimal semantic operating layer above it.

## Core ownership

```text
Human  → goals, taste, consequential judgment, approval
Model  → interpretation, planning, semantic choice
Pindie → durable semantic State, legality, capability, verification, lifecycle
Pi     → LLM execution, tool registry/execution, sessions, low-level Agent Loop
```

> Eliminate meaningless choices, preserve meaningful choices.

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

The semantic layer is deliberately small and is not a second Agent Loop or workflow engine.

See:

- `docs/architecture.md` — approved target v0.2 architecture;
- `docs/behavior.md` — approved semantic/behavioral contract;
- `AGENTS.md` — repository instructions and milestone authority.

## Migration status

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — next
M4 Policy Reduction
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M0 established `Run Facts → Semantic Snapshot → Capabilities`. M1 established shared Tool Effect classification and capability authorization. M2 connected those layers to the live Runtime, so capability truth now authorizes real tool execution and Project Mutation Freshness consumes the same Tool Effect classification.

M3 aligns model-visible affordances with that already-live legality model. It replaces the broad `pindie_state` / `pindie_gate` action enums with narrow semantic tools and dynamically narrows Pi's active Tool Surface from a fresh per-Run Pi/user baseline. Pindie may remove baseline tools when current capabilities do not permit them, but it must never re-enable a tool that Pi/user had disabled.

Pindie is currently pinned to Pi v0.84.3. Its active-tool API is replacement-style and has no composable overlay/change event, so M3 uses a Run-scoped baseline and restores it when the Run settles. M4 then removes/restructures redundant Core Policy injection so Pi's system-prompt text can fully track mid-Run dynamic Tool Surface changes.

## Current implemented baseline

The repository includes:

- minimal persistent current-Task State;
- deterministic reducer and State invariants;
- project-scoped Runtime persistence, refresh, locking, and conflict handling;
- v0.2 Semantic Foundation (`SemanticRunFacts`, `SemanticSnapshot`, capabilities);
- v0.2 Execution Semantics (Tool Effect classification and authorization);
- live Semantic Gateway authorization through M0/M1 truth;
- runtime-only Agent Run facts and stale/unavailable authority handling;
- Project Mutation Freshness using the shared Tool Effect model;
- current transitional broad `pindie_state` / `pindie_gate` tools plus `pindie_git_observe`;
- Human Gate lifecycle and verification freshness;
- runtime-only Activity, Run Timer, Run Cost, status presentation, adaptive reasoning, and `/efficiency`;
- bundled `git-workflow` Skill through Pi's Skill runtime.

## Development

Requires Node.js 22.19+.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run check
```

Load the local extension using the Pi version pinned by this repository:

```bash
pi -e ./src/extension.ts
```

The package scripts are package-manager agnostic; pnpm is the recommended package manager for Pindie.