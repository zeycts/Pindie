import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserRealityManager } from "./browser-reality-manager.ts";
import { readBrowserToolCatalog } from "./browser-tool-catalog.ts";
export { REQUIRED_BROWSER_TOOL_NAMES } from "./browser-tool-catalog.ts";
import {
  buildBrowserLaunchArguments,
  createBrowserRealityHost,
  UnconfirmedBrowserLaunchError,
  type BrowserRealityHost,
  type LaunchedBrowser,
} from "./browser-reality-host.ts";

export { buildBrowserLaunchArguments } from "./browser-reality-host.ts";
const START_TIMEOUT_MS = 10_000;
const START_POLL_MS = 250;
const DEFAULT_START_ATTEMPTS = 2;

export interface BrowserRealityConfig {
  readonly enabled: boolean;
  readonly headless: boolean;
  readonly browserUrl?: string;
  readonly chromeExecutable?: string;
  readonly profileDirectory?: string;
}

interface ActiveBrowserRealityConfig extends BrowserRealityConfig {
  readonly browserUrl: string;
  readonly profileDirectory: string;
}

export interface BrowserRealityStatus {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly reason: string | null;
}

export interface BrowserRealityRuntime {
  readonly config: BrowserRealityConfig;
  start(): Promise<BrowserRealityStatus>;
  status(): Promise<BrowserRealityStatus>;
  dispose(): Promise<void>;
}

export interface BrowserRealityRuntimeDependencies {
  host?: BrowserRealityHost;
  probe?(browserUrl: string): Promise<boolean>;
  allocatePort?(): Promise<number>;
  allocateProfileDirectory?(runtimeId: string): Promise<string>;
  launch?(config: ActiveBrowserRealityConfig): Promise<LaunchedBrowser>;
  stop?(browser: LaunchedBrowser): Promise<void>;
  cleanupProfile?(profileDirectory: string): Promise<void>;
  sleep?(milliseconds: number): Promise<void>;
  now?(): number;
}

