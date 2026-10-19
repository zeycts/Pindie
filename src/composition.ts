import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { discordRemoteConfig, type DiscordRemoteConfigResult } from "./remote-config.ts";
import { NOTION_PROJECT_MEMORY_API_VERSION, notionProjectMemoryConfig, type NotionProjectMemoryConfigResult } from "./notion-project-memory-config.ts";
import { RemoteRoutingStore } from "./remote-routing.ts";
import { FileStateStore, FileTaskContinuityStore } from "./store.ts";
import type { PindieExtensionOptions } from "./extension.ts";
import { FileQuotaResumePreferenceStore } from "./quota-resume.ts";
import { FileQuotaFallbackPreferenceStore } from "./quota-fallback.ts";
import type { NotionProjectMemoryClient } from "./notion-project-memory.ts";

const require = createRequire(import.meta.url);
type DiscordRemoteModule = typeof import("./discord-remote.ts");
type RemoteCompanionModule = typeof import("./remote-companion.ts");
type NotionProjectMemoryModule = typeof import("./notion-project-memory.ts");
type NotionSdkModule = { readonly Client: new (options: { readonly auth: string; readonly notionVersion: string }) => NotionProjectMemoryClient };

/** Retired flags remain inert input compatibility until Phase 2. No override can enable them. */
export interface PindieFeatureSelection {
  readonly selfImprovement: boolean;
  readonly crossProjectLearning: boolean;
  readonly remote: boolean;
  readonly workMemory: boolean;
  readonly bundledSkills: boolean;
  readonly presentation: boolean;
}
export type PindieFeatureSelectionOverrides = Partial<PindieFeatureSelection>;
export interface PindieFeatureAvailability { readonly remote?: boolean; readonly workMemory?: boolean }
export interface PindieStorageRoots {
  readonly projectsBaseDir: string;
  readonly globalBaseDir: string;
  readonly remoteRoutingBaseDir: string;
}
export type PindieStorageRootOverrides = Partial<PindieStorageRoots>;
export interface PindieCompositionConfig {
  readonly configureOptionalFeatures?: boolean;
  /** @deprecated Inert, retained for source compatibility only. */
  readonly onExperienceSaved?: (projectRoot: string) => void;
  readonly env?: Record<string, string | undefined>;
}
export interface PindieComposition {
  readonly featureSelection: PindieFeatureSelection;
  readonly storageRoots: PindieStorageRoots;
  readonly remoteRoutingStore: RemoteRoutingStore | null;
  readonly extensionOptions: PindieExtensionOptions;
  readonly warnings: readonly string[];
}
export const DEFAULT_PINDIE_FEATURE_SELECTION: PindieFeatureSelection = Object.freeze({
  selfImprovement: false, crossProjectLearning: false,
  remote: false, workMemory: false, bundledSkills: true, presentation: true,
});
function configuredFlag(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean value.`);
}
export function resolvePindieFeatureSelection(
  overrides: PindieFeatureSelectionOverrides = {}, availability: PindieFeatureAvailability = {},
  env: Record<string, string | undefined> = process.env,
): PindieFeatureSelection {
  // AL/SI/CPL are retired, not optional features. Do not even parse their old flags.
  const remoteAvailable = availability.remote === true;
  const workMemoryAvailable = availability.workMemory === true;
  return Object.freeze({
    selfImprovement: false, crossProjectLearning: false,
    remote: (overrides.remote ?? configuredFlag(env, "PINDIE_REMOTE_ENABLED") ?? remoteAvailable) && remoteAvailable,
    workMemory: (overrides.workMemory ?? configuredFlag(env, "PINDIE_WORK_MEMORY_ENABLED") ?? workMemoryAvailable) && workMemoryAvailable,
    bundledSkills: overrides.bundledSkills ?? configuredFlag(env, "PINDIE_BUNDLED_SKILLS_ENABLED") ?? true,
    presentation: overrides.presentation ?? configuredFlag(env, "PINDIE_PRESENTATION_ENABLED") ?? true,
  });
}
export function resolvePindieStorageRoots(overrides: PindieStorageRootOverrides = {}, homeDirectory = homedir()): PindieStorageRoots {
  return Object.freeze({
    projectsBaseDir: overrides.projectsBaseDir ?? join(homeDirectory, ".pindie", "projects"),
    globalBaseDir: overrides.globalBaseDir ?? join(homeDirectory, ".pindie", "global"),
    remoteRoutingBaseDir: overrides.remoteRoutingBaseDir ?? join(homeDirectory, ".pindie", "remote", "discord", "projects"),
  });
}
function configuredWarnings(memory: NotionProjectMemoryConfigResult | null, remote: DiscordRemoteConfigResult | null): string[] {
  return [...(memory !== null && !memory.enabled && memory.warning ? [memory.warning] : []),
    ...(remote !== null && !remote.enabled && remote.warning ? [remote.warning] : [])];
}
export function composePindieExtension(input: PindieExtensionOptions = {}, config: PindieCompositionConfig = {}): PindieComposition {
  const env = config.env ?? process.env;
  const roots = resolvePindieStorageRoots(input.storageRoots);
  const configuredMemory = config.configureOptionalFeatures === true ? notionProjectMemoryConfig(env) : null;
  const configuredRemote = config.configureOptionalFeatures === true ? discordRemoteConfig(env) : null;
  const selection = resolvePindieFeatureSelection(input.featureSelection, {
    remote: input.remoteCompanion !== undefined || configuredRemote?.enabled === true,
    workMemory: input.projectMemorySink !== undefined || configuredMemory?.enabled === true,
  }, env);
  let projectMemorySink = selection.workMemory ? input.projectMemorySink : undefined;
  if (selection.workMemory && projectMemorySink === undefined && configuredMemory?.enabled === true) {
    const { Client } = require("@notionhq/client") as NotionSdkModule;
    const { NotionProjectMemorySink } = require("./notion-project-memory.ts") as NotionProjectMemoryModule;
    projectMemorySink = new NotionProjectMemorySink({ client: new Client({ auth: configuredMemory.config.token,
      notionVersion: NOTION_PROJECT_MEMORY_API_VERSION }), dataSourceId: configuredMemory.config.dataSourceId });
  }
  let remoteCompanion = selection.remote ? input.remoteCompanion : undefined;
  let remoteRoutingStore = selection.remote ? input.remoteRoutingStore : undefined;
  if (selection.remote && remoteCompanion === undefined && configuredRemote?.enabled === true) {
    const { DiscordRemote } = require("./discord-remote.ts") as DiscordRemoteModule;
    const { RemoteCompanion } = require("./remote-companion.ts") as RemoteCompanionModule;
    const discord = new DiscordRemote(configuredRemote.config);
    remoteRoutingStore ??= new RemoteRoutingStore({ baseDir: roots.remoteRoutingBaseDir });
    remoteCompanion = { companion: new RemoteCompanion(discord, { routing: remoteRoutingStore }),
      guildId: configuredRemote.config.guildId, discord };
  }
  // Drop retired dependency injection too: no getters, constructors, reads, writes or callbacks.
  const retired = new Set([
    "experienceStore", "experienceReader", "onExperienceSaved", "workEpisodes", "trialAssignmentStore", "trialHypothesisReader",
    "trialAssignmentPolicy", "trialDiagnostic", "strategyCandidateStore", "strategyCandidateReader",
    "strategyDerivationCandidateStore", "strategyDerivationCandidateReader", "strategyDecisionStore", "strategyDecisionReader",
    "strategyDerivationDecisionStore", "strategyDerivationDecisionReader", "strategyTrustScopeCandidateStore",
    "strategyTrustScopeDecisionStore", "strategyTrustScopeSourceResolver", "strategyTrustScopeWriterLock",
    "crossProjectExperienceReader", "crossProjectTrustReader", "scopeProjectTrustReader",
    "strategySynthesisCandidateReader", "strategySynthesisDecisionReader", "strategySynthesisCandidateStore", "strategySynthesisDecisionStore",
    "projectMemorySink", "remoteCompanion", "remoteRoutingStore",
  ]);
  const retained = Object.fromEntries(Object.keys(input).filter((key) => !retired.has(key)).map((key) => [key, input[key as keyof PindieExtensionOptions]]));
  const extensionOptions: PindieExtensionOptions = {
    ...retained,
    store: input.store ?? new FileStateStore({ baseDir: roots.projectsBaseDir }),
    continuityStore: input.continuityStore ?? new FileTaskContinuityStore({ baseDir: roots.projectsBaseDir }),
    quotaResumePreferenceStore: input.quotaResumePreferenceStore ?? new FileQuotaResumePreferenceStore({ baseDir: roots.globalBaseDir }),
    quotaFallbackPreferenceStore: input.quotaFallbackPreferenceStore ?? new FileQuotaFallbackPreferenceStore({ baseDir: roots.globalBaseDir }),
    ...(projectMemorySink === undefined ? {} : { projectMemorySink }),
    ...(remoteCompanion === undefined ? {} : { remoteCompanion }),
    ...(remoteRoutingStore === undefined ? {} : { remoteRoutingStore }),
    featureSelection: selection, storageRoots: roots,
  };
  return Object.freeze({ featureSelection: selection, storageRoots: roots, remoteRoutingStore: remoteRoutingStore ?? null,
    extensionOptions, warnings: Object.freeze(configuredWarnings(configuredMemory, configuredRemote)) });
}
export function composeConfiguredPindieExtension(input: PindieExtensionOptions = {}, env: Record<string, string | undefined> = process.env): PindieComposition {
  return composePindieExtension(input, { configureOptionalFeatures: true, env });
}
