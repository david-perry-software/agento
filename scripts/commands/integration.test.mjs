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

test("status, initiative, session, and next read the companion and ignore in-repo roots", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  // Pre-migration leftovers in the product repo must not appear anywhere.
  writeRoadmap(repo, "features/2026/09/stale", "status: in-progress\nbranch: feature/stale\nnext-step: \"1.2\"");
  writeBreakdown(repo, "initiatives/2026/09/stale-init", null, [{ slug: "stale" }]);
  writeRoadmap(docs, "features/2026/09/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2 todo"');
  writeRoadmap(docs, "issues/2026/09/bug", "status: planned\nbranch: issue/bug\nnext-step: \"1.1\"");
  writeBreakdown(docs, "initiatives/2026/09/demo", null, [{ slug: "alpha" }, { slug: "beta", requires: ["alpha"] }]);

  const status = run(repo, "status");
  assert.equal(status.code, 0);
  assert.equal(status.json.root, repo);
  assert.deepEqual(status.json.items.map((i) => [i.type, i.slug, i.roadmap]), [
    ["feature", "alpha", "features/2026/09/alpha/roadmap.md"],
    ["issue", "bug", "issues/2026/09/bug/roadmap.md"],
  ]);
  assert.deepEqual(status.json.resumable, ["alpha"]);

  const list = run(repo, "initiative");
  assert.deepEqual(list.json.items.map((i) => [i.slug, i.dir, i.total, i.inFlight]), [["demo", "initiatives/2026/09/demo", 2, 1]]);
  const demo = run(repo, "initiative", "demo");
  assert.equal(demo.code, 0);
  assert.equal(demo.json.initiative.breakdown, "initiatives/2026/09/demo/breakdown.md");
  assert.deepEqual(demo.json.features.map((f) => [f.slug, f.state]), [["alpha", "in-progress"], ["beta", "unplanned"]]);
  assert.equal(run(repo, "initiative", "stale-init").json.status, "missing");

  const session = run(repo, "session").json;
  assert.equal(session.role, "primary");
  assert.equal(session.root, repo);

  const next = run(repo, "next");
  assert.equal(next.code, 3);
  assert.equal(next.json.status, "ambiguous");
  assert.deepEqual(next.json.candidates.map((c) => c.slug).sort(), ["alpha", "bug"]);
  const alpha = run(repo, "next", "alpha");
  assert.equal(alpha.code, 0);
  assert.equal(alpha.json.next.invocation, "/agento start-session feature/alpha");
  assert.equal(run(repo, "next", "stale").json.status, "missing");

  // A worktree on the delivery branch reads the same companion roadmap as its delivery.
  const wt = path.join(path.dirname(repo), "project-worktrees", "feature-alpha");
  git(repo, "worktree", "add", "-q", "-b", "feature/alpha", wt);
  const build = run(wt, "session").json;
  assert.equal(build.role, "build");
  assert.equal(build.delivery.slug, "alpha");
  assert.equal(build.delivery.roadmap, "features/2026/09/alpha/roadmap.md");
  assert.equal(build.delivery.status, "in-progress");
  assert.equal(build.lifecycle, "building");
  assert.equal(run(wt, "next").json.next.invocation, "/agento build-feature alpha");
});

test("resolve, find, ship-preflight, and close-decision fall back to the companion's origin branch", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  // The roadmap exists only on the companion's feature/widget, pushed to the companion's origin.
  git(docs, "switch", "-q", "-c", "feature/widget");
  writeRoadmap(docs, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review\nartifact-pr: \"#7\"");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "plan");
  git(docs, "push", "-q", "-u", "origin", "feature/widget");
  git(docs, "switch", "-q", "main");
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  // A same-named roadmap in the product repo's own checkout must not be consulted.
  writeRoadmap(repo, "features/2026/09/widget", "status: planned\nbranch: feature/wrong\nnext-step: 1.1\nartifact-pr: \"#99\"");

  const resolved = run(repo, "resolve", "feature", "widget");
  assert.equal(resolved.code, 0);
  assert.equal(resolved.json.status, "ok");
  assert.equal(resolved.json.source, "remote");
  assert.equal(resolved.json.branch, "feature/widget");
  assert.equal(resolved.json.artifactPr, "#7");
  assert.equal(resolved.json.root, repo);

  const found = run(repo, "find", "widget");
  assert.equal(found.json.type, "feature");
  assert.equal(found.json.source, "remote");
  assert.equal(found.json.artifactPr, "#7");

  const ship = run(repo, "ship-preflight", "feature", "widget");
  assert.equal(ship.code, 0);
  assert.equal(ship.json.resolutionSource, "remote");

  const close = run(repo, "close-decision", "feature", "widget");
  assert.equal(close.json.reason, "remote-roadmap-only");

  // The companion's origin branch also feeds `next` for a slug with no local roadmap,
  // carrying the header's artifact PR.
  const next = run(repo, "next", "widget");
  assert.equal(next.code, 0);
  assert.equal(next.json.slug, "widget");
  assert.equal(next.json.status, "ok");
  assert.equal(next.json.artifactPr, "#7");
  // In-repo resolution reads the header from the checkout; absent → null.
  const inRepo = makeRepo();
  writeRoadmap(inRepo, "features/2026/09/plain", "status: planned\nbranch: feature/plain\nnext-step: 1.1");
  assert.equal(run(inRepo, "resolve", "feature", "plain").json.artifactPr, null);
  assert.equal(run(inRepo, "next", "plain").json.artifactPr, null);
});

