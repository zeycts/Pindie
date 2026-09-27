---
name: development-execution
description: Improve execution of repository implementation, bug fixes, refactors, tests, code changes, and similar development work through dependency-aware batching and verification.
---

# Development Execution

## Purpose and boundaries

Use this procedural Skill to reduce critical-path latency and unnecessary model/tool round trips while preserving correctness and evidence quality. It is advisory: it does not own Pindie Task semantics, verification meaning, Human Gates, capability legality, or completion. It does not add a scheduler, second Agent Loop, workflow engine, task queue, DAG runner, cache, or worker system; do not build efficiency infrastructure absent concrete dogfood evidence.

## Procedure

### 1. Follow dependencies

Think in dependency edges, not a rigid serial checklist. Keep true trunk decisions serial: interpret the task and settle architecture, interface, or invariant decisions that later work depends on. Parallelize only independent leaves.

### 2. Reconnoiter in parallel

Before mutation, identify the minimum evidence needed for the next decision. When read-only observations are independent and their inputs are already known, prefer issuing them together in the same model turn when Pi/tools support parallel calls. Examples include relevant source and tests, package/config, Git reality, and architecture docs. Do not serialize independent reads by habit; do not parallelize if one observation determines what to inspect next. Stop exploring once uncertainty is low enough to act.

### 3. Pipeline verification safely

Keep factual feedback close to each coherent local change/slice and prefer the smallest relevant targeted verification. Independent cheap checks may run together when resource-safe. Parallel is not inherently faster: avoid concurrent CPU-, memory-, port-, or shared-state-heavy checks when contention or shared resources could slow them down or make them flaky. Do not overlap project mutation with a check requiring a stable working tree unless isolation makes it safe. Avoid repeatedly paying for the same expensive full-suite evidence after every small edit.

### 4. Choose local and remote final checks by policy

Inspect repository rules and available CI; there is no universal local-versus-remote rule. Run a local full check when repository policy requires it. If reliable remote CI exists and policy permits, targeted local verification may suffice before push and CI can provide expensive full-suite evidence. Never claim CI evidence before it exists. Do not duplicate an expensive local full suite and equivalent CI full suite solely from habit; duplicate when risk, policy, or evidence justifies it.

### 5. Overlap PR review and CI

Remote CI starts independently after push/PR. While it runs, first exhaust useful independent work: inspect the final diff, self-review regressions, risk, and architecture, clean up the PR description, and gather any other evidence that does not depend on CI. Do not start a blocking CI wait/watch while such independent work remains. Only after that work is exhausted should you query, watch, or wait for remaining CI. If review finds a problem, fix and push, accepting that CI may restart. Converge at the merge/delivery gate with required CI and review evidence, plus repository/user merge authority. Prefer event-driven or status-aware waiting when available; do not busy-poll rapidly. This is pipeline overlap, not a background-worker system.

### 6. Optimize the critical path

Optimize critical-path latency and unnecessary model/tool round trips, not maximum concurrency. Batch already-known independent observations, preserve correctness and evidence quality, and avoid efficiency recursion: no new scheduler/DAG/cache/worker system unless concrete dogfood evidence later requires it.
