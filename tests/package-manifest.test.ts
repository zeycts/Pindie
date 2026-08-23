import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("GS01 bundled git-workflow Skill is exposed through Pi without replacing the extension", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { pi?: { extensions?: string[]; skills?: string[] } };

  assert.ok(manifest.pi?.extensions?.includes("./src/extension.ts"));
  assert.ok(manifest.pi?.skills?.includes("./skills"));
  const entries = await readdir(new URL("../skills/", import.meta.url));
  assert.ok(entries.includes("git-workflow"));
  assert.equal(
    entries.some((entry) => entry.toLowerCase().endsWith(".md")),
    false,
  );

  const skill = await readFile(
    new URL("../skills/git-workflow/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /^---\nname: git-workflow\ndescription: .+\n---/);
  assert.match(skill, /branch.*commit.*push.*pull-request/i);
  assert.match(skill, /code-changing.*reviewable (branch|pull request)/i);
  assert.match(skill, /Pindie Core owns Task establishment and reconciliation/i);
  assert.match(skill, /does not require Git inspection before Pindie Task establishment\/reconciliation/i);
});
