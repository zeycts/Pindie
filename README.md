# Pindie

> Pindie is a personal AI agent for indie development, built on Pi.

Pindie helps carry one development task from intent to verified completion while keeping human judgment explicit for consequential choices. Pi remains responsible for the low-level model/tool agent loop; Pindie adds the minimal operating model above it.

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

The Pindie Core v0.1 has been implemented through the Pi Core Extension.

Implemented:

- State Model
- State Machine
- State Store
- Pindie Runtime
- `pindie_state`
- `pindie_gate`
- Pi Core Extension wiring

Next:

- Real-world dogfooding of the existing Pindie Core

Not currently implemented or assumed next:

- plan / review / ship skills

New specialized skills should only be added later if repeated real usage shows that a specialized procedure is needed.

## Commands

Requires Node.js 22.19+.

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run check
```

Load the local extension in Pi 0.84.2 with:

```bash
pi -e ./src/extension.ts
```

The scripts themselves are package-manager agnostic; pnpm is the recommended package manager for Pindie.
