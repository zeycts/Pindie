import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { composePindieExtension, resolvePindieFeatureSelection } from "../src/composition.ts";
import { registerPindieExtension, type PindieExtensionOptions, type PindieExtensionIntegration } from "../src/extension.ts";
import { classifyToolEffect } from "../src/execution-semantics.ts";
import { deriveCapabilities } from "../src/semantics.ts";
import { renderPindieSystemContract } from "../src/context.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { EMPTY_STATE, type PindieState } from "../src/state.ts";
import type { PindieStateStore } from "../src/store.ts";
import { importEdges, moduleSpecifiers, RETIRED_CPL_MODULES, RETIRED_MODULES } from "./retired-module-imports.ts";

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
    assert.equal("selfImprovement" in selection, false);
    assert.equal("crossProjectLearning" in selection, false);
    assert.equal(selection.bundledSkills, true);
    assert.equal(selection.presentation, true);
  }
});

test("composition drops poisoned learning injections without reading even their getters", () => {
  const removedOptionTypes: Extract<keyof PindieExtensionOptions,
    "experienceStore" | "experienceReader" | "onExperienceSaved" | "workEpisodes" |
    "strategyCandidateStore" | "strategyDecisionReader" | "strategyDerivationCandidateReader" |
    "strategyTrustScopeWriterLock" | "strategySynthesisDecisionStore" | "crossProjectExperienceReader" |
    "trialAssignmentStore" | "trialHypothesisReader" | "trialAssignmentPolicy" | "trialDiagnostic"> extends never ? true : false = true;
  assert.equal(removedOptionTypes, true, "retired dependencies cannot reappear in the public API");
  const removedIntegrationTypes: Extract<keyof PindieExtensionIntegration,
    "trial" | "derivation" | "globalDerivation" | "promotedStrategyRevisionCatalog" | "trustedStrategyPortfolio"> extends never ? true : false = true;
  assert.equal(removedIntegrationTypes, true, "retired null/empty accessors cannot reappear");
  const input: any = { store: new MemoryStore(), featureSelection: { selfImprovement: true, crossProjectLearning: true } };
  for (const name of ["experienceStore", "experienceReader", "onExperienceSaved", "workEpisodes", "trialAssignmentStore",
    "trialHypothesisReader", "trialAssignmentPolicy", "trialDiagnostic", "strategyCandidateStore", "strategyTrustScopeWriterLock",
    "strategySynthesisCandidateReader", "strategySynthesisDecisionStore", "crossProjectExperienceReader"]) {
    Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`Retired access: ${name}`); } });
  }
  const composition = composePindieExtension(input);
  assert.equal("selfImprovement" in composition.featureSelection, false);
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
  assert.deepEqual([...tools.keys()].sort(), ["pindie_task_start", "pindie_task_replace", "pindie_task_refine",
    "pindie_task_progress", "pindie_verification_record", "pindie_task_complete", "pindie_gate_open",
    "pindie_gate_resolve", "pindie_git_observe", "pindie_memory_capture"].sort(), "exact selected Core/Memory registry; no retired factory registration");
  for (const name of retiredTools) {
    assert.match(classifyToolEffect(name).requiredCapability, /^policy\./, "retired name cannot be reclassified as a Core grant");
    assert.equal(tools.has(name), false, name);
    assert.equal(integration.core.authorizeTool(name).decision?.allowed, false, name);
  }
  for (const name of retiredCommands) assert.equal(commands.has(name), false, name);
  for (const name of ["pindie_task_start", "pindie_task_complete", "pindie_verification_record", "pindie_gate_open", "pindie_gate_resolve", "pindie_git_observe", "pindie_memory_capture"]) {
    assert.equal(tools.has(name), true, name);
  }
  assert.equal("workEpisodes" in integration.runtime, false);
  for (const name of ["trial", "derivation", "globalDerivation", "promotedStrategyRevisionCatalog", "trustedStrategyPortfolio"]) {
    assert.equal(name in integration, false, name);
  }
  assert.equal("policySnapshot" in integration, false);
  assert.doesNotMatch(renderPindieSystemContract(), /Seed Strategies|Policy Snapshot|\/adapt|\/trial|pindie_policy_set/);
});

