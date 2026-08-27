# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie carries one development task from intent to verified completion while keeping consequential human judgment explicit. Pi remains the low-level Agent Harness; Pindie adds a small semantic operating layer above it.

## Ownership

```text
Human  → goals, taste, consequential judgment, approval
Model  → interpretation, planning, semantic choice, verification meaning/coverage
Pindie → durable semantic State, legality, capability, factual evidence/freshness, lifecycle
Pi     → LLM execution, tools, sessions, Skills, low-level Agent Loop
```

> Eliminate meaningless choices, preserve meaningful choices.

## Architecture

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

The semantic layer is deliberately small. Pindie does not add a second Agent Loop, workflow engine, task queue, planner framework, or separate Skill runtime.

## What Pindie adds

- one durable current Task with explicit success criteria, open loops, verification, and Human Gate;
- pure `SemanticRunFacts → SemanticSnapshot → Capabilities` derivation;
- capability-driven model Tool Surface over the current Pi/user tool baseline;
- an execution Gateway that re-authorizes consequential calls against fresh authority;
- factual Snapshot-aligned Runtime Context instead of a global lifecycle-policy prompt;
- Project Mutation Freshness for keeping verification current with project Reality;
- Harness-owned verification evidence provenance/freshness while the model owns semantic pass/fail and criterion coverage;
- a one-shot continuation probe that asks only whether latest actual user intent still calls for consequential execution;
- runtime-only activity, timer, cost, status presentation, adaptive reasoning, and `/efficiency`;
- a bundled `git-workflow` Skill implemented through Pi's native Skill runtime.

Model-facing Pindie semantic tools are narrow affordances:

```text
pindie_task_start
pindie_task_replace
pindie_task_refine
pindie_task_progress
pindie_verification_record
pindie_task_complete
pindie_gate_open
pindie_gate_resolve
pindie_git_observe
```

## Documentation

- `docs/architecture.md` — current architecture and ownership boundaries.
- `docs/behavior.md` — current semantic and behavioral contract.
- `AGENTS.md` — repository instructions for agents working on Pindie.

Git history and tests are the record of the v0.2 migration; stable docs describe the system as it exists now.

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
