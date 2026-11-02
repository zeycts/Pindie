# Retained dependency security follow-up — 2026-11-02

## Adapter follow-up after PR #313 (PR #314 candidate)

The deployed PR #313 baseline is clean `main` at
`2faa4a98ee289229de2b6487b2425d3ab67d73f4`: its unfiltered prod+dev audit has
**two Moderate** findings (adapter node-server 1.19.17 and minimatch 10.2.6),
not the 16 findings at the earlier PR #312 baseline described below.

A new upstream-supported path removes the adapter finding without forcing a
major outside its declared range:

| Package | PR #313 baseline → candidate | Exact compatibility boundary |
| --- | --- | --- |
| `@modelcontextprotocol/node` | 2.1.0 → 2.1.2 | Node >=20; Hono dependency ^4.11.4; server peer ^2.4.0; node-server dependency **^1.19.9 \|\| ^2.1.3**. |
| `@modelcontextprotocol/server` | 2.3.0 → 2.4.0 | Node >=20; Zod ^4.2.0; exact core dependency 2.4.0. |
| `@modelcontextprotocol/core` (server path) | 2.3.0 → 2.4.0 | Required transitively. Client 2.3.0 and its core **2.3.0 remain unchanged**; public HTTP/in-memory interoperability is tested. |
| `@hono/node-server` (both paths) | adapter 1.19.17 / SDK 2.1.3 → 2.1.5 | Node >=20; Hono peer ^4 \|\| ^5.0.0-0. SDK 1.32.0 declares **^1.19.9 \|\| ^2.0.5**, also accepting 2.1.5. Two exact-parent overrides select the reviewed patched release in both paths. |

Registry metadata was checked directly; node 2.1.2/server+core 2.4.0 were published
2026-10-23 and node-server 2.1.5 on 2026-10-13. The existing release-age policy
accepts them without new exclusions. No other package versions change. Node
24.22.2, pnpm 11.22.0, Pi 1.4.0 (including exact internal minimatch 10.2.6),
MCP client 2.3.0, browser-use 0.1.15, SDK 1.32.0 and Hono 4.13.11 are retained.

Upstream release/changelog review:
- [node 2.1.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fnode%402.1.1)
  requires a fresh server/transport per stateless request. Pindie's existing
  `createMcpHandler(() => createPindieControlMcpServer(workspace))` already builds
  a fresh server; the workspace remains the one shared runtime owner. A new
  regression holds a real HTTP wait response open while other clients repeatedly
  initialize/list/call; reusing one server would fail this overlap case.
- [node 2.1.2](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fnode%402.1.2)
  widens the node-server range; Hono became a regular dependency in 2.1.1.
- [server 2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol%2Fserver%402.4.0)
  adds opt-in Skills/event features, fixes modern transport revision binding,
  output-schema refs and `Allow: POST`. Pindie enables no new features and uses
  no `x-mcp-header` number annotations or affected schema IDs. Existing 64-element
  tool-input and 1-MiB HTTP-body limits remain enforced and tested.