const historicalSeedIds = ["direct-action", "reproduce-first", "explore-first", "hypothesis-driven", "architecture-first", "minimal-change", "verify-as-you-go"];

test("Core contract remains deterministic without historical Seed guidance", () => {
  const first = renderPindieSystemContract();
  assert.equal(first, renderPindieSystemContract());
  assert.match(first, /^<PINDIE_SYSTEM_CONTRACT>[\s\S]*<\/PINDIE_SYSTEM_CONTRACT>$/);
  for (const term of ["Pindie System Contract", "Execution Gateway is authoritative", "Pindie Run Baseline", "Human Gate"]) assert.ok(first.includes(term), term);
  assert.doesNotMatch(first, /Seed Strategies|Policy Snapshot|\/adapt|\/trial/);
  for (const id of historicalSeedIds) assert.equal(first.includes(id), false, id);
});

test("Core system contract excludes retired Seed and Policy guidance", () => {
  const contract = renderPindieSystemContract();
  assert.doesNotMatch(contract, /Seed Strategies:|Current Policy Snapshot|pindie_policy_set/);
  for (const id of historicalSeedIds) assert.equal(contract.includes(id), false, id);
});

test("retired tools remain denied with coherent project mutation authority and cannot enter State", async () => {
  const api = { on() {}, registerEntryRenderer() {}, registerTool() {}, registerCommand() {} } as unknown as ExtensionAPI;
  const store = new MemoryStore();
  const integration = registerPindieExtension(api, { store, continuityStore: { async save() {} }, featureSelection: { presentation: false } });
  await integration.runtime.load("/isolated-denial");
  await integration.runtime.dispatch({ type: "start_task", goal: "Real work", successCriteria: ["deny retired tools"], constraints: [] });
  integration.core.beginAgentRunFacts({ sessionManager: { getEntries: () => [], getSessionId: () => "denial-session" } } as any);
  assert.equal(integration.core.authorizeTool("edit").decision?.allowed, true);
  const snapshot = integration.core.run.deriveSnapshot();
  assert.equal(snapshot.ok, true);
  if (snapshot.ok) for (const capability of deriveCapabilities(snapshot.snapshot)) assert.doesNotMatch(capability, /^policy\./);
  const before = structuredClone(store.state);
  for (const name of retiredTools) {
    assert.match(classifyToolEffect(name).requiredCapability, /^policy\./);
    assert.equal(integration.core.authorizeTool(name).decision?.allowed, false, name);
  }
  assert.deepEqual(store.state, before);
});

test("ordinary Task transitions ignore a poisoned WorkEpisode ledger; semantic state still persists", async () => {
  const ledger = new Proxy({}, { get() { throw new Error("Learning ledger accessed"); } });
  const store = new MemoryStore();
  const runtime: PindieRuntime = Reflect.construct(PindieRuntime, [store, ledger]);
  await runtime.load("/isolated-retirement");
  const started = await runtime.dispatch({ type: "start_task", goal: "Core survives", successCriteria: ["Persist without Learning"], constraints: [] });
  assert.equal(started.ok, true);
  assert.equal(runtime.state.task?.goal, "Core survives");
  assert.deepEqual(store.state, runtime.state);
  assert.equal("workEpisodes" in runtime, false);
});

