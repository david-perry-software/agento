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

test("harness status reports absent, installed, foreign, dangling, and not-a-link", () => {
  const { plugin, runHarness, link } = harnessFixture();
  const expected = path.join(plugin, "skills", "agento");
  const status = () => runHarness("status", "--plugin-root", plugin);

  const absent = status();
  assert.equal(absent.code, 0, JSON.stringify(absent.json));
  assert.equal(absent.json.status, "ok");
  assert.equal(absent.json.verb, "status");
  assert.equal(absent.json.link, link);
  assert.equal(absent.json.expected, expected);
  assert.equal(absent.json.pluginRoot, plugin);
  assert.equal(absent.json.state, "absent");
  assert.equal(absent.json.target, null);
  assert.equal(absent.json.changed, false);
  assert.match(absent.json.localTakeover, /Local/);

  fs.symlinkSync(expected, link, "dir");
  const installed = status();
  assert.equal(installed.json.state, "installed");
  assert.equal(installed.json.target, expected);

  fs.unlinkSync(link);
  const other = path.join(path.dirname(plugin), "other");
  fs.mkdirSync(path.join(other, "skills", "agento"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "agento", "SKILL.md"), "x");
  fs.symlinkSync(path.join(other, "skills", "agento"), link, "dir");
  const foreign = status();
  assert.equal(foreign.json.state, "foreign");
  assert.equal(foreign.json.target, path.join(other, "skills", "agento"));

  fs.unlinkSync(link);
  fs.symlinkSync(path.join(plugin, "does-not-exist"), link, "dir");
  const dangling = status();
  assert.equal(dangling.json.state, "dangling");
  assert.equal(dangling.json.target, path.join(plugin, "does-not-exist"));

  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, "SKILL.md"), "x");
  const notALink = status();
  assert.equal(notALink.json.state, "not-a-link");
  assert.equal(notALink.json.target, null);
});

test("harness install creates an idempotent link, replaces foreign/dangling with --force, and refuses a real directory", () => {
  const { plugin, runHarness, link } = harnessFixture();
  const expected = path.join(plugin, "skills", "agento");

  const created = runHarness("install", "--plugin-root", plugin);
  assert.equal(created.code, 0, JSON.stringify(created.json));
  assert.equal(created.json.status, "ok");
  assert.equal(created.json.changed, true);
  assert.equal(created.json.state, "installed");
  assert.equal(fs.readlinkSync(link), expected);

  const again = runHarness("install", "--plugin-root", plugin);
  assert.equal(again.code, 0);
  assert.equal(again.json.changed, false);
  assert.equal(again.json.state, "installed");

  // Foreign: refused without --force (untouched), replaced with --force.
  const other = path.join(path.dirname(plugin), "other");
  fs.mkdirSync(path.join(other, "skills", "agento"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "agento", "SKILL.md"), "x");
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(other, "skills", "agento"), link, "dir");
  const foreignRefused = runHarness("install", "--plugin-root", plugin);
  assert.equal(foreignRefused.code, 3);
  assert.equal(foreignRefused.json.status, "refused");
  assert.equal(fs.readlinkSync(link), path.join(other, "skills", "agento"));

  const foreignForced = runHarness("install", "--plugin-root", plugin, "--force");
  assert.equal(foreignForced.code, 0, JSON.stringify(foreignForced.json));
  assert.equal(foreignForced.json.changed, true);
  assert.equal(fs.readlinkSync(link), expected);

  // Dangling: refused without --force, replaced with --force.
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(plugin, "gone"), link, "dir");
  const danglingRefused = runHarness("install", "--plugin-root", plugin);
  assert.equal(danglingRefused.code, 3);
  assert.equal(danglingRefused.json.status, "refused");
  assert.equal(fs.readlinkSync(link), path.join(plugin, "gone"));

  const danglingForced = runHarness("install", "--plugin-root", plugin, "--force");
  assert.equal(danglingForced.code, 0);
  assert.equal(danglingForced.json.changed, true);
  assert.equal(fs.readlinkSync(link), expected);

  // Real directory: refused even with --force, left intact.
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, "SKILL.md"), "mine");
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 3);
  const dirForced = runHarness("install", "--plugin-root", plugin, "--force");
  assert.equal(dirForced.code, 3);
  assert.equal(dirForced.json.status, "refused");
  assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "mine");
});

test("harness install refuses a linked worktree naming the primary clone and reports missing without a router skill", () => {
  const { plugin, env, runHarness } = harnessFixture();

  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  const inLinked = runWith({ cwd: linked, env }, "harness", "install", "--plugin-root", linked);
  assert.equal(inLinked.code, 3, JSON.stringify(inLinked.json));
  assert.equal(inLinked.json.status, "worktree");
  assert.equal(inLinked.json.primaryCheckout, plugin);
  assert.match(inLinked.json.message, new RegExp(`--plugin-root ${plugin}$`));

  const bare = path.join(path.dirname(plugin), "bare");
  fs.mkdirSync(bare);
  const missing = runWith({ cwd: bare, env }, "harness", "install", "--plugin-root", bare);
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "missing");
  assert.match(missing.json.message, /no router skill/);
});

