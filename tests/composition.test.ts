import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
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
  for (const name of ["self-improvement-integration.ts", "cross-project-learning-integration.ts"]) {
    await assert.rejects(access(new URL(`../src/${name}`, import.meta.url)), { code: "ENOENT" });
  }
  // The complete source AST (including erased types) and transitive runtime graph
  // are checked in al-retirement.test.ts, not against retired module internals.
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
