// Canvas definition tests. The SDK is unavailable under node:test, so
// `defineMissionControl` is exercised with a fake `createCanvas` and a fake
// `CanvasError`, plus fake deps for the CLI runner, server, and watcher. The
// store, snapshot, and diff deps are real, pointed at a temp COPILOT_HOME.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defineMissionControl, TITLE } from "./canvas.mjs";

class FakeCanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DASHBOARD = {
  session: {
    worktrees: [{ path: "/primary", isPrimary: true, repo: "product" }],
    worktree: { path: "/primary" },
    companion: { path: "/companion" },
    allowed: ["/agento delivery-status"],
  },
  deliveries: { items: [] },
  initiatives: { details: {} },
  metrics: { items: [] },
};

test("defineMissionControl returns a canvas with the four actions and schemas", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  const created = [];
  const createCanvas = (decl) => {
    created.push(decl);
    return { declaration: decl, open: decl.open, onClose: decl.onClose };
  };
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => DASHBOARD,
      startServer: async () => ({ url: "http://127.0.0.1:1/", setState() {}, broadcast() {}, close: async () => {} }),
      startWatcher: () => ({ stop() {} }),
      send: async () => {},
      log: async () => {},
      copilotHome: () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-")),
      cloneRoot: () => "/primary",
    },
  });

  const declaration = created[0];
  assert.equal(declaration.id, "agento-mission-control");
  assert.equal(declaration.displayName, "Agento Mission Control");
  assert.equal(declaration.description.length > 20, true);

  const names = declaration.actions.map((action) => action.name);
  assert.deepEqual(names, ["refresh", "get_snapshot", "focus", "post_note"]);
  for (const action of declaration.actions) {
    assert.equal(typeof action.handler, "function");
    assert.ok(action.inputSchema, `${action.name} has an input schema`);
  }
  assert.equal(declaration.actions[2].inputSchema.required.includes("kind"), true);
  assert.equal(declaration.actions[2].inputSchema.required.includes("id"), true);
  assert.equal(declaration.actions[3].inputSchema.required.includes("text"), true);
});

test("open is idempotent per instanceId and onClose stops server and watcher", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  let serverCount = 0;
  let watcherCount = 0;
  let closed = 0;
  let stopped = 0;
  let url = "http://127.0.0.1:9/";
  const createCanvas = (decl) => ({ declaration: decl, open: decl.open, onClose: decl.onClose });
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => DASHBOARD,
      startServer: async () => {
        serverCount += 1;
        return {
          url,
          setState() {},
          broadcast() {},
          close: async () => { closed += 1; },
        };
      },
      startWatcher: () => {
        watcherCount += 1;
        return { stop() { stopped += 1; } };
      },
      send: async () => {},
      log: async () => {},
      copilotHome: () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-")),
      cloneRoot: () => "/primary",
    },
  });

  const first = await canvas.open({ instanceId: "a", session: { workingDirectory: "/cwd" } });
  assert.equal(first.title, TITLE);
  assert.equal(first.url, url);
  assert.equal(serverCount, 1);
  assert.equal(watcherCount, 1);

  const second = await canvas.open({ instanceId: "a", session: { workingDirectory: "/cwd" } });
  assert.equal(second.status, "reopened");
  assert.equal(second.url, url);
  assert.equal(serverCount, 1, "server is reused on reopen");
  assert.equal(watcherCount, 1, "watcher is reused on reopen");

  await canvas.onClose({ instanceId: "a" });
  assert.equal(closed, 1);
  assert.equal(stopped, 1);
});

