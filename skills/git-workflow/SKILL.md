---
name: git-workflow
description: Carry repository changes through a safe branch, commit, push, and pull-request workflow. Use when code or documentation changes should be delivered through Git for review.
---

# Git Workflow

## Purpose

Provide a focused Git delivery procedure. This Skill does not decide Pindie Task semantics, verification meaning, Human Gate lifecycle, or completion legality; those remain owned by the Pindie Harness and current model-visible action space.

## Procedure

### 1. Inspect Git reality

Before Git mutation, inspect the current branch and working tree. Prefer `pindie_git_observe` for supported read-only Git observation. Inspect remote/upstream/recent commits only when relevant.

Do not assume existing modified, staged, or untracked files belong to the current work.

### 2. Prepare a focused branch

Reuse a branch that clearly belongs to the current work, or create a focused branch before normal delivery work when practical.

If relevant changes already exist on `main`/`master`, move them onto the focused branch without discarding unrelated local work.

Follow repository naming conventions when present; otherwise use a concise semantic branch name.

### 3. Work without unnecessary Git churn

Use normal implementation/verification tools. Git checkpoints are delivery boundaries, not a required step after every edit or test.

Do not create commits merely to record intermediate agent-loop steps.

### 4. Inspect before commit

Re-observe `git status` and the actual diff, including staged changes when relevant.

Identify the intended changes precisely. Preserve unrelated work; never silently restore, clean, stash, delete, or include unknown changes.

### 5. Commit

Stage only the intended changes and create a focused commit using the repository's commit convention. If no convention exists, use a concise semantic message describing the change.

### 6. Push

Push normally. Set upstream for a new branch; use the existing upstream thereafter.

Do not rewrite remote history by default.

### 7. Pull request

Open or update one focused PR against the intended base branch. When repository policy permits and reliable remote CI exists, appropriate targeted local verification may be enough to open the PR; do not require habitual duplicate full-suite validation.

Use the repository PR template when present. Otherwise keep the description compact, typically:

```text
## Summary
- what changed

## Verification
- what was actually run/observed
```

A PR is a review boundary. Do not merge it unless the current user request explicitly authorizes merging.

Remote CI starts independently after push/PR. While it runs, exhaust useful independent review work before starting a blocking CI wait/watch; only then query, watch, or wait for remaining CI. This is pipeline overlap, not a background-worker system. Merge only with user authority and required CI/review evidence.

### 8. Review cycle

For review feedback:

1. inspect the current branch/code reality;
2. make only the targeted changes;
3. re-run relevant verification;
4. inspect the resulting diff;
5. commit and push the same branch/PR.

Do not open a replacement PR unless the existing PR cannot represent the work correctly.

### 9. Post-merge / post-deployment cleanup

At PR completion, consider cleanup of the known temporary worktree as a procedural handoff, not an unattended automatic action. Proceed only after the PR actually merges and any required deployment acceptance/verification is complete; CI is not deployment validation. Never clean up while the task still uses the worktree. An explicit user cleanup request may instead be handled in a dedicated follow-up after these checks. PR merge, deployment, and destructive cleanup retain their separate human approval boundaries; tool access is not blanket approval.

Before removal:

1. Establish the exact PR ↔ branch ↔ registered worktree path using PR metadata and `git worktree list --porcelain`; record the branch and worktree HEAD. Confirm the PR is merged and current main contains its changes, including for squash merges: ancestry alone may not prove content equivalence. A clean checkout is not proof of merge.
2. Inspect `git status --porcelain=v1 --untracked-files=all` in that exact worktree: require clean tracked and untracked/unignored relevant files. Check for unpublished distinct commits or changes beyond the merged PR; upstream tracking or a successful branch deletion alone is not proof they are safe to discard. Preserve user data, including relevant ignored files; do not assume build/session artifacts are disposable.
3. Check active use by relevant user-owned processes (including cwd/open files) and known services tied to the path. No blanket `/proc` scan of unrelated users is required. If linkage, content equivalence, cleanliness, or active-use checks are ambiguous, fail closed and report; do not stop services or sessions merely to permit cleanup.

With explicit cleanup authorization covering the exact target, recheck the preconditions before mutation and run from outside the target:

- Use ordinary `git worktree remove <exact path>` without force; verify both the directory and its worktree registration are removed. Respect all other worktrees; never sweep by age or name alone.
- Optionally remove the associated local branch with `git branch -d <exact branch>` only after independently establishing it is safe. Squash merges can make `-d` reject: do not automatically use `-D`. Unless exact PR linkage, content equivalence, and explicit cleanup authorization cover that branch, retain it and report the leftover.
- `git worktree prune --dry-run` is an optional read-only check, not permission to prune unrelated registrations. No `rm -rf`, `git clean`, force worktree removal, recursive deletion, history rewrite, or remote branch cleanup by default.

Record concise factual completion status: PR/merge evidence, deployment acceptance (or not required), exact path/branch/HEAD, checks performed, what was removed or retained, and any blockers/leftovers. If deferred, say why; consideration at PR completion does not authorize destruction.

## Safety

- Never discard unknown local work.
- Avoid destructive cleanup and history rewriting unless explicitly required and authorized.
- Do not force-push by default.
- Do not fabricate verification results in commits or PR descriptions.
- Keep Git delivery procedure separate from Pindie semantic correctness; current Tool Surface and Gateway remain authoritative for what actions are legal.
