import type { UiTimelineBlock, UiWorkBlock } from "./ui-projection.ts";

/** Both namespaces are encoded: even a hostile event ID cannot alias a group. */
declare const watchIdKind: unique symbol;
export type WatchEventId = string & { readonly [watchIdKind]: "event" };
export type WatchGroupId = string & { readonly [watchIdKind]: "group" };
export type WatchFeedId = WatchEventId | WatchGroupId;
export const watchEventId = (id: string): WatchEventId => JSON.stringify(["watch-event", id]) as WatchEventId;
export const watchGroupId = (id: string): WatchGroupId => JSON.stringify(["watch-group", id]) as WatchGroupId;
export interface WatchEventItem { readonly kind: "event"; readonly id: WatchEventId; readonly block: UiTimelineBlock }
export interface WatchActivityGroup { readonly kind: "group"; readonly id: WatchGroupId; readonly children: readonly WatchEventItem[] }
export type WatchFeedItem = WatchEventItem | WatchActivityGroup;

export function watchWorkFailed(block: UiWorkBlock): boolean {
  return block.lifecycle === "failed" || (block.kind === "observation"
    ? block.items.some((item) => item.lifecycle === "failed" || item.result?.isError === true)
    : block.result?.isError === true);
}
export function watchBlockFailed(block: UiTimelineBlock): boolean {
  if (block.type === "work") return watchWorkFailed(block);
  if (block.type === "message") return block.lifecycle === "error";
  return block.type === "semantic" && (block.lifecycle === "failed" || block.error !== null ||
    ((block.category === "verification" || block.category === "completion") &&
      (block.verificationStatus === "failed" || block.checks.some((check) => check.status === "failed"))));
}
function eligible(block: UiTimelineBlock): boolean {
  // Running stays explicit; incomplete results and inconsistent observations are boundaries.
  return block.type === "work" && block.lifecycle === "complete" && !watchWorkFailed(block) &&
    (block.kind === "observation" ? block.items.length > 0 && block.items.every((item) => item.lifecycle === "complete" && item.result?.isError === false)
      : block.result?.isError === false);
}

/** Pure bounded projection. Child blocks are the originals, never synthesized/mutated. */
export function groupWatchActivity(blocks: readonly UiTimelineBlock[]): WatchFeedItem[] {
  const feed: WatchFeedItem[] = [];
  let pending: WatchEventItem[] = [];
  const flush = () => {
    if (pending.length > 1) feed.push({ kind: "group", id: watchGroupId(pending[0]!.block.id), children: pending });
    else feed.push(...pending);
    pending = [];
  };
  for (const block of blocks.slice(-50)) {
    const event: WatchEventItem = { kind: "event", id: watchEventId(block.id), block };
    if (eligible(block)) {
      pending.push(event);
      if (pending.length === 8) flush();
    } else { flush(); feed.push(event); }
  }
  flush();
  return feed;
}

export function watchGroupTitle(group: WatchActivityGroup): string {
  const types = new Set<string>();
  for (const { block } of group.children) if (block.type === "work") {
    if (block.kind === "observation") for (const item of block.items) types.add(item.toolName);
    else types.add(block.toolName);
  }
  const count = group.children.reduce((total, { block }) => total + (block.type === "work" && block.kind === "observation" ? block.items.length : 1), 0);
  return `${count} tool operations · types ${[...types].join(", ")}`;
}
