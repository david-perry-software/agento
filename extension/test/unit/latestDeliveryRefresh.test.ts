import assert from "node:assert/strict";
import test from "node:test";

import { LatestDeliveryRefresh } from "../../src/latestDeliveryRefresh.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("older delivery refresh cannot overwrite a newer model", async () => {
  const refresh = new LatestDeliveryRefresh();
  const older = deferred<string>();
  const newer = deferred<string>();
  const applied: string[] = [];
  const errors: unknown[] = [];

  const olderRun = refresh.run(() => older.promise, (value) => applied.push(value), (error) => errors.push(error));
  const newerRun = refresh.run(() => newer.promise, (value) => applied.push(value), (error) => errors.push(error));
  newer.resolve("newer");
  assert.equal(await newerRun, true);
  older.resolve("older");
  assert.equal(await olderRun, false);

  assert.deepEqual(applied, ["newer"]);
  assert.deepEqual(errors, []);
});

test("older delivery refresh error cannot replace a newer model", async () => {
  const refresh = new LatestDeliveryRefresh();
  const older = deferred<string>();
  const newer = deferred<string>();
  const applied: string[] = [];
  const errors: unknown[] = [];

  const olderRun = refresh.run(() => older.promise, (value) => applied.push(value), (error) => errors.push(error));
  const newerRun = refresh.run(() => newer.promise, (value) => applied.push(value), (error) => errors.push(error));
  newer.resolve("newer");
  assert.equal(await newerRun, true);
  older.reject(new Error("stale"));
  assert.equal(await olderRun, false);

  assert.deepEqual(applied, ["newer"]);
  assert.deepEqual(errors, []);
});