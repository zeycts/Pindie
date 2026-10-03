# Pi 1.0.1 compatibility audit

Scope: upgrade the three directly used Pi packages from exactly **0.99.1** to exactly **1.0.1**, with the related Pi family resolved to 1.0.1. This replaces the previous 0.99.1 audit. No Pi feature adoption, auth migration, model-policy change, production Host restart, or Learning architecture change.

## Published upstream audit

Audited the actual npm tarballs for coding-agent 0.99.1 → 0.99.2 → 1.0.0 → 1.0.1, their release notes, distributed implementation/declarations, and SDK documentation. Compared pi-ai, pi-agent-core and pi-tui 0.99.1/1.0.1 packages as well.

- `AgentSessionRuntime` and `SessionManager` implementations/declarations and the SDK factory declarations are unchanged. `createAgentSession`, `createAgentSessionServices`, `createAgentSessionFromServices` and `createAgentSessionRuntime` remain Pindie's integration boundaries. Real Host replacement, PresentationReader lease, Session navigation/rebinding, rollover and quota tests revalidate semantics rather than merely export presence.
- `PromptOptions`, prompt preflight (`started` / `queued` / `handled`), steer/followUp (`queued` / `handled`), `before_agent_start`, `agent_before_settle` and `agent_settled` contracts remain intact. ExtensionRunner's relevant preflight/settlement behavior is unchanged; new renderer resolution APIs are not adopted. Control records deliveries only on actual acceptance, marks automatic work unsettled in accepted preflight before `agent_start`, and waits for settlement through events.
- **0.99.2:** reload now enables newly added `defaultTools` (unless an explicit tools/noTools selection overrides it). AgentSession tracks restored/reloaded tools awaiting registration, drops pending restoration when tools are deactivated or a Run starts, and filters hidden tool snippets. These changes do not replace Pindie's captured-baseline Tool Surface or Gateway. ModelRuntime now provisionally marks native providers with stored/configured credentials available before asynchronous refresh; Pindie's exact model lookup, selection, thinking clamp and quota configuration continue through Pi.
- **1.0.0:** SettingsManager's unconfigured `getTuiMode()` changes from regular to fullscreen. InteractiveMode still takes `options.tuiMode` before settings. Pindie preserves the 0.99.1 precedence explicitly: `interactiveModeOptions.tuiMode` first, then an explicitly configured effective Pi `tuiMode`, then `"regular"` only when the setting is absent. Tests cover unset, settings `regular`/`fullscreen`, Host overrides, and both production Pi InteractiveMode and the optional owned shell. Fullscreen-by-default adoption remains separate future dogfood. Header-only quiet startup and login changes are not adopted.
- **1.0.1:** Anthropic mid-conversation tool redefinitions use inline declarations to preserve cache; provider capacity/retry and Bedrock thinking fixes stay Pi-owned. Tool renderer registration, project MCP overrides, classifier/image models, Radius, new authentication flows and virtual models are not adopted. No credential migration or model-selection policy changes occur.
- SDK DefaultResourceLoader still needs explicit built-in extension factories. Pindie's production Host supplies Pindie/optional Browser Reality factories, not Pi CLI factories. Real-Pi tests assert no `codemode`, `tool_search`, `mcp__` tools, `builtin:` extensions or MCP commands before and after Session replacement. Isolated Learning Sessions have no tools, extensions, commands, skills, templates or themes and cannot borrow the Human transcript. Transitive pi-mcp/pi-codemode installation is not activation. Pindie Control remains its existing MCP transport, not Pi MCP.
- pi-agent-core removes unused experimental harness subpath exports and their dependencies; its ordinary Agent implementation is unchanged. Pindie does not use those removed subpaths. pi-ai adds a models subpath; no adoption.

## Dependency and peer audit

All direct Pi versions remain exact pins. Version-specific release-age exclusions and patchedDependencies follow 1.0.1. Node >=22.19.0 and Pindie's TypeScript 5.8.3 remain unchanged; the published declarations typecheck.

