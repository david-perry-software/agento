import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { diff, LANES, laneFor, normalize } from "./snapshot.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "dashboard.json"), "utf8"));

const snapshot = normalize(fixture);

test("normalize produces the four kanban lanes", () => {
  assert.deepEqual(snapshot.lanes.map((l) => l.id), ["planned", "building", "in-review", "shipped"]);
  for (const lane of snapshot.lanes) assert.ok(Array.isArray(lane.cards), `lane ${lane.id} has no cards`);
});

test("laneFor maps every roadmap status to a lane", () => {
  assert.equal(laneFor("planned"), "planned");
  assert.equal(laneFor("in-progress"), "building");
  assert.equal(laneFor("paused"), "building");
  assert.equal(laneFor("in-review"), "in-review");
  assert.equal(laneFor("complete"), "shipped");
  assert.equal(laneFor("unknown-status"), "other");
});

test("cards carry the panel fields and land in the right lanes", () => {
  assert.equal(snapshot.cards.length, fixture.deliveries.items.length);
  const bySlug = new Map(snapshot.cards.map((c) => [c.slug, c]));
  assert.equal(bySlug.get("canvas-planning-fixture").lane, "planned");
  assert.equal(bySlug.get("canvas-paused-fixture").lane, "building");
  assert.equal(bySlug.get("canvas-review-fixture").lane, "in-review");
  assert.equal(bySlug.get("mission-control-canvas").lane, "building");
  for (const card of snapshot.cards) {
    for (const key of ["slug", "type", "status", "steps", "pr", "companionPr", "reviewVerdict", "owner", "allowed", "elsewhere"]) {
      assert.ok(key in card, `card ${card.slug} missing ${key}`);
    }
    assert.ok(Number.isInteger(card.steps.done) && Number.isInteger(card.steps.total));
    assert.ok(Array.isArray(card.allowed) && Array.isArray(card.elsewhere));
  }
  const buildingLane = snapshot.lanes.find((l) => l.id === "building");
  assert.ok(buildingLane.cards.some((c) => c.slug === "canvas-paused-fixture"));
  const shippedLane = snapshot.lanes.find((l) => l.id === "shipped");
  assert.equal(shippedLane.cards.length, 8);
  assert.equal(shippedLane.collapsed, 0);
});

test("normalize computes the allowed union, deduplicated", () => {
  const counts = new Map();
  for (const command of snapshot.allowed) counts.set(command, (counts.get(command) ?? 0) + 1);
  assert.ok(snapshot.allowed.includes("/agento delivery-status"));
  assert.ok([...counts.values()].every((n) => n === 1), "allowed union has duplicates");
});

test("initiatives expose waves, nodes, edges, and the blockedBy member", () => {
  const hardening = snapshot.initiatives.find((i) => i.slug === "agento-hardening");
  assert.ok(hardening, "agento-hardening initiative missing");
  assert.ok(hardening.waves.length >= 2, `expected >= 2 waves, got ${hardening.waves.length}`);
  const blocked = hardening.nodes.find((n) => n.slug === "delivery-metrics");
  assert.ok(blocked, "delivery-metrics node missing");
  assert.deepEqual(blocked.blockedBy, ["dashboard-cli"]);
  assert.ok(
    hardening.edges.some((e) => e.from === "dashboard-cli" && e.to === "delivery-metrics" && e.kind === "blocking"),
    "missing blocking edge dashboard-cli -> delivery-metrics",
  );
  assert.ok(hardening.edges.every((e) => ["requires", "recommendedAfter", "blocking"].includes(e.kind)));
});

test("timeline carries median markers and per-delivery bands", () => {
  assert.ok(snapshot.timeline.median, "median markers missing");
  assert.equal(snapshot.timeline.bands.length, fixture.metrics.items.length);
  const buildingBand = snapshot.timeline.bands.find((b) => b.slug === "mission-control-canvas");
  assert.equal(buildingBand.running, true);
  const shippedBand = snapshot.timeline.bands.find((b) => b.slug === "agento-router-skill");
  assert.equal(shippedBand.running, false);
  assert.ok(shippedBand.phases.review);
});

