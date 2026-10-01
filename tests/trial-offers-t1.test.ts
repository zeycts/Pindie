import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTrialOfferStore, validateTrialOfferCommit } from "../src/trial-offer-store.ts";
import { validateTrialAssignment } from "../src/learning-v1-contract.ts";
import { validateTrialAssignmentV2 } from "../src/trial-assignment-v2.ts";
import { legacyTrialFixture } from "./fixtures/trial-v1.ts";

test("Frozen v1 history remains exact readable bytes, never v2 authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "trial-v1-history-")), projectId = "a".repeat(64);
  try {
    const f = legacyTrialFixture(projectId, { schemaVersion: 1, family: "strategy-hypothesis", scope: { kind: "project", projectId }, id: "00000000-0000-4000-8000-000000000005", fingerprint: `sha256:${"a".repeat(64)}` });
    assert.ok(validateTrialAssignment(f.commit.assignment)); assert.ok(validateTrialOfferCommit(f.commit)); assert.equal(validateTrialAssignmentV2(f.commit.assignment), false);
    const dir = join(root, projectId, "learning-v1", "trial-offers"); await mkdir(dir, { recursive: true });
    const path = join(dir, `${f.commit.assignment.workEpisodeId}.json`), bytes = JSON.stringify(f.commit);
    await writeFile(path, bytes); await writeFile(join(dir, `${f.commit.assignment.workEpisodeId}.pending.json`), JSON.stringify(f.pending));
    assert.deepEqual(await new FileTrialOfferStore({ projectsBaseDir: root }).find(projectId, f.commit.assignment.workEpisodeId), f.commit);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(validateTrialOfferCommit({ ...f.commit, runtime: true }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
