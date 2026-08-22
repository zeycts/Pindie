import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("GS01 bundled git-workflow Skill is exposed through Pi without replacing the extension", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { pi?: { extensions?: string[]; skills?: string[] } };

  assert.ok(manifest.pi?.extensions?.includes("./src/extension.ts"));
  assert.ok(manifest.pi?.skills?.includes("./skills"));
  assert.deepEqual(
    await readdir(new URL("../skills/", import.meta.url)),
    ["git-workflow"],
  );

  const skill = await readFile(
    new URL("../skills/git-workflow/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /^---\nname: git-workflow\ndescription: .+\n---/);
  assert.match(skill, /branch.*commit.*push.*pull-request/i);
  assert.match(skill, /code-changing.*reviewable (branch|pull request)/i);
});
