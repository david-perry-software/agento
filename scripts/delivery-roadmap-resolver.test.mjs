import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "./agento-config.mjs";
import {
  closeBuildSessionDecision,
  evaluateShipPreflight,
  findLocalRoadmaps,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";

function makeGitMock({ remotePaths = [], remoteContent = new Map() } = {}) {
  return {
    lsTree: () => remotePaths.join("\n"),
    show: (target) => {
      const separator = target.indexOf(":");
      const relPath = separator === -1 ? "" : target.slice(separator + 1);
      return remoteContent.get(relPath) ?? "";
    },
  };
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agento-roadmap-"));
}

test("primary on main resolves a roadmap only on the origin feature branch", () => {
  const root = tmpRoot();
  const git = makeGitMock({
    remotePaths: ["features/2026/08/theme-switching/roadmap.md"],
    remoteContent: new Map([
      ["features/2026/08/theme-switching/roadmap.md", "status: in-review\nbranch: feature/theme-switching\n"],
    ]),
  });

  const result = resolveRoadmapArtifact({
    rootDir: root,
    type: "feature",
    slug: "theme-switching",
    currentBranch: "main",
    git,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "remote");
  assert.equal(result.branch, "feature/theme-switching");
  assert.match(result.message, /(?:resolved|Resolved).*from origin/i);
});

test("timestamped feature roadmaps still resolve exactly by the slug directory", () => {
  const root = tmpRoot();
  const file = path.join(root, "features", "2026", "08", "theme-switching", "roadmap.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "status: in-progress\nbranch: feature/theme-switching\n");

  const result = resolveRoadmapArtifact({
    rootDir: root,
    type: "feature",
    slug: "theme-switching",
    currentBranch: "main",
    git: makeGitMock({}),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "local");
  assert.equal(result.path, file.replace(/\\/g, "/"));
});

test("already-closed build sessions with the branch still on origin are not treated as a false hard-block", () => {
  const decision = closeBuildSessionDecision({
    type: "feature",
    slug: "theme-switching",
    currentBranch: "main",
    rootDir: tmpRoot(),
    worktreeList: "worktree /repo\nHEAD ...\nbranch refs/heads/main\n",
    git: makeGitMock({
      remotePaths: ["features/2026/08/theme-switching/roadmap.md"],
      remoteContent: new Map([
        ["features/2026/08/theme-switching/roadmap.md", "status: complete\nbranch: feature/theme-switching\n"],
      ]),
    }),
  });

  assert.equal(decision.status, "ok");
  assert.equal(decision.reason, "remote-roadmap-only");
  assert.match(decision.message, /no managed worktree/i);
});

test("ship preflight resolves remote fallback before failing a missing local roadmap", () => {
  const result = evaluateShipPreflight({
    type: "feature",
    slug: "theme-switching",
    rootDir: "/tmp/no-roadmap-here",
    currentBranch: "main",
    git: makeGitMock({
      remotePaths: ["features/2026/08/theme-switching/roadmap.md"],
      remoteContent: new Map([
        ["features/2026/08/theme-switching/roadmap.md", "status: in-review\nbranch: feature/theme-switching\n"],
      ]),
    }),
  });

  assert.equal(result.status, "ok");
  assert.equal(result.resolutionSource, "remote");
  assert.match(result.message, /remote fallback/i);
});

// Ownership for `/agento ship` (ship-audit-first): a managed worktree on the branch is
// the owner ship audits against and tears down; ownership never changes `status`.
function shipWorktreeList(root, config, entryDir) {
  const entry = path.resolve(root, config.worktrees.dir, entryDir);
  fs.mkdirSync(entry, { recursive: true });
  return {
    entry,
    list: `worktree ${root}\nHEAD 1111111\nbranch refs/heads/main\n\nworktree ${entry}\nHEAD 2222222\nbranch refs/heads/feature/widget\n`,
  };
}

test("ship preflight reports a managed feature worktree on the branch as owner with role build", () => {
  const { root, config } = widgetRoot();
  const { entry, list } = shipWorktreeList(root, config, "feature-widget");

  const result = evaluateShipPreflight({
    type: "feature",
    slug: "widget",
    rootDir: root,
    currentBranch: "main",
    git: makeGitMock({}),
    config,
    worktreeList: list,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.owner.path, entry);
  assert.equal(result.owner.role, "build");
  assert.equal(result.owner.dirPrefix, "feature");
});

test("ship preflight reports a promoted plan-<id> worktree on the branch as owner with dirPrefix plan", () => {
  const { root, config } = widgetRoot();
  const { entry, list } = shipWorktreeList(root, config, "plan-20260914-233032");

  const result = evaluateShipPreflight({
    type: "feature",
    slug: "widget",
    rootDir: root,
    currentBranch: "main",
    git: makeGitMock({}),
    config,
    worktreeList: list,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.owner.path, entry);
  assert.equal(result.owner.dirPrefix, "plan");
  assert.equal(result.owner.id, "20260914-233032");
  assert.equal(result.owner.role, "build");
});

test("ship preflight without a worktree list reports owner null and stays ok", () => {
  const { root, config } = widgetRoot();

  const result = evaluateShipPreflight({
    type: "feature",
    slug: "widget",
    rootDir: root,
    currentBranch: "main",
    git: makeGitMock({}),
    config,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.owner, null);
});

test("conflicting local or remote roadmaps stay hard-blocked with precise messages", () => {
  const root = tmpRoot();
  const fileA = path.join(root, "features", "slug-a", "roadmap.md");
  const fileB = path.join(root, "features", "2026", "08", "slug-a", "roadmap.md");
  fs.mkdirSync(path.dirname(fileA), { recursive: true });
  fs.mkdirSync(path.dirname(fileB), { recursive: true });
  fs.writeFileSync(fileA, "status: in-progress\nbranch: feature/slug-a\n");
  fs.writeFileSync(fileB, "status: in-progress\nbranch: feature/slug-a\n");

  const result = resolveRoadmapArtifact({
    rootDir: root,
    type: "feature",
    slug: "slug-a",
    currentBranch: "main",
    git: makeGitMock({}),
  });

  assert.equal(result.status, "conflict");
  assert.match(result.message, /multiple matching roadmaps/i);
});

test("findLocalRoadmaps filters to the requested type and slug, not any arbitrary matching file", () => {
  const root = tmpRoot();
  const issuePath = path.join(root, "issues", "2026", "08", "slug-a", "roadmap.md");
  fs.mkdirSync(path.dirname(issuePath), { recursive: true });
  fs.writeFileSync(issuePath, "status: in-progress\nbranch: issue/slug-a\n");

  const matches = findLocalRoadmaps({ rootDir: root, type: "feature", slug: "slug-a" });
  assert.deepEqual(matches, []);
});

test("custom artifact roots and branch prefixes resolve through config", () => {
  const root = tmpRoot();
  const config = defaultConfig(root);
  config.artifacts.features = "planning/features";
  config.branches.feature = "feat/";
  const file = path.join(root, "planning", "features", "2026", "09", "widget", "roadmap.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "status: in-progress\nbranch: feat/widget\n");

  const result = resolveRoadmapArtifact({
    rootDir: root,
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    git: makeGitMock({}),
    config,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "local");
  assert.equal(result.branch, "feat/widget");
});

test("a roadmap with the default branch prefix mismatches when the config renames the prefix", () => {
  const root = tmpRoot();
  const config = defaultConfig(root);
  config.branches.feature = "feat/";
  const file = path.join(root, "features", "widget", "roadmap.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "status: in-progress\nbranch: feature/widget\n");

  const result = resolveRoadmapArtifact({
    rootDir: root,
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    git: makeGitMock({}),
    config,
  });

  assert.equal(result.status, "branch-mismatch");
  assert.match(result.message, /expected feat\/widget/);
});

test("closeBuildSessionDecision detects a managed worktree from the configured worktree dir", () => {
  const root = tmpRoot();
  const config = defaultConfig(root);
  const file = path.join(root, "features", "widget", "roadmap.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "status: in-review\nbranch: feature/widget\n");

  // worktrees.dir is relative to the primary checkout (the first entry).
  const managed = path.resolve(root, config.worktrees.dir, "feature-widget");
  const decision = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    rootDir: root,
    worktreeList: `worktree ${root}\nbranch refs/heads/main\nworktree ${managed}\nbranch refs/heads/feature/widget\n`,
    git: makeGitMock({}),
    config,
  });

  assert.equal(decision.status, "ok");
  assert.equal(decision.reason, "managed-worktree-present");
  assert.deepEqual(decision.owner, { path: managed, role: "build", dirPrefix: "feature", id: "widget" });
  assert.match(decision.message, new RegExp(`managed worktree at ${managed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // A promoted planning worktree on the branch is a managed owner too.
  const plan = path.resolve(root, config.worktrees.dir, "plan-20260914-1");
  const promoted = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    rootDir: root,
    worktreeList: `worktree ${root}\nbranch refs/heads/main\n\nworktree ${plan}\nbranch refs/heads/feature/widget\n`,
    git: makeGitMock({}),
    config,
  });
  assert.equal(promoted.reason, "managed-worktree-present");
  assert.deepEqual(promoted.owner, { path: plan, role: "build", dirPrefix: "plan", id: "20260914-1" });
});

function widgetRoot() {
  const root = tmpRoot();
  const config = defaultConfig(root);
  const file = path.join(root, "features", "widget", "roadmap.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "status: in-review\nbranch: feature/widget\n");
  return { root, config };
}

test("closeBuildSessionDecision reports primary-owns-branch when the primary checkout sits on the delivery branch", () => {
  const { root, config } = widgetRoot();
  const decision = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "feature/widget",
    rootDir: root,
    worktreeList: `worktree ${root}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/feature/widget\n`,
    git: makeGitMock({}),
    config,
  });
  assert.equal(decision.status, "ok");
  assert.equal(decision.reason, "primary-owns-branch");
  assert.deepEqual(decision.owner, { path: root, role: "primary", dirPrefix: null, id: null });
  assert.match(decision.message, /return it to main first/);
  assert.match(decision.message, /no managed worktree to remove/);
});

test("closeBuildSessionDecision ignores lookalike paths outside worktrees.dir and the current branch", () => {
  const { root, config } = widgetRoot();
  const worktreesBase = path.basename(config.worktrees.dir);
  // Same basename as worktrees.dir, but not inside it: the old regex accepted this.
  const lookalike = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    rootDir: root,
    worktreeList: `worktree ${root}\nbranch refs/heads/main\nworktree /elsewhere/${worktreesBase}/feature-widget\nbranch refs/heads/feature/widget\n`,
    git: makeGitMock({}),
    config,
  });
  assert.equal(lookalike.status, "ok");
  assert.equal(lookalike.reason, "remote-roadmap-only");
  assert.equal(lookalike.owner, null);

  // currentBranch equal to the delivery branch no longer implies a managed worktree.
  const fallback = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "feature/widget",
    rootDir: root,
    worktreeList: `worktree ${root}\nbranch refs/heads/main\n`,
    git: makeGitMock({}),
    config,
  });
  assert.equal(fallback.reason, "remote-roadmap-only");
  assert.equal(fallback.owner, null);

  // An entry inside worktrees.dir on another branch is not an owner either.
  const otherBranch = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    rootDir: root,
    worktreeList: `worktree ${root}\nbranch refs/heads/main\nworktree ${path.resolve(root, config.worktrees.dir, "feature-other")}\nbranch refs/heads/feature/other\n`,
    git: makeGitMock({}),
    config,
  });
  assert.equal(otherBranch.reason, "remote-roadmap-only");
  assert.equal(otherBranch.owner, null);
});

test("evaluateShipPreflight reports owner from the worktree list and null without one", () => {
  const { root, config } = widgetRoot();
  const base = { type: "feature", slug: "widget", rootDir: root, currentBranch: "main", git: makeGitMock({}), config };

  const without = evaluateShipPreflight(base);
  assert.equal(without.status, "ok");
  assert.equal(without.owner, null);

  const managed = path.resolve(root, config.worktrees.dir, "feature-widget");
  const withManaged = evaluateShipPreflight({ ...base, worktreeList: `worktree ${root}\nbranch refs/heads/main\nworktree ${managed}\nbranch refs/heads/feature/widget\n` });
  assert.deepEqual(withManaged.owner, { path: managed, role: "build", dirPrefix: "feature", id: "widget" });

  const withPrimary = evaluateShipPreflight({ ...base, currentBranch: "feature/widget", worktreeList: `worktree ${root}\nbranch refs/heads/feature/widget\n` });
  assert.deepEqual(withPrimary.owner, { path: root, role: "primary", dirPrefix: null, id: null });

  const nobody = evaluateShipPreflight({ ...base, worktreeList: `worktree ${root}\nbranch refs/heads/main\n` });
  assert.equal(nobody.owner, null);
  assert.equal(nobody.resolutionSource, "local");
});