test("a managed worktree resolves the companion beside the primary checkout, not beside itself", () => {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  const wt = path.join(path.dirname(repo), "wt");
  fs.mkdirSync(wt);
  writeRoadmap(docs, "features/2026/09/alpha", "status: planned\nbranch: feature/alpha\nnext-step: \"1.1\"");

  const plan = path.join(wt, "plan-x");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  const config = run(plan, "config").json;
  assert.equal(config.root, plan);
  assert.equal(config.artifactsRoot, docs);
  assert.notEqual(config.artifactsRoot, path.join(wt, "project-docs"));
  assert.equal(config.config.artifacts.repo.dir, docs);

  const session = run(plan, "session").json;
  assert.equal(session.role, "plan");
  assert.deepEqual(run(plan, "status").json.items.map((i) => i.slug), ["alpha"]);
  assert.equal(run(plan, "paths", "feature", "alpha").json.artifactRoot, path.join(docs, "features"));

  // Once promoted onto the delivery branch, the delivery still comes from the companion.
  git(plan, "switch", "-q", "-c", "feature/alpha");
  const promoted = run(plan, "session").json;
  assert.equal(promoted.role, "build");
  assert.equal(promoted.delivery.roadmap, "features/2026/09/alpha/roadmap.md");
  assert.equal(promoted.lifecycle, "planned");
  assert.equal(run(plan, "resolve", "feature", "alpha").json.path, path.join(docs, "features", "2026", "09", "alpha", "roadmap.md"));
});

test("layout rule: a worktree whose own branch sets artifacts.repo is companion mode anchored on the primary, while the unset primary stays in-repo", () => {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" } }, companion: true });
  const docs = companionOf(repo);
  const wt = path.join(path.dirname(repo), "wt");
  fs.mkdirSync(wt);
  const plan = path.join(wt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  git(plan, "switch", "-q", "-c", "feature/flip");
  fs.writeFileSync(path.join(plan, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } }));
  git(plan, "add", "-A");
  git(plan, "commit", "-q", "-m", "chore: flip to companion");

  // The worktree: its own config decides, the primary anchors the path (never <wt>/project-docs).
  const config = run(plan, "config").json;
  assert.equal(config.root, plan);
  assert.equal(config.artifactsRoot, docs);
  assert.notEqual(config.artifactsRoot, path.join(wt, "project-docs"));
  assert.deepEqual(config.config.artifacts.repo, { name: "project-docs", dir: docs });
  const session = run(plan, "session").json;
  assert.equal(session.role, "build");
  assert.equal(session.delivery.slug, "flip");
  assert.deepEqual(session.companion, { path: path.join(path.dirname(repo), "project-docs-worktrees", "plan-1"), branch: null, detached: false, dirty: false, ahead: 0, behind: 0, registered: false });

  // The primary on main: unset stays in-repo regardless of the worktree's branch.
  const primary = run(repo, "config").json;
  assert.equal(primary.artifactsRoot, repo);
  assert.deepEqual(primary.config.artifacts.repo, { name: null, dir: null });
  const primarySession = run(repo, "session").json;
  assert.equal(primarySession.role, "primary");
  assert.equal(primarySession.companion, null);
});

