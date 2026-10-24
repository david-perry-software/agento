// Delivery command buttons shared by board cards and the delivery page: a runnable
// command is a "Run" button that posts to /dispatch; a command another window runs
// is the same text greyed out (aria-disabled, so its tooltip stays reachable by
// keyboard) with a handoff button beside it when that window can be opened.

import { dispatch, escapeHtml } from "/app.js";
import { bindHandoffButtons, handoffButtonMarkup } from "/handoff.js";

// `buttons`: actions.js `cardButtons` output.
export function commandButtonsHtml(buttons) {
  return buttons.map((button) => {
    const text = `<span class="mc-verb">Run</span> ${escapeHtml(button.command)}`;
    if (button.enabled) {
      return `<button type="button" class="mc-btn mc-btn-run" data-command="${escapeHtml(button.command)}"
        aria-label="Run ${escapeHtml(button.command)}">${text}</button>`;
    }
    const greyed = `<button type="button" class="mc-btn mc-btn-unavailable" aria-disabled="true"
      data-tooltip="${escapeHtml(button.reason)}"
      aria-label="Run ${escapeHtml(button.command)}, unavailable here. ${escapeHtml(button.reason)}">${text}</button>`;
    const handoff = handoffButtonMarkup(button);
    return handoff ? `<div class="mc-cmd-row">${greyed}${handoff}</div>` : greyed;
  }).join("");
}

export function bindCommandButtons(root) {
  const status = document.getElementById("status");
  root.querySelectorAll(".mc-btn-run[data-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.getAttribute("data-command");
      button.disabled = true;
      try {
        await dispatch(command);
        if (status) status.textContent = `dispatched ${command}`;
      } catch (err) {
        if (status) status.textContent = err?.message ?? String(err);
        button.disabled = false;
      }
    });
  });
  bindHandoffButtons(root);
}

export function progressRing(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  return `<svg class="mc-ring" viewBox="0 0 40 40" role="img" aria-label="${done} of ${total} steps done">
    <circle class="mc-ring-track" cx="20" cy="20" r="${radius}"></circle>
    <circle class="mc-ring-fill" cx="20" cy="20" r="${radius}"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
    <text class="mc-ring-text" x="20" y="20" text-anchor="middle" dominant-baseline="central">${done}/${total}</text>
  </svg>`;
}
