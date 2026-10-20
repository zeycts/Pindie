# AL / SI / CPL retirement — Phase 1

Historical Phase 1 snapshot: [Phase 2-A](al-retirement-phase2-a.md) now removes the standalone Evaluation/Recovery island and inert Host Learning interface types/results described as retained below. Other deletion work remains pending; no historical data is migrated or removed.

Status: Phase 1 production hard isolation **merged in PR #268** at `d89ff6b48220bf0f8ad8d4a72ee9a7d393c6aeba`; Phase 2-A **merged in PR #269** at `bf14847e693f4287c771cf28383ce61d3b7a95e0` (CI #628: 1397/1397 passed). Merge is not deployment: the protected live worktree remains at `4d3139b` and no production service change is claimed. The verification counts and Draft-stage instructions below are historical Phase 1 evidence, not current PR status. This approved retirement contract supersedes historical Learning activation and SI/CPL integration-preservation guidance. Phase 2-B subsequently merged in PR #270 at `a66e47d8cfc335634501b4c36c65b19fd2a71443` (CI #630: 1344/1344 passed). See [Phase 2-C](al-retirement-phase2-c.md) for the next bounded deletion slice; none of these merges claims production deployment.

## Production boundary

- `composition.ts`: AL/SI/CPL always resolve false, regardless of old environment values (including malformed values) or embedding overrides. Retired dependency injections are discarded without reading their getters. No StrategyKnowledge, Experience, WorkEpisode or Trial store is constructed. Remote, Work Memory, bundled Skills, presentation, semantic stores and quota preferences retain their selection.
- `host.ts`: no Learning runtime imports, ledger/model/scheduler construction, discovery enqueue or Learning lifecycle/kick/preemption/disposal path. Deprecated type-only inputs/callbacks are inert compatibility, not activation APIs.
- `extension.ts`: no SI/CPL assembly, commands/tools, preparation, ordinary-Trial placement/context, selector resolver or Experience/TrialEvidence settlement. Core lifecycle, native continuation, Attention/Human Signal, quota, remote and presentation remain.
- `core-integration.ts`, `semantics.ts`, `context.ts`: no Policy registration/grant or Seed/Policy/advisory context. Retired names remain classified as unavailable `policy.*` effects so captured tool baselines cannot bypass the Gateway. Legacy capability names are compatibility types, never Core grants.
- `run-integration.ts` uses independent runtime-only `RunCounters` in `run-counters.ts` for real Core settlement/handoff diagnostics. No learning artifact parser, policy attribution or persistence.
- WorkEpisode had **no non-learning consumer**. No production ledger mounting/reconciliation/preparation/commit/notification remains. Deprecated null/ignored signatures remain for Phase 2 cleanup only. Real Task-occurrence/external-state epochs remain to protect semantic authority and handoff.

The emitted production import graph rooted at Host/Extension/Core/Control is tested transitively, including relative dynamic imports/requires: Learning/Policy runtime modules must be unreachable. Standalone historical modules remain directly importable by isolated artifact/contract tests; this is not a sandbox against arbitrary code.

## Preserved and untouched

Task/Verification/Gate/reducer semantics, Session/Run coherence, Attention/Human Signal, Control API, Browser Reality, quota resume/fallback, Remote, Work Memory, native Skills/git workflow and Pi integration remain. No dependency versions change. No data migration/deletion occurs.

Work is confined to `/home/dev/projects/Pindie-al-retirement`, branch `feature/al-retirement-phase1`, based on main `4d3139b641571a7c32c90c1c7acea85d2ea4645c`. Live main is not edited/checked out or deployed; no production process/service/config change or paid model call. Tests use isolated HOME/cache/tmp under `/tmp/pindie-al-retirement`.

## CI #624: evidence-based classification and repair

Run `39291196691`, job `118191969378`, head `fe1d9fa`: **1422 pass / 87 testCodeFailure / 172 cancelledByParent / 0 skipped**. All 172 cancellations were in `extension.test.ts`, following the obsolete SI preparation wait. They were not 172 independent Core failures.

The exact 87 failing titles, baseline file/line, category and disposition are recorded in `tests/archive/al-phase1/ci624-classification.json`:

| Category | Count | Disposition |
| --- | ---: | --- |
| (a) Production-only retired Learning expectation | 37 failures | Exact cases moved to historical archive; standalone artifact/store tests remain active. |
| (b) Mixed Core + obsolete expectation | 50 failures | Adapted, not skipped: Core assertions remain in active tests. |
| (c) Established new production Core defect | 0 established | Do not infer this solely from names; native/Core regressions and full active suite were rerun. |
| (d) Propagation cancellation | 172 | Removed obsolete waiting case; subsequent active tests execute normally. |

