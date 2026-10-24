// Window banner summary (public/window.js): the kind of window, its purpose, and
// the branch / delivery / worktree it holds.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalize } from "./snapshot.mjs";
import { ROLE_COLORS } from "./public/roles.js";
import { WINDOW_KINDS, windowSummary } from "./public/window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "dashboard.json"), "utf8"));

test("every window kind has a role color", () => {
  for (const role of Object.keys(WINDOW_KINDS)) assert.ok(ROLE_COLORS[role], role);
});

test("the fixture's build window names its branch, delivery, and worktree", () => {
  const session = { ...normalize(fixture).session, lifecycle: "building" };
  const summary = windowSummary(session);
  assert.equal(summary.role, "build");
  assert.equal(summary.label, "Build window");
  assert.deepEqual(summary.details, [
    { label: "Branch", value: "feature/mission-control-canvas" },
    { label: "Delivery", value: "feature mission-control-canvas (building)" },
    { label: "Worktree", value: "/home/user/DP/agento-worktrees/plan-20261023-204459" },
  ]);
});

test("snapshot carries the session lifecycle and hosted flag", () => {
  const session = normalize({ session: { role: "primary", hosted: true, lifecycle: "no-delivery" } }).session;
  assert.equal(session.hosted, true);
  assert.equal(session.lifecycle, "no-delivery");
});

test("a freehand window names its session id; a primary window with no delivery omits it", () => {
  const freehand = windowSummary({
    role: "freehand",
    lifecycle: "no-delivery",
    worktree: { path: "/wt/freehand-20261024-173037", branch: "changes/20261024-173037", id: "20261024-173037" },
    delivery: null,
  });
  assert.equal(freehand.label, "Freehand window");
  assert.deepEqual(freehand.details.map((d) => d.label), ["Branch", "Session", "Worktree"]);

  const primary = windowSummary({ role: "primary", lifecycle: "no-delivery", worktree: { path: "/repo", branch: "main" }, delivery: null });
  assert.deepEqual(primary.details.map((d) => d.label), ["Branch", "Worktree"]);
});

test("detached, hosted, unmanaged, and unknown windows", () => {
  assert.equal(windowSummary({ role: "build", worktree: { path: "/x", detached: true } }).details[0].value, "detached HEAD");
  assert.equal(windowSummary({ role: "build", hosted: true }).hosted, true);
  assert.equal(windowSummary({ role: "unmanaged" }).label, "Not an Agento window");
  const unknown = windowSummary({});
  assert.equal(unknown.role, "unavailable");
  assert.equal(unknown.label, "Window unknown");
  assert.deepEqual(unknown.details, []);
});
