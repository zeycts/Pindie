# Bundled provider-native web search

Pindie ships `web_search` and `url_context` as repository source. A normal
`pnpm install --frozen-lockfile` + `pnpm pindie` needs **no `pi install`**, no
`pi-web-search` dependency/package declaration and no user npm installation.
Pindie currently runs from its checkout (`private: true`, no separate published
binary/build artifact). Copy/ship the complete checkout, including
`src/vendor/pi-web-search/{NOTICE.md,LICENSE}`. An ordinary dependency install
supplies Pi/TypeBox, not a search plugin. Credentials still require normal Pi
provider setup; bundling is not an anonymous search service.

## Design and entry points

The provider implementation is an attributed, reviewable snapshot of the official
npm **pi-web-search 1.7.0** by **ttttmr**, declared MIT. See
[the notice and exact local delta](../src/vendor/pi-web-search/NOTICE.md).
Keeping the transport/citation snapshot avoids a second hand-written Codex SSE,
Gemini grounding and Anthropic search implementation. It adds about 2,500 lines
of vendored source but no runtime dependency/update mechanism. Pindie owns only
a small registration adapter, not another Agent Loop or provider registry.

- **Pindie Host** (`pnpm pindie`, including Control-managed project Hosts):
  `createPindieRuntimeFactory` adds a named, `replaceable` inline extension to
  native Pi services. It is reconstructed for Session/project replacements and
  reloads. Native `InteractiveMode` uses this same Host runtime; there is no
  second TUI tool implementation or custom search renderer.
- **Direct native Pi extension** (Pindie package manifest, or `pi -e
  ./src/extension.ts`): the configured entry registers missing search tools at
  `session_start`, when Pi's tool inventory becomes available. It does not
  overwrite tools or reactivate ones that are already registered but disabled.
- Low-level `registerPindieExtension`/Core test embeddings are deliberately not a
  second composition root; they do not implicitly install provider adapters.

Pi owns registration, validation, native rendering, active-tool selection and
execution. Existing `web_search` / `url_context` Gateway effects remain
`observe.project` / mutation `none`; no authorization is weakened. Search
results are factual tool evidence, not automatic semantic verification passes.

## Provider scope and evidence

| API/provider family | Bundled behavior | Verification level |
| --- | --- | --- |
| OpenAI Codex Responses | OAuth/account header, forced native search, SSE and sources, current thinking level | Fixtures + isolated real `openai-codex/gpt-6.1-sol` smoke |
| OpenAI Responses (incl. Azure/Copilot gateways) | Upstream native Responses search, endpoint/auth handling | OpenAI fixture; Azure/Copilot live not checked |
| Gemini | Google Search grounding, sources, optional URL Context/YouTube | Gemini search fixture; live and video not checked |
| Anthropic Messages | Native server web search and citations | Fixture; live/OAuth not checked |
| xAI/Grok, DeepSeek, OpenCode Responses, Ollama Cloud, Antigravity | Retained upstream transport/dialect support | Not live-validated here; provider/account availability applies |

There is no universal parity promise. Chat-completions-only models and local
Ollama are unsupported. `url_context` is registered on all models and returns an
explicit unsupported-provider error outside Gemini/Ollama Cloud, instead of
Pindie changing active tools on model changes. Search uses the current model;
unsupported models fail rather than silently spending on another provider.

Existing `web-search.json` (provider/model) and `PI_WEB_SEARCH_CONFIG` remain
compatible with upstream. Their path follows `PI_CODING_AGENT_DIR` (default
`~/.pi/agent`), not a separate SDK `agentDir` override. Embedders using a distinct
`agentDir` should explicitly set `PI_WEB_SEARCH_CONFIG` or the matching
`PI_CODING_AGENT_DIR`. No new config is required for Codex.

## Existing plugin coexistence / migration

Do **not** uninstall or edit the user's current plugin automatically.

- Host: when another extension registers either search tool, Pi drops the entire
  replaceable bundled extension before activation. The installed plugin remains
  the owner (including its handlers and renderer), without duplicate tools.
- Direct Pi: missing names are filled individually at session startup; existing
  names are left intact. This late-registration compatibility path uses Pi's
  tool registration/selection rules; it does not replay or rewrite Session
  history. Prefer Host for normal Pindie usage and precise native startup restore.
- To opt into the bundled implementation on a machine that has the plugin,
  disable its **extension resource for that Pindie scope** through native Pi
  resource configuration, or use an isolated Pindie agent directory. Keep it
  enabled for other Pi projects. Do not delete the global installation as a
  migration step. A project-local resource override requires project trust.
- New installations/migrations only need Pindie source/dependencies and provider
  credentials; do not copy npm plugin directories to make search available.

This PR does not alter production settings or the existing running Session.
After an explicitly approved merge/deployment, a normally started replacement
Host gets the feature; no self-restart of an active Control request is needed.
Reverting the code commit removes the bundled fallback and leaves installed
plugins untouched.

## Network and safety

Only the search query/optional supplied URLs go to the selected provider (not
full Session history). The adapter uses Pi credential resolution; no new secret
store. Codex requests use `store:false`. Configured endpoints/proxies remain
credential trust boundaries. Gemini may HEAD Google grounding redirect URLs;
other URL retrieval is provider-side. No vendor-owned process execution or
filesystem writes. Provider errors and search content are untrusted external
input. The inherited provider-specific quota/cost and service terms apply;
OAuth token refresh is Pi-owned. Tests use fake credentials; live smoke uses
private temporary credential/catalog copies, never prints secrets, and deletes
those copies. Real secrets should never be committed.

## Verification commands

```sh
node --experimental-strip-types --test tests/web-search.test.ts tests/host.test.ts
pnpm run check
# Explicit opt-in: real provider usage/quota; all packages/settings are clean.
PINDIE_WEB_SEARCH_AUTH_SOURCE=/path/to/authorized/pi/agent \
  node --experimental-strip-types scripts/web-search-smoke.ts
```

The live smoke constructs the **actual Host factory** with a temporary clean
`PI_CODING_AGENT_DIR`, `packages: []`, temporary Pindie storage, no Remote/Memory,
and an in-memory Session. It asserts the loaded extension is inline Pindie
source, not a user plugin, then requires native search evidence plus sources.
The model/catalog/credential copies are only for provider access and cannot
introduce extension declarations. Offline CI uses provider HTTP/SSE fixtures
and native loader/Host integration tests, not an external API or user settings.
