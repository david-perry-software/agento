// Timeline/Gantt panel: one row per delivery with plan/build/review bands drawn
// from the metrics phase events, a paused count/duration badge, a vertical "now"
// line across the running phases, and per-row median-cycle markers projected from
// each delivery's cycle start. The aggregate median is also shown as a legend.

import { escapeHtml, registerPanel } from "/app.js";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LABEL_W = 180;

function ms(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
}

const BAND_STYLES = [
  ["planned", "mc-band-planned"],
  ["build", "mc-band-build"],
  ["review", "mc-band-review"],
];

function render(state) {
  const root = document.createElement("div");
  root.className = "mc-timeline";

  const bands = state.timeline?.bands ?? [];
  const median = state.timeline?.median ?? null;
  const now = Date.now();

  // Time domain: earliest phase start through the latest phase end or "now".
  let start = Infinity;
  let end = -Infinity;
  for (const band of bands) {
    for (const [key] of BAND_STYLES) {
      const phase = band.phases?.[key];
      if (!phase) continue;
      const s = ms(phase.start);
      const e = phase.open || !phase.end ? now : ms(phase.end);
      if (s != null) start = Math.min(start, s);
      if (e != null) end = Math.max(end, e);
      if (phase.open) end = Math.max(end, now);
    }
  }
  if (!isFinite(start)) start = now - DAY_MS;
  if (!isFinite(end) || end <= start) end = start + DAY_MS;
  // Small right padding so the "now" line and open bands sit just inside the edge.
  end = end + (end - start) * 0.03;

  const pos = (t) => ((t - start) / (end - start)) * 100;
  const widthFor = (a, b) => Math.max(0.2, pos(b) - pos(a));

  const rows = bands
    .map((band) => {
      const segments = [];
      for (const [key, cls] of BAND_STYLES) {
        const phase = band.phases?.[key];
        if (!phase) continue;
        const s = ms(phase.start);
        if (s == null) continue;
        const e = phase.open || !phase.end ? now : ms(phase.end);
        segments.push(
          `<span class="mc-band ${cls}" style="left:${pos(s).toFixed(2)}%;width:${widthFor(s, e).toFixed(2)}%" title="${escapeHtml(key)} ${escapeHtml(phase.start ?? "")}"></span>`
        );
      }

      let medianMarker = "";
      if (median?.cycleSeconds && band.cycle?.start) {
        const s = ms(band.cycle.start);
        if (s != null) {
          const m = s + median.cycleSeconds * 1000;
          if (m >= start && m <= end) {
            medianMarker = `<span class="mc-median" style="left:${pos(m).toFixed(2)}%" title="median cycle ${formatDuration(median.cycleSeconds)}"></span>`;
          }
        }
      }

      const paused = band.phases?.paused;
      const pausedBadge =
        paused && (paused.count > 0 || paused.open)
          ? `<span class="mc-paused" title="paused ${paused.count} time(s), ${formatDuration(paused.seconds)}">⏸ ${paused.count} · ${formatDuration(paused.seconds)}</span>`
          : "";

      const empty = segments.length === 0 && !medianMarker ? `<span class="mc-band-none">no bands</span>` : "";

      return `<div class="mc-timeline-row" data-slug="${escapeHtml(band.slug)}">
        <span class="mc-timeline-label" title="${escapeHtml(band.slug)}">${escapeHtml(band.slug)}</span>
        <div class="mc-timeline-track">${segments.join("")}${medianMarker}${empty}</div>
        ${pausedBadge}
      </div>`;
    })
    .join("");

  const legend = median
    ? `<div class="mc-timeline-legend">median cycle ${formatDuration(median.cycleSeconds)} · build ${formatDuration(median.buildSeconds)} · review ${formatDuration(median.reviewSeconds)} · planned ${formatDuration(median.plannedSeconds)} · pause ${formatDuration(median.pauseSeconds)}</div>`
    : "";

  const nowPct = pos(now).toFixed(2);
  root.innerHTML = `${legend}
    <div class="mc-timeline-body">
      <div class="mc-timeline-rows">${rows}</div>
      <div class="mc-now" style="left:calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${nowPct} / 100)" aria-hidden="true"><span>now</span></div>
    </div>`;

  return root;
}

registerPanel("timeline", render);