test("focus throws not-found for an unknown id and broadcasts a known one", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  const broadcasts = [];
  const createCanvas = (decl) => ({ declaration: decl, open: decl.open, onClose: decl.onClose });
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => DASHBOARD,
      startServer: async () => ({
        url: "http://127.0.0.1:1/",
        setState() {},
        broadcast: (type, data) => broadcasts.push({ type, data }),
        close: async () => {},
      }),
      startWatcher: () => ({ stop() {} }),
      send: async () => {},
      log: async () => {},
      copilotHome: () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-")),
      cloneRoot: () => "/primary",
    },
  });
  await canvas.open({ instanceId: "f", session: { workingDirectory: "/cwd" } });
  const focus = canvas.declaration.actions[2].handler;

  await assert.rejects(() => focus({ instanceId: "f", input: { kind: "delivery", id: "nope" } }), (err) => err instanceof FakeCanvasError && err.code === "not-found");
  const result = await focus({ instanceId: "f", input: { kind: "worktree", id: "/primary" } });
  assert.deepEqual(result, { ok: true, kind: "worktree", id: "/primary" });
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: "focus", data: { kind: "worktree", id: "/primary" } });
});

test("post_note rejects empty and oversized text and persists a valid note", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  const broadcasts = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-"));
  const createCanvas = (decl) => ({ declaration: decl, open: decl.open, onClose: decl.onClose });
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => DASHBOARD,
      startServer: async () => ({
        url: "http://127.0.0.1:1/",
        setState() {},
        broadcast: (type, data) => broadcasts.push({ type, data }),
        close: async () => {},
      }),
      startWatcher: () => ({ stop() {} }),
      send: async () => {},
      log: async () => {},
      copilotHome: () => home,
      cloneRoot: () => "/primary",
    },
  });
  await canvas.open({ instanceId: "n", session: { workingDirectory: "/cwd" } });
  const postNote = canvas.declaration.actions[3].handler;

  await assert.rejects(() => postNote({ instanceId: "n", input: { text: "   " } }), (err) => err instanceof FakeCanvasError && err.code === "invalid-note");
  await assert.rejects(() => postNote({ instanceId: "n", input: { text: "x".repeat(501) } }), (err) => err instanceof FakeCanvasError && err.code === "invalid-note");

  const result = await postNote({ instanceId: "n", input: { text: "hello", level: "success" } });
  assert.deepEqual(result, { ok: true });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, "note");
  assert.equal(broadcasts[0].data.text, "hello");
});

test("open maps a CLI runner failure to a cli CanvasError", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  const createCanvas = (decl) => ({ declaration: decl, open: decl.open, onClose: decl.onClose });
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => {
        const error = new Error("dashboard exited 1");
        error.code = "exit";
        throw error;
      },
      startServer: async () => ({ url: "http://127.0.0.1:1/", setState() {}, broadcast() {}, close: async () => {} }),
      startWatcher: () => ({ stop() {} }),
      send: async () => {},
      log: async () => {},
      copilotHome: () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-")),
      cloneRoot: () => "/primary",
    },
  });
  await assert.rejects(
    () => canvas.open({ instanceId: "c", session: { workingDirectory: "/cwd" } }),
    (err) => err instanceof FakeCanvasError && err.code === "cli"
  );
});

test("open maps a corrupt store to a storage CanvasError", async () => {
  const { normalize, diff } = await import("./snapshot.mjs");
  const createCanvas = (decl) => ({ declaration: decl, open: decl.open, onClose: decl.onClose });
  const canvas = defineMissionControl({
    createCanvas,
    CanvasError: FakeCanvasError,
    deps: {
      normalize,
      diff,
      runDashboard: async () => DASHBOARD,
      startServer: async () => ({ url: "http://127.0.0.1:1/", setState() {}, broadcast() {}, close: async () => {} }),
      startWatcher: () => ({ stop() {} }),
      send: async () => {},
      log: async () => {},
      copilotHome: () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-canvas-")),
      cloneRoot: () => "/primary",
      load: () => ({ ok: false, error: "corrupt", message: "corrupt JSON" }),
    },
  });
  await assert.rejects(
    () => canvas.open({ instanceId: "s", session: { workingDirectory: "/cwd" } }),
    (err) => err instanceof FakeCanvasError && err.code === "storage"
  );
});
