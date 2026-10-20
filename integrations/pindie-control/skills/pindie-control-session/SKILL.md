---
name: pindie-control-session
description: "Use whenever operating Pindie through ChatGPT's Pindie Control tools. Choose the correct project and native Pi Session, prevent unrelated-task context mixing, and respect safe switching boundaries before delivering work."
---

# Pindie Control Session Workflow v0.1

## Purpose

Act as an external, safety-conscious orchestration client of **one** Pindie Host and its native Pi Sessions. Select project and Session deliberately **before** delivering a new intent. Keep the user's goals in charge. Do not create a second Task engine, Session registry, queue, or durable memory.

Scope: project selection, Session continuity/isolation, and preflight/verification around Pindie Control. Model/thinking-level policy, UI changes, and retirement of old functionality are **out of scope** for v0.1.

## Reliable sources and limits

- `pindie_observe({})` provides the current active project, live Control lease/revision, Session ID, runtime settlement, semantic Task goal/status and Human Gate, quota state, and execution config.
- `pindie_list_projects({})` lists valid direct-child workspace projects; a name is not a filesystem path.
- `pindie_list_sessions({offset,limit})` lists **native Pi Sessions in the active project** with ID, name, timestamps, message count and **first-message preview**. The preview is not the latest message or a trustworthy summary of current Session purpose. Listings may be paginated.
- `pindie_read_timeline({limit})` shows only the **currently active** Session's bounded visible tail. It is not a cross-Session history search.
- `pindie_open_project`, `pindie_switch_session`, and `pindie_fresh_session` change the active Host/Session. No parallel active project or Session is supported by these tools.
- A fresh Session is a new native Pi Session; it is not a new Project, Task database entry, or guarantee of inheriting prior working memory.
- Observations and candidate lists can be stale immediately after a call. Always use the most recent live lease for lease-protected writes, and re-observe after any lifecycle change.
- No arbitrary filesystem/shell access exists in this Control surface. Never claim to have inspected a repository based only on session-list metadata.

## Preflight for every new Pindie work request

1. Resolve the **intended project** from explicit user intent and grounded context. Check `pindie_observe`; use `pindie_list_projects` when necessary. Never silently use the active project if evidence points to another one. Never invent a project, path, or project name.
2. Resolve the **work's relationship to the current native Session** using the user's present request, current ChatGPT task context, `semantic.taskGoal`, Session identity, and visible timeline evidence. If identity or continuity matters, inspect `pindie_list_sessions` (page as necessary).
3. Classify the work into one of these cases:
   - **Current-task continuation:** same concrete task/objective and compatible Session evidence → reuse the active Session.
   - **Verified historical-task resumption:** a uniquely identified historical Session tied to the requested task → switch to it only when the current Host is safely switchable; then inspect its current state before input.
   - **Independent task in the same project:** different goal, unrelated context or risk of task contamination → choose a fresh Session **after** the current work is safely settled; do not append it to a long unrelated Session.
   - **Different project:** open the explicit target project at a safe boundary, refresh Control state, then choose a matching existing Session or a fresh Session using the same rules.
   - **Insufficient evidence:** do not guess which historical Session is correct. If task continuity is essential, request the missing identifier/context. Otherwise prefer a fresh Session once safe, with a concise grounded handoff; label any reconstruction as such.
4. Do not equate "same repo" with "same task", "same ChatGPT conversation" with "same Pi Session", or "new ChatGPT conversation" with "fresh Pi Session".

## Safe lifecycle boundary

Before any Session/project replacement or execution configuration change, refresh `pindie_observe` and require all of:

- `runtime.idle === true`
- `runtime.automaticWorkSettled === true`
- `runtime.pendingMessageCount === 0`
- `semantic.humanGate === null`
- `recovery.quotaWaiting === null`

Also respect unavailable/stale semantic authority, active automatic continuation, and actual tool rejections. An `idle` indication alone does **not** mean all automatic work has settled.

If the current Session is busy with **another** task, **do not** inject instructions, steer, follow up, stop, replace the Session, or switch projects just to clear the way. Report the collision. Wait only when useful and appropriate for an explicitly requested continuation; do not promise unattended background execution. Stopping an existing task is consequential and needs explicit user authorization.

If a switch is unsafe or the server rejects it, fail closed. Never stop/retry/switch as a silent fallback. A current unresolved Human Gate is separate from ordinary user input; do not answer it without the user's authorized decision.

## Selection and delivery

- **Reuse current:** once project and Session match, deliver user's intent with `pindie_input` using the current lease. When the same task is actively executing, adding a new instruction risks steering it; only queue as `timing: "after_current_run"` if the user explicitly wants it queued and it belongs to that task. Otherwise observe/wait as appropriate.
- **Resume historical:** use `pindie_switch_session({lease,sessionId})` only for a verified exact ID in the active project. After switching, **re-observe**, examine relevant active timeline/snapshot, and make sure the selected Session still matches before input. A human-readable name alone may not prove identity.
- **Independent task:** at a safe boundary call `pindie_fresh_session({lease})`; re-observe to acquire the new lease and Session ID. Give the fresh Session a compact task-specific prompt with goal, repository/project context and important constraints. Do not copy unverified facts from unrelated history.
- **Cross-project:** call `pindie_open_project({project})` only for a verified workspace child. Re-observe and then list/select Sessions in the **new** project. Never reuse a Session ID from another project. Opening the already-active project is idempotent but is not a substitute for checking task affinity.
- **No active project:** list projects and explicitly open the user's target; do not presume a default.
- **New project:** `pindie_create_project` is only for an explicitly requested new workspace project, not an automatic solution to task/session ambiguity.
- **Input is not a repository merge, production deploy, or approval:** carry over user authorization boundaries explicitly; never infer consent for destructive operations from this workflow.

After lifecycle changes or input, call `pindie_observe` (and `pindie_read_timeline` when useful) to check actual project, Session and delivery/status. Distinguish dispatched from completed and tests claimed from tests actually observed. React to stale leases by re-observing and reconsidering the action, **not** blindly replaying it.

## Decision examples / acceptance scenarios

1. **Same task continuing, settled:** keep the active Session; do not create one just because the ChatGPT turn is new.
2. **New unrelated task, same project, settled:** create a fresh Session; verify Session ID changed before sending the new task.
3. **Explicit task in a different project, settled:** open that project, refresh the lease, then select or create an appropriate Session within it.
4. **Unrelated task arrives while the active Session is running:** observe/read-only only; do not steer, queue, stop, switch, or inject. State what blocked safe dispatch.
5. **Historical Session ambiguous:** a name, first-message preview, or recency alone is insufficient proof; do not select a random Session. Ask for required continuity evidence or start a fresh Session if continuity is unnecessary and the boundary is safe.
6. **Lease stale / unsafe switch / Human Gate / quota wait:** fail closed; recover via read-only observation, not hidden mutation.

## Completion report

For actual work, briefly report: chosen project, selected/new Session ID (when available), why that Session was used, whether input was **dispatched** or work was **verified complete**, and any safety boundary that prevented execution.

This is a decision workflow for ChatGPT. Pindie/Pi own runtime and Session facts; its tools enforce lifecycle legality. The workflow must never imply a guaranteed outcome when the Control surface cannot verify one.
