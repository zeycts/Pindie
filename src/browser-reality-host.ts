import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { windowsBrowserJobLaunch, windowsBrowserJobStop } from "./browser-windows-job.ts";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, release as osRelease } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_WINDOWS_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const POWERSHELL_CWD = "/mnt/c/Windows";
const LINUX_BROWSER_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
] as const;

export type BrowserRealityPlatform = "wsl-windows" | "linux";

export interface BrowserRealityHostConfig {
  readonly headless: boolean;
  readonly browserUrl: string;
  readonly chromeExecutable?: string;
  readonly profileDirectory: string;
}

export class UnconfirmedBrowserLaunchError extends Error {}

export interface LaunchedBrowser {
  readonly pid: number;
  readonly process?: ChildProcess;
}

export interface BrowserRealityHost {
  readonly platform: BrowserRealityPlatform;
  allocatePort(): Promise<number>;
  allocateProfileDirectory(runtimeId: string): Promise<string>;
  launch(config: BrowserRealityHostConfig): Promise<LaunchedBrowser>;
  stop(browser: LaunchedBrowser): Promise<void>;
  cleanupProfile(profileDirectory: string): Promise<void>;
}

export interface PlatformDetectionInput {
  readonly platform?: NodeJS.Platform;
  readonly release?: string;
  readonly env?: Record<string, string | undefined>;
}

