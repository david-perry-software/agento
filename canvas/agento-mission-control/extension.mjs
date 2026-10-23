// Agento Mission Control — spike canvas (step 1.1).
//
// This is a deliberately minimal probe that de-risks the VS Code canvas runtime
// before the real panels are built (Phase 4). It declares one canvas with a
// single `ping` action and serves a page that (a) shows the computed
// `--vscode-editor-background` / `--vscode-foreground` values and (b) has a
// "Send test prompt" button that pushes `/agento delivery-status` into the chat.
//
// Canvas contract (create-canvas skill, VS Code 1.142):
// - ESM, import from `@github/copilot-sdk/extension` (the runtime resolves it).
// - Never write to stdout; use `session.log()`.
// - `open(ctx)` returns `{ title, status, url }` and is idempotent per `instanceId`.
// - `onClose` stops instance-owned servers (hosts may only hide a view, so nothing
//   may depend on it running).
// - The page is ordinary web content: same-origin HTTP endpoints only, no host bridge.

import http from "node:http";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const PROBE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control — spike probe</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, -apple-system, system-ui, sans-serif);
    background: var(--vscode-editor-background, Canvas);
    color: var(--vscode-foreground, CanvasText);
    padding: 2rem;
    line-height: 1.5;
  }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.5rem; }
  dt { font-weight: 600; }
  dd { margin: 0; font-family: var(--vscode-editor-font-family, monospace); overflow-wrap: anywhere; }
  button {
    font: inherit; padding: 0.5rem 1rem; margin-top: 1.5rem;
    border: 1px solid var(--vscode-button-border, ButtonBorder);
    background: var(--vscode-button-background, ButtonFace);
    color: var(--vscode-button-foreground, ButtonText);
    border-radius: 4px; cursor: pointer;
  }
  button:focus-visible { outline: 2px solid var(--vscode-focusBorder, Highlight); outline-offset: 2px; }
</style>
</head>
<body>
  <h1>Agento Mission Control — spike probe</h1>
  <p>This probe reports the computed VS Code theme variables and exercises the
     prompt-dispatch path.</p>
  <dl>
    <dt>--vscode-editor-background</dt><dd id="bg">(reading…)</dd>
    <dt>--vscode-foreground</dt><dd id="fg">(reading…)</dd>
  </dl>
  <button id="send" type="button">Send test prompt</button>
  <p id="status" role="status" aria-live="polite"></p>
  <script>
    const style = getComputedStyle(document.documentElement);
    document.getElementById("bg").textContent =
      JSON.stringify(style.getPropertyValue("--vscode-editor-background").trim());
    document.getElementById("fg").textContent =
      JSON.stringify(style.getPropertyValue("--vscode-foreground").trim());
    document.getElementById("send").addEventListener("click", async () => {
      const status = document.getElementById("status");
      status.textContent = "sending…";
      try {
        const res = await fetch("/send", { method: "POST" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        status.textContent = "prompt sent to chat";
      } catch (err) {
        status.textContent = "send failed: " + err.message;
      }
    });
  </script>
</body>
</html>`;

// Live instances by `instanceId`: { server, url }.
const instances = new Map();

async function startServer(session) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PROBE_HTML);
        return;
      }
      if (req.method === "POST" && url.pathname === "/send") {
        await session.send({ prompt: "/agento delivery-status" });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(err && err.message ? err.message : err));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const session = await joinSession({
  canvases: [
    createCanvas({
      id: "agento-mission-control",
      displayName: "Agento Mission Control",
      description:
        "A spike probe for the Agento Mission Control canvas: reports the VS Code theme variables and exercises prompt dispatch.",
      actions: [
        {
          name: "ping",
          description: "Confirms the canvas action dispatch path works.",
          handler: async () => ({ ok: true, canvas: "agento-mission-control" }),
        },
      ],
      async open(ctx) {
        const existing = instances.get(ctx.instanceId);
        if (existing) {
          return { title: "Mission Control (spike)", status: "reopened", url: existing.url };
        }
        const { server, url } = await startServer(session);
        instances.set(ctx.instanceId, { server, url });
        await session.log(`Mission Control spike opened at ${url} (instance ${ctx.instanceId})`);
        return { title: "Mission Control (spike)", status: "spike probe", url };
      },
      async onClose(ctx) {
        const existing = instances.get(ctx.instanceId);
        if (existing) {
          existing.server.close();
          instances.delete(ctx.instanceId);
        }
      },
    }),
  ],
});