test("branch-aware resolution: from an in-repo primary, a branch whose config names the companion resolves its roadmap there with layout: branch", () => {
  const { repo, docs } = makeFlipRepo();

  const resolved = run(repo, "resolve", "feature", "flip");
  assert.equal(resolved.code, 0);
  assert.equal(resolved.json.status, "ok");
  assert.equal(resolved.json.source, "remote");
  assert.equal(resolved.json.branch, "feature/flip");
  assert.equal(resolved.json.artifactPr, "#7");
  assert.equal(resolved.json.layout, "branch");
  assert.equal(resolved.json.artifactsRoot, docs);
  assert.equal(resolved.json.root, repo);

  const found = run(repo, "find", "flip");
  assert.equal(found.json.type, "feature");
  assert.equal(found.json.source, "remote");
  assert.equal(found.json.layout, "branch");
  assert.equal(found.json.artifactsRoot, docs);

  const close = run(repo, "close-decision", "feature", "flip");
  assert.equal(close.code, 0);
  assert.equal(close.json.reason, "remote-roadmap-only");
  assert.equal(close.json.layout, "branch");
  assert.equal(close.json.artifactsRoot, docs);
  assert.equal(close.json.companion, null);

  const plain = run(repo, "ship-preflight", "feature", "flip");
  assert.equal(plain.code, 0);
  assert.equal(plain.json.resolutionSource, "remote");
  assert.equal(plain.json.layout, "branch");
  assert.equal(plain.json.artifactsRoot, docs);
  assert.deepEqual(plain.json.companionGaps, []);

  const marker = path.join(path.dirname(repo), "gh-invoked");
  const { env } = restrictedPath({ gh: prStub(marker) });
  const ship = runWith({ cwd: repo, env }, "ship-preflight", "feature", "flip", "--pr");
  assert.equal(ship.code, 0);
  assert.equal(ship.json.pr.number, 15);
  assert.equal(ship.json.companionPr.number, 7);
  assert.deepEqual(ship.json.companionGaps, []);
  assert.deepEqual(ship.json.warnings, []);
  const calls = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], new RegExp(`^${repo} pr view feature/flip `));
  assert.match(calls[1], new RegExp(`^${docs} pr view feature/flip `));
  assert.deepEqual(runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker, { companion: "NONE" }) }).env }, "ship-preflight", "feature", "flip", "--pr").json.companionGaps, ["missing-pr"]);

  const next = run(repo, "next", "flip");
  assert.equal(next.code, 0);
  assert.equal(next.json.status, "ok");
  assert.equal(next.json.slug, "flip");
  assert.equal(next.json.artifactPr, "#7");
  assert.equal(next.json.layout, "branch");
  assert.equal(next.json.artifactsRoot, docs);
  assert.equal(next.json.next.invocation, "/agento start-session feature/flip");

  // A branch naming a companion that is not on disk stays missing and names the path.
  git(repo, "switch", "-q", "-c", "feature/ghost");
  fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, artifacts: { repo: { name: "nowhere-docs" } } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: ghost");
  git(repo, "push", "-q", "-u", "origin", "feature/ghost");
  git(repo, "switch", "-q", "main");
  const ghost = run(repo, "resolve", "feature", "ghost");
  assert.equal(ghost.code, 3);
  assert.equal(ghost.json.status, "missing");
  assert.equal(ghost.json.layout, "checkout");
  assert.equal(ghost.json.artifactsRoot, repo);
  assert.match(ghost.json.message, new RegExp(`companion checkout ${path.join(path.dirname(repo), "nowhere-docs")} is not on disk; clone it with /agento agento-init`));
  assert.match(run(repo, "ship-preflight", "feature", "ghost").json.message, /nowhere-docs/);
  assert.match(run(repo, "close-decision", "feature", "ghost").json.message, /nowhere-docs/);

  // A plain in-repo branch: today's fields plus layout: checkout.
  git(repo, "switch", "-q", "-c", "feature/plain");
  writeRoadmap(repo, "features/2026/09/plain", "status: in-review\nbranch: feature/plain\nnext-step: review");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plan");
  git(repo, "push", "-q", "-u", "origin", "feature/plain");
  git(repo, "switch", "-q", "main");
  const plainBranch = run(repo, "resolve", "feature", "plain").json;
  assert.equal(plainBranch.status, "ok");
  assert.equal(plainBranch.source, "remote");
  assert.equal(plainBranch.layout, "checkout");
  assert.equal(plainBranch.artifactsRoot, repo);
  assert.equal(plainBranch.artifactPr, null);
  assert.equal(run(repo, "find", "plain").json.layout, "checkout");
  const plainShip = run(repo, "ship-preflight", "feature", "plain").json;
  assert.equal(plainShip.layout, "checkout");
  assert.equal(plainShip.companion, null);
  assert.equal(run(repo, "close-decision", "feature", "plain").json.layout, "checkout");
  const nextPlain = run(repo, "next", "plain").json;
  assert.equal(nextPlain.layout, "checkout");
  assert.equal(nextPlain.artifactsRoot, repo);
  // Branch-only deliveries become candidates once a managed worktree owns them; each summary carries its layout.
  const wt = path.join(path.dirname(repo), "wt");
  git(repo, "worktree", "add", "-q", path.join(wt, "feature-flip"), "feature/flip");
  git(repo, "worktree", "add", "-q", path.join(wt, "feature-plain"), "feature/plain");
  const ambiguous = run(repo, "next").json;
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidates.map((c) => [c.slug, c.layout, c.artifactsRoot]).sort(), [["flip", "branch", docs], ["plain", "checkout", repo]]);
  // The companion clone is never switched by any of the reads.
  assert.equal(git(docs, "branch", "--show-current"), "main");
});

