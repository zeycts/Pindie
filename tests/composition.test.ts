import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  composeConfiguredPindieExtension,
  composePindieExtension,
  DEFAULT_PINDIE_FEATURE_SELECTION,
  resolvePindieFeatureSelection,
  resolvePindieStorageRoots,
} from "../src/composition.ts";
import { FileRunExperienceStore } from "../src/experience-store.ts";
import { FileStrategyCandidateStore } from "../src/strategy-candidates.ts";
import { FileStrategyDecisionStore } from "../src/strategy-decisions.ts";
import { FileStrategyDerivationCandidateStore } from "../src/strategy-derivation-candidates.ts";
import { FileStrategyDerivationDecisionStore } from "../src/strategy-derivation-decisions.ts";
import { FileStrategyTrustScopeCandidateStore } from "../src/strategy-trust-scope-candidates.ts";
import { FileStrategyTrustScopeDecisionStore } from "../src/strategy-trust-scope-decisions.ts";
import { FileProjectTrustedStrategyPortfolioReader } from "../src/strategy-trust-safety.ts";
import { FileStrategySynthesisCandidateStore } from "../src/strategy-synthesis-candidates.ts";
import { RemoteRoutingStore } from "../src/remote-routing.ts";
import { FileGlobalWriterLock, FileStateStore } from "../src/store.ts";
import { getProjectId } from "../src/store.ts";
import { RemoteCompanion, type RemoteSurface } from "../src/remote-companion.ts";
import type { ProjectMemorySink } from "../src/project-memory.ts";

interface SourceImport {
  readonly moduleSpecifier: string;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
}

function sourceImports(source: string): SourceImport[] {
  const imports: SourceImport[] = [];
  const staticImportPattern = /(?:^|\n)\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(staticImportPattern)) {
    const clause = match[2]!.trim();
    const namedClause = /^\{([\s\S]*)\}$/u.exec(clause);
    const specifiers = namedClause === null
      ? []
      : namedClause[1]!
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier !== "");
    const names = specifiers.map((specifier) =>
      specifier.replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!.trim());
    imports.push({
      moduleSpecifier: match[3]!,
      typeOnly: match[1] !== undefined ||
        (namedClause !== null && specifiers.every((specifier) => specifier.startsWith("type "))),
      names,
    });
  }

  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamicImportPattern)) {
    const precedingSource = source.slice(0, match.index ?? 0);
    if (/\btypeof\s*$/u.test(precedingSource)) continue;
    imports.push({ moduleSpecifier: match[1]!, typeOnly: false, names: [] });
  }
  return imports;
}

function importsFrom(source: string, moduleSpecifier: string): SourceImport[] {
  return sourceImports(source).filter((entry) => entry.moduleSpecifier === moduleSpecifier);
}

function hasRuntimeImport(source: string, moduleSpecifier: string): boolean {
  return importsFrom(source, moduleSpecifier).some((entry) => !entry.typeOnly);
}

const projectRoot = "/workspace/composable-pindie";
const execFileAsync = promisify(execFile);

