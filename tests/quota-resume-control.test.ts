import assert from "node:assert/strict";
import test from "node:test";
import {
  getQuotaResumePublisher,
  getQuotaResumeStatusObserver,
  installQuotaResumeReceiver,
  type QuotaResumeControlEvent,
  type QuotaResumeWaitingStatus,
} from "../src/quota-resume-control.ts";

const cancel = (sessionId: string): QuotaResumeControlEvent => ({ type: "cancel", sessionId });
const waiting = (sessionId = "one"): QuotaResumeWaitingStatus => ({ sessionId, resumeAt: 123 });

test("quota control has one lease, routes events, and release permits a later Host", () => {
  const events: QuotaResumeControlEvent[] = [];
  const lease = installQuotaResumeReceiver((event) => events.push(event));
  const publisher = getQuotaResumePublisher()!;
  publisher(cancel("one"));
  assert.deepEqual(events, [cancel("one")]);
  assert.throws(() => installQuotaResumeReceiver(() => undefined), /already owns/);
  lease.release();

  const later: QuotaResumeControlEvent[] = [];
  const laterLease = installQuotaResumeReceiver((event) => later.push(event));
  assert.throws(() => publisher(cancel("stale")), /no longer active/);
  getQuotaResumePublisher()!(cancel("two"));
  assert.deepEqual(later, [cancel("two")]);
  laterLease.release();
  assert.equal(getQuotaResumePublisher(), null);
});

test("Host waiting publication reaches its observer and null clears it", () => {
  const lease = installQuotaResumeReceiver(() => undefined);
  const observer = getQuotaResumeStatusObserver()!;
  const observed: Array<QuotaResumeWaitingStatus | null> = [];
  const unsubscribe = observer.subscribe((status) => observed.push(status));

  lease.publishWaitingStatus(waiting());
  assert.deepEqual(observer.getSnapshot(), waiting());
  lease.publishWaitingStatus(null);
  assert.equal(observer.getSnapshot(), null);
  assert.deepEqual(observed, [waiting(), null]);

  unsubscribe();
  lease.publishWaitingStatus(waiting("ignored"));
  assert.deepEqual(observed, [waiting(), null]);
  lease.release();
});

test("released observers fail closed, listeners clear, and cannot observe a later Host", () => {
  const first = installQuotaResumeReceiver(() => undefined);
  const staleObserver = getQuotaResumeStatusObserver()!;
  const observed: Array<QuotaResumeWaitingStatus | null> = [];
  staleObserver.subscribe((status) => observed.push(status));
  first.publishWaitingStatus(waiting("first"));
  first.release();

  const second = installQuotaResumeReceiver(() => undefined);
  second.publishWaitingStatus(waiting("second"));
  first.publishWaitingStatus(waiting("stale"));
  assert.equal(staleObserver.getSnapshot(), null);
  assert.deepEqual(observed, [waiting("first")]);
  second.release();
});

test("waiting listener exceptions are isolated from Host publication and other listeners", () => {
  const lease = installQuotaResumeReceiver(() => undefined);
  const observer = getQuotaResumeStatusObserver()!;
  const observed: Array<QuotaResumeWaitingStatus | null> = [];
  observer.subscribe(() => { throw new Error("listener failed"); });
  observer.subscribe((status) => observed.push(status));

  assert.doesNotThrow(() => lease.publishWaitingStatus(waiting()));
  assert.deepEqual(observed, [waiting()]);
  lease.release();
});