export interface BrowserRealityToolClient {
  listAllTools(signal?: AbortSignal): Promise<Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content?: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

export interface BrowserRealityExtensionOptions {
  readonly manager: BrowserRealityManager;
}

function configuredFlag(
  env: Record<string, string | undefined>,
  name: string,
): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be a boolean value.`);
}

export function resolveBrowserRealityConfig(
  env: Record<string, string | undefined> = process.env,
): BrowserRealityConfig {
  return Object.freeze({
    enabled: configuredFlag(env, "PINDIE_BROWSER_ENABLED") ?? true,
    headless: configuredFlag(env, "PINDIE_BROWSER_HEADLESS") ?? true,
    ...(env.PINDIE_BROWSER_URL?.trim()
      ? { browserUrl: env.PINDIE_BROWSER_URL.trim() }
      : {}),
    ...(env.PINDIE_BROWSER_EXECUTABLE?.trim()
      ? { chromeExecutable: env.PINDIE_BROWSER_EXECUTABLE.trim() }
      : {}),
    ...(env.PINDIE_BROWSER_PROFILE_DIR?.trim()
      ? { profileDirectory: env.PINDIE_BROWSER_PROFILE_DIR.trim() }
      : {}),
  });
}

function browserEndpoint(config: BrowserRealityConfig): URL | string {
  let url: URL;
  try {
    if (!config.browserUrl) throw new Error("missing browser URL");
    url = new URL(config.browserUrl);
  } catch {
    return "PINDIE_BROWSER_URL must be an HTTP loopback URL.";
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    return "PINDIE_BROWSER_URL must be an HTTP loopback URL with an explicit port.";
  }
  return url;
}

async function defaultProbe(browserUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/json/version", browserUrl), {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

function safeFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  return String(error);
}

export function createBrowserRealityRuntime(
  config: BrowserRealityConfig,
  dependencies: BrowserRealityRuntimeDependencies = {},
): BrowserRealityRuntime {
  let selectedHost = dependencies.host;
  const host = (): BrowserRealityHost => selectedHost ??= createBrowserRealityHost();
  const probe = dependencies.probe ?? defaultProbe;
  const allocatePort = dependencies.allocatePort ?? (() => host().allocatePort());
  const allocateProfileDirectory = dependencies.allocateProfileDirectory ??
    ((runtimeId) => host().allocateProfileDirectory(runtimeId));
  const launch = dependencies.launch ?? ((activeConfig) => host().launch(activeConfig));
  const stop = dependencies.stop ?? ((browser) => host().stop(browser));
  const cleanupProfile = dependencies.cleanupProfile ??
    ((profileDirectory) => host().cleanupProfile(profileDirectory));
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const runtimeId = randomUUID();
  const ownsProfile = config.profileDirectory === undefined;
  let effectiveConfig: BrowserRealityConfig = config;
  let browser: LaunchedBrowser | null = null;
  let launchUnconfirmed = false;
  let ownedProfileDirectory: string | null = null;
  let current: BrowserRealityStatus = {
    enabled: config.enabled,
    available: false,
    reason: config.enabled ? "Pindie Dev Browser has not started." : null,
  };
  let disposePromise: Promise<void> | null = null;

  const unavailable = (reason: string): BrowserRealityStatus => {
    current = { enabled: config.enabled, available: false, reason };
    return current;
  };
  const cleanOwnedProfile = async (): Promise<void> => {
    const profileDirectory = ownedProfileDirectory;
    if (profileDirectory) await cleanupProfile(profileDirectory);
    ownedProfileDirectory = null;
  };

  return {
    get config() {
      return effectiveConfig;
    },
    async start() {
      if (!config.enabled) return current;
      if (launchUnconfirmed) return unavailable("Browser launch termination is unconfirmed; replacement refused.");

      let profileDirectory = config.profileDirectory;
      try {
        if (!profileDirectory) {
          profileDirectory = await allocateProfileDirectory(runtimeId);
          ownedProfileDirectory = profileDirectory;
        }
      } catch (error) {
        return unavailable(`Could not prepare Pindie Dev Browser: ${safeFailure(error)}`);
      }

      const attempts = config.browserUrl ? 1 : DEFAULT_START_ATTEMPTS;
      let lastFailure = "";
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let browserUrl = config.browserUrl;
        try {
          browserUrl ??= `http://127.0.0.1:${await allocatePort()}`;
        } catch (error) {
          lastFailure = `Could not allocate Pindie Dev Browser endpoint: ${safeFailure(error)}`;
          break;
        }
        effectiveConfig = Object.freeze({ ...config, browserUrl, profileDirectory });
        const activeConfig = effectiveConfig as ActiveBrowserRealityConfig;
        const endpoint = browserEndpoint(activeConfig);
        if (typeof endpoint === "string") {
          lastFailure = endpoint;
          break;
        }
        if (await probe(browserUrl)) {
          if (config.browserUrl) {
            lastFailure =
              `Refused to attach to the existing browser endpoint at ${browserUrl}; ` +
              "Pindie only starts its own dedicated Dev Browser.";
            break;
          }
          lastFailure = `Allocated browser endpoint ${browserUrl} became occupied before launch.`;
          continue;
        }
        try {
          browser = await launch(activeConfig);
        } catch (error) {
          lastFailure = `Could not start Pindie Dev Browser: ${safeFailure(error)}`;
          if (error instanceof UnconfirmedBrowserLaunchError) { launchUnconfirmed = true; break; }
          if (!config.browserUrl && attempt + 1 < attempts) continue;
          break;
        }

        const deadline = now() + START_TIMEOUT_MS;
        while (now() < deadline) {
          if (await probe(browserUrl)) {
            current = { enabled: true, available: true, reason: null };
            return current;
          }
          await sleep(START_POLL_MS);
        }

        try {
          await stop(browser);
          browser = null;
        } catch (error) {
          lastFailure =
            `Pindie Dev Browser did not expose ${browserUrl} and could not be stopped: ` +
            safeFailure(error);
          break;
        }
        lastFailure =
          `Pindie Dev Browser did not expose ${browserUrl} within ${START_TIMEOUT_MS}ms.`;
      }

      if (ownsProfile && browser === null && !launchUnconfirmed) {
        try {
          await cleanOwnedProfile();
        } catch {
          // Preserve the factual startup failure; profile cleanup is best effort.
        }
      }
      return unavailable(lastFailure || "Could not start Pindie Dev Browser.");
    },
    async status() {
      if (!current.available) return current;
      const browserUrl = effectiveConfig.browserUrl!;
      if (await probe(browserUrl)) return current;
      return unavailable(`Pindie Dev Browser endpoint ${browserUrl} is no longer reachable.`);
    },
    dispose() {
      disposePromise ??= (async () => {
        if (launchUnconfirmed) throw new Error("Browser launch termination is unconfirmed; profile retained for manual review.");
        const launched = browser;
        let browserStopped = launched === null;
        if (launched) {
          try {
            await stop(launched);
            browser = null;
            browserStopped = true;
          } catch (error) {
            throw new Error(`Could not stop Pindie Dev Browser: ${safeFailure(error)}`);
          }
        }
        if (ownsProfile && browserStopped) {
          try {
            await cleanOwnedProfile();
          } catch (error) {
            throw new Error(`Could not clean Pindie Dev Browser profile: ${safeFailure(error)}`);
          }
        }
        current = {
          enabled: config.enabled,
          available: false,
          reason: config.enabled ? "Pindie Dev Browser is stopped." : null,
        };
      })();
      return disposePromise;
    },
  };
}

