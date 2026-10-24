import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "./server.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agento-server-"));
}

function rawRequest({ port, method = "GET", path: requestPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function jsonRequest(port, method, path, { host, origin, contentType = "application/json", body } = {}) {
  const headers = {};
  if (host !== undefined) headers.host = host;
  if (origin !== undefined) headers.origin = origin;
  if (contentType) headers["content-type"] = contentType;
  return rawRequest({ port, method, path, headers, body });
}

test("GET /state returns the state set on the server", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    server.setState({ allowed: ["/agento delivery-status"], lanes: [] });
    const res = await rawRequest({ port: server.port, path: "/state" });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).allowed, ["/agento delivery-status"]);
  } finally {
    await server.close();
  }
});

test("GET /events streams an initial state and broadcast events", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const received = [];
    const done = new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: server.port, path: "/events" }, (res) => {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = frame.match(/^event: (\w+)/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event && data != null) received.push({ event, data: JSON.parse(data) });
            if (event === "note") resolve();
          }
        });
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    server.broadcast("note", { text: "hello" });
    await done;
    assert.equal(received[0].event, "state");
    assert.equal(received[0].data.allowed[0], "/agento delivery-status");
    assert.deepEqual(received[1], { event: "note", data: { text: "hello" } });
  } finally {
    await server.close();
  }
});

test("POST /dispatch calls send exactly once and returns 204", async () => {
  let calls = 0;
  const server = await startServer({ send: async (payload) => { calls += 1; assert.deepEqual(payload, { prompt: "/agento delivery-status" }); } });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const res = await jsonRequest(server.port, "POST", "/dispatch", {
      host: `127.0.0.1:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
      body: JSON.stringify({ command: "/agento delivery-status" }),
    });
    assert.equal(res.status, 204);
    assert.equal(calls, 1, "send called more than once");
  } finally {
    await server.close();
  }
});

test("dispatch rejects a wrong Host", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const res = await jsonRequest(server.port, "POST", "/dispatch", {
      host: "evil.example:1234",
      origin: `http://127.0.0.1:${server.port}`,
      body: JSON.stringify({ command: "/agento delivery-status" }),
    });
    assert.equal(res.status, 403);
    assert.ok(JSON.parse(res.body).errors.includes("host"));
  } finally {
    await server.close();
  }
});

test("dispatch rejects a foreign or missing Origin", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const foreign = await jsonRequest(server.port, "POST", "/dispatch", {
      host: `127.0.0.1:${server.port}`,
      origin: "https://evil.example",
      body: JSON.stringify({ command: "/agento delivery-status" }),
    });
    assert.equal(foreign.status, 403);
    assert.ok(JSON.parse(foreign.body).errors.includes("origin"));

    const missing = await rawRequest({
      port: server.port,
      method: "POST",
      path: "/dispatch",
      headers: { host: `127.0.0.1:${server.port}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "/agento delivery-status" }),
    });
    assert.equal(missing.status, 403);
    assert.ok(JSON.parse(missing.body).errors.includes("origin"));
  } finally {
    await server.close();
  }
});

test("dispatch rejects a non-JSON content type and a malformed body", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const wrongType = await jsonRequest(server.port, "POST", "/dispatch", {
      host: `127.0.0.1:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
      contentType: "text/plain",
      body: JSON.stringify({ command: "/agento delivery-status" }),
    });
    assert.equal(wrongType.status, 403);
    assert.ok(JSON.parse(wrongType.body).errors.includes("content-type"));

    const badJson = await jsonRequest(server.port, "POST", "/dispatch", {
      host: `127.0.0.1:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
      body: "{ not json",
    });
    assert.equal(badJson.status, 400);
    assert.ok(JSON.parse(badJson.body).errors.includes("json"));
  } finally {
    await server.close();
  }
});

test("dispatch rejects a command outside the live allowed union", async () => {
  let calls = 0;
  const server = await startServer({ send: async () => { calls += 1; } });
  try {
    server.setState({ allowed: ["/agento delivery-status"] });
    const res = await jsonRequest(server.port, "POST", "/dispatch", {
      host: `127.0.0.1:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
      body: JSON.stringify({ command: "/agento ship mission-control-canvas" }),
    });
    assert.equal(res.status, 403);
    assert.ok(JSON.parse(res.body).errors.includes("command"));
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test("OPTIONS is refused", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    const res = await rawRequest({ port: server.port, method: "OPTIONS", path: "/dispatch" });
    assert.equal(res.status, 405);
  } finally {
    await server.close();
  }
});