test("session warns and paths reports ok: false when the companion half is registered in the product clone (#86 companion-half-registration)", () => {
  const { repo, wt, docsWt } = makePairRepo();
  const base = path.dirname(repo);
  const product = path.join(wt, "plan-20261004-1");
  const stray = path.join(docsWt, "plan-20261004-1");
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  // The dropped-`cd` failure: the companion half is added from the product clone.
  git(repo, "worktree", "add", "-q", "--detach", stray, "origin/main");

  const session = run(product, "session").json;
  const unregistered = session.warnings.filter((w) => w.startsWith("companion-unregistered:"));
  assert.equal(unregistered.length, 1);
  assert.match(unregistered[0], /^companion-unregistered: .*plan-20261004-1 exists but is not a registered worktree of .*project-docs/);
  assert.ok(unregistered[0].includes(repo), unregistered[0]);
  assert.ok(unregistered[0].includes(`git -C ${repo} worktree remove`), unregistered[0]);

  const paths = run(repo, "paths", "plan", "20261004-1").json;
  assert.deepEqual(paths.companion.state, {
    onDisk: true,
    registeredIn: "product",
    origin: path.join(base, "project.git"),
    expectedOrigin: path.join(base, "project-docs.git"),
    ok: false,
  });
  assert.equal(paths.worktreeState.ok, true);
});

