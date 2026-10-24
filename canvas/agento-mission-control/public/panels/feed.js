// Live activity feed panel plus focus handling. It renders the persisted feed
// (state.feed) and appends SSE `note` events (forwarded as `mc:note`). SSE
// `focus` events (forwarded as `mc:focus`) scroll to and highlight the target
// node — a board card, an initiative graph node, or a worktree entry.

import { escapeHtml, registerPanel } from "/app.js";

function noteMarkup(entry) {
  const text = entry?.text ?? "";
  const at = entry?.at ? new Date(entry.at).toLocaleTimeString() : "";
  return `<li class="mc-feed-item">
    <span class="mc-feed-time">${escapeHtml(at)}</span>
    <span class="mc-feed-text">${escapeHtml(text)}</span>
  </li>`;
}

function focusTarget(kind, id) {
  if (kind === "delivery") return document.querySelector(`.mc-card[data-slug="${CSS.escape(id)}"]`);
  if (kind === "initiative") return document.querySelector(`.mc-node[data-slug="${CSS.escape(id)}"]`);
  if (kind === "worktree") return document.querySelector(`.mc-wt-entry[data-path="${CSS.escape(id)}"]`);
  return null;
}

function render(state) {
  const root = document.createElement("div");
  root.className = "mc-feed";
  const feed = Array.isArray(state.feed) ? state.feed : [];
  root.innerHTML = feed.length
    ? `<ul class="mc-feed-list">${feed.map(noteMarkup).join("")}</ul>`
    : '<p class="mc-feed-empty">no activity yet</p>';
  return root;
}

function bindEvents() {
  const root = document.getElementById("feed");

  window.addEventListener("mc:note", (event) => {
    const detail = event.detail ?? {};
    const list = root.querySelector(".mc-feed-list");
    if (!list) {
      root.innerHTML = `<ul class="mc-feed-list">${noteMarkup(detail)}</ul>`;
      return;
    }
    const item = document.createElement("li");
    item.className = "mc-feed-item";
    const time = document.createElement("span");
    time.className = "mc-feed-time";
    time.textContent = detail?.at ? new Date(detail.at).toLocaleTimeString() : "";
    const text = document.createElement("span");
    text.className = "mc-feed-text";
    text.textContent = detail?.text ?? "";
    item.append(time, text);
    list.append(item);
  });

  window.addEventListener("mc:focus", (event) => {
    const detail = event.detail ?? {};
    const target = focusTarget(detail.kind, detail.id);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("mc-focus-target");
    window.setTimeout(() => target.classList.remove("mc-focus-target"), 2500);
  });
}

registerPanel("feed", render);
bindEvents();
