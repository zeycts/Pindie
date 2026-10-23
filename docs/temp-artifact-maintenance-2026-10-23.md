# Temporary artifact maintenance — 2026-10-23

## Bounded prevention

- `tests/remote-companion.test.ts`: every `isolatedRouting(t)` now uses the existing `mkdtemp` fixture and its awaited `t.after(rm)` teardown. Random paths preserve isolation across processes and PID reuse. A nested-test regression writes routing and verifies each directory disappears after teardown and differs from its sibling.
- `scripts/pi-smoke.ts`: remove historical scavenging entirely, including the age-clock option. Invocation no longer enumerates/deletes earlier workspaces. Only the freshly allocated workspace is removed in the existing `finally`; explicit keep-artifacts behavior remains. Aged active siblings, unknown old directories, foreign artifacts and namespace symlinks retain regression coverage. No test coverage is dropped: the age-deletion expectation is replaced by the approved retain-unknown contract; symlink assertions exercise the actual invocation instead of the removed scavenger.
- Age, a dead PID or a PID encoded in a filename cannot prove ownership. No lease registry, global GC or crash-cleanup guarantee is introduced. SIGKILL/machine loss and explicit keep-artifacts can still leave workspaces for human review.

## Pi 1.4.0 output retention assessment

Inspected installed upstream source, without modifying dependencies:

- `dist/utils/output-files.js`: `os.tmpdir()`, random 8-byte hex suffix, mode `0600`, exclusive `wx` creation for files/streams. These already protect private output from ordinary other-user reads and pre-existing symlinks.
- `dist/core/tools/output-accumulator.js` and `dist/core/tools/bash.js`: truncated tool output retains a full-output file; the accumulator delegates location to that shared utility.
- `dist/core/bash-executor.js`: interactive/RPC bash likewise uses `createOutputFileStream("pi-bash", ".log")`.
- `dist/core/agent-session.js:recordBashResult`: persists `fullOutputPath` into native Session history. Interactive rendering uses the same path. Closing a stream is not permission to delete its file.
- No output-directory/ownership hook was found in the inspected SDK/settings declarations or utility. `TMPDIR` is process-wide, not a resource-specific retention contract. Changing it for a Host would also affect unrelated native dependencies and children; deleting that directory on exit would break resumed/forked/cross-Session references. Wrapping just the bash tool misses native interactive bash and other output consumers.

**Decision:** no Pindie-owned output relocation or deletion in this patch. Never sweep shared `/tmp/pi-bash-*` by age, modify `node_modules`, or unlink paths after Session shutdown. A separate upstream proposal could add an injectable output-file sink with private exclusive writes and explicit persistent retention semantics. Adoption would need native/tool/codemode output coverage and cross-Session resume/fork tests; no second Session database or reference-count GC is proposed here.

## Historical read-only inventory

Machine-local retained evidence (not a cleanup script):

`/home/dev/projects/Pindie-temp-artifact-audit-2026-10-23.json`

SHA-256: `2c32097d0438c7f7b07333a420daf668025134e61f7865efa0580d6976bb8d48`

The mode-0600 manifest records exact paths, UID/mode, device/inode, mtime, allocated bytes and remote directory entry metadata. Inventory used `lstat`, `du -s -B1` without following symlinks, and same-UID `/proc` cwd/root/fd/cmdline/maps reference matching. No Sessions, State, credentials or rollback asset contents were read. Sizes are allocated blocks, not logical content size.

| Scope | Items | Allocated bytes |
| --- | ---: | ---: |
| `/tmp/pindie-remote-test-*` | 2474 | 10,133,504 |
| `/tmp/pi-bash-*.log` | 44 | 23,379,968 |
| Other top-level `/tmp/pindie-*` | 482 | 1,713,922,048 |

The extra Pi log relative to the supplied audit includes this run's oversized shell-result capture (`/tmp/pi-bash-39fa27028f498c62.log`); it is retained, not silently removed. Root filesystem still reported 62% used.

All 2474 remote directories belong to UID 1000, each contains exactly one regular hash-named JSON file, and all pass the external routing schema/test guild/channel checks. The 2474 name-encoded PIDs were absent at observation time. A seven-project hash sample matched 1712 entries; this is not an assertion that remaining hashes are invalid. Exact provisional examples (4096 allocated bytes each):

- `/tmp/pindie-remote-test-1011473-1`
- `/tmp/pindie-remote-test-1011473-10`
- `/tmp/pindie-remote-test-1011473-11`

The manifest is the precise full provisional candidate list, not a wildcard deletion authorization. Potential remote-directory recovery is about 9.66 MiB, **not yet certified safe**.

Reference observations and limitations:

- Scanned 54 same-UID processes; no exact inventoried path references were observed in accessible fields. Five processes (828, 832, 2938806, 2939104, 2959937) had inaccessible process information. Exited-process races, other users and non-open future references are not ruled out.
- Queried 139 loaded system service units and 13 loaded user service units via `systemctl show` for WorkingDirectory, ExecStart/Pre/Post and unit/drop-in paths; no exact inventoried temp paths appeared. This is not an exhaustive check of configuration contents, inactive/unloaded units, indirect parent-directory references or arbitrary scripts.
- Therefore **no historical path is approved for deletion by this report**. Name, age, schema and absent PID provide attribution clues, not a complete no-dependency proof. Large scratch directories, shared Pi logs, registered Pi upgrade worktrees and rollback assets remain untouched.

## Verification performed

- `node --experimental-strip-types --test --test-concurrency=1 tests/remote-companion.test.ts tests/pi-smoke.test.ts`: 46 passed, 0 failed/skipped.
- `pnpm run check`: TypeScript check and 1148 tests passed, 0 failed/skipped (137.95 seconds test duration). An earlier invocation was interrupted by the tool's 120-second timeout and is not counted as a completed check; the rerun used a 600-second limit.
- Re-ran the entire remote suite under a fresh Python `TemporaryDirectory` supplied as `TMPDIR`: 33 passed, 0 failed/skipped; the directory was empty after the suite, then the validation harness removed its own empty directory.
- `git diff --check` passed; original production checkout remained clean at `d2273b48130abde03e20b5a9dfe3a431e9344bd4`.
- Tests used the installed pinned dependencies via a worktree-local `node_modules` symlink; no dependency install or dependency mutation was performed.

## Separate human cleanup boundary

A future bounded cleanup proposal must select exact manifest paths (never a glob), resolve inaccessible/unknown holders and indirect service references, reconfirm identity/owner/type and test-only contents immediately before action, and reject changed/symlink/unexpected entries. A human must explicitly approve that exact candidate set and expected recovery before deletion. Until then retain all historical assets; no services/processes should be stopped to make cleanup possible. Check-use-delete races also need an exclusive maintenance window or equivalent ownership proof, not another age/PID heuristic.

This patch does not deploy, restart services, change rollback chains, merge a PR or authorize cleanup. The isolated maintenance worktree and its dependency symlink, named targeted/full-check logs and audit manifest are retained as identified review artifacts, not abandoned `/tmp` scratch data.