test("harness uninstall removes only an installed link; absent is a no-op; foreign and real directories are refused", () => {
  const { plugin, runHarness, link } = harnessFixture();
  const expected = path.join(plugin, "skills", "agento");

  const absent = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(absent.code, 0);
  assert.equal(absent.json.status, "ok");
  assert.equal(absent.json.changed, false);
  assert.equal(absent.json.state, "absent");

  assert.equal(runHarness("install", "--plugin-root", plugin).code, 0);
  const removed = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(removed.code, 0, JSON.stringify(removed.json));
  assert.equal(removed.json.changed, true);
  assert.equal(removed.json.state, "absent");
  assert.equal(fs.existsSync(link), false);
  assert.match(removed.json.warning, /\/agento will no longer resolve/);

  // Foreign: refused and untouched.
  const other = path.join(path.dirname(plugin), "other");
  fs.mkdirSync(path.join(other, "skills", "agento"), { recursive: true });
  fs.writeFileSync(path.join(other, "skills", "agento", "SKILL.md"), "x");
  fs.symlinkSync(path.join(other, "skills", "agento"), link, "dir");
  const foreign = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(foreign.code, 3);
  assert.equal(foreign.json.status, "refused");
  assert.equal(fs.readlinkSync(link), path.join(other, "skills", "agento"));

  // Real directory: refused and untouched.
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, "SKILL.md"), "mine");
  const dir = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(dir.code, 3);
  assert.equal(dir.json.status, "refused");
  assert.equal(fs.readFileSync(path.join(link, "SKILL.md"), "utf8"), "mine");

  // sanity: the expected target was never the install/uninstall source of truth for removal
  assert.ok(fs.existsSync(expected));
});

test("harness usage errors and the pure linkType helper", () => {
  const { plugin, runHarness } = harnessFixture();
  assert.equal(runHarness("bogus", "--plugin-root", plugin).code, 1);
  assert.equal(runHarness("status", "extra", "--plugin-root", plugin).code, 1);
  assert.equal(runHarness("status", "--plugin-root", plugin, "--force").code, 1);
  assert.equal(runHarness("uninstall", "--plugin-root", plugin, "--force").code, 1);

  assert.equal(linkType("win32"), "junction");
  assert.equal(linkType("linux"), "dir");
  assert.equal(linkType("darwin"), "dir");
});

test("harness install links the canvas alongside the router and reports it", () => {
  const { plugin, runHarness, link, canvasLink, canvasExpected } = harnessFixture();

  const created = runHarness("install", "--plugin-root", plugin);
  assert.equal(created.code, 0, JSON.stringify(created.json));
  assert.equal(created.json.status, "ok");
  assert.equal(fs.readlinkSync(link), path.join(plugin, "skills", "agento"));
  assert.equal(fs.readlinkSync(canvasLink), canvasExpected);
  assert.deepEqual(created.json.canvas, { link: canvasLink, expected: canvasExpected, state: "installed", target: canvasExpected, changed: true });

  const again = runHarness("install", "--plugin-root", plugin);
  assert.equal(again.code, 0);
  assert.equal(again.json.canvas.changed, false);
  assert.equal(again.json.canvas.state, "installed");

  const status = runHarness("status", "--plugin-root", plugin);
  assert.equal(status.code, 0);
  assert.equal(status.json.canvas.state, "installed");
  assert.equal(status.json.canvas.target, canvasExpected);
});

test("harness install refuses a real canvas directory and replaces foreign/dangling canvas with --force", () => {
  const { plugin, runHarness, canvasLink, canvasExpected } = harnessFixture();

  // Foreign canvas: refused without --force, replaced with --force.
  const other = path.join(path.dirname(plugin), "other-canvas");
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(other, canvasLink, "dir");
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 3);
  assert.equal(fs.readlinkSync(canvasLink), other);

  const forced = runHarness("install", "--plugin-root", plugin, "--force");
  assert.equal(forced.code, 0, JSON.stringify(forced.json));
  assert.equal(forced.json.canvas.changed, true);
  assert.equal(fs.readlinkSync(canvasLink), canvasExpected);

  // Real directory at the canvas link: refused even with --force, left intact.
  fs.unlinkSync(canvasLink);
  fs.mkdirSync(canvasLink);
  fs.writeFileSync(path.join(canvasLink, "keep.txt"), "mine");
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 3);
  const dirForced = runHarness("install", "--plugin-root", plugin, "--force");
  assert.equal(dirForced.code, 3);
  assert.equal(dirForced.json.status, "refused");
  assert.equal(fs.readFileSync(path.join(canvasLink, "keep.txt"), "utf8"), "mine");
});

test("harness uninstall removes the canvas link only when installed", () => {
  const { plugin, runHarness, canvasLink, canvasExpected } = harnessFixture();
  assert.equal(runHarness("install", "--plugin-root", plugin).code, 0);

  const removed = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(removed.code, 0, JSON.stringify(removed.json));
  assert.equal(removed.json.canvas.state, "absent");
  assert.equal(removed.json.canvas.changed, true);
  assert.equal(fs.existsSync(canvasLink), false);

  // Absent is a no-op.
  const absent = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(absent.code, 0);
  assert.equal(absent.json.canvas.changed, false);

  // Foreign canvas is refused and untouched.
  const other = path.join(path.dirname(plugin), "other-canvas");
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(other, canvasLink, "dir");
  const foreign = runHarness("uninstall", "--plugin-root", plugin);
  assert.equal(foreign.code, 3);
  assert.equal(foreign.json.status, "refused");
  assert.equal(fs.readlinkSync(canvasLink), other);

  // sanity: the expected canvas target was never removed
  assert.ok(fs.existsSync(canvasExpected));
});

test("harness install leaves the canvas link absent when the clone has no canvas", () => {
  const { plugin, runHarness, canvasLink } = harnessFixture({ canvas: false });
  const installed = runHarness("install", "--plugin-root", plugin);
  assert.equal(installed.code, 0, JSON.stringify(installed.json));
  assert.equal(installed.json.canvas.state, "absent");
  assert.equal(installed.json.canvas.changed, false);
  assert.equal(fs.existsSync(canvasLink), false);
});
