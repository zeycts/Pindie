import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  createCoreIntegration,
} from "../src/core-integration.ts";
import { EMPTY_STATE, getVerificationStatus, type PindieState } from "../src/state.ts";
import type {
  PindieStateStore,
  TaskContinuityStore,
} from "../src/store.ts";

class MemoryStateStore implements PindieStateStore {
  state: PindieState = structuredClone(EMPTY_STATE);

  async load(_projectRoot: string): Promise<PindieState> {
    return structuredClone(this.state);
  }

  async save(_projectRoot: string, state: PindieState): Promise<void> {
    this.state = structuredClone(state);
  }

  async withProjectLock<T>(_projectRoot: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

const continuityStore: TaskContinuityStore = {
  async save(): Promise<void> {},
};

function coreContext(): ExtensionContext {
  return {
    hasUI: false,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => "core-session",
    },
  } as unknown as ExtensionContext;
}

function coreApi(tools: Map<string, any>): ExtensionAPI {
  return {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
}

test("Core-only assembly owns base Task, Gateway, verification/Gate, and Seed Policy behavior", async () => {
  const store = new MemoryStateStore();
  const core = createCoreIntegration({
    store,
    continuityStore,
    taskHandoffEnabled: false,
  });
  const tools = new Map<string, any>();
  const ctx = coreContext();

  await core.runtime.load("/core-only");
  core.beginAgentRunFacts(ctx);
  core.registerTools(coreApi(tools));

  assert.equal(core.authorizeTool("edit").decision?.allowed, false);
  assert.equal(tools.has("pindie_strategy_candidate_create"), false);
  assert.equal(tools.has("pindie_memory_capture"), false);

  await tools.get("pindie_policy_set").execute("policy", {
    approach: "direct-action",
  });
  assert.equal(core.run.policySnapshot?.approach.id, "direct-action");

  await tools.get("pindie_task_start").execute("start", {
    goal: "Exercise the Core boundary",
    successCriteria: ["Core tools remain authoritative"],
  });
  assert.equal(core.authorizeTool("pindie_task_progress").decision?.allowed, true);

  await tools.get("pindie_gate_open").execute("open", {
    kind: "approval",
    question: "May the Core test continue?",
  });
  assert.equal(core.runtime.state.task?.humanGate?.kind, "approval");
  await tools.get("pindie_gate_resolve").execute("resolve", {});
  assert.equal(core.runtime.state.task?.humanGate, null);

  const effect = core.classifyToolEffect("read");
  const observation = {
    toolCallId: "core-read",
    toolName: "read",
    input: { path: "." },
    content: [{ type: "text", text: "Core observation" }],
    isError: false,
  } as any;
  core.execution.recordAuthorizedObservation(observation, effect);
  core.run.recordAuthorizedCall(observation.toolCallId, effect);
  core.run.recordSuccessfulCapability("task.start");
  const evidence = core.execution.captureEvidenceIfEligible(
    core.execution.takeAuthorizedExecution(observation.toolCallId)!,
    observation,
    core.run.authoritativeState,
    core.run.semanticRunFacts,
  );
  const evidenceRef = evidence?.content
    .flatMap((part: { type: string; text?: string }) => part.type === "text" && part.text ? [part.text] : [])
    .join(" ")
    .match(/Pindie evidence ref: ([^\]]+)/)?.[1];
  assert.ok(evidenceRef);

  await tools.get("pindie_verification_record").execute("verify", {
    check: {
      name: "core-boundary",
      status: "passed",
      covers: [core.runtime.state.task!.successCriteria[0]!.id],
      evidenceRefs: [evidenceRef],
    },
  });
  assert.equal(getVerificationStatus(core.runtime.state.task!), "passed");
});

test("Core integration has no optional feature implementation imports", async () => {
  const source = await readFile(new URL("../src/core-integration.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /(?:self-improvement|strategy-adaptation|strategy-derivation|strategy-candidate|strategy-trial|strategy-portfolio|cross-project|discord|remote|notion|project-memory)/iu);
  assert.doesNotMatch(source, /\b(?:event\s*bus|service\s*locator|dependency\s*registry|PindiePlugin)\b/iu);
});
