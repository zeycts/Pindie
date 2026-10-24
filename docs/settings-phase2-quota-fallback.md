# Settings Phase 2 — Quota Fallback model and thinking

This user-approved extension supersedes **only** the fixed-backup, source-only thinking and two-row fallback UI restrictions in [Quota Fallback v0.1](quota-fallback-v0.1.md). Its quota confirmation, same-Session ownership, arbitration, idle restoration and human-authority invariants remain unchanged. No merge/deployment/restart authority is implied.

## Verified Pi 1.4.0 boundary

Audited installed declarations **and executable implementations**, then tested the public APIs against an isolated real Pi Session:

- `ctx.modelRegistry` / `session.extensionRunner.getModelRegistry()` expose `ModelRegistry`.
- `find(provider, id)` returns actual chat metadata (`name`, `input`, reasoning map).
- `getAvailable()` reads Pi's synchronous availability snapshot. `hasConfiguredAuth(model)` and `getProviderAuthStatus(provider).configured` expose non-secret configuration state. None require Pindie to read credentials, resolve a key, refresh catalogs, or query a provider.
- pi-ai's exported `getSupportedThinkingLevels(model)` is also what Session `getAvailableThinkingLevels()` uses.
- `await session.setModel(model)` rechecks provider authentication through Pi, records the Session model, emits `model_select`, and does **not** save the global model unless `persist: true` is supplied. Pindie does not supply it.
- `session.setThinkingLevel(level)` clamps through Pi and records effective Session thinking; no global thinking default is changed without `persist: true`.

The pinned static catalog currently resolves `deepseek/deepseek-flash` to **DeepSeek V4.1 Flash**, with `off/low/high/max`, and `deepseek/deepseek-v4-pro` to **DeepSeek V4 Pro**, with `off/high/max`. These observations are not UI constants or promises about future catalog contents. No new model ID or release is invented.

### Candidates and spending authorization

A model must be in Pi's current available **chat** snapshot, have both explicit configured-auth checks, support `text`, not use the audited `pi-virtual` router API, and not have provider `openai-codex`. This allows configured cross-provider choices, not just DeepSeek. An unknown or unauthenticated model is not selectable. There is no provider discovery/refresh, automatic candidate replacement, third-provider cascade, or model request while editing settings.

Names come from metadata. Known but unavailable saved models retain their metadata name plus an unavailable indication; unknown models retain their exact identity. Model rows say **backup, may be paid**. Pi does not provide a reliable universal billing guarantee; no pricing/subscription inference is made from authentication or catalog costs. Explicitly selecting a model and Apply/Save authorizes that exact identity for future confirmed incidents. The existing implicit legacy authorization remains limited to the original DeepSeek Flash default. A missing selected identity is never replaced with another paid model.

Snapshot availability cannot prove remote key validity/balance or future service availability. Pi revalidates auth at `setModel`; failures leave Resume eligible. No authentication secrets are returned, copied, printed or persisted by Pindie.

## Configuration and compatibility

Shared global `preferences.json` keeps the original boolean and adds:

```json
{
  "quotaFallback": false,
  "quotaFallbackModel": { "provider": "deepseek", "modelId": "deepseek-flash" },
  "quotaFallbackThinking": "source"
}
```

No eager migration or background task. Missing file/fields mean OFF + original DeepSeek identity + `source`. Existing boolean `quotaFallback` is unchanged. Explicit saves use atomic temporary-file/rename read-modify-write, preserving unknown fields, `discordRemote` and `quotaAutoResume`. Invalid existing JSON is not overwritten. This retains the existing shared preferences writer's scope: atomic replacement, not a cross-process multiwriter transaction/lock.

Resolution order:

1. Built-in defaults.
2. Global fields (missing optional fields inherit built-ins).
3. Latest current-branch entry of `pindie-quota-fallback-preference` with a boolean `enabled`. New writes contain **all three fields**, `{ enabled, model, thinking }`.
4. A legacy `{ enabled }` inherits model/thinking from the legal global configuration, **not** an earlier abandoned/overridden branch entry.

Invalid boolean entries remain ignored as before. Present invalid target/thinking fields fail closed, rather than falling back to another paid identity. Corrupt global configuration carries an unusable identity so a historical legacy ON cannot accidentally resurrect a different paid target. A structurally valid but missing/unavailable model remains the saved selection; runtime cannot use it. Fixed thinking unsupported by current metadata similarly cannot authorize a run. No preference restoration changes Pi's actual active model.