- [node-server 2.1.3](https://github.com/honojs/node-server/releases/tag/v2.1.3)
  fixes GHSA-rmxm-3fg6-px4f; 2.1.4 widens the Hono peer to include 5 prereleases;
  [2.1.5](https://github.com/honojs/node-server/releases/tag/v2.1.5) fixes HTTP/2
  abort signals and restricts static serving to GET/HEAD. Pindie's `toNodeHandler`
  HTTP path has no static route; encoded static paths still return 404. No
  source/application behavior or Host/Origin/path checks change.

Candidate validation: frozen install; 86 focused security/Control lifecycle tests
pass (zero skipped), including repeated/overlapping HTTP initialize/list/call,
project open, disconnect/reconnect, idempotent shutdown, Host/Origin rejection,
encoded-path 404s, oversized fixed/chunked bodies, nested-input limits and browser
SDK stdio initialize/list/call. Version regressions resolve node-server from both
actual consumers, asserting 2.1.5; server/client core paths are separately pinned.
The fresh **unfiltered** `pnpm audit --json` returns **one Moderate only**, exit 1:
minimatch GHSA-g3hv-75wg-m249; no High/Critical/Low. Pi uses optimizationLevel 1
(default) and only `nocase`, not the vulnerable >=2 mode. Retain this real finding
and usage mitigation, not a Pi override or audit suppression. See the validation
result here for the full check: `pnpm run check` exited 0, **1,238 passed, 0 failed,
0 skipped**, duration 182069.071933 ms (typecheck then the unchanged full test glob).
Exact focused/full/audit output is retained in
`~/.local/state/pindie-maintenance/pr314-investigation-20261102/`.
CI/review and production acceptance remain separate evidence boundaries, not
inferred from this candidate audit.

## PR #313 historical evidence and scope

Production was clean `main` at PR #312's squash
`a836dec21af691ce4be80c7640d4d4c0f55470c2`. Its authorized temporary worktree/local
branch cleanup is complete; the cached origin tracking ref and original rollback
ref/snapshots remain. This follow-up does not change application source, services,
provider configuration, Sessions or Task semantics.

Fresh **unfiltered prod+dev** `pnpm audit --json` against that production lockfile
again returned **16 rows: 5 high, 9 moderate, 2 low, no critical**, exit 1.
All 16 match the historical report; there were no new findings. This is not an
inference from an old audit. Every GHSA was fetched afresh from GitHub's official
`/advisories/{GHSA}` API (CVE, affected/patched ranges, description and upstream
references). Selected versions/engines/dependencies/integrities were also checked
against `https://registry.npmjs.org/{package}/{version}`. Raw audit and official
GHSA responses are retained outside the repository as maintenance evidence.

The PR #313 lockfile audit returned **2 moderate rows, no high/critical/low**,
exit 1: node-server 1.19.17 and minimatch 10.2.6. Thus 14 advisory rows are removed;
one removed row previously covered both node-server majors and remains for 1.x.
Do not call this audit-clean or treat missing current sinks as universal safety.
No advisory filters, ignores, suppressions or test exclusions were added.

## PR #313 smallest compatible repair (historical)

Only these seven package records change; all other resolved package versions,
manifest dependencies, Node 24.22.2, pnpm 11.22.0, Pi 1.4.0, browser-use 0.1.15,
DevTools 1.9.0, direct MCP client/server 2.3.0, node adapter 2.1.0, Zod 4.6.7 and
both previously patched Undici lines remain unchanged:

| Package | Production → candidate | Compatibility evidence |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.30.0 → 1.32.0 | Same major; Node >=18; dependency/peer declarations unchanged. Browser client uses public stdio APIs, now exercised with a real credential-free child initialize/list/call. Google optional integration peer ^1.25.2 accepts it. |
| `hono` | 4.13.8 → 4.13.11 | Same-major patch; Node >=16.9; satisfies adapter/SDK peers. No added static routes. |
| `@hono/node-server` **2.x only** | 2.1.1 → 2.1.3 | Same-major patch; Node >=20; Hono ^4. The adapter's separate 1.19.17 remains. |
| `body-parser` | 2.3.0 → 2.4.0 | Same major; Node >=18; accepted by Express ^2.2.1; new lower bounds resolve to already installed package versions including qs 6.16.1. |
| `fast-uri` | 3.1.8 → 3.1.9 | Same-major patch; accepted by AJV ^3.0.1. |
| `ip-address` | 10.7.2 → 10.7.4 | Same-major patch; Node >=12; accepted by limiter ^10.2.0. |
| `qs` | 6.16.0 → 6.16.1 | Same-major patch; accepted by Express/body-parser; Node >=0.6. |

Exact vulnerable-version selectors in `pnpm-workspace.yaml` keep overrides limited
to these reviewed resolutions, including the SDK pinned by browser-use. No global
major override, package modernization or general `audit fix` is used. Existing
release-age/build policies and the prior scoped Undici override are retained.
The lockfile contains expected peer metadata/key rewrites, not Pi upgrades.
Re-evaluate/remove overrides when their parent dependencies are updated.

Read upstream [SDK 1.32.0 upgrade notes](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0):
cross-origin redirect behavior changes; `maxToolInputElements` and bearer
`expectedResource` remain **opt-in**. No 1.x HTTP/OAuth server is enabled here,
and this upgrade alone would NOT secure a newly enabled server. PR #312 already
sets 64-element/1-MiB limits on the actual direct 2.x Control server. Other fixes
are linked from the official advisories below to upstream patch/release records.

## Dependency paths and actual exposure proof

All 16 historical rows are **transitive**, but that alone is not mitigation.
The installed graph and call sites establish these paths/boundaries:

- **S:** browser-use → SDK; Pi coding-agent/agent-core → pi-ai → Google genai →
  SDK (pi-ai is also a root dev dependency but used at runtime). SDK resolves
  1.30.0 in production, 1.32.0 in the candidate. Browser-use's `dist/index.js`
  lazily imports `client/index.js` and `client/stdio.js`, constructs
  `StdioClientTransport` to the dedicated DevTools child, then calls
  initialize/list/call. It does not construct an SDK HTTP/OAuth server or client.
  Google provider requests in pi-ai do not enable genai's optional MCP adapter.
  These are checked-in provider paths, not a claim about arbitrary extensions.
- **H:** SDK → Hono/node-server; direct `@modelcontextprotocol/node` → Hono and
  node-server 1.19.17. `src/control-mcp-process.ts` imports only Node HTTP adapter
  and Host/Origin validators, registers exactly `/mcp`, returns 404 for other
  paths, and never registers `serveStatic`. This remains true even though Hono
  is installed. Local Chrome CDP is not an SDK HTTP server.
- **E:** S → SDK → Express → body-parser/qs; SDK → express-rate-limit →
  ip-address (and Express peer). No Express/body-parser/rate-limit import or
  middleware is configured in Pindie's actual HTTP service; compressed inbound
  request bodies cannot reach body-parser through this service.
- **U:** S → SDK → AJV (also ajv-formats) → fast-uri. Schema URI/reference handling
  exists, but Pindie does not use fast-uri as an outbound authorization, cache-key,
  rendering or host-validation policy boundary, nor configure suffix references.
  Do not mistake all schema parsing for the specific vulnerable policy sink.
- **M:** Pi coding-agent → minimatch 10.2.6 (also via browser-use's Pi peer).
  Installed `core/package-manager.js` calls minimatch with default options;
  `core/model-resolver.js` adds only `nocase: true`. Installed minimatch defaults
  `optimizationLevel` to **1**; amplification requires **>=2**. Tests assert the
  actual pinned Pi source has no optimizationLevel override and exercise both
  normal matching modes. Future Pi/package/extension behavior must be reassessed.

These observations were cross-checked against current production installed files
and source, not just an audit path or package name. Regressions resolve libraries
**from their consuming packages**, avoiding accidental testing of the direct 2.x
SDK instead of the browser's retained 1.x SDK.

## Every historical/current finding

Classification is the disposition **of this follow-up**, not a declaration of
universal exploitability. FIX_NOW includes compatible defense-in-depth repairs
of installed optional surfaces even where current usage mitigates exposure.
None is classified FALSE_POSITIVE/NOT_AFFECTED merely for being transitive.
GHSA links are authoritative records with upstream fix references. Severity uses
npm's `moderate` spelling (GitHub uses `medium`).

| # | Package/version; path | GHSA; CVE; severity | Patched version; prerequisites/current reachability | Classification; PR #312 status |
| --- | --- | --- | --- | --- |
| 1 | SDK 1.30.0 → 1.32.0; S | [6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h); CVE-2026-104850; high | >=1.31.0; SDK OAuth authProvider and stored credentials with attacker-selected issuer. S uses stdio, not HTTP OAuth. A newly enabled provider also needs issuer/storage assessment. | **FIX_NOW**. #312 patched direct client, not this installed SDK row. |
| 2 | Hono 4.13.8 → 4.13.11; H | [5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7); CVE-2026-111757; moderate | >=4.13.11; double-decoded serveStatic path behind prefix middleware. H registers no static route. | **FIX_NOW**. Not fixed by #312. |
| 3 | SDK 1.30.0 → 1.32.0; S | [22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw); CVE-2026-111767; high | >=1.32.0; shared experimental HTTP task store. No taskStore configured in S; Pindie durable Task is unrelated. | **FIX_NOW**. Not fixed by #312. |
| 4 | SDK 1.30.0 → 1.32.0; S | [6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw); CVE-2026-111769; moderate | >=1.32.0; cross-origin HTTP redirects resend headers/body. S is stdio; actual HTTP monitor uses direct client 2.3.0. | **FIX_NOW**. #312 fixed the actual monitor path, not retained SDK. |
| 5 | SDK 1.30.0 → 1.32.0; S | [46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453); CVE-2026-111768; high | >=1.32.0 **plus opt-in element limit**; HTTP tool validation can exhaust memory within body limit. S is not an HTTP server. Actual Control remains 2.3.0 with 64-element/1-MiB limits. | **FIX_NOW** package repair; **MITIGATED_BY_USAGE** for opt-in 1.x server configuration. #312 repaired exposed 2.x path. |
| 6 | SDK 1.30.0 → 1.32.0; S | [rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq); CVE-2026-111771; moderate | >=1.32.0 **plus expectedResource/verifier configuration**; audience-confused bearer helper. No SDK bearer helper configured in S or Control. | **FIX_NOW** package repair; **MITIGATED_BY_USAGE** for unused auth configuration. #312 did not enable audience validation. |
| 7 | ip-address 10.7.2 → 10.7.4; E | [rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5); CVE-2026-111997; moderate | >=10.7.4; hostile percent-heavy string plus line terminator reaches Address6. E is not the request path; no direct Address6 call. | **FIX_NOW**. Not fixed by #312. |
| 8 | body-parser 2.3.0 → 2.4.0; E | [27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828); CVE-2026-111181; high | >=2.4.0; compressed request with trailing bytes through middleware causes uncaught decoder error. E is absent from actual Control. | **FIX_NOW**. Not fixed by #312. |
| 9 | fast-uri 3.1.8 → 3.1.9; U | [w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg); CVE-2026-110306; moderate | >=3.1.9; scheme percent decoding used as trusted URL/policy normalization. U is not that policy boundary. | **FIX_NOW**. Not fixed by #312. |
| 10 | fast-uri 3.1.8 → 3.1.9; U | [xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h); CVE-2026-110095; low | >=3.1.9; normalize relative reference before resolution for cache/auth keys. No such policy in U. | **FIX_NOW**. Not fixed by #312. |
| 11 | fast-uri 3.1.8 → 3.1.9; U | [wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr); CVE-2026-110180; moderate | >=3.1.9; WHATWG host canonicalization policy/use mismatch. Control host validation does not use fast-uri. | **FIX_NOW**. Not fixed by #312. |
| 12 | fast-uri 3.1.8 → 3.1.9; U | [333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp); CVE-2026-110725; low | >=3.1.9; non-default suffix-reference serialization injects scheme. No suffix option configured. | **FIX_NOW**. Not fixed by #312. |
| 13 | SDK 1.30.0 → 1.32.0; S | [f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq); **no assigned CVE**; high | >=1.30.1; HTTP server body/batch limits missing. S uses stdio. Direct node/server 2.1.0 already fixed this older advisory. | **FIX_NOW**. #312 did not fix this retained SDK row; do not label direct node 2.1.0 affected. |
| 14 | node-server 2.1.1 → 2.1.3 **and retained 1.19.17**; H | [rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f); CVE-2026-118663; moderate | >=2.1.3; double-decoded serveStatic path. H registers no static route. | **FIX_NOW** 2.x; **MITIGATED_BY_USAGE** retained 1.x. Not fixed by #312. Do not force adapter's 1.x dependency across a major. |
| 15 | qs 6.16.0 → 6.16.1; E | [6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw); CVE-2026-110816; moderate | >=6.16.1; comma stringify of hostile objects with non-callable own toString. Parsing is not this sink; no such serializer configured. | **FIX_NOW**. Not fixed by #312. |
| 16 | minimatch 10.2.6 retained; M | [g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249); CVE-2026-118764; moderate | >=11.0.1 only; optimizationLevel >=2 amplification. M proves default 1/no override. | **MITIGATED_BY_USAGE**. Not fixed by #312. Retain Pi pin rather than unvalidated 10→11 override. |

At PR #313 the two retained rows were real affected installed versions, not false
positives. The adapter follow-up above removes the node-server row through a
newly supported dependency range; minimatch remains affected and usage-mitigated.
Reassess before adding static routes, changing minimatch options or enabling
custom extensions. Registry/GHSA provenance is not an independent source-code or
supply-chain audit. The browser SDK upgrade's real stdio test uses synthetic
messages, no actual browser/user data or paid provider request.

## Task lifecycle diagnosis and final acceptance boundary

Read the authoritative existing project State and the implemented
`src/state.ts`, `src/semantics.ts`, `src/transitions.ts`, `src/runtime.ts` and
`src/tools/task.ts` rather than introducing another Task layer:

- State stores **one current Task**, not a queue or nested checkpoints. The
  then-unfinished remediation Task was the correct durable owner of PR #313.
  That Task and its later scoped cleanup are complete; the adapter follow-up has
  a new durable Task and does not reopen completed work.
- `task.start` is legal only with no Task or a Task completed before the Run.
  The reducer also rejects start while a Task is unfinished. Therefore the earlier
  tiny package/HEAD command proved ordinary tool execution, **not** start/complete
  of another durable Task. There was no evidence of a broken execution path.
- `task.refine` and `task.progress` update that existing Task through supported
  tools, with save-before-publish. Goal/constraint/criterion changes invalidate
  verification; clearing stale blockers transitions blocked → active.
- There are **no required persisted workflow checkpoints**. Verification records
  are named upserts covering criterion IDs, backed by actual current tool evidence.
  Completion requires fresh passed coverage of every criterion, no failed checks,
  no blockers/questions/Gate. Completion clears next intent and is terminal.
- Do not complete or replace remediation merely to run a nested smoke Task.
  Existing Task completion itself is the final durable lifecycle test once all
  work is genuinely verified. A later tiny Task needs a later Run after completion;
  claiming it already happened would fabricate acceptance.

Live project/Session observation, current Task/Run timeline, discovery and supported
quota configuration must be recorded at the final deployed SHA. Saved global
fallback ON/model identity does not prove Session overrides or an active lease.
No provider quota request or fallback trigger is part of acceptance; unavailable
balance is **not** zero or healthy. Service-active Tunnel evidence is not an
independent external end-to-end test.

## Delivery boundary

Production remains untouched during development. Run focused security and Task
safety tests, the complete `pnpm run check`, an independent exact-diff review and
CI before authorized merge. If this change is deployed, use a new exact-SHA finite
independent maintenance transaction after the current Control Run settles, retain
PR #312 evidence/rollback and preserve zero-writer/frozen-install/automatic
rollback requirements. The old hard-coded PR #312 worker is **not** authorization
or a generic deployer for a new SHA. Never restart Control/Host from their active
Run or restart Tunnel to make checks green. Record actual results; do not infer
post-deploy success from CI. For the adapter follow-up, the user authorizes merge
only after passing CI and independent exact-diff review, then a new uniquely
named PR314 finite worker/state directory (not reuse of old hard-coded workers).
Require prefetch/parent/tree/reviewed-SHA validation before stopping services,
zero writers, local-only fast-forward, frozen install, focused **and full** checks,
fresh one-Moderate audit, package pins, 13-tool Control discovery/project open and
unchanged Tunnel PID 15895. Preserve rollback and automatic recovery evidence.
Independent read-only acceptance must occur in a new Session before scoped
cleanup of only PR314's worktree/local branch/fired timer; keep remote refs,
Sessions and all maintenance logs. No deployment or cleanup is claimed here.
