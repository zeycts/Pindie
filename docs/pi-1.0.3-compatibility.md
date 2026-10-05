# Pi 1.0.3 compatibility audit

## Incremental 1.0.2 → 1.0.3 audit

Scope: exact-pin compatibility maintenance from merged PR #264 on `main`. No runtime, Control, Session, Learning, model/reasoning/quota policy, TUI ownership, MCP or codemode redesign/adoption. The [1.0.2 audit and retained 1.0.1 history](pi-1.0.2-compatibility.md) remain historical evidence; this document records only new findings.

### Published artifacts and dependency delta

Audited actual npm tarballs/metadata for **1.0.3 (2026-10-05)**: `@earendil-works/{pi-ai,pi-coding-agent,pi-tui,pi-agent-core,chord,pi-codemode,pi-mcp,pi-telemetry}`. Downloaded tarball SHA-512 values match npm `dist.integrity` and all eight lockfile integrity entries.

- Direct `pi-ai`, `pi-coding-agent`, `pi-tui` pins: exactly **1.0.2 → 1.0.3**. The five related family packages also resolve to 1.0.3, following published family dependency ranges (`^1.0.3`). All published external dependency/peer ranges and package export maps are unchanged. Node requirement remains **>=22.19.0** (verification used Node 24.21.0).
- Actual lockfile delta is only those eight family versions/integrities, patch version selector, and dependent/peer-resolution labels. Normalizing these changes reproduces the old lockfile exactly. No external dependency upgrade, cleanup or deduplication; Browser extension remains 0.1.15. Release-age exceptions follow the new exact family versions.
- Published coding-agent `dist/index`, SDK factory, AgentSession, AgentSessionRuntime, AgentSessionServices, SessionManager, DefaultResourceLoader, SettingsManager and ExtensionRunner implementations/declarations are byte-identical to published 1.0.2. Installed files match pristine 1.0.3 except the intentional agent-session.js patch. Pindie's actual imports/usages typecheck, including `createAgentSession`, `createAgentSessionServices`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, Extension APIs and Host/quota/Learning model/runtime lookup. No adapters required.
- Upstream OAuth refresh now persists rotated credentials despite caller cancellation once refresh starts. This is an inherited Pi fix, not a Pindie quota-policy change; live OAuth/provider wire behavior is not deterministically verified here.
- Stricter user-only output-file permissions and terminal EIO/raw-mode shutdown handling are inherited improvements. Catalog refreshes, generated bundles/maps and package/example metadata also change. Azure Foundry Chat Completions, codemode image files and codemode/MCP implementation changes are not adopted. Installation of transitive packages does not activate CLI extensions.

### Azure breaking change: not applicable to current Pindie source integration

Provider ID `azure-openai-responses` becomes `azure`, with corresponding provider imports/model names; `AZURE_OPENAI_*` environment variables remain unchanged. The published coding-agent model-resolver delta is only that default-provider key rename.

Re-searched repository source, tests, scripts and configuration for `azure-openai-responses`, `azureOpenAIResponsesProvider`, `AZURE_OPENAI_RESPONSES_MODELS`, `providers/azure-openai-responses` and provider-specific lookup/configuration references: no existing dependency on the old ID. Host/runtime model selection passes provider IDs through Pi's registry; isolated Learning freezes/resolves exact generic identities; quota recovery specifically uses openai-codex/DeepSeek, not Azure. No compatibility code added.

Read-only inspection of available local `~/.pi/agent/{auth,models,settings}.json` and project `.pi` configuration found no old Azure ID (only existing files inspected; no credentials displayed or mutated). Other users with the old key must manually migrate auth/models/settings provider references or log in again. Upstream warns old Azure Sessions may fall back to another model on resume and lose prompt-cache reuse. No user-global configuration or historical Session migration is performed.

### Downstream custom-trigger patch: still necessary

The **unchanged** `tests/pi-runtime.compatibility.test.ts` was run against both packages (its historical 1.0.2 test labels are intentionally retained):

