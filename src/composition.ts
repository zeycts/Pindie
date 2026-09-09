import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  discordRemoteConfig,
  type DiscordRemoteConfigResult,
} from "./remote-config.ts";
import {
  FileRunExperienceReader,
  FileRunExperienceStore,
  type RunExperienceProjectReader,
  type RunExperienceReader,
  type RunExperienceStore,
} from "./experience-store.ts";
import {
  NOTION_PROJECT_MEMORY_API_VERSION,
  notionProjectMemoryConfig,
  type NotionProjectMemoryConfigResult,
} from "./notion-project-memory-config.ts";
import { RemoteRoutingStore } from "./remote-routing.ts";
import {
  FileStrategyCandidateStore,
  type StrategyCandidateReader,
  type StrategyCandidateStore,
} from "./strategy-candidates.ts";
import {
  FileStrategyDecisionStore,
  type StrategyRevisionDecisionReader,
  type StrategyRevisionDecisionStore,
} from "./strategy-decisions.ts";
import {
  FileStrategyDerivationCandidateStore,
  type StrategyDerivationCandidateReader,
  type StrategyDerivationCandidateStore,
} from "./strategy-derivation-candidates.ts";
import {
  FileStrategyDerivationDecisionStore,
  type StrategyDerivationDecisionReader,
  type StrategyDerivationDecisionStore,
} from "./strategy-derivation-decisions.ts";
import {
  FileStrategyTrustScopeCandidateStore,
  type StrategyTrustScopeCandidateStore,
} from "./strategy-trust-scope-candidates.ts";
import {
  FileStrategyTrustScopeDecisionStore,
  type StrategyTrustScopeDecisionStore,
} from "./strategy-trust-scope-decisions.ts";
import {
  FileStrategyTrustScopeSourceResolver,
  type StrategyTrustScopeSourceResolver,
} from "./strategy-trust-scope-resolution.ts";
import {
  FileScopeProjectTrustReader,
  type ScopeProjectTrustReader,
} from "./strategy-trust-scope-review.ts";
import {
  FileGlobalWriterLock,
  FileStateStore,
  FileTaskContinuityStore,
  type GlobalWriterLock,
  type PindieStateStore,
  type TaskContinuityStore,
} from "./store.ts";
import type { PindieExtensionOptions } from "./extension.ts";
import type { NotionProjectMemoryClient } from "./notion-project-memory.ts";
import type { ProjectMemorySink } from "./project-memory.ts";

const require = createRequire(import.meta.url);

type DiscordRemoteModule = typeof import("./discord-remote.ts");
type RemoteCompanionModule = typeof import("./remote-companion.ts");
type NotionProjectMemoryModule = typeof import("./notion-project-memory.ts");
type NotionSdkModule = {
  readonly Client: new (options: {
    readonly auth: string;
    readonly notionVersion: string;
  }) => NotionProjectMemoryClient;
};

function loadDiscordRemoteModule(): DiscordRemoteModule {
  return require("./discord-remote.ts") as DiscordRemoteModule;
}

function loadRemoteCompanionModule(): RemoteCompanionModule {
  return require("./remote-companion.ts") as RemoteCompanionModule;
}

function loadNotionProjectMemoryModule(): NotionProjectMemoryModule {
  return require("./notion-project-memory.ts") as NotionProjectMemoryModule;
}

function loadNotionSdk(): NotionSdkModule {
  return require("@notionhq/client") as NotionSdkModule;
}

/** Startup-time product selection. This is configuration, not semantic State. */
export interface PindieFeatureSelection {
  readonly selfImprovement: boolean;
  readonly crossProjectLearning: boolean;
  readonly remote: boolean;
  readonly workMemory: boolean;
  readonly bundledSkills: boolean;
  readonly presentation: boolean;
}

export type PindieFeatureSelectionOverrides = Partial<PindieFeatureSelection>;

export interface PindieFeatureAvailability {
  readonly remote?: boolean;
  readonly workMemory?: boolean;
}

/** Explicit production storage namespaces used by the assembled features. */
export interface PindieStorageRoots {
  readonly projectsBaseDir: string;
  readonly globalBaseDir: string;
  readonly remoteRoutingBaseDir: string;
}

export type PindieStorageRootOverrides = Partial<PindieStorageRoots>;