test("all Stable source and mixed test AST edges exclude the 29 retired modules, including erased types", async () => {
  assert.equal(RETIRED_MODULES.size, 29);
  const root = resolve(import.meta.dirname, "..");
  const edges = await importEdges(root);
  const mixed = new Set(["composition", "extension", "al-retirement", "project-discovery", "trial-offers-pi", "trial-overlay-pi-r2"].map((name) => `tests/${name}.test.ts`));
  const frontier = [...mixed], visited = new Set<string>();
  while (frontier.length) {
    const from = frontier.pop()!;
    if (visited.has(from)) continue;
    visited.add(from);
    for (const edge of edges.filter((edge) => edge.from === from)) {
      assert.equal(RETIRED_MODULES.has(edge.to), false, `${edge.from} -> ${edge.to}`);
      if (edge.to.startsWith("tests/")) frontier.push(edge.to);
    }
  }
  for (const edge of edges.filter((edge) => edge.from.startsWith("src/") && !RETIRED_MODULES.has(edge.from))) {
    assert.equal(RETIRED_MODULES.has(edge.to), false, `${edge.from} -> ${edge.to}`);
  }
  assert.deepEqual(moduleSpecifiers(`import type { T } from "./a.ts"; type T2 = import("./b.ts").T;
    const a = import("./c.ts"); const b = require("./d.ts"); export type { T } from "./e.ts";
    import f = require("./f.ts");`), ["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts"]);
});

test("CPL source island and its fixture are physically absent with no remaining import consumers", async () => {
  const root = resolve(import.meta.dirname, "..");
  assert.equal(RETIRED_CPL_MODULES.size, 12);
  const removed = new Set([...RETIRED_CPL_MODULES, "tests/synthesis-trial-fixture.ts"]);
  for (const path of removed) {
    await assert.rejects(access(resolve(root, path)), { code: "ENOENT" }, `Retired artifact must be absent: ${path}`);
  }
  for (const edge of await importEdges(root, ["src", "tests", "scripts"])) {
    assert.equal(removed.has(edge.to), false, `${edge.from} -> ${edge.to}`);
  }
});

test("production entrypoint emitted import graph cannot load retired Learning/Policy modules", async () => {
  const base = resolve(import.meta.dirname, "../src"), visited = new Set<string>();
  const forbidden = /^(?:learning-|discovery-|project-discovery|self-improvement-|cross-project-|strategy-|strategies\.|policy\.|experience-|run-experience|trial-|ordinary-trial-|work-episode|open-hypotheses|hypothesis-lineage|v1-experience-|evaluation-|evaluator-|recovery-)/;
  async function visit(path: string): Promise<void> {
    if (visited.has(path)) return;
    visited.add(path);
    const name = path.slice(base.length + 1);
    assert.equal(forbidden.test(name) || name === "tools/policy.ts" || name.startsWith("tools/strategy-"), false, `Production loads ${name}`);
    // Independently check the actual emitted transitive runtime graph.
    const source = await readFile(path, "utf8");
    const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const match of emitted.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.\.?\/[^"']+\.ts)["']/g)) {
      await visit(resolve(dirname(path), match[1]!));
    }
  }
  for (const name of ["host.ts", "composition.ts", "extension.ts", "control-workspace.ts", "control-mcp.ts", "core-integration.ts"]) await visit(resolve(base, name));
  assert.ok(visited.size > 30);
  for (const name of ["discovery-contract.ts", "discovery-hypotheses.ts", "hypothesis-lineage.ts", "open-hypotheses.ts",
    "ordinary-trial-overlay.ts", "trial-assignment-v2.ts", "trial-evidence-v2.ts", "v1-experience-protection.ts", "experience-lifecycle.ts",
    "strategy-adaptation.ts", "strategy-global-derivation.ts", "strategy-candidate-commands.ts", "strategy-candidate-resolution.ts",
    "learning-artifact-liveness.ts", "tools/strategy-candidate.ts", "tools/strategy-derivation-candidate.ts", "tools/strategy-synthesis-candidate.ts",
    "strategy-knowledge.ts", "strategy-knowledge-file.ts", "strategy-trust-scope.ts", "strategy-synthesis-review.ts",
    "strategy-trial.ts", "strategy-synthesis-trial.ts", "strategy-trust-scope-trial.ts",
    "tools/policy.ts", "trial-offer-contract.ts"]) {
    await assert.rejects(access(resolve(base, name)), { code: "ENOENT" }, `Retired AL module must be physically absent: ${name}`);
  }
});
