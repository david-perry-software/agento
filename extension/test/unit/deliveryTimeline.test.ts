import assert from "node:assert/strict";
import test from "node:test";

import { createTimelineRow, createTimelineRows, formatDuration } from "../../src/deliveryTimeline.js";

const interval = (start: string, end: string | null, seconds: number) => ({ start, end, seconds, open: end === null });

const complete = {
  type: "feature",
  slug: "x",
  roadmap: "features/2026/10/x/roadmap.md",
  status: "complete",
  ref: "origin/main",
  events: [{ at: "2026-10-01T10:00:00+00:00", sha: "a", kind: "status", value: "planned" }],
  phases: {
    planned: interval("2026-10-01T10:00:00+00:00", "2026-10-03T10:00:00+00:00", 2 * 86400),
    build: interval("2026-10-03T10:00:00+00:00", "2026-10-08T10:00:00+00:00", 5 * 86400),
    review: interval("2026-10-08T10:00:00+00:00", "2026-10-09T10:00:00+00:00", 86400),
  },
  cycle: interval("2026-10-01T10:00:00+00:00", "2026-10-09T10:00:00+00:00", 8 * 86400),
  reviewRounds: 2,
  pauses: { count: 1, seconds: 3 * 3600, open: false },
  merged: { at: "2026-10-09T11:00:00-04:00", sha: "m", pr: 105 },
  postShip: { total: 1, ticked: 1, lastTickAt: "2026-10-09T12:00:00+00:00", latencySeconds: 600, pending: false },
  warnings: [],
};

test("formatDuration renders the compact table", () => {
  const table: Array<[number, string]> = [
    [0, "<1m"],
    [59, "<1m"],
    [60, "1m"],
    [42 * 60 + 59, "42m"],
    [3600, "1h 00m"],
    [3 * 3600 + 5 * 60, "3h 05m"],
    [86400 - 1, "23h 59m"],
    [86400, "1d 0h"],
    [2 * 86400 + 4 * 3600, "2d 4h"],
    [7 * 86400, "1w 0d"],
    [3 * 7 * 86400 + 2 * 86400 + 5 * 3600, "3w 2d"],
    [-5, "<1m"],
  ];
  for (const [seconds, expected] of table) assert.equal(formatDuration(seconds), expected, String(seconds));
});

test("createTimelineRow composes the description and lists every phase in the tooltip", () => {
  const row = createTimelineRow(complete);
  assert.equal(row.description, "plan 2d 0h · build 5d 0h · review 1d 0h · 2 rounds · paused 3h 00m · post-ship 10m");
  assert.equal(row.tooltip, [
    "Planned: 2026-10-01 10:00 +00:00 → 2026-10-03 10:00 +00:00 (2d 0h)",
    "Build: 2026-10-03 10:00 +00:00 → 2026-10-08 10:00 +00:00 (5d 0h)",
    "Review: 2026-10-08 10:00 +00:00 → 2026-10-09 10:00 +00:00 (1d 0h)",
    "Cycle: 2026-10-01 10:00 +00:00 → 2026-10-09 10:00 +00:00 (1w 1d)",
    "Review rounds: 2",
    "Pauses: 1 (3h 00m)",
    "Merged: 2026-10-09 11:00 -04:00 (PR #105)",
    "Post-ship: 1/1, latency 10m",
    "Source: origin/main",
  ].join("\n"));
});

test("createTimelineRow omits absent parts, singularises one round, and suffixes open intervals with …", () => {
  const row = createTimelineRow({
    ...complete,
    status: "in-progress",
    ref: "origin/feature/x",
    phases: { planned: null, build: interval("2026-10-01T10:00:00Z", null, 3 * 3600 + 5 * 60), review: null },
    cycle: interval("2026-10-01T10:00:00Z", null, 3 * 3600 + 5 * 60),
    reviewRounds: 1,
    pauses: { count: 1, seconds: 1800, open: true },
    merged: null,
    postShip: { total: 0, ticked: 0, lastTickAt: null, latencySeconds: null, pending: false },
    warnings: ["no in-progress transition"],
  });
  assert.equal(row.description, "build 3h 05m… · 1 round · paused 30m…");
  assert.equal(row.tooltip, [
    "Planned: none",
    "Build: 2026-10-01 10:00 +00:00 → now (3h 05m…)",
    "Review: none",
    "Cycle: 2026-10-01 10:00 +00:00 → now (3h 05m…)",
    "Review rounds: 1",
    "Pauses: 1 (30m, open)",
    "Merged: none",
    "Post-ship: none",
    "Source: origin/feature/x",
    "Warning: no in-progress transition",
  ].join("\n"));
});

test("createTimelineRow reports a pending post-ship step and no history", () => {
  const pending = createTimelineRow({ ...complete, reviewRounds: 0, pauses: { count: 0, seconds: 0, open: false }, postShip: { total: 2, ticked: 1, lastTickAt: null, latencySeconds: null, pending: true } });
  assert.equal(pending.description, "plan 2d 0h · build 5d 0h · review 1d 0h · post-ship pending");
  assert.match(pending.tooltip, /^Post-ship: 1\/2, pending$/m);
  const none = createTimelineRow({ ...complete, events: [], phases: { planned: null, build: null, review: null }, cycle: null });
  assert.equal(none.description, "no history");
  const squashed = createTimelineRow({ ...complete, phases: { planned: null, build: null, review: null }, cycle: interval("2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", 0), reviewRounds: 0, pauses: { count: 0, seconds: 0, open: false }, postShip: { total: 0, ticked: 0, lastTickAt: null, latencySeconds: null, pending: false } });
  assert.equal(squashed.description, "cycle <1m");
  assert.equal(createTimelineRow({ ...complete, phases: {}, cycle: null, reviewRounds: 0, pauses: {}, postShip: {} }).description, "no phases");
  assert.throws(() => createTimelineRow({ ...complete, cycle: { start: 1 } }), /cycle must be an interval or null/);
});

test("createTimelineRows keys rows by roadmap and falls back to unavailable on errors", () => {
  const rows = createTimelineRows({ status: "ok", items: [complete, { ...complete, roadmap: "features/2026/10/bad/roadmap.md", phases: { build: "x" } }, { slug: "no-roadmap" }] });
  assert.equal(rows.get(complete.roadmap)?.description, createTimelineRow(complete).description);
  assert.deepEqual(rows.get("features/2026/10/bad/roadmap.md"), { description: "unavailable", tooltip: "Invalid metrics item: phases.build must be an interval or null" });
  assert.equal(rows.get("features/2026/10/missing/roadmap.md"), undefined);

  const failed = createTimelineRows(new Error("git log failed"));
  assert.deepEqual(failed.get("any/roadmap.md"), { description: "unavailable", tooltip: "git log failed" });
  assert.deepEqual(createTimelineRows(null).get("any/roadmap.md"), { description: "unavailable", tooltip: "Invalid metrics section: status must be ok with an items array" });
});
