# Pi 1.3.0 compatibility audit

## Scope and published packages

Upgrade from exact 1.0.3 to exact **1.3.0**, based on fresh `main` at `8a1ed38c4c66f324bc3b548b70ee507561c49ba6`. Earlier compatibility audits remain recoverable from Git history, not current patch requirements. Implementation, installation and verification used a separate `chore/pi-1.3.0-compat` worktree; no production Host restart, dependency installation in the live checkout, user configuration migration or paid inference.

Audited actual npm metadata and tarballs for `@earendil-works/{pi-ai,pi-coding-agent,pi-tui,pi-agent-core,pi-codemode,pi-mcp,pi-telemetry}`. npm's stable `latest` is 1.3.0, published **2026-10-15 19:13:30.662 UTC**. All seven tarball SHA-512 values match both npm `dist.integrity` and the lockfile. Every published file in these packages matches the installed file byte-for-byte (including both pi-ai peer snapshots).

- The three direct pins are exactly 1.3.0. The seven remaining Pi-family packages resolve only to 1.3.0; published internal Pi dependency pins are now exact, not caret ranges. pi-ai has two peer-resolution snapshots, not two versions.
- No unrelated external package record changes or upgrades. The lockfile removes chord and its now-unused esbuild/platform packages, updates Pi versions/integrities and dependent peer-resolution labels, and removes the patch hash. Browser extension stays **0.1.15**. Obsolete chord release-age and esbuild build-policy entries are removed; release-age exceptions follow the seven exact Pi versions.
- Node requirement remains **>=22.19.0** throughout; verified with **Node 24.21.0 / pnpm 11.22.0**. Pindie has no separate build script: its TypeScript build gate is `pnpm typecheck` / `pnpm run check`.
- Published coding-agent exports remove the old **source-only** `./client` and `./experimental/plugin` entries. pi-codemode adds `./portable` and `./cloudflare`. Other audited export maps are unchanged. Pindie's public root SDK, pi-ai `/compat` and TUI imports remain supported and typecheck. No source imports of chord, experimental Pi client/protocol/server packages or removed paths exist in `src`, `scripts` or tests.

## Skipped releases reviewed semantically

| Release | Relevant upstream changes | Pindie compatibility decision |
| --- | --- | --- |
| 1.0.4 | Tool wildcard selection; `--tools` retains MCP tools by default unless explicitly constrained; `prepareLoadout` prompt-guideline/hidden-declaration corrections | Host uses SDK resource factories, not CLI built-in extension selection. No codemode/tool_search/MCP adoption. Existing active-loadout and Gateway boundaries remain authoritative. |
| 1.1.0 | `+name`/`-name` tool selection; `agent_settled.aborted`; optional OSC 7501 program status | Verify modifier precedence and aborted settlement; no new lifecycle loop, cancellation policy or terminal defaults. |
| 1.2.0 | Native custom-trigger preflight; discriminated event envelope; startup/preflight counts as busy; queue/abort handling; pending nextTurn delivery; `reachesTools` and namespace aliases; schema validation; chord/experimental stack removal | Retire downstream patch after native behavioral proof. Use exact customType for quota resume. Test busy preflight/queue/abort and retain isolated SDK tool/resource loading. Pindie does not register a tool orchestrator or adopt new CLI MCP selection. |
| 1.3.0 | Exact family pins; resumed active tools and modifier overlays; model-switch thinking cleanup; Kimi Chat Completions `/v1`; provider ambiguity fix | Verify resumed tools and explicit overrides. Preserve exact provider/model lookup and quota fallback source thinking preservation. Inherit provider fixes without config migration. |

No `kimi-coding` endpoint/configuration is present in repository source, scripts or tests. Users overriding that provider must independently ensure their base URL includes `/v1`; no private user configuration was inspected or changed. Cross-model thinking removal and credential-aware/ambiguous provider matching are upstream behavior, not a new Pindie model-selection policy. Existing exact-model, model switching, native thinking clamp/restore and quota recovery regressions remain green; real provider wire behavior is a residual manual check.

## Patch retirement gate: pristine published Pi passes

**Removed** `patches/@earendil-works__pi-coding-agent@1.0.3.patch`, `patchedDependencies` and its lockfile selection. No 1.3.0 patch is introduced.

The original 11 behavioral contracts pass against pristine published **1.3.0**. Only assertions tied to the historical envelope changed: native custom events expose `messageType: "custom"` plus `message`, **not** `prompt`. Assertions still require the actual hidden custom trigger, before branch append, exactly one preflight/settlement, and all prior effects. Test labels now name 1.3.0. Quota production code no longer uses hidden-content equality or the latest branch entry: only the native current event's customType can request resume refresh. User text matching the hidden marker and unrelated custom types do not impersonate resume.

The expanded contract has **17/17 passing**, both normally installed and through a Node resolve loader redirecting coding-agent imports to the **detached extracted npm tarball** (`dist/index.js`), with dependency resolution linked to the isolated install. The extracted and installed agent-session implementations are byte-identical. No GitHub-source build, patched reference or assertion weakening is used as native proof.

