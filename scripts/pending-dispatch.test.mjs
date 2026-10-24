import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isCanonicalAgentoCommand, pendingDispatchDir, pendingDispatchFile, pendingDispatchKey, removePendingDispatch, writePendingDispatch } from "./pending-dispatch.mjs";
import { profilesFile } from "./model-profiles.mjs";

test("the queue lives beside model-profiles.json under every resolution", () => {
  for (const env of [{}, { XDG_CONFIG_HOME: "/cfg" }, { AGENTO_CONFIG_HOME: "/agento" }]) {
    assert.equal(pendingDispatchDir(env, "/h"), path.join(path.dirname(profilesFile(env, "/h")), "pending-dispatch"));
  }
  assert.equal(pendingDispatchDir({}, "/h"), "/h/.config/agento/pending-dispatch");
});

test("key and file name match the extension's FilePendingDispatchStore", () => {
  const target = "/home/u/DP/agento.code-workspace";
  assert.equal(pendingDispatchKey(target), `agento.pendingDispatch:${encodeURIComponent(target)}`);
  const digest = createHash("sha256").update(pendingDispatchKey(target)).digest("hex");
  assert.equal(pendingDispatchFile("/q", target), `/q/${digest}.json`);
});

test("writePendingDispatch writes one 0600 record per target and validates input", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-pending-")), "pending-dispatch");
  const target = "/home/u/DP/agento.code-workspace";
  const file = writePendingDispatch(dir, { target, command: "/agento ship widget", createdAt: 42 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { target, command: "/agento ship widget", createdAt: 42 });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  writePendingDispatch(dir, { target, command: "/agento continue widget", createdAt: 43 });
  assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], "a second handoff replaces the first; no temp files remain");
  removePendingDispatch(dir, target);
  assert.deepEqual(fs.readdirSync(dir), []);

  assert.throws(() => writePendingDispatch(dir, { target: "relative", command: "/agento ship widget" }), /absolute/);
  assert.throws(() => writePendingDispatch(dir, { target, command: "rm -rf /" }), /canonical/);
  assert.throws(() => writePendingDispatch(dir, { target, command: "/agento ship widget\n/agento ship other" }), /canonical/);
});

test("isCanonicalAgentoCommand matches the extension's rule", () => {
  assert.equal(isCanonicalAgentoCommand("/agento delivery-status"), true);
  assert.equal(isCanonicalAgentoCommand("/agento start-session feature/x --resume"), true);
  assert.equal(isCanonicalAgentoCommand("/agento Ship x"), false);
  assert.equal(isCanonicalAgentoCommand("/ship x"), false);
});
