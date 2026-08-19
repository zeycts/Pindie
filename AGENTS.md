# Pindie Agent Instructions

Pindie is a personal AI agent for indie development built on the Pi agent harness.

## Authoritative context

Read these before changing core behavior:

1. `docs/architecture.md` — approved architecture and boundaries.
2. `docs/behavior.md` — state-machine invariants and behavioral test cases.
3. Existing source and tests — the current reference implementation.

If code, docs, and assumptions disagree, do not silently redesign the system. Report the contradiction and preserve the approved architecture until it is explicitly changed.

## Engineering principles

- Keep Pi as the underlying agent runtime. Do not implement a second agent loop.
- Pindie Core Loop is: Observe → Understand → Decide → Act → Verify → Update State.
- Loop phases are runtime behavior, not persisted task status.
- Reality outranks persisted Pindie State.
- Maintain at most one current task in v0.1.
- Persist only semantic current-work state that cannot be reliably reconstructed from the project.
- Do not add task queues, history systems, memory databases, planners, orchestration frameworks, or extra abstractions unless explicitly approved.
- Prefer the simplest implementation that directly represents the approved architecture.
- Verification is required before task completion.
- Human judgment is required for consequential product, architecture, or destructive decisions.

## Development workflow

Work in small slices. For each task:

1. Read only the relevant authoritative context.
2. Preserve scope and note any contradiction before changing architecture.
3. Add or update tests for the approved behavior.
4. Implement the smallest change that makes those tests pass.
5. Run `pnpm run check` before declaring the task complete.

## Current implementation boundary

PR 1 implements only the pure State Model:

- `src/state.ts`
- `tests/state.test.ts`

Do not introduce Pi integration, persistence, reducers, custom tools, skills, or runtime hooks into this slice.
