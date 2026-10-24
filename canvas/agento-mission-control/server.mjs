// The Mission Control canvas HTTP server. Binds to 127.0.0.1 on an ephemeral
// port and serves:
//
//   GET  /           the page shell (public/index.html)
//   GET  /state      the current view-model state as JSON
//   GET  /events     server-sent events (`state`, `focus`, `note`)
//   POST /refresh    re-run the dashboard and push the new state to clients
//   POST /dispatch   push exactly one prompt into the chat, if allowed
//
// Dispatch safety (see plan.md "Dispatch safety"): a command is accepted only when
// the Host is exactly `127.0.0.1:<port>` (blocks DNS rebinding), the Origin is the
// server's own origin, the Content-Type is application/json, and the command exactly
// matches an entry in the live allowed union. OPTIONS is refused, so a cross-site
// preflight never reaches the handler. Static files are served only from `public/`
// with no path traversal. Every rendered value is escaped by the client.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function defaultPublicDir() {
  return path.join(here, "public");
}

function originFor(port) {
  return `http://127.0.0.1:${port}`;
}

function respond(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Serve one static file from `publicDir`, refusing any path that escapes it.
function serveStatic(publicDir, reqUrl, res) {
  const url = new URL(reqUrl, "http://127.0.0.1");
  const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const target = path.resolve(publicDir, rel === "" ? "index.html" : rel);
  const inside = target === publicDir || target.startsWith(publicDir + path.sep);
  if (!inside) {
    respond(res, 403, "forbidden", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    respond(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  if (!stat.isFile()) {
    respond(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const type = CONTENT_TYPES[ext] ?? "application/octet-stream";
  respond(res, 200, fs.readFileSync(target), { "content-type": type, "cache-control": "no-cache" });
}

export function startServer({ publicDir = defaultPublicDir(), send = null, onRefresh = null, log = () => {}, port: requestedPort = 0, onExtra = null } = {}) {
  let state = { allowed: [] };
  let port = 0;
  const clients = new Set();

  const broadcast = (type, data) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
        // client socket already gone; it will be pruned on close
      }
    }
  };

  const setState = (next) => {
    state = next;
    broadcast("state", state);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const host = req.headers.host ?? "";

    // Cross-site preflight never reaches a handler.
    if (req.method === "OPTIONS") {
      respond(res, 405, "method not allowed", { "content-type": "text/plain; charset=utf-8" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/state") {
      respond(res, 200, JSON.stringify(state), { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/refresh") {
      if (typeof onRefresh !== "function") {
        respond(res, 501, "refresh unavailable", { "content-type": "text/plain; charset=utf-8" });
        return;
      }
      try {
        await onRefresh();
        respond(res, 200, JSON.stringify({ ok: true }), { "content-type": "application/json; charset=utf-8" });
      } catch (err) {
        respond(res, 500, JSON.stringify({ ok: false, error: String(err?.message ?? err) }), { "content-type": "application/json; charset=utf-8" });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/dispatch") {
      const errors = [];
      if (host !== `127.0.0.1:${port}`) errors.push("host");
      const origin = req.headers.origin ?? "";
      if (origin !== originFor(port)) errors.push("origin");
      const contentType = (req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) errors.push("content-type");
      if (errors.length) {
        respond(res, 403, JSON.stringify({ ok: false, errors }), { "content-type": "application/json; charset=utf-8" });
        return;
      }

      let body;
      try {
        body = await readBody(req);
      } catch {
        respond(res, 413, JSON.stringify({ ok: false, errors: ["body"] }), { "content-type": "application/json; charset=utf-8" });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        respond(res, 400, JSON.stringify({ ok: false, errors: ["json"] }), { "content-type": "application/json; charset=utf-8" });
        return;
      }

      const command = parsed?.command;
      const allowed = Array.isArray(state?.allowed) ? state.allowed : [];
      if (typeof command !== "string" || !allowed.includes(command)) {
        respond(res, 403, JSON.stringify({ ok: false, errors: ["command"] }), { "content-type": "application/json; charset=utf-8" });
        return;
      }

      if (typeof send !== "function") {
        respond(res, 501, JSON.stringify({ ok: false, errors: ["send"] }), { "content-type": "application/json; charset=utf-8" });
        return;
      }
      try {
        await send({ prompt: command });
        respond(res, 204, "", {});
      } catch (err) {
        respond(res, 500, JSON.stringify({ ok: false, error: String(err?.message ?? err) }), { "content-type": "application/json; charset=utf-8" });
      }
      return;
    }

    if (req.method === "GET") {
      serveStatic(publicDir, req.url, res);
      return;
    }

    if (typeof onExtra === "function") {
      const handled = await onExtra({
        req,
        res,
        url,
        port,
        respond,
        readBody,
        broadcast,
        setState,
        getState: () => state,
      });
      if (handled) return;
    }

    respond(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      port = server.address().port;
      resolve({
        server,
        port,
        url: `${originFor(port)}/`,
        setState,
        getState: () => state,
        broadcast,
        close: async () => {
          for (const client of clients) client.end();
          clients.clear();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}
