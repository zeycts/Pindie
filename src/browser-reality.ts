import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DevToolsClient,
  type BrowserUseConfig,
} from "@amaster.ai/pi-browser-use";

const execFile = promisify(execFileCallback);

const DEFAULT_WINDOWS_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const POWERSHELL_CWD = "/mnt/c/Windows";
const START_TIMEOUT_MS = 10_000;
const START_POLL_MS = 250;
const DEFAULT_START_ATTEMPTS = 2;

export const REQUIRED_BROWSER_TOOL_NAMES = Object.freeze([
  "list_pages",
  "select_page",
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "click",
  "fill",
  "press_key",
  "evaluate_script",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
] as const);

export interface BrowserRealityConfig {
  readonly enabled: boolean;
  readonly browserUrl?: string;
  readonly chromeExecutable: string;
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

interface LaunchedBrowser {
  readonly pid: number;
}

export interface BrowserRealityRuntimeDependencies {
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
  readonly config: BrowserRealityConfig;
  readonly status: () => Promise<BrowserRealityStatus>;
  readonly createClient?: (config: BrowserUseConfig) => BrowserRealityToolClient;
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
    ...(env.PINDIE_BROWSER_URL?.trim()
      ? { browserUrl: env.PINDIE_BROWSER_URL.trim() }
      : {}),
    chromeExecutable:
      env.PINDIE_BROWSER_EXECUTABLE?.trim() || DEFAULT_WINDOWS_CHROME,
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

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function defaultAllocatePort(): Promise<number> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)",
    "try {",
    "  $listener.Start()",
    "  Write-Output \"PORT:$($listener.LocalEndpoint.Port)\"",
    "} finally {",
    "  $listener.Stop()",
    "}",
  ].join("\n");
  const result = await execFile(DEFAULT_POWERSHELL, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    cwd: POWERSHELL_CWD,
    timeout: 10_000,
    windowsHide: true,
  });
  const match = /(?:^|\n)PORT:(\d+)(?:\r?\n|$)/u.exec(result.stdout);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Windows did not allocate a loopback browser port.");
  }
  return port;
}

async function defaultAllocateProfileDirectory(runtimeId: string): Promise<string> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$root = Join-Path $env:LOCALAPPDATA 'Pindie\\Dev Browser'",
    `$profile = Join-Path $root ${powershellLiteral(runtimeId)}`,
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
    "Write-Output \"PROFILE:$profile\"",
  ].join("\n");
  const result = await execFile(DEFAULT_POWERSHELL, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    cwd: POWERSHELL_CWD,
    timeout: 10_000,
    windowsHide: true,
  });
  const match = /(?:^|\n)PROFILE:(.+?)(?:\r?\n|$)/u.exec(result.stdout);
  const profileDirectory = match?.[1]?.trim();
  if (!profileDirectory) throw new Error("Windows did not provide a Dev Browser profile path.");
  return profileDirectory;
}

async function defaultLaunch(config: ActiveBrowserRealityConfig): Promise<LaunchedBrowser> {
  const endpoint = browserEndpoint(config);
  if (typeof endpoint === "string") throw new Error(endpoint);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$profile = ${powershellLiteral(config.profileDirectory)}`,
    "$arguments = @(",
    `  '--remote-debugging-port=${endpoint.port}',`,
    "  \"--user-data-dir=`\"$profile`\"\",",
    "  '--no-first-run',",
    "  '--no-default-browser-check',",
    "  '--disable-extensions',",
    "  'about:blank'",
    ")",
    `$process = Start-Process -FilePath ${powershellLiteral(config.chromeExecutable)} -ArgumentList $arguments -PassThru`,
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
    "Write-Output \"PID:$($process.Id)\"",
  ].join("\n");
  const result = await execFile(DEFAULT_POWERSHELL, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    cwd: POWERSHELL_CWD,
    env: process.env,
    timeout: 10_000,
    windowsHide: true,
  });
  const match = /(?:^|\n)PID:(\d+)(?:\r?\n|$)/u.exec(result.stdout);
  if (!match) throw new Error("Windows Chrome did not report its process ID.");
  return { pid: Number(match[1]) };
}

async function defaultStop(browser: LaunchedBrowser): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Stop-Process -Id ${browser.pid}`,
  ].join("\n");
  await execFile(DEFAULT_POWERSHELL, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    cwd: POWERSHELL_CWD,
    timeout: 10_000,
    windowsHide: true,
  });
}

async function defaultCleanupProfile(profileDirectory: string): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$profile = ${powershellLiteral(profileDirectory)}`,
    "for ($attempt = 0; $attempt -lt 20; $attempt++) {",
    "  if (-not (Test-Path -LiteralPath $profile)) { exit 0 }",
    "  Remove-Item -LiteralPath $profile -Recurse -Force",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "if (Test-Path -LiteralPath $profile) { exit 1 }",
  ].join("\n");
  await execFile(DEFAULT_POWERSHELL, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    cwd: POWERSHELL_CWD,
    timeout: 10_000,
    windowsHide: true,
  });
}

