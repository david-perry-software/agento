// Window banner: a full-width strip above the header naming the kind of Agento
// window this canvas belongs to (primary, plan, build, freehand, unmanaged) in the
// same role colors the extension paints window title bars with.

import { escapeHtml, registerPanel, roleColor } from "/app.js";
import { windowSummary } from "/window.js";

function render(state) {
  const summary = windowSummary(state.session);
  const colors = roleColor(summary.role);
  const root = document.createElement("div");
  root.className = "mc-window-banner-inner";
  root.dataset.role = summary.role;
  root.style.background = colors.background;
  root.style.color = colors.foreground;
  const details = summary.details
    .map((d) => `<span class="mc-window-detail"><span class="mc-window-detail-label">${escapeHtml(d.label)}</span> <span class="mc-window-detail-value" title="${escapeHtml(d.value)}">${escapeHtml(d.value)}</span></span>`)
    .join("");
  root.innerHTML = `
    <div class="mc-window-title">
      <strong class="mc-window-kind">${escapeHtml(summary.label)}</strong>
      ${summary.hosted ? '<span class="mc-window-tag">hosted</span>' : ""}
      <span class="mc-window-purpose">${escapeHtml(summary.purpose)}</span>
    </div>
    ${details ? `<div class="mc-window-details">${details}</div>` : ""}`;
  return root;
}

registerPanel("window-banner", render);
