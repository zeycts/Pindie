# Control MCP error boundary and authentication release gate

Status: Phase 4 P1 adapter hardening. This is not public-access authentication
acceptance or deployment approval. Read with [Control v0.2](pindie-control-v0.2.md)
and [v0.1 runtime safety](pindie-control-v0.1.md).

## Public errors

`src/control-mcp-errors.ts` owns the reviewed MCP error vocabulary:

- Known `PindieControlError` codes expose only `code`, a static message, the
  existing bounded public Control `snapshot` when available, and optional
  `receipt` (`dispatchId`, `delivery`, `nextAction` only).
- Known `PindieWorkspaceError` codes expose only `code` and a static message.
- Unknown codes, malformed domain errors and arbitrary thrown values become
  `internal_error` with fixed observe/no-automatic-resend guidance. Do not read
  or serialize their message, stack, cause, custom members, `toString` or `toJSON`.
- The same safe object is returned as MCP text and structured content, with
  `isError: true`. Adding a domain code requires reviewing its static public
  message; dynamic exception text is not a fallback.

Workspace create/bootstrap/disposal and synchronous prompt-delivery wrappers
also no longer copy the underlying exception text. Model-unavailable errors do
not echo a requested provider/model identity in their message.

The Node adapter catches handler rejection. Before headers are sent it returns
HTTP 500 / JSON-RPC `-32603` with fixed text and null ID. After headers are sent
it destroys the incomplete response; it does not append an error to a partial
stream. An already-ended/destroyed response is left alone. None of these paths
replays an operation or fabricates a dispatch receipt. Startup, shutdown and
transport failure logging accepts only a phase and emits a fixed diagnostic,
not the thrown value or request headers.

This is an exception boundary, **not recursive redaction of legitimate Session
content**. The existing snapshot/timeline projection remains the public data
contract; user/assistant text is not rewritten. Existing separately bounded,
sanitized terminal-assistant diagnostics are unchanged. This change makes no
claim that all dependencies or ordinary Session content are secret-free.

## Recovery semantics remain unchanged

There are still exactly 13 tools with unchanged input schemas and authority
checks. Lease is lifecycle-scoped binding freshness, not caller identity.
`delivery_uncertain` retains its receipt and no-resend guidance. A transport
failure or timeout can lose the entire acknowledgement after acceptance; it
neither proves non-delivery nor Run failure. Reconnect and observe/wait/read the
current Session; if reconciliation is inconclusive, ask the human before a new
attempt. An explicit resend may execute twice. HTTP reconnect alone does not
rotate a live Host lease; Session rebind/restart does. No persistent exactly-once
ledger or new queue is introduced.

## Authentication evidence and limitations

The source binds `127.0.0.1` (default port 8765) and retains localhost Host and
Origin validation. These are DNS-rebinding/browser-origin defenses, **not bearer
validation or per-tool RBAC**. An isolated local fixture accepts both missing and
synthetic invalid Authorization headers, including project open; that documents
the local trust boundary, not a secure public endpoint.

The P0 read-only tunnel observation identified a running `tunnel-client-runtime`
artifact with SHA-256
`94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77`.
Its version subcommand exited 1. Process naming and a hash do not establish an
official distributor, version, upstream provenance or enforced caller identity.
No tunnel config/credentials were read and no public requests were made for P1.
The historical “OpenAI Secure MCP Tunnel” label in design docs is not independent
verification of the current running artifact. Cloudflare Access (or another
public caller authentication layer) and authorization policy remain **unverified**.
Do not add speculative `requireBearer`/RBAC or create a replacement tunnel from
this evidence.

### P2 release gate (requires separate human authorization)

Before claiming public-path security or deploying this change:

1. Establish the actual tunnel distributor/version/provenance and effective
   authentication policy through an approved, credential-safe operator review.
   Do not publish credentials, private routing URLs or raw config.
2. On an explicitly approved disposable route/fixture, verify authenticated
   intended-caller access, and rejection of missing, invalid, expired and wrong
   caller credentials at the public edge. Verify rejection prevents local tool
   execution, not merely that the client UI displays an error.
3. Verify the route cannot bypass the edge to reach the loopback service and
   document which layer owns identity enforcement. Test representative reads
   and consequential writes without production mutations; annotations and lease
   checks do not substitute for authentication.
4. Confirm public responses/logs contain no synthetic credential/header/path
   markers on failures. Reconfirm no automatic mutation replay after disconnect,
   receipt loss or restart. Keep timeout, dispatch outcome and semantic Task
   completion distinct.
5. Record positive and negative evidence with safe provenance, resolve failures,
   and obtain separate deployment/restart approval. P1 local tests/CI do not
   satisfy this gate.

## Regression evidence scope

`tests/control-mcp-error-boundary.test.ts` uses real loopback HTTP/MCP SDK clients
with stub execution and synthetic failures only. It covers unknown/non-Error
throws, nested causes, custom accessors/serialization, reviewed recovery fields,
unknown-code fail-closed behavior, Host bootstrap failure, HTTP rejection before
and after headers, fixed lifecycle logger output and actual CLI startup stderr.
The logger test covers shutdown's fixed diagnostic; it is not a production
signal/shutdown acceptance test. It also preserves local Host/Origin and
acceptance-timeout/reconnect/no-replay observations from the untouched P0 audit.
Existing Control client/workspace/MCP and native Pi HTTP tests cover schema,
lease, dispatch, receipt and settlement behavior. No provider, public route,
production service, real credentials or occupied TUI is exercised.