OFF preserves the last selected model/thinking and does not cancel an active lease. Disabling an unchanged valid target needs no auth. Editing a target (even while OFF), enabling, or saving ON requires an exact fresh snapshot preflight. Save errors preserve current Session config and existing default bytes. Menu interactions reject stale Session/branch/revision before append. If Session replacement happens during an already successful asynchronous global save, the global save stands, but no stale draft is appended to the replacement Session; a clear error is shown.

### Thinking mapping

- `source` = **Same as source**. Capture source thinking, switch backup, reapply source thinking through Pi; Pi may clamp it. Legacy preferences never silently become Medium.
- Fixed `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, **`max`** map one-to-one to Pi's public values. Only metadata-supported values are offered/accepted; there is no Pindie provider-specific alias map or silent fixed-level clamp policy.
- Fixed thinking also requires Pi's actual post-switch effective level to exactly match the selected value; mismatch fails before lease/continuation and rolls back only while ownership/generation guards still hold. Source mode may still clamp, and source restore always reapplies the captured **source** thinking, not the configured backup value.

## Small UI, no settings framework

A fallback-owned component composes the existing `SettingsMenu`: Enabled / Model / Thinking / Apply. Enter opens a field; choosing returns to the local draft. Enter on **Apply to Session** commits the full triple only to the current branch. The actual `app.models.save` binding (Ctrl+S by default) saves the full draft as global default and applies it to the current Session; in a sub-selector it first takes the highlighted value. Esc in a sub-selector discards that field choice; Esc on the main screen discards the complete draft. No writes occur before Apply/Save.

Sub-selectors retain shared colors, cursor/current/default marks and remapped/multiple/unbound key behavior. The main view shows actual Session and global triples explicitly. An optional eight-choice window bounds model lists; existing boolean menus retain their default rendering and behavior. ANSI-aware native Text wraps narrow widths. `/quota-resume` and `/discord-remote` business logic is unchanged.

## Runtime slices and ownership

1. Configuration: immutable triples + compatible read/write/branch resolution.
2. UI: local draft and shared-menu sub-selectors, no actual active-model change.
3. Runtime: Extension passes the current Session triple with the confirmed quota plan; Host bridge passes it to Supervisor. Supervisor copies/freeze-snapshots the plan/backup **before awaiting** the switch. It verifies selected availability/thinking, then uses the captured identity throughout commit, failure detection, compensation, restore and rollback. A menu change cannot rewrite an active lease.
4. Tests: store/UI/branch checks, native API audit, configured Supervisor and Extension arbitration tests.

The Host now checks terminal assistant errors against its **actual lease identity**, not a fixed DeepSeek constant or stale extension model. Normal stops, tool failures and unrelated providers cannot trigger backup-failure restoration. Source model/thinking capture, owned mutation guard, generation invalidation, safe idle/pending/streaming boundaries, Session replacement, timer cleanup and one-continuation arbitration remain intact. Preferences and leases never enter semantic State. Restart still loses the lease; no reconstruction from old Sessions is attempted.

## Verification scope and residual acceptance

Tests use temporary preference files, in-memory Sessions, native metadata/registry APIs, synthetic fixture providers, and simulated confirmed usage facts/timers. The native API audit installs a **synthetic runtime-only test key**, forbids network via a throwing fetch, and never prompts a model. No real paid request, provider failover, OAuth refresh or live quota exhaustion was executed. Automated key/width/color checks are not a real user's terminal visual acceptance. Human review and a separate authorized merge/deployment remain required.

Local verification at the implementation boundary: `pnpm typecheck` passed; focused store/menu/Supervisor/Host/Extension/Resume/Discord checks passed **257/257** before the final window/lifecycle hardening; final `pnpm run check` (typecheck + unchanged complete test glob) passed **1179/1179**, zero failures/skips, including that hardening. `git diff --check` passed. CI status belongs to the PR's exact commit and is reported there, not inferred from these local results.

Existing coverage is retained: Phase1 fallback-only rendering assertions now exercise the Phase2 Enabled sub-selector and dynamic metadata; old boolean append assertions now expect full triples; fixtures supply the newly required public auth/text metadata. Resume/Discord assertions are unchanged. New tests add persistence, legacy/corruption, cross-provider selection, fixed/source thinking, lease snapshot, selected backup failure/compensation, configured quota-reset integration, stale menu rejection, native API and long-list/window coverage. No test skips/filters/globs are changed.
