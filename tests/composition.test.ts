import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

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
import { RemoteRoutingStore } from "../src/remote-routing.ts";
import { FileGlobalWriterLock, FileStateStore } from "../src/store.ts";
import { getProjectId } from "../src/store.ts";

const projectRoot = "/workspace/composable-pindie";

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

test("Slice A feature selection preserves dependency rules and explicit adapter off", () => {
  assert.deepEqual(
    resolvePindieFeatureSelection(
      { selfImprovement: false },
      { remote: true, workMemory: true },
      {},
    ),
    {
      selfImprovement: false,
      crossProjectLearning: false,
      remote: true,
      workMemory: true,
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

  const composition = composeConfiguredPindieExtension(
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
  assert.equal(composition.featureSelection.remote, false);
  assert.equal(composition.featureSelection.workMemory, false);
  assert.equal(composition.extensionOptions.remoteCompanion, undefined);
  assert.equal(composition.extensionOptions.projectMemorySink, undefined);
});

test("Slice A keeps unsupported independent feature removal explicit", () => {
  assert.throws(
    () => composePindieExtension({ featureSelection: { presentation: false } }),
    /does not support disabling Self-Improvement, Cross-Project Learning, or Presentation yet/,
  );
});