test("session from a companion half anchors on the product primary and matches the product half", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  writeRoadmap(docs, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  const product = path.join(wt, "feature-widget");
  const half = path.join(docsWt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(docs, "worktree", "add", "-q", "-b", "feature/widget", half);

  const fromProduct = run(product, "session").json;
  fs.mkdirSync(path.join(half, "features"));
  const fromHalf = run(path.join(half, "features"), "session").json;
  assert.equal(fromProduct.role, "build");
  assert.equal(fromHalf.role, "build");
  assert.equal(fromHalf.root, product, "root re-anchors on the product half");
  assert.deepEqual(strip(fromHalf), strip(fromProduct));
  assert.deepEqual(fromHalf.worktree, fromProduct.worktree);
  assert.equal(fromHalf.worktree.path, product);
  assert.deepEqual(fromHalf.delivery, fromProduct.delivery);
  assert.deepEqual(fromHalf.allowed, fromProduct.allowed);
  assert.deepEqual(fromHalf.companion, fromProduct.companion);
  assert.deepEqual(fromHalf.worktrees, fromProduct.worktrees);
  assert.deepEqual(fromProduct.warnings, []);
  assert.equal(fromHalf.warnings.length, 1);
  assert.match(fromHalf.warnings[0], /^anchored-from-companion: .*project-docs-worktrees\/feature-widget is a companion checkout of .*project; the record describes .*wt\/feature-widget$/);

  // companion / workspace describe the pair from either side.
  assert.deepEqual(fromProduct.companion, { path: half, branch: "feature/widget", detached: false, dirty: false, ahead: 0, behind: 0, registered: true });
  assert.deepEqual(fromProduct.workspace, { path: path.join(wt, "feature-widget.code-workspace"), exists: false, current: null });
  fs.writeFileSync(path.join(wt, "feature-widget.code-workspace"), JSON.stringify({ folders: [{ path: product }, { path: half }], settings: {} }));
  const stale = run(half, "session").json.workspace;
  assert.equal(stale.exists, true);
  assert.equal(stale.current, false);
  run(repo, "workspace", "feature", "widget", "--write");
  const refreshed = run(half, "session").json.workspace;
  assert.equal(refreshed.exists, true);
  assert.equal(refreshed.current, true);

  // worktrees[]: product entries first (primary at 0), companion entries appended with repo: companion.
  const list = fromProduct.worktrees;
  assert.equal(list[0].repo, "product");
  assert.equal(list[0].isPrimary, true);
  assert.equal(list[0].path, repo);
  assert.deepEqual(list.map((w) => w.repo), ["product", "product", "companion", "companion"]);
  assert.deepEqual(list[3], { path: half, branch: "feature/widget", detached: false, role: "build", dirPrefix: "feature", id: "widget", isPrimary: false, isManaged: true, repo: "companion" });
  assert.equal(list[2].path, docs);
  assert.equal(list[2].role, "unmanaged");

  // next agrees from both halves.
  const nextProduct = run(product, "next").json;
  const nextHalf = run(half, "next").json;
  assert.equal(nextProduct.next.invocation, "/agento build-feature widget");
  assert.equal(nextHalf.next.invocation, nextProduct.next.invocation);
  assert.equal(nextHalf.role, "build");
  assert.equal(nextProduct.next.target, null);
  assert.ok(nextHalf.warnings.some((w) => w.startsWith("anchored-from-companion:")));

  // A fresh approve in the half sends ship to the primary window, targeting the product primary.
  writeRoadmap(half, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  fs.writeFileSync(path.join(half, "features/2026/09/widget/review.md"), "# Review\n\nVerdict: approve\n");
  commitAt(half, "review: approve", T1);
  git(half, "push", "-q", "-u", "origin", "feature/widget");
  const approved = run(product, "next").json;
  assert.equal(approved.lifecycle, "approved");
  assert.equal(approved.next.window, "primary");
  assert.deepEqual(approved.next.target, { path: repo, workspace: null });

  // The primary and the companion clone: primary → primary with companion: null; clone → primary, anchored on the product primary.
  const primary = run(repo, "session").json;
  assert.equal(primary.role, "primary");
  assert.equal(primary.companion, null);
  assert.equal(primary.workspace, null);
  const clone = run(docs, "session").json;
  assert.equal(clone.role, "primary");
  assert.equal(clone.root, repo);
  assert.match(clone.warnings[0], /^anchored-from-companion: /);
});

test("session, next, and doctor from the companion clone describe the product primary (#92 companion-cwd-window-role)", () => {
  const { repo, docs } = makePairRepo();
  fs.mkdirSync(path.join(docs, "features"), { recursive: true });

  const primary = run(repo, "session").json;
  for (const cwd of [docs, path.join(docs, "features")]) {
    const record = run(cwd, "session").json;
    assert.equal(record.role, "primary", cwd);
    assert.equal(record.worktree.path, repo);
    assert.deepEqual(strip(record), strip(primary));
    assert.match(record.warnings[0], /^anchored-from-companion: /);
  }

  const nextPrimary = run(repo, "next").json;
  const nextClone = run(docs, "next");
  assert.equal(nextClone.code, 0);
  assert.equal(nextClone.json.role, "primary");
  assert.deepEqual(nextClone.json.status, nextPrimary.status);
  assert.deepEqual(nextClone.json.next, nextPrimary.next);

  const { env } = restrictedPath(okStubs);
  const doctorClone = byId(runWith({ cwd: docs, env }, "doctor").json)["session-workspace"];
  const doctorPrimary = byId(runWith({ cwd: repo, env }, "doctor").json)["session-workspace"];
  assert.deepEqual(doctorClone, doctorPrimary);

  git(docs, "switch", "-q", "-c", "tmp-branch");
  const onBranch = run(docs, "session").json;
  assert.equal(onBranch.role, "primary");
  assert.equal(onBranch.worktree.branch, "main");
});

test("session and next read the delivery roadmap from the registered companion half, not only the clone", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const product = path.join(wt, "feature-mirror");
  const half = path.join(docsWt, "feature-mirror");
  git(repo, "worktree", "add", "-q", "-b", "feature/mirror", product);
  git(docs, "worktree", "add", "-q", "--no-track", "-b", "feature/mirror", half, "origin/main");
  // The roadmap is committed only on the companion half's mirrored branch; the clone (main) has none.
  writeRoadmap(half, "features/2026/09/mirror", "status: in-progress\nbranch: feature/mirror\nnext-step: \"1.2 todo\"\nartifact-pr: \"#7\"");
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "docs(feature): mirror");
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  // A same-path roadmap in the clone is shadowed by the half's copy.
  writeRoadmap(docs, "features/2026/09/other", "status: planned\nbranch: feature/other\nnext-step: \"1.1\"");

  for (const cwd of [product, half]) {
    const session = run(cwd, "session").json;
    assert.equal(session.role, "build", cwd);
    assert.equal(session.delivery.slug, "mirror");
    assert.equal(session.delivery.branch, "feature/mirror");
    assert.equal(session.delivery.roadmap, "features/2026/09/mirror/roadmap.md");
    assert.equal(session.delivery.status, "in-progress");
    assert.equal(session.delivery.artifactPr, "#7");
    assert.equal(session.lifecycle, "building");
    assert.ok(session.allowed.includes("/agento build-feature mirror"), JSON.stringify(session.allowed));
    assert.equal(session.companion.branch, "feature/mirror");
    const next = run(cwd, "next").json;
    assert.equal(next.status, "ok");
    assert.equal(next.next.invocation, "/agento build-feature mirror");
    assert.equal(next.artifactPr, "#7");
  }
  // Precedence: the half's copy of a shared path wins over the clone's.
  writeRoadmap(docs, "features/2026/09/mirror", "status: planned\nbranch: feature/mirror\nnext-step: \"1.1\"");
  assert.equal(run(product, "session").json.delivery.status, "in-progress");
  assert.equal(run(product, "session").json.delivery.artifactPr, "#7");
  // status from the primary walks the registered halves too: the half on feature/mirror shadows the clone's copy.
  assert.deepEqual(run(repo, "status").json.items.map((i) => [i.slug, i.status]), [["mirror", "in-progress"], ["other", "planned"]]);
});

