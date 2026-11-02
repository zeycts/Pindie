# Post-cutover dependency security review — 2026-11-01

## Baseline and scope

Deployed clean `main`: `64285157eee120de48432948a6e091c531c48ed9`, equal to
GitHub `zeycts/Pindie` main when audited. GitHub's manifest and lockfile at that
commit matched the deployed bytes. Baseline SHA-256:

- `package.json`: `4873a8d314cf921d19074561d3ea5a7b202626dd5eba6248ccb302507c125822`
- `pnpm-lock.yaml`: `e6fa79325ec27d4f68cf4e2b11605d45b32adf4317e554ae53e60c2258faedf9`

`pnpm audit --json` with **no prod/dev/severity exclusions** reported 38 advisory
rows (29 unique GHSAs): 17 high, 18 moderate, 3 low, no critical. Every GHSA was
cross-checked with GitHub's official advisory API, including its upstream
references, affected ranges and remediation requirements. Multiple rows can
represent one GHSA affecting different package majors; counts are not exploit
counts. Audit exits 1 when findings remain.

Cutover acceptance is separate from this PR: earlier actual executable checks
passed for live Control and interactive Host Node 24.22.2, live Control pnpm
11.22.0, installed Pi 1.4.0 and MCP initialize/13-tool discovery. Tunnel remained
active with the original PID 15895 and no restart. The human confirmed the
post-cutover 18:01:44 native `/session` capture restores interactive Session
`01a176bc-17f6-73a2-b840-4a276a766068`. The filename's old timestamp is Session
creation time, not capture time. Prior Control Session
`01a19823-8fcd-7406-868a-d34f709165c8` remains a native historical record; the new
security Task correctly uses a separate Control Session. No switching was needed.

## Smallest selected changes and compatibility

| Package | Baseline → selected | Reason |
| --- | --- | --- |
| `undici` | 6.28.0 → 6.29.1 | Same-major fixes for outbound HTTP/TLS; also updates compatible Discord and OpenAI peer resolutions. |
| Pi's `undici` | 8.10.2 → 8.12.2 | Only `@earendil-works/pi-coding-agent@1.4.0>undici` is overridden; Pi pins this dependency, so ordinary compatible resolution cannot repair it. |
| `@modelcontextprotocol/client` | 2.1.0 → 2.3.0 | Same-major cross-origin redirect fix; loopback monitor uses this HTTP transport, without OAuth. |
| `@modelcontextprotocol/server` | 2.1.0 → 2.3.0 | Enables pre-validation argument element limits. |
| `@modelcontextprotocol/core` | 2.1.0 → 2.3.0 | Required exact dependency of the selected SDK client/server. |
| `zod` | 4.6.5 → 4.6.7 | Early constrained-collection size checks shipped in 4.6.6; 4.6.7 is a version-metadata-only follow-up, allowing one shared resolution. |

Node 24.22.2, pnpm 11.22.0, every Pi 1.4.0 package, browser-use 0.1.15,
`@modelcontextprotocol/node` 2.1.0 and all other package versions stay unchanged.
The lockfile package-record diff contains only the six substitutions above;
peer snapshot keys also change. No audit fix, broad update, major upgrade or
blanket override is used. Existing build/release-age policies are retained.

