import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveProjectRoot } from "../src/project.ts";

const execFileAsync = promisify(execFile);

async function createFixture(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pindie-project-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function initializeRepository(directory: string): Promise<void> {
  await execFileAsync("git", ["init", directory], { windowsHide: true });
}

test("P01 a non-Git directory resolves to its canonical cwd", async (t) => {
  const directory = await createFixture(t);

  assert.equal(await resolveProjectRoot(directory), await realpath(directory));
});

test("P02 a Git repository resolves to its canonical root", async (t) => {
  const repository = await createFixture(t);
  await initializeRepository(repository);

  assert.equal(await resolveProjectRoot(repository), await realpath(repository));
});

test("P03 nested directories in one Git repository share a project root", async (t) => {
  const repository = await createFixture(t);
  const nested = join(repository, "packages", "app", "src");
  await initializeRepository(repository);
  await mkdir(nested, { recursive: true });

  assert.equal(
    await resolveProjectRoot(nested),
    await resolveProjectRoot(repository),
  );
});

test("P04 separate Git repositories resolve to distinct project roots", async (t) => {
  const parent = await createFixture(t);
  const first = join(parent, "first");
  const second = join(parent, "second");
  await initializeRepository(first);
  await initializeRepository(second);

  assert.notEqual(
    await resolveProjectRoot(first),
    await resolveProjectRoot(second),
  );
});

test("P05 an aborted project-root resolution does not fall back to canonical cwd", async (t) => {
  const directory = await createFixture(t);
  const controller = new AbortController();
  const reason = new Error("root resolution cancelled");
  controller.abort(reason);

  await assert.rejects(
    resolveProjectRoot(directory, controller.signal),
    (error: unknown) => error === reason,
  );
});