Covered invariants:

- idle custom trigger runs fresh preflight, applies injected context and a one-Run system override;
- explicit `systemPromptOptions.selectedTools` beats a live loadout edit; otherwise live tool changes survive preflight;
- one-Run override restores the base on a successor, and prompt/injected context survive a real tool-call round trip;
- fallback and quota triggers remain hidden, delivered once, with quota identity available before append;
- custom trigger Promise covers the complete Run; settled successor is a new preflight/Run;
- `agent_before_settle` continuation remains one Run, one initial preflight and one final settlement;
- pending `nextTurn` messages accompany both user/custom starts; messages sent during preflight queue into that Run, not a competing Run;
- user/custom preflight is busy; user delivery without a queue mode rejects; preflight abort executes no provider request and emits exactly one `agent_settled` with `aborted: true`;
- resumed active tools are preserved, modifier overlays and explicit replacement stay authoritative;
- SDK/Host have no unexpected `codemode`, `tool_search`, `mcp__*` or built-in MCP extensions/commands.

The expanded native contract can be rerun with:

```sh
node --experimental-strip-types --test tests/pi-runtime.compatibility.test.ts
```

For detached verification, `npm pack @earendil-works/pi-coding-agent@1.3.0`, extract into a disposable directory, give that package dependency lookup from the isolated install, and redirect the exact coding-agent package specifier to the extracted `dist/index.js` with a Node resolve loader. Run the same test unchanged with `--loader <loader.mjs>`.

## Control, quota and TUI

New `tests/pi-1.3-control.test.ts` uses real Pi with a faux provider, blocked native preflight and temporary project/agent/Pindie storage. It asserts busy before `agent_start`, `now → steer` / `after_current_run → followUp`, queued versus handled dispositions, no fabricated handled messages, exactly-once accepted timeline delivery, event-driven settled wait remaining pending during preflight, stop/queue-clear/preflight abort, `agent_settled.aborted`, replacement and stale lease rejection. Existing tests retain accepted-but-unsettled-before-agent_start, Session/reader rebinding, stale Session/generation and transport contracts. `preflightResult("started")` now follows asynchronous preparation but still precedes `agent_start`; Control need not invent an earlier acceptance event. Settled waiting continues to require idle + automatic work settled + empty queues + no quota wait, not just `agent_end` or the notification's aborted flag.

Quota refresh remains detached/fail-soft, once per quota-resume start, without blocking preparation or changing State. Automatic fallback/resume successors and same-Run continuation preserve their existing ownership and exactly-once semantics. No Control, Host, quota-policy or UI refactor was necessary.

TUI policy stays **explicit Host override → explicit effective Pi setting → regular fallback**, in both production Pi InteractiveMode and the owned shell. No adoption of fullscreen default. Existing six-case precedence coverage and TUI/action tests pass. Home/End remain editor line movement; Ctrl+Home/End control fullscreen transcript bounds. Upstream fixes shifted-symbol keys, terminal reply fragmentation, fullscreen selection across Session changes and overlay ownership. EIO/raw-mode handling remains upstream; OSC 7501 and OSC 52 are optional Pi capabilities, not enabled by Pindie. No keybindings/settings files are rewritten.

## Sequential verification and limits

Heavy suites ran sequentially (not concurrent suite invocations). Passed before final full-check/CI delivery:

| Check | Result |
| --- | ---: |
| Pristine detached native contract | 17/17 |
| Control/client/workspace/MCP/headless/monitor/spikes + new preflight Control tests | 69/69 |
| Host/runtime/Session/long-task Control | 61/61 |
| Quota resume/fallback/control/supervisors | 69/69 |
| Browser Reality | 27/27 |
| TUI/actions | 58/58 |
| Extension regressions including quota trigger discrimination | 240/240 |
| `pnpm typecheck` | pass |
| Frozen strict-peer install, including forced reinstall | pass |
| Published artifact/integrity/family/lockfile audit | pass |
| Owned smoke and isolated headless Control MCP end-to-end | pass |

Owned smoke used `pnpm smoke -- pi130-headless --timeout-ms 60000 -- node --experimental-strip-types <disposable-dogfood.ts>` with a private temporary smoke namespace. The disposable script runs actual Pindie loopback MCP transport/client → headless Host → real Pi/faux provider: open project, accept input while unsettled, wait for settlement, exactly-once timeline, replace Session/PresentationReader, rotate lease and reject stale input. All project/agent/Pindie state is temporary. Final full `pnpm run check`, whitespace and GitHub CI results are recorded in the PR.

Residual manual checks: live-provider inference, OAuth refresh and Kimi/provider wire behavior; actual terminal visuals, SSH/tmux/IME and optional fullscreen/OSC interaction; live Chrome visual dogfood. Automated Browser Reality tests are not a live Chrome claim. Production rollout/restart and merge are deliberately left to the human reviewer.
