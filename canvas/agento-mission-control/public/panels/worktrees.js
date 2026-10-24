// Worktree and window map panel: product and companion worktrees grouped by
// window role, each entry colored by its role, linked to the delivery it owns,
// and the current window ("This window") highlighted.

import { escapeHtml, roleColor, registerPanel } from "/app.js";

function entryMarkup(entry) {
  const colors = roleColor(entry.role);
  const repo = entry.repo === "companion" ? "companion" : "product";
  const branch = entry.detached ? "(detached)" : entry.branch ?? "";
  const delivery = entry.delivery ?? "—";
  const current = entry.current ? " mc-wt-current" : "";
  return `<li class="mc-wt-entry${current}" style="border-left-color:${colors.background}">
    <span class="mc-wt-path" title="${escapeHtml(entry.path ?? "")}">${escapeHtml(entry.path ?? "")}</span>
    <span class="mc-wt-meta">
      <span class="mc-wt-repo mc-wt-repo-${escapeHtml(repo)}">${escapeHtml(repo)}</span>
      <span class="mc-wt-branch">${escapeHtml(branch)}</span>
      <span class="mc-wt-delivery" title="${escapeHtml(delivery)}">→ ${escapeHtml(delivery)}</span>
    </span>
    ${entry.current ? '<span class="mc-wt-badge">This window</span>' : ""}
  </li>`;
}

function groupMarkup(group) {
  const colors = roleColor(group.role);
  const items = (group.worktrees ?? []).map(entryMarkup).join("");
  return `<section class="mc-wt-group">
    <h3 class="mc-wt-role" style="background:${colors.background};color:${colors.foreground}">${escapeHtml(group.role ?? "unknown")}</h3>
    <ul class="mc-wt-list">${items}</ul>
  </section>`;
}

function render(state) {
  const root = document.createElement("div");
  root.className = "mc-worktrees";
  const groups = state.worktrees?.groups ?? [];
  root.innerHTML = groups.length
    ? groups.map(groupMarkup).join("")
    : '<p class="mc-empty">no worktrees</p>';
  return root;
}

registerPanel("worktrees", render);
