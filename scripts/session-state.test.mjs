import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LIFECYCLES, ROLES, deriveAllowed, deriveDelivery, deriveLifecycle, deriveRole, parseWorktreeList } from "./session-state.mjs";

const config = { branches: { default: "main", feature: "feature/", issue: "issue/", freehand: "changes/", postShip: "post-ship/" } };

// A fake layout: <base>/project (primary), <base>/project-worktrees/<managed dirs>,
// <base>/sibling (unmanaged). Directories exist so realpath resolves them.
function layout() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-session-state-"));
  const primary = path.join(base, "project");
  const worktreesDir = path.join(base, "project-worktrees");
  const dirs = ["plan-20260914-015913", "plan-fresh", "feature-widget", "issue-bug", "freehand-tidy"];
  fs.mkdirSync(path.join(primary, "scripts"), { recursive: true });
  for (const d of dirs) fs.mkdirSync(path.join(worktreesDir, d, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(base, "sibling"), { recursive: true });
  const wt = (p, branch) => ({ path: p, head: "0".repeat(40), branch, detached: branch === null });
  const worktrees = [
    wt(primary, "main"),
    wt(path.join(worktreesDir, "plan-20260914-015913"), "feature/session-state-cli"),
    wt(path.join(worktreesDir, "plan-fresh"), null),
    wt(path.join(worktreesDir, "feature-widget"), "feature/widget"),
    wt(path.join(worktreesDir, "issue-bug"), "issue/bug"),
    wt(path.join(worktreesDir, "freehand-tidy"), "changes/tidy"),
    wt(path.join(base, "sibling"), "feature/elsewhere"),
  ];
  return { base, primary, worktreesDir, worktrees };
}

const role = (l, cwd) => deriveRole({ cwd, worktrees: l.worktrees, worktreesDir: l.worktreesDir, config });

test("parseWorktreeList handles branch, detached, and trailing blank lines", () => {
  const porcelain = [
    "worktree /home/u/agento",
    "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /home/u/agento-worktrees/plan-1",
    "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "detached",
    "",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(porcelain), [
    { path: "/home/u/agento", head: "a".repeat(40), branch: "main", detached: false },
    { path: "/home/u/agento-worktrees/plan-1", head: "b".repeat(40), branch: null, detached: true },
  ]);
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(undefined), []);
});

test("primary: cwd at or below the first worktree entry", () => {
  const l = layout();
  const top = role(l, l.primary);
  assert.equal(top.role, "primary");
  assert.equal(top.worktree.isPrimary, true);
  assert.equal(top.worktree.isManaged, false);
  assert.equal(top.worktree.branch, "main");
  assert.equal(top.worktree.path, l.primary);
  const sub = role(l, path.join(l.primary, "scripts"));
  assert.equal(sub.role, "primary");
  assert.equal(sub.worktree.path, l.primary);
});

test("plan: managed plan-* worktree that is detached", () => {
  const l = layout();
  const r = role(l, path.join(l.worktreesDir, "plan-fresh"));
  assert.equal(r.role, "plan");
  assert.deepEqual(r.worktree, {
    path: path.join(l.worktreesDir, "plan-fresh"),
    branch: null,
    detached: true,
    isPrimary: false,
    isManaged: true,
    dirPrefix: "plan",
    id: "fresh",
  });
});

test("build: promoted plan-* worktree on a feature branch (branch prefix wins over dir prefix)", () => {
  const l = layout();
  const r = role(l, path.join(l.worktreesDir, "plan-20260914-015913"));
  assert.equal(r.role, "build");
  assert.equal(r.worktree.dirPrefix, "plan");
  assert.equal(r.worktree.id, "20260914-015913");
  assert.equal(r.worktree.branch, "feature/session-state-cli");
  assert.equal(r.worktree.isManaged, true);
});

