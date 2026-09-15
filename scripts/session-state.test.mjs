import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LIFECYCLES, NEXT_STATUSES, ROLES, classifyWorktrees, deriveAllowed, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, parseWorktreeList } from "./session-state.mjs";

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

const hostedRole = (l, cwd, env) => deriveRole({ cwd, worktrees: l.worktrees, worktreesDir: l.worktreesDir, config, env });

test("hosted: CODESPACES=true derives build from a delivery branch, ignoring the path", () => {
  const l = layout();
  // The sibling is unmanaged by path, but its branch is a feature branch.
  const r = hostedRole(l, path.join(l.base, "sibling"), { CODESPACES: "true" });
  assert.equal(r.role, "build");
  assert.equal(r.hosted, true);
  assert.match(r.reason, /^hosted-workspace: role derived from the branch \(CODESPACES=true\)$/);
  assert.equal(r.worktree.branch, "feature/elsewhere");
  assert.equal(r.worktree.path, path.join(l.base, "sibling"));
});

test("hosted: GITHUB_ACTIONS=true on the default branch derives primary; worktrees.dir is ignored", () => {
  const l = layout();
  const onMain = hostedRole(l, l.primary, { GITHUB_ACTIONS: "true" });
  assert.equal(onMain.role, "primary");
  assert.equal(onMain.hosted, true);
  assert.match(onMain.reason, /GITHUB_ACTIONS=true/);
  // A detached plan-* worktree would be `plan` by path; hosted derives from the (absent) branch.
  const detached = hostedRole(l, path.join(l.worktreesDir, "plan-fresh"), { GITHUB_ACTIONS: "true" });
  assert.equal(detached.role, "primary");
  assert.equal(detached.worktree.isManaged, true);
  // A managed freehand worktree on a non-delivery branch is `primary` under hosted rules.
  assert.equal(hostedRole(l, path.join(l.worktreesDir, "freehand-tidy"), { CODESPACES: "true" }).role, "primary");
  assert.equal(hostedRole(l, path.join(l.worktreesDir, "issue-bug"), { CODESPACES: "true" }).role, "build");
});

test("hosted: env absent, empty, or with other values leaves results unchanged (hosted: false)", () => {
  const l = layout();
  const cwd = path.join(l.base, "sibling");
  const plain = role(l, cwd);
  assert.equal(plain.hosted, false);
  assert.equal(plain.reason, undefined);
  for (const env of [undefined, {}, { CODESPACES: "false" }, { GITHUB_ACTIONS: "1" }, { HOME: "/x" }]) {
    assert.deepEqual(hostedRole(l, cwd, env), plain, JSON.stringify(env));
  }
  assert.equal(hostedRole(l, l.primary, {}).role, "primary");
  assert.equal(hostedRole(l, path.join(l.worktreesDir, "plan-fresh"), {}).role, "plan");
});

test("classifyWorktrees: one record per registered entry, primary first, stray sibling unmanaged", () => {
  const l = layout();
  const list = classifyWorktrees({ worktrees: l.worktrees, worktreesDir: l.worktreesDir, config });
  assert.equal(list.length, l.worktrees.length);
  for (const [i, entry] of list.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ["branch", "detached", "dirPrefix", "id", "isManaged", "isPrimary", "path", "role"]);
    assert.equal(entry.path, l.worktrees[i].path);
  }
  assert.deepEqual(list[0], { path: l.primary, branch: "main", detached: false, role: "primary", dirPrefix: null, id: null, isPrimary: true, isManaged: false });
  assert.deepEqual(list[1], {
    path: path.join(l.worktreesDir, "plan-20260914-015913"),
    branch: "feature/session-state-cli",
    detached: false,
    role: "build",
    dirPrefix: "plan",
    id: "20260914-015913",
    isPrimary: false,
    isManaged: true,
  });
  assert.deepEqual(list[2], { path: path.join(l.worktreesDir, "plan-fresh"), branch: null, detached: true, role: "plan", dirPrefix: "plan", id: "fresh", isPrimary: false, isManaged: true });
  assert.equal(list[3].role, "build");
  assert.equal(list[3].dirPrefix, "feature");
  assert.equal(list[4].role, "build");
  assert.equal(list[4].id, "bug");
  assert.deepEqual(list[5], { path: path.join(l.worktreesDir, "freehand-tidy"), branch: "changes/tidy", detached: false, role: "freehand", dirPrefix: "freehand", id: "tidy", isPrimary: false, isManaged: true });
  assert.deepEqual(list[6], { path: path.join(l.base, "sibling"), branch: "feature/elsewhere", detached: false, role: "unmanaged", dirPrefix: null, id: null, isPrimary: false, isManaged: false });
  assert.deepEqual(classifyWorktrees({ worktrees: [], worktreesDir: l.worktreesDir, config }), []);
});

