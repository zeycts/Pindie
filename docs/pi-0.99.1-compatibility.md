# Pi 0.99.1 compatibility audit

Scope: upgrade the three directly used Pi packages from pinned 0.87.1 to pinned stable 0.99.1. No new Pi features, auth migration, model-policy changes, or learning lifecycle changes.

## Upstream and dependency boundary

Audited the published `@earendil-works/pi-coding-agent@0.99.1` tarball, its 0.99.0/0.99.1 changelog, SDK/extension/theme/settings documentation, session-runtime examples and distributed implementation/declarations at Pindie's direct touchpoints.

- Node remains >=22.19.0 (Pindie's existing minimum). Pi's ES2024/TypeScript 7 build does not require changing Pindie's compiler: the existing TypeScript dependency typechecks the published declarations.
- `prompt()` still resolves after the Run. `preflightResult` now reports `started`, `queued`, or `handled`, not a boolean; `steer()`/`followUp()` now return `queued` or `handled`. Control rejects consumed input without inventing a timeline delivery. Accepted prompt preflight marks automatic work unsettled before `agent_start`, closing the early settled-wait window.
- `agent_before_settle`, `agent_settled`, hidden messages, replacement contexts, runtime lifecycle/rebinding, and SessionManager branch recovery retain the required contracts. Real-Pi compatibility, replacement, Control lifecycle and quota-supervisor tests cover these paths.
- MCP, codemode and tool search are new **CLI** built-in extensions. SDK loaders require explicit factories; Pindie's Host does not supply them. Isolated learning uses a custom resource loader and no tools. Tests assert absence of these extensions/tools in both boundaries. Transitive installation of pi-mcp/pi-codemode is not activation.
- Pi changes the default theme to `system`, revises `dark`/`light` palettes and supports terminal-responsive colors. Pindie's production InteractiveMode delegates theme ownership to Pi; existing explicit theme settings remain authoritative, and `fg`/`bg` APIs used by Pindie remain supported. No theme override or new theme feature is added. Visual differences are an upstream upgrade effect, not pixel-equivalence; a real terminal visual review remains advisable.
- Pi adds OpenAI ChatGPT login and labels Codex legacy. Pindie continues using the existing Codex provider/auth and quota paths; no credential or settings migration is performed. Pi 0.99.1 changes its own automatic Codex default to GPT-6.1 Sol. Explicit persisted model selection is unchanged; unconfigured automatic selection follows Pi as before.
- Browser extension 0.1.15 peers accept Pi >=0.80.10 and TypeBox `*`. Pindie's wildcard Pi/TypeBox peers remain unchanged. Installation reports no peer conflict. New OpenAI 7.x optional peers resolve within their declared ranges, including the existing undici 6.x. Lockfile changes include Pi-required transitive packages (QuickJS, OpenAI and MCP support), not independent upgrades.

## Downstream patch remains necessary

Published 0.99.1 still dispatches idle `sendCustomMessage({ triggerTurn: true })` directly to `_runAgentPrompt`, including its deferred `agent_settled` successor path, bypassing `before_agent_start`.

The 0.87.1 patch applies to the pristine tarball with **zero fuzz**, with both hunks offset by +233 lines. The 0.99.1 patch is regenerated against that tarball; its implementation is unchanged. It preserves hidden custom-message identity and Promise/Run settlement while running fresh preflight, collecting injected context, respecting explicit selectedTools edits over live loadout changes, and preparing transcript-aware prompt/tool declarations. Ordinary prompting and streaming queue dispatch are untouched.

An isolated unpatched tarball run of the compatibility suite fails the preflight-dependent contracts; the patched installed package passes them. Removing the patch is therefore not safe. Retire it only when upstream natively satisfies the same tests.

## Verification and operational limits

Focused tests include custom preflight/loadout, settled successor, same-Run continuation, quota resume/fallback hidden triggers, full-Run Promise, isolated learning startup, real Host replacement/recovery, browser loading and Control observe/timeline/wait/rebinding. Final delivery runs standalone typecheck, then full `pnpm run check`, then an owned `pnpm smoke` subprocess using temporary Hosts and deterministic faux providers.

No running Pindie Control/Host restart, live Session mutation, live credential migration, paid model invocation or merge is part of this upgrade. Safe dogfood is isolated headless Control exercised through its actual MCP transport and SDK with temporary storage; live-provider and interactive visual validation remain residual risks.
