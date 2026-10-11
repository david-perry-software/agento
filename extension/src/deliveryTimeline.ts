// Presentation of `agento.mjs metrics` items as the Deliveries view's Timeline row.
// Pure: no vscode import, so the unit tests exercise it directly.

export interface TimelineRow {
  description: string;
  tooltip: string;
}

export type TimelineLookup = Pick<ReadonlyMap<string, TimelineRow>, "get">;

type UnknownRecord = Record<string, unknown>;

interface Interval {
  start: string;
  end: string | null;
  seconds: number;
  open: boolean;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < MINUTE) {
    return "<1m";
  }
  if (s < HOUR) {
    return `${Math.floor(s / MINUTE)}m`;
  }
  if (s < DAY) {
    return `${Math.floor(s / HOUR)}h ${String(Math.floor((s % HOUR) / MINUTE)).padStart(2, "0")}m`;
  }
  if (s < WEEK) {
    return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / HOUR)}h`;
  }
  return `${Math.floor(s / WEEK)}w ${Math.floor((s % WEEK) / DAY)}d`;
}

// `2026-10-09T03:02:24-04:00` → `2026-10-09 03:02 -04:00`; anything else verbatim.
function formatTimestamp(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/);
  return match ? `${match[1]} ${match[2]} ${match[3] === "Z" ? "+00:00" : match[3]}` : value;
}

function parseInterval(value: unknown, name: string): Interval | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value) || typeof value.start !== "string" || typeof value.seconds !== "number" || typeof value.open !== "boolean") {
    throw new Error(`${name} must be an interval or null`);
  }
  return { start: value.start, end: typeof value.end === "string" ? value.end : null, seconds: value.seconds, open: value.open };
}

const withOpen = (interval: Interval) => `${formatDuration(interval.seconds)}${interval.open ? "…" : ""}`;

function intervalLine(label: string, interval: Interval | null): string {
  if (!interval) {
    return `${label}: none`;
  }
  const end = interval.end ? formatTimestamp(interval.end) : "now";
  return `${label}: ${formatTimestamp(interval.start)} → ${end} (${withOpen(interval)})`;
}

export function createTimelineRow(item: unknown): TimelineRow {
  if (!isRecord(item)) {
    throw new Error("metrics item must be an object");
  }
  const phases = isRecord(item.phases) ? item.phases : {};
  const planned = parseInterval(phases.planned, "phases.planned");
  const build = parseInterval(phases.build, "phases.build");
  const review = parseInterval(phases.review, "phases.review");
  const cycle = parseInterval(item.cycle, "cycle");
  const rounds = typeof item.reviewRounds === "number" ? item.reviewRounds : 0;
  const pauses = isRecord(item.pauses) ? item.pauses : {};
  const pauseCount = typeof pauses.count === "number" ? pauses.count : 0;
  const pauseSeconds = typeof pauses.seconds === "number" ? pauses.seconds : 0;
  const pauseOpen = pauses.open === true;
  const merged = isRecord(item.merged) ? item.merged : null;
  const postShip = isRecord(item.postShip) ? item.postShip : {};
  const total = typeof postShip.total === "number" ? postShip.total : 0;
  const ticked = typeof postShip.ticked === "number" ? postShip.ticked : 0;
  const latency = typeof postShip.latencySeconds === "number" ? postShip.latencySeconds : null;
  const pending = postShip.pending === true;
  const events = Array.isArray(item.events) ? item.events : [];
  const ref = typeof item.ref === "string" ? item.ref : "unknown";
  const warnings = Array.isArray(item.warnings) ? item.warnings.filter((w): w is string => typeof w === "string") : [];

  const parts: string[] = [];
  if (planned) parts.push(`plan ${withOpen(planned)}`);
  if (build) parts.push(`build ${withOpen(build)}`);
  if (review) parts.push(`review ${withOpen(review)}`);
  if (rounds > 0) parts.push(`${rounds} ${rounds === 1 ? "round" : "rounds"}`);
  if (pauseCount > 0) parts.push(`paused ${formatDuration(pauseSeconds)}${pauseOpen ? "…" : ""}`);
  if (latency !== null) parts.push(`post-ship ${formatDuration(latency)}`);
  else if (pending) parts.push("post-ship pending");
  // A squashed or single-commit history has no phases; its cycle is still worth showing.
  if (parts.length === 0 && cycle) parts.push(`cycle ${withOpen(cycle)}`);

  const mergedLine = merged && typeof merged.at === "string"
    ? `Merged: ${formatTimestamp(merged.at)}${typeof merged.pr === "number" ? ` (PR #${merged.pr})` : ""}`
    : "Merged: none";
  const postShipLine = total === 0
    ? "Post-ship: none"
    : `Post-ship: ${ticked}/${total}${latency !== null ? `, latency ${formatDuration(latency)}` : ""}${pending ? ", pending" : ""}`;

  return {
    description: events.length === 0 ? "no history" : parts.join(" · ") || "no phases",
    tooltip: [
      intervalLine("Planned", planned),
      intervalLine("Build", build),
      intervalLine("Review", review),
      intervalLine("Cycle", cycle),
      `Review rounds: ${rounds}`,
      `Pauses: ${pauseCount}${pauseCount > 0 ? ` (${formatDuration(pauseSeconds)}${pauseOpen ? ", open" : ""})` : ""}`,
      mergedLine,
      postShipLine,
      `Source: ${ref}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ].join("\n"),
  };
}

const unavailable = (tooltip: string): TimelineLookup => ({ get: () => ({ description: "unavailable", tooltip }) });

// The `metrics` dashboard section → rows keyed by roadmap path. A section error (or a
// malformed section) yields the `unavailable` row for every key; a malformed item
// yields it for that item only.
export function createTimelineRows(metrics: unknown): TimelineLookup {
  if (metrics instanceof Error) {
    return unavailable(metrics.message);
  }
  if (!isRecord(metrics) || metrics.status !== "ok" || !Array.isArray(metrics.items)) {
    return unavailable("Invalid metrics section: status must be ok with an items array");
  }
  const rows = new Map<string, TimelineRow>();
  for (const item of metrics.items) {
    if (!isRecord(item) || typeof item.roadmap !== "string") {
      continue;
    }
    try {
      rows.set(item.roadmap, createTimelineRow(item));
    } catch (error) {
      rows.set(item.roadmap, { description: "unavailable", tooltip: `Invalid metrics item: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return rows;
}
