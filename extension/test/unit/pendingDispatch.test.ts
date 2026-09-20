import assert from "node:assert/strict";
import test from "node:test";

import {
  PENDING_DISPATCH_TTL_MS,
  pendingDispatchKey,
  savePendingDispatch,
  takePendingDispatch,
  type PendingDispatchStore,
} from "../../src/pendingDispatch.js";

class MemoryStore implements PendingDispatchStore {
  readonly values = new Map<string, unknown>();
  readonly operations: string[] = [];

  get<T>(key: string): T | undefined {
    this.operations.push(`get:${key}`);
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.operations.push(`update:${key}:${value === undefined ? "delete" : "write"}`);
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

const target = "/repo/worktree.code-workspace";
const now = 1_000_000;

test("saves by target and consumes once with deletion before returning", async () => {
  const store = new MemoryStore();
  await savePendingDispatch(store, { target, command: "/agento continue widget", createdAt: now });
  assert.equal(store.values.size, 1);

  assert.deepEqual(await takePendingDispatch(store, target, now + 1), { kind: "ready", command: "/agento continue widget" });
  assert.deepEqual(await takePendingDispatch(store, target, now + 2), { kind: "none" });
  assert.deepEqual(store.operations.slice(1, 3), [`get:${pendingDispatchKey(target)}`, `update:${pendingDispatchKey(target)}:delete`]);
});

test("separate activation and focus checks cannot consume the same record twice", async () => {
  const store = new MemoryStore();
  await savePendingDispatch(store, { target, command: "/agento continue widget", createdAt: now });
  const activation = await takePendingDispatch(store, target, now);
  const focus = await takePendingDispatch(store, target, now);
  assert.equal(activation.kind, "ready");
  assert.equal(focus.kind, "none");
});

test("discards expired, future-dated, malformed, and mismatched records", async () => {
  const cases: Array<[unknown, string]> = [
    [{ target, command: "/agento continue widget", createdAt: now - PENDING_DISPATCH_TTL_MS - 1 }, "expired"],
    [{ target, command: "/agento continue widget", createdAt: now + 1 }, "expired"],
    [{ target, command: "continue widget", createdAt: now }, "malformed"],
    [{ target: "/other", command: "/agento continue widget", createdAt: now }, "target-mismatch"],
    ["bad", "malformed"],
  ];
  for (const [value, reason] of cases) {
    const store = new MemoryStore();
    store.values.set(pendingDispatchKey(target), value);
    assert.deepEqual(await takePendingDispatch(store, target, now), { kind: "discarded", reason });
    assert.equal(store.values.size, 0);
  }
});

test("rejects invalid records before writing", async () => {
  const store = new MemoryStore();
  await assert.rejects(savePendingDispatch(store, { target: "", command: "/agento continue widget", createdAt: now }));
  await assert.rejects(savePendingDispatch(store, { target, command: "/continue widget", createdAt: now }));
  assert.equal(store.values.size, 0);
});