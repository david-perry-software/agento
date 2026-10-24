// Fixture-shape tests for the sanitized dashboard recording the Mission Control
// panels render from (`fixtures/dashboard.json`). The fixture is a trimmed, home-path
// sanitized recording of `node scripts/agento.mjs dashboard`, with representative
// lanes synthesized for the statuses a live repo may not currently exhibit.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "dashboard.json");

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const serialized = JSON.stringify(fixture);

test("fixture parses as the dashboard shape", () => {
  for (const key of ["status", "session", "doctor", "deliveries", "initiatives", "metrics", "timings", "root", "configSource"]) {
    assert.ok(key in fixture, `missing top-level key ${key}`);
  }
  assert.equal(fixture.status, "ok");
  assert.ok(Array.isArray(fixture.deliveries.items), "deliveries.items is not an array");
  assert.ok(Array.isArray(fixture.metrics.items), "metrics.items is not an array");
});

test("fixture is trimmed to fewer than 40 deliveries", () => {
  assert.ok(fixture.deliveries.items.length < 40, `deliveries trimmed to ${fixture.deliveries.items.length}, expected < 40`);
});

test("fixture keeps at least one delivery per kanban lane", () => {
  const statuses = new Set(fixture.deliveries.items.map((d) => d.status));
  for (const lane of ["planned", "in-progress", "paused", "in-review", "complete"]) {
    assert.ok(statuses.has(lane), `no delivery with status ${lane}`);
  }
});

test("fixture keeps one paused delivery", () => {
  const paused = fixture.deliveries.items.filter((d) => d.status === "paused");
  assert.ok(paused.length >= 1, "no paused delivery");
  assert.equal(paused[0].lifecycle, "paused");
});

test("fixture keeps one delivery with elsewhere[] entries", () => {
  const withElsewhere = fixture.deliveries.items.filter((d) => Array.isArray(d.elsewhere) && d.elsewhere.length > 0);
  assert.ok(withElsewhere.length >= 1, "no delivery with elsewhere[]");
  assert.ok(withElsewhere.every((d) => d.elsewhere[0].command && d.elsewhere[0].window));
});

test("fixture keeps one initiative with two waves and a blockedBy member", () => {
  const details = fixture.initiatives.details ?? {};
  const matching = Object.values(details).filter(
    (init) => Array.isArray(init.waves) && init.waves.length >= 2 && (init.features ?? []).some((f) => Array.isArray(f.blockedBy) && f.blockedBy.length > 0),
  );
  assert.ok(matching.length >= 1, "no initiative with two waves and a blockedBy member");
});

test("fixture keeps the metrics events and an aggregate", () => {
  assert.ok(fixture.metrics.items.length > 0, "metrics.items is empty");
  for (const item of fixture.metrics.items) {
    assert.ok(Array.isArray(item.events) && item.events.length > 0, `metrics item ${item.slug} has no events`);
    assert.ok(item.phases && item.cycle, `metrics item ${item.slug} missing phases/cycle`);
  }
  assert.ok(fixture.metrics.aggregate, "metrics.aggregate missing");
  assert.equal(fixture.metrics.aggregate.count, fixture.metrics.items.length, "aggregate.count does not match items");
});

test("fixture home paths are sanitized", () => {
  assert.ok(!serialized.includes("/home/david"), "fixture still contains /home/david");
  assert.ok(!serialized.includes("/home/david/DP"), "fixture still contains /home/david/DP");
});

test("every delivery card field the panels read is present", () => {
  for (const d of fixture.deliveries.items) {
    for (const key of ["type", "slug", "status", "lifecycle", "steps", "postShipPending", "allowed", "elsewhere", "owner", "companion", "pr", "companionPr", "reviewVerdict"]) {
      assert.ok(key in d, `delivery ${d.slug} missing ${key}`);
    }
    assert.ok(Array.isArray(d.allowed), `delivery ${d.slug} allowed is not an array`);
    assert.ok(Array.isArray(d.elsewhere), `delivery ${d.slug} elsewhere is not an array`);
    assert.ok(Number.isInteger(d.steps.ticked) && Number.isInteger(d.steps.total), `delivery ${d.slug} steps are not integer counts`);
  }
});