test("a malformed percent path is answered 400 and the server stays alive", async () => {
  const server = await startServer({ send: async () => {} });
  try {
    const bad = await rawRequest({ port: server.port, path: "/%" });
    assert.equal(bad.status, 400);
    const after = await rawRequest({ port: server.port, path: "/state" });
    assert.equal(after.status, 200, "server must keep serving after a malformed path");
  } finally {
    await server.close();
  }
});

test("a throwing handler is answered 500 and the server stays alive", async () => {
  const server = await startServer({
    send: async () => {},
    onExtra: async () => {
      throw new Error("boom");
    },
  });
  try {
    const res = await rawRequest({ port: server.port, method: "POST", path: "/boom" });
    assert.equal(res.status, 500);
    const after = await rawRequest({ port: server.port, path: "/state" });
    assert.equal(after.status, 200, "server must keep serving after a handler throw");
  } finally {
    await server.close();
  }
});

test("POST /refresh invokes the refresh callback", async () => {
  let refreshed = 0;
  const server = await startServer({ send: async () => {}, onRefresh: async () => { refreshed += 1; } });
  try {
    const res = await rawRequest({ port: server.port, method: "POST", path: "/refresh" });
    assert.equal(res.status, 200);
    assert.equal(refreshed, 1);
  } finally {
    await server.close();
  }
});

test("static files are served only from public/ with no traversal", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "public", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "index.html"), "<h1>hello</h1>");
  fs.writeFileSync(path.join(dir, "public", "app.js"), "console.log('app');");
  fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");
  const server = await startServer({ publicDir: path.join(dir, "public"), send: async () => {} });
  try {
    const index = await rawRequest({ port: server.port, path: "/" });
    assert.equal(index.status, 200);
    assert.match(index.body, /<h1>hello<\/h1>/);

    const app = await rawRequest({ port: server.port, path: "/app.js" });
    assert.equal(app.status, 200);
    assert.match(app.headers["content-type"], /javascript/);

    const traversal = await rawRequest({ port: server.port, path: "/%2e%2e%2fsecret.txt" });
    assert.equal(traversal.status, 403);
    assert.ok(!traversal.body.includes("do not serve"));
  } finally {
    await server.close();
  }
});

// A freehand window whose board shows one delivery owned by a build worktree, with
// the primary checkout in the worktree map: its commands are handoff targets.
const HANDOFF_STATE = {
  allowed: [],
  session: { role: "freehand", worktree: { path: "/wt/freehand-1" }, allowed: [], elsewhere: [] },
  worktrees: { entries: [{ path: "/repo", isPrimary: true, repo: "product" }] },
  cards: [{
    slug: "widget",
    lane: "building",
    owner: { path: "/wt/feature-widget", role: "build" },
    allowed: ["/agento build-feature widget"],
    elsewhere: [{ command: "/agento ship widget", window: "primary", reason: "after approve" }],
  }],
  initiatives: [],
};

test("POST /handoff passes the server-derived checkout and the command to handoff()", async () => {
  const calls = [];
  const server = await startServer({ handoff: async (args) => (calls.push(args), { status: "ok", wasOpen: true, opened: true }) });
  try {
    server.setState(HANDOFF_STATE);
    const origin = `http://127.0.0.1:${server.port}`;
    const res = await jsonRequest(server.port, "POST", "/handoff", { origin, body: JSON.stringify({ command: "/agento ship widget", checkout: "/etc" }) });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body), { ok: true, command: "/agento ship widget", windowName: "the primary window", wasOpen: true, opened: true });
    assert.deepEqual(calls, [{ checkout: "/repo", command: "/agento ship widget" }], "a checkout in the request body is ignored");

    await jsonRequest(server.port, "POST", "/handoff", { origin, body: JSON.stringify({ command: "/agento build-feature widget" }) });
    assert.deepEqual(calls[1], { checkout: "/wt/feature-widget", command: "/agento build-feature widget" });
  } finally {
    await server.close();
  }
});

