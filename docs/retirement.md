# AL / SI / CPL retirement

Stable Mode never mounts Learning jobs, Policy/Strategy tools/commands, advisory or Experience persistence, regardless of old flags/injections. Retired `policy.*` effects remain classified for denial, never Core grants. Task/State/Run/Session/Verification/Gate, metrics/counters, continuity/rollover, Quota, Browser, Remote, Memory, native Pi/TUI/Skills and Control keep their existing authority. Code deletion never authorizes historical user-data access, migration or deletion.

## Accepted evidence

Merge is not deployment. Old phase prose is in Git; this table and exact manifests retain the review trail without a roadmap.

| Slice | Merged PR / SHA | Recorded evidence | Exact audit |
| --- | --- | --- | --- |
| Phase1 isolation | [268](https://github.com/zeycts/Pindie/pull/268), `d89ff6b` | 1600 active; CI #625 recorded acceptance head `3ae44b0`, [run](https://github.com/zeycts/Pindie/actions/runs/39294952295) | [81 archived cases](../tests/archive/al-phase1/manifest.json), unchanged historical source |
| 2-A Evaluation/Recovery | [269](https://github.com/zeycts/Pindie/pull/269), `bf14847` | CI #628: 1397/1397 | [graph](al-phase2-a-deletion-graph.json) |
| 2-B scheduler/Discovery execution | [270](https://github.com/zeycts/Pindie/pull/270), `a66e47d` | CI #630: 1344/1344 | [graph](al-phase2-b-deletion-graph.json) |
| 2-C orphan SI/CPL integration/stores | [271](https://github.com/zeycts/Pindie/pull/271), `aa7b741` | CI #632: 1340/1340 | [graph](al-phase2-c-deletion-graph.json) |
| 2-D Trial/Hypothesis/retention | [272](https://github.com/zeycts/Pindie/pull/272), `1e9865f` | CI #635: 1304/1304 | [graph and 17 dead design deletions](al-phase2-d-deletion-graph.json) |
| 2-E Candidate execution island | [273](https://github.com/zeycts/Pindie/pull/273), `ad8ce52` | CI #637: 1284/1284 | [graph](al-phase2-e-deletion-graph.json) |
| 2-F Strategy knowledge/Scope/Synthesis review | [274](https://github.com/zeycts/Pindie/pull/274), `4f7416d` | CI #640: 1270/1270 | [graph](al-phase2-f-deletion-graph.json) |
| 2-G Trial runtime leases and packets | [275](https://github.com/zeycts/Pindie/pull/275), `ccdb5ca` | CI #642: 1260/1260 | [graph](al-phase2-g-deletion-graph.json) |
| 2-H final frontier: Policy tool factory, Trial offer contract | Draft PR (this branch) | exact-head CI pending | [graph](al-phase2-h-deletion-graph.json) |

Archive tree SHA: `ae453acf3c16ef139a5d22bd68cf999546c7b6f9`. The archive is frozen test source, not current runtime guidance. A minimal [Phase1 bridge](al-retirement-phase1.md) stays because its untouched README refers to that path. Removed phase prose can be recovered at the Phase2-E base below.

## Phase 2-E: Candidate execution island

Base **`1e9865f22f93c83d3a4a87c672e2fcf5862832ce`**. New worktree `/home/dev/projects/Pindie-al-phase2e`, branch `feature/al-retirement-phase2e`; independent Draft PR, no automatic merge/deploy. [Explicit manifest](al-phase2-e-deletion-graph.json) records every source path, incoming/outgoing type/runtime/dynamic edges, negative references, removed TAP title and retained-test body digest.

Delete eight standalone execution/control modules: Adaptation packet/lease, Global Derivation reservation/lease, three Candidate creation tools, Candidate command projection, Candidate resolution and Learning-specific immutable-publication helper. Keep Candidate/Decision/Trust readers/stores, Policy/Experience schemas and their valid tests: those have substantial retained consumers. No prefix deletion or replacement runtime. Only retained source change is erasing the GlobalDerivationRuntime import and narrowing its always-null Extension accessor to `null`; runtime emission stays identical. Core/shared types are not guessed or truncated.

All eight affected test files remain active, including all five generic Core bounded-operation cases, telemetry exclusion for retired calls, Seed/Policy checks and artifact-store/history parsing. Only 20 cases for removed AL execution interfaces disappear. Actual baseline/current TAP comparison includes every generated/nested case; unaffected bodies are byte-identical (digests in manifest).

| File | Baseline | Retained | Removed AL-only |
| --- | ---: | ---: | ---: |
| strategy-adaptation | 11 | 6 | 5 |
| strategy-derivation | 12 | 9 | 3 |
| strategy-synthesis-candidates | 8 | 4 | 4 |
| strategy-derivation-decisions | 4 | 3 | 1 |
| strategy-trial | 11 | 10 | 1 |
| liveness | 11 | 5 | 6 |
| al-retirement guards | 5 | 5 | 0 |
| execution-semantics guards | 16 | 16 | 0 |

**1304 = 1284 retained active + 20 retired-only cases.** No added registrations, skip/filter, glob/script/lockfile change or archive edits. Guards require deleted sources absent, retired tool effects still `policy.*` and denied, inert global accessor exposing no runtime type, and no emitted Learning imports from Core/Host/Control.

Evidence: frozen offline install and typecheck passed; affected baseline **78/78**, retained **58/58**, focused Extension/composition/native Pi/Control/Quota/Browser **260/260**, all zero fail/cancel/skip. The first full run had **1283 pass / 1 fail / 0 cancel / 0 skip**: a computed tool-directory inspection still expected the three deleted factories. Its original mixed case is retained, now distinguishing physical factories from legacy fail-closed classifications; all four retired names are denied in derived idle/active/unavailable states. Exact Core/Memory registration is separately asserted. Baseline/current execution guard titles remain 16/16. Corrected full `timeout -k 5s 480s ... pnpm run check`: **1284 pass / 0 fail / 0 cancel / 0 skip**, **151083.291147 ms**, exit 0, typecheck first. Only documentation/results changed afterward. All 37 unmodified test bodies match base digests; Extension emitted runtime is identical. Document checks cover 19 Markdown files / 30 local links; diff/archive checks passed. Exact-head CI is recorded on the Draft PR only after observation. Tests use isolated `/tmp/pindie-al-phase2e-u4Ds1s` HOME/cache/tmp and temporary agentDir/cwd; only pnpm validation metadata is reused. No paid-model/service E2E or new production dogfood is claimed.

The four previous Phase2 narrative files are physically removed, consolidated here; their exact base and PR/CI/JSON sources stay reproducible. No new obsolete-doc archive is created. [Architecture](architecture.md), [behavior](behavior.md), Control/Quota/Remote/Pi/TUI/long-task documents and native Skills remain current.

## Phase 2-F: Strategy knowledge, Scope orchestration, Synthesis review

Base **`ad8ce52aa93ec2428b68eabe9f28498c705a11b4`** (merged #273). Worktree `/home/dev/projects/Pindie-al-phase2f`, Draft branch `feature/al-retirement-phase2f`. [Explicit manifest](al-phase2-f-deletion-graph.json) records every incoming/outgoing type/runtime/dynamic edge, negative references, removed TAP titles and retained-body digests.

Delete four modules with no production consumer: portable StrategyKnowledge snapshot store plus its schema re-export, Scope transfer Candidate/Decision orchestration with its command projection, and Synthesis promotion review/decision orchestration. **Zero retained source changes**; Extension's inert `scopeProjectTrustReader`/Strategy type ports are untouched. Shared Scope project-trust review, cross-project Trial validation, Candidate/Decision stores, portfolio/trust safety, Policy and Experience schemas keep their retained consumers and active schema/store tests. No prefix deletion, replacement runtime or type truncation.

Delete the standalone `strategy-knowledge.test.ts`. Four other mixed files keep every Core/schema assertion; only API-specific cases disappear. Retained bodies are byte-identical except the retirement guard, which intentionally gains four physical-absence assertions.

| File | Baseline | Retained | Removed AL-only |
| --- | ---: | ---: | ---: |
| strategy-trust-scope | 13 | 10 | 3 |
| strategy-trust-scope-slice-d | 7 | 3 | 4 |
| strategy-synthesis-review | 8 | 2 | 6 |
| strategy-knowledge (deleted) | 1 | 0 | 1 |
| al-retirement guards | 5 | 5 | 0 |
| composition guards | 12 | 12 | 0 |

**1284 = 1270 retained active + 14 removed AL-only cases.** No added registrations, skip/filter, glob/script/lockfile change or archive edits. Guards keep the exact selected Core/Memory registry, retired `policy.*` denial, emitted-graph boundaries and physical absence of every deleted module.

Evidence: frozen offline install and typecheck passed; affected baseline 28/28 plus 1/1, retained 15/15, focused Extension/native Pi/Control/Quota/Browser plus retirement/execution guards **269/269**, all zero fail/cancel/skip. Full bounded `timeout -k 5s 480s ... pnpm run check`: **1270 pass / 0 fail / 0 cancel / 0 skip**, **144955.078712 ms**, exit 0. Only manifest/docs/results changed afterward. Home/cache/tmp isolated at `/tmp/pindie-al-phase2f-g4hd8M`; no paid-model/service E2E or production dogfood claimed. Exact-head CI is recorded on the Draft PR only after observation.

## Phase 2-G: Trial runtime leases, packets and admission

Base **`4f7416dfb2094abc9a24318da7383502d2c7e33f`** (merged #274). Worktree `/home/dev/projects/Pindie-al-phase2g`, Draft branch `feature/al-retirement-phase2g`. [Explicit manifest](al-phase2-g-deletion-graph.json) holds every type/runtime/dynamic edge, negative reference, removed TAP title and the accounting.

Delete three Trial runtime modules with no production mount: ordinary `TrialRuntime`/packet/selector admission, Synthesis Trial orchestration, and Scope Trial binding/command values. `src/extension.ts` only erases the `TrialRuntime` type-only import and narrows its already-null `trial` accessor to `null`; TypeScript-emitted Extension runtime is byte-identical to base. Every other retained source file is untouched, and Strategy Candidate/Decision/Derivation/Portfolio/Trust-Safety/Scope-Review stores, Policy, Experience/WorkEpisode/learning-v1 schemas keep their consumers and tests.

| File | Baseline | Retained | Removed AL-only |
| --- | ---: | ---: | ---: |
| strategy-trial | 10 | 6 | 4 |
| strategy-trust-scope | 10 | 8 | 2 |
| strategy-synthesis-trial (deleted) | 4 | 0 | 4 |
| extension (import only) | 180 | 180 | 0 |
| al-retirement guards | 5 | 5 | 0 |
| composition guards | 12 | 12 | 0 |

**1270 = 1260 active + 10 removed AL-only cases.** All retained bodies are byte-identical to base except the retirement guard's added absence assertions. No skip/filter, glob/script/lockfile change or archive edit.

Evidence: frozen offline install and typecheck passed; affected baseline 24/24 plus 4/4, retained 14/14, focused native Pi/Control/Quota/Browser/execution-semantics/Policy **92/92**, all zero fail/cancel/skip. Full `timeout -k 5s 480s ... pnpm run check`: **1260 pass / 0 fail / 0 cancel / 0 skip**, **149233.323153 ms**, exit 0. Isolated HOME/cache/tmp `/tmp/pindie-al-phase2g-O83Xnk`; no paid-model/service E2E or production dogfood claim. Exact-head CI is recorded on the Draft PR only after observation.

## Phase 2-H: final source-retirement frontier

Base **`ccdb5ca2fb295faaa2b705382c125f0c2c1a8b23`** (merged #275). Worktree `/home/dev/projects/Pindie-al-phase2h`, Draft branch `feature/al-retirement-phase2h`. [Explicit manifest](al-phase2-h-deletion-graph.json).

Reachability audit from Core production entrypoints (`host`, `extension`, `composition`, `control-workspace`, `control-mcp`, `core-integration`): **73** src files runtime-reachable, **34** runtime-unreachable but retained through type-only seams or artifact/test consumers, **8** fully unreachable. Six of those eight are independent Control/Pindie CLI entrypoints, not Learning code. The last two were the only remaining AL-only sources:

- `src/tools/policy.ts` — retired `pindie_policy_set` factory, never registered by production; effect classification stays in `execution-semantics` and remains denied.
- `src/trial-offer-contract.ts` — only the passive frozen-history fixture consumed it; no storage, protocol or migration caller. Its recorded default-policy fingerprint is inlined and verified identical.

Core entrypoint emitted runtime is byte-identical to base. Extension's inert Strategy/Trust/Policy/WorkEpisode type seams remain as the reviewed compatibility boundary, and no retained store, reader, Policy contract, Experience/WorkEpisode implementation or historical fixture was removed.

| File | Baseline | Retained | Removed AL-only |
| --- | ---: | ---: | ---: |
| policy | 8 | 5 | 3 |
| strategy-adaptation | 6 | 6 | 0 |
| execution-semantics guards | 16 | 16 | 0 |
| al-retirement guards | 5 | 5 | 0 |
| trial-offers-pi | 2 | 2 | 0 |
| trial-overlay-pi-r2 | 9 | 9 | 0 |
| learning-foundation-f1 | 3 | 3 | 0 |
| trial-evidence-r3 | 1 | 1 | 0 |

**1260 = 1257 active + 3 removed AL-only cases.** Only the three factory-only `pindie_policy_set` cases are retired. Both mixed historical-schema cases are restored with every non-tool assertion and their original titles, including `createPolicySnapshotFromRevisions`/`createStrategyRevisionSelection`/`serializePolicySnapshot`/`policySnapshotIdentity`/`formatStrategySelectionLabel` identity and presentation behavior. The Core contract exclusion guard is kept under a corrected title (it no longer names a deleted factory) and still asserts no Seed/`Current Policy Snapshot`/`pindie_policy_set` guidance. Exact tool classification/denial and every native historical-bytes case remain active. No skip/filter, glob/script/lockfile change or archive edit.

Evidence: frozen offline install and typecheck passed; policy **5/5**, strategy-adaptation **6/6**, retirement **5/5**, both native history files **2/2 + 9/9**, extra F1 **3/3** and R3 **1/1**; focused native Pi/Control/Quota/Browser/execution-semantics/composition/extension **276/276** and the full suite, all zero fail/cancel/skip. Full `timeout -k 5s 480s ... pnpm run check`: **1257 pass / 0 fail / 0 cancel / 0 skip**, **147112.576117 ms**, exit 0. Isolated HOME/cache/tmp; no paid-model/service E2E or production dogfood claim. Exact-head CI is recorded on the Draft PR after observation.

**Retirement STOP decision:** no further AL-only production source island exists. Remaining runtime-unreachable modules are consumed by retained artifact/stores, mixed tests or frozen historical-contract readers, and their type-only Extension seams are deliberate compatibility, not mounts. Further source deletion would require removing real guard coverage for zero production benefit, so this is the end of source retirement — the next step is a separately authorized production-upgrade plan.

## Production upgrade gate

Source retirement is complete. Retained Strategy/Trust/Policy stores, Scope/Synthesis review, cross-project evidence code and Experience/WorkEpisode/learning-v1 contracts are inert fail-closed compatibility surfaces, not a backlog; they must not be reactivated through flags, injections or new production imports. Historical user data is never migrated or deleted by cleanup.

Protected live main remains `4d3139b`; all old worktrees are unchanged. No service/tmux/tunnel stop/restart, active Pi Session switch, user config/credential or `~/.pindie` historical-data access. Production upgrade requires **separate explicit approval**, reviewed merged SHA, isolated acceptance and an independently authorized deployment/rollback plan. A green Draft PR does not authorize it. Git-only source rollback needs no data migration.
