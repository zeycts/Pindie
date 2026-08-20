import assert from "node:assert/strict";
import test from "node:test";

import { RunTimer, formatDuration, type RunTimerScheduler } from "../src/run-timer.ts";

class FakeScheduler implements RunTimerScheduler {
  private nextId = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];

  schedule(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  tick(): void {
    for (const callback of this.callbacks.values()) callback();
  }
}

test("formatDuration renders concise elapsed wall-clock durations", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(7_999), "7s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(63_000), "1m 03s");
  assert.equal(formatDuration(522_000), "8m 42s");
  assert.equal(formatDuration(4_320_000), "1h 12m");
});

test("RunTimer starts at zero, updates with the monotonic clock, and finalizes", () => {
  let now = 100;
  const scheduler = new FakeScheduler();
  const updates: Array<{ durationMs: number; active: boolean }> = [];
  const timer = new RunTimer({ now: () => now, scheduler });

  timer.start((timing) => updates.push(timing));
  assert.equal(timer.active, true);
  assert.equal(timer.durationMs, 0);
  assert.deepEqual(updates, [{ durationMs: 0, active: true }]);

  now = 1_100;
  scheduler.tick();
  assert.deepEqual(updates.at(-1), { durationMs: 1_000, active: true });

  now = 8_742;
  assert.equal(timer.finish(), 8_642);
  assert.equal(timer.active, false);
  assert.equal(timer.durationMs, 8_642);
  assert.deepEqual(updates.at(-1), { durationMs: 8_642, active: false });
  assert.deepEqual(scheduler.cancelled, [1]);
});

test("RunTimer clears its ticker and gives each consecutive Run a fresh start time", () => {
  let now = 0;
  const scheduler = new FakeScheduler();
  const timer = new RunTimer({ now: () => now, scheduler });

  timer.start(() => {});
  now = 5_000;
  timer.start(() => {});

  assert.equal(timer.durationMs, 0);
  assert.deepEqual(scheduler.cancelled, [1]);

  now = 7_000;
  assert.equal(timer.finish(), 2_000);
  assert.deepEqual(scheduler.cancelled, [1, 2]);

  timer.reset();
  assert.equal(timer.durationMs, null);
  assert.equal(timer.active, false);
});