test("Slice A resolves stable startup defaults and explicit dependency roots", () => {
  assert.deepEqual(
    resolvePindieFeatureSelection({}, {}, {}),
    DEFAULT_PINDIE_FEATURE_SELECTION,
  );
  assert.deepEqual(
    resolvePindieStorageRoots({}, "/isolated-home"),
    {
      projectsBaseDir: "/isolated-home/.pindie/projects",
      globalBaseDir: "/isolated-home/.pindie/global",
      remoteRoutingBaseDir: "/isolated-home/.pindie/remote/discord/projects",
    },
  );

  const roots = {
    projectsBaseDir: "/tmp/pindie-projects",
    globalBaseDir: "/tmp/pindie-global",
    remoteRoutingBaseDir: "/tmp/pindie-remote",
  } as const;
  const composition = composePindieExtension({ storageRoots: roots });

  assert.deepEqual(composition.storageRoots, roots);
  assert.equal(
    (composition.extensionOptions.store as FileStateStore).storageBaseDir,
    roots.projectsBaseDir,
  );
  assert.equal(
    (composition.extensionOptions.experienceStore as FileRunExperienceStore).experienceDirectory(projectRoot),
    join(roots.projectsBaseDir, getProjectId(projectRoot), "experience"),
  );
  assert.equal(
    (composition.extensionOptions.strategyCandidateStore as FileStrategyCandidateStore).strategyCandidateDirectory(projectRoot),
    join(roots.projectsBaseDir, getProjectId(projectRoot), "strategy-candidates"),
  );
  assert.equal(
    (composition.extensionOptions.strategyDecisionStore as FileStrategyDecisionStore).strategyDecisionDirectory(projectRoot),
    join(roots.projectsBaseDir, getProjectId(projectRoot), "strategy-decisions"),
  );
  assert.equal(
    (composition.extensionOptions.strategyDerivationCandidateStore as FileStrategyDerivationCandidateStore).strategyDerivationCandidateDirectory(projectRoot),
    join(roots.projectsBaseDir, getProjectId(projectRoot), "strategy-derivation-candidates"),
  );
  assert.equal(
    (composition.extensionOptions.strategyDerivationDecisionStore as FileStrategyDerivationDecisionStore).strategyDerivationDecisionDirectory(projectRoot),
    join(roots.projectsBaseDir, getProjectId(projectRoot), "strategy-derivation-decisions"),
  );
  assert.equal(
    (composition.extensionOptions.strategyTrustScopeCandidateStore as FileStrategyTrustScopeCandidateStore).strategyScopeCandidateDirectory(),
    join(roots.globalBaseDir, "strategy-scope-candidates"),
  );
  assert.equal(
    (composition.extensionOptions.strategyTrustScopeDecisionStore as FileStrategyTrustScopeDecisionStore).strategyScopeDecisionDirectory(),
    join(roots.globalBaseDir, "strategy-scope-decisions"),
  );
  assert.equal(
    (composition.extensionOptions.strategyTrustScopeWriterLock as FileGlobalWriterLock).storageBaseDir,
    roots.globalBaseDir,
  );
  assert.equal(composition.extensionOptions.crossProjectTrustReader instanceof FileProjectTrustedStrategyPortfolioReader, true);
  assert.equal(
    (composition.extensionOptions.strategySynthesisCandidateStore as FileStrategySynthesisCandidateStore).candidateDirectory(),
    join(roots.globalBaseDir, "strategy-synthesis-candidates"),
  );
});

test("Slice A gives configured Remote an explicit routing root", () => {
  const roots = {
    projectsBaseDir: "/tmp/pindie-projects",
    globalBaseDir: "/tmp/pindie-global",
    remoteRoutingBaseDir: "/tmp/pindie-remote",
  } as const;
  const composition = composeConfiguredPindieExtension(
    { storageRoots: roots },
    {
      PINDIE_DISCORD_TOKEN: "token",
      PINDIE_DISCORD_USER_ID: "123456789012345678",
      PINDIE_DISCORD_GUILD_ID: "987654321098765432",
    },
  );
  assert.ok(composition.remoteRoutingStore instanceof RemoteRoutingStore);
  assert.equal(
    composition.remoteRoutingStore?.path(projectRoot),
    join(roots.remoteRoutingBaseDir, `${getProjectId(projectRoot)}.json`),
  );
  assert.equal(composition.extensionOptions.remoteRoutingStore, composition.remoteRoutingStore);
});

test("Slice A never derives feature roots from an injected StateStore", () => {
  const composition = composePindieExtension({
    store: new FileStateStore({ baseDir: "/tmp/state-only" }),
    storageRoots: {
      projectsBaseDir: "/tmp/explicit-projects",
      globalBaseDir: "/tmp/explicit-global",
      remoteRoutingBaseDir: "/tmp/explicit-remote",
    },
  });

  assert.equal(
    (composition.extensionOptions.store as FileStateStore).storageBaseDir,
    "/tmp/state-only",
  );
  assert.equal(
    (composition.extensionOptions.experienceStore as FileRunExperienceStore).experienceDirectory(projectRoot),
    join("/tmp/explicit-projects", getProjectId(projectRoot), "experience"),
  );
});

