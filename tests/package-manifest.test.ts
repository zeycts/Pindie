import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("GS01 bundled git-workflow Skill is exposed through Pi as procedure-only Git delivery", async () => {
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
  assert.match(skill, /Prefer `pindie_git_observe`.*read-only Git observation/i);
  assert.match(skill, /does not decide Pindie Task semantics/i);
  assert.match(skill, /Tool Surface and Gateway remain authoritative/i);
  assert.match(skill, /Do not merge it unless the current user request explicitly authorizes merging/i);
  assert.doesNotMatch(skill, /Pindie Core/i);
});
