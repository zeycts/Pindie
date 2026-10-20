import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

import {
  composeConfiguredPindieExtension,
  composePindieExtension,
  DEFAULT_PINDIE_FEATURE_SELECTION,
  resolvePindieFeatureSelection,
  resolvePindieStorageRoots,
} from "../src/composition.ts";
import { RemoteRoutingStore } from "../src/remote-routing.ts";
import { FileStateStore } from "../src/store.ts";
import { FileQuotaResumePreferenceStore } from "../src/quota-resume.ts";
import { FileQuotaFallbackPreferenceStore } from "../src/quota-fallback.ts";
import { getProjectId } from "../src/store.ts";
import { RemoteCompanion, type RemoteSurface } from "../src/remote-companion.ts";
import type { ProjectMemorySink } from "../src/project-memory.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPindieExtension, type PindieExtensionOptions, type PindieExtensionIntegration } from "../src/extension.ts";
import { classifyToolEffect } from "../src/execution-semantics.ts";
import { deriveCapabilities } from "../src/semantics.ts";
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

const projectRoot = "/workspace/composable-pindie";
const execFileAsync = promisify(execFile);
const roots = {
  projectsBaseDir: "/tmp/pindie-projects",
  globalBaseDir: "/tmp/pindie-global",
  remoteRoutingBaseDir: "/tmp/pindie-remote",
};
const retiredDependencies = [
  "experienceStore", "experienceReader", "onExperienceSaved", "workEpisodes",
  "trialAssignmentStore", "trialHypothesisReader", "trialAssignmentPolicy", "trialDiagnostic",
  "strategyCandidateStore", "strategyCandidateReader", "strategyDerivationCandidateStore", "strategyDerivationCandidateReader",
  "strategyDecisionStore", "strategyDecisionReader", "strategyDerivationDecisionStore", "strategyDerivationDecisionReader",
  "strategyTrustScopeCandidateStore", "strategyTrustScopeDecisionStore", "strategyTrustScopeSourceResolver", "strategyTrustScopeWriterLock",
  "crossProjectExperienceReader", "crossProjectTrustReader", "scopeProjectTrustReader",
  "strategySynthesisCandidateReader", "strategySynthesisDecisionReader", "strategySynthesisCandidateStore", "strategySynthesisDecisionStore",
];
function assertRetiredAbsent(composition: ReturnType<typeof composePindieExtension>) {
  for (const name of ["selfImprovement", "crossProjectLearning"]) assert.equal(Object.hasOwn(composition.featureSelection, name), false, name);
  for (const name of retiredDependencies) assert.equal(Object.hasOwn(composition.extensionOptions, name), false, name);
}
// Explicit historical JS payload, not a supported typed feature selection.
const legacySelection = (selfImprovement: boolean, crossProjectLearning: boolean) => ({ selfImprovement, crossProjectLearning, presentation: true });

test("production composition excludes retired WorkEpisode and Learning dependencies", () => {
  const composition = composeConfiguredPindieExtension({ storageRoots: roots }, {});
  assertRetiredAbsent(composition);
  assert.equal("trialOffers" in composition.extensionOptions, false);
  assert.equal("trialOfferPolicy" in composition.extensionOptions, false);
});

test("Slice A resolves stable startup defaults and explicit dependency roots", () => {
  assert.deepEqual(resolvePindieFeatureSelection({}, {}, {}), DEFAULT_PINDIE_FEATURE_SELECTION);
  assert.deepEqual(resolvePindieStorageRoots({}, "/isolated-home"), {
    projectsBaseDir: "/isolated-home/.pindie/projects",
    globalBaseDir: "/isolated-home/.pindie/global",
    remoteRoutingBaseDir: "/isolated-home/.pindie/remote/discord/projects",
  });
  const composition = composePindieExtension({ featureSelection: legacySelection(true, true), storageRoots: roots });
  assert.deepEqual(composition.storageRoots, roots);
  assert.equal((composition.extensionOptions.store as FileStateStore).storageBaseDir, roots.projectsBaseDir);
  assert.ok(composition.extensionOptions.quotaResumePreferenceStore instanceof FileQuotaResumePreferenceStore);
  assert.ok(composition.extensionOptions.quotaFallbackPreferenceStore instanceof FileQuotaFallbackPreferenceStore);
  assert.deepEqual(composition.extensionOptions.quotaResumePreferenceStore, new FileQuotaResumePreferenceStore({ baseDir: roots.globalBaseDir }));
  assert.deepEqual(composition.extensionOptions.quotaFallbackPreferenceStore, new FileQuotaFallbackPreferenceStore({ baseDir: roots.globalBaseDir }));
  assertRetiredAbsent(composition);
});

