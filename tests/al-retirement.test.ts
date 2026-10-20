import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composePindieExtension, resolvePindieFeatureSelection } from "../src/composition.ts";
import { registerPindieExtension } from "../src/extension.ts";
import { renderPindieSystemContract } from "../src/context.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";

class MemoryStore implements PindieStateStore {
  state: PindieState = structuredClone(EMPTY_STATE);
  async load() { return structuredClone(this.state); }
  async save(_root: string, state: PindieState) { this.state = structuredClone(state); }
  async withProjectLock<T>(_root: string, operation: () => Promise<T>) { return operation(); }
}
const retiredTools = ["pindie_policy_set", "pindie_strategy_candidate_create",
  "pindie_strategy_derivation_candidate_create", "pindie_strategy_synthesis_candidate_create"];
const retiredCommands = ["experience", "strategies", "adapt", "derive", "trial", "trial-review", "promote", "reject", "derive-global", "trust-transfer"];

test("retired flags and direct overrides cannot reactivate AL, including malformed values", () => {
  for (const value of [undefined, "", "0", "1", "false", "true", "on", "yes", "invalid"]) {
    const selection = resolvePindieFeatureSelection({ selfImprovement: true, crossProjectLearning: true }, {}, {
      PINDIE_AUTONOMOUS_LEARNING_ENABLED: value, PINDIE_SELF_IMPROVEMENT_ENABLED: value,
      PINDIE_CROSS_PROJECT_LEARNING_ENABLED: value,
    });
    assert.equal(selection.selfImprovement, false);
    assert.equal(selection.crossProjectLearning, false);
    assert.equal(selection.bundledSkills, true);
    assert.equal(selection.presentation, true);
  }
});

test("composition drops poisoned learning injections without reading even their getters", () => {
  const input: any = { store: new MemoryStore(), featureSelection: { selfImprovement: true, crossProjectLearning: true } };
  for (const name of ["experienceStore", "experienceReader", "onExperienceSaved", "workEpisodes", "trialAssignmentStore",
    "trialHypothesisReader", "trialDiagnostic", "strategyCandidateStore", "strategyTrustScopeWriterLock",
    "strategySynthesisCandidateReader", "strategySynthesisDecisionStore", "crossProjectExperienceReader"]) {
    Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`Retired access: ${name}`); } });
  }
  const composition = composePindieExtension(input);
  assert.equal(composition.featureSelection.selfImprovement, false);
  for (const name of Object.keys(input).filter((k) => !["store", "featureSelection"].includes(k))) {
    assert.equal(Object.hasOwn(composition.extensionOptions, name), false);
  }
});

test("extension registers only live Core/Memory tools; retired calls are denied and advisory is absent", () => {
  const tools = new Map<string, any>(), commands = new Set<string>();
  const api = {
    on() {}, registerEntryRenderer() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string) { commands.add(name); },
  } as unknown as ExtensionAPI;
  const integration = registerPindieExtension(api, {
    store: new MemoryStore(), continuityStore: { async save() {} },
    featureSelection: { selfImprovement: true, crossProjectLearning: true, presentation: false },
    projectMemorySink: { async capture() {} } as any,
  });
  for (const name of retiredTools) {
    assert.equal(tools.has(name), false, name);
    assert.equal(integration.core.authorizeTool(name).decision?.allowed, false, name);
  }
  for (const name of retiredCommands) assert.equal(commands.has(name), false, name);
  for (const name of ["pindie_task_start", "pindie_task_complete", "pindie_verification_record", "pindie_gate_open", "pindie_gate_resolve", "pindie_git_observe", "pindie_memory_capture"]) {
    assert.equal(tools.has(name), true, name);
  }
  assert.equal(integration.runtime.workEpisodes, undefined);
  assert.equal(integration.trial, null);
  assert.equal(integration.policySnapshot, null);
  assert.doesNotMatch(renderPindieSystemContract(), /Seed Strategies|Policy Snapshot|\/adapt|\/trial|pindie_policy_set/);
});

test("ordinary Task transitions ignore a poisoned WorkEpisode ledger; semantic state still persists", async () => {
  const ledger = new Proxy({}, { get() { throw new Error("Learning ledger accessed"); } });
  const store = new MemoryStore(), runtime = new PindieRuntime(store, ledger as any);
  await runtime.load("/isolated-retirement");
  const started = await runtime.dispatch({ type: "start_task", goal: "Core survives", successCriteria: ["Persist without Learning"], constraints: [] });
  assert.equal(started.ok, true);
  assert.equal(runtime.state.task?.goal, "Core survives");
  assert.deepEqual(store.state, runtime.state);
  assert.equal(runtime.workEpisodes, undefined);
});

test("production entrypoint emitted import graph cannot load retired Learning/Policy modules", async () => {
  const base = resolve(import.meta.dirname, "../src"), visited = new Set<string>();
  const forbidden = /^(?:learning-|discovery-|project-discovery|self-improvement-|cross-project-|strategy-|strategies\.|policy\.|experience-|run-experience|trial-|ordinary-trial-|work-episode|open-hypotheses|hypothesis-lineage|v1-experience-|evaluation-|evaluator-|recovery-)/;
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const name = path.slice(base.length + 1);
    assert.equal(forbidden.test(name) || name === "tools/policy.ts" || name.startsWith("tools/strategy-"), false, `Production loads ${name}`);
    // Type-only legacy interfaces are deliberately erased; test actual emitted imports.
    const source = await readFile(path, "utf8");
    const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const match of emitted.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.\.?\/[^"']+\.ts)["']/g)) {
      await visit(resolve(dirname(path), match[1]!));
    }
  }
  for (const name of ["host.ts", "composition.ts", "extension.ts", "control-workspace.ts", "control-mcp.ts", "core-integration.ts"]) await visit(resolve(base, name));
  assert.ok(visited.size > 30);
});