test("Slice E allows SI-only composition and drops CPL dependencies when disabled", () => {
  const roots = {
    projectsBaseDir: "/tmp/slice-d-projects",
    globalBaseDir: "/tmp/slice-d-global",
    remoteRoutingBaseDir: "/tmp/slice-d-remote",
  } as const;
  const injectedExperienceStore = new FileRunExperienceStore({ baseDir: "/tmp/not-selected" });
  const composition = composePindieExtension({
    featureSelection: { selfImprovement: false },
    storageRoots: roots,
    experienceStore: injectedExperienceStore,
  });

  assert.equal(composition.featureSelection.selfImprovement, false);
  assert.equal(composition.featureSelection.crossProjectLearning, false);
  for (const dependency of [
    "experienceStore",
    "experienceReader",
    "crossProjectExperienceReader",
    "strategyCandidateStore",
    "strategyCandidateReader",
    "strategyDerivationCandidateStore",
    "strategyDerivationCandidateReader",
    "strategyDecisionStore",
    "strategyDecisionReader",
    "strategyDerivationDecisionStore",
    "strategyDerivationDecisionReader",
    "strategyTrustScopeCandidateStore",
    "strategyTrustScopeDecisionStore",
    "strategyTrustScopeSourceResolver",
    "strategyTrustScopeWriterLock",
    "crossProjectTrustReader",
    "scopeProjectTrustReader",
    "strategySynthesisCandidateStore",
  ]) {
    assert.equal(Object.hasOwn(composition.extensionOptions, dependency), false, dependency);
  }
  assert.equal(
    (composition.extensionOptions.store as FileStateStore).storageBaseDir,
    roots.projectsBaseDir,
  );
  assert.equal(composition.extensionOptions.experienceStore, undefined);

  const siOnly = composePindieExtension({
    featureSelection: { selfImprovement: true, crossProjectLearning: false },
    storageRoots: roots,
  });
  assert.equal(siOnly.featureSelection.selfImprovement, true);
  assert.equal(siOnly.featureSelection.crossProjectLearning, false);
  for (const dependency of ["experienceStore", "strategyCandidateStore", "strategyTrustScopeCandidateStore", "strategyTrustScopeWriterLock"]) {
    assert.equal(Object.hasOwn(siOnly.extensionOptions, dependency), true, dependency);
  }
  for (const dependency of [
    "crossProjectExperienceReader",
    "crossProjectTrustReader",
    "scopeProjectTrustReader",
    "strategySynthesisCandidateStore",
  ]) {
    assert.equal(Object.hasOwn(siOnly.extensionOptions, dependency), false, dependency);
  }

  assert.deepEqual(
    resolvePindieFeatureSelection({ selfImprovement: false }, {}, {}),
    {
      selfImprovement: false,
      crossProjectLearning: false,
      remote: false,
      workMemory: false,
      bundledSkills: true,
      presentation: true,
    },
  );
  assert.throws(
    () => resolvePindieFeatureSelection(
      { selfImprovement: false, crossProjectLearning: true },
      {},
      {},
    ),
    /Cross-Project Learning requires Self-Improvement/,
  );
  assert.equal(
    resolvePindieFeatureSelection(
      { selfImprovement: true, crossProjectLearning: false },
      {},
      {},
    ).crossProjectLearning,
    false,
  );

  const optionalDisabled = composeConfiguredPindieExtension(
    {
      featureSelection: { remote: false, workMemory: false },
    },
    {
      PINDIE_DISCORD_TOKEN: "token",
      PINDIE_DISCORD_USER_ID: "123456789012345678",
      PINDIE_DISCORD_GUILD_ID: "987654321098765432",
      PINDIE_NOTION_TOKEN: "token",
      PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source",
    },
  );
  assert.equal(optionalDisabled.featureSelection.remote, false);
  assert.equal(optionalDisabled.featureSelection.workMemory, false);
  assert.equal(optionalDisabled.extensionOptions.remoteCompanion, undefined);
  assert.equal(optionalDisabled.extensionOptions.projectMemorySink, undefined);
});

