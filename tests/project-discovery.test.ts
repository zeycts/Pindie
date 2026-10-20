import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPindieHost } from "../src/host.ts";
import { getProjectId, FileStateStore } from "../src/store.ts";
import { PindieRuntime } from "../src/runtime.ts";
import { legacyExperience } from "./legacy-learning-payload.ts";

// Retain both Host regressions; standalone Discovery executor cases are retired.
async function setup(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "retired-discovery-host-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const cwd = join(dir, "project"), agentDir = join(dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const projects = join(dir, "projects"), global = join(dir, "global");
  const runtime = new PindieRuntime(new FileStateStore({ baseDir: projects }));
  await runtime.load(cwd);
  await runtime.dispatch({ type: "start_task", goal: "goal", constraints: [], successCriteria: ["done"] });
  const experienceDir = join(projects, getProjectId(cwd), "experience");
  await mkdir(experienceDir, { recursive: true });
  for (let i = 0; i < 6; i++) {
    // Persist opaque legacy payloads without loading retired writers/assemblers.
    await writeFile(join(experienceDir, `${randomUUID()}.json`), JSON.stringify(legacyExperience(randomUUID(), i)));
  }
  return { cwd, agentDir, projects, global };
}

async function assertRetiredHost(t: import("node:test").TestContext, flag?: string) {
  const f = await setup(t);
  const experienceDir = join(f.projects, getProjectId(f.cwd), "experience");
  const before = await readdir(experienceDir);
  const bytes = await Promise.all(before.map((name) => readFile(join(experienceDir, name))));
  const host = await createPindieHost({
    cwd: f.cwd, agentDir: f.agentDir, sessionManager: SessionManager.inMemory(f.cwd),
    storageRoots: { projectsBaseDir: f.projects, globalBaseDir: f.global },
    env: { PINDIE_BROWSER_ENABLED: "false", ...(flag ? { PINDIE_AUTONOMOUS_LEARNING_ENABLED: flag } : {}) },
    dependencies: { createInteractiveMode: () => ({ run: async () => {} }) },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal("learningModelIdentity" in host, false);
    // Observe the filesystem, not a removed ledger API. Host may create Core
    // preferences, but no Learning namespace/job is allowed, even with old data.
    assert.equal((await readdir(f.global).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })).includes("learning-v1"), false);
    assert.deepEqual(await readdir(experienceDir), before);
    assert.deepEqual(await Promise.all(before.map((name) => readFile(join(experienceDir, name)))), bytes);
  } finally { await host.dispose(); }
}

test("Stable Mode Host does not enqueue discovery or start a learning runtime by default", async (t) => {
  await assertRetiredHost(t);
});

test("retired flags cannot add Learning model interfaces to the Host", async (t) => {
  await assertRetiredHost(t, "true");
});