function toolResultContent(result: Awaited<ReturnType<BrowserRealityToolClient["callTool"]>>) {
  const content: Array<Record<string, unknown>> = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    } else if (item.type === "image" && typeof item.data === "string") {
      content.push({
        type: "image",
        data: item.data,
        mimeType: item.mimeType ?? "image/png",
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return content;
}

export function registerBrowserRealityExtension(
  pi: ExtensionAPI,
  options: BrowserRealityExtensionOptions,
): void {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Browser Reality belongs to a closed Pi Session.");
  };
  for (const upstream of readBrowserToolCatalog().tools) {
    pi.registerTool({
      name: `browser_${upstream.name}`,
      label: `browser_${upstream.name}`,
      description: upstream.description!,
      parameters: Type.Unsafe(upstream.inputSchema),
      async execute(_toolCallId, params, signal) {
        assertOpen();
        const result = await options.manager.callTool(upstream.name, params as Record<string, unknown>, signal);
        return {
          content: toolResultContent(result) as never,
          details: undefined,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    });
  }
  pi.registerTool({
    name: "browser_release", label: "browser_release",
    description: "Close this Host's DevTools bridge and owned Dev Browser, discarding its temporary pages/profile. Refuses while browser tools are in flight. The next browser call starts fresh.",
    parameters: Type.Object({}),
    async execute() {
      assertOpen();
      await options.manager.release();
      return { content: [{ type: "text", text: "Browser Reality released." }], details: undefined };
    },
  });
  pi.registerTool({
    name: "browser_status", label: "browser_status",
    description: "Report this Host's Browser Reality resource phase without starting Chrome or a DevTools bridge.",
    parameters: Type.Object({}),
    async execute() {
      assertOpen();
      return { content: [{ type: "text", text: JSON.stringify(options.manager.status()) }], details: undefined };
    },
  });
  // Activity protects browser state while the user is working elsewhere in Pi.
  pi.on("before_agent_start", async () => { options.manager.touch(); });
  pi.on("session_shutdown", async () => { closed = true; });
}