Lockfile changes are bounded to eight Pi-family packages, Pi-required Anthropic SDK **0.124.0 → 0.129.0**, and upstream's pinned **brace-expansion 5.0.12** security fix. The existing minimatch `^5.0.8` edge is also resolved to 5.0.12 so pnpm does not retain vulnerable 5.0.9 beside the new direct pin. No general dedupe or unrelated upgrades. Other transitive versions, including OpenAI, QuickJS, MCP SDKs, AWS, TypeBox and undici, are retained. 1.0.1 removes npm-shrinkwrap; Pindie's pnpm lockfile remains authoritative.

Browser extension **0.1.15** is unchanged; its Pi peers accept >=0.80.10 and TypeBox `*`. Frozen strict-peer installation verifies the actual resolution. Browser Reality regression coverage exercises extension/tool adaptation and owned-browser lifecycle; this is not live Chrome visual dogfood.

## Downstream custom-trigger patch remains necessary

Published **1.0.1** still sends idle `sendCustomMessage(..., { triggerTurn: true })` directly into `_runAgentPrompt`, including its deferred `agent_settled` successor, bypassing `before_agent_start`.

The existing patch applies to the pristine published tarball with **zero fuzz**, both hunks offset by +32 lines. `patches/@earendil-works__pi-coding-agent@1.0.1.patch` is regenerated against that tarball with **unchanged implementation**. It restores:

```text
idle custom trigger → fresh before_agent_start → fresh prompt/tool preflight → Run → settlement
agent_settled successor → fresh before_agent_start → new Run → settlement
agent_before_settle continuation → same Run → no extra preflight → one settlement
```

Live active-tool changes remain effective unless an explicit selectedTools edit takes precedence. Injected custom messages, hidden trigger identity, transcript-aware tool/system declarations, one-Run system-prompt overrides without replacing the base, full-Run Promise settlement and quota resume/fallback hidden messages are preserved. Ordinary prompting and streaming queue dispatch are untouched.

### Unpatched versus patched proof

The same `tests/pi-runtime.compatibility.test.ts` runs against:

1. An extracted, pristine npm `@earendil-works/pi-coding-agent@1.0.1` tarball, using a temporary Node resolve loader that redirects every coding-agent import (including Pindie imports) to its `dist/index.js`; its dependency lookup links to the installed 1.0.1 dependency directory. No installed production package is overwritten.
2. The normal pnpm-installed, patched 1.0.1 package.

**Unpatched: 11 tests, 3 pass, 8 fail. Patched: 11 tests, 11 pass.** Failures are explicit selectedTools precedence, fallback preflight, idle preflight/injection, one-Run system override/base restoration, live loadout, settled successor preflight, same-Run continuation's initial preflight, and quota preflight-before-append. SDK isolation, isolated Learning startup and full-Run Promise settlement already pass upstream. The patch restores missing preflight; it does not claim upstream Promise or SDK isolation bugs. Retire the patch only when upstream satisfies these same contracts.

Patch verification applies the regenerated patch to a fresh tarball with zero fuzz/no offset and compares its resulting agent-session.js byte-for-byte with the pnpm-installed implementation.

## Verification and rollout limits

Final verification runs sequentially (no simultaneous heavy jobs): frozen strict-peer install; pristine patch application/comparison; Pi compatibility suite; Control client/headless/workspace/MCP lifecycle tests; Host/runtime/rollover/continuation/model/presentation regressions; quota resume/fallback/recovery regressions; Learning foundation/isolated Session/preemption regressions; Browser Reality regressions; `pnpm typecheck`; full `pnpm run check`; owned `pnpm smoke`; safe isolated headless Control dogfood through the actual MCP client/transport; `git diff --check`. Test counts/results are recorded in the delivery PR.

Real-Pi Control coverage includes consumed idle input without a fabricated message or queued state, accepted input unsettled before agent_start, exactly one user delivery, handled/queued steer and followUp, event-driven wait(settled), lease rotation and no stale Session/reader binding. Faux providers and temporary storage avoid paid/live inference and production Host mutation.

Residual rollout checks: interactive terminal visual review (including upstream theme/image/rendering effects) and live-provider inference were not performed. Deterministic tests do not prove provider-specific cache/wire behavior. Fullscreen, Pi MCP/codemode/tool search and other 1.0 features remain independent future evaluations, not part of this compatibility baseline.
