import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PindieControlError, type PindieControlClient, type PindieControlSnapshot } from "../src/control-client.ts";
import { PindieControlWorkspace } from "../src/control-workspace.ts";
import type { PindieHost } from "../src/host.ts";

const snapshot = (lease: string, changes: Record<string, unknown> = {}) => ({
  lease, runtime: { idle: true, automaticWorkSettled: true, pendingMessageCount: 0 },
  semantic: { humanGate: null }, recovery: { quotaWaiting: null }, ...changes,
}) as PindieControlSnapshot;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pindie-workspace-switch-"));
  await mkdir(join(root, "A")); await mkdir(join(root, "B"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("switch safety checks all five conditions without disposing A; active Task is irrelevant", async () => {
  const { root, cleanup } = await setup();
  let current = snapshot("A");
  let disposed = 0;
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => { disposed++; } }) as PindieHost,
    createClient: () => ({ start: async () => {}, dispose: () => {}, observe: () => current }) as PindieControlClient,
  });
  try {
    await workspace.openProject("A");
    for (const change of [
      { runtime: { idle: false, automaticWorkSettled: true, pendingMessageCount: 0 } },
      { runtime: { idle: true, automaticWorkSettled: false, pendingMessageCount: 0 } },
      { runtime: { idle: true, automaticWorkSettled: true, pendingMessageCount: 1 } },
      { semantic: { humanGate: { key: "gate" } } },
      { recovery: { quotaWaiting: { sessionId: "a", resumeAt: 1 } } },
    ]) {
      current = snapshot("A", change);
      await assert.rejects(workspace.openProject("B"), (error: { code: string }) => error.code === "project_switch_unsafe");
      assert.equal(disposed, 0);
      assert.equal((await workspace.observe()).activeProject, "A");
    }
    current = snapshot("A", { semantic: { humanGate: null, taskStatus: "active" } });
    assert.equal((await workspace.openProject("B")).activeProject, "B");
    assert.equal(disposed, 1);
  } finally { await workspace.close(); await cleanup(); }
});

test("replacement disposes old client/Host once, stales lease, and never overlaps; same project idempotent", async () => {
  const { root, cleanup } = await setup();
  const events: string[] = [];
  let live = 0, created = 0;
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async (options) => {
      assert.equal(live++, 0);
      const name = options.cwd!.split("/").at(-1)!;
      created++; events.push(`create ${name}`);
      return { dispose: async () => { events.push(`host dispose ${name}`); live--; } } as PindieHost;
    },
    createClient: (host) => {
      const name = created === 1 ? "A" : "B";
      let disposed = false;
      return ({ start: async () => { events.push(`start ${name}`); },
        observe: () => { if (disposed) throw new Error("disposed"); return snapshot(name); },
        dispose: () => { events.push(`client dispose ${name}`); disposed = true; },
        input: ({ lease }: { lease: string }) => {
          if (lease !== name) throw new PindieControlError("stale_control_lease", "Stale", snapshot(name));
        },
      }) as PindieControlClient;
    },
  });
  try {
    assert.equal((await workspace.openProject("A")).activeProject, "A");
    await workspace.openProject("A");
    assert.equal(created, 1);
    const [first, second] = await Promise.all([workspace.openProject("B"), workspace.openProject("B")]);
    assert.equal(first.activeProject, "B"); assert.equal(second.activeProject, "B");
    assert.equal(created, 2);
    await assert.rejects(workspace.withClient((client) => client.input({ lease: "A", text: "old" })),
      (error: { code: string }) => error.code === "stale_control_lease");
    assert.deepEqual(events, ["create A", "start A", "client dispose A", "host dispose A", "create B", "start B"]);
  } finally { await workspace.close(); await cleanup(); }
  assert.equal(live, 0);
});

test("detached wait does not hold Workspace serialization during project replacement", async () => {
  const { root, cleanup } = await setup();
  let waitStarted!: () => void;
  const started = new Promise<void>((resolve) => { waitStarted = resolve; });
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => ({ dispose: async () => {} }) as PindieHost,
    createClient: () => {
      let finish!: (value: { reason: string; snapshot: PindieControlSnapshot }) => void;
      const pending = new Promise<{ reason: string; snapshot: PindieControlSnapshot }>((resolve) => { finish = resolve; });
      return ({ start: async () => {}, observe: () => snapshot("live"),
        wait: () => { waitStarted(); return pending; },
        dispose: () => finish({ reason: "binding_changed", snapshot: snapshot("live") }),
      }) as unknown as PindieControlClient;
    },
  });
  try {
    await workspace.openProject("A");
    const waiting = workspace.wait({ lease: "live", until: "settled" });
    await started;
    let switched = false;
    const replacement = await Promise.race([
      workspace.openProject("B").then((result) => { switched = true; return result; }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("project replacement blocked by wait")), 500)),
    ]);
    assert.equal(switched, true);
    assert.equal(replacement.activeProject, "B");
    assert.equal((await waiting).reason, "binding_changed");
  } finally { await workspace.close(); await cleanup(); }
});

test("bootstrap failure is structured, cleans up and leaves no active slot; concurrent opens serialize", async () => {
  const { root, cleanup } = await setup();
  let live = 0, disposed = 0, clientDisposed = 0, fail = true;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async () => {
      assert.equal(live++, 0);
      return { dispose: async () => { live--; disposed++; } } as PindieHost;
    },
    createClient: () => ({ start: async () => { await barrier; if (fail) throw new Error("session_start failed"); },
      dispose: () => { clientDisposed++; }, observe: () => snapshot("live"),
    }) as PindieControlClient,
  });
  try {
    const opening = workspace.openProject("A");
    const observing = workspace.observe();
    release();
    await assert.rejects(opening, (error: { code: string; message: string }) => error.code === "project_open_failed" && error.message.includes("session_start failed"));
    assert.equal((await observing).state, "no_active_project");
    assert.deepEqual([live, disposed, clientDisposed], [0, 1, 1]);
    fail = false;
    await workspace.openProject("A");
    fail = true;
    await assert.rejects(workspace.openProject("B"), (error: { code: string }) => error.code === "project_open_failed");
    assert.equal((await workspace.observe()).state, "no_active_project");
    assert.deepEqual([live, disposed, clientDisposed], [0, 3, 3]);
  } finally { await workspace.close(); await cleanup(); }
});
