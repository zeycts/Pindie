import assert from "node:assert/strict";
import test from "node:test";
import { canReleaseBrowserIdle } from "../src/browser-idle-authority.ts";
import type { PindiePresentationSnapshot } from "../src/presentation-integration.ts";

function facts() {
  return {
    session: { sessionId: "session", isIdle: true, isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
    presentation: { status: { state: { task: null } }, quotaResumeWaiting: null } as unknown as PindiePresentationSnapshot,
    uiIdle: true,
    bashRunning: false,
  };
}

test("browser idle release needs settled Session, known UI, available State and no Human Gate or quota wait", () => {
  assert.equal(canReleaseBrowserIdle(facts()), true);
  for (const session of [
    { isIdle: false }, { isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 },
  ]) {
    const input = facts();
    Object.assign(input.session, session);
    assert.equal(canReleaseBrowserIdle(input), false);
  }
  assert.equal(canReleaseBrowserIdle({ ...facts(), uiIdle: false }), false);
  assert.equal(canReleaseBrowserIdle({ ...facts(), bashRunning: true }), false);
  assert.equal(canReleaseBrowserIdle({ ...facts(), presentation: null }), false);
  for (const presentation of [
    { status: { state: null }, quotaResumeWaiting: null },
    { status: { state: { task: { humanGate: { kind: "decision" } } } }, quotaResumeWaiting: null },
    { status: { state: { task: null } }, quotaResumeWaiting: { sessionId: "session" } },
  ]) {
    assert.equal(canReleaseBrowserIdle({ ...facts(), presentation: presentation as unknown as PindiePresentationSnapshot }), false);
  }
});
