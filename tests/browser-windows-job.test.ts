import assert from "node:assert/strict";
import test from "node:test";
import { createWslWindowsBrowserRealityHost, UnconfirmedBrowserLaunchError } from "../src/browser-reality-host.ts";
import { windowsBrowserJobLaunch, windowsBrowserJobStop } from "../src/browser-windows-job.ts";

const config = { browserUrl: "http://127.0.0.1:9011", profileDirectory: "C:\\isolated profile's\\", headless: true };

test("Windows job launch suspends before assignment and resumes only after ownership", () => {
  const script = windowsBrowserJobLaunch("Local\\test", "C:\\Program Files\\chrome.exe", ["--user-data-dir=C:\\profile's\\", 'a"b']);
  const creation = script.indexOf("if (-not [PindieBrowserJob]::CreateProcess");
  const assignment = script.indexOf("if (-not [PindieBrowserJob]::AssignProcessToJobObject");
  const retained = script.indexOf("if (-not [PindieBrowserJob]::DuplicateHandle");
  const resume = script.indexOf("if ([PindieBrowserJob]::ResumeThread");
  assert.ok(creation < assignment && assignment < retained && retained < resume);
  assert.match(script, /\$info.process, \[ref\]\$browserJobHandle, 4, \$false, 0/u);
  assert.doesNotMatch(script, /CloseHandle\(\$browserJobHandle\)/u);
  assert.match(script.slice(creation, assignment), /\$false, 4, /u);
  assert.match(script, /createdError -eq 183/u);
  assert.match(script, /TerminateProcess\(\$info.process, 1\)/u);
  assert.match(script, /TerminateJobObject\(\$job, 1\)/u);
  assert.ok(script.includes("profile''s\\\\\"")); // PS literal + Win32 trailing slash quoting.
  assert.ok(script.includes('a\\"b'));
  assert.doesNotMatch(script, /Start-Process|Stop-Process|BREAKAWAY/u);
});

test("Windows job stop requires an open handle and zero active members; a missing name is never clean", () => {
  const script = windowsBrowserJobStop("Local\\owned");
  assert.match(script, /OpenJobObject\(12, \$false, 'Local\\owned'\)/u);
  assert.doesNotMatch(script, /GetLastWin32Error\(\) -eq 2/u);
  assert.match(script, /if \(\$job -eq \[IntPtr\]::Zero\) \{\s+throw/u);
  assert.match(script, /Active\(\$job\) -eq 0\) \{ Write-Output 'STOPPED:Local\\owned'; exit 0 \}/u);
  assert.match(script, /attempt -lt 30/u);
  assert.match(script, /throw 'Owned browser job still has active processes'/u);
  assert.doesNotMatch(script, /Stop-Process|Get-Process|taskkill/iu);
});

test("WSL stop accepts only exact Host launch handles and propagates unconfirmed job stop", async () => {
  const scripts: string[] = [];
  let failStop = false;
  const host = createWslWindowsBrowserRealityHost({ execute: async (script) => {
    scripts.push(script);
    if (failStop) throw new Error("job still active");
    const stopped = /'(?<ack>STOPPED:[^']+)'/u.exec(script)?.groups?.ack;
    return { stdout: stopped ? `${stopped}\r\n` : "PID:321\r\n" };
  } });
  const browser = await host.launch(config);
  await assert.rejects(host.stop({ pid: browser.pid }), /not launched by this Host/u);
  assert.equal(scripts.length, 1);
  const job = /'Local\\PindieDevBrowser-[a-f0-9-]+'/u.exec(scripts[0]!)?.[0];
  assert.ok(job);
  await host.stop(browser);
  assert.ok(scripts[1]!.includes(job));
  failStop = true;
  await assert.rejects(host.stop(browser), /job still active/u);
});

test("uncertain Windows interop launch best-effort stops its exact job but never claims confirmed ownership", async () => {
  const scripts: string[] = [];
  const host = createWslWindowsBrowserRealityHost({ execute: async (script) => {
    scripts.push(script);
    if (scripts.length === 1) throw new Error("interop timeout");
    return { stdout: "" };
  } });
  await assert.rejects(host.launch(config), UnconfirmedBrowserLaunchError);
  assert.equal(scripts.length, 2);
  const job = /'Local\\PindieDevBrowser-[a-f0-9-]+'/u.exec(scripts[0]!)?.[0];
  assert.ok(job && scripts[1]!.includes(job));
});
