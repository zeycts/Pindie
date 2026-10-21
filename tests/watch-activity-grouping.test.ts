import assert from "node:assert/strict";
import test from "node:test";
import { groupWatchActivity, watchEventId, watchGroupId, watchGroupTitle, type WatchFeedItem } from "../src/watch-activity-grouping.ts";
import type { UiTimelineBlock, UiWorkBlock } from "../src/ui-projection.ts";

const work = (id: string): UiWorkBlock => ({ type: "work", kind: "command", id, toolCallId: id, toolName: "bash", lifecycle: "complete", title: `tool-${id}`, input: { command: "echo bounded" }, result: { isError: false, summary: "bounded", details: null, textContent: "bounded" }, defaultDisplayMode: "compact" });
const completion: UiTimelineBlock = { type: "semantic", id: "done", category: "completion", lifecycle: "complete", summary: "old result", verificationStatus: "passed", checks: [], error: null, defaultDisplayMode: "compact" };
const flatten = (feed: readonly WatchFeedItem[]) => feed.flatMap((item) => item.kind === "group" ? item.children.map((child) => child.block) : [item.block]);

test("pure grouping: all boundaries, exact chronological object fidelity and singles", () => {
  const boundaries: UiTimelineBlock[] = [
    { type: "message", id: "user", role: "user", source: "session", lifecycle: "complete", text: "human", defaultDisplayMode: "compact" },
    { type: "message", id: "assistant", role: "assistant", source: "session", lifecycle: "complete", text: "reply", defaultDisplayMode: "compact" },
    { type: "runtime", id: "runtime", category: "generic", title: "runtime", defaultDisplayMode: "compact" },
    completion,
    { type: "semantic", id: "task", category: "task", lifecycle: "complete", action: "start", goal: "goal", taskStatus: "active", blockers: [], questions: [], nextIntent: null, successCriterionCount: 1, handoff: null, error: null, defaultDisplayMode: "compact" },
    { ...completion, id: "gate", category: "human-gate", gateKind: "approval", question: "Review?", options: [], state: "open", error: null },
    { type: "semantic", id: "verify", category: "verification", lifecycle: "complete", verificationStatus: "passed", checks: [], coveredCriteria: [], totalCriteria: 1, pendingCheck: null, error: null, defaultDisplayMode: "compact" },
    { ...work("failed"), lifecycle: "failed" }, { ...work("running"), lifecycle: "running" },
    { ...work("inconsistent"), result: { isError: true, summary: "error", details: null } },
    { ...work("missing"), result: null },
    { type: "work", kind: "observation", id: "observation", title: "observed", lifecycle: "complete", defaultDisplayMode: "compact", items: [{ toolCallId: "read", toolName: "read", input: { path: "/x" }, label: "x", lifecycle: "failed", result: { isError: false, summary: "failure", details: null } }] },
  ];
  for (const boundary of boundaries) {
    const input = [work("a"), work("b"), boundary, work("c")];
    const before = JSON.stringify(input);
    const feed = groupWatchActivity(input);
    assert.deepEqual(feed.map((item) => item.kind), ["group", "event", "event"]);
    assert.equal(feed[1]!.kind === "event" && feed[1]!.block, boundary);
    flatten(feed).forEach((block, i) => assert.equal(block, input[i]));
    assert.equal(JSON.stringify(input), before);
  }
});

test("cap eight, bounded 50 tail, append stability, namespace collision resistance and factual types", () => {
  const input = Array.from({ length: 61 }, (_, i) => work(String(i)));
  const feed = groupWatchActivity(input);
  assert.equal(flatten(feed).length, 50);
  assert.deepEqual(flatten(feed), input.slice(-50));
  assert.ok(feed.every((item) => item.kind !== "group" || (item.children.length >= 2 && item.children.length <= 8)));
  const first = groupWatchActivity(input.slice(0, 3));
  const appended = groupWatchActivity(input.slice(0, 4));
  assert.equal(first[0]!.id, appended[0]!.id);
  const hostile = watchGroupId("a");
  assert.notEqual(watchEventId(hostile), watchGroupId("a"));
  const ids = feed.flatMap((item) => item.kind === "group" ? [item.id, ...item.children.map((child) => child.id)] : [item.id]);
  assert.equal(new Set(ids).size, ids.length);
  const group = first[0]!; assert.equal(group.kind, "group");
  if (group.kind === "group") assert.equal(watchGroupTitle(group), "3 tool operations · types bash");
});

test("successful observation items retain native source order and factual tool counts; running member breaks group", () => {
  const observation: UiWorkBlock = { type: "work", kind: "observation", id: "obs", title: "observed", lifecycle: "complete", defaultDisplayMode: "compact", items: ["read", "grep"].map((toolName) => ({ toolCallId: toolName, toolName, input: null, label: toolName, lifecycle: "complete", result: { isError: false, summary: "ok", details: null } })) };
  const input = [work("a"), observation, work("b")];
  const feed = groupWatchActivity(input); assert.equal(feed.length, 1);
  if (feed[0]!.kind === "group") assert.equal(watchGroupTitle(feed[0]!), "4 tool operations · types bash, read, grep");
  assert.deepEqual(flatten(feed), input);
  const running = { ...observation, items: observation.items.map((item, i) => i ? item : { ...item, lifecycle: "running" as const }) };
  assert.deepEqual(groupWatchActivity([work("a"), running, work("b")]).map((item) => item.kind), ["event", "event", "event"]);
});