export function createBrowserRealityRuntime(
  config: BrowserRealityConfig,
  dependencies: BrowserRealityRuntimeDependencies = {},
): BrowserRealityRuntime {
  const probe = dependencies.probe ?? defaultProbe;
  const allocatePort = dependencies.allocatePort ?? defaultAllocatePort;
  const allocateProfileDirectory = dependencies.allocateProfileDirectory ??
    defaultAllocateProfileDirectory;
  const launch = dependencies.launch ?? defaultLaunch;
  const stop = dependencies.stop ?? defaultStop;
  const cleanupProfile = dependencies.cleanupProfile ?? defaultCleanupProfile;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const runtimeId = randomUUID();
  const ownsProfile = config.profileDirectory === undefined;
  let effectiveConfig: BrowserRealityConfig = config;
  let browser: LaunchedBrowser | null = null;
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
    ownedProfileDirectory = null;
    if (profileDirectory) await cleanupProfile(profileDirectory);
  };

  return {
    get config() {
      return effectiveConfig;
    },
    async start() {
      if (!config.enabled) return current;

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
        } catch {
          // Preserve the factual startup failure; cleanup is best effort.
        }
        browser = null;
        lastFailure =
          `Pindie Dev Browser did not expose ${browserUrl} within ${START_TIMEOUT_MS}ms.`;
      }

      if (ownsProfile) {
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
        const launched = browser;
        browser = null;
        if (launched) {
          try {
            await stop(launched);
          } catch (error) {
            console.warn(`[Pindie] Could not stop Pindie Dev Browser: ${safeFailure(error)}`);
          }
        }
        if (ownsProfile) {
          try {
            await cleanOwnedProfile();
          } catch (error) {
            console.warn(`[Pindie] Could not clean Pindie Dev Browser profile: ${safeFailure(error)}`);
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

function browserClientConfig(config: BrowserRealityConfig): BrowserUseConfig {
  if (!config.browserUrl) throw new Error("Pindie Dev Browser endpoint is unavailable.");
  return {
    sessionMode: "existing",
    browserUrl: config.browserUrl,
    categoryPerformance: false,
    categoryNetwork: true,
    categoryEmulation: true,
    categoryExtensions: false,
    experimentalVision: false,
    experimentalScreencast: false,
    experimentalMemory: false,
    experimentalPageIdRouting: true,
    usageStatistics: false,
    performanceCrux: false,
    redactNetworkHeaders: true,
    acceptInsecureCerts: false,
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
  const createClient = options.createClient ?? ((config) => new DevToolsClient(config));
  let client: BrowserRealityToolClient | null = null;
  let unavailableReason: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const runtimeStatus = await options.status();
    if (!runtimeStatus.available) {
      unavailableReason = runtimeStatus.reason ?? "Pindie Dev Browser is unavailable.";
      if (ctx.hasUI) ctx.ui.notify(`Browser Reality unavailable: ${unavailableReason}`, "warning");
      return;
    }

    const candidate = createClient(browserClientConfig(options.config));
    client = candidate;
    try {
      const discovered = await candidate.listAllTools(AbortSignal.timeout(15_000));
      const byName = new Map(discovered.map((tool) => [tool.name, tool]));
      const missing = REQUIRED_BROWSER_TOOL_NAMES.filter((name) => !byName.has(name));
      if (missing.length > 0) {
        throw new Error(`Chrome DevTools MCP is missing required tools: ${missing.join(", ")}.`);
      }

      for (const name of REQUIRED_BROWSER_TOOL_NAMES) {
        const upstream = byName.get(name)!;
        pi.registerTool({
          name: `browser_${name}`,
          label: `browser_${name}`,
          description: upstream.description ?? `Chrome DevTools ${name} tool.`,
          parameters: Type.Unsafe(upstream.inputSchema),
          async execute(_toolCallId, params, signal) {
            if (client !== candidate) {
              throw new Error("Browser Reality belongs to a closed Pi Session.");
            }
            const result = await candidate.callTool(
              name,
              params as Record<string, unknown>,
              signal,
            );
            return {
              content: toolResultContent(result) as never,
              details: undefined,
              ...(result.isError ? { isError: true } : {}),
            };
          },
        });
      }
      unavailableReason = null;
    } catch (error) {
      unavailableReason = `Chrome DevTools bridge unavailable: ${safeFailure(error)}`;
      client = null;
      try {
        await candidate.close();
      } catch {
        // The original discovery failure is authoritative.
      }
      if (ctx.hasUI) ctx.ui.notify(`Browser Reality unavailable: ${unavailableReason}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event) => {
    const runtimeStatus = await options.status();
    const reason = unavailableReason ?? (runtimeStatus.available ? null : runtimeStatus.reason);
    if (!reason) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nBrowser Reality is enabled but unavailable: ${reason}`,
    };
  });

  pi.on("session_shutdown", async () => {
    const current = client;
    client = null;
    if (current) await current.close();
  });
}
