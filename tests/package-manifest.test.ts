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
  assert.match(skill, /When repository policy permits and reliable remote CI exists.*targeted local verification may be enough/s);
  assert.match(skill, /remote CI starts independently after push\/PR/i);
  assert.match(skill, /exhaust useful independent review work before starting a blocking CI wait\/watch/i);
  assert.match(skill, /only then query, watch, or wait for remaining CI/i);
  assert.match(skill, /pipeline overlap, not a background-worker system/i);
  assert.match(skill, /Merge only with user authority and required CI\/review evidence/i);
  assert.doesNotMatch(skill, /Pindie Core/i);
});

test("GS03 git-workflow cleanup remains an approved, fail-closed post-merge handoff", async () => {
  const skill = await readFile(
    new URL("../skills/git-workflow/SKILL.md", import.meta.url),
    "utf8",
  );
  const review = skill.indexOf("### 8. Review cycle");
  const cleanup = skill.indexOf("### 9. Post-merge / post-deployment cleanup");
  const safety = skill.indexOf("## Safety");
  assert.ok(review >= 0 && cleanup > review && safety > cleanup);
  const section = skill.slice(cleanup, safety);
  assert.match(section, /only after the PR actually merges.*deployment acceptance/s);
  assert.match(section, /Never clean up while the task still uses the worktree/);
  assert.match(section, /tool access is not blanket approval/);
  assert.match(section, /exact PR ↔ branch ↔ registered worktree path/);
  assert.match(section, /current main contains its changes.*squash merges/s);
  assert.match(section, /--untracked-files=all/);
  assert.match(section, /read-only check.*--ignored --untracked-files=all.*target worktree.*hidden directories\/files.*contents and ownership only within that worktree.*clean ordinary Git status does not establish ignored-file safety.*ownership or disposability is unclear, retain the worktree and report/s);
  assert.match(section, /unpublished distinct commits/);
  assert.match(section, /user-owned processes.*cwd\/open files.*known services/s);
  assert.match(section, /fail closed and report/);
  assert.match(section, /explicit cleanup authorization covering the exact target/);
  assert.match(section, /`git worktree remove <exact path>` without force/);
  assert.match(section, /directory and its worktree registration are removed/);
  assert.match(section, /`git branch -d <exact branch>`.*independently establishing it is safe/s);
  assert.match(section, /do not automatically use `-D`/);
  assert.match(section, /retain it and report the leftover/);
  assert.match(section, /No `rm -rf`, `git clean`, force worktree removal/);
  assert.match(section, /Record concise factual completion status/);
});

test("GS02 development-execution is a bundled procedural Pi Skill for efficient development", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { pi?: { skills?: string[] } };

  assert.ok(manifest.pi?.skills?.includes("./skills"));
  const entries = await readdir(new URL("../skills/", import.meta.url));
  assert.ok(entries.includes("development-execution"));
  const skill = await readFile(
    new URL("../skills/development-execution/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skill, /^---\nname: development-execution\ndescription: .+\n---/);
  assert.match(skill, /implementation, bug fixes, refactors, tests, code changes/i);
  assert.match(skill, /read-only observations are independent.*same model turn/s);
  assert.match(skill, /smallest relevant targeted verification/i);
  assert.match(skill, /contention or shared resources.*flaky/s);
  assert.match(skill, /remote CI starts independently after push\/PR/i);
  assert.match(skill, /first exhaust useful independent work.*final diff.*self-review.*regressions.*risk.*architecture.*PR description/s);
  assert.match(skill, /Do not start a blocking CI wait\/watch while such independent work remains/i);
  assert.match(skill, /Only after that work is exhausted should you query, watch, or wait for remaining CI/i);
  assert.match(skill, /pipeline overlap, not a background-worker system/i);
  assert.match(skill, /scheduler, second Agent Loop/i);
  assert.match(skill, /Task semantics, verification meaning, Human Gates, capability legality, or completion/i);
});
