# AL retirement Phase 2-B — retire the remaining executable scheduler

Base: `bf14847e693f4287c771cf28383ce61d3b7a95e0`, merged Phase 2-A PR #269 (CI #628: 1397 active cases). This is one bounded source-deletion slice, not completion of all Phase 2. Delivery is an independent Draft PR; no merge or deployment is authorized.

## Actual dependency boundary

The exact base graph and every deleted case title are recorded in [al-phase2-b-deletion-graph.json](al-phase2-b-deletion-graph.json). The conservative scan covers every relative `.ts` string under `src`, `tests` (including fixtures), and `scripts`: imports, exports, type-only and dynamic references. No deletion by filename prefix. Historical archive `.txt` files are not active imports and remain byte-identical.

The five executors have no retained production consumer, including no Core-used `project-discovery.ts` API: this file is specifically the AL Experience-to-packet/job builder, not Control workspace project discovery. Its only source consumer is the deleted AL handler. Two mixed test files supplied the remaining incoming edges and were explicitly detached. After detachment, incoming references from retained files into the exact deletion set are zero. Typecheck and the retirement emitted-runtime-graph test independently check the boundary.

Physical deletions:

- `src/learning-supervisor.ts`: claim/kick/preemption/attempt execution.
- `src/learning-budget-store.ts`: learning token/time reservation and daily budget persistence.
- `src/learning-session-runner.ts`: isolated Learning Pi Session/model runner.
- `src/project-discovery-handler.ts`: Learning job handler/model-result publication.
- `src/project-discovery.ts`: AL evidence selection/packet builder/enqueue entry point.
- `tests/learning-foundation-f2.test.ts`: 15 standalone Learning scheduler/runner cases.

No production replacement scheduler, compatibility stub, persisted workflow, data migration or deleted namespace is introduced. Removing the old executor functions reduces physically callable legacy surface; it does not change the Phase 1 production mounting boundary.

## Mixed tests and exact accounting

- `tests/project-discovery.test.ts` remains active. Preserve both Host regressions (default Stable Mode and legacy AL flag true), with six existing v5 Experience records. Replace the deleted job-ledger assertion with direct filesystem assertions: no `learning-v1` namespace, no Learning model result interface, existing Experience bytes unchanged. Remove only its 37 standalone AL Discovery execution/artifact cases (35 ordinary registrations plus a `hasReceipt` loop generating two cases at base line 822). Those case titles and their original file are in the manifest; this is retired-feature coverage removal, not improved Core quality.
- `tests/pi-runtime.compatibility.test.ts` remains active. Remove exactly one Learning runner case with the removed implementation. All ordinary native Pi/preflight/tool-loadout/hidden-trigger/continuation/quota compatibility registrations, including generated cases, remain.
- `tests/learning-foundation-f1.test.ts` remains untouched, including job-ledger and artifact contracts. Its consumers are why `learning-job-store.ts` is explicitly retained rather than blindly deleting all `learning-*` files.

**1397 baseline active = 1344 retained active + 53 removed AL-only cases** (15 + 37 + 1). Initial top-level-only counting missed the two generated Discovery cases; the final manifest explicitly includes them and matches actual full-check totals. An isolated exact-base archive was subsequently executed file-by-file (no old worktree touched), then TAP `Subtest` titles were compared against the current files and manifest:

| File | Base executed | Retained executed | Removed AL-only |
| --- | ---: | ---: | ---: |
| `learning-foundation-f2.test.ts` | 15 | 0 (file deleted) | 15 |
| `project-discovery.test.ts` | 39 | 2 | 37 |
| `pi-runtime.compatibility.test.ts` | 17 | 16 | 1 |

All these runs passed with no failed/cancelled/skipped cases; none contains nested subtests. Every removed executed title exactly matches the manifest; every retained executed title existed at the base. The two Host titles and all 16 ordinary Native Pi cases are retained. No test source changed after the full check; accounting/documentation corrections did not require another expensive full suite. No added registration, `test.skip`, skip helper, name filter, test-glob or package script change. `tests/archive/al-phase1` stays unchanged and outside this accounting.

## Preserved boundary and next slice

No production retained source is edited. Core State/store/reducer/current-state authority, Task/Verification/Gate, Host/Control MCP/workspace, Native Pi/TUI, Session/Run, Handoff/AutoRollover, Quota resume/fallback, Browser Reality, Remote/Discord, Work Memory/Notion, Skills/git workflow, LLM model configuration, TaskMetrics/RunCounters and Subscription/UI are untouched. `policy.*` names retain their fail-closed classification; no Core capability or activation grants are introduced. AL flags remain inert even when true.

Deferred Phase 2-C candidates, not claimed deleted: the job ledger and learning-v1 artifact contract, Discovery packet/receipt/hypothesis/lineage stores, Trial/assignment/evidence, Experience/WorkEpisode, SI/CPL Strategy/Trust/Policy implementations, and Extension/composition/Core inert/type-only interfaces. They still have retained artifact/contract consumers and need their own exact closure review. The historical research docs are not permission to reactivate Learning; this manifest supersedes references to these five executor source files.

## Verification and isolation

Worktree `/home/dev/projects/Pindie-al-phase2b`, branch `feature/al-retirement-phase2b`. All local execution uses new isolated HOME/cache/tmp under `/tmp/pindie-al-phase2b-A05od3`. Offline install initially failed because the fresh metadata cache lacked a supply-chain verification entry; copying only pnpm's `lockfile-verified.jsonl` package-validation cache into the new isolated cache allowed `pnpm install --frozen-lockfile --offline` to succeed with the existing content store. No integrity/supply-chain validation was disabled, no credentials copied, and no lockfile/dependency change was made.

- Typecheck passed after deletion.
- Focused native/Core/retirement/Host/Control/Quota/Browser: **75 passed / 0 failed / 0 cancelled / 0 skipped**, 34914.444564 ms. Includes real published Pi/faux-provider SDK Session regressions and headless Control lifecycle coverage in isolation.
- Full final `timeout -k 5s 480s ... pnpm run check`: **1344 passed / 0 failed / 0 cancelled / 0 skipped**, 161434.654603 ms, exit 0 (typecheck ran first). Only documentation/manifest accounting changed afterward. Current-head CI is reported separately on the Draft PR; no unobserved CI success is claimed.
- Import scan, diff checks, archive Git blob comparison and protected worktree observations: final results recorded on the Draft PR.
- No additional paid-model/native-service E2E smoke or production dogfood. Native Pi tests are automated regression evidence, not a real-service deployment claim.

Live main remains `4d3139b`; existing retirement/acceptance/phase2 worktrees are not edited, checked out, cleaned or reset. No service/tmux/tunnel restart, configuration change, active Pi Session switch, or historical `~/.pindie` read/write/deletion. Retained users' Learning data is deliberately not inspected or migrated. Revert the reviewed slice commits to restore source/tests; rollback does not require data migration or a production restart.
