// "Shipped Deliveries" list below the board: every shipped delivery in a table,
// searchable and filterable by type, initiative, and ship date. The controls are
// static markup in index.html so typing is never interrupted by a live state
// frame; only the table (#shipped) re-renders. Filtering lives in /shipped.js.

import { deliveryHref, escapeHtml, getState, refreshPanel, registerPanel } from "/app.js";
import {
  DEFAULT_FILTERS,
  SHIPPED_PAGE_SIZE,
  filterShipped,
  formatDuration,
  initiativeOptions,
  isDefaultFilters,
  shippedRows,
} from "/shipped.js";

const filters = { ...DEFAULT_FILTERS };
let limit = SHIPPED_PAGE_SIZE;
let knownInitiatives = "";

const form = document.getElementById("shipped-controls");
const fields = {
  query: document.getElementById("shipped-query"),
  type: document.getElementById("shipped-type"),
  initiative: document.getElementById("shipped-initiative"),
  within: document.getElementById("shipped-within"),
  sort: document.getElementById("shipped-sort"),
};

function syncInitiativeOptions(rows) {
  const select = fields.initiative;
  if (!select) return;
  const options = initiativeOptions(rows);
  const key = options.join("\n");
  if (key === knownInitiatives) return;
  knownInitiatives = key;
  const fixed = [...select.querySelectorAll('option[value="all"], option[value="none"]')];
  select.replaceChildren(...fixed);
  for (const slug of options) {
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = slug;
    select.append(option);
  }
  if (!["all", "none", ...options].includes(filters.initiative)) filters.initiative = "all";
  select.value = filters.initiative;
}

function shippedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function rowMarkup(row) {
  const chips = [];
  if (row.postShipPending > 0) chips.push(`<span class="mc-chip">post-ship ${escapeHtml(row.postShipPending)}</span>`);
  const prs = [];
  if (row.pr != null) prs.push(`#${escapeHtml(row.pr)}`);
  if (row.companionPr != null) prs.push(`docs #${escapeHtml(row.companionPr)}`);
  return `<tr class="mc-shipped-row" data-slug="${escapeHtml(row.slug)}">
    <th scope="row" class="mc-shipped-slug"><a class="mc-slug-link" href="${escapeHtml(deliveryHref(row.slug))}">${escapeHtml(row.slug)}</a> ${chips.join("")}</th>
    <td><span class="mc-badge mc-badge-${escapeHtml(row.type)}">${escapeHtml(row.type)}</span></td>
    <td>${row.initiative ? escapeHtml(row.initiative) : '<span class="mc-muted">—</span>'}</td>
    <td>${prs.length ? prs.join(" · ") : '<span class="mc-muted">—</span>'}</td>
    <td><time datetime="${escapeHtml(row.shippedAt ?? "")}" title="${escapeHtml(row.shippedAt ?? "")}">${escapeHtml(shippedDate(row.shippedAt))}</time></td>
    <td>${escapeHtml(formatDuration(row.cycleSeconds)) || '<span class="mc-muted">—</span>'}</td>
  </tr>`;
}

function render(state) {
  const all = shippedRows(state);
  syncInitiativeOptions(all);
  const matches = filterShipped(all, filters);
  const shown = matches.slice(0, limit);

  const summary = document.getElementById("shipped-summary");
  if (summary) {
    summary.textContent = all.length === 0
      ? ""
      : `Showing ${shown.length} of ${matches.length}${matches.length === all.length ? " shipped" : ` matching (${all.length} shipped)`}`;
  }

  const root = document.createElement("div");
  root.className = "mc-shipped-list";
  if (all.length === 0) {
    root.innerHTML = '<p class="mc-shipped-empty">Nothing shipped yet.</p>';
    return root;
  }
  if (matches.length === 0) {
    root.innerHTML = '<p class="mc-shipped-empty">No shipped deliveries match these filters.</p>';
    return root;
  }
  const more = matches.length - shown.length;
  root.innerHTML = `<div class="mc-shipped-scroll"><table class="mc-shipped-table">
      <thead><tr>
        <th scope="col">Delivery</th><th scope="col">Type</th><th scope="col">Initiative</th>
        <th scope="col">PR</th><th scope="col">Shipped</th><th scope="col">Cycle</th>
      </tr></thead>
      <tbody>${shown.map(rowMarkup).join("")}</tbody>
    </table></div>
    ${more > 0 ? `<button type="button" class="mc-btn mc-shipped-more">Show ${Math.min(more, SHIPPED_PAGE_SIZE)} more (${more} hidden)</button>` : ""}`;
  root.querySelector(".mc-shipped-more")?.addEventListener("click", () => {
    limit += SHIPPED_PAGE_SIZE;
    refreshPanel("shipped");
  });
  return root;
}

function readForm() {
  for (const [key, field] of Object.entries(fields)) {
    if (field) filters[key] = field.value;
  }
  limit = SHIPPED_PAGE_SIZE;
  refreshPanel("shipped");
}

function resetFilters() {
  Object.assign(filters, DEFAULT_FILTERS);
  for (const [key, field] of Object.entries(fields)) {
    if (field) field.value = DEFAULT_FILTERS[key];
  }
  limit = SHIPPED_PAGE_SIZE;
}

form?.addEventListener("input", readForm);
form?.addEventListener("change", readForm);
form?.addEventListener("submit", (event) => event.preventDefault());
form?.addEventListener("reset", (event) => {
  event.preventDefault();
  resetFilters();
  refreshPanel("shipped");
  fields.query?.focus();
});

// Before a `focus` on a shipped delivery, make sure its row is rendered: clear
// filters that hide it and widen the page until it is in view. Runs synchronously
// from feed.js's focus handler, ahead of its DOM lookup.
window.addEventListener("mc:reveal", (event) => {
  const { kind, id } = event.detail ?? {};
  if (kind !== "delivery") return;
  const all = shippedRows(getState());
  if (!all.some((row) => row.slug === id)) return;
  let index = filterShipped(all, filters).findIndex((row) => row.slug === id);
  if (index === -1 && !isDefaultFilters(filters)) {
    resetFilters();
    index = filterShipped(all, filters).findIndex((row) => row.slug === id);
  }
  if (index >= limit) limit = (Math.floor(index / SHIPPED_PAGE_SIZE) + 1) * SHIPPED_PAGE_SIZE;
  refreshPanel("shipped");
});

registerPanel("shipped", render);
