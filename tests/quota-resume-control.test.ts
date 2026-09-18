import assert from "node:assert/strict";
import test from "node:test";
import {
  getQuotaResumePublisher,
  installQuotaResumeReceiver,
  type QuotaResumeControlEvent,
} from "../src/quota-resume-control.ts";

const cancel = (sessionId: string): QuotaResumeControlEvent => ({ type: "cancel", sessionId });

test("quota control has one lease, routes events, and release permits a later Host", () => {
  const events: QuotaResumeControlEvent[] = [];
  const release = installQuotaResumeReceiver((event) => events.push(event));
  const publisher = getQuotaResumePublisher()!;
  publisher(cancel("one"));
  assert.deepEqual(events, [cancel("one")]);
  assert.throws(() => installQuotaResumeReceiver(() => undefined), /already owns/);
  release();

  const later: QuotaResumeControlEvent[] = [];
  const releaseLater = installQuotaResumeReceiver((event) => later.push(event));
  assert.throws(() => publisher(cancel("stale")), /no longer active/);
  getQuotaResumePublisher()!(cancel("two"));
  assert.deepEqual(later, [cancel("two")]);
  releaseLater();
  assert.equal(getQuotaResumePublisher(), null);
});
