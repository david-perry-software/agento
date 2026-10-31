import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeRoadmap, reopenRoadmap } from "../delivery-roadmap-resolver.mjs";
import { linkType } from "../harness.mjs";
import { profilesHash, setHandoffModels, setModel } from "../model-profiles.mjs";
import { LIFECYCLES, SESSION_WORKSPACE_SETTINGS } from "../session-state.mjs";
import {
  assertDashboardMatches,
  baseEnv,
  both,
  byId,
  cli,
  cloneWithOrigin,
  commitAt,
  ciCheck,
  codes,
  commonDirOf,
  cloneState,
  companionOf,
  DONE_STEPS,
  git,
  gitLoggingPath,
  harnessFixture,
  inRepoDelivery,
  landBranch,
  legacyPins,
  makeDashboardRepo,
  makeFlipRepo,
  makePairRepo,
  makeRepo,
  makeWorktreeRepo,
  mergeCommitAt,
  MERGE,
  modelsFixture,
  okStubs,
  LATER,
  PARENT,
  pairDelivery,
  PASSING,
  prStub,
  publishBranch,
  publishPrRun,
  refState,
  releaseGh,
  releaseRoutes,
  releaseRun,
  repoRoot,
  restrictedPath,
  roadmapFor,
  RUNS,
  run,
  runWith,
  shippable,
  shipReady,
  shipRun,
  shipStub,
  stableMetrics,
  stepsOf,
  strip,
  T1,
  worktreeCount,
  workflowFile,
  worktreeListCalls,
  writeBreakdown,
  writeFile,
  writeRoadmap,
} from "../test-helpers/agento-fixtures.mjs";

test("config resolves the template's null worktrees.dir to an absolute sibling path", () => {
  const repo = makeRepo({ config: JSON.parse(fs.readFileSync(path.join(repoRoot, "templates", "agento.json"), "utf8")) });
  const { code, json } = run(repo, "config");
  assert.equal(code, 0);
  assert.equal(json.config.worktrees.dir, path.join(path.dirname(repo), "project-worktrees"));
  assert.equal(json.config.branches.default, "main");
  assert.equal(json.pluginRoot, repoRoot);
  // In-repo layout: the artifacts root is the checkout and artifacts.repo stays null.
  assert.equal(json.artifactsRoot, repo);
  assert.deepEqual(json.config.artifacts.repo, { name: null, dir: null });
});

test("config with artifacts.repo.name reports the sibling companion as artifactsRoot", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const { code, json } = run(repo, "config");
  assert.equal(code, 0);
  assert.equal(json.root, repo);
  assert.equal(json.artifactsRoot, companionOf(repo));
  assert.deepEqual(json.config.artifacts.repo, { name: "project-docs", dir: companionOf(repo) });
  assert.equal(json.config.artifacts.features, "features");

  // dir only: name derives from the directory basename.
  const byDir = makeRepo({ config: { artifacts: { repo: { dir: "../project-docs" } } }, companion: true });
  assert.deepEqual(run(byDir, "config").json.config.artifacts.repo, { name: "project-docs", dir: companionOf(byDir) });
});

test("resolve falls back to the origin branch when the checkout has no roadmap", () => {
  const repo = makeRepo();
  git(repo, "switch", "-q", "-c", "feature/widget");
  writeRoadmap(repo, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plan");
  git(repo, "push", "-q", "-u", "origin", "feature/widget");
  git(repo, "switch", "-q", "main");
  assert.ok(!fs.existsSync(path.join(repo, "features")));

  const { code, json } = run(repo, "resolve", "feature", "widget");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.source, "remote");
  assert.equal(json.branch, "feature/widget");

  const found = run(repo, "find", "widget");
  assert.equal(found.json.type, "feature");
  assert.equal(found.json.source, "remote");

  const ship = run(repo, "ship-preflight", "feature", "widget");
  assert.equal(ship.code, 0);
  assert.equal(ship.json.resolutionSource, "remote");

  const close = run(repo, "close-decision", "feature", "widget");
  assert.equal(close.json.reason, "remote-roadmap-only");
});

test("resolution failures exit 3 with precise statuses", () => {
  const repo = makeRepo();
  const missing = run(repo, "resolve", "issue", "nothing-here");
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "missing");

  writeRoadmap(repo, "features/2026/09/widget", "status: planned\nbranch: feature/wrong\nnext-step: 1.1");
  const mismatch = run(repo, "resolve", "feature", "widget");
  assert.equal(mismatch.code, 3);
  assert.equal(mismatch.json.status, "branch-mismatch");

  writeRoadmap(repo, "features/2026/08/widget", "status: planned\nbranch: feature/widget\nnext-step: 1.1");
  const conflict = run(repo, "resolve", "feature", "widget");
  assert.equal(conflict.json.status, "conflict");

  writeRoadmap(repo, "issues/2026/09/dup", "status: planned\nbranch: issue/dup\nnext-step: 1.1");
  writeRoadmap(repo, "features/2026/09/dup", "status: planned\nbranch: feature/dup\nnext-step: 1.1");
  const ambiguous = run(repo, "find", "dup");
  assert.equal(ambiguous.code, 3);
  assert.equal(ambiguous.json.status, "conflict");
});
