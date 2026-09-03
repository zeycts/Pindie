import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSessionRuntime,
  SessionManager,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

import { createPindieRuntimeFactory } from "../src/host.ts";
import { PiRuntimeAdapter } from "../src/pi-runtime.ts";

test("PiRuntimeAdapter replaces a real Pindie Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pindie-runtime-replacement-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  let runtime: AgentSessionRuntime | undefined;

  try {
    await mkdir(cwd);
    await mkdir(agentDir);
    runtime = await createAgentSessionRuntime(createPindieRuntimeFactory(), {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const adapter = new PiRuntimeAdapter(runtime);
    const beforeSessionId = adapter.activeSessionId;

    const result = await adapter.replaceWithFreshSession();

    assert.deepEqual(result, { cancelled: false });
    assert.notEqual(beforeSessionId, adapter.activeSessionId);
    assert.equal(adapter.activeSession, runtime.session);
    await adapter.dispose();
    runtime = undefined;
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
