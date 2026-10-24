// Shipped Deliveries list view-model (public/shipped.js): rows joined from the
// normalized fixture, search, filters, sort, and duration formatting.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalize } from "./snapshot.mjs";
import {
  DEFAULT_FILTERS,
  filterShipped,
  formatDuration,
  initiativeOptions,
  isDefaultFilters,
  shippedRows,
} from "./public/shipped.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "dashboard.json"), "utf8"));
const state = normalize(fixture);
const rows = shippedRows(state);
const NOW = Date.parse("2026-10-24T12:00:00Z");

test("rows cover every shipped card and only shipped cards", () => {
  const shipped = state.cards.filter((card) => card.lane === "shipped").map((card) => card.slug).sort();
  assert.deepEqual(rows.map((row) => row.slug).sort(), shipped);
  assert.equal(rows.length, 8);
});

test("rows are not capped by the board's collapsed shipped lane", () => {
  const many = {
    cards: Array.from({ length: 40 }, (_, i) => ({ slug: `d-${i}`, type: "feature", lane: "shipped", lastUpdated: "2026-10-01" })),
    timeline: { bands: [] },
  };
  assert.equal(shippedRows(many).length, 40);
});

test("rows take the merge date, merged PR, and closed cycle from the timeline band", () => {
  const row = rows.find((r) => r.slug === "agento-router-skill");
  assert.equal(row.shippedAt, "2026-10-17T06:18:40Z");
  assert.equal(row.pr, 117);
  assert.equal(row.cycleSeconds, 40492);
  assert.equal(row.initiative, "copilot-harness");
});

test("a row without a timeline band falls back to lastUpdated and no PR", () => {
  const [row] = shippedRows({ cards: [{ slug: "x", lane: "shipped", type: "issue", lastUpdated: "2026-10-02" }] });
  assert.equal(row.shippedAt, "2026-10-02");
  assert.equal(row.pr, null);
  assert.equal(row.cycleSeconds, null);
});

test("default filters sort newest shipped first", () => {
  const result = filterShipped(rows, DEFAULT_FILTERS, NOW);
  assert.equal(result.length, rows.length);
  assert.deepEqual(result.slice(0, 3).map((r) => r.slug), ["agento-router-skill", "agents-copilot-models", "artifact-preview-open"]);
  assert.equal(result.at(-1).slug, "artifact-repo-config");
});

test("search matches slug, initiative, and PR number; every term must match", () => {
  assert.deepEqual(filterShipped(rows, { query: "repo-" }, NOW).map((r) => r.slug).sort(), ["artifact-repo-config", "artifact-repo-hooks", "artifact-repo-init"]);
  assert.equal(filterShipped(rows, { query: "REPO" }, NOW).length, 4, "initiative external-artifact-repo matches too");
  assert.deepEqual(filterShipped(rows, { query: "#117" }, NOW).map((r) => r.slug), ["agento-router-skill"]);
  assert.equal(filterShipped(rows, { query: "copilot-harness" }, NOW).length, 2);
  assert.deepEqual(filterShipped(rows, { query: "artifact hooks" }, NOW).map((r) => r.slug), ["artifact-repo-hooks"]);
  assert.equal(filterShipped(rows, { query: "no-such-thing" }, NOW).length, 0);
});

test("type, initiative, and none-initiative filters", () => {
  assert.deepEqual(filterShipped(rows, { type: "issue" }, NOW).map((r) => r.slug), ["autopilot-in-review-handoff"]);
  assert.equal(filterShipped(rows, { type: "feature" }, NOW).length, 7);
  assert.equal(filterShipped(rows, { initiative: "external-artifact-repo" }, NOW).length, 4);
  assert.deepEqual(filterShipped(rows, { initiative: "none" }, NOW).map((r) => r.slug).sort(), ["artifact-preview-open", "autopilot-in-review-handoff"]);
});

test("shipped-within filter uses the merge date against now", () => {
  assert.deepEqual(filterShipped(rows, { within: "7" }, Date.parse("2026-10-18T00:00:00Z")).map((r) => r.slug), ["agento-router-skill", "agents-copilot-models"]);
  assert.equal(filterShipped(rows, { within: "7" }, NOW).length, 0, "Oct 17 06:18 is more than 7 days before Oct 24 12:00");
  assert.equal(filterShipped(rows, { within: "30" }, NOW).length, 3);
  assert.equal(filterShipped(rows, { within: "90" }, NOW).length, 8);
});

test("oldest and name sorts", () => {
  assert.equal(filterShipped(rows, { sort: "oldest" }, NOW)[0].slug, "artifact-repo-config");
  const names = filterShipped(rows, { sort: "name" }, NOW).map((r) => r.slug);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("initiative options are distinct and sorted", () => {
  assert.deepEqual(initiativeOptions(rows), ["copilot-harness", "external-artifact-repo"]);
});

test("isDefaultFilters and formatDuration", () => {
  assert.equal(isDefaultFilters({ ...DEFAULT_FILTERS }), true);
  assert.equal(isDefaultFilters({ ...DEFAULT_FILTERS, type: "issue" }), false);
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(0), "", "a zero-length recorded cycle is unknown, not 1m");
  assert.equal(formatDuration(20), "1m");
  assert.equal(formatDuration(3014), "50m");
  assert.equal(formatDuration(3585), "1.0h", "rounds to 60 minutes, so shown in hours");
  assert.equal(formatDuration(40492), "11.2h");
  assert.equal(formatDuration(5 * 86400), "5.0d");
});