test("paths and ports derive from config and are stable", () => {
  const repo = makeRepo({ config: { branches: { feature: "feat/", default: "trunk" }, worktrees: { dir: "../wt" } } });
  const { json } = run(repo, "paths", "feature", "widget");
  assert.equal(json.branch, "feat/widget");
  assert.equal(json.worktree, path.join(path.dirname(repo), "wt", "feature-widget"));
  assert.equal(json.defaultBranch, "trunk");
  assert.equal(json.postShipBranch, "post-ship/widget");
  // In-repo layout: absolute artifact roots under the checkout itself.
  assert.equal(json.artifactsRoot, repo);
  assert.equal(json.artifactRoot, path.join(repo, "features"));
  assert.equal(run(repo, "paths", "issue", "bug").json.artifactRoot, path.join(repo, "issues"));
  assert.equal(run(repo, "paths", "plan", "20260914-1").json.artifactRoot, null);
  assert.equal(run(repo, "paths", "freehand", "tidy").json.artifactRoot, null);

  const a = run(repo, "ports", "widget").json;
  const b = run(repo, "ports", "widget").json;
  assert.deepEqual(a, b);
  assert.ok(a.WEB_PORT >= 3100 && a.WEB_PORT < 3190);
  assert.equal(a.API_PORT - a.WEB_PORT, 1000);
});

test("paths and config from a managed worktree report the primary's worktrees.dir (in-repo)", () => {
  const { repo, wt } = makeWorktreeRepo();
  const plan = path.join(wt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");

  const paths = run(plan, "paths", "feature", "xy");
  assert.equal(paths.code, 0);
  assert.equal(paths.json.worktreesDir, wt);
  assert.equal(paths.json.worktree, path.join(wt, "feature-xy"));
  assert.equal(paths.json.workspace, null);

  const config = run(plan, "config");
  assert.equal(config.code, 0);
  assert.equal(config.json.config.worktrees.dir, wt);
  assert.equal(config.json.config.worktrees.dir, run(repo, "config").json.config.worktrees.dir);
});

test("paths, workspace, and config from a managed worktree report the primary's worktrees.dir (companion mode)", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const plan = path.join(wt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", path.join(docsWt, "plan-1"), "origin/main");

  const paths = run(plan, "paths", "feature", "xy");
  assert.equal(paths.code, 0);
  assert.equal(paths.json.worktreesDir, wt);
  assert.equal(paths.json.worktree, path.join(wt, "feature-xy"));
  assert.equal(paths.json.workspace, path.join(wt, "feature-xy.code-workspace"));
  assert.equal(paths.json.companion.worktree, path.join(docsWt, "feature-xy"));

  const workspace = run(plan, "workspace", "feature", "xy");
  assert.equal(workspace.code, 0);
  assert.equal(workspace.json.path, path.join(wt, "feature-xy.code-workspace"));
  assert.equal(workspace.json.folders[0].path, path.join(wt, "feature-xy"));

  assert.equal(run(plan, "config").json.config.worktrees.dir, wt);
});

test("usage errors exit 1 and never throw", () => {
  const repo = makeRepo();
  assert.equal(run(repo, "resolve", "thing", "x").code, 1);
  assert.equal(run(repo, "resolve", "feature", "Bad_Slug").code, 1);
  assert.equal(run(repo).code, 1);
  assert.equal(run(repo, "status", "--bogus").code, 1);
  assert.equal(run(repo, "session", "extra").code, 1);
  assert.equal(run(repo, "doctor", "--for", "Bad_Name").code, 1);
  assert.equal(run(repo, "doctor", "--for").code, 1);
  assert.equal(run(repo, "doctor", "extra").code, 1);
  assert.match(run(repo).json.usage.join("\n"), /session \[--pr\]/);
  assert.match(run(repo).json.usage.join("\n"), /worktrees/);
  assert.match(run(repo).json.usage.join("\n"), /doctor \[--for <command>\]/);
});

test("session, status --pr, initiative, metrics, and dashboard read each clone's worktree list once from a product cwd", () => {
  const { repo, wt } = makeWorktreeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2"');
  writeBreakdown(repo, "initiatives/2026/09/demo", null, [{ slug: "alpha" }, { slug: "beta" }]);
  git(repo, "worktree", "add", "-q", "-b", "feature/alpha", path.join(wt, "feature-alpha"));
  const { log, env } = gitLoggingPath();
  const commands = [["session"], ["status", "--pr"], ["initiative"], ["metrics"], ["dashboard"], ["dashboard", "--pr"]];
  for (const args of commands) {
    assert.equal(runWith({ cwd: repo, env }, ...args).code, 0);
    assert.deepEqual(worktreeListCalls(log), { [fs.realpathSync(repo)]: 1 }, `in-repo ${args.join(" ")}`);
  }

  const pair = makePairRepo();
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/alpha", path.join(pair.wt, "feature-alpha"));
  git(pair.docs, "worktree", "add", "-q", "-b", "feature/alpha", path.join(pair.docsWt, "feature-alpha"));
  writeRoadmap(path.join(pair.docsWt, "feature-alpha"), "features/2026/09/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2"');
  writeBreakdown(pair.docs, "initiatives/2026/09/demo", null, [{ slug: "alpha" }, { slug: "beta" }]);
  for (const args of commands) {
    assert.equal(runWith({ cwd: pair.repo, env }, ...args).code, 0);
    assert.deepEqual(worktreeListCalls(log), { [fs.realpathSync(pair.repo)]: 1, [fs.realpathSync(pair.docs)]: 1 }, `companion ${args.join(" ")}`);
  }
});

test("status --pr probes gh --version once and runs pr view once per non-complete item per clone", () => {
  const items = [["alpha", "in-progress"], ["beta", "planned"], ["gamma", "paused"], ["omega", "complete"]];
  const readCalls = (marker) => {
    const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
    fs.rmSync(marker);
    return { versions: lines.filter((l) => l.endsWith(" --version")), views: lines.filter((l) => / pr view /.test(l)) };
  };
  const branchesOf = (views, cwd) => views.filter((l) => l.startsWith(`${cwd} pr view `)).map((l) => l.split(" ")[3]).sort();
  const open = ["feature/alpha", "feature/beta", "feature/gamma"];

  const { repo } = makeWorktreeRepo();
  for (const [slug, status] of items) writeRoadmap(repo, `features/2026/10/${slug}`, `status: ${status}\nbranch: feature/${slug}\nnext-step: "1.2"`);
  const marker = path.join(path.dirname(repo), "gh-calls");
  const inRepo = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker, { logVersion: true }) }).env }, "status", "--pr");
  assert.equal(inRepo.code, 0);
  assert.deepEqual(inRepo.json.items.filter((i) => i.pr?.number === 15).map((i) => i.branch).sort(), open);
  const inRepoCalls = readCalls(marker);
  assert.equal(inRepoCalls.versions.length, 1);
  assert.equal(inRepoCalls.views.length, 3);
  assert.deepEqual(branchesOf(inRepoCalls.views, repo), open);

  const pair = makePairRepo();
  for (const [slug, status] of items) writeRoadmap(pair.docs, `features/2026/10/${slug}`, `status: ${status}\nbranch: feature/${slug}\nnext-step: "1.2"`);
  const pairMarker = path.join(pair.wt, "gh-calls");
  const companion = runWith({ cwd: pair.repo, env: restrictedPath({ gh: prStub(pairMarker, { logVersion: true }) }).env }, "status", "--pr");
  assert.equal(companion.code, 0);
  assert.deepEqual(companion.json.items.filter((i) => i.companionPr?.number === 7).map((i) => i.branch).sort(), open);
  const pairCalls = readCalls(pairMarker);
  assert.equal(pairCalls.versions.length, 1);
  assert.equal(pairCalls.views.length, 6);
  assert.deepEqual(branchesOf(pairCalls.views, pair.repo), open);
  assert.deepEqual(branchesOf(pairCalls.views, pair.docs), open);
});