test("findOwner: managed owner, primary owner, and none", () => {
  const l = layout();
  const owner = (branch, worktrees = l.worktrees) => findOwner({ worktrees, worktreesDir: l.worktreesDir, branch, config });
  assert.deepEqual(owner("feature/widget"), { path: path.join(l.worktreesDir, "feature-widget"), role: "build", dirPrefix: "feature", id: "widget" });
  assert.deepEqual(owner("feature/session-state-cli"), { path: path.join(l.worktreesDir, "plan-20260914-015913"), role: "build", dirPrefix: "plan", id: "20260914-015913" });
  assert.deepEqual(owner("main"), { path: l.primary, role: "primary", dirPrefix: null, id: null });
  // The primary checkout sitting on a delivery branch owns it as `primary`.
  const primaryOnFeature = [{ ...l.worktrees[0], branch: "feature/hotfix" }, ...l.worktrees.slice(1)];
  assert.deepEqual(owner("feature/hotfix", primaryOnFeature), { path: l.primary, role: "primary", dirPrefix: null, id: null });
  // An unmanaged sibling on the branch is not an owner; unknown branches have none.
  assert.equal(owner("feature/elsewhere"), null);
  assert.equal(owner("feature/nowhere"), null);
  assert.equal(owner(null), null);
  // A lookalike managed name outside worktrees.dir does not own the branch.
  fs.mkdirSync(path.join(l.base, "feature-lookalike"));
  const lookalike = [...l.worktrees, { path: path.join(l.base, "feature-lookalike"), head: "0".repeat(40), branch: "feature/lookalike", detached: false }];
  assert.equal(owner("feature/lookalike", lookalike), null);
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
  // Ship first: it audits the open worktree and tears it down after the merge (§8);
  // close-session stays allowed for abandoning the build.
  assert.deepEqual(approved.allowed, ["/agento ship widget", "/agento close-session feature/widget", "/agento delivery-status"]);
  assert.deepEqual(approved.elsewhere, []);

  assert.deepEqual(deriveAllowed({ role: "primary", lifecycle: "shipped", delivery: widget }).allowed, none.allowed);
  assert.deepEqual(deriveAllowed({ role: "primary", lifecycle: "post-ship-pending", delivery: widget }).allowed, ["/agento ship widget", "/agento delivery-status"]);
});