test("Slice A gives configured Remote an explicit routing root", () => {
  const composition = composeConfiguredPindieExtension({ storageRoots: roots }, {
    PINDIE_DISCORD_TOKEN: "token", PINDIE_DISCORD_USER_ID: "123456789012345678", PINDIE_DISCORD_GUILD_ID: "987654321098765432",
  });
  assert.ok(composition.remoteRoutingStore instanceof RemoteRoutingStore);
  assert.equal(composition.remoteRoutingStore?.path(projectRoot), join(roots.remoteRoutingBaseDir, `${getProjectId(projectRoot)}.json`));
  assert.equal(composition.extensionOptions.remoteRoutingStore, composition.remoteRoutingStore);
});

test("Slice A never derives feature roots from an injected StateStore", () => {
  const composition = composePindieExtension({ featureSelection: legacySelection(true, false), store: new FileStateStore({ baseDir: "/tmp/state-only" }), storageRoots: roots });
  assert.equal((composition.extensionOptions.store as FileStateStore).storageBaseDir, "/tmp/state-only");
  assert.equal(composition.storageRoots.projectsBaseDir, roots.projectsBaseDir);
  assertRetiredAbsent(composition);
});

test("retired SI and CPL overrides drop learning dependencies while other features remain configurable", () => {
  for (const featureSelection of [legacySelection(false, true), legacySelection(true, false), legacySelection(true, true)]) {
    const input = { featureSelection, storageRoots: roots };
    for (const name of retiredDependencies) Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`retired getter: ${name}`); } });
    const composition = composePindieExtension(input);
    assertRetiredAbsent(composition);
    assert.equal(composition.featureSelection.remote, false);
    assert.equal(composition.featureSelection.workMemory, false);
    assert.equal(composition.extensionOptions.remoteCompanion, undefined);
    assert.equal(composition.extensionOptions.projectMemorySink, undefined);
  }
  const optionalDisabled = composeConfiguredPindieExtension({ featureSelection: { remote: false, workMemory: false } }, {
    PINDIE_DISCORD_TOKEN: "token", PINDIE_DISCORD_USER_ID: "123456789012345678", PINDIE_DISCORD_GUILD_ID: "987654321098765432",
    PINDIE_NOTION_TOKEN: "token", PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source",
  });
  assert.equal(optionalDisabled.featureSelection.remote, false);
  assert.equal(optionalDisabled.featureSelection.workMemory, false);
  assert.equal(optionalDisabled.extensionOptions.remoteCompanion, undefined);
  assert.equal(optionalDisabled.extensionOptions.projectMemorySink, undefined);
});

