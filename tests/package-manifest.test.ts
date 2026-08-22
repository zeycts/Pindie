import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("SI01 package exposes bundled Skills through Pi without replacing the extension", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { pi?: { extensions?: string[]; skills?: string[] } };

  assert.ok(manifest.pi?.extensions?.includes("./src/extension.ts"));
  assert.ok(manifest.pi?.skills?.includes("./skills"));
  assert.deepEqual(
    await readdir(new URL("../skills/", import.meta.url)),
    [".gitkeep"],
  );
});