test("Slice F protects the final Core/SI/CPL and trust runtime import boundaries", async () => {
  const [coreSource, selfImprovementSource, crossProjectLearningSource, portfolioSource, trustSafetySource, globalSource] = await Promise.all(
    [
      "core-integration.ts",
      "self-improvement-integration.ts",
      "cross-project-learning-integration.ts",
      "strategy-portfolio.ts",
      "strategy-trust-safety.ts",
      "strategy-trust-scope-global.ts",
    ].map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")),
  );

  for (const moduleSpecifier of [
    "./self-improvement-integration.ts",
    "./cross-project-learning-integration.ts",
    "./presentation-integration.ts",
    "./remote-companion.ts",
    "./discord-remote.ts",
    "./notion-project-memory.ts",
  ]) {
    assert.equal(hasRuntimeImport(coreSource, moduleSpecifier), false, moduleSpecifier);
  }
  assert.equal(hasRuntimeImport(selfImprovementSource, "./cross-project-learning-integration.ts"), false);

  const cplSelfImprovementImports = importsFrom(
    crossProjectLearningSource,
    "./self-improvement-integration.ts",
  );
  assert.equal(cplSelfImprovementImports.length, 1);
  assert.equal(cplSelfImprovementImports[0]!.typeOnly, true);
  assert.deepEqual(
    [...cplSelfImprovementImports[0]!.names].sort(),
    [
      "CrossProjectLearningAttachment",
      "SelfImprovementLearningAccess",
      "SelfImprovementStrategyTrustAccess",
    ].sort(),
  );

  const portfolioDerivationDecisionImports = importsFrom(
    portfolioSource,
    "./strategy-derivation-decisions.ts",
  );
  assert.equal(portfolioDerivationDecisionImports.length, 1);
  assert.equal(portfolioDerivationDecisionImports[0]!.typeOnly, true);

  for (const moduleSpecifier of [
    "./strategy-trust-scope-global.ts",
    "./strategy-trust-scope.ts",
    "./strategy-trust-scope-review.ts",
    "./strategy-trust-scope-trial.ts",
    "./strategy-trust-safety.ts",
  ]) {
    assert.equal(hasRuntimeImport(portfolioSource, moduleSpecifier), false, moduleSpecifier);
  }
  assert.equal(hasRuntimeImport(globalSource, "./strategy-portfolio.ts"), false);
  assert.equal(hasRuntimeImport(globalSource, "./strategy-trust-scope-trial.ts"), false);
  assert.equal(hasRuntimeImport(trustSafetySource, "./strategy-trust-scope-global.ts"), true);
});

test("Slice F preserves environment-driven selection and clearly rejects SI-off plus CPL-on", () => {
  const siOff = composeConfiguredPindieExtension({}, {
    PINDIE_SELF_IMPROVEMENT_ENABLED: "false",
  });
  assert.equal(siOff.featureSelection.selfImprovement, false);
  assert.equal(siOff.featureSelection.crossProjectLearning, false);
  assert.equal(Object.hasOwn(siOff.extensionOptions, "experienceStore"), false);

  const bothOff = composeConfiguredPindieExtension({}, {
    PINDIE_SELF_IMPROVEMENT_ENABLED: "off",
    PINDIE_CROSS_PROJECT_LEARNING_ENABLED: "no",
  });
  assert.equal(bothOff.featureSelection.selfImprovement, false);
  assert.equal(bothOff.featureSelection.crossProjectLearning, false);

  assert.throws(
    () => composeConfiguredPindieExtension({}, {
      PINDIE_SELF_IMPROVEMENT_ENABLED: "false",
      PINDIE_CROSS_PROJECT_LEARNING_ENABLED: "true",
    }),
    /Cross-Project Learning requires Self-Improvement/,
  );
  const siOnly = composeConfiguredPindieExtension({}, {
    PINDIE_SELF_IMPROVEMENT_ENABLED: "true",
    PINDIE_CROSS_PROJECT_LEARNING_ENABLED: "false",
  });
  assert.equal(siOnly.featureSelection.selfImprovement, true);
  assert.equal(siOnly.featureSelection.crossProjectLearning, false);
  assert.equal(Object.hasOwn(siOnly.extensionOptions, "crossProjectExperienceReader"), false);
  assert.equal(Object.hasOwn(siOnly.extensionOptions, "scopeProjectTrustReader"), false);

  assert.deepEqual(
    siOnly.featureSelection,
    resolvePindieFeatureSelection(
      { selfImprovement: true, crossProjectLearning: false },
      {},
      {
        PINDIE_SELF_IMPROVEMENT_ENABLED: "true",
        PINDIE_CROSS_PROJECT_LEARNING_ENABLED: "false",
      },
    ),
  );
});

