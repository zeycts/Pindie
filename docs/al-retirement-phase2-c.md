# AL retirement Phase 2-C — disconnected integration and artifact-store slice

Base: `a66e47d8cfc335634501b4c36c65b19fd2a71443`, independently reviewed and merged Phase 2-B PR #270, CI #630 **1344/1344**. Phase 2-C subsequently passed independent review and merged as PR #271 at `aa7b741cd6919a09c1aa232f8a64fb3a1aef507e`, CI #632 **1340/1340**. Draft-stage language below is historical, not current PR status or a deployment claim. This is a bounded sub-slice, not total Learning deletion; see [Phase 2-D](al-retirement-phase2-d.md) for the next exact boundary. No later PR is authorized to merge automatically.

## Exact closure, not a prefix deletion

The [deletion graph/manifest](al-phase2-c-deletion-graph.json) records the exact base, physical paths, incoming/outgoing edges, executed baseline case titles and explicit keep reasons. Every relative `.ts` string under **src/tests/scripts** was scanned, including imports, exports, type-only and dynamic literal references and fixtures. A supplemental exact-basename audit covers computed source-inspection URLs: the first full run exposed two obsolete `readFile` source-inspection edges in composition's Slice F test, which relative-literal scanning alone did not reconstruct. These are now explicitly listed in the manifest and replaced with physical-absence assertions, not ignored. Archived `.txt` tests are historical data, not active import roots. Typecheck and the retained production emitted-import-graph regression provide independent guards.

Delete exactly six AL-only source modules:

| Source | Classification / why safe |
| --- | --- |
| `src/cross-project-learning-integration.ts` | Orphaned CPL command/tool/Trial/trust orchestration; zero source or test importers. |
| `src/self-improvement-integration.ts` | Orphaned SI Policy/Trial/Experience/decision orchestration; its only importer is the deleted CPL integration. No Extension/Core importer. |
| `src/learning-job-store.ts` | Obsolete Learning job persistence; only importer is three ledger-specific tests detached from F1. |
| `src/discovery-packets.ts` | Standalone frozen Discovery packet store; no remaining importer after Phase 2-B executor deletion. |
| `src/discovery-receipts.ts` | Standalone Discovery receipt store; no remaining importer after Phase 2-B executor deletion. |
| `src/trial-offer-store.ts` | Frozen v1 Trial offer reader/commit validator; only importer is its standalone artifact test. |

Delete exactly `tests/trial-offers-t1.test.ts` (one artifact-reader case). No fixture is deleted. Source deletion is the implementation: no retained production source, replacement runtime, inert shim, scheduler, capability or State schema is added or changed. After explicit test detachment, retained incoming references into the deletion set are **zero**. Shared helpers imported *by* these deleted modules (State, writer locks, Pi interfaces, capability semantics, trust types) are not deletion candidates merely because they appeared as outgoing edges.

The source embedding APIs exported by these six modules cease to exist. In particular, old Trial v1 `FileTrialOfferStore.find` is no longer an API: preserving historical bytes does not promise continuing every experimental reader. The fixture's contract and Native Pi historical-data preservation tests remain. No user artifact is inspected, deleted or migrated.

## Executed test-title accounting

Both affected baseline test files were executed **before mutation at exact base** with isolated HOME/tmp. The retained F1 file was then executed again. Actual TAP `Subtest` titles, rather than a top-level regex estimate, are the accounting authority. These files have no generated registration loops or nested subtests.

| File | Baseline executed | Retained executed | Removed AL-only |
| --- | ---: | ---: | ---: |
| `tests/learning-foundation-f1.test.ts` | 6 | 3 | 3 |
| `tests/trial-offers-t1.test.ts` | 1 | 0 | 1 |
| `tests/composition.test.ts` | 12 | 12 | 0 |
| `tests/al-retirement.test.ts` | 5 | 5 | 0 |

Removed exact titles:

- `F1 jobs are deterministic, fenced, persistent and never silently compacted`
- `F1 independent job directory initializes, owner/token are strictly bounded`
- `F1 ledger at capacity refuses enqueue without evicting pending/running`
- `Frozen v1 history remains exact readable bytes, never v2 authority`

**1344 baseline active = 1340 retained active + 4 removed AL-only cases.** F1's three remaining hypothesis/artifact/budget contract test bodies are byte-identical to the base. Its obsolete ledger setup and unused imports are removed; no Core assertion was removed. Host, Native Pi, Quota and Control tests are untouched. The composition Slice F case and retirement graph case are preserved and updated as described below; both retain their original titles and counts. No skip helper, `test.skip`, name filter, test glob or package-script change. Retiring four tests is coverage removal for deleted interfaces, not a claim of improved quality. The 81 historical Phase 1 cases (`tests/archive/al-phase1`, nine files) remain outside this active count and unchanged.

### Preserved Slice F regression and actual failure repair

