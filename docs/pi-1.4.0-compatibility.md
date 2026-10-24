# Pi 1.4.0 compatibility audit and rollout boundary

## Current status and reading boundary

Pindie pins Pi **1.4.0** in `package.json` and the lockfile. The upgrade merged in [PR #297](https://github.com/zeycts/Pindie/pull/297); subsequent maintenance [#299](https://github.com/zeycts/Pindie/pull/299) and [#300](https://github.com/zeycts/Pindie/pull/300) also merged. At this documentation audit, the production checkout is `c806f8db5944240a897e2e29a1df1ea15e8917f6` and the installed SDK reports 1.4.0; the completed deployment is user-confirmed. The earlier “production pending” boundary is no longer current.

The sections below preserve the isolated compatibility audit and its original cutover/rollback proposal. They do **not** record the later production transaction, identify its effective rollback artifacts, or authorize rerunning it. Use separately retained operational records for recovery. No backup, recovery artifact, State or Session is modified by this documentation update. Terminal visual/live-provider acceptance is not established by automated tests or by the fact of deployment.

## Original isolated audit outcome and provenance

Prepared against clean `main` at `dcbd142275a4bd956a70859efa88a0ca540f0ee5`, using branch `chore/pi-1.4.0-compat` in `/home/dev/projects/Pindie-pi140`. **At that audit boundary**, only the isolated installation had been upgraded; production was still on 1.3.0 pending review and a human-operated maintenance window. No merge, production dependency install, service restart, Session switch, real-provider inference, user settings migration or user-data deletion was performed during that isolated audit.

- Registry: `https://registry.npmjs.org/`, not a global/managed Pi installation. Pindie imports its project-local SDK. Three direct exact pins (`pi-ai`, `pi-coding-agent`, `pi-tui`) and all seven Pi-family packages resolve to **1.4.0**, with no downstream patch.
- [Official v1.4.0 release](https://github.com/earendil-works/pi/releases/tag/v1.4.0): non-prerelease, published `2026-10-21T22:49:48Z`; npm `latest` was `1.4.0` at inspection.
- Node `24.21.0`, pnpm `11.22.0`; upstream Node requirement remains `>=22.19.0`.
- Each family's npm tarball SHA-512 matches registry metadata and the lockfile. Every published file matches the isolated installed bytes, including both pi-ai peer snapshots. No preexisting external package/snapshot record changed beyond Pi peer labels. The only new external package is upstream TUI's `marked-cjk-friendly@0.1.2` (CJK Markdown fix). Browser-use remains `0.1.15`.

## Compatibility decisions

### Custom-turn preflight and patch

The historical `before_agent_start` patch was already retired in 1.3.0; neither production manifests nor this upgrade install a patch. Pristine published 1.4.0 passes all 17 prior native contracts, plus a new resumed-tool declaration test (18 total). These retain hidden custom-message identity before branch append, fresh authority/preflight, injected context/system prompt, selectedTools precedence, full-Run Promise, queued startup delivery, startup abort/settlement and same-Run continuation. No second loop or replacement preflight is introduced. `long-task-runtime.md` now explicitly marks its obsolete 0.84.4 patch account as historical.

The native contract and native UI tests also pass with coding-agent imports redirected to the separately extracted npm tarball (`dist/index.js`), not a GitHub build or patched reference.

### Control / Session lifecycle

Published SDK documentation and public AgentSessionRuntime declarations are unchanged from 1.3.0. AgentSession declaration changes here concern private recovery bookkeeping. Runtime replacement still needs old subscriptions detached and new Session/reader bindings installed; Host ownership, fresh leases and stale-input rejection are unchanged. Real-Pi/faux tests exercise busy preflight, steer/followUp, accepted-versus-settled, queued versus handled input, abort, Session replacement and hidden quota resume. Existing Control/Host/quota/rollover regressions all pass in the full suite.

Upstream now activates newly registered extension tools when the resumed transcript never mentioned them, except `defaultActive: false`; recorded removals remain inactive. Added a replay fixture with an explicit persisted `toolsRemoved` declaration, a new active tool and a new inactive tool. An initial attempted fixture using live `setActiveToolsByName([])` and `noTools: "builtin"` was invalid for this contract: the explicit startup override bypasses transcript restoration. It was corrected, not made to accept the wrong expected behavior. Existing explicit/modifier override assertions remain unchanged. Pindie's Gateway remains fresh authorization; no new built-in SDK extensions/codemode/MCP tools are adopted.

### Native TUI defaults and bounded UI observation

Current Host policy remains **explicit Host override → explicit Pi setting → fullscreen** (`src/host.ts`), verified by existing precedence tests. The earlier 1.3.0 audit describes its then-current regular fallback; that is historical, not this upgrade's policy. No user keybindings/settings are rewritten.

A concrete incompatibility was found: `observeNativeUiIdle` is deliberately version/shape-pinned. 1.4.0 replaces `extensionSelector`/`extensionInput`/`extensionEditor` with an `extensionDialogs` stack. Updated only the per-instance binding to exact 1.4.0 and require an empty, present array. Pending UI promise counting, async pre-mount gaps, hidden overlays, editor identity, queued input, shutdown/initialization and replaced-wrapper rejection remain intact. Unknown versions (including 1.3.0), missing/malformed stacks and unknown shapes still deny automatic Browser release. No prototype/global patch.

All prior tests remain. The three removed-field fixture guards map to nonempty/non-array/null stack guards, and the missing-field guard now targets the stack. Added actual native stacked custom-dialog tests closing both top-first and bottom-first, checking restoration and no idle release until both settle. The first upgrade run correctly failed five UI tests before this adaptation. Existing signal/Host disposal, fake-terminal, Watch mouse/scroll/overlay and native renderer tests pass. Upstream terminal teardown and concurrent-dialog fixes are inherited; actual terminal visuals/SSH/tmux/IME remain manual acceptance checks.

### SDK and upstream behavioral changes

No new release-noted breaking section or removed public lifecycle signature was found. Typecheck passes with Pindie's current imports. Behavior changes were reviewed rather than assuming a minor release is risk-free:

- `generateSummary()` / `generateSummaryWithUsage()` ignore `reserveTokens` as an output cap. Compaction reserve now controls trigger timing; summary output uses the model limit/context fit. Pindie does not call these helpers or set an alternate output cap; real-Pi/faux compaction/checkpoint regression passes. Longer real summaries may cost more; no settings migration was done.
- Attribution headers now originate in pi-ai client identity; `before_provider_headers` sees different attribution fields. Pindie registers no such handler. No telemetry preference is enabled/changed here.
- Session output-limit recovery now omits failed attempts and paired tool results together; provider retry/error classification and model catalogs also change upstream (including ChatGPT Business quota handling and removal of unavailable Codex models). No automatic fallback-policy/model-name rewrite is added. Real provider/OAuth behavior is not claimed by faux tests.
- Classifier image input, codemode worker queuing, MCP BOM handling and model-configuration reference are upstream features, not new Pindie functionality. SDK defaults remain isolated from CLI built-in extensions.

## Backup and actual commands/results

Private operational backup: `/home/dev/projects/pindie-pi140-backup-gZ8FPY` (mode 0700). It retains a complete pre-upgrade Git bundle, original three manifests, their SHA-256 checksums, base HEAD, service-start facts, release/registry metadata, seven tarballs/extracted packages, artifact-audit script, detached loader and check logs. `git bundle verify` passed. At the isolated audit boundary, the original production checkout/dependency tree was untouched rollback material. This statement is historical; do not infer that today's checkout is a pre-upgrade backup. User State/Sessions/preferences/routing/credentials were not read or copied; no migration requires their restoration. Before a later production window, stop all writers and take a separate authorized consistent backup of the effective configured storage roots if desired—do not restore old semantic State just to roll back code.

Actual command families (log files are in the private directory above):

```sh
# Initial production observations (no service mutation):
git status --short; git branch --show-current; git rev-parse HEAD; git worktree list
node --version; pnpm --version; pnpm config get registry
systemctl --user show pindie-control.service pindie-tunnel.service \
  -p MainPID -p ActiveState -p SubState -p NRestarts -p ExecStart -p WorkingDirectory -p FragmentPath
npm view @earendil-works/pi-coding-agent@1.4.0 version dist repository engines --json
npm view @earendil-works/pi-coding-agent dist-tags --json
gh api repos/earendil-works/pi/releases/tags/v1.4.0
# Backup: git bundle create "$backup/pre-upgrade.bundle" HEAD;
# cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$backup/"
# For each of pi-ai, pi-coding-agent, pi-tui, pi-agent-core, pi-codemode, pi-mcp, pi-telemetry:
# npm view @earendil-works/$p@1.4.0 --json
# npm pack @earendil-works/$p@1.4.0 --pack-destination "$backup" --silent
git worktree add -b chore/pi-1.4.0-compat /home/dev/projects/Pindie-pi140 HEAD
cd /home/dev/projects/Pindie-pi140
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm run check                 # BEFORE: 1141/1141; check-before.log
# Edit only exact Pi pins/release-age exceptions; then:
pnpm install --strict-peer-dependencies
pnpm typecheck                # pass
node --experimental-strip-types --test --test-concurrency=1 \
  tests/pi-runtime.compatibility.test.ts tests/pi-1.3-control.test.ts \
  tests/pi-runtime.integration.test.ts tests/host.test.ts \
  tests/native-interactive-runtime.test.ts tests/native-ui-idle.test.ts \
  tests/watch-native-presentation.test.ts tests/watch-mouse.test.ts
# First: 62/67 (five pinned-UI failures). After UI fix/new tests: 68/69
# (new replay-fixture mismatch); corrected fixture was retested below.
node --experimental-strip-types --test --test-concurrency=1 \
  tests/pi-runtime.compatibility.test.ts tests/native-ui-idle.test.ts
# 23/23; compat-ui-after.log
pnpm install --frozen-lockfile --strict-peer-dependencies   # pass; frozen-after.log
pnpm run check                 # AFTER final implementation: 1143/1143; check-after.log
python3 /home/dev/projects/pindie-pi140-backup-gZ8FPY/audit-artifacts.py
# PASS all seven integrities/published bytes and external lock records
node --experimental-strip-types \
  --loader /home/dev/projects/pindie-pi140-backup-gZ8FPY/detached-loader.mjs \
  --test --test-concurrency=1 tests/pi-runtime.compatibility.test.ts tests/native-ui-idle.test.ts
# 23/23; detached-after.log
TMPDIR=/home/dev/projects/pindie-pi140-backup-gZ8FPY/smoke-tmp \
  pnpm smoke -- pi140-control --timeout-ms 60000 -- node --experimental-strip-types \
  --test --test-concurrency=1 tests/pi-1.3-control.test.ts tests/control-mcp.test.ts
# command succeeded; smoke-after.log. Private namespace avoids scavenging unrelated smoke data.
git diff --check              # pass
```

`tests/pi-1.3-control.test.ts` and the 1.3.0-labelled historical native contracts retain their names; the executed dependency is 1.4.0, including the detached run. No tests/skips/globs were removed to get green. Tests use temporary storage/faux providers; the owned smoke reruns native Control and MCP transport regressions, not a live production/provider/browser claim. Documentation-only edits after the implementation check use targeted link/whitespace validation rather than another identical full run.

## Historical cutover proposal (not the executed deployment record)

**Do not replay this as a current runbook.** The commands and process IDs below are the original pre-deployment proposal, retained intact for audit/rollback context. Its `main` branch, `$rollout` layout and rollback-branch assumptions must not be applied to later transactions without independent verification.

The Control service runs from `/home/dev/projects/Pindie` via `/bin/bash -lc` → NVM Node 24 → `pnpm control:mcp` → `node --experimental-strip-types src/control-mcp-process.ts`. At inspection its MainPID was `2752492` and Node child `2752854`, `NRestarts=0`; tunnel MainPID `2617948`, also active. Two local native TUI processes were present. Replacing live dependencies can mix old and lazily imported new modules. **Do not run the following from an agent call hosted by that Control service.** Finish this interaction, close native TUIs normally after their work settles, and use a separate SSH/local shell. Do not restart the tunnel.

After the Draft PR has been reviewed and separately authorized/merged, this guarded procedure uses the exact merge commit, not an unreviewed newer `origin/main`. Abort on a dirty tree, unmerged PR, non-fast-forward, unknown storage/process use or any failed command. The intentional service stop disconnects Control; startup has no active project and requires explicit project open plus a fresh lease. It does not resume the former in-flight request.

```sh
set -e
cd /home/dev/projects/Pindie
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain=v1 --untracked-files=all)"
# This command resolves the merged PR for the exact prepared branch:
reviewed=$(gh pr view chore/pi-1.4.0-compat --json state,mergeCommit \
  --jq 'select(.state == "MERGED") | .mergeCommit.oid')
test -n "$reviewed"
git fetch origin
# Confirm all TUI/Control work is settled and native TUI processes have exited first.
# Record current service facts and any effective custom storage-root overrides privately.
rollout=$(mktemp -d /home/dev/projects/pindie-pi140-rollout-XXXXXX)
chmod 700 "$rollout"
git rev-parse HEAD > "$rollout/old-head"
rollback_branch="rollback/pi140-$(date +%Y%m%d-%H%M%S)"
git branch "$rollback_branch" HEAD
printf '%s\n' "$rollback_branch" > "$rollout/rollback-branch"
printf 'Keep this rollback directory: %s\n' "$rollout"
systemctl --user stop pindie-control.service
# Optional consistent user-data backup here, only for confirmed effective roots.
# Retain the exact old installation rather than mutate it in place:
mv node_modules "$rollout/node_modules-1.3.0"
git merge --ff-only "$reviewed"
pnpm install --frozen-lockfile --strict-peer-dependencies
node --input-type=module -e \
  'import { VERSION } from "@earendil-works/pi-coding-agent"; if (VERSION !== "1.4.0") process.exit(1); console.log(VERSION)'
pnpm run check
systemctl --user start pindie-control.service
systemctl --user is-active pindie-control.service pindie-tunnel.service
systemctl --user show pindie-control.service -p MainPID -p NRestarts -p ActiveState -p SubState
# From Control: observe workspace (initially no active project), explicitly open project,
# obtain a fresh lease, then verify safe input/settlement. Separately launch `pnpm pindie`
# and check Watch, stacked dialogs, fullscreen/regular override and normal terminal exit.
```

Record `$rollout` and branch outside the terminal before proceeding. If installation, checks or startup fail, **leave Control stopped**, inspect the failure, and use the retained tree rather than force/reset/clean. From the same independent shell (or set `rollout` to the printed exact path):

```sh
set -e
cd /home/dev/projects/Pindie
systemctl --user stop pindie-control.service
# Close any newly launched TUI normally before moving dependencies.
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test -d "$rollout/node_modules-1.3.0"
if test -e node_modules; then mv node_modules "$rollout/node_modules-1.4.0-failed"; fi
git switch "$(<"$rollout/rollback-branch")"
mv "$rollout/node_modules-1.3.0" node_modules
node --input-type=module -e \
  'import { VERSION } from "@earendil-works/pi-coding-agent"; if (VERSION !== "1.3.0") process.exit(1); console.log(VERSION)'
systemctl --user start pindie-control.service
systemctl --user is-active pindie-control.service pindie-tunnel.service
# Observe/reopen project with a fresh lease; do not restore stale State or Session files.
```

The rollback intentionally leaves production on the named rollback branch for diagnosis, with upgraded `main` retained. No force checkout, remote history rewrite, storage migration, destructive cleanup or automatic merge is authorized by these instructions. At the original audit boundary, live provider/OAuth, terminal visuals and production acceptance had not been performed. Later deployment does not by itself establish those individual acceptance checks.

## Work Memory settings isolated visual fixture

`scripts/work-memory-preview.ts --fixtures` constructs the real pinned Pi 1.4.0
InteractiveMode and Pindie settings command, not a screenshot renderer. It requires
an isolated launcher, creates a fresh run directory for each invocation and keeps
its own prefs/auth/Session/State/routing roots. The configured variant uses only a
**fake sink** to simulate configured availability; it has no Notion token. The
unconfigured variant has neither credentials nor sink. Network sockets, fetch,
real adapter imports and model inference are blocked. Ordinary text input is
consumed with a fixture notice. No production settings or occupied tmux panes are used.

For this feature's retained worktree/preview, run in a **new idle terminal or tmux
window**, not one of the three production panes:

```bash
bash /tmp/pindie-work-memory-preview/launch.sh --fixtures
# Alternatively: missing Notion configuration
bash /tmp/pindie-work-memory-preview/launch.sh --fixtures --unconfigured
```

Then enter `/work-memory`. The configured fixture deliberately shows Host on / Saved
off divergence; test Enter, Ctrl+S, Esc, narrow resize and current/default markers.
Reopen the menu to confirm saved intent changes while the Host checkmark does not.
Use `/quit` to exit. Each launch starts a fresh fixture; inspect
`/tmp/pindie-work-memory-preview/last-run.txt` for its isolated run path.
The launcher uses `env -i`, temporary HOME/XDG/PI_AGENT_DIR/**PI_CODING_AGENT_DIR**
(the SDK's actual agent-directory environment variable), and never copies real auth.

The same launcher with `--fixtures --smoke` uses real InteractiveMode with an inert
Terminal and sends Ctrl+S through Pi's actual input handler. It checks registration,
native menu mounting, global write, unchanged Host assembly and unchanged Session
entries; `--unconfigured` covers the missing-config state. The regression suite
runs both variants in disposable isolated directories. This is non-interactive
smoke evidence, **not human visual acceptance**. Retain the development worktree and
preview for acceptance; independent PR review, merge and deployment remain separate,
not-yet-authorized steps.