test("worktrees are grouped by role with the current window marked", () => {
  assert.ok(snapshot.worktrees.groups.length > 0);
  const roles = new Set(snapshot.worktrees.groups.map((g) => g.role));
  assert.ok(roles.has("build"));
  assert.ok(roles.has("primary"));
  const all = snapshot.worktrees.groups.flatMap((g) => g.worktrees);
  assert.ok(all.some((w) => w.repo === "product"));
  assert.ok(all.some((w) => w.repo === "companion"));
  assert.ok(all.some((w) => w.current), "no current worktree marked");
  const current = all.find((w) => w.current);
  assert.equal(current.path, snapshot.worktrees.current);
  const owner = all.find((w) => w.path.endsWith("plan-20261023-204459"));
  assert.equal(owner.delivery, "mission-control-canvas");
});

test("diff emits status-changed and step-ticked", () => {
  const next = structuredClone(fixture);
  const delivery = next.deliveries.items.find((d) => d.slug === "canvas-planning-fixture");
  delivery.status = "in-progress";
  delivery.lifecycle = "building";
  delivery.steps.ticked = 1;
  const events = diff(snapshot, normalize(next));
  assert.ok(events.some((e) => e.type === "status-changed" && e.slug === "canvas-planning-fixture" && e.from === "planned" && e.to === "in-progress"));
  assert.ok(events.some((e) => e.type === "step-ticked" && e.slug === "canvas-planning-fixture" && e.from === 0 && e.to === 1));
});

test("diff emits pr-opened and verdict-recorded", () => {
  const next = structuredClone(fixture);
  const delivery = next.deliveries.items.find((d) => d.slug === "canvas-review-fixture");
  delivery.pr = { number: 130, state: "OPEN" };
  delivery.reviewVerdict = "approve";
  const events = diff(snapshot, normalize(next));
  assert.ok(events.some((e) => e.type === "pr-opened" && e.slug === "canvas-review-fixture" && e.pr === 130));
  assert.ok(events.some((e) => e.type === "verdict-recorded" && e.slug === "canvas-review-fixture" && e.verdict === "approve"));
});

test("diff emits worktree-created and worktree-removed", () => {
  const next = structuredClone(fixture);
  next.session.worktrees = next.session.worktrees.filter((w) => !w.path.endsWith("plan-20261012-031857"));
  next.session.worktrees.push({ path: "/home/user/DP/agento-worktrees/plan-20261030-000000", branch: "feature/added", detached: false, role: "build", repo: "product", dirPrefix: "plan", id: "20261030-000000", isPrimary: false, isManaged: true });
  const events = diff(snapshot, normalize(next));
  assert.ok(events.some((e) => e.type === "worktree-created" && e.path.endsWith("plan-20261030-000000")));
  assert.ok(events.some((e) => e.type === "worktree-removed" && e.path.endsWith("plan-20261012-031857")));
});

test("diff emits member-unblocked when a blockedBy member clears", () => {
  const next = structuredClone(fixture);
  const hardening = next.initiatives.details["agento-hardening"];
  const first = hardening.features.find((f) => f.slug === "dashboard-cli");
  const second = hardening.features.find((f) => f.slug === "delivery-metrics");
  first.state = "complete";
  first.ready = false;
  second.blockedBy = [];
  second.ready = false;
  const events = diff(snapshot, normalize(next));
  assert.ok(events.some((e) => e.type === "member-unblocked" && e.initiative === "agento-hardening" && e.slug === "delivery-metrics"));
});

test("diff of identical snapshots is empty", () => {
  assert.deepEqual(diff(snapshot, normalize(structuredClone(fixture))), []);
});