test("deriveAllowed: build worktree rows send ship (then close) to the primary window", () => {
  const building = deriveAllowed({ role: "build", lifecycle: "building", delivery: widget, worktree: { id: "20260914" } });
  assert.ok(building.allowed.includes("/agento build-feature widget"));
  assert.ok(building.allowed.includes("/agento delivery-status"));
  assert.equal(building.elsewhere[0].command, "/agento ship widget");
  assert.equal(building.elsewhere[0].window, "primary");
  assert.match(building.elsewhere[0].reason, /tears/);

  assert.ok(deriveAllowed({ role: "build", lifecycle: "planned", delivery: widget }).allowed.includes("/agento build-feature widget"));
  assert.ok(deriveAllowed({ role: "build", lifecycle: "paused", delivery: bug }).allowed.includes("/agento build-issue bug"));

  const review = deriveAllowed({ role: "build", lifecycle: "in-review", delivery: bug });
  assert.ok(review.allowed.includes("/agento review-issue bug"));
  assert.doesNotMatch(review.allowed.join(" "), /build-issue/);

  const approved = deriveAllowed({ role: "build", lifecycle: "approved", delivery: widget });
  assert.deepEqual(approved.allowed, ["/agento delivery-status"]);
  assert.equal(approved.elsewhere[0].command, "/agento ship widget");
  assert.equal(approved.elsewhere[0].window, "primary");
  assert.match(approved.elsewhere[0].reason, /tears/);
  assert.doesNotMatch(approved.elsewhere.map((e) => e.command).join(" "), /close-session/, "close-session is not the normal next step for an approved build");

  const planApproved = deriveAllowed({ role: "plan", lifecycle: "approved", delivery: widget });
  assert.equal(planApproved.elsewhere[0].command, "/agento ship widget");
  assert.match(planApproved.elsewhere[0].reason, /tears/);

  const none = deriveAllowed({ role: "build", lifecycle: "no-delivery", delivery: { type: "feature", slug: "fresh" } });
  assert.deepEqual(none.allowed, ["/agento delivery-status"]);
  assert.equal(none.elsewhere[0].window, "primary");

  // Shipped with the worktree still present: re-sending ship resumes at teardown
  // (§9 ship row); close-session remains for manual cleanup.
  const shipped = deriveAllowed({ role: "build", lifecycle: "shipped", delivery: widget });
  assert.deepEqual(shipped.elsewhere.map((e) => e.command), ["/agento ship widget", "/agento close-session feature/widget"]);
  assert.match(shipped.elsewhere[0].reason, /tear/);
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

// --- deriveNext -------------------------------------------------------------

const promptNames = new Set(
  fs
    .readdirSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "prompts"))
    .filter((f) => f.endsWith(".prompt.md"))
    .map((f) => f.replace(/\.prompt\.md$/, "")),
);

const emitted = [];
function next(input) {
  const result = deriveNext({ config, ...input });
  assert.ok(NEXT_STATUSES.includes(result.status), `status ${result.status}`);
  assert.ok(Array.isArray(result.candidates));
  assert.equal(typeof result.reason, "string");
  if (result.status === "ok") {
    const n = result.next;
    assert.ok(n, "ok without next");
    assert.ok(promptNames.has(n.command), `${n.command} is not a .github/prompts/ basename`);
    assert.notEqual(n.command, "ap", "/agento ap is never chosen");
    assert.ok(["here", "primary", "secondary"].includes(n.window), n.window);
    assert.equal(n.invocation, [`/agento ${n.command}`, ...n.args].join(" "));
    assert.ok(n.then === null || /^\/agento continue [a-z0-9-]+$/.test(n.then), `then: ${n.then}`);
    assert.equal(result.reason, n.reason);
    emitted.push(n.command);
  } else {
    assert.equal(result.next, null);
  }
  return result;
}

const activeDelivery = (type, slug, status, reviewVerdict = null, postShipPending = 0) =>
  roadmapRecord(type, slug, { status, reviewVerdict, review: reviewVerdict ? `${type}s/2026/09/${slug}/review.md` : null, postShipPending });
const lifecycleOf = (d) => deriveLifecycle({ delivery: d, pr: null }).lifecycle;

// Every role × lifecycle × reviewFresh cell for a window that owns a delivery.
const activeTable = [
  // [status, verdict, postShip, reviewFresh, expected command, window]
  ["planned", null, 0, null, "build-<type>", "here"],
  ["in-progress", null, 0, null, "build-<type>", "here"],
  ["paused", null, 0, null, "build-<type>", "here"],
  ["in-review", null, 0, null, "review-<type>", "here"],
  ["in-review", "request-changes", 0, true, "build-<type>", "here"],
  ["in-review", "request-changes", 0, null, "build-<type>", "here"],
  ["in-review", "request-changes", 0, false, "review-<type>", "here"],
  ["in-review", "approve", 0, true, "ship", "primary"],
  ["in-review", "approve", 0, null, "ship", "primary"],
  ["in-review", "approve", 0, false, "review-<type>", "here"],
  ["complete", "approve", 0, true, "ship", "primary"],
  ["complete", "approve", 2, true, "ship", "primary"],
];

