# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie carries one development task from intent to verified completion while keeping consequential human judgment explicit. Pi remains responsible for the low-level model/tool Agent Loop; Pindie adds a minimal semantic operating layer above it.

## Core ownership

```text
Human  → goals, taste, consequential judgment, approval
Model  → interpretation, planning, semantic choice, verification meaning/coverage
Pindie → durable semantic State, legality, capability, factual evidence/freshness, lifecycle
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

- `docs/architecture.md` — target v0.2 architecture;
- `docs/behavior.md` — semantic/behavioral contract;
- `AGENTS.md` — repository instructions and milestone authority.

## Migration status

```text
M0 Semantic Foundation              — implemented
M1 Execution Semantics Foundation   — implemented
M2 Semantic Gateway Cutover         — implemented
M3 Model Tool Surface               — implemented
M4 Policy Reduction                 — implemented
M5 Verification v0.2                — implemented
M6 Continuation Simplification      — next
M7 Skill / Docs Prune
M8 Extension Composition
```

M0–M4 established one semantic truth for legality, aligned model-visible tools with that truth, cut the live Gateway over to it, and removed the duplicated global Core Policy/system-prompt override. Runtime Context is factual Knowledge Surface derived from the same Semantic Snapshot that drives capabilities.

M5 moved durable verification evidence provenance/freshness into the Harness without changing the persisted `VerificationCheck` schema. Actual tool results become temporary current-Run evidence candidates; the model selects factual refs and still owns semantic pass/fail and criterion coverage; Pindie materializes selected bounded factual evidence into the existing durable `evidence` string.

M6 simplifies continuation. Deterministic eligibility comes from the current Semantic Snapshot plus Pi runtime facts; only the genuinely semantic question — whether the latest actual user intent still calls for consequential execution — remains a one-shot hidden model probe. Historical continuation probes must not accumulate in future model context.

## Current implemented baseline

The repository includes:

- minimal persistent current-Task State;
- deterministic reducer and State invariants;
- project-scoped Runtime persistence, refresh, locking, and conflict handling;
- `SemanticRunFacts → SemanticSnapshot → Capabilities`;
- shared Tool Effect classification and capability authorization;
- live Semantic Gateway authorization;
- runtime-only Agent Run facts and stale/unavailable authority handling;
- Project Mutation Freshness using the shared Tool Effect model;
- narrow model-facing semantic tools:
  - `pindie_task_start`
  - `pindie_task_replace`
  - `pindie_task_refine`
  - `pindie_task_progress`
  - `pindie_verification_record`
  - `pindie_task_complete`
  - `pindie_gate_open`
  - `pindie_gate_resolve`
  - `pindie_git_observe`;
- capability-driven active Tool Surface narrowing over a fresh per-Run Pi/user baseline;
- factual Snapshot-aligned Runtime Context with no global Pindie lifecycle-policy prompt;
- Harness-owned runtime verification evidence refs/freshness with bounded durable materialization;
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