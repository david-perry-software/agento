// Delivery page (`#/delivery/<slug>`): one delivery's status, its actions (the same
// buttons its card carries, with handoff), its initiative context when it belongs
// to one, and its plan.md / roadmap.md / review.md rendered from Markdown. The
// documents come from `GET /artifacts?slug=` (`agento.mjs artifacts`) and are
// re-fetched only when the delivery's status, steps, or dates change.

import { escapeHtml, getPage, getParam, refreshPanel, registerPanel, roleColor, deliveryHref } from "/app.js";
import { cardButtons, knownSlugs, primaryCheckout } from "/actions.js";
import { bindCommandButtons, commandButtonsHtml, progressRing } from "/commands.js";
import { windowsKey } from "/handoff.js";
import { renderMarkdown } from "/markdown.js";

const DOCS = [
  ["plan", "Plan"],
  ["roadmap", "Roadmap"],
  ["review", "Review"],
];
const LANE_LABELS = { planned: "Planned", building: "Building", "in-review": "In Review", shipped: "Shipped" };
const SOURCE_LABELS = {
  worktree: "the delivery's own worktree",
  checkout: "the artifacts checkout",
};

const docsBySlug = new Map();
let activeTab = "plan";
let lastSlug = null;
let renderedKey = null;

function versionOf(card) {
  return JSON.stringify([card.status, card.lastUpdated, card.steps, card.reviewVerdict, card.nextStep]);
}

async function loadDocs(slug, version) {
  const previous = docsBySlug.get(slug);
  docsBySlug.set(slug, { version, status: "loading", data: previous?.data ?? null, error: null });
  let next;
  try {
    const res = await fetch(`/artifacts?slug=${encodeURIComponent(slug)}`);
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) throw new Error(body?.error ?? (Array.isArray(body?.errors) ? body.errors.join(", ") : `artifacts failed (${res.status})`));
    next = { version, status: body.ok ? "ok" : "missing", data: body, error: body.message ?? null };
  } catch (err) {
    next = { version, status: "error", data: previous?.data ?? null, error: err?.message ?? String(err) };
  }
  if (docsBySlug.get(slug)?.version === version) docsBySlug.set(slug, next);
  if (getPage() === "delivery" && getParam() === slug) refreshPanel("delivery");
}

function memberLink(slug, cards) {
  return cards.has(slug)
    ? `<a class="mc-slug-link" href="${escapeHtml(deliveryHref(slug))}">${escapeHtml(slug)}</a>`
    : `<span class="mc-muted-slug">${escapeHtml(slug)}</span>`;
}

function slugList(slugs, cards, empty = "none") {
  return slugs?.length ? slugs.map((s) => memberLink(s, cards)).join(", ") : `<span class="mc-muted">${escapeHtml(empty)}</span>`;
}

