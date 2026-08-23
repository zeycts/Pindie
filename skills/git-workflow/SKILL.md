---
name: git-workflow
description: Carry a code-changing task through a safe Git branch, commit, push, and pull-request workflow. Use when changes in a Git repository should be delivered through a reviewable branch or pull request.
---

# Git Workflow

## Purpose

Deliver one code-changing Pindie task through a focused, reviewable Git branch and pull request without taking over Pindie Core decisions.

## Procedure

### 1. Inspect

Pindie Core owns Task establishment and reconciliation. When latest user intent begins or replaces a code-changing Task, establish the correct current Pindie Task before consequential Git action; minimal read-only observation may precede that reconciliation when needed. Then, before consequential Git mutation, observe the branch, working tree, and repository context. “Inspect before consequential Git mutation” does not require Git inspection before Pindie Task establishment/reconciliation. Inspect remote, upstream, recent commits, or PR context only when needed. Do not assume existing modified, untracked, or staged changes belong to this Task.

### 2. Prepare the branch

Reuse a branch that clearly belongs to the Task. For a new code-changing task on clean `main` or `master`, create a focused branch before normal implementation when practical. If confirmed Task changes already exist on `main` or `master`, create or switch to the focused Task branch while preserving them before committing; preserve ambiguous changes and follow Human Gate guidance. Follow repository branch and delivery conventions; use a simple semantic prefix only when none exist.

### 3. Work

Normal Pindie Core Loop implementation and Verification remain authoritative. Use Git checkpoints at useful delivery boundaries, not after every edit or Core Loop step.

### 4. Inspect before commit

Re-observe `git status` and the actual diff, including staged changes when relevant. Identify only the Task changes and preserve unrelated work; never silently include, discard, restore, clean, or stash unknown changes.

### 5. Commit

Stage the identified Task changes after inspection. Follow the repository's commit convention; otherwise use a concise semantic message describing the committed change.

### 6. Push

Push normally: set upstream for a new branch and use the existing upstream thereafter. Do not rewrite remote history by default.

### 7. Pull request

Open or update one focused PR, using an existing PR template when present. Otherwise report concise `## Summary` and `## Verification` sections with only actual evidence. A PR is ready for review, not merge authorization.

### 8. Review cycle

Read actual review feedback and inspect current branch/code reality. Make targeted changes, re-verify after mutation, inspect the resulting diff, then commit and push the existing branch/PR.

## Safety

Never discard unknown local work. Destructive or history-rewriting actions require consequence-aware observation; prefer safer options and use the existing Pindie Human Gate when consequential judgment is required. Obey current user intent, repository reality, the Task Contract, Verification, and Core invariants.

## Completion

Branch, commit, push, and PR milestones are Git delivery milestones only. This Skill never decides whether the Pindie Task is complete.