Reviewed upstream [Undici 6.29.1](https://github.com/nodejs/undici/releases/tag/v6.29.1)
and [8.12.2](https://github.com/nodejs/undici/releases/tag/v8.12.2) security notes
and intervening minor-release notes. Undici 6 requires Node >=18.17; Undici 8
requires >=22.19.0, compatible with production and existing CI. Pi's
`core/http-dispatcher.js` uses `Client`, `Pool`, `EnvHttpProxyAgent`,
`setGlobalDispatcher` and `install`; their compatibility is exercised in an
isolated subprocess, including gzip JSON fetch. No production dispatcher is changed.
The scoped override requires re-evaluation when Pi is upgraded.

Reviewed SDK [2.2.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.2.0)
and [2.3.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.0)
upgrade notes. The existing `createMcpHandler(() => createPindieControlMcpServer(workspace))`
already supplies a fresh server per request, so the new shared-server rejection
needs no lifecycle rewrite. Monitor endpoints do not require cross-origin redirects.
Node adapter 2.1.0's server peer range accepts 2.3.0 and it already supports the
body-size option. No bearer/OAuth configuration is introduced.

Reviewed [Zod 4.6.6](https://github.com/colinhacks/zod/releases/tag/v4.6.6) and
[4.6.6…4.6.7](https://github.com/colinhacks/zod/compare/v4.6.6...v4.6.7).
Upstream notes that the September compromised Git commits were reverted and never
published to npm. Registry integrity metadata is used by the lockfile; this is
not an independent audit of upstream supply-chain provenance.

**An SDK upgrade alone does not fix GHSA-46jr-4wx8-v453.** Control now explicitly
sets `maxToolInputElements: 64` (current tools need at most eight object members)
and `maxRequestBodySize: 1 MiB` on both the handler and Node adapter. The latter
bounds pre-tool JSON-RPC parsing too. This intentionally rejects exceptionally
large wire requests, previously allowed up to the SDK's 4 MiB default; ordinary
64 KiB prompts and all current tool schemas remain supported. Unknown nested
arrays/objects are rejected before tool schema validation and workspace dispatch.
No tool visibility, lease, Session, Task or execution authorization changes.

## Complete advisory and exposure map

Each GHSA link below is the official database record, including the upstream
package advisory/patch links. Exposure describes current checked-in call sites,
not a guarantee that every dependency feature is safe for arbitrary future use.

### Undici: selected repairs

Direct `src/discord-gateway.ts` uses 6.x `ProxyAgent`; Discord REST resolves 6.x
and can make HTTP requests through it. OpenAI accepts the same Undici peer.
Pi 1.4.0 pins 8.x in `core/http-dispatcher.js`; native InteractiveMode configures
its dispatcher and installs npm Undici fetch/globals, making outbound HTTP/TLS
and potentially WebSocket paths relevant. Codex uses `api/openai-codex-responses.js`;
its Node WebSocket branch can use `ws`, so do not assume every Codex WebSocket is
an Undici WebSocket. Exposure requires a malicious/compromised contacted peer,
not an arbitrary inbound connection. No production endpoint was attacked.

| GHSA | CVE | Baseline version(s) | Reachability/prerequisite |
| --- | --- | --- | --- |
| [3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) | CVE-2026-85024 | 6.28.0 | Undici WebSocket permessage-deflate; Discord uses `ws`, not this implementation. |
| [r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) | CVE-2026-18540 | 6.28.0 | Retry interceptor plus downstream response forwarding; neither is configured by Pindie. |
| [rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | CVE-2026-19534 | 6.28.0 | Undici WebSocket unrequested subprotocol; no direct Pindie 6.x WebSocket construction. |
| [4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | CVE-2026-109924 | 6.28.0, 8.10.2 | Undici EventSource; no Pindie EventSource construction. Streaming fetch/SSE is not this parser. |
| [f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | CVE-2026-109841 | 8.10.2 | Uppercase/mixed-case SRI metadata; no integrity option configured. |
| [xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | CVE-2026-109869 | 6.28.0, 8.10.2 | Outbound fetch response with excessive encodings; relevant to Pi's installed fetch. Regression tests both lines in child process. |
| [4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | CVE-2026-109829 | 8.10.2 | Shared cache plus redirect interceptor composition; not configured. |
| [2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | CVE-2026-109383 | 6.28.0, 8.10.2 | Function-valued `tls` pinning callback; no such Pindie option. Ordinary certificate validation is not bypassed. |
| [qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | CVE-2026-87018 | 6.28.0, 8.10.2 | Outbound TLS 1.2 renegotiation crash; relevant to HTTP clients, not excluded by application catches. |
| [9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | CVE-2026-109932 | 6.28.0, 8.10.2 | Undici WebSocket PONG buffering; conditional on use of this implementation. |
| [55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) | CVE-2026-87029 | 8.10.2 | Decompress interceptor plus throwing handler; not configured. |

The fixed package versions remove these findings together; separate feature
refactors/workarounds would be larger and less complete. npm audit does not audit
Node's bundled Undici. This PR does not replace Node or promise to patch built-in
implementations used independently of Pi's npm dispatcher.

### MCP and Zod: repaired direct surface, retained dormant 1.x graph

The direct client is declared under devDependencies but is **runtime-used** by
`src/control-monitor-client.ts`; it must not be dismissed as test-only. The
server/node adapter are production dependencies in `src/control-mcp-process.ts`.
Loopback Host/Origin checks and private Tunnel transport limit access, but do not
replace body/validation limits against a compromised authorized caller.

`@modelcontextprotocol/sdk` 1.30.0 is transitive through browser-use 0.1.15 and
Pi → pi-ai → `@google/genai`. Browser-use's `dist/index.js` creates only a
`StdioClientTransport` to the dedicated DevTools bridge. Pindie does not construct
an SDK 1.x HTTP server/client, OAuth provider or experimental task store. Google
MCP integration is not enabled by Pindie. The SDK's optional Express/server stack
is installed, not exposed by these call sites.

| GHSA | CVE | Baseline affected packages | Current exposure/action |
| --- | --- | --- | --- |
| [6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) | CVE-2026-104850 | client 2.1.0; sdk 1.30.0 | No OAuth/authProvider in monitor; browser uses stdio. Direct client repaired, dormant 1.x remains. No credential migration/rotation warranted by observed use. |
| [22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) | CVE-2026-111767 | sdk 1.30.0 | Requires HTTP server `taskStore`; none configured. Retained. Pindie durable Task is unrelated. |
| [6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) | CVE-2026-111769 | client 2.1.0; sdk 1.30.0 | Monitor uses loopback Streamable HTTP; direct client repaired and cross-origin 307 refusal tested. Stdio 1.x unaffected in current use. |
| [jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp) | CVE-2026-111770 | server 2.1.0 | Existing per-request factory already meets mitigation; updated server preserves it. |
| [46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) | CVE-2026-111768 | server 2.1.0; sdk 1.30.0 | Direct HTTP validation is exposed; server upgrade **and explicit limits** applied. Dormant 1.x server remains installed. |
| [rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) | CVE-2026-111771 | server 2.1.0; sdk 1.30.0 | Requires SDK bearer auth without audience checks; Pindie does not use these helpers. Upgrade alone does not enable audience validation. No auth changes. |
| [f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq) | No CVE assigned in official record | sdk 1.30.0 | Dormant HTTP server only. Direct node/server 2.1.0 already fixed this earlier issue; not every 2.1.0 package was vulnerable to it. |
| [mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | CVE-2023-54404 | zod 4.6.5 | SDK/protocol/tool schema validation; Zod patched throughout graph. Early collection bounds tested; unbounded schemas are not magically bounded by the patch. |

### Other retained findings: no current vulnerable use identified

| Package/path | GHSA / CVE | Reachability and reason not to expand this PR |
| --- | --- | --- |
| `hono` 4.13.8 via node adapter and sdk 1.x | [5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7), CVE-2026-111757 | Requires `serveStatic` with protected static prefixes. Control uses Node HTTP `/mcp`, not static file serving. |
| `@hono/node-server` 1.19.17 via node adapter; 2.1.1 via sdk 1.x | [rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), CVE-2026-118663 | Same static middleware prerequisite, absent. Official patched range starts 2.1.3; forcing 1.x to 2.x is unnecessary. |
| sdk 1.x → `express-rate-limit` → `ip-address` 10.7.2 | [rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5), CVE-2026-111997 | Attacker-controlled string with many `%` plus a line terminator passed to Address6. No Express rate limiter or direct Address6 use exposed. |
| sdk 1.x → `express` → `body-parser` 2.3.0 | [27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), CVE-2026-111181 | Requires compressed request through body-parser middleware. Control uses neither Express nor body-parser. |
| sdk 1.x → `ajv` → `fast-uri` 3.1.8 | [w74x-v6f9-j3xg](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), CVE-2026-110306 | Percent-encoded scheme normalization becomes active scheme. No use for rendering URLs or outbound/authorization policy. |
| Same `fast-uri` path | [xhq7-xmqj-769h](https://github.com/advisories/GHSA-xhq7-xmqj-769h), CVE-2026-110095 | Relative-reference normalization before resolution; no Pindie cache/auth/reference policy using it. |
| Same `fast-uri` path | [wjr9-j795-jxcr](https://github.com/advisories/GHSA-wjr9-j795-jxcr), CVE-2026-110180 | Host canonicalization policy/use mismatch; no Pindie host policy based on fast-uri. |
| Same `fast-uri` path | [333x-w4r6-6crp](https://github.com/advisories/GHSA-333x-w4r6-6crp), CVE-2026-110725 | Requires non-default `reference: 'suffix'`; not configured. Browser bridge schemas are pinned/checked, not arbitrary URL policy. |
| sdk 1.x → `express`/`body-parser` → `qs` 6.16.0 | [6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw), CVE-2026-110816 | Requires `stringify` with `arrayFormat: 'comma'` and hostile object elements; no such Pindie use. |
| Pi 1.4.0 → `minimatch` 10.2.6 | [g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), CVE-2026-118764 | Requires `optimizationLevel >= 2`. Pi's `core/package-manager.js` and `core/model-resolver.js` use default level 1 (latter adds only `nocase`). Only patched major is 11.0.1; no unsupported major override. |

After the scoped repair the complete audit reports **16 rows** (5 high,
9 moderate, 2 low). All are the retained findings described above. No advisory
exclusions, severity filters or policy suppression were added. Revisit these
paths if HTTP/OAuth/tasks/static serving, schema-driven URL policy or higher
minimatch optimization is introduced. "No current vulnerable use identified"
is not proof of universal unreachability or permission to expose them.

## Verification and delivery boundary

New regressions cover nested argument budgets, both fixed/chunked oversized HTTP
requests, continued discovery and ordinary prompts, cross-origin MCP redirects,
Zod early bounds, excessive-encoding process survival in both Undici majors, and
the actual pinned Pi dispatcher APIs/gzip fetch in a credential-free subprocess.
Existing Control and Discord security/lifecycle tests remain in the check glob.
No production service, Session, config, networking, credentials or Tunnel source
is changed by this PR. Full `pnpm run check` and CI results belong in the PR's
verification section, not inferred from this audit document.

Keep deployed commit `64285157eee120de48432948a6e091c531c48ed9` and its original
lockfile as rollback. Do not merge before independent actual-diff/CI review.
Any subsequent deployment must use an explicitly authorized external maintenance
boundary for Control/interactive Host replacement, preserving native Session
identities and user storage. Never restart them from their active execution
Session. This diff does not require a Tunnel restart.
