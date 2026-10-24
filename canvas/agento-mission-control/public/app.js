// Mission Control page core. Loads /state, follows /events over server-sent
// events, escapes every rendered value, and posts dispatches to /dispatch as
// JSON. Panel modules (public/panels/*.js) register a render function with
// `registerPanel(name, render)`; the shell calls each one with the current state
// on every update. `focus` and `note` SSE events are forwarded as DOM custom
// events (`mc:focus`, `mc:note`) for panels that need them.

import { ROLE_COLORS, roleColor } from "./roles.js";

export { ROLE_COLORS, roleColor };

let state = {
  lanes: [],
  cards: [],
  initiatives: [],
  timeline: { bands: [] },
  worktrees: { groups: [] },
  allowed: [],
  session: {},
};

const panels = new Map();

// Escape untrusted text before interpolating it into HTML.
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

export function getState() {
  return state;
}

export function registerPanel(name, render) {
  panels.set(name, render);
  renderPanel(name);
}

function renderPanel(name) {
  const mount = document.getElementById(name);
  const render = panels.get(name);
  if (mount && render) {
    mount.replaceChildren(render(state, { escapeHtml, roleColor }));
  }
}

function renderAll() {
  for (const name of panels.keys()) renderPanel(name);
  const status = document.getElementById("status");
  if (status) {
    const counts = state.lanes
      .map((lane) => `${escapeHtml(lane.label)}: ${lane.cards.length}`)
      .join(" · ");
    status.textContent = counts || "waiting for data";
  }
}

export function applyState(next) {
  if (next && typeof next === "object") state = next;
  renderAll();
}

// Dispatch exactly one command to the chat (or to dev.mjs's stub). The server
// enforces the allowlist; the client only needs to send JSON.
export async function dispatch(command) {
  const res = await fetch("/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (res.status === 204) return;
  let detail = `dispatch failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.error) detail = String(body.error);
  } catch {
    // non-JSON error body; keep the status detail
  }
  throw new Error(detail);
}

async function loadState() {
  const res = await fetch("/state");
  if (!res.ok) throw new Error(`state load failed (${res.status})`);
  applyState(await res.json());
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("state", (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch {
      // ignore malformed frames
    }
  });
  source.addEventListener("focus", (event) => {
    try {
      window.dispatchEvent(new CustomEvent("mc:focus", { detail: JSON.parse(event.data) }));
    } catch {
      // ignore malformed frames
    }
  });
  source.addEventListener("note", (event) => {
    try {
      window.dispatchEvent(new CustomEvent("mc:note", { detail: JSON.parse(event.data) }));
    } catch {
      // ignore malformed frames
    }
  });
}

function boot() {
  const status = document.getElementById("status");
  loadState().catch((err) => {
    if (status) status.textContent = escapeHtml(err.message);
  });
  connectEvents();
}

boot();