test("Slice F assembles the final composition matrix through the production composition root", () => {
  const remoteSurface: RemoteSurface = {
    ensureProject: async () => ({ channelId: "channel" }),
    ensureSession: async () => ({ threadId: "thread", anchorMessageId: "anchor", headerMessageId: null }),
    send: async () => undefined,
    updateSessionPresentation: async () => undefined,
  };
  const remoteCompanion = {
    companion: new RemoteCompanion(remoteSurface),
    guildId: "guild",
  };
  const projectMemorySink: ProjectMemorySink = {
    capture: async () => ({ ok: true, outcome: "created" }),
  };
  const roots = {
    projectsBaseDir: "/tmp/slice-f-projects",
    globalBaseDir: "/tmp/slice-f-global",
    remoteRoutingBaseDir: "/tmp/slice-f-remote",
  } as const;
  const compose = (input: Parameters<typeof composePindieExtension>[0]) =>
    composePindieExtension({
      ...input,
      storageRoots: roots,
    }, { env: {} });
  const optionalInput = { remoteCompanion, projectMemorySink };
  const selection = (
    overrides: Partial<typeof DEFAULT_PINDIE_FEATURE_SELECTION> = {},
  ) => ({
    selfImprovement: false,
    crossProjectLearning: false,
    remote: false,
    workMemory: false,
    bundledSkills: false,
    presentation: false,
    ...overrides,
  });
  const cases = [
    ["Core only", selection()],
    ["Core + SI", selection({ selfImprovement: true })],
    ["Core + SI + CPL", selection({ selfImprovement: true, crossProjectLearning: true })],
    ["Core + Remote", selection({ remote: true })],
    ["Core + Work Memory", selection({ workMemory: true })],
  ] as const;

  for (const [name, featureSelection] of cases) {
    const composition = compose({ ...optionalInput, featureSelection });
    assert.deepEqual(composition.featureSelection, featureSelection, name);
    for (const dependency of [
      "experienceStore",
      "experienceReader",
      "strategyCandidateStore",
      "strategyCandidateReader",
      "strategyDerivationCandidateStore",
      "strategyDerivationCandidateReader",
      "strategyDecisionStore",
      "strategyDecisionReader",
      "strategyDerivationDecisionStore",
      "strategyDerivationDecisionReader",
      "strategyTrustScopeCandidateStore",
      "strategyTrustScopeDecisionStore",
      "strategyTrustScopeSourceResolver",
      "strategyTrustScopeWriterLock",
    ]) {
      assert.equal(
        Object.hasOwn(composition.extensionOptions, dependency),
        featureSelection.selfImprovement,
        `${name}: ${dependency}`,
      );
    }
    for (const dependency of [
      "crossProjectExperienceReader",
      "crossProjectTrustReader",
      "scopeProjectTrustReader",
      "strategySynthesisCandidateStore",
    ]) {
      assert.equal(
        Object.hasOwn(composition.extensionOptions, dependency),
        featureSelection.crossProjectLearning,
        `${name}: ${dependency}`,
      );
    }
    assert.equal(
      Object.hasOwn(composition.extensionOptions, "remoteCompanion"),
      featureSelection.remote,
      `${name}: remoteCompanion`,
    );
    assert.equal(
      Object.hasOwn(composition.extensionOptions, "projectMemorySink"),
      featureSelection.workMemory,
      `${name}: projectMemorySink`,
    );
  }

  const defaultComposition = composePindieExtension({}, { env: {} });
  assert.deepEqual(
    defaultComposition.featureSelection,
    DEFAULT_PINDIE_FEATURE_SELECTION,
    "default full-feature composition",
  );
  assert.equal(Object.hasOwn(defaultComposition.extensionOptions, "remoteCompanion"), false);
  assert.equal(Object.hasOwn(defaultComposition.extensionOptions, "projectMemorySink"), false);
});

test("Slice C accepts independent Presentation selection", () => {
  const composition = composePindieExtension({
    featureSelection: { presentation: false },
  });

  assert.equal(composition.featureSelection.presentation, false);
});

test("Slice C drops injected Remote routing when Remote is explicitly disabled", () => {
  const routing = new RemoteRoutingStore({ baseDir: "/tmp/should-not-be-exposed" });
  const composition = composePindieExtension({
    featureSelection: { remote: false },
    remoteRoutingStore: routing,
  });

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
        {
          PINDIE_DISCORD_TOKEN: "token",
          PINDIE_DISCORD_USER_ID: "123456789012345678",
          PINDIE_DISCORD_GUILD_ID: "987654321098765432",
          PINDIE_NOTION_TOKEN: "token",
          PINDIE_WORK_MEMORY_DATA_SOURCE_ID: "data-source",
        },
      );
      if (composition.remoteRoutingStore !== null || composition.extensionOptions.projectMemorySink !== undefined) {
        throw new Error("disabled optional feature was composed");
      }
      process.stdout.write("ok");
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = await execFileAsync(
    process.execPath,
    ["--experimental-strip-types", "-e", script],
    { cwd: process.cwd() },
  );
  assert.equal(result.stdout, "ok");
});