The first full run completed **1339 pass / 1 fail / 0 cancel / 0 skip**, 158660.857041 ms. The sole failure was `Slice F protects the final Core/SI/CPL and trust runtime import boundaries` at `tests/composition.test.ts:298`, trying to read the correctly deleted SI orchestrator. The test was not deleted, renamed or skipped. Its Core reverse-import checks, Core Task no-learning-seam assertions, and retained Portfolio/TrustSafety/Global type/runtime structure checks remain. Obsolete SI/CPL-content assertions are replaced with `access`/ENOENT checks for physical absence, plus emitted-code runtime-import checks over Core/composition/extension/Host/Control. The existing transitive production graph test now also roots `composition.ts`; its retired-tool authorization test still proves fail-closed behavior.

An intermediate focused assertion falsely treated interface `import("./work-episode.ts")` as a runtime edge. Checking TypeScript-emitted code, matching the existing retirement graph's method, fixes that false positive without changing production or deleting shared types. The corrected files pass **12/12 + 5/5**; all executed titles match exact-base runs (also 12/12 + 5/5), with no removed registrations. This separates actual runtime edges from retained type-only contracts.

## Core and remaining Phase 2-D

No retained source is edited, so Task/Verification/Gate/State Authority, Session/Run/Attention, RunCounters/TaskMetrics, Handoff/AutoRollover, Quota resume/fallback, Native Pi/TUI, Skills/git workflow, Host/Control MCP/workspace, Browser Reality, Remote/Discord, Work Memory/Notion, Subscription/UI and model configuration remain unchanged. `policy.*` effects remain fail-closed; no Core grants or bypass appear. AL flags true remain inert. Focused native tests still exercise legacy data without mutation or Learning activation.

Deliberately retained (not a claim of full Phase 2-C completion):

- `learning-v1-contract.ts`: still imported by retained artifact stores/fixtures/tests, WorkEpisode/Experience and Trial schemas. No shared contract truncation.
- `trial-offer-contract.ts` and `tests/fixtures/trial-v1.ts`: still supply real frozen v1 history in retained Native Pi safety tests. Do not remove them just because the v1 store is gone.
- Discovery contract/hypotheses/lineage/open catalog and Trial assignment/evidence/overlay: retained Trial/Experience lifecycle/artifact consumers plus Extension inert/type-only interfaces.
- Experience/WorkEpisode stores/lifecycle: retained artifact consumers and inert Core/Runtime/Extension compatibility. Real Core counters and authority epochs remain independent and untouched.
- SI/CPL Strategy/Trust/Scope/Policy and candidate/decision stores/tools: remaining mutually dependent artifact tests plus Core/Extension type interfaces. Deleting two orphan orchestrators does not authorize broad type or trust-store deletion.

Phase 2-D should inventory those remaining interfaces/consumers before selecting its next exact closure. No architecture milestone, data-cleanup work or autonomous trust path is introduced. This manifest supersedes historical references to the six deleted modules; research docs remain historical, not activation authority.

## Verification and operational isolation

New worktree `/home/dev/projects/Pindie-al-phase2c`, branch `feature/al-retirement-phase2c`. Local tests use new HOME/cache/tmp `/tmp/pindie-al-phase2c-nrX3kV` and explicit temporary agentDir/cwd in native fixtures. Only pnpm's package-validation `lockfile-verified.jsonl` was copied into the isolated package cache; the existing content store supplied dependencies. `pnpm install --frozen-lockfile --offline` passed without disabling supply-chain/integrity validation, credential copies or lockfile/dependency changes.

- Baseline per-file TAP: **6/6 + 1/1**, no fail/cancel/skip. Current retained F1: **3/3**, no fail/cancel/skip; removed titles exactly match the manifest and remaining bodies match the base.
- Typecheck passed after deletion.
- Focused retirement/Core/Host/native Pi/Control/Quota/Browser and historical Trial-data safety: **89 passed / 0 failed / 0 cancelled / 0 skipped**, **41362.924725 ms**.
- Corrected composition/retirement focused runs: **12/12 + 5/5**, zero fail/cancel/skip; exact-base runs preserve all 17 titles. The earlier 89-case focused run preceded this test-only Slice F repair.
- Final corrected full `timeout -k 5s 480s ... pnpm run check`: **1340 passed / 0 failed / 0 cancelled / 0 skipped**, **159504.616035 ms**, exit 0; typecheck ran first. Only documentation/manifest results changed afterward. Import/diff/archive checks and current-head CI are recorded on the Draft PR after observation, never presumed.
- Native Pi/faux-provider and isolated headless Control regressions are automated coverage, not paid-model/service E2E or production dogfood. No additional live smoke/deployment is claimed.

Live main stays `4d3139b`. Existing retirement, acceptance, Phase2-A and Phase2-B worktrees are not edited, checked out, reset or cleaned. No service/tmux/tunnel stop/restart, configuration change, active Pi Session switch or historical `~/.pindie` access. No migration. Rollback is Git-only restoration of reviewed slice commits, not a service restart or reverse data migration.
