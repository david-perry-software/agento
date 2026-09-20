import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FilePendingDispatchStore } from "../../src/filePendingDispatchStore.js";

test("shares pending records across store instances and deletes them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agento-pending-dispatch-"));
  try {
    const source = new FilePendingDispatchStore(directory);
    const target = new FilePendingDispatchStore(directory);
    const key = "agento.pendingDispatch:%2Frepo%2Ffeature.code-workspace";
    const value = { target: "/repo/feature.code-workspace", command: "/agento continue widget", createdAt: 1 };

    await source.update(key, value);
    assert.deepEqual(target.get(key), value);
    await target.update(key, undefined);
    assert.equal(source.get(key), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("surfaces malformed records written by another process for safe discard", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agento-pending-dispatch-"));
  try {
    const source = new FilePendingDispatchStore(directory);
    const target = new FilePendingDispatchStore(directory);

    await source.update("pending", { command: "/agento continue widget" });
    const [record] = await readdir(directory);
    assert.ok(record);
    await writeFile(path.join(directory, record), "not-json", "utf8");

    assert.equal(target.get("pending"), "malformed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});