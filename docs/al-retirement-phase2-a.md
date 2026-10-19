# AL retirement Phase 2-A — Evaluation/Recovery island removal

Status: bounded Phase 2 sub-slice for independent Draft PR review, not the completion of all Phase 2. Base: merged `d89ff6b48220bf0f8ad8d4a72ee9a7d393c6aeba` (CI #627: 1600 active tests).

## Ownership and exact deletion boundary

The R4 Evaluation attempt/lease/authority/recovery foundation is Learning-only and had no active production mounting. Before deletion, a conservative scan of every relative `.ts` string reference under **src, tests (including fixtures), scripts** found **zero references from retained files into the explicit deletion set**. It includes type-only/dynamic references, not just runtime imports. The recorded base-graph edges and exact file lists are in `al-phase2-a-deletion-graph.json`. This was not prefix-based deletion.

Deleted 18 source modules:

- `src/evaluation-contract.ts`
- `src/evaluation-execution-authority-store.ts`
- `src/evaluation-execution-lease-assessment.ts`
- `src/evaluation-execution-lease-store.ts`
- `src/evaluation-execution-lease.ts`
- `src/evaluation-execution-runner.ts`
- `src/evaluation-packet-builder.ts`
- `src/evaluation-packet-store.ts`
- `src/evaluation-recovery-readiness.ts`
- `src/evaluation-run-store.ts`
- `src/evaluation-run.ts`
- `src/evaluation-stale-confirmation.ts`
- `src/evaluator-contract.ts`
- `src/recovery-admission-store.ts`
- `src/recovery-admission.ts`
- `src/recovery-capacity.ts`
- `src/recovery-successor-binding-store.ts`
- `src/recovery-successor-binding.ts`

Deleted 13 artifact-only test files and one fixture (no mixed Core file removed):

- `tests/evaluation-execution-lease-assessment.test.ts`
- `tests/evaluation-execution-lease-store.test.ts`
- `tests/evaluation-execution-lease.test.ts`
- `tests/evaluation-execution-runner.test.ts`
- `tests/evaluation-packet-builder.test.ts`
- `tests/evaluation-packet-store.test.ts`
- `tests/evaluation-r4a.test.ts`
- `tests/evaluation-recovery-readiness.test.ts`
- `tests/evaluation-run.test.ts`
- `tests/evaluation-stale-confirmation.test.ts`
- `tests/evaluator-contract.test.ts`
- `tests/recovery-admission.test.ts`
- `tests/recovery-successor-binding.test.ts`
- Fixture: `tests/recovery-fixture.ts`

These 13 files supplied **203 cases**, not product Core coverage. Exact accounting: **1600 base active = 1397 remaining active + 203 deleted island cases**. The Phase 1 archive of 81 historical cases is unchanged and outside this accounting. No skip wrapper, `test.skip`, name filter or changed test glob is introduced.

## Removed Host compatibility surface

`src/host.ts` no longer imports LearningJobHandler/LearningModelPolicy/ProjectDiscoveryPolicy types. Removed ignored options `learningHandlers`, `learningModel`, `discoveryPolicy`; removed inert result `learningModelIdentity`; removed the five unused Learning lifecycle callback options from `createPindieRuntimeFactory` (`onExperienceSaved`, `onHumanRunStart`, `onHumanRunSettled`, `onSessionChange`, `onSessionReady`). Their signatures had no active consumers beyond two retired-mode Host checks. Those two cases in `tests/project-discovery.test.ts` remain active and now assert that the Host has no Learning identity interface and cannot enqueue jobs. Test count is unchanged there.

This is an intentional source API removal for retired embedding options, not a State or Control protocol schema change. Callers using these obsolete TypeScript fields must stop supplying them. Native Pi/Host/Control lifecycle and presentation callbacks are retained.

## Explicit keep boundary

No changes to Core State/store/reducer/Task/Verification/Gate schemas or authority, CoreIntegration/RunIntegration/Runtime, RunCounters/TaskMetrics, handoff/rollover/continuation, Control MCP/workspace/client, native Pi/TUI, Attention/Human Signal, Browser Reality, quota resume/fallback, Remote/Discord, Work Memory/Notion, bundled Skills/git workflow or subscription/UI behavior.

In particular, `long-task-rollover.ts`, `quota-*-supervisor.ts`, `quota-*-control.ts`, and Codex quota incident recovery are **not** the deleted Learning recovery island. `experience-evaluation.ts` and the older SI StrategyEvaluation types are also distinct from R4; their remaining imports require separate cleanup. Retired `policy.*` tool names still classify fail-closed and are never Core capability grants. Existing `tests/al-retirement.test.ts` and Core/Pi lifecycle tests remain active.

## Verification

All local tests use isolated HOME/cache/tmp `/tmp/pindie-al-phase2-IeJibD`; no user credentials or production service changes.

- Frozen offline dependency install: exit 0; no dependency version/lockfile change.
- `pnpm run typecheck`: passed.
- Focused retirement/Core/Host/native Pi/Discovery checks: **82 passed / 0 failed / 0 cancelled / 0 skipped**.
- Full `timeout -k 5s 480s ... pnpm run check`: **1397 passed / 0 failed / 0 cancelled / 0 skipped**, test duration **181087.642471 ms**, exit 0. Typecheck ran first.
- `git diff --check` / staged diff check: passed.
- Final Draft PR records current-head CI separately; local success is not presented as an unobserved CI result.

This is automated/native regression coverage, not new external E2E/dogfood. The isolated post-merge Phase 1 runtime report remains at `/tmp/pindie-al-acceptance-Wy3cjl/REPORT.md` and is not rewritten or claimed as a Phase 2 real-service deployment.

## Safety, rollback and remaining Phase 2

Work only in `/home/dev/projects/Pindie-al-phase2`, `feature/al-retirement-phase2`. Live main remains on old `4d3139b` and is not checked out/pulled/reset/edited; existing acceptance/retirement worktrees are preserved. No service restart/kill, active Session change, historical `~/.pindie` read/write/deletion or production configuration change is part of this slice. Phase 1 archive bytes are preserved. Revert the slice commits on a reviewed branch to restore source/tests; no data migration/reverse migration is required.

Still deferred, not claimed deleted: SI/CPL Strategy/Trust/Policy implementations, Learning scheduler/jobs/budget/session runner, Discovery/hypothesis/lineage, Trial/assignment/evidence, Experience/WorkEpisode recorders and remaining Extension/composition/Core type-only/inert compatibility. Those have interconnected retained legacy module/test consumers and require the next bounded interface-detachment slice. Old research docs remain historical, not a roadmap to reactivate Learning; their R4 source references are superseded by this deletion manifest. Phase 2-A does not delete user artifacts merely because their readers are retired.