export interface PindieCompositionConfig {
  /** Resolve environment-configured Remote and Work Memory adapters. */
  readonly configureOptionalFeatures?: boolean;
  readonly env?: Record<string, string | undefined>;
}

export interface PindieComposition {
  readonly featureSelection: PindieFeatureSelection;
  readonly storageRoots: PindieStorageRoots;
  readonly remoteRoutingStore: RemoteRoutingStore | null;
  readonly extensionOptions: PindieExtensionOptions;
  readonly warnings: readonly string[];
}

const DEFAULT_PINDIE_FEATURE_SELECTION: PindieFeatureSelection = Object.freeze({
  selfImprovement: true,
  crossProjectLearning: true,
  remote: false,
  workMemory: false,
  bundledSkills: true,
  presentation: true,
});

export { DEFAULT_PINDIE_FEATURE_SELECTION };

function configuredFlag(
  env: Record<string, string | undefined>,
  name: string,
): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  throw new Error(`${name} must be a boolean value.`);
}

/**
 * Resolve startup selection without constructing any feature implementation.
 * Remote and Work Memory are selected only when their complete environment or
 * an explicitly supplied dependency is available.
 */
export function resolvePindieFeatureSelection(
  overrides: PindieFeatureSelectionOverrides = {},
  availability: PindieFeatureAvailability = {},
  env: Record<string, string | undefined> = process.env,
): PindieFeatureSelection {
  const selfImprovement = overrides.selfImprovement ??
    configuredFlag(env, "PINDIE_SELF_IMPROVEMENT_ENABLED") ??
    DEFAULT_PINDIE_FEATURE_SELECTION.selfImprovement;
  const requestedCrossProjectLearning = overrides.crossProjectLearning ??
    configuredFlag(env, "PINDIE_CROSS_PROJECT_LEARNING_ENABLED");
  const crossProjectLearning = requestedCrossProjectLearning ?? selfImprovement;
  if (!selfImprovement && crossProjectLearning) {
    throw new Error(
      "Pindie feature selection is invalid: Cross-Project Learning requires Self-Improvement.",
    );
  }
  if (!selfImprovement) {
    throw new Error(
      "Slice C composition does not support disabling Self-Improvement until Composable Slice D is implemented.",
    );
  }
  if (!crossProjectLearning) {
    throw new Error(
      "Slice C composition does not support disabling Cross-Project Learning until Composable Slice E is implemented.",
    );
  }

  const remoteAvailable = availability.remote === true;
  const workMemoryAvailable = availability.workMemory === true;
  const requestedRemote = overrides.remote ??
    configuredFlag(env, "PINDIE_REMOTE_ENABLED") ??
    remoteAvailable;
  const requestedWorkMemory = overrides.workMemory ??
    configuredFlag(env, "PINDIE_WORK_MEMORY_ENABLED") ??
    workMemoryAvailable;

  return Object.freeze({
    selfImprovement,
    crossProjectLearning,
    remote: requestedRemote && remoteAvailable,
    workMemory: requestedWorkMemory && workMemoryAvailable,
    bundledSkills: overrides.bundledSkills ??
      configuredFlag(env, "PINDIE_BUNDLED_SKILLS_ENABLED") ??
      DEFAULT_PINDIE_FEATURE_SELECTION.bundledSkills,
    presentation: overrides.presentation ??
      configuredFlag(env, "PINDIE_PRESENTATION_ENABLED") ??
      DEFAULT_PINDIE_FEATURE_SELECTION.presentation,
  });
}

/** Resolve the production namespaces without touching the filesystem. */
export function resolvePindieStorageRoots(
  overrides: PindieStorageRootOverrides = {},
  homeDirectory = homedir(),
): PindieStorageRoots {
  return Object.freeze({
    projectsBaseDir: overrides.projectsBaseDir ?? join(homeDirectory, ".pindie", "projects"),
    globalBaseDir: overrides.globalBaseDir ?? join(homeDirectory, ".pindie", "global"),
    remoteRoutingBaseDir: overrides.remoteRoutingBaseDir ?? join(
      homeDirectory,
      ".pindie",
      "remote",
      "discord",
      "projects",
    ),
  });
}