test("build: feature-* and issue-* worktrees, including from a subdirectory", () => {
  const l = layout();
  const feature = role(l, path.join(l.worktreesDir, "feature-widget", "src", "deep"));
  assert.equal(feature.role, "build");
  assert.equal(feature.worktree.path, path.join(l.worktreesDir, "feature-widget"));
  assert.equal(feature.worktree.dirPrefix, "feature");
  assert.equal(feature.worktree.id, "widget");
  const issue = role(l, path.join(l.worktreesDir, "issue-bug"));
  assert.equal(issue.role, "build");
  assert.equal(issue.worktree.branch, "issue/bug");
});

test("freehand: freehand-* worktree regardless of branch", () => {
  const l = layout();
  const r = role(l, path.join(l.worktreesDir, "freehand-tidy"));
  assert.equal(r.role, "freehand");
  assert.equal(r.worktree.dirPrefix, "freehand");
  assert.equal(r.worktree.id, "tidy");
  assert.equal(r.worktree.branch, "changes/tidy");
});

test("unmanaged: a sibling worktree outside worktrees.dir and a plain directory", () => {
  const l = layout();
  const sibling = role(l, path.join(l.base, "sibling"));
  assert.equal(sibling.role, "unmanaged");
  assert.equal(sibling.worktree.isManaged, false);
  assert.equal(sibling.worktree.branch, "feature/elsewhere");
  const plain = role(l, l.base);
  assert.equal(plain.role, "unmanaged");
  assert.equal(plain.worktree.path, l.base);
  assert.equal(plain.worktree.branch, null);
  // The worktrees dir itself is not a managed worktree.
  assert.equal(role(l, l.worktreesDir).role, "unmanaged");
  // A managed-looking name outside worktrees.dir is not managed.
  fs.mkdirSync(path.join(l.base, "feature-stray"));
  assert.equal(role(l, path.join(l.base, "feature-stray")).role, "unmanaged");
});

test("symlinked paths compare by realpath on both sides", () => {
  const l = layout();
  const link = path.join(l.base, "link-to-widget");
  fs.symlinkSync(path.join(l.worktreesDir, "feature-widget"), link);
  const viaLink = role(l, path.join(link, "src"));
  assert.equal(viaLink.role, "build");
  assert.equal(viaLink.worktree.path, path.join(l.worktreesDir, "feature-widget"));

  const linkedDir = path.join(l.base, "link-to-worktrees");
  fs.symlinkSync(l.worktreesDir, linkedDir);
  const viaDir = deriveRole({ cwd: path.join(l.worktreesDir, "issue-bug"), worktrees: l.worktrees, worktreesDir: linkedDir, config });
  assert.equal(viaDir.role, "build");

  const primaryLink = path.join(l.base, "link-to-primary");
  fs.symlinkSync(l.primary, primaryLink);
  assert.equal(role(l, primaryLink).role, "primary");
});

test("empty worktree list still classifies by directory", () => {
  const l = layout();
  const r = deriveRole({ cwd: path.join(l.worktreesDir, "feature-widget"), worktrees: [], worktreesDir: l.worktreesDir, config });
  assert.equal(r.role, "plan");
  assert.equal(r.worktree.branch, null);
  assert.equal(r.worktree.dirPrefix, "feature");
  assert.equal(r.worktree.path, path.join(l.worktreesDir, "feature-widget"));
});

// Shape of agento.mjs describe() output.
function roadmapRecord(type, slug, overrides = {}) {
  return {
    type,
    slug,
    dir: `${type}s/2026/09/${slug}`,
    roadmap: `${type}s/2026/09/${slug}/roadmap.md`,
    plan: `${type}s/2026/09/${slug}/plan.md`,
    review: null,
    reviewVerdict: null,
    status: "planned",
    branch: `${type}/${slug}`,
    lastUpdated: "2026-09-13",
    nextStep: "1.1",
    githubIssue: null,
    initiative: null,
    steps: { ticked: 0, total: 3 },
    postShipPending: 0,
    ...overrides,
  };
}

