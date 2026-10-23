import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startWatcher } from "./watch.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agento-watch-"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("watch fires one debounced refresh for a burst of changes", async () => {
  const dir = tmpdir();
  const watched = path.join(dir, "features");
  fs.mkdirSync(watched);
  const calls = [];
  const watcher = startWatcher({ watchPaths: [watched], onChange: async (opts) => calls.push(opts), debounceMs: 40 });
  try {
    fs.writeFileSync(path.join(watched, "a.md"), "a");
    fs.writeFileSync(path.join(watched, "b.md"), "b");
    fs.writeFileSync(path.join(watched, "c.md"), "c");
    await sleep(200);
    assert.equal(calls.length, 1, "expected exactly one debounced refresh");
    assert.deepEqual(calls[0], { pr: false });
  } finally {
    watcher.stop();
  }
});

test("watch skips nonexistent paths and still works for existing ones", async () => {
  const dir = tmpdir();
  const watched = path.join(dir, "issues");
  fs.mkdirSync(watched);
  const calls = [];
  const watcher = startWatcher({ watchPaths: [path.join(dir, "missing"), watched], onChange: async () => calls.push(1), debounceMs: 40 });
  try {
    fs.writeFileSync(path.join(watched, "a.md"), "a");
    await sleep(200);
    assert.equal(calls.length, 1);
  } finally {
    watcher.stop();
  }
});

test("pr interval fires periodic --pr refreshes", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "features"));
  const calls = [];
  const watcher = startWatcher({ watchPaths: [path.join(dir, "features")], onChange: async (opts) => calls.push(opts), pr: true, prIntervalMs: 40 });
  try {
    await sleep(120);
    assert.ok(calls.length >= 2, "expected at least two interval refreshes");
    assert.ok(calls.every((c) => c.pr === true));
  } finally {
    watcher.stop();
  }
});

test("pr false does not schedule an interval", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "features"));
  const calls = [];
  const watcher = startWatcher({ watchPaths: [path.join(dir, "features")], onChange: async () => calls.push(1), pr: false, prIntervalMs: 40 });
  try {
    await sleep(120);
    assert.equal(calls.length, 0);
  } finally {
    watcher.stop();
  }
});

test("stop releases watchers and timers", async () => {
  const dir = tmpdir();
  const watched = path.join(dir, "features");
  fs.mkdirSync(watched);
  const calls = [];
  const watcher = startWatcher({ watchPaths: [watched], onChange: async () => calls.push(1), debounceMs: 40, pr: true, prIntervalMs: 40 });
  await sleep(60);
  const before = calls.length;
  watcher.stop();
  fs.writeFileSync(path.join(watched, "after.md"), "x");
  await sleep(120);
  assert.equal(calls.length, before, "onChange fired after stop()");
});

test("an in-flight refresh coalesces later triggers into one follow-up", async () => {
  const dir = tmpdir();
  const watched = path.join(dir, "features");
  fs.mkdirSync(watched);
  const calls = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const watcher = startWatcher({
    watchPaths: [watched],
    onChange: async () => {
      calls.push("start");
      await gate;
      calls.push("end");
    },
    debounceMs: 30,
  });
  try {
    fs.writeFileSync(path.join(watched, "a.md"), "a");
    await sleep(80); // first refresh is now in flight (blocked on gate)
    fs.writeFileSync(path.join(watched, "b.md"), "b");
    await sleep(80); // second trigger coalesces into `pending`
    release();
    await sleep(120);
    assert.ok(calls.filter((c) => c === "start").length >= 2, "expected a follow-up refresh after the in-flight one");
  } finally {
    release();
    watcher.stop();
  }
});
