// Header "Actions" menu: the window-wide commands (delivery-status, new-feature,
// start-session, start-freehand, …) that used to repeat on every card. Enabled
// items are this window's `session.allowed` entries and dispatch through
// /dispatch; the rest of the catalog is listed disabled with the CLI's reason.
// The split itself is pure and tested in /actions.js.

import { dispatch, escapeHtml, registerPanel } from "/app.js";
import { headerActions } from "/actions.js";
import { bindHandoffButtons, handoffButtonMarkup, windowsKey } from "/handoff.js";

const toggle = document.getElementById("actions-toggle");
const menu = document.getElementById("actions-menu");
let renderedKey = null;

function itemMarkup(action) {
  if (action.enabled) {
    return `<li><button type="button" class="mc-btn mc-btn-run mc-action-item" data-command="${escapeHtml(action.command)}"
      aria-label="Run ${escapeHtml(action.command)}"><span class="mc-verb">Run</span> ${escapeHtml(action.label)}</button></li>`;
  }
  const greyed = `<button type="button" class="mc-btn mc-action-item" disabled
    aria-label="${escapeHtml(action.command)} — ${escapeHtml(action.reason ?? "")}">${escapeHtml(action.label)}
    <span class="mc-action-reason">${escapeHtml(action.reason ?? "")}</span></button>`;
  const handoff = handoffButtonMarkup(action);
  return `<li${handoff ? ' class="mc-cmd-row"' : ""}>${greyed}${handoff}</li>`;
}

function setOpen(open, { focusToggle = false } = {}) {
  if (!toggle || !menu) return;
  menu.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("button:not([disabled])")?.focus();
  else if (focusToggle) toggle.focus();
}

function render(state) {
  const actions = headerActions(state);
  const key = JSON.stringify(actions) + windowsKey();
  // Unchanged actions keep the current DOM, so a live state frame never steals
  // keyboard focus from an open menu.
  if (key === renderedKey) return null;
  renderedKey = key;

  const enabled = actions.filter((a) => a.enabled);
  const disabled = actions.filter((a) => !a.enabled);
  if (toggle) toggle.firstChild.textContent = enabled.length ? `Actions (${enabled.length}) ` : "Actions ";

  const root = document.createElement("div");
  root.innerHTML = `
    <p class="mc-actions-group">This window</p>
    ${enabled.length ? `<ul class="mc-actions-list">${enabled.map(itemMarkup).join("")}</ul>` : '<p class="mc-actions-empty">No window-wide actions here.</p>'}
    ${disabled.length ? `<p class="mc-actions-group">Not available here</p><ul class="mc-actions-list">${disabled.map(itemMarkup).join("")}</ul>` : ""}`;

  const status = document.getElementById("status");
  root.querySelectorAll(".mc-btn-run[data-command]").forEach((button) => {
    button.addEventListener("click", async () => {
      const command = button.getAttribute("data-command");
      button.disabled = true;
      try {
        await dispatch(command);
        if (status) status.textContent = `dispatched ${command}`;
        setOpen(false, { focusToggle: true });
      } catch (err) {
        if (status) status.textContent = err?.message ?? String(err);
      } finally {
        button.disabled = false;
      }
    });
  });
  bindHandoffButtons(root);
  return root;
}

toggle?.addEventListener("click", () => setOpen(menu.hidden));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu && !menu.hidden) {
    event.preventDefault();
    setOpen(false, { focusToggle: true });
  }
});
document.addEventListener("click", (event) => {
  if (menu && !menu.hidden && !event.target.closest(".mc-actions")) setOpen(false);
});

registerPanel("actions-menu", render);