test("POST /handoff applies the dispatch request checks and refuses commands that are not handoff targets", async () => {
  const calls = [];
  const server = await startServer({ handoff: async (args) => (calls.push(args), { status: "ok" }) });
  try {
    server.setState(HANDOFF_STATE);
    const origin = `http://127.0.0.1:${server.port}`;
    const body = JSON.stringify({ command: "/agento ship widget" });
    assert.equal((await jsonRequest(server.port, "POST", "/handoff", { origin: "http://evil.example", body })).status, 403);
    assert.equal((await jsonRequest(server.port, "POST", "/handoff", { origin, host: "evil.example", body })).status, 403);
    assert.equal((await jsonRequest(server.port, "POST", "/handoff", { origin, contentType: "text/plain", body })).status, 403);
    assert.equal((await jsonRequest(server.port, "POST", "/handoff", { origin, body: "{" })).status, 400);
    const foreign = await jsonRequest(server.port, "POST", "/handoff", { origin, body: JSON.stringify({ command: "/agento close-session feature/widget" }) });
    assert.equal(foreign.status, 403);
    assert.deepEqual(JSON.parse(foreign.body).errors, ["command"]);
    assert.deepEqual(calls, []);
  } finally {
    await server.close();
  }
});

test("POST /handoff reports a CLI refusal as 502 with its reason", async () => {
  const server = await startServer({ handoff: async () => ({ status: "failed", reason: "code CLI not found on PATH" }) });
  try {
    server.setState(HANDOFF_STATE);
    const res = await jsonRequest(server.port, "POST", "/handoff", { origin: `http://127.0.0.1:${server.port}`, body: JSON.stringify({ command: "/agento ship widget" }) });
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(res.body).error, "code CLI not found on PATH");
  } finally {
    await server.close();
  }
});

test("GET /windows asks only about handoff target checkouts and keys the answer by checkout", async () => {
  const asked = [];
  const server = await startServer({
    windows: async (checkouts) => {
      asked.push(checkouts);
      return checkouts.map((checkout) => ({ checkout, open: checkout === "/repo", target: `${checkout}.code-workspace` }));
    },
  });
  try {
    server.setState(HANDOFF_STATE);
    const res = await rawRequest({ port: server.port, path: "/windows" });
    assert.equal(res.status, 200);
    assert.deepEqual(asked, [["/wt/feature-widget", "/repo"]]);
    assert.deepEqual(JSON.parse(res.body).windows, {
      "/wt/feature-widget": { open: false, target: "/wt/feature-widget.code-workspace" },
      "/repo": { open: true, target: "/repo.code-workspace" },
    });
    const rebound = await rawRequest({ port: server.port, path: "/windows", headers: { host: "evil.example" } });
    assert.equal(rebound.status, 403);
  } finally {
    await server.close();
  }
});

test("GET /artifacts serves only slugs on the board, with the type from state and no file paths", async () => {
  const calls = [];
  const server = await startServer({
    artifacts: async (args) => {
      calls.push(args);
      return { status: "ok", source: "worktree", base: "/secret/base", files: { plan: { exists: true, path: "/secret/plan.md", content: "# Plan" }, roadmap: { exists: true, content: "r" }, review: { exists: false } } };
    },
  });
  try {
    server.setState({ ...HANDOFF_STATE, cards: [...HANDOFF_STATE.cards, { slug: "bug", type: "issue", lane: "shipped" }] });
    const res = await rawRequest({ port: server.port, path: "/artifacts?slug=bug" });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(calls, [{ type: "issue", slug: "bug" }]);
    assert.deepEqual(body, { ok: true, slug: "bug", source: "worktree", ref: null, files: { plan: { exists: true, content: "# Plan" }, roadmap: { exists: true, content: "r" }, review: { exists: false } } });
    assert.doesNotMatch(res.body, /secret/);

    assert.equal((await rawRequest({ port: server.port, path: "/artifacts?slug=../../etc/passwd" })).status, 404);
    assert.equal((await rawRequest({ port: server.port, path: "/artifacts" })).status, 404);
    assert.equal((await rawRequest({ port: server.port, path: "/artifacts?slug=bug", headers: { host: "evil.example" } })).status, 403);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

test("GET /artifacts reports a missing delivery's message", async () => {
  const server = await startServer({ artifacts: async () => ({ status: "missing", message: "No roadmap for feature/widget", files: {} }) });
  try {
    server.setState(HANDOFF_STATE);
    const body = JSON.parse((await rawRequest({ port: server.port, path: "/artifacts?slug=widget" })).body);
    assert.equal(body.ok, false);
    assert.equal(body.message, "No roadmap for feature/widget");
    assert.deepEqual(body.files.plan, { exists: false });
  } finally {
    await server.close();
  }
});
