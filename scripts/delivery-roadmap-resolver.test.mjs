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

  const worktreesBase = path.basename(config.worktrees.dir);
  const decision = closeBuildSessionDecision({
    type: "feature",
    slug: "widget",
    currentBranch: "main",
    rootDir: root,
    worktreeList: `worktree /repo\nbranch refs/heads/main\nworktree /repo/../x/${worktreesBase}/feature-widget\nbranch refs/heads/feature/widget\n`,
    git: makeGitMock({}),
    config,
  });

  assert.equal(decision.status, "ok");
  assert.equal(decision.reason, "managed-worktree-present");
});