test("deriveDelivery: branch prefix decides type/slug and merges the matching roadmap", () => {
  const roadmaps = [roadmapRecord("feature", "widget", { status: "in-progress" }), roadmapRecord("issue", "widget", { status: "paused", githubIssue: "#7" })];
  const feature = deriveDelivery({ branch: "feature/widget", dirPrefix: "plan", id: "x", roadmaps, config });
  assert.equal(feature.type, "feature");
  assert.equal(feature.slug, "widget");
  assert.equal(feature.status, "in-progress");
  assert.equal(feature.roadmap, "features/2026/09/widget/roadmap.md");
  assert.deepEqual(feature.steps, { ticked: 0, total: 3 });
  const issue = deriveDelivery({ branch: "issue/widget", dirPrefix: null, id: null, roadmaps, config });
  assert.equal(issue.type, "issue");
  assert.equal(issue.status, "paused");
  assert.equal(issue.githubIssue, "#7");
});

test("deriveDelivery: no roadmap yet yields null roadmap fields; non-delivery branches yield null", () => {
  const fresh = deriveDelivery({ branch: "feature/new-thing", dirPrefix: "plan", id: "s", roadmaps: [], config });
  assert.equal(fresh.type, "feature");
  assert.equal(fresh.slug, "new-thing");
  assert.equal(fresh.branch, "feature/new-thing");
  assert.equal(fresh.roadmap, null);
  assert.equal(fresh.status, null);
  assert.equal(fresh.steps, null);
  assert.equal(fresh.postShipPending, 0);
  assert.equal(deriveDelivery({ branch: "main", dirPrefix: null, id: null, roadmaps: [], config }), null);
  assert.equal(deriveDelivery({ branch: "changes/tidy", dirPrefix: "freehand", id: "tidy", roadmaps: [], config }), null);
  assert.equal(deriveDelivery({ branch: "feature/", dirPrefix: null, id: null, roadmaps: [], config }), null);
  assert.equal(deriveDelivery({ branch: null, dirPrefix: "plan", id: "20260914", roadmaps: [], config }), null);
});

test("deriveDelivery: detached feature-/issue- directories fall back to the directory name", () => {
  const roadmaps = [roadmapRecord("issue", "bug", { status: "in-review" })];
  const d = deriveDelivery({ branch: null, dirPrefix: "issue", id: "bug", roadmaps, config });
  assert.equal(d.type, "issue");
  assert.equal(d.slug, "bug");
  assert.equal(d.status, "in-review");
  assert.equal(d.branch, "issue/bug");
});

test("deriveDelivery honours custom branch prefixes", () => {
  const custom = { branches: { ...config.branches, feature: "feat/", issue: "fix/" } };
  assert.equal(deriveDelivery({ branch: "feat/x", roadmaps: [], config: custom }).type, "feature");
  assert.equal(deriveDelivery({ branch: "fix/x", roadmaps: [], config: custom }).type, "issue");
  assert.equal(deriveDelivery({ branch: "feature/x", roadmaps: [], config: custom }), null);
  assert.equal(deriveDelivery({ branch: null, dirPrefix: "feature", id: "x", roadmaps: [], config: custom }).branch, "feat/x");
});

test("deriveLifecycle: every lifecycle value from its roadmap/review inputs", () => {
  const d = (overrides) => roadmapRecord("feature", "widget", overrides);
  const table = [
    [{ delivery: null }, "no-delivery"],
    [{ delivery: { type: "feature", slug: "w", roadmap: null, status: null } }, "no-delivery"],
    [{ delivery: d({ status: "planned" }) }, "planned"],
    [{ delivery: d({ status: "in-progress" }) }, "building"],
    [{ delivery: d({ status: "paused" }) }, "paused"],
    [{ delivery: d({ status: "in-review", reviewVerdict: null }) }, "in-review"],
    [{ delivery: d({ status: "in-review", reviewVerdict: "request-changes" }) }, "in-review"],
    [{ delivery: d({ status: "in-review", reviewVerdict: "approve" }) }, "approved"],
    [{ delivery: d({ status: "complete", postShipPending: 0 }) }, "shipped"],
    [{ delivery: d({ status: "complete", postShipPending: 2 }) }, "post-ship-pending"],
  ];
  const produced = new Set();
  for (const [input, expected] of table) {
    const { lifecycle, warnings } = deriveLifecycle({ ...input, pr: null });
    assert.equal(lifecycle, expected, JSON.stringify(input));
    assert.deepEqual(warnings, []);
    produced.add(lifecycle);
  }
  assert.deepEqual([...produced].sort(), [...LIFECYCLES].sort());
});

