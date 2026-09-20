import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
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

function windowsLaunchArguments(config: BrowserRealityHostConfig): readonly string[] {
  return buildBrowserLaunchArguments(config)
    .filter((argument) => argument !== "--remote-debugging-address=127.0.0.1")
    .map((argument) =>
      argument.startsWith("--user-data-dir=")
        ? `--user-data-dir=\"${config.profileDirectory}\"`
        : argument
    );
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

export function createWslWindowsBrowserRealityHost(): BrowserRealityHost {
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
      const argumentsScript = windowsLaunchArguments(config)
        .map((argument) => `  ${powershellLiteral(argument)}`)
        .join(",\n");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$arguments = @(", argumentsScript, ")",
        `$process = Start-Process -FilePath ${powershellLiteral(config.chromeExecutable ?? DEFAULT_WINDOWS_CHROME)} -ArgumentList $arguments -PassThru`,
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
        "Write-Output \"PID:$($process.Id)\"",
      ].join("\n");
      const result = await execFile(DEFAULT_POWERSHELL, [
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], {
        cwd: POWERSHELL_CWD,
        env: process.env,
        timeout: 10_000,
        windowsHide: true,
      });
      const match = /(?:^|\n)PID:(\d+)(?:\r?\n|$)/u.exec(result.stdout);
      if (!match) throw new Error("Windows Chrome did not report its process ID.");
      return { pid: Number(match[1]) };
    },
    async stop(browser) {
      const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `Stop-Process -Id ${browser.pid}`,
      ].join("\n");
      await execFile(DEFAULT_POWERSHELL, [
        "-NoProfile", "-NonInteractive", "-Command", script,
      ], { cwd: POWERSHELL_CWD, timeout: 10_000, windowsHide: true });
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
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (child.pid === undefined) throw new Error("Chrome did not report its process ID.");
      return { pid: child.pid, process: child };
    },
    async stop(browser) {
      const child = browser.process;
      if (!child) {
        try {
          process.kill(browser.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) return;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let forceTimer: NodeJS.Timeout | undefined;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          if (forceTimer) clearTimeout(forceTimer);
          child.off("exit", exited);
          child.off("close", exited);
          if (error) reject(error);
          else resolve();
        };
        const exited = () => finish();
        const send = (signal: NodeJS.Signals): boolean => {
          try {
            return child.kill(signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
            finish(error);
            return false;
          }
        };
        const graceTimer = setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            finish();
            return;
          }
          if (!send("SIGKILL")) {
            finish();
            return;
          }
          forceTimer = setTimeout(() => finish(
            new Error(`Chrome process ${browser.pid} did not exit after SIGKILL.`),
          ), forceKillWaitMs);
        }, stopGracePeriodMs);
        child.once("exit", exited);
        child.once("close", exited);
        if (!send("SIGTERM")) finish();
      });
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
