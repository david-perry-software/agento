import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveRole, parseWorktreeList } from "./session-state.mjs";

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
