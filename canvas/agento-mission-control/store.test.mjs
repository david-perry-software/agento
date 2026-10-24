import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FEED_CAP, NOTES_CAP, appendFeed, appendNote, copilotHome, emptyStore, load, repoKeyFor, save, storePath } from "./store.mjs";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agento-store-"));
}

test("copilotHome honors COPILOT_HOME and falls back to ~/.copilot", () => {
  assert.equal(copilotHome({ COPILOT_HOME: "/tmp/copilot" }), "/tmp/copilot");
  assert.equal(copilotHome({ COPILOT_HOME: "" }), path.join(os.homedir(), ".copilot"));
  assert.equal(copilotHome({}), path.join(os.homedir(), ".copilot"));
});

test("repoKeyFor is stable and distinguishes repos", () => {
  const a = repoKeyFor("/tmp/repo-a");
  const b = repoKeyFor("/tmp/repo-b");
  assert.equal(a, repoKeyFor("/tmp/repo-a"));
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("storePath nests under extension-data/agento-mission-control", () => {
  const home = tmpHome();
  assert.equal(storePath("key", { copilotHome: home }), path.join(home, "extension-data", "agento-mission-control", "key.json"));
});

test("load reports absent, then save/load round-trips with the format marker", () => {
  const home = tmpHome();
  const before = load("key", { copilotHome: home });
  assert.equal(before.ok, true);
  assert.equal(before.absent, true);
  assert.equal(before.store, null);

  const store = emptyStore();
  appendNote(store, { text: "hello", slug: "mission-control-canvas", level: "info" });
  const saved = save("key", store, { copilotHome: home });
  assert.equal(saved.ok, true);

  const after = load("key", { copilotHome: home });
  assert.equal(after.ok, true);
  assert.equal(after.store.format, "agento-mission-control");
  assert.equal(after.store.version, 1);
  assert.equal(after.store.notes.length, 1);
  assert.equal(after.store.notes[0].text, "hello");
});

test("writes are atomic and leave no temp files", () => {
  const home = tmpHome();
  save("key", emptyStore(), { copilotHome: home });
  const dir = path.dirname(storePath("key", { copilotHome: home }));
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("corrupt files are reported and never overwritten", () => {
  const home = tmpHome();
  const file = storePath("key", { copilotHome: home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");

  const read = load("key", { copilotHome: home });
  assert.equal(read.ok, false);
  assert.equal(read.error, "corrupt");

  const write = save("key", emptyStore(), { copilotHome: home });
  assert.equal(write.ok, false);
  assert.equal(write.error, "refusing-overwrite");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "corrupt file was overwritten");
});

test("unknown-version files are reported and never overwritten", () => {
  const home = tmpHome();
  const file = storePath("key", { copilotHome: home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ format: "agento-mission-control", version: 99, feed: [], notes: [], prefs: {} });
  fs.writeFileSync(file, original);

  const read = load("key", { copilotHome: home });
  assert.equal(read.ok, false);
  assert.equal(read.error, "unknown-version");

  const write = save("key", emptyStore(), { copilotHome: home });
  assert.equal(write.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), original, "unknown-version file was overwritten");
});

test("invalid shape is reported and refused", () => {
  const home = tmpHome();
  const file = storePath("key", { copilotHome: home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: "agento-mission-control", version: 1, feed: "nope", notes: [], prefs: {} }));

  const read = load("key", { copilotHome: home });
  assert.equal(read.ok, false);
  assert.equal(read.error, "invalid-shape");
  assert.equal(save("key", { feed: "nope", notes: [], prefs: {} }, { copilotHome: home }).ok, false);
});

test("feed history and notes are capped", () => {
  const home = tmpHome();
  const store = emptyStore();
  for (let i = 0; i < FEED_CAP + 25; i += 1) appendFeed(store, { type: "status-changed", slug: `f${i}` });
  for (let i = 0; i < NOTES_CAP + 25; i += 1) appendNote(store, { text: `n${i}` });
  assert.equal(store.feed.length, FEED_CAP);
  assert.equal(store.notes.length, NOTES_CAP);
  assert.equal(store.feed[0].slug, "f25", "oldest feed entries were not dropped");
  assert.equal(store.notes[0].text, "n25");
  const saved = save("key", store, { copilotHome: home });
  assert.equal(saved.ok, true);
  assert.equal(load("key", { copilotHome: home }).store.feed.length, FEED_CAP);
});

test("records are keyed by repoKey and do not collide", () => {
  const home = tmpHome();
  save("alpha", emptyStore(), { copilotHome: home });
  save("beta", emptyStore(), { copilotHome: home });
  assert.equal(load("alpha", { copilotHome: home }).store.notes.length, 0);
  assert.ok(fs.existsSync(storePath("alpha", { copilotHome: home })));
  assert.ok(fs.existsSync(storePath("beta", { copilotHome: home })));
});
