# AL / SI / CPL retirement — Phase 1

Status: production hard isolation for review, **not merged/deployed**. This approved retirement contract supersedes the historical Learning target and SI/CPL integration-preservation requirements. Phase 2 deletion is not included.

## Production boundary

- `composition.ts`: AL/SI/CPL always resolve false. Old environment values (including malformed values) and direct overrides are ignored. Learning dependency injection is discarded without reading the retired properties. No StrategyKnowledge, Experience, WorkEpisode or Trial store is constructed. Remote, Work Memory, Skills, presentation, semantic stores and quota preferences keep their existing selection.
- `host.ts`: remove Learning runtime imports, ledger/model/scheduler construction, discovery enqueue, Learning lifecycle extension, kick/preemption and shutdown paths. Retired input types/callbacks are inert compatibility only. No Learning resource exists to launch or dispose.
- `extension.ts`: remove SI/CPL assembly, tools/commands, preparation, ordinary-Trial placement/context, selector resolver and Experience/TrialEvidence settlement. Core lifecycle, native continuation, Human Signal, quota, remote and presentation remain.
- `core-integration.ts`, `semantics.ts`, `context.ts`: no Policy registration/capability, Seed/Policy/advisory prompt or learned-selector use. Known retired tool names remain classified as unavailable `policy.*` effects so captured user tool baselines cannot bypass the Gateway. The legacy capability names are compatibility types, never Core grants.
- `run-integration.ts` uses the independent `RunCounters` in `run-counters.ts`: bounded runtime execution/error facts only, no policy attribution, artifact parser, learning import or persistence. These counters retain a real Core consumer: settlement/handoff diagnostics.
- WorkEpisode has **no non-learning consumer**. Composition no longer mounts its ledger; Runtime load/dispatch no longer reconcile, prepare, commit or notify it. Deprecated signatures/null getters remain inert for Phase 1 source compatibility, not a new Core episode contract. Task occurrence/external-state epochs remain because they also protect current semantic authority and handoff.

The emitted production import graph rooted at Host, Extension, Core and Control is tested transitively, including relative dynamic imports/requires: retired runtime modules must be unreachable. Type-only legacy interfaces erase at runtime. Standalone historical implementations are still directly importable for research/unit tests; this is not a sandbox against arbitrary code and is not a production activation API.

## Preserved and untouched

Core Task/Verification/Gate/reducer semantics, Session/Run coherence, Attention/Human Signal, Control API, Browser Reality, quota resume/fallback, Remote, Work Memory, native Skills, git workflow and Pi runtime remain. No dependency versions change. No data migration or deletion occurs.

Implementation is confined to `/home/dev/projects/Pindie-al-retirement`, branch `feature/al-retirement-phase1`, based on main `4d3139b641571a7c32c90c1c7acea85d2ea4645c`. No live-main checkout/edit, service change/restart, paid model call or historical `~/.pindie` mutation is part of this work. Tests use an isolated HOME/cache/tmp under `/tmp/pindie-al-retirement`.

## Verification and honest legacy status

- `pnpm run typecheck` passed after correcting two initial Extension type errors.
- New `tests/al-retirement.test.ts`: flags/overrides cannot revive Learning; poisoned injections/WorkEpisode ledger cannot be accessed; Core/Memory registration survives; retired calls fail closed; advisory is absent; emitted production import graph excludes Learning/Policy.
- Core/Pi integration tests were adjusted narrowly to assert retired Policy absence instead of requiring its registration. No test files were deleted, no legacy test was skipped or disabled to make the suite green.
- Bounded sequential regression command: **437 tests passed, 0 failed, 0 skipped**. Files: `al-retirement`, `core-integration`, `host`, `pi-runtime.integration`, `control-*`, `quota-*`, `browser-*`, `human-signal`, `remote-companion`, `reasoning`, `tools`, `state`, `transitions`, `store`, `run-facts`, `execution-integration`, `verification-evidence`, `task-metrics`, `task-continuity` (`tests/*.test.ts` names). This includes native Pi + faux-provider Host replacement/hidden-resume and bundled git-workflow Skill checks; it is not live-service or native Windows dogfood.
- The unchanged full legacy suite is **not green**. An initial Core batch hit its 120s bound; a broader diagnostic run (concurrency 4, per-test 15s, outer 150s) also timed out. These are diagnostics, not full-suite pass counts. Final `timeout -k 5s 90s ... pnpm run check` exited **124**: typecheck completed, old composition/context expectations failed, and the overall test run was stopped at the safety deadline. Pending-file cancellation messages after termination are not independent test failures. No claim that all historical tests pass.

### Failure classification / follow-up

1. **Obsolete production Learning expectations:** composition opt-in/matrix/WorkEpisode tests; Extension SI/CPL commands, preparation, trust/Policy, Experience/Trial attribution; F1 Runtime episode integration; F2 Host scheduler; D1/D2 Host discovery; native Pi Trial overlay/offer tests. Their expected behavior is intentionally removed. Retain the tests for review now; replace/archive/remove only in the accepted Phase 2 cleanup. Standalone artifact/store/contract tests are not automatically obsolete.
2. **Core tests with mixed old assumptions:** `context.test.ts`, `semantics.test.ts`, `execution-semantics.test.ts`, parts of `extension.test.ts` require Policy eligibility/text or exact old tool counts. Handoff/metrics tests sometimes require an Experience write before continuity. Preserve their actual Core assertions while removing only obsolete Learning expectations in follow-up. Do not label an entire mixed test file obsolete.
3. **Unresolved resource/timing diagnostics:** broad triage also reported evaluation packet/run capacity and recovery successor tests timing out, and a Linux owned-descendant timeout assertion. Their cause is not established by this run; do not claim those passed or were caused solely by retirement. The focused Browser group passed sequentially. Full legacy-suite remediation remains open.

A non-green full CI is expected with the unadapted legacy assertions. This PR is a review/rollback boundary, **not merge-ready based on full-suite verification**. Do not merge until the agreed acceptance decision and follow-up verification.

## Rollback and Phase 2

Rollback is Git-only: revert Phase 1 commits on a reviewed branch. Historical bytes/schema are unchanged, so there is no reverse data migration. Do not deploy/restart a production Host merely to test rollback.

After Phase 1 acceptance, separately inventory/delete unreachable `learning-*`, discovery/hypothesis/lineage, trial/overlay/evidence, evaluation/evaluator/recovery, SI/CPL strategy/trust/knowledge and Experience implementations plus associated tests/fixtures. Remove inert compatibility options/results/types and unused helpers; simplify old capability classifications only while preserving explicit fail-closed handling of retired tool names. Reconcile historical docs and mixed Core tests. Retain independent Core counters and real authority epochs, not Learning episode machinery. Any archival/deletion of historical data needs separate explicit authorization; never delete a project namespace, State/continuity, global preferences, remote routing or user sessions as a shortcut.
