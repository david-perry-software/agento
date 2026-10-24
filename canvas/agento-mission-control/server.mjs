// The Mission Control canvas HTTP server. Binds to 127.0.0.1 on an ephemeral
// port and serves:
//
//   GET  /           the page shell (public/index.html)
//   GET  /state      the current view-model state as JSON
//   GET  /events     server-sent events (`state`, `focus`, `note`)
//   POST /refresh    re-run the dashboard and push the new state to clients
//   POST /dispatch   push exactly one prompt into the chat, if allowed
//   GET  /windows    which handoff target windows are open (open vs. switch labels)
//   POST /handoff    queue a greyed command for its window and open or focus it
//   GET  /artifacts?slug=<slug>   that delivery's plan.md / roadmap.md / review.md text
//
// Dispatch safety (see plan.md "Dispatch safety"): a command is accepted only when
// the Host is exactly `127.0.0.1:<port>` (blocks DNS rebinding), the Origin is the
// server's own origin, the Content-Type is application/json, and the command exactly
// matches an entry in the live allowed union. OPTIONS is refused, so a cross-site
// preflight never reaches the handler. Static files are served only from `public/`
// with no path traversal. Every rendered value is escaped by the client.
// Handoff applies the same request checks; the command must be one of the live
// state's handoff targets (public/actions.js `handoffTargets`), and the checkout
// is taken from there — the request never names a path.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handoffTargets } from "./public/actions.js";

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

const JSON_TYPE = { "content-type": "application/json; charset=utf-8" };

// The request checks every state-changing POST applies: exact Host (DNS
// rebinding), same Origin (cross-site), and a JSON body (no simple-form CSRF).
function writeRequestErrors(req, host, port) {
  const errors = [];
  if (host !== `127.0.0.1:${port}`) errors.push("host");
  if ((req.headers.origin ?? "") !== originFor(port)) errors.push("origin");
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) errors.push("content-type");
  return errors;
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

export function startServer({ publicDir = defaultPublicDir(), send = null, onRefresh = null, windows = null, handoff = null, artifacts = null, log = () => {}, port: requestedPort = 0, onExtra = null } = {}) {
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

  const handle = async (req, res) => {
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
      const errors = writeRequestErrors(req, host, port);
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

    if (req.method === "GET" && url.pathname === "/artifacts") {
      if (host !== `127.0.0.1:${port}`) {
        respond(res, 403, JSON.stringify({ ok: false, errors: ["host"] }), JSON_TYPE);
        return;
      }
      // Only a delivery on the live board; its type comes from the state too.
      const slug = url.searchParams.get("slug") ?? "";
      const card = (state?.cards ?? []).find((c) => c?.slug === slug);
      if (!card) {
        respond(res, 404, JSON.stringify({ ok: false, errors: ["slug"] }), JSON_TYPE);
        return;
      }
      if (typeof artifacts !== "function") {
        respond(res, 501, JSON.stringify({ ok: false, errors: ["artifacts"] }), JSON_TYPE);
        return;
      }
      try {
        const result = await artifacts({ type: card.type === "issue" ? "issue" : "feature", slug });
        const files = {};
        for (const name of ["plan", "roadmap", "review"]) {
          const file = result?.files?.[name];
          files[name] = file?.exists && typeof file.content === "string" ? { exists: true, content: file.content } : { exists: false };
        }
        respond(res, 200, JSON.stringify({
          ok: result?.status === "ok",
          slug,
          source: result?.source ?? null,
          ref: result?.ref ?? null,
          message: result?.status === "ok" ? undefined : String(result?.message ?? "artifacts unavailable"),
          files,
        }), { ...JSON_TYPE, "cache-control": "no-cache" });
      } catch (err) {
        respond(res, 500, JSON.stringify({ ok: false, error: String(err?.message ?? err) }), JSON_TYPE);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/windows") {
      if (host !== `127.0.0.1:${port}`) {
        respond(res, 403, JSON.stringify({ ok: false, errors: ["host"] }), JSON_TYPE);
        return;
      }
      if (typeof windows !== "function") {
        respond(res, 501, JSON.stringify({ ok: false, errors: ["windows"] }), JSON_TYPE);
        return;
      }
      const checkouts = [...new Set([...handoffTargets(state).values()].map((t) => t.checkout))];
      try {
        const found = checkouts.length ? await windows(checkouts) : [];
        const byCheckout = {};
        for (const w of found ?? []) if (w?.checkout) byCheckout[w.checkout] = { open: Boolean(w.open), target: w.target ?? null };
        respond(res, 200, JSON.stringify({ ok: true, windows: byCheckout }), { ...JSON_TYPE, "cache-control": "no-cache" });
      } catch (err) {
        respond(res, 500, JSON.stringify({ ok: false, error: String(err?.message ?? err) }), JSON_TYPE);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/handoff") {
      const errors = writeRequestErrors(req, host, port);
      if (errors.length) {
        respond(res, 403, JSON.stringify({ ok: false, errors }), JSON_TYPE);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        respond(res, 400, JSON.stringify({ ok: false, errors: ["json"] }), JSON_TYPE);
        return;
      }
      const command = parsed?.command;
      const target = typeof command === "string" ? handoffTargets(state).get(command) : undefined;
      if (!target) {
        respond(res, 403, JSON.stringify({ ok: false, errors: ["command"] }), JSON_TYPE);
        return;
      }
      if (typeof handoff !== "function") {
        respond(res, 501, JSON.stringify({ ok: false, errors: ["handoff"] }), JSON_TYPE);
        return;
      }
      try {
        const result = await handoff({ checkout: target.checkout, command });
        const ok = result?.status === "ok";
        respond(res, ok ? 200 : 502, JSON.stringify({
          ok,
          command,
          windowName: target.windowName,
          wasOpen: Boolean(result?.wasOpen),
          opened: Boolean(result?.opened),
          error: ok ? undefined : String(result?.reason ?? result?.message ?? "handoff failed"),
        }), JSON_TYPE);
      } catch (err) {
        respond(res, 500, JSON.stringify({ ok: false, error: String(err?.message ?? err) }), JSON_TYPE);
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
  };

  // Error boundary: a synchronous throw or rejected promise anywhere in the
  // handler (today `decodeURIComponent` in `serveStatic` throws URIError on a
  // malformed percent path like `GET /%`) must never escape as an unhandled
  // rejection — that would exit the extension process hosting every canvas
  // instance. Answer 400 for a malformed request, 500 otherwise, log, and keep
  // the server alive for the next request.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof URIError) {
        respond(res, 400, "bad request", { "content-type": "text/plain; charset=utf-8" });
      } else {
        respond(res, 500, "internal server error", { "content-type": "text/plain; charset=utf-8" });
      }
    });
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