function configuredWarnings(
  memory: NotionProjectMemoryConfigResult | null,
  remote: DiscordRemoteConfigResult | null,
): string[] {
  return [
    ...(memory !== null && !memory.enabled && memory.warning ? [memory.warning] : []),
    ...(remote !== null && !remote.enabled && remote.warning ? [remote.warning] : []),
  ];
}

function isProjectReader(
  value: RunExperienceReader,
): value is RunExperienceReader & RunExperienceProjectReader {
  return typeof (value as Partial<RunExperienceProjectReader>).listProjectIds === "function" &&
    typeof (value as Partial<RunExperienceProjectReader>).readProjectId === "function";
}

/**
 * Construct production defaults and return the dependencies for the existing
 * extension registration path. No feature business logic is executed here.
 */
export function composePindieExtension(
  input: PindieExtensionOptions = {},
  config: PindieCompositionConfig = {},
): PindieComposition {
  const env = config.env ?? process.env;
  const roots = resolvePindieStorageRoots(input.storageRoots);
  const configureOptionalFeatures = config.configureOptionalFeatures === true;

  const configuredMemory = configureOptionalFeatures
    ? notionProjectMemoryConfig(env)
    : null;
  const configuredRemote = configureOptionalFeatures
    ? discordRemoteConfig(env)
    : null;
  const selection = resolvePindieFeatureSelection(
    input.featureSelection,
    {
      remote: input.remoteCompanion !== undefined || configuredRemote?.enabled === true,
      workMemory: input.projectMemorySink !== undefined || configuredMemory?.enabled === true,
    },
    env,
  );

  const stateStore: PindieStateStore = input.store ?? new FileStateStore({
    baseDir: roots.projectsBaseDir,
  });
  const experienceStore: RunExperienceStore = input.experienceStore ?? new FileRunExperienceStore({
    baseDir: roots.projectsBaseDir,
  });
  const experienceReader: RunExperienceReader = input.experienceReader ?? new FileRunExperienceReader({
    baseDir: roots.projectsBaseDir,
  });
  const crossProjectExperienceReader = input.crossProjectExperienceReader ??
    (isProjectReader(experienceReader) ? experienceReader : null);
  const continuityStore: TaskContinuityStore = input.continuityStore ?? new FileTaskContinuityStore({
    baseDir: roots.projectsBaseDir,
  });

  const strategyCandidateStore: StrategyCandidateStore = input.strategyCandidateStore ??
    new FileStrategyCandidateStore({ baseDir: roots.projectsBaseDir });
  const strategyCandidateReader: StrategyCandidateReader = input.strategyCandidateReader ??
    (typeof (strategyCandidateStore as Partial<StrategyCandidateReader>).read === "function"
      ? strategyCandidateStore as unknown as StrategyCandidateReader
      : new FileStrategyCandidateStore({ baseDir: roots.projectsBaseDir }));

  const strategyDerivationCandidateStore: StrategyDerivationCandidateStore =
    input.strategyDerivationCandidateStore ??
    new FileStrategyDerivationCandidateStore({ baseDir: roots.projectsBaseDir });
  const strategyDerivationCandidateReader: StrategyDerivationCandidateReader =
    input.strategyDerivationCandidateReader ??
    (typeof (strategyDerivationCandidateStore as Partial<StrategyDerivationCandidateReader>).read === "function"
      ? strategyDerivationCandidateStore as unknown as StrategyDerivationCandidateReader
      : new FileStrategyDerivationCandidateStore({ baseDir: roots.projectsBaseDir }));

  const strategyDecisionStore: StrategyRevisionDecisionStore = input.strategyDecisionStore ??
    new FileStrategyDecisionStore({ baseDir: roots.projectsBaseDir });
  const strategyDecisionReader: StrategyRevisionDecisionReader = input.strategyDecisionReader ??
    strategyDecisionStore;
  const strategyDerivationDecisionStore: StrategyDerivationDecisionStore =
    input.strategyDerivationDecisionStore ??
    new FileStrategyDerivationDecisionStore({ baseDir: roots.projectsBaseDir });
  const strategyDerivationDecisionReader: StrategyDerivationDecisionReader =
    input.strategyDerivationDecisionReader ?? strategyDerivationDecisionStore;

  const strategyTrustScopeCandidateStore: StrategyTrustScopeCandidateStore =
    input.strategyTrustScopeCandidateStore ??
    new FileStrategyTrustScopeCandidateStore({ baseDir: roots.globalBaseDir });
  const strategyTrustScopeDecisionStore: StrategyTrustScopeDecisionStore =
    input.strategyTrustScopeDecisionStore ??
    new FileStrategyTrustScopeDecisionStore({ baseDir: roots.globalBaseDir });
  const strategyTrustScopeSourceResolver: StrategyTrustScopeSourceResolver =
    input.strategyTrustScopeSourceResolver ??
    new FileStrategyTrustScopeSourceResolver({ projectsBaseDir: roots.projectsBaseDir });
  const strategyTrustScopeWriterLock: GlobalWriterLock =
    input.strategyTrustScopeWriterLock ?? new FileGlobalWriterLock({
      baseDir: roots.globalBaseDir,
    });
  const scopeProjectTrustReader: ScopeProjectTrustReader = input.scopeProjectTrustReader ??
    new FileScopeProjectTrustReader({ projectsBaseDir: roots.projectsBaseDir });

  let projectMemorySink: ProjectMemorySink | undefined;
  if (selection.workMemory) {
    projectMemorySink = input.projectMemorySink;
    if (projectMemorySink === undefined && configuredMemory?.enabled === true) {
      const { Client } = loadNotionSdk();
      const { NotionProjectMemorySink } = loadNotionProjectMemoryModule();
      const client = new Client({
        auth: configuredMemory.config.token,
        notionVersion: NOTION_PROJECT_MEMORY_API_VERSION,
      });
      projectMemorySink = new NotionProjectMemorySink({
        client,
        dataSourceId: configuredMemory.config.dataSourceId,
      });
    }
  }

  let remoteCompanion: PindieExtensionOptions["remoteCompanion"];
  let remoteRoutingStore = selection.remote ? input.remoteRoutingStore : undefined;
  if (selection.remote) {
    remoteCompanion = input.remoteCompanion;
    if (remoteCompanion === undefined && configuredRemote?.enabled === true) {
      const { DiscordRemote } = loadDiscordRemoteModule();
      const { RemoteCompanion } = loadRemoteCompanionModule();
      const discord = new DiscordRemote(configuredRemote.config);
      remoteRoutingStore ??= new RemoteRoutingStore({
        baseDir: roots.remoteRoutingBaseDir,
      });
      remoteCompanion = {
        companion: new RemoteCompanion(discord, {
          routing: remoteRoutingStore,
        }),
        guildId: configuredRemote.config.guildId,
        discord,
      };
    }
  }

  const {
    projectMemorySink: _inputProjectMemorySink,
    remoteCompanion: _inputRemoteCompanion,
    remoteRoutingStore: _inputRemoteRoutingStore,
    ...inputWithoutOptionalFeatures
  } = input;
  const extensionOptions: PindieExtensionOptions = {
    ...inputWithoutOptionalFeatures,
    store: stateStore,
    continuityStore,
    experienceStore,
    experienceReader,
    crossProjectExperienceReader: crossProjectExperienceReader ?? undefined,
    strategyCandidateStore,
    strategyCandidateReader,
    strategyDerivationCandidateStore,
    strategyDerivationCandidateReader,
    strategyDecisionStore,
    strategyDecisionReader,
    strategyDerivationDecisionStore,
    strategyDerivationDecisionReader,
    strategyTrustScopeCandidateStore,
    strategyTrustScopeDecisionStore,
    strategyTrustScopeSourceResolver,
    strategyTrustScopeWriterLock,
    scopeProjectTrustReader,
    ...(projectMemorySink === undefined ? {} : { projectMemorySink }),
    ...(remoteCompanion === undefined ? {} : { remoteCompanion }),
    ...(remoteRoutingStore === undefined ? {} : { remoteRoutingStore }),
    featureSelection: selection,
    storageRoots: roots,
  };

  return Object.freeze({
    featureSelection: selection,
    storageRoots: roots,
    remoteRoutingStore: remoteRoutingStore ?? null,
    extensionOptions,
    warnings: Object.freeze(configuredWarnings(configuredMemory, configuredRemote)),
  });
}

export function composeConfiguredPindieExtension(
  input: PindieExtensionOptions = {},
  env: Record<string, string | undefined> = process.env,
): PindieComposition {
  return composePindieExtension(input, {
    configureOptionalFeatures: true,
    env,
  });
}
