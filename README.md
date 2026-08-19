# Pindie

> Pindie is my personal AI agent for indie development.

Pindie is built on top of the Pi agent harness. Pi remains responsible for the low-level model/tool agent loop; Pindie adds a minimal operating model for carrying an indie-development task from intent to verified completion.

## Core model

```text
Pindie Loop

Observe → Understand → Decide → Act → Verify → Update State
   ↑                                              │
   └──────────────── Continue if needed ─────────┘
```

Pi handles the inner execution loop (`LLM → tool call → tool result → LLM`). Pindie governs what the agent is trying to accomplish, when evidence is sufficient, what must persist across sessions, and when human judgment is required.

## v0.1 architecture

```text
Pindie
├── Core Policy
├── Core Extension
│   ├── State machine
│   ├── State tools
│   ├── Human gate
│   └── Verification invariants
├── State
│   └── Current task
└── Optional skills
    ├── plan
    ├── review
    └── ship

Pi
├── Agent loop
├── LLM runtime
├── Sessions
└── Built-in tools
```

See `docs/architecture.md` and `docs/behavior.md` for the approved v0.1 design.

## Current status

The repository is intentionally being implemented in small slices.

Implemented:

- State Model
- State Machine
- State Store
- Pindie Runtime
- `pindie_state`
- `pindie_gate`

Next:

- Pi Core Extension wiring

Still not implemented:

- Pi Extension hooks
- plan / review / ship skills

## Commands

Requires Node.js 22.19+.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run check
```

The scripts themselves are package-manager agnostic; pnpm is the recommended package manager for Pindie.
