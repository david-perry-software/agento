// Mission Control page core. Loads /state, follows /events over server-sent
// events, escapes every rendered value, and posts dispatches to /dispatch as
// JSON. Panel modules (public/panels/*.js) register a render function with
// `registerPanel(name, render)`; the shell calls each one with the current state
// on every update. `focus` and `note` SSE events are forwarded as DOM custom
// events (`mc:focus`, `mc:note`) for panels that need them.
//
// Each page holds one or more panels: the URL hash (`#/board`, `#/graph`, …)
// shows the panels whose `data-page` matches and hides the rest, which stay
// rendered so a switch is instant and every page shares the one /events
// connection. Panels marked `data-collapsible` fold from their heading row; the
// choice is remembered per panel in localStorage.

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

export const PAGES = ["board", "graph", "timeline", "worktrees", "feed"];
// Pages reached by link rather than a tab, with one path parameter:
// `#/delivery/<slug>` is the delivery page. Each highlights its parent tab.
const DETAIL_PAGES = { delivery: "board" };
const DEFAULT_PAGE = "board";
let currentPage = null;
let currentParam = null;
let unreadNotes = 0;

function routeFromHash(hash) {
  const [name, ...rest] = String(hash ?? "").replace(/^#\/?/, "").split("/");
  if (PAGES.includes(name) && rest.length === 0) return { page: name, param: null };
  if (DETAIL_PAGES[name] && rest.length === 1 && rest[0]) {
    try {
      return { page: name, param: decodeURIComponent(rest[0]) };
    } catch {
      return null;
    }
  }
  return null;
}

export function getPage() {
  return currentPage;
}

// The detail page's parameter (the delivery slug on `#/delivery/<slug>`), else null.
export function getParam() {
  return currentParam;
}

export function deliveryHref(slug) {
  return `#/delivery/${encodeURIComponent(slug)}`;
}

function renderUnread() {
  const badge = document.getElementById("feed-unread");
  if (!badge) return;
  badge.hidden = unreadNotes === 0;
  badge.textContent = unreadNotes > 99 ? "99+" : String(unreadNotes);
  badge.setAttribute("aria-label", `${unreadNotes} new`);
}

// Show one page and hide the others. `moveFocus` sends keyboard and screen
// reader focus to the page heading after a user navigation.
export function showPage(name, { moveFocus = false, param = null } = {}) {
  const detail = Boolean(DETAIL_PAGES[name]);
  if (!PAGES.includes(name) && !detail) return;
  const changed = name !== currentPage || param !== currentParam;
  currentPage = name;
  currentParam = detail ? param : null;
  for (const section of document.querySelectorAll(".mc-panel[data-page]")) {
    section.hidden = section.dataset.page !== name;
  }
  const tab = DETAIL_PAGES[name] ?? name;
  for (const link of document.querySelectorAll(".mc-nav a[data-page]")) {
    if (link.dataset.page === tab) link.setAttribute("aria-current", detail ? "true" : "page");
    else link.removeAttribute("aria-current");
  }
  if (name === "feed") {
    unreadNotes = 0;
    renderUnread();
  }
  const hash = detail ? `#/${name}/${encodeURIComponent(currentParam ?? "")}` : `#/${name}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  if (detail && changed) refreshPanel(name);
  if (moveFocus) document.getElementById(`${name}-heading`)?.focus({ preventScroll: true });
  if (changed) window.scrollTo(0, 0);
}

function initPages() {
  const initial = routeFromHash(location.hash) ?? { page: DEFAULT_PAGE, param: null };
  showPage(initial.page, { param: initial.param });
  window.addEventListener("hashchange", () => {
    const route = routeFromHash(location.hash);
    if (route) showPage(route.page, { param: route.param, moveFocus: true });
  });
}

const COLLAPSE_KEY = "mc:collapsed:";

function readCollapsed(id) {
  try {
    return localStorage.getItem(COLLAPSE_KEY + id) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(id, collapsed) {
  try {
    if (collapsed) localStorage.setItem(COLLAPSE_KEY + id, "1");
    else localStorage.removeItem(COLLAPSE_KEY + id);
  } catch {
    // storage unavailable; the choice lasts for this page load only
  }
}

export function setCollapsed(section, collapsed) {
  if (!section?.matches?.("[data-collapsible]")) return;
  const body = section.querySelector(":scope > .mc-panel-body");
  const button = section.querySelector(":scope > .mc-panel-head .mc-collapse-btn");
  const title = section.querySelector(":scope > .mc-panel-head h2")?.textContent?.trim() ?? "section";
  section.classList.toggle("mc-collapsed", collapsed);
  if (body) body.hidden = collapsed;
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.textContent = collapsed ? "Show" : "Hide";
    button.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} ${title}`);
  }
  writeCollapsed(section.id, collapsed);
}

// Expand whichever collapsible panel holds `element` (used before a `focus`).
export function expandFor(element) {
  const section = element?.closest?.("[data-collapsible]");
  if (section && section.classList.contains("mc-collapsed")) setCollapsed(section, false);
}

function initCollapsibles() {
  for (const section of document.querySelectorAll(".mc-panel[data-collapsible]")) {
    setCollapsed(section, readCollapsed(section.id));
    // The whole heading row toggles; the button inside it is the keyboard control
    // and its click bubbles here, so there is exactly one toggle per activation.
    section.querySelector(":scope > .mc-panel-head")?.addEventListener("click", () => {
      setCollapsed(section, !section.classList.contains("mc-collapsed"));
    });
  }
}

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

// Re-render one panel from the current state (for panel-local UI changes such as
// a filter edit, which do not arrive as a new state frame).
export function refreshPanel(name) {
  renderPanel(name);
}

// A render function returns the panel's new content, or null to leave the
// current DOM (and any focus inside it) untouched. When new content replaces the
// old, focus on an element with an id moves to its replacement.
function renderPanel(name) {
  const mount = document.getElementById(name);
  const render = panels.get(name);
  if (mount && render) {
    const content = render(state, { escapeHtml, roleColor });
    if (content) {
      const active = document.activeElement;
      const focusedId = active && active !== document.body && mount.contains(active) ? active.id : "";
      mount.replaceChildren(content);
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    }
  }
}

function renderAll() {
  for (const name of panels.keys()) renderPanel(name);
  const status = document.getElementById("status");
  if (status) {
    const counts = state.lanes
      .map((lane) => `${escapeHtml(lane.label)}: ${lane.cards.length + (lane.collapsed ?? 0)}`)
      .join(" · ");
    status.textContent = counts || "waiting for data";
  }
}

const stateListeners = new Set();

// Run `fn(state)` after every state update (for non-panel work such as re-checking
// which windows are open).
export function onStateChange(fn) {
  stateListeners.add(fn);
}

export function applyState(next) {
  if (next && typeof next === "object") state = next;
  renderAll();
  for (const fn of stateListeners) {
    try {
      fn(state);
    } catch {
      // a listener failure must not break rendering
    }
  }
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
      return; // ignore malformed frames
    }
    if (currentPage !== "feed") {
      unreadNotes += 1;
      renderUnread();
    }
  });
}

function boot() {
  initPages();
  initCollapsibles();
  const status = document.getElementById("status");
  loadState().catch((err) => {
    if (status) status.textContent = escapeHtml(err.message);
  });
  connectEvents();
}

boot();
