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

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — next
M3 Model Tool Surface
M4 Policy Reduction
M5 Verification v0.2
M6 Continuation Simplification
M7 Skill / Docs Prune
M8 Extension Composition
```

M0 established `Run Facts → Semantic Snapshot → Capabilities`. M1 established concrete Tool Effect classification and pure capability authorization. Neither changed the live `tool_call` path.

M2 is the first intentional runtime cutover. It adapts real Agent-run facts into the semantic model and makes the existing capability truth the live execution authority. The cutover also makes Project Mutation Freshness consume the same Tool Effect classification instead of a separate tool-name taxonomy.

The M2 Run Facts design stays runtime-only: use run-start Task/Gate identity only as a coherent-run immutable-State change detector, plus the minimum additional fact needed to remember that a Task was introduced by successful start/replacement during the Run. No Task ID or workflow phase is added to persistent State.

## Current implemented baseline

The repository already includes:

- minimal persistent current-Task State;
- deterministic State reducer and invariants;
- project-scoped Runtime persistence and conflict handling;
- v0.2 Semantic Foundation (`SemanticRunFacts`, `SemanticSnapshot`, capability derivation);
- v0.2 Execution Semantics Foundation (Tool Effect classification and pure authorization);
- current legacy `pindie_state`, `pindie_gate`, and `pindie_git_observe` model-facing tools;
- verification invalidation from known/observed project mutation;
- Human Gate lifecycle;
- runtime-only Current Activity, Run Timer, Run Cost, status presentation, and adaptive reasoning;
- `/efficiency` inspection;
- bundled `git-workflow` Skill through Pi's Skill runtime.

Until M2 is implemented, the live Agent still uses the legacy v0.1 semantic Guard path even though target semantic/execution truth already exists in pure modules. M3 later aligns model-visible tools with the live legality model.

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