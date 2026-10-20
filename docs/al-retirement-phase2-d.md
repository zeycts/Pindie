# AL retirement Phase 2-D — ordinary Trial/Hypothesis/retention closure

Base: `aa7b741cd6919a09c1aa232f8a64fb3a1aef507e`, merged Phase 2-C PR #271 after independent review and CI #632 **1340/1340**. This is one substantial closed subgraph, not total removal of all AL types/artifacts. Deliver as an independent **Draft PR**, never merge or deploy automatically.

## Actual source boundary

[Exact deletion graph](al-phase2-d-deletion-graph.json) records import/export/type-only/dynamic literal edges, outgoing dependencies, retained consumers, intentional absence checks and executed baseline TAP titles. Scan roots are **src/tests/scripts**, including fixtures; explicit basename audit covers computed source-inspection paths. No prefix-based deletion. The existing emitted production graph independently checks actual runtime imports, with Core/composition/Extension/Host/Control roots.

Delete exactly nine AL-only sources:

- `src/discovery-contract.ts`
- `src/discovery-hypotheses.ts`
- `src/hypothesis-lineage.ts`
- `src/open-hypotheses.ts`
- `src/ordinary-trial-overlay.ts`
- `src/trial-assignment-v2.ts`
- `src/trial-evidence-v2.ts`
- `src/v1-experience-protection.ts`
- `src/experience-lifecycle.ts`

This closes the disconnected ordinary-work experimental advisory/assignment/evidence path, its Hypothesis catalog/lineage, and AL-only Experience pruning/protection. Before deletion, production's only references into this closure were **three type-only Extension imports** supporting four ignored options. All other incoming references were inside the closure or explicitly adapted/removed tests. No Core metric, tracing, State authority or real Task/Session behavior consumes these implementations.

`src/extension.ts` removes only those three type-only imports and four inert public fields: `trialAssignmentStore`, `trialHypothesisReader`, `trialAssignmentPolicy`, `trialDiagnostic`. This intentionally retires the TypeScript embedding API; callers must stop specifying these fields. There is **no runtime statement change**: TypeScript-emitted Extension runtime (comments erased) is byte-identical to the exact base. The composition legacy deny-list remains so stale untyped JS fields/getters are discarded without access, not activated. Tests use local untyped historical injections, not replacement production compatibility types. All other retained production source is untouched. Retained `integration.trial` relates to the older Strategy Trial API, not a replacement ordinary Trial runtime, and is left inert.

After detachment, retained import/type/dynamic edges into the exact deletion set are **zero**. Physical-absence assertions are intentional negative references, explicitly listed in the manifest. Deleted readers/stores/retention helpers no longer supply APIs; disk history is neither read nor migrated/deleted. No replacement scheduler, Trial runtime, storage format or persisted workflow is introduced.

## Core/native tests retained, artifacts precisely removed

Delete only these standalone AL-only test files:

- `tests/hypothesis-v2.test.ts`
- `tests/trial-assignment-r2.test.ts`
- `tests/experience-lifecycle.test.ts`

Mixed files remain active:

- `trial-evidence-r3.test.ts`: preserve the original **Experience committed-byte/caller-mutation/maintenance-failure** test and exact assertion body. Only its fixture changes to an ordinary valid v5 record, independent of deleted assignment/materialization machinery. Do not erase this real store guarantee merely because it lived in an AL-named file. Remove its other 14 AL-specific cases.
- `trial-offers-pi.test.ts`: preserve both generated Native Pi ordinary-work/history cases. Write the same legacy record/ref shapes directly; inspect bytes rather than instantiate deleted Hypothesis readers. Task persistence, no advisory, no new Experience/WorkEpisode, existing Trial/Hypothesis bytes and repeated ordinary-work behavior remain asserted.
- `trial-overlay-pi-r2.test.ts`: preserve all nine cases, including four generated dependency failures, Task replacement, failed task_start recovery, inactive seams/episode handling, external State authority and retired Policy denial. Observe raw evidence files instead of the deleted reader. In the corrupt-evidence case compare original `null` bytes after ordinary work; no reader, repair, deletion or evidence fabrication is permitted. Historical injections remain test-local untyped fields.
- `al-retirement.test.ts`: preserve all five cases. Add compile-time absence checks for the four removed public options, poisoned getter coverage for all four, and `access`/ENOENT guards for all nine deleted sources. Keep actual retired-tool authorization denial and the transitive emitted runtime graph.

### Executed baseline/current TAP accounting

Each affected baseline file ran **before mutation at the exact base** under isolated HOME/tmp. Each retained mixed file then ran again. All removed/retained titles are compared against actual TAP output, including generated registration loops. No new registration, nested-subtest omission or title change is used to balance counts.