// --- model pins across ship / publish-pr fast-forwards ------------------------------

const PIN_AGENT = "---\nname: Tester\ndescription: \"Tests\"\n---\n\nAgent.\n";
const PIN_PROMPT = "---\ndescription: \"Widget\"\nagent: agent\n---\n\nBody.\n";
const PIN_PROMPT_V2 = "---\ndescription: \"Widget\"\nagent: agent\n---\n\nBody v2.\n";
const PIN_PAIR = [".github/prompts/widget.prompt.md", "skills/agento/commands/widget.md"];

// Commits a minimal plugin layout to main and pins the primary: `apply` a named
// profile, or `adopt` a legacy (skip-worktree) custom pin set.
function pinPrimary(repo, mode) {
  writeFile(".github/agents/delivery-builder.agent.md", PIN_AGENT)(repo);
  for (const rel of PIN_PAIR) writeFile(rel, PIN_PROMPT)(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plugin layout");
  git(repo, "push", "-q", "origin", "main");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agento-pin-home-"));
  fs.writeFileSync(path.join(home, "model-profiles.json"), JSON.stringify({ profiles: { cheap: { default: "Cheap (copilot)" } } }));
  const env = { ...baseEnv, AGENTO_CONFIG_HOME: home };
  const models = (...args) => runWith({ cwd: repo, env }, "models", ...args, "--plugin-root", repo);
  if (mode === "apply") {
    assert.equal(models("apply", "cheap").code, 0);
  } else {
    legacyPins(repo, Object.fromEntries(PIN_PAIR.map((rel) => [rel, "Hand (copilot)"])));
    assert.equal(models("adopt").code, 0);
  }
  const value = mode === "apply" ? "Cheap (copilot)" : "Hand (copilot)";
  const active = models("list").json.active;
  assert.equal(active, mode === "apply" ? "cheap" : "custom");
  assert.equal(git(repo, "status", "--porcelain"), "");
  return { models, value, active };
}

// The pinned clone still carries the same pins on the merged content, and git sees no change.
function assertPinsSurvived(repo, { models, value, active }, content = PIN_PROMPT_V2) {
  for (const rel of PIN_PAIR) {
    assert.equal(fs.readFileSync(path.join(repo, rel), "utf8"), setModel(content, value), rel);
    assert.equal(git(repo, "show", `HEAD:${rel}`), content.trimEnd(), `${rel} is committed pin-free`);
  }
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(models("list").json.active, active);
}

const v2Pair = both(...PIN_PAIR.map((rel) => writeFile(rel, PIN_PROMPT_V2)));

for (const mode of ["apply", "adopt"]) {
  test(`ship --confirm syncs a primary pinned by models ${mode} through a delivery that changes a pinned prompt and its mirror`, () => {
    const fixture = makeWorktreeRepo();
    const { repo } = fixture;
    const pins = pinPrimary(repo, mode);
    const { branch, owner } = shippable(fixture, "widget", { extra: v2Pair });
    assert.equal(fs.readFileSync(path.join(owner, PIN_PAIR[0]), "utf8"), setModel(PIN_PROMPT_V2, pins.value), "the owner worktree inherits the pins");
    assert.equal(git(owner, "status", "--porcelain"), "");
    const stub = shipStub({ product: { prs: { [branch]: { rollups: PASSING } } } });
    const audit = shipRun(repo, stub.env, "feature", "widget").json;
    assert.equal(audit.outcome, "awaiting-confirm", JSON.stringify(audit));
    const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", audit.confirmToken, "--wait", "0");
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.outcome, "shipped");
    assert.ok(stepsOf(json).includes("sync"), JSON.stringify(json.actions));
    assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
    assert.equal(fs.existsSync(owner), false);
    assertPinsSurvived(repo, pins);
  });
}