| Package under test | Tests | Pass | Fail |
| --- | ---: | ---: | ---: |
| Pristine published npm coding-agent 1.0.3 | 11 | 3 | 8 |
| Normal pnpm-installed patched coding-agent 1.0.3 | 11 | 11 | 0 |

The same eight preflight-dependent cases fail upstream: selectedTools precedence, fallback trigger preflight, idle preflight/injection, one-Run system override/base restoration, live loadout, settled successor preflight, initial preflight for same-Run continuation, and quota hidden-content preflight-before-append. SDK isolation, isolated Learning startup and full-Run Promise settlement already pass upstream. No test contract/assertion was weakened or rewritten.

Pristine proof uses the extracted npm tarball with a temporary Node resolve loader redirecting every coding-agent import to pristine `dist/index.js`, linking its dependency lookup to the installed 1.0.3 dependency directory. It does not overwrite installed packages or mutate the production Host/Session.

`patches/@earendil-works__pi-coding-agent@1.0.3.patch` was regenerated against pristine published 1.0.3, applying with **zero fuzz and no offsets**. It is byte-identical to the 1.0.2 patch (same pnpm patch hash); patched agent-session.js exactly matches the pnpm-installed implementation. Semantics unchanged:

```text
idle custom trigger → fresh before_agent_start → fresh prompt/tool preflight → Run → settlement
agent_settled successor → fresh before_agent_start → new Run → settlement
agent_before_settle continuation → same Run → no duplicate preflight → one settlement
```

### TUI and SDK isolation

Policy remains **explicit Host override → explicitly configured effective Pi tuiMode → "regular" fallback**. Existing Host six-case precedence coverage passes for both production Pi InteractiveMode and the owned shell. No Pindie keybindings changed. Upstream 1.0.3 assigns Home/End to editor line start/end and Ctrl+Home/Ctrl+End to fullscreen transcript top/bottom; these no longer move the editor cursor. Fullscreen-by-default is not adopted.

Real-Pi tests continue asserting no unintended `codemode`, `tool_search`, `mcp__*`, builtin Pi MCP extensions/commands before/after Host Session replacement. Stable Mode stays default. Isolated Learning Sessions still have no Human tools, extensions, commands, skills, prompts/templates, themes or transcript state.

### Sequential verification and rollout limits

Performed without overlapping heavy suites: forced clean/frozen strict-peer install (`pnpm install --frozen-lockfile --strict-peer-dependencies --force`), artifact/integrity/lockfile audit, pristine-versus-patched proof, Pi compatibility **11/11**, Control **72/72**, Host/runtime/Session **107/107**, quota **69/69**, Learning foundation/composition/isolation/preemption **40/40**, Browser Reality **27/27**, TUI **58/58**; `pnpm typecheck`; owned smoke and isolated headless Control dogfood. Final full `pnpm run check`, whitespace and GitHub CI results are recorded in the delivery PR.

Control/real Host regressions cover started/queued/handled disposition, accepted work unsettled before agent_start, handled input without fabricated timeline delivery, exactly-once user delivery, steer/followUp and pending-message accounting, event-driven wait(settled), Session replacement, lease rotation/stale rejection, PresentationReader rebinding and no stale Session binding. No Control implementation changes.

Owned invocation: `pnpm smoke -- pi103-headless --timeout-ms 60000 -- node --experimental-strip-types /tmp/pi103-audit/dogfood.ts`. The disposable script reuses the previous upgrade's deterministic dogfood with only version labels changed: temporary workspace/agent/Pindie storage, actual Pi SDK/runtime and Pindie loopback MCP transport/client, faux provider, project open, accepted/unsettled input, wait(settled), exactly-once timeline, Session/reader replacement and stale-lease rejection. It also passes when invoked directly. No production Host/session mutation or paid inference.

Residual manual checks: live-provider inference and OAuth/provider wire behavior; actual terminal visuals under SSH/tmux, IME and optional fullscreen interaction; live Chrome visual dogfood (Browser Reality coverage here is automated). These are not claimed as verified; no observed regression requires broader integration changes.
