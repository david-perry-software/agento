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
test("the queue directory, key, file name, and command rule match the CLI's pending-dispatch module", async () => {
  const { pendingDispatchDirectory, pendingDispatchKey: extensionKey } = await import("../../src/pendingDispatch.js");
  const { isCanonicalAgentoCommand: extensionCommand } = await import("../../src/commandActions.js");
  const { FilePendingDispatchStore } = await import("../../src/filePendingDispatchStore.js");
  const nodePath = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const cli = (await import(pathToFileURL(nodePath.resolve("cli/pending-dispatch.mjs")).href)) as {
    pendingDispatchDir(env: Record<string, string>, home: string): string;
    pendingDispatchKey(target: string): string;
    isCanonicalAgentoCommand(value: unknown): boolean;
    writePendingDispatch(dir: string, record: { target: string; command: string; createdAt: number }): string;
  };
  const envs: Record<string, string>[] = [{}, { XDG_CONFIG_HOME: "/cfg" }, { AGENTO_CONFIG_HOME: "/agento" }, { AGENTO_CONFIG_HOME: "/agento", XDG_CONFIG_HOME: "/cfg" }];
  for (const env of envs) {
    assert.equal(pendingDispatchDirectory(env, "/h"), cli.pendingDispatchDir(env, "/h"));
  }
  const target = "/home/u/DP/agento.code-workspace";
  assert.equal(extensionKey(target), cli.pendingDispatchKey(target));
  for (const command of ["/agento ship widget", "/agento start-session feature/x --resume", "/agento Ship x", "rm -rf /", "/agento a\nb"]) {
    assert.equal(extensionCommand(command), cli.isCanonicalAgentoCommand(command), command);
  }

  // A record the CLI writes is the one the extension's store takes.
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agento-parity-"));
  cli.writePendingDispatch(dir, { target, command: "/agento ship widget", createdAt: 1_000 });
  const store = new FilePendingDispatchStore(dir);
  assert.deepEqual(await takePendingDispatch(store, target, 2_000), { kind: "ready", command: "/agento ship widget" });
  assert.deepEqual(fs.readdirSync(dir), []);
});
