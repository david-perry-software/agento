import assert from "node:assert/strict";
import test from "node:test";

import { RefreshScheduler, type RefreshEvent, type TimerApi } from "../../src/refreshScheduler.js";

class FakeTimers implements TimerApi {
  delayMs: number | undefined;
  private callback: (() => void) | undefined;

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.callback = callback;
    this.delayMs = delayMs;
    return callback;
  }

  clearTimeout(handle: unknown): void {
    if (this.callback === handle) {
      this.callback = undefined;
    }
  }

  fire(): void {
    const callback = this.callback;
    this.callback = undefined;
    callback?.();
  }
}

test("RefreshScheduler coalesces scheduled reasons into one trailing event", () => {
  const timers = new FakeTimers();
  const scheduler = new RefreshScheduler(4000, timers);
  const events: RefreshEvent[] = [];
  scheduler.onDidRefresh((event) => events.push(event));

  scheduler.schedule("create roadmap");
  scheduler.schedule("change review");
  scheduler.schedule("change HEAD");

  assert.equal(timers.delayMs, 4000);
  assert.deepEqual(events, []);
  timers.fire();
  assert.deepEqual(events, [{ reasons: ["create roadmap", "change review", "change HEAD"] }]);
});

test("RefreshScheduler clamps its debounce to 3000 ms", () => {
  const timers = new FakeTimers();
  const scheduler = new RefreshScheduler(500, timers);

  scheduler.schedule("change");

  assert.equal(scheduler.debounceMs, 3000);
  assert.equal(timers.delayMs, 3000);
});

test("refreshNow cancels a pending timer and emits immediately", () => {
  const timers = new FakeTimers();
  const scheduler = new RefreshScheduler(3000, timers);
  const events: RefreshEvent[] = [];
  scheduler.onDidRefresh((event) => events.push(event));

  scheduler.schedule("change roadmap");
  scheduler.refreshNow("command");
  timers.fire();

  assert.deepEqual(events, [{ reasons: ["change roadmap", "command"] }]);
});

test("dispose prevents pending and future refreshes", () => {
  const timers = new FakeTimers();
  const scheduler = new RefreshScheduler(3000, timers);
  const events: RefreshEvent[] = [];
  scheduler.onDidRefresh((event) => events.push(event));

  scheduler.schedule("change");
  scheduler.dispose();
  timers.fire();
  scheduler.refreshNow("command");

  assert.deepEqual(events, []);
});