for (const role of ["build", "plan"]) {
  test(`deriveNext: ${role} window with an active delivery, every lifecycle × reviewFresh cell`, () => {
    const seen = new Set();
    for (const [type, slug] of [["feature", "widget"], ["issue", "bug"]]) {
      for (const [status, verdict, postShip, reviewFresh, command, window] of activeTable) {
        const delivery = activeDelivery(type, slug, status, verdict, postShip);
        const lifecycle = lifecycleOf(delivery);
        seen.add(lifecycle);
        const label = `${role}/${type}/${status}/${verdict}/${postShip}/${reviewFresh}`;
        const r = next({ role, worktree: { branch: delivery.branch, dirPrefix: role, id: "x" }, delivery, lifecycle, reviewFresh });
        assert.equal(r.status, "ok", label);
        assert.equal(r.next.command, command.replace("<type>", type), label);
        assert.deepEqual(r.next.args, [slug], label);
        assert.equal(r.next.window, window, label);
        assert.equal(r.next.then, null, label);
        // The same slug as an explicit argument changes nothing.
        assert.deepEqual(next({ role, worktree: { branch: delivery.branch }, delivery, lifecycle, reviewFresh, requestedSlug: slug }), r, label);
      }
    }
    assert.deepEqual([...seen].sort(), LIFECYCLES.filter((l) => l !== "no-delivery").sort(), "every delivery lifecycle covered");
  });
}

test("deriveNext: build/plan window given another slug is blocked; build without a roadmap is blocked", () => {
  const delivery = activeDelivery("feature", "widget", "in-progress");
  for (const role of ["build", "plan"]) {
    const r = next({ role, worktree: { branch: "feature/widget" }, delivery, lifecycle: "building", requestedSlug: "other" });
    assert.equal(r.status, "blocked");
    assert.match(r.reason, /wrong window for other/);
    assert.match(r.reason, /feature\/widget/);
  }
  const fresh = next({ role: "build", worktree: { branch: "feature/fresh", dirPrefix: "plan", id: "s" }, delivery: { type: "feature", slug: "fresh", roadmap: null, status: null }, lifecycle: "no-delivery" });
  assert.equal(fresh.status, "blocked");
  assert.match(fresh.reason, /no roadmap yet/);
  const detachedBuild = next({ role: "build", worktree: { branch: null, dirPrefix: "feature", id: "w" }, delivery: null, lifecycle: "no-delivery" });
  assert.equal(detachedBuild.status, "blocked");
});

const member = (slug, initiative = "orchestration") => ({ kind: "initiative-member", slug, type: "feature", initiative, branch: `feature/${slug}` });
const deliveryCandidate = (type, slug, status, extra = {}) => ({
  kind: "delivery",
  type,
  slug,
  branch: `${type}/${slug}`,
  roadmap: `${type}s/2026/09/${slug}/roadmap.md`,
  status,
  reviewVerdict: null,
  postShipPending: 0,
  owner: null,
  reviewFresh: null,
  ...extra,
});
const managedOwner = { path: "/wt/feature-widget", role: "build", dirPrefix: "feature", id: "widget" };
const primaryOwner = { path: "/project", role: "primary", dirPrefix: null, id: null };

test("deriveNext: detached plan window drives the Planner from ready initiative members", () => {
  const plan = { role: "plan", worktree: { branch: null, detached: true, dirPrefix: "plan", id: "fresh" }, delivery: null, lifecycle: "no-delivery" };
  const one = next({ ...plan, candidates: [member("continue-command")] });
  assert.equal(one.status, "ok");
  assert.equal(one.next.command, "new-feature");
  assert.deepEqual(one.next.args, ["initiative:orchestration/continue-command"]);
  assert.equal(one.next.window, "here");
  assert.equal(one.next.then, null);

  const none = next({ ...plan, candidates: [] });
  assert.equal(none.status, "none");
  assert.match(none.reason, /\/agento new-feature <description>/);
  // Deliveries in flight elsewhere are not the plan window's business.
  assert.equal(next({ ...plan, candidates: [deliveryCandidate("feature", "widget", "in-progress")] }).status, "none");

  const many = next({ ...plan, candidates: [member("a"), member("b", "other")] });
  assert.equal(many.status, "ambiguous");
  assert.deepEqual(many.candidates.map((c) => [c.slug, c.initiative, c.invocation]), [["a", "orchestration", "/agento continue a"], ["b", "other", "/agento continue b"]]);

  const picked = next({ ...plan, candidates: [member("a"), member("b", "other")], requestedSlug: "b" });
  assert.equal(picked.status, "ok");
  assert.deepEqual(picked.next.args, ["initiative:other/b"]);
  const isDelivery = next({ ...plan, candidates: [member("a"), deliveryCandidate("feature", "widget", "in-progress")], requestedSlug: "widget" });
  assert.equal(isDelivery.status, "blocked");
  assert.match(isDelivery.reason, /existing feature delivery/);
  assert.equal(next({ ...plan, candidates: [member("a")], requestedSlug: "zzz" }).status, "missing");
});

