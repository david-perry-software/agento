// Pure view-model for the "Shipped Deliveries" list: no DOM, so node:test can
// import it directly. Rows come from every shipped card in `state.cards` (the
// board lane is capped, the card list is not), joined by slug with the timeline
// band for the merge date, merged PR, and cycle time.

export const SHIPPED_PAGE_SIZE = 25;

export const DEFAULT_FILTERS = Object.freeze({
  query: "",
  type: "all",
  initiative: "all",
  within: "all",
  sort: "newest",
});

// `within` values -> days; "all" means no date limit.
export const WITHIN_DAYS = Object.freeze({ "7": 7, "30": 30, "90": 90, "365": 365 });

const DAY_MS = 24 * 60 * 60 * 1000;

export function shippedRows(state) {
  const bands = new Map((state?.timeline?.bands ?? []).map((band) => [band.slug, band]));
  const rows = [];
  for (const card of state?.cards ?? []) {
    if (card?.lane !== "shipped") continue;
    const band = bands.get(card.slug) ?? null;
    const cycle = band?.cycle && !band.cycle.open ? band.cycle.seconds ?? null : null;
    rows.push({
      slug: card.slug,
      type: card.type ?? "feature",
      initiative: card.initiative ?? null,
      pr: card.pr ?? band?.merged?.pr ?? null,
      companionPr: card.companionPr ?? null,
      shippedAt: band?.merged?.at ?? card.lastUpdated ?? null,
      cycleSeconds: cycle,
      postShipPending: card.postShipPending ?? 0,
      reviewVerdict: card.reviewVerdict ?? null,
      dir: card.dir ?? null,
    });
  }
  return rows;
}

// Distinct initiative slugs across the rows, sorted, for the initiative filter.
export function initiativeOptions(rows) {
  const seen = new Set();
  for (const row of rows) if (row.initiative) seen.add(row.initiative);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function timeOf(value) {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

function matchesQuery(row, terms) {
  if (terms.length === 0) return true;
  const haystack = [
    row.slug,
    row.type,
    row.initiative ?? "",
    row.pr != null ? `#${row.pr}` : "",
    row.companionPr != null ? `#${row.companionPr}` : "",
    row.dir ?? "",
  ].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

// Apply search, filters, and sort. `now` is injectable for tests.
export function filterShipped(rows, filters = DEFAULT_FILTERS, now = Date.now()) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const terms = String(f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const days = WITHIN_DAYS[f.within] ?? null;
  const cutoff = days == null ? null : now - days * DAY_MS;

  const result = rows.filter((row) => {
    if (f.type !== "all" && row.type !== f.type) return false;
    if (f.initiative === "none" && row.initiative) return false;
    if (f.initiative !== "all" && f.initiative !== "none" && row.initiative !== f.initiative) return false;
    if (cutoff != null) {
      const at = timeOf(row.shippedAt);
      if (at == null || at < cutoff) return false;
    }
    return matchesQuery(row, terms);
  });

  const byDate = (a, b) => (timeOf(a.shippedAt) ?? 0) - (timeOf(b.shippedAt) ?? 0);
  if (f.sort === "oldest") result.sort((a, b) => byDate(a, b) || a.slug.localeCompare(b.slug));
  else if (f.sort === "name") result.sort((a, b) => a.slug.localeCompare(b.slug));
  else result.sort((a, b) => byDate(b, a) || a.slug.localeCompare(b.slug));
  return result;
}

export function isDefaultFilters(filters) {
  return Object.keys(DEFAULT_FILTERS).every((key) => (filters?.[key] ?? DEFAULT_FILTERS[key]) === DEFAULT_FILTERS[key]);
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