test("Stable composition protects Core and optional adapter runtime import boundaries", async () => {
  const coreSource = await readFile(new URL("../src/core-integration.ts", import.meta.url), "utf8");
  const emitted = ts.transpileModule(coreSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  assert.doesNotMatch(emitted, /(?:from\s*|import\s*\(|require\s*\()\s*["']\.\/(?:composition|presentation-integration|remote-companion|discord-remote|notion-project-memory)\.ts/);
  const taskSource = await readFile(new URL("../src/tools/task.ts", import.meta.url), "utf8");
  assert.doesNotMatch(taskSource, /learning-signal|learning-disposition-contract|LearningSignalHolder|isValidLearningSignal/);
});

test("retired master switch is inert both when enabled and disabled", () => {
  for (const value of ["true", "false", "invalid"]) {
    assert.deepEqual(resolvePindieFeatureSelection(legacySelection(true, true), {}, {
      PINDIE_AUTONOMOUS_LEARNING_ENABLED: value, PINDIE_SELF_IMPROVEMENT_ENABLED: value, PINDIE_CROSS_PROJECT_LEARNING_ENABLED: value,
    }), DEFAULT_PINDIE_FEATURE_SELECTION);
  }
});

test("retired environment selection cannot enable SI or CPL even with conflicting old values", () => {
  for (const self of ["false", "true", "off", "invalid"]) {
    const composition = composeConfiguredPindieExtension({}, {
      PINDIE_AUTONOMOUS_LEARNING_ENABLED: "true", PINDIE_SELF_IMPROVEMENT_ENABLED: self, PINDIE_CROSS_PROJECT_LEARNING_ENABLED: "true",
    });
    assertRetiredAbsent(composition);
    assert.deepEqual(composition.featureSelection, DEFAULT_PINDIE_FEATURE_SELECTION);
  }
  const env = {};
  for (const name of ["PINDIE_AUTONOMOUS_LEARNING_ENABLED", "PINDIE_SELF_IMPROVEMENT_ENABLED", "PINDIE_CROSS_PROJECT_LEARNING_ENABLED"]) {
    Object.defineProperty(env, name, { enumerable: true, get() { throw new Error(`retired flag read: ${name}`); } });
  }
  const overrides = { presentation: false };
  for (const name of ["selfImprovement", "crossProjectLearning"]) {
    Object.defineProperty(overrides, name, { enumerable: true, get() { throw new Error(`retired override read: ${name}`); } });
  }
  assert.deepEqual(resolvePindieFeatureSelection(overrides, {}, env), { ...DEFAULT_PINDIE_FEATURE_SELECTION, presentation: false });
  const config = { env };
  Object.defineProperty(config, "onExperienceSaved", { enumerable: true, get() { throw new Error("retired config callback read"); } });
  assertRetiredAbsent(composePindieExtension({ storageRoots: roots, featureSelection: overrides }, config));
});

test("Stable composition matrix keeps Remote, Work Memory and Presentation independent", () => {
  const surface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async () => undefined, updateSessionPresentation: async () => undefined,
  };
  const remoteCompanion = { companion: new RemoteCompanion(surface), guildId: "guild" };
  const projectMemorySink: ProjectMemorySink = { capture: async () => ({ ok: true, outcome: "created" }) };
  for (const remote of [false, true]) for (const workMemory of [false, true]) for (const presentation of [false, true]) {
    const featureSelection = { remote, workMemory, presentation, bundledSkills: false };
    const input = { featureSelection, storageRoots: roots, remoteCompanion, projectMemorySink };
    for (const name of retiredDependencies) Object.defineProperty(input, name, { enumerable: true, get() { throw new Error(`retired getter: ${name}`); } });
    const composition = composePindieExtension(input, { env: {} });
    assert.deepEqual(composition.featureSelection, featureSelection);
    assertRetiredAbsent(composition);
    assert.equal(composition.extensionOptions.remoteCompanion, remote ? remoteCompanion : undefined);
    assert.equal(composition.extensionOptions.projectMemorySink, workMemory ? projectMemorySink : undefined);
  }
  assert.deepEqual(composePindieExtension({}, { env: {} }).featureSelection, DEFAULT_PINDIE_FEATURE_SELECTION);
});

test("Slice C accepts independent Presentation selection", () => {
  assert.equal(composePindieExtension({ featureSelection: { presentation: false } }).featureSelection.presentation, false);
});

test("Slice C drops injected Remote routing when Remote is explicitly disabled", () => {
  const composition = composePindieExtension({ featureSelection: { remote: false }, remoteRoutingStore: new RemoteRoutingStore({ baseDir: "/tmp/should-not-be-exposed" }) });
  assert.equal(composition.remoteRoutingStore, null);
  assert.equal(Object.hasOwn(composition.extensionOptions, "remoteRoutingStore"), false);
  assert.equal(Object.hasOwn(composition.extensionOptions, "remoteCompanion"), false);
});

test("Slice C does not load disabled Discord or Notion adapters", async () => {
  const extensionUrl = new URL("../src/extension.ts", import.meta.url).href;
  const compositionUrl = new URL("../src/composition.ts", import.meta.url).href;
  const script = `
    const Module = require("node:module");
    const originalLoad = Module._load;
    const forbidden = new Set(["@notionhq/client", "discord.js", "https-proxy-agent", "undici", "ws"]);
    Module._load = function(request, parent, isMain) {
      if (forbidden.has(request)) throw new Error("disabled optional dependency loaded: " + request);
      return originalLoad.call(this, request, parent, isMain);
    };
    import(${JSON.stringify(extensionUrl)}).then(() => import(${JSON.stringify(compositionUrl)})).then(({ composeConfiguredPindieExtension }) => {
      const composition = composeConfiguredPindieExtension(
        { featureSelection: { remote: false, workMemory: false } },
        { PINDIE_DISCORD_TOKEN: "token", PINDIE_DISCORD_USER_ID: "123456789012345678", PINDIE_DISCORD_GUILD_ID: "987654321098765432",
          PINDIE_NOTION_TOKEN: "token", PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source" },
      );
      if (composition.remoteRoutingStore !== null || composition.extensionOptions.projectMemorySink !== undefined) throw new Error("disabled optional feature was composed");
      process.stdout.write("ok");
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = await execFileAsync(process.execPath, ["--experimental-strip-types", "-e", script], { cwd: process.cwd() });
  assert.equal(result.stdout, "ok");
});