Mixed repairs preserve exact Task/Gate/verification capability sets without Policy, deterministic factual context/compaction, registration uniqueness, Remote reload/shutdown, in-memory counters/error facts, continuity-before-publish ordering, in-flight/terminal handoff barriers, per-Run and cumulative Task metrics across Sessions, stale observer completion fencing, and native Pi Task failure/replacement/external-State behavior. Native historical-data tests verify all Learning bytes remain unchanged and no WorkEpisode/Experience is created. The invalid-task fixture now uses an actually invalid empty criterion array; it no longer assumes an empty string goal is rejected by the existing contract. Shutdown tests inspect persisted Task state rather than expecting an unloaded Runtime to retain State.

No production `src/` change was needed in this acceptance repair. Earlier resource/timing suspicions were not labeled obsolete: evaluation/recovery and real Linux owned-descendant tests completed in the full sequential run.

## Active test composition and latest local verification

- **No `test.skip`, skip wrapper, name filter or whole-file exclusion was introduced.** A proposed unused skip helper was discarded before wiring it into any test.
- Historical archive: **78 top-level registration blocks = 81 generated cases** (one role/placement loop generates four). Exact original case bodies from `fe1d9fa` are retained as `.test.ts.txt`, with source locations/reasons in `tests/archive/al-phase1/manifest.json`. They require removed production Learning activation. This includes 37 failures from #624 and 44 previously passing/cancelled production-Learning cases; it is not an archive of all failures.
- Mixed files remain active. Independent Learning artifact/store/contract tests remain active pending Phase 2. No Core test file or production source file was deleted. The archive is deliberately non-executable historical text, not silently discovered test code.
- `pnpm test` / `pnpm run check` retain the user-approved `--test-concurrency=1` default with **unchanged `tests/*.test.ts` glob and no case filtering**. Sequential verification completed locally and on GitHub Actions #625; the attempted original-concurrency VPS check did not complete inside its 180s safety bound. Keep the verified configuration rather than optimize speed during acceptance. Future scheduling optimization requires separate measurements; this timeout alone does not diagnose an underlying runtime hang.
- Full sequential `timeout -k 5s 360s ... pnpm run check`: **1600 passed / 0 failed / 0 cancelled / 0 skipped**; test duration **296049.599238 ms**. The reduction from 1681 is exactly the 81 archived cases. Typecheck ran first and passed. GitHub also passed the sequential intermediate head `3ae44b0` (run `39294952295`).
- Original-concurrency VPS experiment `timeout -k 5s 180s ... pnpm run check`: exit **124**, 763 individual passes logged before termination, no failed assertion before the deadline; pending-file cancellation output afterward is not an independent failure diagnosis. No completed original-concurrency suite count is claimed. Only our own worktree's package.json was restored exactly to the verified sequential PR head. Final-head GitHub Actions status remains separately reported on the PR.
- Full suite includes retirement flags/poisoned injections/import-graph guards, native Pi/faux-provider replacement and hidden-resume, git-workflow Skill presence, all active Extension/Core/Control, Browser, Quota, Remote, Work Memory, State/Gate/evidence, metrics, continuity and retained artifact contracts. This is not live-service or native Windows dogfood.
- `git diff --check`: passed after archive extraction formatting. Current-head GitHub Actions status is reported on PR #268; the failed #624 result is historical, not silently replaced with a local-green claim.

## Rollback and Phase 2

Rollback is Git-only: revert the reviewed Phase 1 commits. Historical bytes/schema are unchanged, so no reverse migration is needed. Do not restart/deploy production merely to test rollback. The original instruction was to keep PR #268 Draft/unmerged until independent acceptance; that acceptance and merge are now complete. This is not authorization to merge later retirement PRs or deploy production.

After acceptance, separately inventory/delete unreachable Learning/discovery/hypothesis/lineage, Trial/overlay/evidence, evaluation/evaluator/recovery, SI/CPL strategy/trust/knowledge and Experience implementations and their isolated tests/fixtures. Remove inert interfaces/results/helpers and reconcile historical docs. Preserve explicit fail-closed handling of retired tool names, independent Core counters and real authority epochs. Any archival/deletion of historical user data requires separate explicit authorization; never delete State/continuity, global preferences, remote routing or user Sessions as a shortcut.
