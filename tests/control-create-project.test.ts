import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PindieControlWorkspace } from "../src/control-workspace.ts";
import type { PindieControlClient, PindieControlSnapshot } from "../src/control-client.ts";
import type { PindieHost } from "../src/host.ts";

const rejectCode = (code: string) => (error: { code: string }) => error.code === code;
const safe = (change: object = {}) => ({
  lease: "lease", runtime: { idle: true, automaticWorkSettled: true, pendingMessageCount: 0 },
  semantic: { humanGate: null }, recovery: { quotaWaiting: null }, ...change,
}) as PindieControlSnapshot;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pindie-create-"));
  let current = safe();
  let live = 0, created = 0, disposed = 0;
  let fail = false;
  let hostBarrier: Promise<void> | undefined;
  const events: string[] = [];
  const workspace = await PindieControlWorkspace.create({ workspaceRoot: root,
    createHost: async ({ cwd }) => {
      assert.equal(live++, 0, "Hosts must never overlap");
      created++;
      events.push(`create ${cwd}`);
      await hostBarrier;
      return { dispose: async () => { live--; disposed++; events.push(`dispose ${cwd}`); } } as PindieHost;
    },
    createClient: () => ({ start: async () => { if (fail) throw new Error("bootstrap failed"); },
      observe: () => current, dispose: () => {}, }) as PindieControlClient,
  });
  return { root, workspace, events, setSnapshot: (value: PindieControlSnapshot) => { current = value; },
    setFailure: (value: boolean) => { fail = value; },
    delayHost: (barrier: Promise<void>) => { hostBarrier = barrier; },
    counts: () => ({ live, created, disposed }),
    cleanup: async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); } };
}

test("create from no active project makes only an empty child, opens it and lists it", async () => {
  const f = await fixture();
  try {
    const opened = await f.workspace.createProject("New");
    assert.equal(opened.state, "active_project");
    assert.equal(opened.activeProject, "New");
    if (opened.state === "active_project") assert.equal(opened.control.lease, "lease");
    assert.deepEqual(await readdir(f.root), ["New"]);
    assert.deepEqual(await readdir(join(f.root, "New")), []);
    assert.deepEqual((await f.workspace.listProjects()).projects, [{ name: "New", active: true }]);
    assert.deepEqual(f.counts(), { live: 1, created: 1, disposed: 0 });
  } finally { await f.cleanup(); }
});

test("invalid names and existing directory/file/symlink never create or reuse entries", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "dir"));
    await writeFile(join(f.root, "file"), "preserve");
    await symlink(join(f.root, "missing"), join(f.root, "link"));
    for (const name of ["", ".", "..", "../escape", "/tmp/escape", "a/b", "a\\b", "a\0b"]) {
      await assert.rejects(f.workspace.createProject(name), rejectCode("invalid_project"));
    }
    for (const name of ["dir", "file", "link"]) {
      await assert.rejects(f.workspace.createProject(name), rejectCode("project_exists"));
    }
    assert.equal((await lstat(join(f.root, "link"))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(join(f.root, "dir")), []);
    assert.deepEqual((await readdir(f.root)).sort(), ["dir", "file", "link"]);
    assert.equal(f.counts().created, 0);
  } finally { await f.cleanup(); }
});

test("every unsafe active condition rejects before mkdir and leaves Host intact", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "A"));
    await f.workspace.openProject("A");
    for (const change of [
      { runtime: { idle: false, automaticWorkSettled: true, pendingMessageCount: 0 } },
      { runtime: { idle: true, automaticWorkSettled: false, pendingMessageCount: 0 } },
      { runtime: { idle: true, automaticWorkSettled: true, pendingMessageCount: 1 } },
      { semantic: { humanGate: { key: "gate" } } },
      { recovery: { quotaWaiting: { sessionId: "s", resumeAt: 1 } } },
    ]) {
      f.setSnapshot(safe(change));
      await assert.rejects(f.workspace.createProject("New"), rejectCode("project_switch_unsafe"));
      await assert.rejects(lstat(join(f.root, "New")), { code: "ENOENT" });
      assert.equal((await f.workspace.observe()).activeProject, "A");
      assert.deepEqual(f.counts(), { live: 1, created: 1, disposed: 0 });
    }
    f.setSnapshot(safe());
    assert.equal((await f.workspace.createProject("New")).activeProject, "New");
    assert.deepEqual(f.counts(), { live: 1, created: 2, disposed: 1 });
    assert.deepEqual(f.events.slice(1), [`dispose ${join(f.root, "A")}`, `create ${join(f.root, "New")}`]);
  } finally { await f.cleanup(); }
});

test("mkdir failure leaves safe Host active; bootstrap failure preserves new directory with no active Host and explicit open retries", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "A"));
    await f.workspace.openProject("A");
    // A directory cannot be created beneath a replaced workspace root; this fails before Host disposal.
    await rm(f.root, { recursive: true });
    await assert.rejects(f.workspace.createProject("New"), rejectCode("project_create_failed"));
    assert.deepEqual(f.counts(), { live: 1, created: 1, disposed: 0 });
    assert.equal((await f.workspace.observe()).activeProject, "A");
    await mkdir(f.root);
    f.setFailure(true);
    await assert.rejects(f.workspace.createProject("New"), rejectCode("project_open_failed"));
    assert.equal((await f.workspace.observe()).state, "no_active_project");
    assert.deepEqual(await readdir(join(f.root, "New")), []);
    assert.deepEqual(f.counts(), { live: 0, created: 2, disposed: 2 });
    f.setFailure(false);
    assert.equal((await f.workspace.openProject("New")).activeProject, "New");
  } finally { await f.cleanup(); }
});

test("concurrent create/open serialize bootstrap and share one live Host", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    f.delayHost(barrier);
    const creating = f.workspace.createProject("New");
    const opening = f.workspace.openProject("New");
    const observing = f.workspace.observe();
    // Wait until create reached bootstrap before allowing queued open to proceed.
    while (f.counts().created === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(await readdir(join(f.root, "New")), []);
    release();
    assert.equal((await creating).activeProject, "New");
    assert.equal((await opening).activeProject, "New");
    assert.equal((await observing).activeProject, "New");
    assert.deepEqual(f.counts(), { live: 1, created: 1, disposed: 0 });
  } finally { await f.cleanup(); }
});