test("deriveNext: freehand and unmanaged windows are unsupported for every lifecycle", () => {
  for (const role of ["freehand", "unmanaged"]) {
    for (const lifecycle of LIFECYCLES) {
      const r = next({ role, worktree: { branch: "changes/tidy", id: "tidy" }, delivery: null, lifecycle, candidates: [member("a")], requestedSlug: "a" });
      assert.equal(r.status, "unsupported", `${role}/${lifecycle}`);
      assert.match(r.reason, new RegExp(`role ${role}`));
    }
  }
});

const primaryWindow = { role: "primary", worktree: { branch: "main", isPrimary: true }, delivery: null, lifecycle: "no-delivery" };

test("deriveNext: primary window, one delivery candidate, every lifecycle × owner × reviewFresh cell", () => {
  const table = [
    // [status, verdict, postShip, owner, reviewFresh, expected command, args suffix, then?]
    ["planned", null, 0, null, null, "start-session", ["feature/widget"], true],
    ["planned", null, 0, managedOwner, null, "start-session", ["feature/widget", "--resume"], true],
    ["in-progress", null, 0, null, null, "start-session", ["feature/widget"], true],
    ["in-progress", null, 0, managedOwner, null, "start-session", ["feature/widget", "--resume"], true],
    ["paused", null, 0, managedOwner, null, "start-session", ["feature/widget", "--resume"], true],
    ["in-review", null, 0, managedOwner, null, "start-session", ["feature/widget", "--resume"], true],
    ["in-review", "request-changes", 0, managedOwner, true, "start-session", ["feature/widget", "--resume"], true],
    ["in-review", "request-changes", 0, null, false, "start-session", ["feature/widget"], true],
    ["in-review", "approve", 0, managedOwner, true, "ship", ["widget"], false],
    ["in-review", "approve", 0, null, true, "ship", ["widget"], false],
    ["in-review", "approve", 0, managedOwner, null, "ship", ["widget"], false],
    ["in-review", "approve", 0, managedOwner, false, "start-session", ["feature/widget", "--resume"], true],
    ["in-review", "approve", 0, null, false, "start-session", ["feature/widget"], true],
    ["complete", "approve", 2, managedOwner, true, "ship", ["widget"], false],
    ["complete", "approve", 2, null, true, "ship", ["widget"], false],
    ["complete", "approve", 0, managedOwner, true, "ship", ["widget"], false],
  ];
  const seen = new Set();
  for (const [status, verdict, postShip, owner, reviewFresh, command, args, hasThen] of table) {
    const candidate = deliveryCandidate("feature", "widget", status, { reviewVerdict: verdict, postShipPending: postShip, owner, reviewFresh });
    seen.add(lifecycleOf({ roadmap: "r", status, reviewVerdict: verdict, postShipPending: postShip }));
    const label = `${status}/${verdict}/${postShip}/${owner?.role ?? "none"}/${reviewFresh}`;
    const r = next({ ...primaryWindow, candidates: [candidate] });
    assert.equal(r.status, "ok", label);
    assert.equal(r.next.command, command, label);
    assert.deepEqual(r.next.args, args, label);
    assert.equal(r.next.window, "here", label);
    assert.equal(r.next.then, hasThen ? "/agento continue widget" : null, label);
    // The slug argument selects the same candidate; owner/reviewFresh may also arrive top-level.
    const top = next({ ...primaryWindow, candidates: [{ ...candidate, owner: undefined, reviewFresh: undefined }], owner, reviewFresh, requestedSlug: "widget" });
    assert.deepEqual(top, r, `${label} (top-level owner/reviewFresh)`);
  }
  assert.deepEqual([...seen].sort(), LIFECYCLES.filter((l) => l !== "no-delivery").sort());

  // complete with no owner: shipped, nothing to continue.
  const gone = next({ ...primaryWindow, candidates: [deliveryCandidate("feature", "widget", "complete", { reviewVerdict: "approve", owner: null, reviewFresh: true })] });
  assert.equal(gone.status, "none");
  assert.match(gone.reason, /complete/);
  // Issue deliveries use the issue prefix in start-session's argument.
  const issue = next({ ...primaryWindow, candidates: [deliveryCandidate("issue", "bug", "in-progress", { owner: { ...managedOwner, id: "bug" } })] });
  assert.deepEqual(issue.next.args, ["issue/bug", "--resume"]);
  assert.equal(issue.next.then, "/agento continue bug");
});

