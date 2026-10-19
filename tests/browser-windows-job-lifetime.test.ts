import assert from "node:assert/strict";
import test from "node:test";
import { createWslWindowsBrowserRealityHost } from "../src/browser-reality-host.ts";
import { createBrowserRealityRuntime, resolveBrowserRealityConfig } from "../src/browser-reality.ts";
import { createBrowserRealityManager } from "../src/browser-reality-manager.ts";
import { readBrowserToolCatalog } from "../src/browser-tool-catalog.ts";

/** Windows name lifetime model, not a PowerShell interpreter or native smoke.
 * Member references keep the object, but ONLY handles keep its name reopenable.
 * Exercise the actual Host -> runtime -> manager deletion boundary with an
 * executor that can even reproduce the old helper's incorrect exit-0/no-proof.
 * Generated-script tests separately bind DuplicateHandle/order/query semantics.
 */
function fixture(options: {
  ready?: boolean; stop?: "missing-ack" | "wrong-ack" | "active-members"; loseNameAtLaunchReturn?: boolean;
} = {}) {
  const handles = new Set<string>();
  const members = new Set<string>();
  const events: string[] = [];
  let job = "";
  let launches = 0;
  let cleanups = 0;
  let clock = 0;
  const windows = createWslWindowsBrowserRealityHost({ execute: async (script) => {
    if (script.includes("$job = [PindieBrowserJob]::CreateJobObject")) {
      job = /'(?<name>Local\\PindieDevBrowser-[a-f0-9-]+)'/u.exec(script)!.groups!.name!;
      launches++;
      handles.add("launch-helper");
      members.add("root");
      members.add("descendant");
      if (script.includes("if (-not [PindieBrowserJob]::DuplicateHandle(")) handles.add("browser-root");
      if (options.loseNameAtLaunchReturn) handles.delete("browser-root");
      handles.delete("launch-helper"); // Last HELPER handle closed: membership is not a handle.
      events.push("launch-helper-exit");
      return { stdout: "PID:321\r\n" };
    }
    assert.ok(script.includes("$job = [PindieBrowserJob]::OpenJobObject"));
    assert.ok(script.includes(`'${job}'`));
    if (handles.size === 0) {
      events.push("ERROR_FILE_NOT_FOUND");
      // Reproduce the prior faulty helper too: exit 0 with NO query/termination.
      // The Host must reject this independently of the script's new throw.
      return { stdout: "" };
    }
    handles.add("stop-helper");
    try {
      events.push("terminate-job");
      if (options.stop !== "active-members") {
        members.clear();
        handles.delete("browser-root");
      }
      events.push(`query-active:${members.size}`);
      if (members.size !== 0) throw new Error("Owned browser job still has active processes");
      return { stdout: options.stop === "missing-ack" ? "" : options.stop === "wrong-ack" ? "STOPPED:other-job\n" : `STOPPED:${job}\r\n` };
    } finally { handles.delete("stop-helper"); }
  } });
  const host = {
    ...windows,
    allocatePort: async () => 9011,
    allocateProfileDirectory: async () => "C:\\isolated-test-profile",
    cleanupProfile: async () => { cleanups++; events.push("profile-delete"); assert.equal(members.size, 0); },
  };
  const manager = createBrowserRealityManager(resolveBrowserRealityConfig({}), {
    canIdleRelease: () => false,
    createRuntime: (config) => createBrowserRealityRuntime(config, {
      host,
      probe: async () => options.ready !== false && members.size !== 0,
      now: () => { clock += options.ready === false ? 20_000 : 1; return clock; },
    }),
    createClient: () => ({
      listAllTools: async () => [...readBrowserToolCatalog().tools],
      callTool: async () => { events.push("dispatch"); return { content: [] }; },
      close: async () => { events.push("bridge-close"); },
    }),
  });
  return {
    manager, handles, members, events,
    get cleanups() { return cleanups; }, get launches() { return launches; },
  };
}

test("retained root Job handle keeps name after helper exit; confirmed termination covers every descendant before deletion", async () => {
  const f = fixture();
  await f.manager.callTool("list_pages", {});
  assert.deepEqual([...f.handles], ["browser-root"]);
  assert.equal(f.members.size, 2);
  // A Host process disappearing would not close the handle in the browser root.
  assert.equal(f.cleanups, 0); // No speculative or background stale-profile cleanup.
  await f.manager.release();
  assert.equal(f.members.size, 0);
  assert.equal(f.cleanups, 1);
  assert.deepEqual(f.events.slice(-4), ["bridge-close", "terminate-job", "query-active:0", "profile-delete"]);
  await f.manager.dispose();
});

test("regression: launch helper closes LAST handle, name vanishes but live Chrome never authorizes profile deletion", async () => {
  const f = fixture({ loseNameAtLaunchReturn: true });
  await f.manager.callTool("list_pages", {});
  assert.equal(f.handles.size, 0);
  assert.equal(f.members.size, 2); // The original blocker: object membership outlives its NAME.
  await assert.rejects(f.manager.release(), /termination is unconfirmed/);
  assert.ok(f.events.includes("ERROR_FILE_NOT_FOUND"));
  assert.equal(f.cleanups, 0);
  assert.equal(f.members.size, 2);
  await assert.rejects(f.manager.dispose(), /unconfirmed/);
  assert.equal(f.cleanups, 0);
});

for (const rootSurvives of [true, false]) {
  test(`last-handle/name loss with surviving Chrome forbids profile deletion (rootSurvives=${rootSurvives})`, async () => {
    const f = fixture();
    await f.manager.callTool("list_pages", {});
    f.handles.clear(); // Model last HANDLE loss, not last member reference.
    if (!rootSurvives) f.members.delete("root"); // Descendant remains in the unnamed Job.
    await assert.rejects(f.manager.release(), /termination is unconfirmed/);
    assert.ok(f.events.includes("ERROR_FILE_NOT_FOUND"));
    assert.ok(f.members.size > 0);
    assert.equal(f.cleanups, 0);
    assert.equal(f.manager.status().phase, "failed");
    await assert.rejects(f.manager.callTool("list_pages", {}), /unconfirmed/);
    assert.equal(f.launches, 1);
    await assert.rejects(f.manager.dispose(), /unconfirmed/);
    assert.equal(f.cleanups, 0);
  });
}

for (const stop of ["missing-ack", "wrong-ack", "active-members"] as const) {
  test(`Windows release requires exact zero-active confirmation (${stop})`, async () => {
    const f = fixture({ stop });
    await f.manager.callTool("list_pages", {});
    await assert.rejects(f.manager.release());
    assert.equal(f.cleanups, 0);
    await assert.rejects(f.manager.dispose());
    assert.equal(f.cleanups, 0);
  });
}

test("startup timeout with unconfirmed Windows termination retains profile and forbids replacement", async () => {
  const f = fixture({ ready: false, stop: "active-members" });
  await assert.rejects(f.manager.callTool("list_pages", {}), /could not be stopped/);
  assert.equal(f.launches, 1);
  assert.equal(f.cleanups, 0);
  assert.equal(f.events.includes("dispatch"), false);
  await assert.rejects(f.manager.callTool("list_pages", {}));
  await assert.rejects(f.manager.dispose());
  assert.equal(f.launches, 1);
  assert.equal(f.cleanups, 0);
});
