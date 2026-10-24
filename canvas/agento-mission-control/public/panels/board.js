// Delivery kanban panel: Planned / Building / In Review lanes with one card per
// active delivery. Shipped deliveries are not a lane; they are listed, searchable,
// in the "Shipped Deliveries" section below the board (panels/shipped.js).
// Cards show a type badge, an animated step-progress ring, PR
// and companion-PR chips, the review verdict, the owning worktree in its role
// color, a post-ship pending count, and the delivery's dispatch buttons.
// A card's commands are runnable only from the window that owns the delivery
// (actions.js `cardButtons`); there they use the spike's dispatch label ("Run") and
// post to /dispatch. Anywhere else — and for every `elsewhere` command — the same
// "Run <command>" text renders greyed out and inert, with a tooltip naming the
// window to run it from.

import { deliveryHref, escapeHtml, roleColor, registerPanel } from "/app.js";
import { cardButtons, knownSlugs, primaryCheckout } from "/actions.js";
import { bindCommandButtons, commandButtonsHtml, progressRing } from "/commands.js";

const LANE_IDS = ["planned", "building", "in-review"];
const HIDDEN_LANES = new Set(["shipped"]);

// Window-wide commands (`continue`, `delivery-status`, `new-feature`, …) are not
// repeated on every card; they live in the header's Actions menu (panels/actions.js).
function cardActions(card, ctx) {
  return commandButtonsHtml(cardButtons(card, ctx.session, ctx.slugs, ctx.primary));
}

function cardMarkup(card, ctx) {
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

  const actions = cardActions(card, ctx);
  return `<article class="mc-card" data-slug="${escapeHtml(card.slug)}">
    <header class="mc-card-head">
      <span class="mc-badge mc-badge-${escapeHtml(card.type ?? "feature")}">${escapeHtml(card.type ?? "feature")}</span>
      <h3 class="mc-card-title"><a class="mc-slug-link" href="${escapeHtml(deliveryHref(card.slug))}">${escapeHtml(card.slug)}</a></h3>
      ${progressRing(card.steps.done, card.steps.total)}
    </header>
    <div class="mc-card-chips">${chips.join("")}</div>
    ${ownerHtml ? `<div class="mc-card-owner">${ownerHtml}</div>` : ""}
    ${actions ? `<div class="mc-card-actions">${actions}</div>` : ""}
  </article>`;
}

function laneMarkup(lane, ctx) {
  const cards = lane.cards.map((card) => cardMarkup(card, ctx)).join("");
  return `<section class="mc-lane" data-lane="${escapeHtml(lane.id)}">
    <h3 class="mc-lane-heading">${escapeHtml(lane.label)} <span class="mc-lane-count">${lane.cards.length}</span></h3>
    <div class="mc-lane-cards">${cards}</div>
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
    if (!LANE_IDS.includes(lane.id) && !HIDDEN_LANES.has(lane.id)) ordered.push(lane);
  }
  const ctx = { session: state.session ?? {}, slugs: knownSlugs(state), primary: primaryCheckout(state) };
  root.innerHTML = ordered.map((lane) => laneMarkup(lane, ctx)).join("");
  bindCommandButtons(root);

  return root;
}

registerPanel("board", render);
