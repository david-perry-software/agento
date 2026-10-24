// Open-window handoff for greyed commands: a small button beside a command this
// window cannot run opens or focuses the window that can (`POST /handoff`, which
// runs `agento.mjs handoff`) and queues the command there; the Agento extension in
// that window submits it to chat. `GET /windows` tells whether each target window
// is already open, so the button reads "Switch to …" or "Open …".

import { escapeHtml, onStateChange, refreshPanel } from "/app.js";

let openByCheckout = {};
let loading = null;
let debounce = null;

export function windowOpen(checkout) {
  return checkout && Object.prototype.hasOwnProperty.call(openByCheckout, checkout) ? openByCheckout[checkout].open : null;
}

export function windowsKey() {
  return JSON.stringify(openByCheckout);
}

async function loadWindows() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch("/windows");
      if (!res.ok) return;
      const body = await res.json();
      const next = body?.windows && typeof body.windows === "object" ? body.windows : {};
      if (JSON.stringify(next) !== JSON.stringify(openByCheckout)) {
        openByCheckout = next;
        refreshPanel("board");
        refreshPanel("actions-menu");
      }
    } catch {
      // window detection is advisory; buttons fall back to "Open or switch to"
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function scheduleLoad(delay = 500) {
  clearTimeout(debounce);
  debounce = setTimeout(loadWindows, delay);
}

// "Switch to the build window (x) and run /agento ship x" — `button` is a card
// button or header action with `checkout` and `windowName`.
export function handoffLabel(button) {
  const open = windowOpen(button.checkout);
  const verb = open === true ? "Switch to" : open === false ? "Open" : "Open or switch to";
  return `${verb} ${button.windowName ?? "its window"} and run ${button.command} there`;
}

export function handoffButtonMarkup(button) {
  if (!button.checkout) return "";
  const label = handoffLabel(button);
  const open = windowOpen(button.checkout);
  return `<button type="button" class="mc-btn mc-handoff${open ? " mc-handoff-open" : ""}" data-handoff="${escapeHtml(button.command)}"
    data-tooltip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span aria-hidden="true">${open ? "⇥" : "↗"}</span></button>`;
}

export function bindHandoffButtons(root) {
  const status = document.getElementById("status");
  root.querySelectorAll(".mc-handoff[data-handoff]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const command = button.getAttribute("data-handoff");
      button.disabled = true;
      if (status) status.textContent = `Opening the window for ${command}…`;
      try {
        const res = await fetch("/handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body?.error ?? (Array.isArray(body?.errors) ? `handoff refused: ${body.errors.join(", ")}` : `handoff failed (${res.status})`));
        if (status) status.textContent = `${body.wasOpen ? "Switched to" : "Opened"} ${body.windowName ?? "the window"} — ${command} will run there`;
        scheduleLoad(1500);
      } catch (err) {
        if (status) status.textContent = err?.message ?? String(err);
      } finally {
        button.disabled = false;
      }
    });
  });
}

onStateChange(() => scheduleLoad());
window.addEventListener("focus", () => scheduleLoad(0));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleLoad(0);
});
scheduleLoad(0);