export function detectBrowserRealityPlatform(
  input: PlatformDetectionInput = {},
): BrowserRealityPlatform {
  const platform = input.platform ?? process.platform;
  const release = input.release ?? osRelease();
  const env = input.env ?? process.env;
  if (
    env.WSL_DISTRO_NAME !== undefined ||
    env.WSL_INTEROP !== undefined ||
    (platform === "linux" && /microsoft/iu.test(release))
  ) return "wsl-windows";
  if (platform === "linux") return "linux";
  throw new Error(`Browser Reality is not supported on platform ${platform}.`);
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildBrowserLaunchArguments(
  config: BrowserRealityHostConfig,
): readonly string[] {
  const endpoint = new URL(config.browserUrl);
  return Object.freeze([
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${endpoint.port}`,
    `--user-data-dir=${config.profileDirectory}`,
    ...(config.headless ? ["--headless"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank",
  ]);
}

export function createWslWindowsBrowserRealityHost(dependencies: {
  execute?: (script: string) => Promise<{ stdout: string }>;
} = {}): BrowserRealityHost {
  const execute = dependencies.execute ?? ((script: string) => execFile(DEFAULT_POWERSHELL, [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], { cwd: POWERSHELL_CWD, timeout: 10_000, windowsHide: true }));
  const owned = new WeakMap<LaunchedBrowser, string>();
  return {
    platform: "wsl-windows",
    async allocatePort() {
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
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], { cwd: POWERSHELL_CWD, timeout: 10_000, windowsHide: true });
      const match = /(?:^|\n)PORT:(\d+)(?:\r?\n|$)/u.exec(result.stdout);
      const port = match ? Number(match[1]) : 0;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Windows did not allocate a loopback browser port.");
      }
      return port;
    },
    async allocateProfileDirectory(runtimeId) {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$root = Join-Path $env:LOCALAPPDATA 'Pindie\\Dev Browser'",
        `$profile = Join-Path $root ${powershellLiteral(runtimeId)}`,
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
        "Write-Output \"PROFILE:$profile\"",
      ].join("\n");
      const result = await execFile(DEFAULT_POWERSHELL, [
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], { cwd: POWERSHELL_CWD, timeout: 10_000, windowsHide: true });
      const match = /(?:^|\n)PROFILE:(.+?)(?:\r?\n|$)/u.exec(result.stdout);
      const profileDirectory = match?.[1]?.trim();
      if (!profileDirectory) {
        throw new Error("Windows did not provide a Dev Browser profile path.");
      }
      return profileDirectory;
    },
    async launch(config) {
      const job = `Local\\PindieDevBrowser-${randomUUID()}`;
      try {
        const result = await execute(windowsBrowserJobLaunch(job, config.chromeExecutable ?? DEFAULT_WINDOWS_CHROME,
          buildBrowserLaunchArguments(config).filter((argument) => argument !== "--remote-debugging-address=127.0.0.1")));
        const match = /(?:^|\n)PID:(\d+)(?:\r?\n|$)/u.exec(result.stdout);
        if (!match || Number(match[1]) < 1) throw new Error("Windows Chrome did not report its process ID.");
        const browser = Object.freeze({ pid: Number(match[1]) });
        owned.set(browser, job);
        return browser;
      } catch (error) {
        // A timed-out interop process might have launched Chrome without returning
        // its marker. Best-effort job stop never authorizes profile deletion here.
        try { await execute(windowsBrowserJobStop(job)); } catch { /* Retain for manual review. */ }
        throw new UnconfirmedBrowserLaunchError(`Windows browser launch is unconfirmed (${job}): ${String(error)}`);
      }
    },
    async stop(browser) {
      const job = owned.get(browser);
      if (!job) throw new Error("Refused to stop a browser not launched by this Host.");
      await execute(windowsBrowserJobStop(job));
    },
    async cleanupProfile(profileDirectory) {
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
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], { cwd: POWERSHELL_CWD, timeout: 10_000, windowsHide: true });
    },
  };
}

export interface LinuxBrowserRealityHostDependencies {
  readonly env?: Record<string, string | undefined>;
  readonly homeDirectory?: string;
  readonly spawn?: typeof spawn;
  readonly access?: typeof access;
  readonly mkdir?: typeof mkdir;
  readonly rm?: typeof rm;
  readonly stopGracePeriodMs?: number;
  readonly forceKillWaitMs?: number;
  readonly kill?: typeof process.kill;
  readonly readFile?: typeof readFile;
}

export async function resolveLinuxBrowserExecutable(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
  checkAccess: typeof access = access,
): Promise<string> {
  const candidates = explicit ? [explicit] : [...LINUX_BROWSER_CANDIDATES];
  const pathDirectories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const candidate of candidates) {
    const paths = candidate.includes("/") || isAbsolute(candidate)
      ? [candidate]
      : pathDirectories.map((directory) => join(directory, candidate));
    for (const executable of paths) {
      try {
        await checkAccess(executable, fsConstants.X_OK);
        return executable;
      } catch {
        // Continue to the next factual filesystem candidate.
      }
    }
  }
  if (explicit) {
    throw new Error(`Configured browser executable is not executable: ${explicit}`);
  }
  throw new Error(
    "No supported Chrome/Chromium executable was found. " +
    "Set PINDIE_BROWSER_EXECUTABLE or install Chrome/Chromium.",
  );
}

function parseLinuxProcessStat(text: string): { state: string; group: number; session: number; started: string } {
  // comm may contain spaces and parentheses. Fields after its final ')' begin at state (3).
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/u);
  if (text.lastIndexOf(")") < 0 || fields.length < 20 || !/^[A-Z]$/u.test(fields[0]!) ||
      [fields[2], fields[3], fields[19]].some((field) => !/^\d+$/u.test(field ?? ""))) {
    throw new Error("Unrecognized Linux process identity.");
  }
  return { state: fields[0]!, group: Number(fields[2]), session: Number(fields[3]), started: fields[19]! };
}

export function createLinuxBrowserRealityHost(
  dependencies: LinuxBrowserRealityHostDependencies = {},
): BrowserRealityHost {
  const env = dependencies.env ?? process.env;
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const spawnProcess = dependencies.spawn ?? spawn;
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const removeDirectory = dependencies.rm ?? rm;
  const checkAccess = dependencies.access ?? access;
  const stopGracePeriodMs = dependencies.stopGracePeriodMs ?? 2_000;
  const forceKillWaitMs = dependencies.forceKillWaitMs ?? 1_000;
  const signalProcess = dependencies.kill ?? process.kill;
  const read = dependencies.readFile ?? readFile;
  const owned = new WeakMap<LaunchedBrowser, { started: string; stopped: boolean }>();
  const stat = async (pid: number) => {
    try { return parseLinuxProcessStat(await read(`/proc/${pid}/stat`, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null;
      throw error;
    }
  };
  return {
    platform: "linux",
    allocatePort() {
      return new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          server.close((error) => error ? reject(error) : resolve(port));
        });
      });
    },
    async allocateProfileDirectory(runtimeId) {
      const cacheRoot = env.XDG_CACHE_HOME?.trim() || join(homeDirectory, ".cache");
      const profileDirectory = join(cacheRoot, "pindie", "dev-browser", runtimeId);
      await makeDirectory(profileDirectory, { recursive: true });
      return profileDirectory;
    },
    async launch(config) {
      const executable = await resolveLinuxBrowserExecutable(
        config.chromeExecutable,
        env,
        checkAccess,
      );
      const child = spawnProcess(executable, [...buildBrowserLaunchArguments(config)], {
        stdio: "ignore",
        detached: true, // Dedicated session/process group; never signal the Host's group.
        env: env as NodeJS.ProcessEnv,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (child.pid === undefined) throw new Error("Chrome did not report its process ID.");
      const browser = Object.freeze({ pid: child.pid, process: child });
      let identity;
      try {
        identity = await stat(child.pid);
        if (!identity || identity.group !== child.pid || identity.session !== child.pid) {
          throw new Error("Could not establish dedicated Chrome process-group ownership.");
        }
      } catch (error) {
        // No confirmed group authority: retain the profile and block replacement.
        // Killing a direct child alone would not prove descendant termination.
        throw new UnconfirmedBrowserLaunchError(String(error));
      }
      owned.set(browser, { started: identity.started, stopped: false });
      return browser;
    },
    async stop(browser) {
      const ownership = owned.get(browser);
      if (!ownership) throw new Error("Refused to stop a browser not launched by this Host.");
      if (ownership.stopped) return;
      const alive = async () => {
        const leader = await stat(browser.pid);
        if (leader && leader.started !== ownership.started) throw new Error("Chrome process-group leader identity changed; cleanup refused.");
        // Kernel group absence is authoritative. A /proc enumeration alone
        // could miss a child forked while its parent was exiting. Even zombies
        // conservatively keep cleanup unconfirmed until the group is gone.
        try { signalProcess(-browser.pid, 0); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          ownership.stopped = true;
          return false;
        }
      };
      const send = async (signal: NodeJS.Signals) => {
        if (!await alive()) return;
        try { signalProcess(-browser.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      const wait = async (duration: number) => {
        const deadline = Date.now() + duration;
        do {
          if (!await alive()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        return !await alive();
      };
      await send("SIGTERM");
      if (await wait(stopGracePeriodMs)) return;
      await send("SIGKILL");
      if (!await wait(forceKillWaitMs)) throw new Error(`Chrome process group ${browser.pid} did not stop after SIGKILL.`);
    },
    async cleanupProfile(profileDirectory) {
      await removeDirectory(profileDirectory, { recursive: true, force: true });
    },
  };
}

export function createBrowserRealityHost(
  platform = detectBrowserRealityPlatform(),
): BrowserRealityHost {
  return platform === "wsl-windows"
    ? createWslWindowsBrowserRealityHost()
    : createLinuxBrowserRealityHost();
}
