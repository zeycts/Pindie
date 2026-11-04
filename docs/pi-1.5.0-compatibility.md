# Pi 1.5.0 compatibility

## Boundary and dependency decision

Isolated implementation based on clean `origin/main` **d5ca71555a8da207a6c9fea32a89c09e2352fa66** (security PRs #312–#314 retained), branch `chore/pi-1.5.0-compat`, worktree `/home/work/projects/Pindie-pi150`. Remote main matched that SHA before worktree creation. Original checkout, production dependencies, services, configuration, credentials and user Sessions are untouched. No merge or deployment is authorized by this audit.

Node **24.22.2**, pnpm **11.22.0**; no Node/engine change. Exact direct and Pi peer pins are **1.5.0**. All eight resolved family packages are 1.5.0: `pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-codemode`, `pi-mcp`, `pi-schema` (new), `pi-telemetry`, `pi-tui`.

Registry `npm view @earendil-works/pi-coding-agent@1.5.0 version dependencies engines dist --json` establishes upstream's exact **undici 8.12.3** and **minimatch 11.0.3** security updates. Remove only the obsolete coding-agent@1.4.0 → undici 8.12.2 override: keeping/repointing it would downgrade upstream's fix. Direct undici **6.29.1**, MCP node/client/server pins, all retained-graph security overrides and browser-use **0.1.15** remain. Lock changes outside Pi are only these upstream security dependencies, new `@isaacs/nonrecursive-glob-match@1.0.3`, and registry deprecation metadata for the unchanged `@smithy/core@3.34.1`.

Sources: [release](https://github.com/earendil-works/pi/releases/tag/v1.5.0), [upstream comparison](https://github.com/earendil-works/pi/compare/v1.4.0...v1.5.0). The [1.4 audit](pi-1.4.0-compatibility.md) is historical deployment evidence, not this upgrade's runbook.

## Tool schemas: demonstrated mismatch, not a schema migration

Reviewed every declaration in `src/tools/{task,gate,memory,git-observe}.ts`, `src/browser-reality.ts`, and bundled `src/vendor/pi-web-search/{web_search,url_context}.ts`. They use JSON-Schema-compatible TypeBox builders or raw DevTools schemas. No `Type.Refine`, `Type.BigInt`, `Type.Undefined`, codecs or `Format.Set` validation reliance was found. Control's Zod transport schemas are separate and unchanged.

Installed `pi-ai/package.json` exports `/compat` with `dist/compat.d.ts`. That file re-exports `index.ts`, whose `utils/string-enum.d.ts` returns pi-schema `Schema<T>`. In contrast, coding-agent `dist/core/extensions/loader.js:56–69` maps **both** root and `/compat` to `pi-ai-extension-view.js`, which implements the release-noted TypeBox `TUnsafe<T>` enum. The alias is an extension-loader feature, not native Node/tsc package resolution.

Exact original `pnpm typecheck` diagnostics (exit 2):

```text
src/tools/gate.ts(76,36): TS2322 kind: {} | null not assignable to HumanGate kind
src/tools/git-observe.ts(245,40): TS2345 action: unknown not assignable to GitObserveParams
src/tools/git-observe.ts(251,75): TS2345 unknown not assignable to GitObserveAction
src/tools/memory.ts(200,13): TS2322 unknown not assignable to ProjectMemoryType
```

An imports-only experiment changed the four StringEnum imports to official `/compat`, leaving every schema unchanged: **the identical diagnostics remained, exit 2**. Native Node also reported `root.StringEnum === compat.StringEnum` as `true`. Thus an import-only fix is insufficient for the actual published artifact. Keep official compat imports and `Type` from `typebox`; wrap only those four enum nodes in `Type.Unsafe<existing union>(StringEnum(...))`. This preserves existing enum JSON, descriptions and accepted values in native Host imports and Pi-loaded extensions; no custom enum helper, enum conversion or pi-schema migration is retained.

`tests/pi-1.5-schema.test.ts` exercises Pi's real `validateToolArguments` across all **28** Pindie semantic/memory/Git/search/browser declarations. It also checks TypeBox enum consumers, required fields, strict object boundaries, min/max items, unique evidence refs, scalar bounds, pi-schema error paths, numeric/boolean/array coercion, optional null omission and transcript-argument immutability. Raw browser schemas now share coercion; no Pindie call site required a policy change. Existing execution/reducer/Gateway tests remain intact.

## Native UI and Browser Reality

Compared installed 1.4.0 and 1.5.0 `dist/modes/interactive/interactive-mode.js`, not only declarations. Idle-observer fields and all 16 instrumented methods remain present. `extensionDialogs` remains a stack; custom factories stay asynchronous, overlays retain independent lifetime, and inline custom dialogs now accept optional blocked-status metadata. Editor replacement while a dialog is open preserves that dialog instead of replacing its slot. Initialization, queued inputs, selector token, renderer overlays, composer identity and shutdown facts retain their roles.

`observeNativeUiIdle` accepts exact **1.4.0 and 1.5.0** only, still rejects unknown shapes/replaced wrappers, and never instruments prototypes. Tests explicitly reject 1.5.1, 1.6.0, 2.0.0, prereleases and unknown strings. Real installed-prototype tests retain asynchronous pre-mount gaps, overlapping prompts, stacked dialogs closed in either order, overlays, selectors, pending input, initialization and shutdown blockers. No idle safety assertion was removed.

Upstream rendering/input changes (incremental tool parsing, cached highlighting, selector paging, terminal escape hardening, regular-mode prompt markers, startup model-scope notice) are inherited. Pindie's layout, fullscreen precedence, keybindings and presentation policy are unchanged. Automated native render/signal tests are not human visual acceptance; terminal/SSH/tmux/IME and live-browser acceptance remain separate review checks.

## Lifecycle, loadout, summaries and shutdown

Compared installed `dist/core/{agent-session-runtime,agent-session,agent-session-services,sdk,session-manager}.js` and InteractiveMode, then inspected Pindie's actual wrappers:

- `src/host.ts:121–194` creates services and calls `createAgentSessionFromServices`; upstream `agent-session-services.js:129` delegates to `createAgentSession`. SDK `sdk.js:289–290` marks the installed ModelRuntime stream function. Pindie does not replace it.
- Upstream `agent-session.js:258–294` leaves summary auth resolution to that marked runtime; compaction, branch and bug-report callers share this path. [#11520 regression](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/test/suite/regressions/11520-sdk-summary-oauth-auth.test.ts) checks branch navigation and **undefined explicit API-key overrides**, not absence of auth resolution.
- `tests/pi-1.5-summary-auth.test.ts` mirrors that scenario through Pindie's real runtime factory/services using public `InMemoryCredentialStore`, synthetic OAuth and a synthetic provider. It calls `navigateTree(targetId, { summarize: true })`, plus separately tests manual compaction and `summarizeForBugReport`. Every provider request gets the synthetic stored token; every `ModelRuntime.getAuth` explicit `apiKey` override is undefined. Each fresh runtime Session retains explicit configured model identity.
- Initial test findings are retained here: an overbroad fixture made **all** getAuth calls throw, producing `Bug report summary failed: Summary must not pre-resolve stored OAuth as an explicit key` (37/38 focused checks passed). Actual `model-runtime.js:452–480` calls getAuth during normal request preparation; upstream's test also expects those calls. Corrected the fixture to observe overrides without prohibiting normal resolution, retaining the no-explicit-key assertion. An attempted root `AuthStorage` import then failed before tests: it is not publicly exported. Replaced it with public `InMemoryCredentialStore`, not a private deep import. Independent final summary test: **1/1 passed**, all three summary APIs exercised. No Pi patch or Pindie auth workaround was needed.
- Runtime replacement implementation changes are path-equality handling for imports; callback ownership, old Session teardown and rebinding remain. `src/pi-runtime.ts` resolves the active Session per operation; subscriptions remain Session-local, with before-invalidate/rebind hooks. Control headless lifecycle tests exercise actual replacement and stale lease invalidation. Long Task rollover and quota resume/fallback still use Host-owned leases and Pi-native hidden turns, not another loop.
- Tool loadout now treats active names as a set: retained tools keep their order; additions append. A regression checks reversed same-set selection preserves declaration order. Existing persisted loadout, selectedTools preflight, custom continuation and rejection safety tests remain. Pindie does not take ownership of visibility.
- Installed ModelRuntime, service construction, core compaction and bug-report implementations are byte-identical between the two installations; the auth correction is in SDK/AgentSession routing. Branch summarization additionally honors context edits and forwards the Session thinking level. Pindie does not replace that summarizer or copy its output into semantic State.
- SessionManager rolls back in-memory append/leaf state when persistence fails, writes forks through one descriptor, and uses platform-aware path equality. These are inherited fixes, not a Session migration.
- InteractiveMode still awaits runtime disposal before native exit; shutdown/signal code is unchanged in the installed comparison. `src/native-interactive-runtime.ts` retains its per-consumer dispose facade and `src/host.ts:337–359` idempotent cleanup. Native normal/signal subprocess and Browser Reality lifecycle regressions remain; crash/SIGKILL cleanup guarantees are not expanded.

Upstream's `gpt-6.1-sol` default/catalog changes do not rewrite Pindie's settings or explicit models. Host still delegates configured/restored model selection to Pi; quota fallback stays opt-in with existing `deepseek/deepseek-flash` legacy/default backup and source-model restoration. A new completely unconfigured Pi session can inherit upstream defaults; this upgrade adds no Pindie default or user configuration change. MCP OAuth metadata/client registration changes are inherited in optional upstream MCP support, not adopted as a new Pindie Control authentication path.

## Verification

All commands run in the isolated worktree with Node 24.22.2 / pnpm 11.22.0. Logs are `/tmp/pindie-pi150-*.log` (audit JSON alongside them); they are local evidence, not committed operational/user data.

- `pnpm install --strict-peer-dependencies` — passed.
- `pnpm install --frozen-lockfile --strict-peer-dependencies` — passed, already up to date; all eight installed family packages independently inspected as exact 1.5.0, including both pi-ai peer snapshots.
- `pnpm audit --json` — exit 0; **0 vulnerabilities** across all severities, 236 total dependencies at audit time. This is registry evidence, not a guarantee against undisclosed issues.
- `pnpm typecheck` — passed after the demonstrated TypeBox compatibility fix. Repository typecheck covers `src/**/*.ts`; runtime tests exercise test fixtures.
- `node --experimental-strip-types --test tests/pi-1.5-summary-auth.test.ts` — **1/1 passed**, no skips (independent run before the final gates).
- Initial broad focused command (below, before adding the separate upstream-mirroring summary file) — **307/307 passed**, no skips, 70.0 seconds.

```sh
node --experimental-strip-types --test --test-concurrency=1 \
  tests/pi-runtime.compatibility.test.ts tests/pi-runtime.integration.test.ts \
  tests/pi-runtime.test.ts tests/pi-1.3-control.test.ts tests/pi-1.5-schema.test.ts \
  tests/native-ui-idle.test.ts tests/native-interactive-runtime.test.ts \
  tests/browser-idle-authority.test.ts tests/browser-reality.test.ts tests/host.test.ts \
  tests/control-headless-lifecycle.test.ts tests/control-workspace.test.ts tests/control-mcp.test.ts \
  tests/long-task-control.test.ts tests/long-task-rollover.test.ts \
  tests/quota-resume.test.ts tests/quota-resume-control.test.ts \
  tests/quota-resume-incident.test.ts tests/quota-resume-supervisor.test.ts \
  tests/quota-fallback.test.ts tests/quota-fallback-control.test.ts tests/quota-fallback-supervisor.test.ts \
  tests/tools.test.ts tests/memory-tool.test.ts tests/git-observe.test.ts \
  tests/web-search.test.ts tests/web-search-entry.test.ts \
  tests/dependency-security.test.ts tests/retained-dependency-security.test.ts \
  tests/watch-native-presentation.test.ts
```

### Final gates and self-review

- First `pnpm run check` — **exit 1, 1243/1244 passed**, no skips, 182.5 seconds. The isolated preview stopped at `scripts/work-memory-preview.ts:15`: installed `1.5.0 !== 1.4.0`. Updated only its exact version guard/comment and matching stdout assertion/test label; retained network/credential isolation and all Ctrl+S, Session and Host assertions.
- Scanned `src`, `scripts`, `tests`, package/workspace config and `AGENTS.md` for active 1.4 assumptions. Updated the current audit pointer and catalog-test label. Reverted an unnecessary disposal-comment edit: `src/native-interactive-runtime.ts` has no upgrade diff because the implementation already works unchanged. Kept historical 1.3/1.4 introduction labels, vendor provenance comments and the intentional 1.4 idle allowlist/regression. Historical compatibility docs were not rewritten.
- `node --experimental-strip-types --test --test-concurrency=1 tests/work-memory-preference.test.ts tests/pi-1.5-schema.test.ts tests/pi-1.5-summary-auth.test.ts tests/native-ui-idle.test.ts` — **exit 0, 21/21 passed**, no skips, 26.8 seconds. Includes configured and unconfigured isolated native preview smoke.
- Final `pnpm run check` — **exit 0, 1244/1244 passed**, no skips, 187.6 seconds, after successful `tsc --noEmit`. This is the documented full gate; the repository has no separate lint/build scripts.
- Inspected `scripts/pi-smoke.ts` usage/lifetime handling first. The smoke below uses a newly allocated namespace and retains only its own artifacts. It launches no production runtime; selected tests use temporary storage/synthetic providers.

```sh
smoke_tmp=$(mktemp -d /tmp/pindie-pi150-smoke-XXXXXX)
TMPDIR="$smoke_tmp" PINDIE_KEEP_ARTIFACTS=1 pnpm smoke -- pi150-compat --timeout-ms 120000 -- \
  bash -c 'node --experimental-strip-types --test --test-concurrency=1 tests/pi-1.3-control.test.ts tests/control-mcp.test.ts tests/native-ui-idle.test.ts tests/pi-1.5-schema.test.ts tests/pi-1.5-summary-auth.test.ts > "$PINDIE_SMOKE_DIR/tests.log" 2>&1'
```

Smoke: **exit 0**, `pi-smoke: command succeeded`; child **20/20 passed**, no skips, 13.6 seconds. Retained log: `/tmp/pindie-pi150-smoke-O6h76D/pindie-1001/smoke/pi150-compat-k8jFDm/tests.log`.

Complete source/test/package/lockfile diff reviewed, including new files. Frozen install and all eight package versions verified; `pnpm audit --json` returned zero vulnerabilities. `git diff --check` passed. Original checkout remains clean at d5ca715; no existing branch/worktree was removed. No test skips, filters or repository test-glob changes were used to manufacture green.

Production rollout, real-provider OAuth/network acceptance, human native-terminal visual acceptance and independent PR review remain unperformed and require separate human action. The isolated worktree and preview script remain available for review; production was untouched.
