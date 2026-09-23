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
  FileProjectTrustedStrategyPortfolioReader,
  type ProjectTrustedStrategyPortfolioReader,
} from "./strategy-trust-safety.ts";
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
import {
  FileQuotaResumePreferenceStore,
  type QuotaResumePreferenceStore,
} from "./quota-resume.ts";
import { FileQuotaFallbackPreferenceStore, type QuotaFallbackPreferenceStore } from "./quota-fallback.ts";
import type { NotionProjectMemoryClient } from "./notion-project-memory.ts";
import type { ProjectMemorySink } from "./project-memory.ts";
import {
  FileStrategySynthesisCandidateReader,
  FileStrategySynthesisCandidateStore,
  type StrategySynthesisCandidateReader,
  type StrategySynthesisCandidateStore,
} from "./strategy-synthesis-candidates.ts";
import {
  FileStrategySynthesisDecisionReader,
  FileStrategySynthesisDecisionStore,
  type StrategySynthesisDecisionReader,
  type StrategySynthesisDecisionStore,
} from "./strategy-synthesis-decisions.ts";

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
  const continuityStore: TaskContinuityStore = input.continuityStore ?? new FileTaskContinuityStore({
    baseDir: roots.projectsBaseDir,
  });
  const quotaResumePreferenceStore: QuotaResumePreferenceStore =
    input.quotaResumePreferenceStore ?? new FileQuotaResumePreferenceStore({
      baseDir: roots.globalBaseDir,
    });
  const quotaFallbackPreferenceStore: QuotaFallbackPreferenceStore =
    input.quotaFallbackPreferenceStore ?? new FileQuotaFallbackPreferenceStore({
      baseDir: roots.globalBaseDir,
    });

  let experienceStore: RunExperienceStore | undefined;
  let experienceReader: RunExperienceReader | undefined;
  let crossProjectExperienceReader: RunExperienceProjectReader | undefined;
  let strategyCandidateStore: StrategyCandidateStore | undefined;
  let strategyCandidateReader: StrategyCandidateReader | undefined;
  let strategyDerivationCandidateStore: StrategyDerivationCandidateStore | undefined;
  let strategyDerivationCandidateReader: StrategyDerivationCandidateReader | undefined;
  let strategyDecisionStore: StrategyRevisionDecisionStore | undefined;
  let strategyDecisionReader: StrategyRevisionDecisionReader | undefined;
  let strategyDerivationDecisionStore: StrategyDerivationDecisionStore | undefined;
  let strategyDerivationDecisionReader: StrategyDerivationDecisionReader | undefined;
  let strategyTrustScopeCandidateStore: StrategyTrustScopeCandidateStore | undefined;
  let strategyTrustScopeDecisionStore: StrategyTrustScopeDecisionStore | undefined;
  let strategyTrustScopeSourceResolver: StrategyTrustScopeSourceResolver | undefined;
  let strategyTrustScopeWriterLock: GlobalWriterLock | undefined;
  let scopeProjectTrustReader: ScopeProjectTrustReader | undefined;
  let crossProjectTrustReader: ProjectTrustedStrategyPortfolioReader | undefined;
  let strategySynthesisCandidateReader: StrategySynthesisCandidateReader | undefined;
  let strategySynthesisDecisionReader: StrategySynthesisDecisionReader | undefined;
  let strategySynthesisCandidateStore: StrategySynthesisCandidateStore | undefined;
  let strategySynthesisDecisionStore: StrategySynthesisDecisionStore | undefined;

  // The mutable Synthesis Stores are also the read-only SI authority readers
  // when CPL is selected. Reuse the exact production instances so the two
  // feature boundaries cannot silently observe different global namespaces.
  if (selection.crossProjectLearning) {
    strategySynthesisCandidateStore = input.strategySynthesisCandidateStore ??
      new FileStrategySynthesisCandidateStore({ baseDir: roots.globalBaseDir });
    strategySynthesisDecisionStore = input.strategySynthesisDecisionStore ??
      new FileStrategySynthesisDecisionStore({ baseDir: roots.globalBaseDir });
  }

  if (selection.selfImprovement) {
    experienceStore = input.experienceStore ?? new FileRunExperienceStore({
      baseDir: roots.projectsBaseDir,
    });
    experienceReader = input.experienceReader ?? new FileRunExperienceReader({
      baseDir: roots.projectsBaseDir,
    });
    strategyCandidateStore = input.strategyCandidateStore ??
      new FileStrategyCandidateStore({ baseDir: roots.projectsBaseDir });
    strategyCandidateReader = input.strategyCandidateReader ??
      (typeof (strategyCandidateStore as Partial<StrategyCandidateReader>).read === "function"
        ? strategyCandidateStore as unknown as StrategyCandidateReader
        : new FileStrategyCandidateStore({ baseDir: roots.projectsBaseDir }));

    strategyDerivationCandidateStore = input.strategyDerivationCandidateStore ??
      new FileStrategyDerivationCandidateStore({ baseDir: roots.projectsBaseDir });
    strategyDerivationCandidateReader = input.strategyDerivationCandidateReader ??
      (typeof (strategyDerivationCandidateStore as Partial<StrategyDerivationCandidateReader>).read === "function"
        ? strategyDerivationCandidateStore as unknown as StrategyDerivationCandidateReader
        : new FileStrategyDerivationCandidateStore({ baseDir: roots.projectsBaseDir }));

    strategyDecisionStore = input.strategyDecisionStore ??
      new FileStrategyDecisionStore({ baseDir: roots.projectsBaseDir });
    strategyDecisionReader = input.strategyDecisionReader ?? strategyDecisionStore;
    strategyDerivationDecisionStore = input.strategyDerivationDecisionStore ??
      new FileStrategyDerivationDecisionStore({ baseDir: roots.projectsBaseDir });
    strategyDerivationDecisionReader = input.strategyDerivationDecisionReader ?? strategyDerivationDecisionStore;

    strategyTrustScopeCandidateStore = input.strategyTrustScopeCandidateStore ??
      new FileStrategyTrustScopeCandidateStore({ baseDir: roots.globalBaseDir });
    strategyTrustScopeDecisionStore = input.strategyTrustScopeDecisionStore ??
      new FileStrategyTrustScopeDecisionStore({ baseDir: roots.globalBaseDir });
    strategyTrustScopeSourceResolver = input.strategyTrustScopeSourceResolver ??
      new FileStrategyTrustScopeSourceResolver({ projectsBaseDir: roots.projectsBaseDir });
    strategyTrustScopeWriterLock = input.strategyTrustScopeWriterLock ?? new FileGlobalWriterLock({
      baseDir: roots.globalBaseDir,
    });
    // Synthesis authority is part of the SI trust-safety substrate, not only
    // the optional CPL workflow. SI constructs read-only access here; the
    // mutable workflow Stores are assembled only when CPL is selected below.
    strategySynthesisCandidateReader = input.strategySynthesisCandidateReader ??
      strategySynthesisCandidateStore ??
      input.strategySynthesisCandidateStore ??
      new FileStrategySynthesisCandidateReader({ baseDir: roots.globalBaseDir });
    strategySynthesisDecisionReader = input.strategySynthesisDecisionReader ??
      strategySynthesisDecisionStore ??
      input.strategySynthesisDecisionStore ??
      new FileStrategySynthesisDecisionReader({ baseDir: roots.globalBaseDir });
  }

  if (selection.crossProjectLearning) {
    crossProjectExperienceReader = input.crossProjectExperienceReader ??
      (experienceReader !== undefined && isProjectReader(experienceReader) ? experienceReader : undefined);
    crossProjectTrustReader = input.crossProjectTrustReader ?? new FileProjectTrustedStrategyPortfolioReader({
      projectsBaseDir: roots.projectsBaseDir,
      globalBaseDir: roots.globalBaseDir,
    });
    scopeProjectTrustReader = input.scopeProjectTrustReader ??
      new FileScopeProjectTrustReader({ projectsBaseDir: roots.projectsBaseDir });
    if (crossProjectExperienceReader === undefined) {
      // A custom SI-only test reader may not expose the optional cross-project
      // namespace. Keep CPL assembled but make its evidence path fail closed;
      // production composition always supplies FileRunExperienceReader.
      crossProjectExperienceReader = {
        listProjectIds: async () => Object.freeze([]),
        readProjectId: async () => {
          throw new Error("Cross-project Experience reader is unavailable.");
        },
      };
    }
  }

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
    quotaResumePreferenceStore: _inputQuotaResumePreferenceStore,
    quotaFallbackPreferenceStore: _inputQuotaFallbackPreferenceStore,
    experienceStore: _inputExperienceStore,
    experienceReader: _inputExperienceReader,
    crossProjectExperienceReader: _inputCrossProjectExperienceReader,
    crossProjectTrustReader: _inputCrossProjectTrustReader,
    strategySynthesisCandidateReader: _inputStrategySynthesisCandidateReader,
    strategySynthesisDecisionReader: _inputStrategySynthesisDecisionReader,
    strategySynthesisCandidateStore: _inputStrategySynthesisCandidateStore,
    strategySynthesisDecisionStore: _inputStrategySynthesisDecisionStore,
    strategyCandidateStore: _inputStrategyCandidateStore,
    strategyCandidateReader: _inputStrategyCandidateReader,
    strategyDerivationCandidateStore: _inputStrategyDerivationCandidateStore,
    strategyDerivationCandidateReader: _inputStrategyDerivationCandidateReader,
    strategyDecisionStore: _inputStrategyDecisionStore,
    strategyDecisionReader: _inputStrategyDecisionReader,
    strategyDerivationDecisionStore: _inputStrategyDerivationDecisionStore,
    strategyDerivationDecisionReader: _inputStrategyDerivationDecisionReader,
    strategyTrustScopeCandidateStore: _inputStrategyTrustScopeCandidateStore,
    strategyTrustScopeDecisionStore: _inputStrategyTrustScopeDecisionStore,
    strategyTrustScopeSourceResolver: _inputStrategyTrustScopeSourceResolver,
    strategyTrustScopeWriterLock: _inputStrategyTrustScopeWriterLock,
    scopeProjectTrustReader: _inputScopeProjectTrustReader,
    ...inputWithoutOptionalFeatures
  } = input;
  const extensionOptions: PindieExtensionOptions = {
    ...inputWithoutOptionalFeatures,
    store: stateStore,
    continuityStore,
    quotaResumePreferenceStore,
    quotaFallbackPreferenceStore,
    ...(selection.selfImprovement
      ? {
          experienceStore: experienceStore!,
          experienceReader: experienceReader!,
          strategyCandidateStore: strategyCandidateStore!,
          strategyCandidateReader: strategyCandidateReader!,
          strategyDerivationCandidateStore: strategyDerivationCandidateStore!,
          strategyDerivationCandidateReader: strategyDerivationCandidateReader!,
          strategyDecisionStore: strategyDecisionStore!,
          strategyDecisionReader: strategyDecisionReader!,
          strategyDerivationDecisionStore: strategyDerivationDecisionStore!,
          strategyDerivationDecisionReader: strategyDerivationDecisionReader!,
          strategyTrustScopeCandidateStore: strategyTrustScopeCandidateStore!,
          strategyTrustScopeDecisionStore: strategyTrustScopeDecisionStore!,
          strategyTrustScopeSourceResolver: strategyTrustScopeSourceResolver!,
          strategyTrustScopeWriterLock: strategyTrustScopeWriterLock!,
          strategySynthesisCandidateReader: strategySynthesisCandidateReader!,
          strategySynthesisDecisionReader: strategySynthesisDecisionReader!,
        }
      : {}),
    ...(selection.crossProjectLearning
      ? {
          crossProjectExperienceReader: crossProjectExperienceReader!,
          crossProjectTrustReader: crossProjectTrustReader!,
          scopeProjectTrustReader: scopeProjectTrustReader!,
          strategySynthesisCandidateStore: strategySynthesisCandidateStore!,
          strategySynthesisDecisionStore: strategySynthesisDecisionStore!,
        }
      : {}),
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
