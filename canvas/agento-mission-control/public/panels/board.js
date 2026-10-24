// Delivery kanban panel: Planned / Building / In Review / Shipped lanes with one
// card per delivery. Cards show a type badge, an animated step-progress ring, PR
// and companion-PR chips, the review verdict, the owning worktree in its role
// color, a post-ship pending count, and the allowed/elsewhere dispatch buttons.
// Allowed buttons use the spike's dispatch label ("Run") and post their command
// to /dispatch; elsewhere buttons are disabled and name the window they run in.

import { escapeHtml, roleColor, registerPanel, dispatch } from "/app.js";

const LANE_IDS = ["planned", "building", "in-review", "shipped"];

function progressRing(done, total) {
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

function cardActions(card) {
  const parts = [];
  for (const command of card.allowed ?? []) {
    parts.push(
      `<button type="button" class="mc-btn mc-btn-run" data-command="${escapeHtml(command)}"
        aria-label="Run ${escapeHtml(command)}"><span class="mc-verb">Run</span> ${escapeHtml(command)}</button>`
    );
  }
  for (const entry of card.elsewhere ?? []) {
    const windowName = entry.window ?? "another";
    const command = entry.command ?? "";
    parts.push(
      `<button type="button" class="mc-btn mc-btn-elsewhere" disabled
        title="${escapeHtml(command)}" aria-label="${escapeHtml(command)} runs in ${escapeHtml(windowName)} window">runs in ${escapeHtml(windowName)} window</button>`
    );
  }
  return parts.join("");
}

function cardMarkup(card) {
  const chips = [];
  if (card.pr != null) chips.push(`<span class="mc-chip">PR #${escapeHtml(card.pr)}</span>`);
  if (card.companionPr != null) chips.push(`<span class="mc-chip">docs #${escapeHtml(card.companionPr)}</span>`);
  if (card.reviewVerdict) chips.push(`<span class="mc-chip mc-chip-verdict">${escapeHtml(card.reviewVerdict)}</span>`);
  if (card.postShipPending > 0) chips.push(`<span class="mc-chip">post-ship ${escapeHtml(card.postShipPending)}</span>`);

  const owner = card.owner;
  const ownerColors = owner ? roleColor(owner.role) : null;
  const ownerHtml = owner
    ? `<span class="mc-owner" style="background:${ownerColors.background};color:${ownerColors.foreground}" title="${escapeHtml(owner.path ?? "")}">${escapeHtml(owner.path ?? "")}</span>`
    : "";

  return `<article class="mc-card" data-slug="${escapeHtml(card.slug)}">
    <header class="mc-card-head">
      <span class="mc-badge mc-badge-${escapeHtml(card.type ?? "feature")}">${escapeHtml(card.type ?? "feature")}</span>
      <h3 class="mc-card-title">${escapeHtml(card.slug)}</h3>
      ${progressRing(card.steps.done, card.steps.total)}
    </header>
    <div class="mc-card-chips">${chips.join("")}</div>
    ${ownerHtml ? `<div class="mc-card-owner">${ownerHtml}</div>` : ""}
    <div class="mc-card-actions">${cardActions(card)}</div>
  </article>`;
}

function laneMarkup(lane) {
  const cards = lane.cards.map(cardMarkup).join("");
  const collapsed = lane.collapsed > 0
    ? `<p class="mc-collapsed">+ ${escapeHtml(lane.collapsed)} older shipped</p>`
    : "";
  return `<section class="mc-lane" data-lane="${escapeHtml(lane.id)}">
    <h3 class="mc-lane-heading">${escapeHtml(lane.label)} <span class="mc-lane-count">${lane.cards.length}</span></h3>
    <div class="mc-lane-cards">${cards}</div>
    ${collapsed}
  </section>`;
}

function render(state) {
  const root = document.createElement("div");
  root.className = "mc-board";
  const lanes = new Map((state.lanes ?? []).map((lane) => [lane.id, lane]));
  const ordered = [];
  for (const id of LANE_IDS) {
    if (lanes.has(id)) ordered.push(lanes.get(id));
  }
  for (const lane of state.lanes ?? []) {
    if (!LANE_IDS.includes(lane.id)) ordered.push(lane);
  }
  root.innerHTML = ordered.map(laneMarkup).join("");

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

  return root;
}

registerPanel("board", render);