test("deriveNext: primary window blocked when the primary itself owns the branch or is on one", () => {
  const owned = next({ ...primaryWindow, candidates: [deliveryCandidate("feature", "widget", "in-progress", { owner: primaryOwner })] });
  assert.equal(owned.status, "blocked");
  assert.match(owned.reason, /return it to main/);
  const onBranch = next({ role: "primary", worktree: { branch: "feature/widget", isPrimary: true }, delivery: activeDelivery("feature", "widget", "in-progress"), lifecycle: "building", candidates: [] });
  assert.equal(onBranch.status, "blocked");
  assert.match(onBranch.reason, /primary checkout is on feature\/widget/);
  const unknownStatus = next({ ...primaryWindow, candidates: [deliveryCandidate("feature", "widget", "weird")] });
  assert.equal(unknownStatus.status, "blocked");
  assert.match(unknownStatus.reason, /unknown status "weird"/);
});

test("deriveNext: primary window with no slug — none, one initiative member, ambiguous; with a slug — missing", () => {
  const none = next({ ...primaryWindow, candidates: [] });
  assert.equal(none.status, "none");
  assert.match(none.reason, /\/agento new-feature <description>, \/agento new-issue, or \/agento new-initiative/);

  const ready = next({ ...primaryWindow, candidates: [member("continue-command", "workflow-orchestration")] });
  assert.equal(ready.status, "ok");
  assert.equal(ready.next.command, "start-session");
  assert.deepEqual(ready.next.args, []);
  assert.equal(ready.next.window, "here");
  assert.equal(ready.next.then, "/agento continue continue-command");
  assert.match(ready.next.reason, /workflow-orchestration/);

  const two = next({ ...primaryWindow, candidates: [deliveryCandidate("feature", "widget", "in-progress", { owner: managedOwner }), member("other")] });
  assert.equal(two.status, "ambiguous");
  assert.equal(two.next, null);
  assert.deepEqual(two.candidates, [
    { kind: "delivery", slug: "widget", type: "feature", status: "in-progress", initiative: null, owner: managedOwner, invocation: "/agento continue widget" },
    { kind: "initiative-member", slug: "other", type: "feature", status: "unplanned", initiative: "orchestration", owner: null, invocation: "/agento continue other" },
  ]);
  const chosen = next({ ...primaryWindow, candidates: two.candidates.length ? [deliveryCandidate("feature", "widget", "in-progress", { owner: managedOwner }), member("other")] : [], requestedSlug: "other" });
  assert.equal(chosen.status, "ok");
  assert.equal(chosen.next.then, "/agento continue other");

  const missing = next({ ...primaryWindow, candidates: [member("other")], requestedSlug: "nope" });
  assert.equal(missing.status, "missing");
  assert.match(missing.reason, /slug nope/);
});

test("deriveNext: every command it ever emitted exists as a prompt and is never ap", () => {
  const distinct = [...new Set(emitted)].sort();
  assert.deepEqual(distinct, ["build-feature", "build-issue", "new-feature", "review-feature", "review-issue", "ship", "start-session"]);
  for (const c of distinct) assert.ok(promptNames.has(c), c);
  assert.ok(!distinct.includes("ap"));
});