function initiativeMarkup(card, state) {
  if (!card.initiative) return "";
  const view = (state.initiatives ?? []).find((i) => i.slug === card.initiative);
  const cards = new Set((state.cards ?? []).map((c) => c.slug));
  if (!view) {
    return `<section class="mc-detail-section" aria-labelledby="delivery-initiative">
      <h3 id="delivery-initiative">Initiative ${escapeHtml(card.initiative)}</h3>
      <p class="mc-muted">No breakdown for this initiative is on the board.</p>
    </section>`;
  }
  const node = (view.nodes ?? []).find((n) => n.slug === card.slug);
  const facts = node
    ? `<dl class="mc-facts">
        <div><dt>Wave</dt><dd>${escapeHtml(node.wave ?? "—")}${node.declaredWave != null && node.declaredWave !== node.wave ? ` <span class="mc-muted">(declared ${escapeHtml(node.declaredWave)})</span>` : ""}</dd></div>
        <div><dt>State</dt><dd>${escapeHtml(node.state ?? "—")}${node.ready ? ' <span class="mc-chip">ready</span>' : ""}</dd></div>
        <div><dt>Requires</dt><dd>${slugList(node.requires, cards)}</dd></div>
        <div><dt>Recommended after</dt><dd>${slugList(node.recommendedAfter, cards)}</dd></div>
        <div><dt>Blocked by</dt><dd${node.blockedBy?.length ? ' class="mc-blocked"' : ""}>${slugList(node.blockedBy, cards, "nothing")}</dd></div>
      </dl>`
    : '<p class="mc-muted">This delivery is not listed in the initiative breakdown.</p>';
  const members = [...(view.nodes ?? [])].sort((a, b) => (a.wave ?? 99) - (b.wave ?? 99) || (a.order ?? 0) - (b.order ?? 0));
  const rows = members.map((m) => `<tr${m.slug === card.slug ? ' class="mc-current-row" aria-current="true"' : ""}>
      <td>${escapeHtml(m.wave ?? "—")}</td>
      <th scope="row">${m.slug === card.slug ? `<strong>${escapeHtml(m.slug)}</strong>` : memberLink(m.slug, cards)}${view.next === m.slug ? ' <span class="mc-chip">next</span>' : ""}</th>
      <td>${escapeHtml(m.state ?? "—")}</td>
      <td>${m.blockedBy?.length ? `blocked by ${slugList(m.blockedBy, cards)}` : m.ready ? "ready" : ""}</td>
    </tr>`).join("");
  return `<section class="mc-detail-section" aria-labelledby="delivery-initiative">
    <h3 id="delivery-initiative">Initiative <a class="mc-slug-link" href="#/graph" data-graph-focus="${escapeHtml(card.slug)}">${escapeHtml(view.slug)}</a>${view.done ? ' <span class="mc-chip">done</span>' : ""}</h3>
    ${facts}
    <div class="mc-detail-table"><table>
      <thead><tr><th scope="col">Wave</th><th scope="col">Member</th><th scope="col">State</th><th scope="col">Dependencies</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

function sourceNote(data) {
  if (!data) return "";
  if (data.source === "origin") return `Read from <code>${escapeHtml(data.ref ?? "origin")}</code> (not checked out here).`;
  if (data.source === "local-branch") return `Read from the local branch <code>${escapeHtml(data.ref ?? "")}</code>.`;
  return SOURCE_LABELS[data.source] ? `Read from ${SOURCE_LABELS[data.source]}.` : "";
}

function documentsMarkup(slug) {
  const entry = docsBySlug.get(slug);
  const files = entry?.data?.files ?? null;
  const available = DOCS.filter(([name]) => !files || files[name]?.exists || name !== "review");
  if (!available.some(([name]) => name === activeTab)) activeTab = "plan";
  const tabs = available.map(([name, label]) => `<button type="button" role="tab" class="mc-doc-tab" id="doc-tab-${name}"
      aria-selected="${name === activeTab}" aria-controls="doc-panel" tabindex="${name === activeTab ? 0 : -1}" data-doc-tab="${name}">${escapeHtml(label)}</button>`).join("");

  let body;
  if (!entry || (entry.status === "loading" && !files)) body = '<p class="mc-muted">Loading…</p>';
  else if (entry.status === "error" && !files) body = `<p class="mc-doc-error">${escapeHtml(entry.error ?? "Could not load the documents.")} <button type="button" class="mc-btn mc-doc-retry">Retry</button></p>`;
  else if (entry.status === "missing") body = `<p class="mc-muted">${escapeHtml(entry.error ?? "No artifacts found for this delivery.")}</p>`;
  else {
    const file = files?.[activeTab];
    body = file?.exists
      ? `<div class="mc-markdown">${renderMarkdown(file.content, { idPrefix: `${activeTab}-` })}</div>`
      : `<p class="mc-muted">This delivery has no ${escapeHtml(activeTab)}.md yet.</p>`;
  }
  const note = sourceNote(entry?.data);
  return `<section class="mc-detail-section mc-docs" aria-labelledby="delivery-docs">
    <h3 id="delivery-docs" class="mc-visually-hidden">Documents</h3>
    <div class="mc-doc-tabs" role="tablist" aria-label="Delivery documents">${tabs}</div>
    <div id="doc-panel" class="mc-doc-panel" role="tabpanel" aria-labelledby="doc-tab-${activeTab}" tabindex="0">
      ${note ? `<p class="mc-doc-source">${note}${entry?.status === "loading" ? " Refreshing…" : ""}</p>` : ""}
      ${body}
    </div>
  </section>`;
}

function headerMarkup(card) {
  const chips = [`<span class="mc-chip">${escapeHtml(LANE_LABELS[card.lane] ?? card.status ?? "")}</span>`];
  if (card.lifecycle && card.lifecycle !== card.lane) chips.push(`<span class="mc-chip">${escapeHtml(card.lifecycle)}</span>`);
  if (card.reviewVerdict) chips.push(`<span class="mc-chip mc-chip-verdict">${escapeHtml(card.reviewVerdict)}</span>`);
  if (card.pr != null) chips.push(`<span class="mc-chip">PR #${escapeHtml(card.pr)}</span>`);
  if (card.companionPr != null) chips.push(`<span class="mc-chip">docs #${escapeHtml(card.companionPr)}</span>`);
  if (card.postShipPending > 0) chips.push(`<span class="mc-chip">post-ship ${escapeHtml(card.postShipPending)}</span>`);
  const owner = card.owner;
  const colors = owner ? roleColor(owner.role) : null;
  return `<nav class="mc-breadcrumb" aria-label="Breadcrumb"><a href="#/board">Deliveries</a> <span aria-hidden="true">/</span> <span aria-current="page">${escapeHtml(card.slug)}</span></nav>
    <header class="mc-detail-head">
      <span class="mc-badge mc-badge-${escapeHtml(card.type ?? "feature")}">${escapeHtml(card.type ?? "feature")}</span>
      <h2 id="delivery-heading" tabindex="-1">${escapeHtml(card.slug)}</h2>
      ${progressRing(card.steps?.done ?? 0, card.steps?.total ?? 0)}
    </header>
    <div class="mc-card-chips">${chips.join("")}</div>
    <dl class="mc-facts">
      ${card.nextStep ? `<div><dt>Next step</dt><dd>${escapeHtml(card.nextStep)}</dd></div>` : ""}
      <div><dt>Steps</dt><dd>${escapeHtml(card.steps?.done ?? 0)} of ${escapeHtml(card.steps?.total ?? 0)} done</dd></div>
      ${card.lastUpdated ? `<div><dt>Last updated</dt><dd>${escapeHtml(card.lastUpdated)}</dd></div>` : ""}
      ${card.dir ? `<div><dt>Artifacts</dt><dd><code>${escapeHtml(card.dir)}</code></dd></div>` : ""}
      ${owner ? `<div><dt>Worktree</dt><dd><span class="mc-owner" style="background:${colors.background};color:${colors.foreground}">${escapeHtml(owner.role ?? "")}</span> <code>${escapeHtml(owner.path ?? "")}</code></dd></div>` : ""}
    </dl>`;
}