test("ship reopen (checks-failed) fast-forwards a pinned owner worktree and a pinned primary switched onto the branch", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const pins = pinPrimary(repo, "apply");
  const failing = (number) => ({ number, rollups: [[{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" }]] });

  const owned = shippable(fixture, "broken", { extra: v2Pair });
  const ownedStub = shipStub({ product: { prs: { [owned.branch]: failing(16) } } });
  const ownedToken = shipRun(repo, ownedStub.env, "feature", "broken").json.confirmToken;
  const ownedRun = shipRun(repo, ownedStub.env, "feature", "broken", "--confirm", ownedToken, "--wait", "0");
  assert.equal(ownedRun.json.reason, "checks-failed", JSON.stringify(ownedRun.json));
  assert.ok(stepsOf(ownedRun.json).includes("roadmap-reopened"));
  assert.equal(git(owned.owner, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(owned.owner, PIN_PAIR[0]), "utf8"), setModel(PIN_PROMPT_V2, pins.value));

  const orphan = shippable(fixture, "orphan", { owner: false, extra: v2Pair });
  const orphanStub = shipStub({ product: { prs: { [orphan.branch]: failing(17) } } });
  const orphanToken = shipRun(repo, orphanStub.env, "feature", "orphan").json.confirmToken;
  const orphaned = shipRun(repo, orphanStub.env, "feature", "orphan", "--confirm", orphanToken, "--wait", "0");
  assert.equal(orphaned.json.reason, "checks-failed", JSON.stringify(orphaned.json));
  assert.ok(stepsOf(orphaned.json).includes("roadmap-reopened"));
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assertPinsSurvived(repo, pins, PIN_PROMPT);
});

test("publish-pr --merge switches a pinned primary to the default branch and fast-forwards it over a pinned prompt change", () => {
  const { repo } = makeWorktreeRepo();
  const pins = pinPrimary(repo, "apply");
  git(repo, "switch", "-q", "-c", "changes/widget");
  v2Pair(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: widget v2");
  const stub = shipStub({ product: { prs: { "changes/widget": { number: 15, isDraft: false, rollups: [[ciCheck("Unit tests", "SUCCESS")]] } } } });
  const { code, json } = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "merged");
  assert.deepEqual(json.sync, { switched: true, fastForwarded: true, branchDeleted: true, skipped: null });
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assertPinsSurvived(repo, pins);
});

test("with pins active, the primary and a linked worktree are clean and their commits carry no model: line", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap (copilot)", agents: { planner: "Strong (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  for (const [checkout, rel] of [[plugin, ".github/prompts/doctor.prompt.md"], [linked, ".github/agents/delivery-planner.agent.md"]]) {
    assert.equal(git(checkout, "status", "--porcelain"), "", checkout);
    const file = path.join(checkout, rel);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^model: "/m, `${rel} is pinned in ${checkout}`);
    fs.writeFileSync(file, `${text}\nA body edit.\n`);
    assert.equal(git(checkout, "status", "--porcelain"), `M ${rel}`);
    git(checkout, "commit", "-q", "-am", "body edit");
    const committed = git(checkout, "show", `HEAD:${rel}`);
    assert.doesNotMatch(committed, /^\s*model:/m, `${rel} committed from ${checkout}`);
    assert.match(committed, /A body edit\.$/);
    assert.equal(git(checkout, "status", "--porcelain"), "");
    assert.match(fs.readFileSync(file, "utf8"), /^model: "/m, "the pin stays in the working file");
  }
});
