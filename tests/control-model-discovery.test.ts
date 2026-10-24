import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";
import { PindieControlClient } from "../src/control-client.ts";
import { PindieControlWorkspace } from "../src/control-workspace.ts";
import { createPindieControlMcpServer } from "../src/control-mcp.ts";
import type { PindieHost } from "../src/host.ts";

test("model discovery projects only current cached Pi registry metadata, independent of picker scope", () => {
  const model = (provider: string, id: string) => ({ provider, id, name: id,
    reasoning: true, input: ["text", "image"], contextWindow: 123, maxTokens: 45,
    get cost() { throw new Error("must not read price"); },
    get baseUrl() { throw new Error("must not read endpoint"); },
    get headers() { throw new Error("must not read secrets"); },
  });
  let available = [model("z", "b"), model("a", "c"), model("a", "a")];
  let reads = 0;
  const adapter = new PiRuntimeAdapter({ session: {
    scopedModels: [],
    extensionRunner: { getModelRegistry: () => ({
      getAvailable: () => { reads++; return available; },
      refresh: () => assert.fail("no refresh"),
      getApiKeyAndHeaders: () => assert.fail("no credential resolution"),
    }) },
  } } as unknown as AgentSessionRuntime);
  const first = adapter.getAvailableModelCatalog();
  assert.deepEqual(first.map(({ provider, modelId }) => [provider, modelId]), [["a", "a"], ["a", "c"], ["z", "b"]]);
  assert.deepEqual(first[0], { provider: "a", modelId: "a", name: "a", reasoning: true,
    input: ["text", "image"], contextWindow: 123, maxTokens: 45 });
  first[0]!.input.push("text");
  assert.deepEqual(available[2]!.input, ["text", "image"]);
  available = [];
  assert.deepEqual(adapter.getAvailableModelCatalog(), []);
  assert.equal(reads, 2);
});

test("observe models uses Control client discovery without changing the thirteen tools or writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-model-discovery-"));
  await mkdir(join(root, "project"));
  const catalog = { source: "pi_available_registry_snapshot", models: [{ provider: "test", modelId: "one" }] };
  let reads = 0;
  // Exercise the real Control discovery method with only its narrow dependencies.
  const listModels = () => PindieControlClient.prototype.listModels.call({
    requireActiveBinding: () => ({}),
    runtime: { getAvailableModelCatalog: () => { reads++; return catalog.models; } },
  } as unknown as PindieControlClient);
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => ({ start: async () => {}, dispose: () => {}, observe: () => ({ lease: "live" }),
      listModels,
      configure: () => assert.fail("discovery must not configure"),
    }) as unknown as PindieControlClient,
  });
  const server = createPindieControlMcpServer(workspace);
  const peer = new Client({ name: "discovery-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await peer.connect(right);
    await peer.callTool({ name: "pindie_open_project", arguments: { project: "project" } });
    const normal = await peer.callTool({ name: "pindie_observe", arguments: {} });
    assert.equal(normal.structuredContent?.state, "active_project");
    assert.equal(reads, 0);
    const result = await peer.callTool({ name: "pindie_observe", arguments: { view: "models" } });
    assert.deepEqual(result.structuredContent, catalog);
    assert.equal(reads, 1);
    assert.equal((await peer.listTools()).tools.length, 13);
    assert.equal((await peer.callTool({ name: "pindie_observe", arguments: { view: "unknown" } })).isError, true);
  } finally { await peer.close(); await server.close(); await workspace.close(); await rm(root, { recursive: true }); }
});