test("deriveLifecycle: PR state only warns and never changes the lifecycle", () => {
  const d = roadmapRecord("feature", "widget", { status: "in-progress" });
  const merged = deriveLifecycle({ delivery: d, pr: { number: 15, state: "MERGED" } });
  assert.equal(merged.lifecycle, "building");
  assert.equal(merged.warnings.length, 1);
  assert.match(merged.warnings[0], /^merged-but-not-complete: PR #15 for feature\/widget/);
  const open = deriveLifecycle({ delivery: d, pr: { number: 15, state: "OPEN" } });
  assert.deepEqual(open, { lifecycle: "building", warnings: [] });
  const complete = deriveLifecycle({ delivery: roadmapRecord("feature", "widget", { status: "complete" }), pr: { number: 15, state: "MERGED" } });
  assert.deepEqual(complete, { lifecycle: "shipped", warnings: [] });
  const unknown = deriveLifecycle({ delivery: roadmapRecord("feature", "widget", { status: "weird" }), pr: null });
  assert.equal(unknown.lifecycle, "no-delivery");
  assert.match(unknown.warnings[0], /^unknown-roadmap-status/);
});

const widget = { type: "feature", slug: "widget" };
const bug = { type: "issue", slug: "bug" };

test("deriveAllowed: one row per role × lifecycle, concrete commands, no placeholders", () => {
  for (const role of ROLES) {
    for (const lifecycle of LIFECYCLES) {
      const { allowed, elsewhere } = deriveAllowed({ role, lifecycle, delivery: widget, worktree: { id: "x" } });
      assert.ok(Array.isArray(allowed) && Array.isArray(elsewhere), `${role}/${lifecycle}`);
      assert.ok(allowed.length + elsewhere.length > 0, `${role}/${lifecycle} has no commands`);
      for (const cmd of allowed) assert.match(cmd, /^\/agento [a-z-]+/, `${role}/${lifecycle}: ${cmd}`);
      for (const cmd of [...allowed, ...elsewhere.map((e) => e.command)]) assert.doesNotMatch(cmd, /<type>|<slug>/, `${role}/${lifecycle}: ${cmd}`);
      for (const e of elsewhere) {
        assert.ok(["primary", "secondary"].includes(e.window), `${role}/${lifecycle}: ${e.window}`);
        assert.ok(typeof e.reason === "string" && e.reason.length > 0);
      }
    }
  }
});

test("deriveAllowed: primary window rows", () => {
  const none = deriveAllowed({ role: "primary", lifecycle: "no-delivery", delivery: null, worktree: {} });
  assert.ok(none.allowed.includes("/agento start-session"));
  assert.ok(none.allowed.includes("/agento new-feature"));
  assert.ok(none.allowed.includes("/agento new-issue"));
  assert.ok(none.allowed.includes("/agento new-initiative"));
  assert.ok(none.allowed.includes("/agento delivery-status"));
  assert.deepEqual(none.elsewhere, []);

  const planned = deriveAllowed({ role: "primary", lifecycle: "planned", delivery: widget });
  assert.ok(planned.allowed.includes("/agento start-session feature/widget"));
  assert.deepEqual(planned.elsewhere.map((e) => [e.command, e.window]), [["/agento build-feature widget", "secondary"]]);

  const building = deriveAllowed({ role: "primary", lifecycle: "building", delivery: bug });
  assert.ok(building.allowed.includes("/agento start-session issue/bug --resume"));
  assert.deepEqual(building.elsewhere.map((e) => e.command), ["/agento build-issue bug"]);

  const review = deriveAllowed({ role: "primary", lifecycle: "in-review", delivery: widget });
  assert.deepEqual(review.elsewhere.map((e) => [e.command, e.window]), [["/agento review-feature widget", "secondary"]]);

  const approved = deriveAllowed({ role: "primary", lifecycle: "approved", delivery: widget });
  assert.deepEqual(approved.allowed, ["/agento close-session feature/widget", "/agento ship widget", "/agento delivery-status"]);
  assert.deepEqual(approved.elsewhere, []);

  assert.deepEqual(deriveAllowed({ role: "primary", lifecycle: "shipped", delivery: widget }).allowed, none.allowed);
  assert.deepEqual(deriveAllowed({ role: "primary", lifecycle: "post-ship-pending", delivery: widget }).allowed, ["/agento ship widget", "/agento delivery-status"]);
});

test("deriveAllowed: build worktree rows send close/ship to the primary window", () => {
  const building = deriveAllowed({ role: "build", lifecycle: "building", delivery: widget, worktree: { id: "20260914" } });
  assert.ok(building.allowed.includes("/agento build-feature widget"));
  assert.ok(building.allowed.includes("/agento delivery-status"));
  const ship = building.elsewhere.find((e) => e.command === "/agento ship widget");
  assert.equal(ship.window, "primary");
  const close = building.elsewhere.find((e) => e.command === "/agento close-session feature/widget");
  assert.equal(close.window, "primary");

  assert.ok(deriveAllowed({ role: "build", lifecycle: "planned", delivery: widget }).allowed.includes("/agento build-feature widget"));
  assert.ok(deriveAllowed({ role: "build", lifecycle: "paused", delivery: bug }).allowed.includes("/agento build-issue bug"));

  const review = deriveAllowed({ role: "build", lifecycle: "in-review", delivery: bug });
  assert.ok(review.allowed.includes("/agento review-issue bug"));
  assert.doesNotMatch(review.allowed.join(" "), /build-issue/);

  const approved = deriveAllowed({ role: "build", lifecycle: "approved", delivery: widget });
  assert.deepEqual(approved.allowed, ["/agento delivery-status"]);
  assert.deepEqual(approved.elsewhere.map((e) => [e.command, e.window]), [
    ["/agento close-session feature/widget", "primary"],
    ["/agento ship widget", "primary"],
  ]);

  const none = deriveAllowed({ role: "build", lifecycle: "no-delivery", delivery: { type: "feature", slug: "fresh" } });
  assert.deepEqual(none.allowed, ["/agento delivery-status"]);
  assert.equal(none.elsewhere[0].window, "primary");

  assert.deepEqual(deriveAllowed({ role: "build", lifecycle: "shipped", delivery: widget }).elsewhere.map((e) => e.command), ["/agento close-session feature/widget"]);
  assert.deepEqual(deriveAllowed({ role: "build", lifecycle: "post-ship-pending", delivery: widget }).elsewhere.map((e) => e.command), ["/agento ship widget"]);
});

test("deriveAllowed: plan worktree offers the planners; freehand and unmanaged are fixed", () => {
  const plan = deriveAllowed({ role: "plan", lifecycle: "no-delivery", delivery: null, worktree: { id: "20260914-015913" } });
  assert.deepEqual(plan.allowed, ["/agento new-feature", "/agento new-issue", "/agento delivery-status"]);
  assert.deepEqual(plan.elsewhere, []);

  for (const lifecycle of LIFECYCLES) {
    const freehand = deriveAllowed({ role: "freehand", lifecycle, delivery: null, worktree: { id: "tidy" } });
    assert.deepEqual(freehand, { allowed: ["/agento finish-freehand tidy", "/agento commit-current-changes"], elsewhere: [] });

    const unmanaged = deriveAllowed({ role: "unmanaged", lifecycle, delivery: widget, worktree: { id: null } });
    assert.deepEqual(unmanaged.allowed, []);
    assert.deepEqual(unmanaged.elsewhere.map((e) => [e.command, e.window]), [["/agento start-session", "primary"]]);
  }
});

test("deriveAllowed: unknown role or lifecycle yields empty lists", () => {
  assert.deepEqual(deriveAllowed({ role: "mystery", lifecycle: "building", delivery: widget }), { allowed: [], elsewhere: [] });
  assert.deepEqual(deriveAllowed({ role: "build", lifecycle: "mystery", delivery: widget }), { allowed: [], elsewhere: [] });
});