| File | Base executed | Retained executed | Removed AL-only |
| --- | ---: | ---: | ---: |
| hypothesis-v2.test.ts | 3 | 0 | 3 |
| trial-assignment-r2.test.ts | 12 | 0 | 12 |
| experience-lifecycle.test.ts | 7 | 0 | 7 |
| trial-evidence-r3.test.ts | 15 | 1 | 14 |
| trial-offers-pi.test.ts | 2 | 2 | 0 |
| trial-overlay-pi-r2.test.ts | 9 | 9 | 0 |
| al-retirement.test.ts | 5 | 5 | 0 |

**53 affected baseline = 17 retained + 36 removed. Overall: 1340 baseline active = 1304 retained active + 36 removed AL-only cases.** Exact generated titles are in the JSON, not inferred from static registration counts. The 81 archived Phase1 cases (nine files) remain byte-identical and outside this active count. No skip, filter, glob/package-script/lockfile change. Test reduction is loss of retired-feature coverage, not a quality-improvement claim.

## Safety and remaining Phase 2-E

Core State/Task/Run/Session/Attention/Verification/Gate/current-state authority, TaskMetrics/RunCounters, Handoff/AutoRollover, quota resume/fallback, native Pi/TUI/Skills/git workflow, Host/Control MCP/workspace, Browser Reality, Remote/Discord, Work Memory/Notion, Subscription/UI/model routing are unchanged. Retired `policy.*` never gains Core grants; old AL flags true remain unable to load Learning. Core/Task/Trust composition guardrails remain active.

Explicitly retain for Phase 2-E review:

- `learning-v1-contract.ts` / `trial-offer-contract.ts` and frozen v1 fixture: retained Experience/WorkEpisode/legacy artifact schemas and Native Pi historical-data tests still consume them.
- Experience record/store/evaluation/fingerprint and WorkEpisode record/attribution/interfaces: still have retained artifact consumers and inert Core/Runtime/Extension type/constructor ports. No mutation of these stores, no replacement of real counters or authority epochs. Only AL-only **maintenance/retention** is deleted here; committed record semantics remain tested.
- Strategy/Trust/Policy/candidate/decision stores, tools, review and older Strategy Trial implementations: mutual artifact consumers and Core/Extension inert type contracts still exist. Need separate exact closure/type-boundary review, not broad prefix deletion.

The user's docs follow-up physically deletes 17 obsolete AL/SI/CPL/Evaluation/Recovery designs and the old composition migration plan. The JSON's per-document audit records each reason; Git at the exact base recovers old text. Useful composition/Core invariants were moved into the existing architecture document, not another roadmap. README/AGENTS now navigate Stable Core and native Skills/workflow. Browser/Quota/Memory/Pi/Control/Remote/TUI/long-task contracts and phase deletion/PR/CI evidence remain. The Phase1 test archive is not product documentation and stays untouched.

## Verification and production isolation

New worktree `/home/dev/projects/Pindie-al-phase2d`, branch `feature/al-retirement-phase2d`. New test HOME/cache/tmp `/tmp/pindie-al-phase2d-wmr5XC`; native fixtures use temporary cwd/agentDir and faux providers. Only pnpm's lockfile-validation metadata was copied into the isolated package cache; `pnpm install --frozen-lockfile --offline` passed using existing content cache, with full supply-chain/integrity validation and no credentials copied.

- Typecheck after detachment/deletion: passed.
- Executed baseline: all 53 affected cases passed, no fail/cancel/skip. Retained mixed re-runs: **17 passed**, no fail/cancel/skip.
- Additional focused composition/Host/native Pi/Control/Quota/Browser: **82 passed / 0 failed / 0 cancelled / 0 skipped**, **38658.799973 ms**.
- Final full `timeout -k 5s 480s ... pnpm run check`: **1304 passed / 0 failed / 0 cancelled / 0 skipped**, **158455.104843 ms**, exit 0; typecheck ran first. Only docs/manifest results changed afterward. Exact-head CI is reported separately on the Draft PR, never presumed.
- Exact deletion/import/type/basename scans, retained TAP-title/body checks and `git diff --check` passed. Archive nine files unchanged, tree SHA `ae453acf3c16ef139a5d22bd68cf999546c7b6f9`; package scripts/glob/lockfile unchanged.
- Docs-only follow-up: exact 17-path deletion and remaining Markdown/code/test references checked; **22 retained Markdown files / 27 local links**, no dead paths. Package/Skills + composition + retirement checks: **19 passed / 0 failed / 0 cancelled / 0 skipped**, **13356.372852 ms**. Source/tests/scripts/package/lockfile are identical to code-verified `3984477`; the completed local full check remains the code evidence, with fresh exact-head full CI after the docs commit instead of a redundant local full rerun.
- No separate paid-model/service E2E smoke or production dogfood claim. Isolated native Pi/headless Control automated regressions are not production deployment.

Protected live main stays `4d3139b`; old retirement/acceptance/Phase2-A/B/C worktrees are not edited, checked out, reset or cleaned. No tmux/service/tunnel stop/restart/kill, current Pi Session change, configuration/credential change or `~/.pindie` history access. No disk-data migration/deletion. Revert reviewed source/test commits for Git-only rollback; no reverse data migration or production restart is needed.