function render(state) {
  if (getPage() !== "delivery") return null;
  const slug = getParam();
  if (slug !== lastSlug) {
    activeTab = "plan";
    lastSlug = slug;
  }
  const card = (state.cards ?? []).find((c) => c.slug === slug);
  if (card) {
    const version = versionOf(card);
    if (docsBySlug.get(slug)?.version !== version) loadDocs(slug, version);
  }
  const doc = docsBySlug.get(slug);
  const initiative = card?.initiative ? (state.initiatives ?? []).find((i) => i.slug === card.initiative) ?? null : null;
  const key = JSON.stringify([slug, card, doc?.version, doc?.status, activeTab, windowsKey(), initiative, state.session?.role, state.session?.worktree?.path]);
  if (key === renderedKey) return null;
  renderedKey = key;

  const root = document.createElement("div");
  root.className = "mc-detail";
  if (!card) {
    root.innerHTML = `<nav class="mc-breadcrumb" aria-label="Breadcrumb"><a href="#/board">Deliveries</a></nav>
      <h2 id="delivery-heading" tabindex="-1">${escapeHtml(slug ?? "")}</h2>
      <p class="mc-muted">No delivery named <code>${escapeHtml(slug ?? "")}</code> is on the board.</p>`;
    return root;
  }
  const buttons = cardButtons(card, state.session ?? {}, knownSlugs(state), primaryCheckout(state));
  root.innerHTML = `${headerMarkup(card)}
    <section class="mc-detail-section" aria-labelledby="delivery-actions">
      <h3 id="delivery-actions">Actions</h3>
      ${buttons.length
        ? `<div class="mc-detail-actions">${commandButtonsHtml(buttons)}</div>`
        : '<p class="mc-muted">No commands act on this delivery now; window-wide actions are in the Actions menu.</p>'}
    </section>
    ${initiativeMarkup(card, state)}
    ${documentsMarkup(slug)}`;

  bindCommandButtons(root);
  bindDocuments(root, slug);
  root.querySelector("[data-graph-focus]")?.addEventListener("click", (event) => {
    event.preventDefault();
    const id = event.currentTarget.getAttribute("data-graph-focus");
    location.hash = "#/graph";
    setTimeout(() => window.dispatchEvent(new CustomEvent("mc:focus", { detail: { kind: "initiative", id } })), 0);
  });
  return root;
}

function selectTab(name, focus = false) {
  activeTab = name;
  refreshPanel("delivery");
  if (focus) document.getElementById(`doc-tab-${name}`)?.focus();
}

function bindDocuments(root, slug) {
  const tabs = [...root.querySelectorAll("[data-doc-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.docTab));
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.docTab, true);
    });
  });
  root.querySelector(".mc-doc-retry")?.addEventListener("click", () => {
    docsBySlug.delete(slug);
    refreshPanel("delivery");
  });
  // In-document links: another artifact switches tab; #anchor scrolls within it.
  root.querySelectorAll(".mc-markdown .md-ref").forEach((link) => {
    const activate = (event) => {
      event.preventDefault();
      if (link.dataset.doc) {
        selectTab(link.dataset.doc);
        document.getElementById("doc-panel")?.scrollIntoView({ block: "start" });
      } else if (link.dataset.anchor) {
        document.getElementById(`${activeTab}-${link.dataset.anchor}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    };
    link.addEventListener("click", activate);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter") activate(event);
    });
  });
}

registerPanel("delivery", render);
