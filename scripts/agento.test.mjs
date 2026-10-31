import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { completeRoadmap, reopenRoadmap } from "./delivery-roadmap-resolver.mjs";
import { linkType } from "./harness.mjs";
import { profilesHash, setHandoffModels, setModel } from "./model-profiles.mjs";
import { LIFECYCLES, SESSION_WORKSPACE_SETTINGS } from "./session-state.mjs";
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
} from "./test-helpers/agento-fixtures.mjs";

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

test("paths in companion mode adds the companion half and the workspace file; in-repo mode reports null", () => {
  const { repo, docs, docsWt, wt } = makePairRepo();
  const base = path.dirname(repo);
  for (const [kind, id, branch] of [["plan", "20260916-1", null], ["feature", "widget", "feature/widget"], ["issue", "bug", "issue/bug"], ["freehand", "tidy", "changes/tidy"]]) {
    const { code, json } = run(repo, "paths", kind, id);
    assert.equal(code, 0);
    assert.equal(json.worktree, path.join(wt, `${kind}-${id}`));
    assert.equal(json.branch, branch);
    const { state, ...companion } = json.companion;
    assert.deepEqual(companion, { worktreesDir: docsWt, worktree: path.join(docsWt, `${kind}-${id}`), branch });
    assert.deepEqual(state, { onDisk: false, registeredIn: null, origin: null, expectedOrigin: path.join(base, "project-docs.git"), ok: false });
    assert.deepEqual(json.worktreeState, { onDisk: false, registeredIn: null, origin: null, expectedOrigin: path.join(base, "project.git"), ok: false });
    assert.equal(json.workspace, path.join(wt, `${kind}-${id}.code-workspace`));
    assert.equal(json.layout, "checkout");
  }
  // A correctly created pair: each half registered in its own clone with its own origin.
  git(repo, "worktree", "add", "-q", "--detach", path.join(wt, "plan-20260916-1"), "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", path.join(docsWt, "plan-20260916-1"), "origin/main");
  const pair = run(repo, "paths", "plan", "20260916-1").json;
  assert.deepEqual(pair.worktreeState, { onDisk: true, registeredIn: "product", origin: path.join(base, "project.git"), expectedOrigin: path.join(base, "project.git"), ok: true });
  assert.deepEqual(pair.companion.state, { onDisk: true, registeredIn: "companion", origin: path.join(base, "project-docs.git"), expectedOrigin: path.join(base, "project-docs.git"), ok: true });
  const inRepo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  for (const [kind, id] of [["plan", "20260916-1"], ["feature", "widget"], ["freehand", "tidy"]]) {
    const json = run(inRepo, "paths", kind, id).json;
    assert.equal(json.status, "ok");
    assert.equal(json.companion, null);
    assert.equal(json.workspace, null);
    assert.equal(json.layout, "checkout");
    assert.equal(json.artifactsRoot, inRepo);
    assert.equal(json.worktreeState.ok, false);
  }
  assert.match(run(repo).json.usage.join("\n"), /companion half and \.code-workspace/);
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

test("workspace command writes the session pair's .code-workspace with the auto-approve settings block (#58 session-auto-approve)", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const planId = "20260916-1";
  const product = path.join(wt, `plan-${planId}`);
  const companion = path.join(docsWt, `plan-${planId}`);
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", companion, "origin/main");

  const command = run(repo, "workspace", "plan", planId, "--write");
  assert.equal(command.code, 0);
  assert.equal(command.json.status, "ok");
  assert.equal(command.json.path, path.join(wt, `plan-${planId}.code-workspace`));
  assert.equal(command.json.written, true);

  const writtenPath = command.json.path;
  const before = fs.readFileSync(writtenPath, "utf8");
  const doc = JSON.parse(before);
  assert.deepEqual(doc.folders, [{ path: product }, { path: companion }]);
  assert.deepEqual(doc.settings, command.json.settings);

  const second = run(repo, "workspace", "plan", planId, "--write");
  assert.equal(second.code, 0);
  assert.equal(second.json.written, false);
  assert.equal(fs.readFileSync(writtenPath, "utf8"), before);

  fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify({ artifacts: { repo: { name: "project-docs" } }, worktrees: { dir: "../wt", autoApprove: false } }));
  const disabled = run(repo, "workspace", "plan", planId, "--write");
  assert.equal(disabled.code, 0);
  assert.equal(disabled.json.status, "ok");
  assert.deepEqual(disabled.json.settings, {});

  const inRepo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  const none = run(inRepo, "workspace", "plan", planId, "--write");
  assert.equal(none.code, 0);
  assert.equal(none.json.status, "not-applicable");
  assert.equal(fs.existsSync(path.join(path.dirname(inRepo), "wt", `plan-${planId}.code-workspace`)), false);
});

test("paths is branch-aware: from an in-repo primary a delivery branch that flips to the companion reports the pair; a plain branch stays in-repo", () => {
  const { repo, docs } = makeFlipRepo();
  const wt = path.join(path.dirname(repo), "wt");
  const docsWt = path.join(path.dirname(repo), "project-docs-worktrees");
  const flip = run(repo, "paths", "feature", "flip").json;
  assert.equal(flip.status, "ok");
  assert.equal(flip.layout, "branch");
  assert.equal(flip.artifactsRoot, docs);
  assert.equal(flip.artifactRoot, path.join(docs, "features"));
  assert.equal(flip.worktree, path.join(wt, "feature-flip"));
  const { state: flipState, ...flipCompanion } = flip.companion;
  assert.deepEqual(flipCompanion, { worktreesDir: docsWt, worktree: path.join(docsWt, "feature-flip"), branch: "feature/flip" });
  assert.equal(flipState.onDisk, false);
  assert.equal(flip.workspace, path.join(wt, "feature-flip.code-workspace"));
  // In-repo control: no config on the branch → today's output.
  git(repo, "switch", "-q", "-c", "feature/plain");
  writeRoadmap(repo, "features/2026/09/plain", "status: in-progress\nbranch: feature/plain\nnext-step: \"1.1\"");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plan");
  git(repo, "push", "-q", "-u", "origin", "feature/plain");
  git(repo, "switch", "-q", "main");
  const plain = run(repo, "paths", "feature", "plain").json;
  assert.equal(plain.layout, "checkout");
  assert.equal(plain.artifactsRoot, repo);
  assert.equal(plain.artifactRoot, path.join(repo, "features"));
  assert.equal(plain.companion, null);
  assert.equal(plain.workspace, null);
  // Plan and freehand kinds never consult a branch.
  assert.equal(run(repo, "paths", "plan", "20260916-1").json.companion, null);
  assert.equal(run(repo, "paths", "freehand", "tidy").json.companion, null);
  assert.equal(git(docs, "branch", "--show-current"), "main");
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

test("session: plan pair (both detached), half-promoted pair, and a product half without a companion half", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const plan = path.join(wt, "plan-1");
  const planHalf = path.join(docsWt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", planHalf, "origin/main");

  const both = run(plan, "session").json;
  assert.equal(both.role, "plan");
  assert.deepEqual(both.companion, { path: planHalf, branch: null, detached: true, dirty: false, ahead: 0, behind: 0, registered: true });
  const fromHalf = run(planHalf, "session").json;
  assert.equal(fromHalf.role, "plan");
  assert.deepEqual(fromHalf.worktree, both.worktree);
  assert.deepEqual(fromHalf.companion, both.companion);

  // Half-promoted: the product half moves to feature/thing, the companion half stays detached.
  git(plan, "switch", "-q", "-c", "feature/thing");
  const promoted = run(plan, "session").json;
  assert.equal(promoted.role, "build");
  assert.equal(promoted.delivery.slug, "thing");
  assert.deepEqual(promoted.companion, { path: planHalf, branch: null, detached: true, dirty: false, ahead: 0, behind: 0, registered: true });
  const promotedHalf = run(planHalf, "session").json;
  assert.equal(promotedHalf.role, "build");
  assert.equal(promotedHalf.worktree.branch, "feature/thing");
  assert.deepEqual(promotedHalf.delivery, promoted.delivery);
  assert.equal(promoted.worktrees.find((w) => w.path === planHalf).role, "build");

  // A product half with no companion half registered (pre-pair session).
  const lone = path.join(wt, "feature-lone");
  git(repo, "worktree", "add", "-q", "-b", "feature/lone", lone);
  assert.deepEqual(run(lone, "session").json.companion, { path: path.join(docsWt, "feature-lone"), branch: null, detached: false, dirty: false, ahead: 0, behind: 0, registered: false });
});

test("session: a plan pair promoted on both halves is one delivery from either side", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const plan = path.join(wt, "plan-2");
  const planHalf = path.join(docsWt, "plan-2");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", planHalf, "origin/main");
  // The Planner's step 5: product branch first, then the same name in the companion half.
  git(plan, "switch", "-q", "-c", "feature/mirror");
  git(planHalf, "switch", "-q", "-c", "feature/mirror");
  assert.equal(git(planHalf, "rev-parse", "--abbrev-ref", "HEAD"), "feature/mirror");
  assert.equal(spawnSync("git", ["-C", planHalf, "rev-parse", "--abbrev-ref", "@{upstream}"]).status !== 0, true, "the mirrored branch has no upstream yet");

  const fromProduct = run(plan, "session").json;
  const fromHalf = run(planHalf, "session").json;
  assert.equal(fromProduct.role, "build");
  assert.equal(fromHalf.role, "build");
  assert.equal(fromProduct.delivery.slug, "mirror");
  assert.equal(fromProduct.delivery.branch, "feature/mirror");
  assert.deepEqual(fromHalf.delivery, fromProduct.delivery);
  assert.deepEqual(fromHalf.worktree, fromProduct.worktree);
  assert.equal(fromProduct.worktree.dirPrefix, "plan", "promotion keeps the plan-* directory");
  assert.deepEqual(fromProduct.companion, { path: planHalf, branch: "feature/mirror", detached: false, dirty: false, ahead: 0, behind: 0, registered: true });
  assert.equal(fromProduct.companion.branch, fromProduct.delivery.branch);
  assert.deepEqual(fromHalf.companion, fromProduct.companion);
  assert.deepEqual(fromHalf.worktrees, fromProduct.worktrees);
  const tagged = fromProduct.worktrees.filter((w) => w.branch === "feature/mirror");
  assert.deepEqual(tagged.map((w) => [w.repo, w.path, w.role, w.dirPrefix]), [["product", plan, "build", "plan"], ["companion", planHalf, "build", "plan"]]);
  assert.match(fromHalf.warnings[0], /^anchored-from-companion: /);

  // An unpushed companion commit shows up as ahead: 1 from either side.
  fs.mkdirSync(path.join(planHalf, "features"), { recursive: true });
  fs.writeFileSync(path.join(planHalf, "features", "x.md"), "x\n");
  git(planHalf, "add", "-A");
  git(planHalf, "commit", "-q", "-m", "docs: x");
  assert.equal(run(plan, "session").json.companion.ahead, 1);
  git(planHalf, "push", "-q", "-u", "origin", "feature/mirror");
  assert.equal(run(planHalf, "session").json.companion.ahead, 0);
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

test("session: an unrelated repo and an ambiguous companion stay put; a half nobody names is that repo's own managed worktree", () => {
  const { repo, docs } = makePairRepo();
  const base = path.dirname(repo);
  // An unrelated sibling repository: no anchoring, no warning.
  const other = cloneWithOrigin(base, "other");
  const unrelated = run(other, "session").json;
  assert.equal(unrelated.role, "primary");
  assert.equal(unrelated.root, other);
  assert.deepEqual(unrelated.warnings, []);
  assert.equal(unrelated.companion, null);

  // `<name>-worktrees/plan-9` under a repo no product names is simply that repo's
  // in-repo managed worktree: today's record, no anchoring, no warning.
  const orphanDocs = cloneWithOrigin(base, "orphan-docs");
  const orphanHalf = path.join(base, "orphan-docs-worktrees", "plan-9");
  fs.mkdirSync(path.dirname(orphanHalf));
  git(orphanDocs, "worktree", "add", "-q", "--detach", orphanHalf, "origin/main");
  const orphan = run(orphanHalf, "session").json;
  assert.equal(orphan.role, "plan");
  assert.equal(orphan.root, orphanHalf);
  assert.deepEqual(orphan.warnings, []);
  assert.equal(orphan.companion, null);

  // Two products naming the same companion: ambiguous, unmanaged, warning lists both.
  cloneWithOrigin(base, "project-two", { artifacts: { repo: { name: "project-docs" } } });
  const ambiguous = run(docs, "session").json;
  assert.equal(ambiguous.role, "primary", "unanchored: the clone is its own primary");
  assert.equal(ambiguous.root, docs);
  assert.equal(ambiguous.companion, null);
  assert.match(ambiguous.warnings[0], /^companion-anchor: 2 sibling checkouts name .*project-docs as their artifacts\.repo \(.*project.*project-two.*\)/);
});

test("close-decision and ship-preflight report the companion half and refuse a dirty or unpushed one", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  writeRoadmap(docs, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  const product = path.join(wt, "feature-widget");
  const half = path.join(docsWt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", product);

  // Product half registered, no companion half yet: companion is unregistered and harmless.
  const none = run(repo, "close-decision", "feature", "widget").json;
  assert.equal(none.status, "ok");
  assert.equal(none.reason, "managed-worktree-present");
  assert.deepEqual(none.companion, { path: half, branch: null, detached: false, dirty: false, ahead: 0, behind: 0, registered: false });

  git(docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  const clean = run(repo, "close-decision", "feature", "widget");
  assert.equal(clean.code, 0);
  assert.equal(clean.json.reason, "managed-worktree-present");
  assert.equal(clean.json.owner.path, product);
  assert.deepEqual(clean.json.companion, { path: half, branch: "feature/widget", detached: false, dirty: false, ahead: 0, behind: 0, registered: true });
  const ship = run(repo, "ship-preflight", "feature", "widget").json;
  assert.equal(ship.status, "ok");
  assert.deepEqual(ship.companion, clean.json.companion);
  assert.deepEqual(ship.companionGaps, []);

  // Dirty companion half.
  fs.writeFileSync(path.join(half, "notes.md"), "wip\n");
  const dirty = run(repo, "close-decision", "feature", "widget");
  assert.equal(dirty.code, 3);
  assert.equal(dirty.json.status, "error");
  assert.equal(dirty.json.reason, "companion-unpushed");
  assert.equal(dirty.json.companion.dirty, true);
  assert.equal(dirty.json.owner.path, product);
  assert.match(dirty.json.message, /companion half at .* is dirty; commit and push it/);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, ["dirty"]);

  // Committed but never pushed (no upstream): counted as unpushed.
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "notes");
  const ahead = run(repo, "close-decision", "feature", "widget").json;
  assert.equal(ahead.reason, "companion-unpushed");
  assert.deepEqual([ahead.companion.dirty, ahead.companion.ahead], [false, 1]);
  assert.match(ahead.message, /is unpushed;/);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, ["unpushed"]);

  // Pushed with an upstream: clean again.
  git(half, "push", "-q", "-u", "origin", "feature/widget");
  assert.equal(run(repo, "close-decision", "feature", "widget").json.reason, "managed-worktree-present");
  assert.equal(run(repo, "close-decision", "feature", "widget").json.companion.ahead, 0);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, []);

  // Behind its upstream: a second commit pushed to origin/feature/widget from the clone.
  git(docs, "fetch", "-q", "origin");
  git(docs, "switch", "-q", "-c", "feature/widget-elsewhere", "origin/feature/widget");
  fs.writeFileSync(path.join(docs, "elsewhere.md"), "from another machine\n");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "docs: elsewhere");
  git(docs, "push", "-q", "origin", "HEAD:feature/widget");
  git(docs, "switch", "-q", "main");
  git(docs, "branch", "-q", "-D", "feature/widget-elsewhere");
  git(half, "fetch", "-q", "origin");
  const behind = run(repo, "close-decision", "feature", "widget");
  assert.equal(behind.code, 3);
  assert.equal(behind.json.reason, "companion-unpushed");
  assert.equal(behind.json.companion.behind, 1);
  assert.equal(behind.json.companion.ahead, 0);
  assert.match(behind.json.message, /is behind its upstream; run git -C .* merge origin\/feature\/widget/);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, ["behind"]);
  git(half, "merge", "-q", "origin/feature/widget");
  assert.equal(run(repo, "close-decision", "feature", "widget").json.reason, "managed-worktree-present");
  assert.equal(run(repo, "close-decision", "feature", "widget").json.companion.behind, 0);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, []);

  // Dirty and unpushed together.
  fs.writeFileSync(path.join(half, "more.md"), "wip\n");
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "more");
  fs.writeFileSync(path.join(half, "notes.md"), "edited\n");
  const both = run(repo, "close-decision", "feature", "widget").json;
  assert.match(both.message, /is dirty and unpushed;/);
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.companionGaps, ["dirty", "unpushed"]);

  // In-repo mode: companion null, companionGaps empty, decisions unchanged.
  const inRepo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  fs.mkdirSync(path.join(path.dirname(inRepo), "wt"));
  git(inRepo, "worktree", "add", "-q", "-b", "feature/plain", path.join(path.dirname(inRepo), "wt", "feature-plain"));
  writeRoadmap(inRepo, "features/2026/09/plain", "status: in-review\nbranch: feature/plain\nnext-step: review");
  const plainClose = run(inRepo, "close-decision", "feature", "plain").json;
  assert.equal(plainClose.reason, "managed-worktree-present");
  assert.equal(plainClose.companion, null);
  const plainShip = run(inRepo, "ship-preflight", "feature", "plain").json;
  assert.equal(plainShip.companion, null);
  assert.deepEqual(plainShip.companionGaps, []);
  // Remote-only roadmap: no owner, no companion.
  const remoteOnly = run(repo, "close-decision", "feature", "nobody");
  assert.equal(remoteOnly.json.status, "error");
  assert.equal(remoteOnly.json.companion, undefined);
});

test("ship-preflight reports the owner tree split into tracked and untracked files (#88 ship-untracked-byproducts)", () => {
  // In-repo: a pushed owner worktree whose only dirt is untracked byproducts.
  const { repo, wt } = makeWorktreeRepo();
  const owner = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", owner);
  writeRoadmap(owner, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  fs.writeFileSync(path.join(owner, "app.js"), "v1\n");
  git(owner, "add", "-A");
  git(owner, "commit", "-q", "-m", "plan");
  git(owner, "push", "-q", "-u", "origin", "feature/widget");
  fs.mkdirSync(path.join(owner, "features/2026/09/other/evidence"), { recursive: true });
  fs.writeFileSync(path.join(owner, "features/2026/09/other/evidence/x.png"), "png");
  fs.writeFileSync(path.join(owner, "evidence"), "stray");

  const ship = run(repo, "ship-preflight", "feature", "widget");
  assert.equal(ship.code, 0);
  assert.equal(ship.json.status, "ok");
  assert.deepEqual(ship.json.ownerTree, { tracked: [], untracked: ["evidence", "features/2026/09/other/evidence/x.png"], ahead: 0 });
  assert.deepEqual(Object.keys(ship.json.owner), ["path", "role", "dirPrefix", "id"]);
  assert.equal(ship.json.companionTree, null);
  assert.deepEqual(ship.json.companionGaps, []);

  // A tracked change is listed apart from the byproducts; a local commit counts as ahead.
  fs.writeFileSync(path.join(owner, "app.js"), "v2\n");
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.ownerTree.tracked, ["app.js"]);
  git(owner, "commit", "-q", "-am", "v2");
  assert.deepEqual(run(repo, "ship-preflight", "feature", "widget").json.ownerTree, { tracked: [], untracked: ["evidence", "features/2026/09/other/evidence/x.png"], ahead: 1 });

  // No owner worktree: ownerTree is null.
  git(repo, "worktree", "remove", "--force", owner);
  const ownerless = run(repo, "ship-preflight", "feature", "widget").json;
  assert.equal(ownerless.status, "ok");
  assert.equal(ownerless.owner, null);
  assert.equal(ownerless.ownerTree, null);

  // Companion mode: the half's untracked file is listed; the gap stays dirty.
  const pair = makePairRepo();
  writeRoadmap(pair.docs, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  const product = path.join(pair.wt, "feature-widget");
  const half = path.join(pair.docsWt, "feature-widget");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(pair.docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  fs.writeFileSync(path.join(half, "notes.md"), "wip\n");
  const paired = run(pair.repo, "ship-preflight", "feature", "widget").json;
  assert.equal(paired.status, "ok");
  assert.deepEqual(paired.ownerTree, { tracked: [], untracked: [], ahead: 0 });
  assert.deepEqual(paired.companionTree, { tracked: [], untracked: ["notes.md"] });
  assert.deepEqual(paired.companionGaps, ["dirty"]);
  assert.equal(paired.companion.dirty, true);
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

test("paths places artifactRoot under the companion checkout when artifacts.repo is set", () => {
  const repo = makeRepo({ config: { artifacts: { issues: "tracker/issues", repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  const feature = run(repo, "paths", "feature", "widget").json;
  assert.equal(feature.artifactsRoot, docs);
  assert.equal(feature.artifactRoot, path.join(docs, "features"));
  // Worktrees stay beside the product repo, not the companion.
  assert.equal(feature.worktreesDir, path.join(path.dirname(repo), "project-worktrees"));
  assert.equal(run(repo, "paths", "issue", "bug").json.artifactRoot, path.join(docs, "tracker", "issues"));
  const plan = run(repo, "paths", "plan", "20260914-1").json;
  assert.equal(plan.artifactsRoot, docs);
  assert.equal(plan.artifactRoot, null);
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

test("session from the primary worktree reports role primary and no delivery", () => {
  const { repo } = makeWorktreeRepo();
  const { code, json } = run(repo, "session");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.role, "primary");
  assert.equal(json.worktree.isPrimary, true);
  assert.equal(json.worktree.branch, "main");
  assert.equal(json.delivery, null);
  assert.equal(json.pr, null);
  assert.equal(json.lifecycle, "no-delivery");
  assert.ok(json.allowed.includes("/agento start-session"));
  assert.deepEqual(json.elsewhere, []);
  assert.deepEqual(json.warnings, []);
  assert.equal(json.hosted, false);
  assert.deepEqual(json.worktrees, [{ path: repo, branch: "main", detached: false, role: "primary", dirPrefix: null, id: null, isPrimary: true, isManaged: false, repo: "product" }]);

  const sub = path.join(repo, "src", "nested");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(run(sub, "session").json.role, "primary");
  assert.equal(run(repo, "session", "--root", sub).json.worktree.path, repo);
});

test("session from a managed build worktree reports the delivery, lifecycle, and commands", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nlast-updated: 2026-09-13\nnext-step: \"1.2 todo\"");

  const { code, json } = run(build, "session");
  assert.equal(code, 0);
  assert.equal(json.role, "build");
  assert.deepEqual(json.worktree, { path: build, branch: "feature/widget", detached: false, isPrimary: false, isManaged: true, dirPrefix: "feature", id: "widget" });
  assert.equal(json.delivery.type, "feature");
  assert.equal(json.delivery.slug, "widget");
  assert.equal(json.delivery.status, "in-progress");
  assert.equal(json.delivery.roadmap, "features/2026/09/widget/roadmap.md");
  assert.deepEqual(json.delivery.steps, { ticked: 1, total: 2 });
  assert.equal(json.lifecycle, "building");
  assert.ok(json.allowed.includes("/agento build-feature widget"));
  const ship = json.elsewhere.find((e) => e.command === "/agento ship widget");
  assert.equal(ship.window, "primary");

  // From the primary, the same branch is only visible via its worktree, not the cwd.
  assert.equal(run(repo, "session").json.role, "primary");

  // An unmanaged sibling worktree on a delivery branch.
  const stray = path.join(path.dirname(repo), "stray");
  git(repo, "worktree", "add", "-q", "-b", "issue/bug", stray);
  const unmanaged = run(stray, "session").json;
  assert.equal(unmanaged.role, "unmanaged");
  assert.equal(unmanaged.delivery.slug, "bug");
  assert.deepEqual(unmanaged.allowed, []);
  assert.equal(unmanaged.elsewhere[0].window, "primary");

  // worktrees[] classifies every registered entry the same way from any cwd
  // (git lists linked worktrees in no guaranteed order).
  const byPath = (list) => [...list].sort((a, b) => a.path.localeCompare(b.path));
  const expected = byPath([
    { path: repo, branch: "main", detached: false, role: "primary", dirPrefix: null, id: null, isPrimary: true, isManaged: false, repo: "product" },
    { path: build, branch: "feature/widget", detached: false, role: "build", dirPrefix: "feature", id: "widget", isPrimary: false, isManaged: true, repo: "product" },
    { path: stray, branch: "issue/bug", detached: false, role: "unmanaged", dirPrefix: null, id: null, isPrimary: false, isManaged: false, repo: "product" },
  ]);
  assert.equal(unmanaged.worktrees[0].path, repo, "primary first");
  assert.deepEqual(byPath(unmanaged.worktrees), expected);
  assert.deepEqual(byPath(run(repo, "session").json.worktrees), expected);
  assert.deepEqual(byPath(run(build, "session").json.worktrees), expected);
});

test("session: hosted workspaces derive the role from the branch and warn once", () => {
  const { repo, wt } = makeWorktreeRepo();
  const stray = path.join(path.dirname(repo), "stray");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", stray);
  const plan = path.join(wt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");

  assert.equal(run(stray, "session").json.hosted, false);
  assert.equal(run(stray, "session").json.role, "unmanaged");

  const actions = runWith({ cwd: stray, env: { ...baseEnv, GITHUB_ACTIONS: "true" } }, "session").json;
  assert.equal(actions.status, "ok");
  assert.equal(actions.hosted, true);
  assert.equal(actions.role, "build");
  assert.equal(actions.delivery.slug, "widget");
  assert.deepEqual(actions.warnings, ["hosted-workspace: role derived from the branch (GITHUB_ACTIONS=true)"]);
  // The build row applies: no roadmap yet, so only the window-wide reads here and start-session elsewhere.
  assert.equal(actions.lifecycle, "no-delivery");
  assert.deepEqual(actions.allowed, ["/agento continue", "/agento delivery-status", "/agento next-feature"]);
  assert.equal(actions.elsewhere[0].window, "primary");
  // worktrees[] still describes the on-disk checkouts by path.
  assert.equal(actions.worktrees.find((w) => w.path === stray).role, "unmanaged");

  const codespaces = runWith({ cwd: repo, env: { ...baseEnv, CODESPACES: "true" } }, "session").json;
  assert.equal(codespaces.hosted, true);
  assert.equal(codespaces.role, "primary");
  assert.deepEqual(codespaces.warnings, ["hosted-workspace: role derived from the branch (CODESPACES=true)"]);

  // Detached plan worktree: `plan` by path, `primary` under hosted rules.
  assert.equal(run(plan, "session").json.role, "plan");
  assert.equal(runWith({ cwd: plan, env: { ...baseEnv, CODESPACES: "true" } }, "session").json.role, "primary");
});

test("session promotes a plan-* worktree to build once it is on a delivery branch", () => {
  const { repo, wt } = makeWorktreeRepo();
  const plan = path.join(wt, "plan-20260914-015913");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");

  const detached = run(plan, "session").json;
  assert.equal(detached.role, "plan");
  assert.equal(detached.worktree.detached, true);
  assert.equal(detached.worktree.branch, null);
  assert.equal(detached.delivery, null);
  assert.equal(detached.lifecycle, "no-delivery");
  assert.ok(detached.allowed.includes("/agento new-feature"));

  git(plan, "switch", "-q", "-c", "feature/thing");
  const promoted = run(plan, "session").json;
  assert.equal(promoted.role, "build");
  assert.equal(promoted.worktree.dirPrefix, "plan");
  assert.equal(promoted.worktree.id, "20260914-015913");
  assert.equal(promoted.delivery.slug, "thing");
  assert.equal(promoted.delivery.roadmap, null);
  assert.equal(promoted.lifecycle, "no-delivery");

  writeRoadmap(plan, "features/2026/09/thing", "status: planned\nbranch: feature/thing\nnext-step: 1.1");
  const planned = run(plan, "session").json;
  assert.equal(planned.lifecycle, "planned");
  assert.ok(planned.allowed.includes("/agento build-feature thing"));
});

test("session --pr degrades to pr: null with one warning when gh is missing", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: x");
  const { env } = restrictedPath();

  const { code, json } = runWith({ cwd: build, env }, "session", "--pr");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.pr, null);
  assert.equal(json.warnings.length, 1);
  assert.match(json.warnings[0], /gh CLI not found/);
  assert.equal(json.lifecycle, "building");
});

test("session never invokes gh without --pr and reads its JSON with --pr", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  const marker = path.join(wt, "gh-invoked");
  const { env, bin } = restrictedPath({
    gh: `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\nif [ "$1" = "--version" ]; then echo gh version 0; exit 0; fi\necho '{"number":15,"state":"OPEN","isDraft":true,"mergeStateStatus":"CLEAN","url":"https://example.test/pr/15"}'\n`,
  });

  const plain = runWith({ cwd: build, env }, "session");
  assert.equal(plain.code, 0);
  assert.equal(plain.json.pr, null);
  assert.deepEqual(plain.json.warnings, []);
  assert.ok(!fs.existsSync(marker), "gh was invoked without --pr");

  const withPr = runWith({ cwd: build, env }, "session", "--pr");
  assert.equal(withPr.code, 0);
  assert.deepEqual(withPr.json.pr, { number: 15, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", url: "https://example.test/pr/15" });
  assert.deepEqual(withPr.json.warnings, []);
  assert.match(fs.readFileSync(marker, "utf8"), /pr view feature\/widget --json number,state,isDraft,mergeStateStatus,mergeable,url/);

  // A gh that fails (exit 99) is reported as a warning, not an error.
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho 'no pull requests found for branch' >&2\nexit 99\n", { mode: 0o755 });
  const failing = runWith({ cwd: build, env }, "session", "--pr");
  assert.equal(failing.code, 0);
  assert.equal(failing.json.pr, null);
  assert.deepEqual(failing.json.warnings.length, 1);
  assert.match(failing.json.warnings[0], /gh pr view feature\/widget failed: no pull requests found/);

  // A merged PR on a non-complete roadmap warns without changing the lifecycle.
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: x");
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\necho '{\"number\":15,\"state\":\"MERGED\",\"isDraft\":false,\"mergeStateStatus\":\"UNKNOWN\",\"url\":\"u\"}'\n", { mode: 0o755 });
  const merged = runWith({ cwd: build, env }, "session", "--pr");
  assert.equal(merged.json.lifecycle, "building");
  assert.match(merged.json.warnings[0], /^merged-but-not-complete: PR #15/);
});

test("session --pr: companionPr is null with no extra gh call in-repo, and the companion clone's PR in companion mode", () => {
  // In-repo: exactly one gh pr view, companionPr null, artifactPr read from the header.
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: x\nartifact-pr: \"#7\"");
  const marker = path.join(wt, "gh-invoked");
  const ghScript = `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "$PWD $*" >> ${JSON.stringify(marker)}\ncase "$PWD" in *project-docs*) n=7;; *) n=15;; esac\necho "{\\"number\\":$n,\\"state\\":\\"OPEN\\",\\"isDraft\\":true,\\"mergeStateStatus\\":\\"CLEAN\\",\\"url\\":\\"https://example.test/pr/$n\\"}"\n`;
  const { env } = restrictedPath({ gh: ghScript });
  const inRepo = runWith({ cwd: build, env }, "session", "--pr");
  assert.equal(inRepo.code, 0);
  assert.equal(inRepo.json.pr.number, 15);
  assert.equal(inRepo.json.companionPr, null);
  assert.equal(inRepo.json.delivery.artifactPr, "#7");
  assert.deepEqual(inRepo.json.warnings, []);
  assert.equal(fs.readFileSync(marker, "utf8").trim().split("\n").length, 1, "in-repo mode runs gh pr view once");
  assert.equal(runWith({ cwd: build, env }, "session").json.companionPr, null, "without --pr companionPr is null too");

  // Companion mode: one gh pr view per repo, the companion one run from the companion clone.
  const pair = makePairRepo();
  const product = path.join(pair.wt, "feature-widget");
  const half = path.join(pair.docsWt, "feature-widget");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(pair.docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  writeRoadmap(pair.docs, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: x\nartifact-pr: \"#7\"");
  const pairMarker = path.join(pair.wt, "gh-invoked");
  const pairEnv = restrictedPath({ gh: ghScript.replace(JSON.stringify(marker), JSON.stringify(pairMarker)) }).env;
  const both = runWith({ cwd: product, env: pairEnv }, "session", "--pr");
  assert.equal(both.code, 0);
  assert.deepEqual(both.json.pr, { number: 15, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", url: "https://example.test/pr/15" });
  assert.deepEqual(both.json.companionPr, { number: 7, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", url: "https://example.test/pr/7" });
  assert.equal(both.json.delivery.artifactPr, "#7");
  assert.deepEqual(both.json.warnings, []);
  const calls = fs.readFileSync(pairMarker, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], new RegExp(`^${product} pr view feature/widget `));
  assert.match(calls[1], new RegExp(`^${pair.docs} pr view feature/widget `));
  assert.equal(git(pair.docs, "branch", "--show-current"), "main", "the companion clone is never switched");
  assert.equal(git(half, "branch", "--show-current"), "feature/widget");

  // The companion lookup degrades like pr: a failing gh there yields companionPr: null and one companionPr: warning.
  const failingEnv = restrictedPath({
    gh: `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\ncase "$PWD" in *project-docs*) echo 'no pull requests found for branch' >&2; exit 1;; esac\necho '{"number":15,"state":"OPEN","isDraft":true,"mergeStateStatus":"CLEAN","url":"u"}'\n`,
  }).env;
  const degraded = runWith({ cwd: product, env: failingEnv }, "session", "--pr");
  assert.equal(degraded.json.pr.number, 15);
  assert.equal(degraded.json.companionPr, null);
  assert.deepEqual(degraded.json.warnings.length, 1);
  assert.match(degraded.json.warnings[0], /^companionPr: gh pr view feature\/widget failed: no pull requests found/);

  // Half-shipped: the code PR merged while the companion PR is still open → companion-pr-open warning, lifecycle unchanged.
  const halfShippedEnv = restrictedPath({ gh: prStub(path.join(pair.wt, "gh-half"), { product: "MERGED", companion: "OPEN" }) }).env;
  const halfShipped = runWith({ cwd: product, env: halfShippedEnv }, "session", "--pr");
  assert.equal(halfShipped.json.lifecycle, "building");
  assert.deepEqual(halfShipped.json.warnings.map((w) => w.split(":")[0]), ["merged-but-not-complete", "companion-pr-open"]);
  assert.match(halfShipped.json.warnings[1], /^companion-pr-open: PR #15 for feature\/widget is merged but companion PR #7 is still open$/);
});

test("ship-preflight --pr: in-repo one gh call with companionPr null; companion mode both PRs and PR gaps; no --pr means no pr key", () => {
  // In-repo layout.
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(repo, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  const marker = path.join(wt, "gh-invoked");
  const { env } = restrictedPath({ gh: prStub(marker) });
  const plain = runWith({ cwd: repo, env }, "ship-preflight", "feature", "widget");
  assert.equal(plain.code, 0);
  assert.ok(!("pr" in plain.json) && !("companionPr" in plain.json) && !("warnings" in plain.json), "without --pr the output is today's shape");
  assert.ok(!fs.existsSync(marker), "gh was invoked without --pr");
  const inRepo = runWith({ cwd: repo, env }, "ship-preflight", "feature", "widget", "--pr");
  assert.equal(inRepo.code, 0);
  assert.equal(inRepo.json.pr.number, 15);
  assert.equal(inRepo.json.companionPr, null);
  assert.equal(inRepo.json.companion, null);
  assert.deepEqual(inRepo.json.companionGaps, []);
  assert.deepEqual(inRepo.json.warnings, []);
  const inRepoCalls = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.equal(inRepoCalls.length, 1, "in-repo mode runs gh pr view once");
  assert.match(inRepoCalls[0], new RegExp(`^${repo} pr view feature/widget --json number,state,isDraft,mergeStateStatus,mergeable,url$`));

  // Companion mode: both PRs, the companion one looked up from inside the clone.
  const pair = makePairRepo();
  const product = path.join(pair.wt, "feature-widget");
  const half = path.join(pair.docsWt, "feature-widget");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(pair.docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  writeRoadmap(pair.docs, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review\nartifact-pr: \"#7\"");
  const pairMarker = path.join(pair.wt, "gh-invoked");
  const shipWith = (states) => {
    fs.rmSync(pairMarker, { force: true });
    const json = runWith({ cwd: pair.repo, env: restrictedPath({ gh: prStub(pairMarker, states) }).env }, "ship-preflight", "feature", "widget", "--pr").json;
    return { json, calls: fs.existsSync(pairMarker) ? fs.readFileSync(pairMarker, "utf8").trim().split("\n") : [] };
  };
  const both = shipWith({});
  assert.equal(both.json.status, "ok");
  assert.deepEqual(both.json.pr, { number: 15, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", url: "https://example.test/pr/15" });
  assert.deepEqual(both.json.companionPr, { number: 7, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", url: "https://example.test/pr/7" });
  assert.deepEqual(both.json.companionGaps, []);
  assert.deepEqual(both.json.warnings, []);
  assert.equal(both.json.companion.path, half);
  assert.equal(both.calls.length, 2);
  assert.match(both.calls[0], new RegExp(`^${pair.repo} pr view feature/widget `));
  assert.match(both.calls[1], new RegExp(`^${pair.docs} pr view feature/widget `));
  assert.equal(git(pair.docs, "branch", "--show-current"), "main", "the companion clone is never switched");

  const missing = shipWith({ companion: "NONE" });
  assert.equal(missing.json.companionPr, null);
  assert.deepEqual(missing.json.companionGaps, ["missing-pr"]);
  assert.equal(missing.json.warnings.length, 1);
  assert.match(missing.json.warnings[0], /^companionPr: gh pr view feature\/widget failed/);
  assert.deepEqual(shipWith({ companion: "CLOSED" }).json.companionGaps, ["pr-not-open"]);
  assert.deepEqual(shipWith({ companionMerge: "DIRTY", companionMergeable: "CONFLICTING" }).json.companionGaps, ["conflicting-pr"]);
  const merged = shipWith({ product: "MERGED", companion: "MERGED" });
  assert.equal(merged.json.companionPr.state, "MERGED");
  assert.deepEqual(merged.json.companionGaps, [], "a merged companion PR is the resume-at-teardown case, not a gap");
  // The resume-at-companion-merge case: code merged, companion still open, no gap.
  const halfShipped = shipWith({ product: "MERGED", companion: "OPEN" });
  assert.deepEqual([halfShipped.json.pr.state, halfShipped.json.companionPr.state, halfShipped.json.companionGaps], ["MERGED", "OPEN", []]);
  // PR gaps stack on top of the half's own gaps.
  fs.writeFileSync(path.join(half, "wip.md"), "wip\n");
  assert.deepEqual(shipWith({ companion: "CLOSED" }).json.companionGaps, ["dirty", "pr-not-open"]);
  assert.ok(!("pr" in runWith({ cwd: pair.repo, env: restrictedPath({ gh: prStub(pairMarker) }).env }, "ship-preflight", "feature", "widget").json));
});

// --- next -------------------------------------------------------------------

// Commits with a fixed clock so review-freshness comparisons are deterministic.



const T2 = "2026-09-10T11:00:00Z";
const T3 = "2026-09-10T12:00:00Z";

function assertDispatch(json, agentExpected) {
  assert.ok(json.dispatch, "dispatch missing");
  assert.equal(json.dispatch.prompt, path.join(repoRoot, "skills", "agento", "commands", `${json.next.command}.md`));
  assert.ok(fs.existsSync(json.dispatch.prompt), json.dispatch.prompt);
  if (agentExpected === null) assert.equal(json.dispatch.agent, null);
  else {
    assert.equal(json.dispatch.agent, path.join(repoRoot, ".github", "agents", agentExpected));
    assert.ok(fs.existsSync(json.dispatch.agent), json.dispatch.agent);
  }
}

test("next from the primary: one in-progress roadmap → start-session --resume with then; two → ambiguous", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  commitAt(build, "plan widget", T1);
  git(build, "push", "-q", "-u", "origin", "feature/widget");

  // The roadmap is only on the branch; the primary sees it through the worktree + origin.
  const one = run(repo, "next");
  assert.equal(one.code, 0);
  assert.equal(one.json.status, "ok");
  assert.equal(one.json.role, "primary");
  assert.equal(one.json.slug, "widget");
  assert.equal(one.json.type, "feature");
  assert.deepEqual(one.json.next, {
    command: "start-session",
    args: ["feature/widget", "--resume"],
    invocation: "/agento start-session feature/widget --resume",
    window: "here",
    then: "/agento continue widget",
    reason: one.json.next.reason,
    target: null,
  });
  assert.match(one.json.next.reason, /in-progress/);
  assertDispatch(one.json, null);
  assert.deepEqual(one.json.warnings, []);
  // The explicit slug selects the same transition.
  assert.deepEqual(run(repo, "next", "widget").json.next, one.json.next);

  // A second in-flight roadmap on main makes the choice ambiguous (exit 3).
  writeRoadmap(repo, "issues/2026/09/bug", "status: paused\nbranch: issue/bug\nnext-step: \"1.1\"");
  const two = run(repo, "next");
  assert.equal(two.code, 3);
  assert.equal(two.json.status, "ambiguous");
  assert.equal(two.json.next, null);
  assert.equal(two.json.dispatch, null);
  assert.deepEqual(
    two.json.candidates.map((c) => [c.kind, c.slug, c.type, c.status, c.invocation]).sort(),
    [
      ["delivery", "bug", "issue", "paused", "/agento continue bug"],
      ["delivery", "widget", "feature", "in-progress", "/agento continue widget"],
    ],
  );
  assert.equal(two.json.candidates.find((c) => c.slug === "widget").owner.path, build);
  assert.equal(two.json.candidates.find((c) => c.slug === "bug").owner, null);

  // Naming a candidate resolves it: an unowned paused issue opens a fresh session.
  const bug = run(repo, "next", "bug");
  assert.equal(bug.code, 0);
  assert.equal(bug.json.next.invocation, "/agento start-session issue/bug");
  assert.equal(bug.json.next.then, "/agento continue bug");

  // Unknown slugs are missing (exit 3) with the find-style message.
  const missing = run(repo, "next", "nope");
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "missing");
  assert.match(missing.json.reason, /No roadmap for slug nope/);
  assert.equal(run(repo, "next", "alpha", "beta").code, 1);
});

test("next in a build worktree: in-progress → build-feature here with dispatch paths; wrong slug → blocked", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");

  const { code, json } = run(build, "next");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.role, "build");
  assert.equal(json.lifecycle, "building");
  assert.equal(json.next.invocation, "/agento build-feature widget");
  assert.equal(json.next.window, "here");
  assert.equal(json.next.then, null);
  assert.equal(json.next.target, null, "window here carries no target");
  assert.equal(json.reviewFresh, null);
  assertDispatch(json, "delivery-builder.agent.md");

  const wrong = run(build, "next", "other");
  assert.equal(wrong.code, 3);
  assert.equal(wrong.json.status, "blocked");
  assert.match(wrong.json.reason, /wrong window for other/);

  // An issue worktree dispatches build-issue with the same Builder agent.
  const issue = path.join(wt, "issue-bug");
  git(repo, "worktree", "add", "-q", "-b", "issue/bug", issue);
  writeRoadmap(issue, "issues/2026/09/bug", "status: planned\nbranch: issue/bug\nnext-step: \"1.1\"");
  const planned = run(issue, "next").json;
  assert.equal(planned.next.invocation, "/agento build-issue bug");
  assertDispatch(planned, "delivery-builder.agent.md");
});

test("next: review freshness decides between ship, re-review, and the fix handoff", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  const dir = "features/2026/09/widget";
  writeRoadmap(build, dir, "status: in-review\nbranch: feature/widget\nnext-step: review");
  commitAt(build, "build done", T1);

  // No review.md yet: the Reviewer runs here.
  const pending = run(build, "next").json;
  assert.equal(pending.lifecycle, "in-review");
  assert.equal(pending.next.invocation, "/agento review-feature widget");
  assert.equal(pending.reviewFresh, null);
  assertDispatch(pending, "delivery-reviewer.agent.md");

  // Fresh approve (review.md is the newest commit): ship — from the primary window
  // when asked in the worktree, here when asked from the primary.
  fs.writeFileSync(path.join(build, dir, "review.md"), "# Review\n\nVerdict: approve\n");
  commitAt(build, "review: approve", T2);
  git(build, "push", "-q", "-u", "origin", "feature/widget");
  const approved = run(build, "next").json;
  assert.equal(approved.lifecycle, "approved");
  assert.equal(approved.reviewFresh, true);
  assert.equal(approved.next.invocation, "/agento ship widget");
  assert.equal(approved.next.window, "primary");
  assert.deepEqual(approved.next.target, { path: repo, workspace: null }, "window primary targets the primary checkout");
  assertDispatch(approved, null);
  const fromPrimary = run(repo, "next").json;
  assert.equal(fromPrimary.status, "ok");
  assert.equal(fromPrimary.next.invocation, "/agento ship widget");
  assert.equal(fromPrimary.next.window, "here");
  assert.equal(fromPrimary.next.then, null);
  assert.equal(fromPrimary.next.target, null);
  assert.equal(fromPrimary.reviewFresh, true);

  // A code commit after the approve makes it stale: re-review here; the primary reopens the window.
  fs.writeFileSync(path.join(build, "src.txt"), "later change\n");
  commitAt(build, "fix: later change", T3);
  git(build, "push", "-q", "origin", "feature/widget");
  const stale = run(build, "next").json;
  assert.equal(stale.reviewFresh, false);
  assert.equal(stale.next.invocation, "/agento review-feature widget");
  assert.equal(stale.next.window, "here");
  const stalePrimary = run(repo, "next").json;
  assert.equal(stalePrimary.next.invocation, "/agento start-session feature/widget --resume");
  assert.equal(stalePrimary.next.then, "/agento continue widget");

  // A branch never pushed is judged from the local branch, with one warning.
  const local = path.join(wt, "issue-bug");
  git(repo, "worktree", "add", "-q", "-b", "issue/bug", local);
  writeRoadmap(local, "issues/2026/09/bug", "status: in-review\nbranch: issue/bug\nnext-step: review");
  fs.writeFileSync(path.join(local, "issues/2026/09/bug/review.md"), "# Review\n\nVerdict: request-changes\n");
  commitAt(local, "review: request changes", T1);
  const fix = run(local, "next").json;
  assert.equal(fix.lifecycle, "in-review");
  assert.equal(fix.reviewFresh, true);
  assert.equal(fix.next.invocation, "/agento build-issue bug");
  assert.match(fix.next.reason, /request-changes/);
  assert.equal(fix.warnings.length, 1);
  assert.match(fix.warnings[0], /origin\/issue\/bug is absent/);
  // Builder commits after the request-changes review: back to the Reviewer.
  fs.writeFileSync(path.join(local, "fix.txt"), "fixed\n");
  commitAt(local, "fix: address review", T2);
  assert.equal(run(local, "next").json.next.invocation, "/agento review-issue bug");
});

test("#60 autopilot-in-review-handoff: in-review transitions continue to reviewer while /agento ap stays available", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "issue-bug");
  git(repo, "worktree", "add", "-q", "-b", "issue/bug", build);
  writeRoadmap(build, "issues/2026/09/bug", "status: in-review\nbranch: issue/bug\nnext-step: review");
  commitAt(build, "build: issue ready for review", T1);

  const session = run(build, "session").json;
  assert.ok(session.allowed.includes("/agento ap bug"), "in-review worktrees must keep /agento ap available for unattended re-send");

  const next = run(build, "next").json;
  assert.equal(next.lifecycle, "in-review");
  assert.equal(next.next.invocation, "/agento review-issue bug");
  assert.match(next.next.reason, /Reviewer runs in this window/);
});

test("next: complete with a managed owner resumes ship at teardown; without one there is nothing to continue", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  const dir = "features/2026/09/widget";
  writeRoadmap(build, dir, "status: complete\nbranch: feature/widget\nnext-step: \"\"");
  fs.writeFileSync(path.join(build, dir, "review.md"), "# Review\n\nVerdict: approve\n");
  commitAt(build, "ship", T1);
  git(build, "push", "-q", "-u", "origin", "feature/widget");

  const inWorktree = run(build, "next").json;
  assert.equal(inWorktree.lifecycle, "shipped");
  assert.equal(inWorktree.next.invocation, "/agento ship widget");
  assert.equal(inWorktree.next.window, "primary");
  assert.match(inWorktree.next.reason, /tear/);

  const fromPrimary = run(repo, "next");
  assert.equal(fromPrimary.code, 0);
  assert.equal(fromPrimary.json.next.invocation, "/agento ship widget");
  assert.equal(fromPrimary.json.next.window, "here");
  assert.match(fromPrimary.json.next.reason, /teardown/);

  // Worktree gone, roadmap merged and complete: none (exit 0), and it is not a candidate.
  git(repo, "worktree", "remove", "--force", build);
  git(repo, "merge", "-q", "--ff-only", "feature/widget");
  const done = run(repo, "next");
  assert.equal(done.code, 0);
  assert.equal(done.json.status, "none");
  assert.equal(done.json.next, null);
  assert.match(done.json.reason, /nothing is in flight/);
  const named = run(repo, "next", "widget");
  assert.equal(named.code, 0);
  assert.equal(named.json.status, "none");
  assert.match(named.json.reason, /widget is complete/);

  // Post-ship steps pending: ship resumes at its epilogue from the primary.
  writeRoadmap(repo, dir, "status: complete\nbranch: feature/widget\nnext-step: \"\"", "- [x] 1.1 done — verify: x\n- [ ] 1.2 (manual, post-ship) flip the flag — verify: y\n");
  const epilogue = run(repo, "next").json;
  assert.equal(epilogue.status, "ok");
  assert.equal(epilogue.next.invocation, "/agento ship widget");
  assert.match(epilogue.next.reason, /post-ship/);
});

const trio = [{ slug: "alpha" }, { slug: "beta", recommendedAfter: ["alpha"] }, { slug: "gamma", requires: ["beta"] }];

test("next: ready initiative members drive start-session from the primary and new-feature from a plan window", () => {
  const { repo, wt } = makeWorktreeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, trio);
  commitAt(repo, "breakdown", T1);
  git(repo, "push", "-q", "origin", "main");

  // alpha and beta are both ready (Recommended after does not block); gamma requires beta.
  const fromPrimary = run(repo, "next");
  assert.equal(fromPrimary.code, 3);
  assert.equal(fromPrimary.json.status, "ambiguous");
  assert.deepEqual(fromPrimary.json.candidates.map((c) => [c.kind, c.slug, c.initiative, c.invocation]), [
    ["initiative-member", "alpha", "demo", "/agento continue alpha"],
    ["initiative-member", "beta", "demo", "/agento continue beta"],
  ]);
  const picked = run(repo, "next", "alpha");
  assert.equal(picked.code, 0);
  assert.deepEqual(picked.json.next.args, []);
  assert.equal(picked.json.next.invocation, "/agento start-session");
  assert.equal(picked.json.next.then, "/agento continue alpha");
  assert.equal(picked.json.next.target, null, "start-session runs here: no target");
  assert.equal(picked.json.slug, "alpha");
  assertDispatch(picked.json, null);

  // A detached plan worktree with the same breakdown: the Planner runs here for the named member.
  const plan = path.join(wt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  const inPlan = run(plan, "next", "alpha");
  assert.equal(inPlan.code, 0);
  assert.equal(inPlan.json.role, "plan");
  assert.equal(inPlan.json.next.invocation, "/agento new-feature initiative:demo/alpha");
  assert.equal(inPlan.json.next.window, "here");
  assertDispatch(inPlan.json, "delivery-planner.agent.md");
  assert.equal(run(plan, "next").json.status, "ambiguous");
  assert.equal(run(plan, "next", "zzz").json.status, "missing");

  // Once alpha is planned on its branch and owned by a worktree, it stops being a ready
  // member and becomes the delivery candidate; beta alone stays ready.
  const build = path.join(wt, "feature-alpha");
  git(repo, "worktree", "add", "-q", "-b", "feature/alpha", build);
  writeRoadmap(build, "features/2026/09/alpha", 'status: planned\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.1"');
  commitAt(build, "plan alpha", T2);
  git(build, "push", "-q", "-u", "origin", "feature/alpha");
  const after = run(repo, "next");
  assert.equal(after.json.status, "ambiguous");
  assert.deepEqual(after.json.candidates.map((c) => [c.kind, c.slug, c.status]).sort(), [
    ["delivery", "alpha", "planned"],
    ["initiative-member", "beta", "unplanned"],
  ]);
  assert.equal(run(repo, "next", "alpha").json.next.invocation, "/agento start-session feature/alpha --resume");
  // In the plan worktree only the single remaining ready member counts: new-feature without a slug.
  const single = run(plan, "next").json;
  assert.equal(single.status, "ok");
  assert.equal(single.next.invocation, "/agento new-feature initiative:demo/beta");
});

test("next: freehand worktrees are unsupported; the primary on a delivery branch and an unplanned build branch are blocked", () => {
  const { repo, wt } = makeWorktreeRepo();
  const freehand = path.join(wt, "freehand-tidy");
  git(repo, "worktree", "add", "-q", "-b", "changes/tidy", freehand);
  const { code, json } = run(freehand, "next");
  assert.equal(code, 3);
  assert.equal(json.status, "unsupported");
  assert.equal(json.role, "freehand");
  assert.equal(json.next, null);
  assert.equal(json.dispatch, null);
  assert.match(json.reason, /role freehand/);

  // The primary checkout itself on a delivery branch must go back to main first.
  writeRoadmap(repo, "features/2026/09/hot", "status: in-progress\nbranch: feature/hot\nnext-step: \"1.1\"");
  commitAt(repo, "hot", T1);
  git(repo, "switch", "-q", "-c", "feature/hot");
  const onBranch = run(repo, "next");
  assert.equal(onBranch.code, 3);
  assert.equal(onBranch.json.status, "blocked");
  assert.match(onBranch.json.reason, /primary checkout is on feature\/hot/);

  // A build-role worktree whose branch has no roadmap is blocked until planned.
  git(repo, "switch", "-q", "main");
  const fresh = path.join(wt, "plan-2");
  git(repo, "worktree", "add", "-q", "-b", "feature/fresh", fresh);
  const unplanned = run(fresh, "next");
  assert.equal(unplanned.code, 3);
  assert.equal(unplanned.json.status, "blocked");
  assert.equal(unplanned.json.role, "build");
  assert.match(unplanned.json.reason, /no roadmap yet/);
});

test("next: the usage header lists the subcommand", () => {
  const repo = makeRepo();
  const usage = run(repo, "bogus");
  assert.ok(usage.json.usage.some((line) => line.includes("next [<slug>]")), JSON.stringify(usage.json.usage));
});

// --- start-session -------------------------------------------------------------

// A PATH with node, git, and (unless `code: false`) a `code` stub that logs
// every call other than `--version`, so no test ever opens a real window.
function startSessionEnv({ code = true } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-code-log-")), "code.log");
  const stubs = {};
  if (code) stubs.code = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.99.0; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\n`;
  const { env } = restrictedPath(stubs);
  const opened = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { env, opened };
}

const startSession = (cwd, env, ...args) => runWith({ cwd, env }, "start-session", ...args);

// Publish <branch> from main (optionally writing files first), then return to main;
// `keepLocal` keeps the local branch, `localAhead` adds an unpushed commit to it.




test("start-session validates its arguments and is listed in the usage header", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env } = startSessionEnv();
  for (const args of [["a", "b"], ["--resume"], ["Bad_Id"], ["feature/Bad_Slug"], ["chore/x"], ["--bogus"]]) {
    const { code, json } = startSession(repo, env, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
  assert.match(run(repo).json.usage.join("\n"), /start-session \[<feature\|issue>\/<slug> \| <session-id>\] \[--resume\] \[--no-open\]/);
  assert.match(run(repo).json.usage.join("\n"), /Options: --root <dir>/);
  assert.deepEqual(fs.readdirSync(wt), []);
});

test("start-session rejects a managed window, a primary off the default branch (including one on the delivery branch), and a dirty primary, writing nothing", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env, opened } = startSessionEnv();
  const plan = path.join(wt, "plan-existing");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");

  const fromPlan = startSession(plan, env);
  assert.equal(fromPlan.code, 3);
  assert.equal(fromPlan.json.status, "rejected");
  assert.match(fromPlan.json.reason, /^wrong window: role=plan \(.*plan-existing, branch detached\)$/);
  const record = run(plan, "session").json;
  assert.deepEqual(fromPlan.json.allowed, record.allowed);
  assert.deepEqual(fromPlan.json.elsewhere, record.elsewhere);

  publishBranch(repo, "feature/widget", roadmapFor("feature", "widget"), { keepLocal: true });
  git(repo, "switch", "-q", "feature/widget");
  const offMain = startSession(repo, env, "feature/widget");
  assert.equal(offMain.code, 3);
  assert.equal(offMain.json.status, "rejected");
  assert.match(offMain.json.reason, /^primary checkout not on main \(.*, branch feature\/widget\)$/);
  git(repo, "switch", "-q", "main");

  fs.writeFileSync(path.join(repo, "scratch.txt"), "x");
  const dirty = startSession(repo, env);
  assert.equal(dirty.code, 3);
  assert.equal(dirty.json.status, "rejected");
  assert.match(dirty.json.reason, /^primary checkout is dirty/);
  fs.rmSync(path.join(repo, "scratch.txt"));

  assert.deepEqual(fs.readdirSync(wt), ["plan-existing"]);
  assert.equal(worktreeCount(repo), 2);
  assert.deepEqual(opened(), []);
});

test("start-session warns and continues when origin is unreachable, and stops with a re-login command on an authentication failure", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env } = startSessionEnv();
  git(repo, "remote", "set-url", "origin", path.join(path.dirname(repo), "missing.git"));
  const offline = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(offline.code, 0);
  assert.equal(offline.json.status, "ok");
  assert.equal(offline.json.outcome, "created");
  assert.ok(offline.json.warnings.some((w) => /^fetch: product .*missing\.git not fetched \(.*\); continuing from local refs$/.test(w)), offline.json.warnings.join("\n"));

  const ssh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-ssh-")), "ssh");
  fs.writeFileSync(ssh, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n", { mode: 0o755 });
  git(repo, "remote", "set-url", "origin", "git@example.invalid:o/r.git");
  const auth = startSession(repo, { ...env, GIT_SSH_COMMAND: ssh }, "20261008-2", "--no-open");
  assert.equal(auth.code, 3);
  assert.equal(auth.json.status, "failed");
  assert.equal(auth.json.reason, "fetch-auth");
  assert.match(auth.json.message, /Permission denied \(publickey\)/);
  assert.match(auth.json.reauth, /git@example\.invalid:o\/r\.git/);
  assert.equal(fs.existsSync(path.join(wt, "plan-20261008-2")), false);
});

test("start-session plan mode creates a detached session at origin/main and resumes it untouched, promoted or not (in-repo)", () => {
  const { repo, wt } = makeWorktreeRepo();
  const origin = path.join(path.dirname(repo), "project.git");
  const { env, opened } = startSessionEnv();

  const fresh = startSession(repo, env, "--no-open");
  assert.equal(fresh.code, 0);
  const { json } = fresh;
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "plan");
  assert.equal(json.outcome, "created");
  assert.match(json.subject, /^\d{8}-\d{6}(-\d+)?$/);
  const half = path.join(wt, `plan-${json.subject}`);
  assert.deepEqual(json.product, { path: half, branch: null, detached: true, state: { onDisk: true, registeredIn: "product", origin, expectedOrigin: origin, ok: true } });
  assert.equal(git(half, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(json.companion, null);
  assert.equal(json.workspace, null);
  assert.deepEqual(json.target, { kind: "folder", path: half });
  assert.equal(json.opened, false);
  assert.equal(json.openCommand, `code --new-window ${half}`);
  assert.deepEqual(json.next, ["/agento new-feature <description>", "/agento new-issue <description>"]);
  assert.equal(json.reason, null);
  assert.deepEqual(opened(), []);

  const created = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(created.json.outcome, "created");
  assert.equal(created.json.subject, "20261008-1");
  const session = path.join(wt, "plan-20261008-1");
  const marker = path.join(session, "notes.txt");
  fs.writeFileSync(marker, "keep");
  const head = git(session, "rev-parse", "HEAD");
  for (const extra of [[], ["--resume"]]) {
    const again = startSession(repo, env, "20261008-1", ...extra, "--no-open");
    assert.equal(again.code, 0);
    assert.equal(again.json.outcome, "resumed");
    assert.equal(fs.readFileSync(marker, "utf8"), "keep");
    assert.equal(git(session, "rev-parse", "HEAD"), head);
  }

  git(session, "switch", "-q", "-c", "feature/widget");
  const promoted = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(promoted.json.outcome, "resumed");
  assert.equal(promoted.json.product.branch, "feature/widget");
  assert.equal(promoted.json.product.detached, false);
  assert.equal(git(session, "branch", "--show-current"), "feature/widget");
});

test("start-session plan mode creates and resumes a companion pair and writes or refreshes its workspace file", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const { env } = startSessionEnv();
  const product = path.join(wt, "plan-20261008-1");
  const half = path.join(docsWt, "plan-20261008-1");
  const file = path.join(wt, "plan-20261008-1.code-workspace");

  const { code, json } = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(code, 0);
  assert.equal(json.outcome, "created");
  assert.equal(json.product.path, product);
  assert.equal(json.companion.path, half);
  assert.equal(json.companion.detached, true);
  assert.equal(json.companion.state.registeredIn, "companion");
  assert.equal(json.companion.state.ok, true);
  assert.equal(git(half, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
  assert.deepEqual(json.workspace, { path: file, written: true });
  assert.deepEqual(json.target, { kind: "workspace", path: file });
  assert.equal(json.openCommand, `code --new-window ${file}`);
  const expected = { folders: [{ path: product }, { path: half }], settings: SESSION_WORKSPACE_SETTINGS };
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected);

  const again = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(again.json.outcome, "resumed");
  assert.deepEqual(again.json.workspace, { path: file, written: false });

  fs.writeFileSync(file, "{}\n");
  const refreshed = startSession(repo, env, "20261008-1", "--resume", "--no-open");
  assert.equal(refreshed.json.outcome, "resumed");
  assert.deepEqual(refreshed.json.workspace, { path: file, written: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected);

  git(product, "switch", "-q", "-c", "feature/widget");
  git(half, "switch", "-q", "-c", "feature/widget");
  const promoted = startSession(repo, env, "20261008-1", "--no-open");
  assert.equal(promoted.json.outcome, "resumed");
  assert.equal(promoted.json.product.branch, "feature/widget");
  assert.equal(promoted.json.companion.branch, "feature/widget");
  assert.equal(worktreeCount(repo), 2);
  assert.equal(worktreeCount(docs), 2);
});

test("start-session build mode: origin-only branch tracks, a local branch is used, a managed owner resumes, missing/complete/mismatched roadmaps reject (in-repo)", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env } = startSessionEnv();

  publishBranch(repo, "feature/remote", roadmapFor("feature", "remote"));
  const remote = startSession(repo, env, "feature/remote", "--no-open");
  assert.equal(remote.code, 0);
  assert.equal(remote.json.mode, "build");
  assert.equal(remote.json.subject, "feature/remote");
  assert.equal(remote.json.outcome, "created");
  const remoteHalf = path.join(wt, "feature-remote");
  assert.equal(remote.json.product.path, remoteHalf);
  assert.equal(remote.json.product.branch, "feature/remote");
  assert.equal(remote.json.product.state.ok, true);
  assert.equal(git(remoteHalf, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/remote");
  assert.deepEqual(remote.json.next, ["/agento build-feature remote"]);
  assert.equal(remote.json.companion, null);
  assert.deepEqual(remote.json.target, { kind: "folder", path: remoteHalf });

  publishBranch(repo, "feature/local", roadmapFor("feature", "local"), { localAhead: true });
  const localTip = git(repo, "rev-parse", "refs/heads/feature/local");
  const local = startSession(repo, env, "feature/local", "--no-open");
  assert.equal(local.json.outcome, "created");
  assert.equal(git(path.join(wt, "feature-local"), "rev-parse", "HEAD"), localTip);
  assert.notEqual(localTip, git(repo, "rev-parse", "origin/feature/local"));

  publishBranch(repo, "issue/bug", roadmapFor("issue", "bug"));
  const issue = startSession(repo, env, "issue/bug", "--no-open");
  assert.equal(issue.json.outcome, "created");
  assert.equal(issue.json.product.path, path.join(wt, "issue-bug"));
  assert.deepEqual(issue.json.next, ["/agento build-issue bug"]);

  publishBranch(repo, "feature/owned", roadmapFor("feature", "owned"), { keepLocal: true });
  const promoted = path.join(wt, "plan-20261008-9");
  git(repo, "worktree", "add", "-q", promoted, "feature/owned");
  fs.writeFileSync(path.join(promoted, "wip.txt"), "keep");
  for (const extra of [[], ["--resume"]]) {
    const owned = startSession(repo, env, "feature/owned", ...extra, "--no-open");
    assert.equal(owned.code, 0);
    assert.equal(owned.json.outcome, "resumed");
    assert.equal(owned.json.product.path, promoted);
    assert.equal(owned.json.product.branch, "feature/owned");
  }
  assert.equal(fs.readFileSync(path.join(promoted, "wip.txt"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(wt, "feature-owned")), false);

  roadmapFor("feature", "ghost", "planned")(repo);
  roadmapFor("feature", "done", "complete")(repo);
  roadmapFor("feature", "odd", "planned", "feature/other")(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "roadmaps on main");
  git(repo, "push", "-q", "origin", "main");
  const ghost = startSession(repo, env, "feature/ghost", "--no-open");
  assert.equal(ghost.code, 3);
  assert.equal(ghost.json.status, "rejected");
  assert.match(ghost.json.reason, /feature\/ghost exists neither locally nor on origin; the delivery planner must publish it/);
  const done = startSession(repo, env, "feature/done", "--no-open");
  assert.equal(done.json.status, "rejected");
  assert.match(done.json.reason, /complete.*no build session is needed/);
  const odd = startSession(repo, env, "feature/odd", "--no-open");
  assert.equal(odd.json.status, "rejected");
  assert.equal(odd.json.resolution, "branch-mismatch");
  assert.match(odd.json.reason, /branch mismatch/);
  const nope = startSession(repo, env, "feature/nope", "--no-open");
  assert.equal(nope.json.status, "rejected");
  assert.equal(nope.json.resolution, "missing");
  for (const slug of ["ghost", "done", "odd", "nope"]) assert.equal(fs.existsSync(path.join(wt, `feature-${slug}`)), false);
});

test("start-session build mode in companion mode: a mirrored companion branch tracks, an absent one is created --no-track with a push warning, a promoted pair resumes", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const { env } = startSessionEnv();

  publishBranch(repo, "feature/mirror");
  publishBranch(docs, "feature/mirror", roadmapFor("feature", "mirror"));
  const mirror = startSession(repo, env, "feature/mirror", "--no-open");
  assert.equal(mirror.code, 0, JSON.stringify(mirror.json));
  assert.equal(mirror.json.outcome, "created");
  const mirrorHalf = path.join(docsWt, "feature-mirror");
  assert.equal(mirror.json.companion.path, mirrorHalf);
  assert.equal(mirror.json.companion.branch, "feature/mirror");
  assert.equal(mirror.json.companion.state.ok, true);
  assert.equal(git(mirrorHalf, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature/mirror");
  assert.equal(mirror.json.product.branch, "feature/mirror");
  const mirrorFile = path.join(wt, "feature-mirror.code-workspace");
  assert.deepEqual(mirror.json.workspace, { path: mirrorFile, written: true });
  assert.deepEqual(mirror.json.target, { kind: "workspace", path: mirrorFile });
  assert.ok(!mirror.json.warnings.some((w) => w.startsWith("companion-branch:")));

  roadmapFor("feature", "legacy")(docs);
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "legacy roadmap");
  git(docs, "push", "-q", "origin", "main");
  publishBranch(repo, "feature/legacy");
  const legacy = startSession(repo, env, "feature/legacy", "--no-open");
  assert.equal(legacy.code, 0, JSON.stringify(legacy.json));
  const legacyHalf = path.join(docsWt, "feature-legacy");
  assert.equal(legacy.json.companion.branch, "feature/legacy");
  assert.equal(git(legacyHalf, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
  assert.throws(() => git(legacyHalf, "rev-parse", "--abbrev-ref", "@{upstream}"));
  assert.ok(legacy.json.warnings.some((w) => /^companion-branch: feature\/legacy did not exist .*push -u origin feature\/legacy$/.test(w)), legacy.json.warnings.join("\n"));

  publishBranch(repo, "feature/promo", null, { keepLocal: true });
  publishBranch(docs, "feature/promo", roadmapFor("feature", "promo"), { keepLocal: true });
  git(repo, "worktree", "add", "-q", path.join(wt, "plan-20261008-7"), "feature/promo");
  git(docs, "worktree", "add", "-q", path.join(docsWt, "plan-20261008-7"), "feature/promo");
  const promo = startSession(repo, env, "feature/promo", "--no-open");
  assert.equal(promo.code, 0, JSON.stringify(promo.json));
  assert.equal(promo.json.outcome, "resumed");
  assert.equal(promo.json.product.path, path.join(wt, "plan-20261008-7"));
  assert.equal(promo.json.companion.path, path.join(docsWt, "plan-20261008-7"));
  assert.deepEqual(promo.json.workspace, { path: path.join(wt, "plan-20261008-7.code-workspace"), written: true });
  assert.equal(fs.existsSync(path.join(wt, "feature-promo")), false);
  assert.equal(fs.existsSync(path.join(docsWt, "feature-promo")), false);
});

test("start-session fails the post-add check for a companion half registered in the product clone, writing, opening, and removing nothing (#86)", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const base = path.dirname(repo);
  const { env, opened } = startSessionEnv();
  const product = path.join(wt, "plan-20261004-1");
  const stray = path.join(docsWt, "plan-20261004-1");
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(repo, "worktree", "add", "-q", "--detach", stray, "origin/main");
  const before = [git(repo, "worktree", "list", "--porcelain"), git(docs, "worktree", "list", "--porcelain")];

  const { code, json } = startSession(repo, env, "20261004-1");
  assert.equal(code, 3);
  assert.equal(json.status, "failed");
  assert.equal(json.reason, "post-add-check");
  assert.equal(json.half, "companion");
  assert.equal(json.registeredIn, "product");
  assert.equal(json.origin, path.join(base, "project.git"));
  assert.equal(json.expectedOrigin, path.join(base, "project-docs.git"));
  assert.equal(json.fix, `git -C ${repo} worktree remove ${stray}`);
  assert.equal(json.workspace, null);
  assert.equal(json.opened, false);
  assert.deepEqual(opened(), []);
  assert.equal(fs.existsSync(path.join(wt, "plan-20261004-1.code-workspace")), false);
  assert.deepEqual([git(repo, "worktree", "list", "--porcelain"), git(docs, "worktree", "list", "--porcelain")], before);
  assert.ok(fs.existsSync(product) && fs.existsSync(stray));

  // A failing `git worktree add` reports its stderr: the branch is checked out in an unmanaged worktree.
  const other = makeWorktreeRepo();
  publishBranch(other.repo, "feature/busy", roadmapFor("feature", "busy"), { keepLocal: true });
  git(other.repo, "worktree", "add", "-q", path.join(path.dirname(other.repo), "elsewhere"), "feature/busy");
  const busy = startSession(other.repo, env, "feature/busy", "--no-open");
  assert.equal(busy.code, 3);
  assert.equal(busy.json.status, "failed");
  assert.equal(busy.json.reason, "worktree-add");
  assert.equal(busy.json.half, "product");
  assert.match(busy.json.message, /worktree add .*feature\/busy/);
  assert.equal(fs.existsSync(path.join(other.wt, "feature-busy")), false);
});

test("start-session opens the target with code --new-window unless --no-open, reopens on resume, and reports openCommand without code", () => {
  const pair = makePairRepo();
  const { env, opened } = startSessionEnv();
  const file = path.join(pair.wt, "plan-20261008-1.code-workspace");
  const first = startSession(pair.repo, env, "20261008-1");
  assert.equal(first.code, 0);
  assert.equal(first.json.opened, true);
  assert.deepEqual(opened(), [`--new-window ${file}`]);
  const again = startSession(pair.repo, env, "20261008-1");
  assert.equal(again.json.outcome, "resumed");
  assert.equal(again.json.opened, true);
  assert.deepEqual(opened(), [`--new-window ${file}`, `--new-window ${file}`]);
  const quiet = startSession(pair.repo, env, "20261008-1", "--no-open");
  assert.equal(quiet.json.opened, false);
  assert.equal(quiet.json.openCommand, `code --new-window ${file}`);
  assert.equal(opened().length, 2);

  const inRepo = makeWorktreeRepo();
  const folder = startSession(inRepo.repo, env, "20261008-2");
  assert.equal(folder.json.opened, true);
  assert.equal(opened().at(-1), `--new-window ${path.join(inRepo.wt, "plan-20261008-2")}`);

  const bare = startSessionEnv({ code: false });
  const missing = startSession(inRepo.repo, bare.env, "20261008-3");
  assert.equal(missing.code, 0);
  assert.equal(missing.json.opened, false);
  assert.equal(missing.json.openCommand, `code --new-window ${path.join(inRepo.wt, "plan-20261008-3")}`);
  const codeCheck = missing.json.preflight.find((p) => p.id === "code");
  assert.equal(codeCheck.status, "warn");
  assert.equal(codeCheck.capability, "code");
  assert.match(codeCheck.fallback, /code --new-window/);
  assert.ok(missing.json.warnings.some((w) => /^open: code CLI not found on PATH; run code --new-window /.test(w)), missing.json.warnings.join("\n"));
});

// --- close-session -------------------------------------------------------------

// A PATH with node and git plus, when `status` is given, a `code` stub printing it
// for `code --status`; never the real VS Code.
function closeSessionEnv(status = null) {
  const stubs = status === null ? {} : { code: `#!/bin/sh\nprintf '%s\\n' '${status.replaceAll("'", "")}'\n` };
  return restrictedPath(stubs).env;
}

const closeSession = (cwd, env, ...args) => runWith({ cwd, env }, "close-session", ...args);

// Worktree registrations and local branches of each clone, for "nothing changed" checks.


test("close-session validates its arguments and is listed in the usage header", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  for (const args of [[], ["a", "b"], ["Bad_Id"], ["feature/Bad_Slug"], ["changes/"], ["changes/Bad_Slug"], ["chore/x"], ["x", "--bogus"]]) {
    const { code, json } = closeSession(repo, env, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
  const usage = run(repo).json.usage.join("\n");
  assert.match(usage, /close-session <feature\|issue>\/<slug> \| changes\/<slug> \| <session-id> \[--dry-run\] \[--ignore-occupants\]/);
  assert.match(usage, /Options: --root <dir>/);
  assert.deepEqual(fs.readdirSync(wt), []);
});

test("close-session rejects from a non-primary window with the session record's alternatives, removing nothing", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  const plan = path.join(wt, "plan-20261009-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  const before = cloneState(repo);

  const { code, json } = closeSession(plan, env, "20261009-1");
  assert.equal(code, 3);
  assert.equal(json.status, "rejected");
  assert.match(json.reason, /^wrong window: role=plan \(.*plan-20261009-1, branch detached\)$/);
  const record = run(plan, "session").json;
  assert.deepEqual(json.allowed, record.allowed);
  assert.deepEqual(json.elsewhere, record.elsewhere);
  assert.equal(json.applied, false);
  assert.deepEqual(cloneState(repo), before);
  assert.ok(fs.existsSync(plan));
});

test("close-session warns and continues when origin is unreachable, and fails with a re-login command on an authentication failure before any write", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  const first = path.join(wt, "plan-20261009-1");
  const second = path.join(wt, "plan-20261009-2");
  git(repo, "worktree", "add", "-q", "--detach", first, "origin/main");
  git(repo, "worktree", "add", "-q", "--detach", second, "origin/main");

  git(repo, "remote", "set-url", "origin", path.join(path.dirname(repo), "missing.git"));
  const offline = closeSession(repo, env, "20261009-1");
  assert.equal(offline.code, 0, JSON.stringify(offline.json));
  assert.equal(offline.json.status, "ok");
  assert.equal(offline.json.outcome, "closed");
  assert.ok(offline.json.warnings.some((w) => /^fetch: product .*missing\.git not fetched \(.*\); continuing from local refs$/.test(w)), offline.json.warnings.join("\n"));
  assert.equal(fs.existsSync(first), false);

  const ssh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-ssh-")), "ssh");
  fs.writeFileSync(ssh, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n", { mode: 0o755 });
  git(repo, "remote", "set-url", "origin", "git@example.invalid:o/r.git");
  const before = cloneState(repo);
  const auth = closeSession(repo, { ...env, GIT_SSH_COMMAND: ssh }, "20261009-2");
  assert.equal(auth.code, 3);
  assert.equal(auth.json.status, "failed");
  assert.equal(auth.json.reason, "fetch-auth");
  assert.match(auth.json.message, /Permission denied \(publickey\)/);
  assert.match(auth.json.reauth, /git@example\.invalid:o\/r\.git/);
  assert.equal(auth.json.applied, false);
  assert.deepEqual(cloneState(repo), before);
  assert.ok(fs.existsSync(second));
});

const removedHalf = (halfPath, extra = {}) => ({ path: halfPath, branch: null, detached: true, registered: true, onDisk: true, removed: true, ...extra });

test("close-session plan close (in-repo): removes a pushed detached session, reports nothing-to-close for an unknown id, rejects unpushed commits", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  const plan = path.join(wt, "plan-20261009-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");

  const { code, json } = closeSession(repo, env, "20261009-1");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "plan");
  assert.equal(json.subject, "20261009-1");
  assert.equal(json.outcome, "closed");
  assert.equal(json.applied, true);
  assert.deepEqual(json.product, removedHalf(plan));
  assert.equal(json.companion, null);
  assert.equal(json.workspace, null);
  assert.deepEqual(json.branches, { product: null, companion: null });
  assert.deepEqual(json.next, []);
  assert.equal(worktreeCount(repo), 1);
  assert.equal(fs.existsSync(plan), false);

  const none = closeSession(repo, env, "20261009-9");
  assert.equal(none.code, 0);
  assert.equal(none.json.outcome, "nothing-to-close");
  assert.deepEqual(none.json.product, { path: path.join(wt, "plan-20261009-9"), branch: null, detached: false, registered: false, onDisk: false, removed: false });

  const ahead = path.join(wt, "plan-20261009-2");
  git(repo, "worktree", "add", "-q", "--detach", ahead, "origin/main");
  git(ahead, "commit", "-q", "--allow-empty", "-m", "local idea");
  const rejected = closeSession(repo, env, "20261009-2");
  assert.equal(rejected.code, 3);
  assert.equal(rejected.json.status, "rejected");
  assert.equal(rejected.json.reason, "unpushed");
  assert.equal(rejected.json.commits.product.length, 1);
  assert.match(rejected.json.message, /plan-20261009-2 has 1 commit\(s\) on neither its upstream nor origin\/main: \w+ local idea/);
  assert.equal(rejected.json.outcome, null);
  assert.ok(fs.existsSync(ahead));
  assert.equal(worktreeCount(repo), 2);
});

test("close-session plan close (companion pair): removes the companion half, the product half, and the workspace file; an unpushed companion half rejects", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const env = closeSessionEnv();
  const product = path.join(wt, "plan-20261009-1");
  const half = path.join(docsWt, "plan-20261009-1");
  const file = path.join(wt, "plan-20261009-1.code-workspace");
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", half, "origin/main");
  fs.writeFileSync(file, "{}\n");

  const { code, json } = closeSession(repo, env, "20261009-1");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "closed");
  assert.deepEqual(json.product, removedHalf(product));
  assert.deepEqual(json.companion, removedHalf(half));
  assert.deepEqual(json.workspace, { path: file, existed: true, removed: true });
  assert.equal(worktreeCount(repo), 1);
  assert.equal(worktreeCount(docs), 1);
  assert.equal(fs.existsSync(file), false);

  const product2 = path.join(wt, "plan-20261009-2");
  const half2 = path.join(docsWt, "plan-20261009-2");
  git(repo, "worktree", "add", "-q", "--detach", product2, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", half2, "origin/main");
  git(half2, "commit", "-q", "--allow-empty", "-m", "draft plan");
  const before = cloneState(repo, docs);
  const rejected = closeSession(repo, env, "20261009-2");
  assert.equal(rejected.code, 3);
  assert.equal(rejected.json.reason, "unpushed");
  assert.deepEqual(rejected.json.commits.product, []);
  assert.equal(rejected.json.commits.companion.length, 1);
  assert.deepEqual(cloneState(repo, docs), before);
});

test("close-session closes a promoted plan-<id> worktree as the build it became", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  publishBranch(repo, "feature/promo", roadmapFor("feature", "promo"), { keepLocal: true });
  const promoted = path.join(wt, "plan-20261009-3");
  git(repo, "worktree", "add", "-q", promoted, "feature/promo");

  const { code, json } = closeSession(repo, env, "20261009-3");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "build");
  assert.equal(json.subject, "feature/promo");
  assert.equal(json.outcome, "closed");
  assert.deepEqual(json.product, removedHalf(promoted, { branch: "feature/promo", detached: false }));
  assert.equal(json.branches.product.action, "retained");
  assert.equal(json.branches.product.reason, "origin/feature/promo still exists");
  assert.deepEqual(json.next, ["/agento ship promo"]);
  assert.equal(worktreeCount(repo), 1);
  assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/feature/promo"));
});

// Land <branch> on origin/main (fast-forward push) and delete it from origin;
// `syncMain` also fast-forwards the clone's local main. `remote` names the remote
// branch to delete when `branch` is a remote-tracking ref (`origin/<name>`).


test("close-session build close passes every close-decision error through as rejected and rejects a primary on the branch with the fix", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const env = closeSessionEnv();
  const inRepo = makeWorktreeRepo();
  writeRoadmap(inRepo.repo, "features/2026/09/dup", "status: planned\nbranch: feature/dup\nnext-step: \"1.1\"");
  writeRoadmap(inRepo.repo, "features/2026/10/dup", "status: planned\nbranch: feature/dup\nnext-step: \"1.1\"");
  roadmapFor("feature", "odd", "planned", "feature/other")(inRepo.repo);
  git(inRepo.repo, "add", "-A");
  git(inRepo.repo, "commit", "-q", "-m", "roadmaps");
  git(inRepo.repo, "push", "-q", "origin", "main");
  for (const [subject, reason] of [["feature/dup", "multiple-roadmaps"], ["feature/odd", "branch-mismatch"], ["feature/nope", "no-resolvable-roadmap"]]) {
    const { code, json } = closeSession(inRepo.repo, env, subject);
    assert.equal(code, 3, subject);
    assert.equal(json.status, "rejected", subject);
    assert.equal(json.reason, reason, subject);
    assert.ok(json.message, subject);
  }

  publishBranch(repo, "feature/side", null, { keepLocal: true });
  publishBranch(docs, "feature/side", roadmapFor("feature", "side"), { keepLocal: true });
  git(repo, "worktree", "add", "-q", path.join(wt, "feature-side"), "feature/side");
  git(docs, "worktree", "add", "-q", path.join(docsWt, "feature-side"), "feature/side");
  fs.writeFileSync(path.join(docsWt, "feature-side", "notes.md"), "draft");
  const before = cloneState(repo, docs);
  const gap = closeSession(repo, env, "feature/side");
  assert.equal(gap.code, 3);
  assert.equal(gap.json.reason, "companion-unpushed");
  assert.match(gap.json.message, /^The companion half at .*feature-side is dirty; commit and push it/);
  assert.deepEqual(cloneState(repo, docs), before);

  publishBranch(inRepo.repo, "feature/here", roadmapFor("feature", "here"), { keepLocal: true });
  git(inRepo.repo, "switch", "-q", "feature/here");
  const primaryOwns = closeSession(inRepo.repo, env, "feature/here");
  assert.equal(primaryOwns.code, 3);
  assert.equal(primaryOwns.json.reason, "primary-owns-branch");
  assert.equal(primaryOwns.json.fix, "git switch main");
  assert.equal(git(inRepo.repo, "branch", "--show-current"), "feature/here");
});

test("close-session build close (in-repo): dirty and unpushed halves reject; a clean pushed half is removed with its branch retained while on origin", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  publishBranch(repo, "feature/widget", roadmapFor("feature", "widget"), { keepLocal: true });
  const half = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", half, "feature/widget");

  fs.writeFileSync(path.join(half, "scratch.txt"), "x");
  const dirty = closeSession(repo, env, "feature/widget");
  assert.equal(dirty.code, 3);
  assert.equal(dirty.json.reason, "dirty");
  assert.deepEqual(dirty.json.dirty.product, ["scratch.txt"]);
  assert.match(dirty.json.message, /feature-widget has uncommitted changes: scratch\.txt/);
  fs.rmSync(path.join(half, "scratch.txt"));

  git(half, "commit", "-q", "--allow-empty", "-m", "unpushed step");
  const ahead = closeSession(repo, env, "feature/widget");
  assert.equal(ahead.code, 3);
  assert.equal(ahead.json.reason, "unpushed");
  assert.match(ahead.json.message, /1 commit\(s\) .*unpushed step/);
  assert.deepEqual(ahead.json.next, ["/agento ship widget"]);
  assert.equal(worktreeCount(repo), 2);
  git(half, "push", "-q");

  const { code, json } = closeSession(repo, env, "feature/widget");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "build");
  assert.equal(json.outcome, "closed");
  assert.deepEqual(json.product, removedHalf(half, { branch: "feature/widget", detached: false }));
  assert.deepEqual(json.branches.product, { name: "feature/widget", upstream: "origin/feature/widget", remoteExists: true, mergedIntoDefault: false, action: "retained", reason: "origin/feature/widget still exists" });
  assert.equal(json.branches.companion, null);
  assert.deepEqual(json.next, ["/agento ship widget"]);
  assert.equal(worktreeCount(repo), 1);
});

test("close-session build close (in-repo): remote-roadmap-only is already-closed and still deletes a merged local branch, retaining unmerged or stale-main ones with the reason", () => {
  const { repo } = makeWorktreeRepo();
  const env = closeSessionEnv();
  publishBranch(repo, "feature/gone", roadmapFor("feature", "gone"));
  const gone = closeSession(repo, env, "feature/gone");
  assert.equal(gone.code, 0, JSON.stringify(gone.json));
  assert.equal(gone.json.outcome, "already-closed");
  assert.equal(gone.json.product.registered, false);
  assert.equal(gone.json.branches.product.action, "absent");

  publishBranch(repo, "feature/unmerged", roadmapFor("feature", "unmerged"), { keepLocal: true });
  git(repo, "push", "-q", "origin", "--delete", "feature/unmerged");
  roadmapFor("feature", "unmerged")(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "roadmap on main");
  git(repo, "push", "-q", "origin", "main");
  const unmerged = closeSession(repo, env, "feature/unmerged");
  assert.equal(unmerged.code, 0, JSON.stringify(unmerged.json));
  assert.equal(unmerged.json.outcome, "already-closed");
  assert.deepEqual(unmerged.json.branches.product, { name: "feature/unmerged", upstream: "origin/feature/unmerged", remoteExists: false, mergedIntoDefault: false, action: "retained", reason: "not merged into origin/main" });
  assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/feature/unmerged"));

  roadmapFor("feature", "stale", "complete")(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stale roadmap on main");
  git(repo, "push", "-q", "origin", "main");
  publishBranch(repo, "feature/stale", null, { keepLocal: true });
  landBranch(repo, "feature/stale", { syncMain: false });
  const stale = closeSession(repo, env, "feature/stale");
  assert.equal(stale.code, 0, JSON.stringify(stale.json));
  assert.equal(stale.json.branches.product.action, "retained");
  assert.equal(stale.json.branches.product.mergedIntoDefault, true);
  assert.match(stale.json.branches.product.reason, /^merged into origin\/main but not into main at .*; run git -C .* pull --ff-only, then re-send$/);
  assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/feature/stale"));

  git(repo, "merge", "-q", "--ff-only", "origin/main");
  const merged = closeSession(repo, env, "feature/stale");
  assert.equal(merged.code, 0, JSON.stringify(merged.json));
  assert.equal(merged.json.outcome, "already-closed");
  assert.deepEqual(merged.json.branches.product, { name: "feature/stale", upstream: "origin/feature/stale", remoteExists: false, mergedIntoDefault: true, action: "deleted", reason: "merged into origin/main and gone from origin" });
  assert.deepEqual(merged.json.next, []);
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/stale"));
});

test("close-session build close (companion pair): removes both halves and the workspace file, retaining branches on origin; once landed, deletes the merged branch in each clone", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const env = closeSessionEnv();
  const open = (slug, status = "in-review") => {
    publishBranch(repo, `feature/${slug}`, null, { keepLocal: true });
    publishBranch(docs, `feature/${slug}`, roadmapFor("feature", slug, status), { keepLocal: true });
    git(repo, "worktree", "add", "-q", path.join(wt, `feature-${slug}`), `feature/${slug}`);
    git(docs, "worktree", "add", "-q", path.join(docsWt, `feature-${slug}`), `feature/${slug}`);
    fs.writeFileSync(path.join(wt, `feature-${slug}.code-workspace`), "{}\n");
  };

  open("pw");
  const { code, json } = closeSession(repo, env, "feature/pw");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "closed");
  assert.deepEqual(json.product, removedHalf(path.join(wt, "feature-pw"), { branch: "feature/pw", detached: false }));
  assert.deepEqual(json.companion, removedHalf(path.join(docsWt, "feature-pw"), { branch: "feature/pw", detached: false }));
  assert.deepEqual(json.workspace, { path: path.join(wt, "feature-pw.code-workspace"), existed: true, removed: true });
  assert.equal(json.branches.product.action, "retained");
  assert.equal(json.branches.companion.action, "retained");
  assert.equal(json.branches.companion.reason, "origin/feature/pw still exists");
  assert.deepEqual(json.next, ["/agento ship pw"]);
  assert.equal(worktreeCount(repo), 1);
  assert.equal(worktreeCount(docs), 1);

  open("done", "complete");
  landBranch(repo, "feature/done");
  landBranch(docs, "feature/done");
  const landed = closeSession(repo, env, "feature/done");
  assert.equal(landed.code, 0, JSON.stringify(landed.json));
  assert.equal(landed.json.outcome, "closed");
  assert.equal(landed.json.branches.product.action, "deleted");
  assert.equal(landed.json.branches.companion.action, "deleted");
  assert.deepEqual(landed.json.next, []);
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/done"));
  assert.throws(() => git(docs, "rev-parse", "--verify", "--quiet", "refs/heads/feature/done"));
  assert.equal(fs.existsSync(path.join(wt, "feature-done.code-workspace")), false);
});

test("close-session freehand close (in-repo): requires changes/<slug>, rejects unpushed commits with finish-freehand, offers a resume for unmerged work, deletes a merged branch", () => {
  const { repo, wt } = makeWorktreeRepo();
  const env = closeSessionEnv();
  const add = (slug, branch = `changes/${slug}`, ...flags) => {
    const half = path.join(wt, `freehand-${slug}`);
    git(repo, "worktree", "add", "-q", ...flags, "-b", branch, half, "origin/main");
    return half;
  };

  const none = closeSession(repo, env, "changes/ghost");
  assert.equal(none.code, 0, JSON.stringify(none.json));
  assert.equal(none.json.mode, "freehand");
  assert.equal(none.json.outcome, "nothing-to-close");
  assert.equal(none.json.branches.product.action, "absent");
  assert.deepEqual(none.json.next, []);

  const odd = add("odd", "changes/other");
  const mismatch = closeSession(repo, env, "changes/odd");
  assert.equal(mismatch.code, 3);
  assert.equal(mismatch.json.reason, "branch-mismatch");
  assert.match(mismatch.json.message, /freehand-odd is on changes\/other, expected on changes\/odd; nothing was removed$/);
  assert.ok(fs.existsSync(odd));

  const tidy = add("tidy");
  const closed = closeSession(repo, env, "changes/tidy");
  assert.equal(closed.code, 0, JSON.stringify(closed.json));
  assert.equal(closed.json.outcome, "closed");
  assert.deepEqual(closed.json.product, removedHalf(tidy, { branch: "changes/tidy", detached: false }));
  assert.deepEqual(closed.json.branches.product, { name: "changes/tidy", upstream: "origin/main", remoteExists: false, mergedIntoDefault: true, action: "deleted", reason: "merged into origin/main and gone from origin" });
  assert.deepEqual(closed.json.next, []);
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/changes/tidy"));

  // start-freehand's branch tracks origin/main, so commits past it are unpublished work.
  const draft = add("draft");
  git(draft, "commit", "-q", "--allow-empty", "-m", "unpublished");
  const tracking = closeSession(repo, env, "changes/draft");
  assert.equal(tracking.code, 3);
  assert.equal(tracking.json.reason, "unpushed");
  assert.deepEqual(tracking.json.next, ["/agento finish-freehand"]);

  const pub = add("pub");
  git(pub, "commit", "-q", "--allow-empty", "-m", "published");
  git(pub, "push", "-q", "-u", "origin", "changes/pub");
  git(pub, "commit", "-q", "--allow-empty", "-m", "not yet");
  const ahead = closeSession(repo, env, "changes/pub");
  assert.equal(ahead.code, 3);
  assert.equal(ahead.json.reason, "unpushed");
  assert.deepEqual(ahead.json.next, ["/agento finish-freehand"]);
  assert.ok(fs.existsSync(pub));
  git(pub, "push", "-q");
  const open = closeSession(repo, env, "changes/pub");
  assert.equal(open.code, 0, JSON.stringify(open.json));
  assert.equal(open.json.branches.product.action, "retained");
  assert.equal(open.json.branches.product.reason, "origin/changes/pub still exists");
  assert.deepEqual(open.json.next, ["/agento start-freehand pub --resume"]);

  const local = add("local", "changes/local", "--no-track");
  git(local, "commit", "-q", "--allow-empty", "-m", "never published");
  const kept = closeSession(repo, env, "changes/local");
  assert.equal(kept.code, 0, JSON.stringify(kept.json));
  assert.deepEqual(kept.json.branches.product, { name: "changes/local", upstream: null, remoteExists: false, mergedIntoDefault: false, action: "retained", reason: "not merged into origin/main" });
  assert.deepEqual(kept.json.next, ["/agento start-freehand local --resume"]);
  assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/changes/local"));
  assert.equal(worktreeCount(repo), 3);
});

test("close-session freehand close (companion pair): removes both halves and the workspace file, deletes the merged branch in each clone, and rejects an unpushed companion half", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const env = closeSessionEnv();
  const product = path.join(wt, "freehand-tidy");
  const half = path.join(docsWt, "freehand-tidy");
  const file = path.join(wt, "freehand-tidy.code-workspace");
  git(repo, "worktree", "add", "-q", "-b", "changes/tidy", product, "origin/main");
  git(docs, "worktree", "add", "-q", "-b", "changes/tidy", half, "origin/main");
  fs.writeFileSync(file, "{}\n");

  const { code, json } = closeSession(repo, env, "changes/tidy");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "closed");
  assert.deepEqual(json.product, removedHalf(product, { branch: "changes/tidy", detached: false }));
  assert.deepEqual(json.companion, removedHalf(half, { branch: "changes/tidy", detached: false }));
  assert.deepEqual(json.workspace, { path: file, existed: true, removed: true });
  assert.equal(json.branches.product.action, "deleted");
  assert.equal(json.branches.companion.action, "deleted");
  assert.equal(worktreeCount(repo), 1);
  assert.equal(worktreeCount(docs), 1);

  git(repo, "worktree", "add", "-q", "-b", "changes/wip", path.join(wt, "freehand-wip"), "origin/main");
  const wipHalf = path.join(docsWt, "freehand-wip");
  git(docs, "worktree", "add", "-q", "-b", "changes/wip", wipHalf, "origin/main");
  git(wipHalf, "push", "-q", "-u", "origin", "changes/wip");
  git(wipHalf, "commit", "-q", "--allow-empty", "-m", "draft");
  const before = cloneState(repo, docs);
  const ahead = closeSession(repo, env, "changes/wip");
  assert.equal(ahead.code, 3);
  assert.equal(ahead.json.reason, "unpushed");
  assert.equal(ahead.json.commits.companion.length, 1);
  assert.deepEqual(ahead.json.next, ["/agento finish-freehand"]);
  assert.deepEqual(cloneState(repo, docs), before);
});

// A detached plan pair <id> with its workspace file, for the occupant and dry-run tests.
function planPair({ repo, docs, wt, docsWt }, id) {
  const product = path.join(wt, `plan-${id}`);
  const half = path.join(docsWt, `plan-${id}`);
  const file = path.join(wt, `plan-${id}.code-workspace`);
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", half, "origin/main");
  fs.writeFileSync(file, "{}\n");
  return { product, half, file };
}

test("close-session occupant gate: a live process inside a half blocks with the guard's wording and changes nothing; --ignore-occupants proceeds with a warning", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const env = closeSessionEnv();
  const { half, file } = planPair(pair, "20261009-1");
  const child = spawn("sleep", ["30"], { cwd: half, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const before = [cloneState(repo, docs), fs.readFileSync(file, "utf8")];
    for (const extra of [[], ["--dry-run"]]) {
      const { code, json } = closeSession(repo, env, "20261009-1", ...extra);
      assert.equal(code, 3, JSON.stringify(json));
      assert.equal(json.status, "blocked");
      assert.equal(json.reason, "occupied");
      assert.deepEqual(json.occupants, { product: [], companion: [`PID ${child.pid} (sleep)`] });
      assert.equal(json.applied, false);
      assert.match(json.message, /^Active worktree occupants detected - companion half .*plan-20261009-1: PID \d+ \(sleep\)\. Close their terminals or VS Code window before removal/);
      assert.deepEqual([cloneState(repo, docs), fs.readFileSync(file, "utf8")], before);
    }

    const forced = closeSession(repo, env, "20261009-1", "--ignore-occupants");
    assert.equal(forced.code, 0, JSON.stringify(forced.json));
    assert.equal(forced.json.applied, true);
    assert.ok(forced.json.warnings.some((w) => /^occupants: ignored \(--ignore-occupants\) - companion half .*: PID \d+ \(sleep\)$/.test(w)), forced.json.warnings.join("\n"));
    assert.equal(worktreeCount(repo), 1);
    assert.equal(worktreeCount(docs), 1);
  } finally {
    child.kill();
  }
});

test("close-session occupant gate: code --status naming the half as a Folder, Workspace, or Window (… (Workspace)) blocks; --dry-run reports the full decision and changes nothing", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { file } = planPair(pair, "20261009-1");
  const before = [cloneState(repo, docs), fs.readFileSync(file, "utf8")];
  for (const [status, detail] of [
    ["|    Folder (plan-20261009-1): 12 files", "a matching VS Code folder"],
    ["|  Workspace (plan-20261009-1)", "a matching VS Code workspace window"],
    ["|  Window (roadmap.md - plan-20261009-1 (Workspace) - Visual Studio Code)", "a matching VS Code workspace window"],
  ]) {
    const env = closeSessionEnv(status);
    for (const extra of [[], ["--dry-run"]]) {
      const { code, json } = closeSession(repo, env, "20261009-1", ...extra);
      assert.equal(code, 3, `${status} ${extra}`);
      assert.equal(json.status, "blocked");
      assert.deepEqual(json.occupants, { product: [detail], companion: [detail] });
      assert.deepEqual([cloneState(repo, docs), fs.readFileSync(file, "utf8")], before);
    }
  }

  const env = closeSessionEnv("|    Folder (other): 1 files");
  const dry = closeSession(repo, env, "20261009-1", "--dry-run");
  assert.equal(dry.code, 0, JSON.stringify(dry.json));
  assert.equal(dry.json.status, "ok");
  assert.equal(dry.json.applied, false);
  assert.equal(dry.json.outcome, "closed");
  assert.equal(dry.json.product.removed, true);
  assert.equal(dry.json.companion.removed, true);
  assert.deepEqual(dry.json.workspace, { path: file, existed: true, removed: true });
  assert.deepEqual([cloneState(repo, docs), fs.readFileSync(file, "utf8")], before);

  const real = closeSession(repo, env, "20261009-1");
  assert.equal(real.code, 0, JSON.stringify(real.json));
  assert.equal(real.json.applied, true);
  assert.equal(worktreeCount(repo), 1);
  assert.equal(worktreeCount(docs), 1);
  assert.equal(fs.existsSync(file), false);
});

test("close-session is idempotent: a re-send is nothing-to-close or already-closed, a half removed earlier is skipped, a merged branch left behind is still deleted", () => {
  const pair = makePairRepo();
  const { repo, docs, wt, docsWt } = pair;
  const env = closeSessionEnv();
  planPair(pair, "20261009-1");
  assert.equal(closeSession(repo, env, "20261009-1").code, 0);
  const again = closeSession(repo, env, "20261009-1");
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.outcome, "nothing-to-close");
  assert.equal(again.json.product.registered, false);
  assert.equal(again.json.companion.registered, false);
  assert.deepEqual(again.json.workspace, { path: path.join(wt, "plan-20261009-1.code-workspace"), existed: false, removed: false });

  publishBranch(repo, "feature/half", null, { keepLocal: true });
  publishBranch(docs, "feature/half", roadmapFor("feature", "half"), { keepLocal: true });
  const product = path.join(wt, "feature-half");
  const half = path.join(docsWt, "feature-half");
  git(repo, "worktree", "add", "-q", product, "feature/half");
  git(docs, "worktree", "add", "-q", half, "feature/half");
  fs.writeFileSync(path.join(wt, "feature-half.code-workspace"), "{}\n");
  git(docs, "worktree", "remove", half);

  const partial = closeSession(repo, env, "feature/half");
  assert.equal(partial.code, 0, JSON.stringify(partial.json));
  assert.equal(partial.json.outcome, "closed");
  assert.equal(partial.json.product.removed, true);
  assert.deepEqual(partial.json.companion, { path: half, branch: null, detached: false, registered: false, onDisk: false, removed: false });
  assert.equal(partial.json.workspace.removed, true);
  assert.equal(worktreeCount(repo), 1);

  const resent = closeSession(repo, env, "feature/half");
  assert.equal(resent.code, 0, JSON.stringify(resent.json));
  assert.equal(resent.json.outcome, "already-closed");
  assert.equal(resent.json.product.registered, false);
  assert.equal(resent.json.branches.product.action, "retained");

  landBranch(repo, "feature/half");
  landBranch(docs, "feature/half");
  const cleanup = closeSession(repo, env, "feature/half");
  assert.equal(cleanup.code, 0, JSON.stringify(cleanup.json));
  assert.equal(cleanup.json.outcome, "already-closed");
  assert.equal(cleanup.json.branches.product.action, "deleted");
  assert.equal(cleanup.json.branches.companion.action, "deleted");
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/half"));
  assert.throws(() => git(docs, "rev-parse", "--verify", "--quiet", "refs/heads/feature/half"));
});

// --- ship -------------------------------------------------------------------------

// A scriptable `gh` for the ship tests. `prs` is `{ "<branch>": { number, state, isDraft,
// mergeStateStatus, mergeable, body, title, refuseMerge, rollups: [ [ { name, status, conclusion } ] … ] } }`
// per repo (`product`, `companion`); the repo is chosen by `$PWD` (anything under
// project-docs is the companion). `pr merge <n> --merge` performs a real merge of the
// branch into the repo's bare origin default, so later fetches and `pr view` report
// `MERGED` with a `mergeCommit`. `api` routes are prefix-matched like `releaseGh`.
// Every call logs `$PWD $*` to `calls.log`; the state file is rewritten after writes.


// Every ref and worktree registration of the clones, for "nothing changed" checks.
// `origin/HEAD` is excluded: git ≥ 2.48 creates that pointer on the first fetch.


test("shipStub self-test: wait-for-checks.sh reads the scripted rollups (exit 0 / 1 / 2), pr merge lands a real merge commit, forbidden flags are refused", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const wait = (stub, ...extra) => spawnSync("bash", [path.join(repoRoot, "scripts", "wait-for-checks.sh"), "pr", "15", "--max-seconds", "0", "--interval", "1", ...extra], { cwd: repo, env: stub.env, encoding: "utf8" });
  const check = (name, conclusion) => ({ name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
  const withRollups = (rollups, extra = {}) => shipStub({ product: { prs: { [branch]: { rollups, ...extra } } } });

  const pass = wait(withRollups([[check("Unit tests", "SUCCESS"), check("Shellcheck", "SKIPPED")]]));
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /RESULT: success/);
  const failing = wait(withRollups([[check("Unit tests", "FAILURE")]]));
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /Unit tests=fail/);
  const pending = withRollups([[check("Unit tests", null)], [check("Unit tests", "SUCCESS")]]);
  assert.equal(wait(pending).status, 2, "first snapshot pending");
  assert.equal(wait(pending).status, 0, "second snapshot passes");
  assert.equal(wait(withRollups([[]])).status, 0, "no checks with merge=CLEAN is success");
  assert.equal(wait(withRollups([[]], { mergeStateStatus: "BLOCKED" })).status, 2, "no checks and not CLEAN stays pending within the grace window");
  assert.equal(wait(withRollups([[]]), "--repo", "acme/project").status, 0, "--repo passes through");
  assert.ok(pending.calls().every((c) => c.startsWith(`${repo} pr view 15 --json statusCheckRollup,mergeStateStatus --jq `)), pending.calls().join("\n"));

  // pr view answers by number or branch with the requested fields; pr ready flips isDraft.
  const gh = (stub, ...args) => spawnSync("gh", args, { cwd: repo, env: stub.env, encoding: "utf8" });
  const stub = withRollups([[]]);
  assert.deepEqual(JSON.parse(gh(stub, "pr", "view", branch, "--json", "number,state,isDraft,mergeCommit").stdout), { number: 15, state: "OPEN", isDraft: true, mergeCommit: null });
  assert.equal(gh(stub, "pr", "view", "nope", "--json", "number").status, 1);
  const draftMerge = gh(stub, "pr", "merge", "15", "--merge");
  assert.equal(draftMerge.status, 1, "a draft cannot merge");
  assert.equal(gh(stub, "pr", "ready", "15").status, 0);
  assert.equal(stub.state().product.prs[branch].isDraft, false);
  for (const flag of ["--admin", "--squash", "--rebase", "--delete-branch"]) {
    assert.equal(gh(stub, "pr", "merge", "15", "--merge", flag).status, 1, flag);
    assert.equal(stub.state().product.prs[branch].state, "OPEN", flag);
  }

  // A real merge commit lands on the bare origin's main; the branch stays on origin until deleted.
  const merged = gh(stub, "pr", "merge", "15", "--merge");
  assert.equal(merged.status, 0, merged.stderr);
  git(repo, "fetch", "-q", "--prune", "origin");
  assert.equal(git(repo, "show", "origin/main:src.js"), "code");
  assert.equal(stub.state().product.prs[branch].state, "MERGED");
  assert.equal(stub.state().product.prs[branch].mergeCommit, git(repo, "rev-parse", "origin/main"));
  assert.match(git(repo, "log", "-1", "--format=%s", "origin/main"), /^Merge pull request #15 from feature\/widget$/);
  assert.equal(git(repo, "rev-list", "--count", "origin/main", "^origin/feature/widget"), "1", "one merge commit on top of the branch");
  assert.deepEqual(JSON.parse(gh(stub, "pr", "view", branch, "--json", "state,mergeCommit").stdout), { state: "MERGED", mergeCommit: { oid: git(repo, "rev-parse", "origin/main") } });
  assert.equal(gh(stub, "pr", "merge", "15", "--merge").status, 1, "a merged PR cannot merge twice");

  // pr create registers a new PR for the head branch; api PATCH edits the body; repo view, run list/view, workflow run.
  git(repo, "switch", "-q", "-c", "post-ship/widget");
  const created = gh(stub, "pr", "create", "--base", "main", "--head", "post-ship/widget", "--title", "post-ship", "--body", "evidence");
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /^https:\/\/example\.test\/pull\/100$/m);
  assert.equal(gh(stub, "pr", "create", "--head", "post-ship/widget").status, 1, "a second PR for the same open head is refused");
  git(repo, "switch", "-q", "main");
  assert.equal(gh(stub, "api", "repos/acme/project/pulls/100", "-X", "PATCH", "-f", "body=evidence\n\nFixes #3").status, 0);
  assert.equal(stub.state().product.prs["post-ship/widget"].body, "evidence\n\nFixes #3");
  assert.equal(gh(stub, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner").stdout.trim(), "acme/project");
  assert.deepEqual(JSON.parse(gh(stub, "run", "list", "--workflow", "release.yml", "--event", "workflow_dispatch", "--json", "databaseId,createdAt,url").stdout), []);
  assert.equal(gh(stub, "workflow", "run", "release.yml", "--ref", "main").status, 0);
  const runs = JSON.parse(gh(stub, "run", "list", "--workflow", "release.yml", "--event", "workflow_dispatch", "--json", "databaseId,createdAt,url").stdout);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].databaseId, 900);
  assert.equal(gh(stub, "run", "view", "900", "--json", "status,conclusion,url", "--jq", "x").stdout.trim(), "in_progress - https://example.test/runs/900");
  const runWait = spawnSync("bash", [path.join(repoRoot, "scripts", "wait-for-checks.sh"), "run", "900", "--max-seconds", "0", "--interval", "1"], { cwd: repo, env: stub.env, encoding: "utf8" });
  assert.equal(runWait.status, 2, runWait.stdout);
  stub.update((s) => Object.assign(s.runs[0], { status: "completed", conclusion: "success" }));
  assert.equal(spawnSync("bash", [path.join(repoRoot, "scripts", "wait-for-checks.sh"), "run", "900", "--max-seconds", "0"], { cwd: repo, env: stub.env, encoding: "utf8" }).status, 0);
});

test("ship validates its arguments, is listed in the usage header, and --confirm needs a value", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env } = shipStub();
  for (const args of [[], ["feature"], ["chore", "x"], ["feature", "Bad_Slug"], ["feature", "widget", "extra"], ["feature", "widget", "--wait", "61"], ["feature", "widget", "--confirm"], ["feature", "widget", "--confirm", "--wait"], ["feature", "widget", "--bogus"]]) {
    const { code, json } = shipRun(repo, env, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
  const usage = run(repo).json.usage.join("\n");
  assert.match(usage, /ship <feature\|issue> <slug> \[--confirm <token>\] \[--wait N\]/);
  assert.deepEqual(fs.readdirSync(wt), []);
});

test("ship rejects from a non-primary window with the session record's alternatives, writing nothing", () => {
  const { repo, wt } = makeWorktreeRepo();
  const { env, calls } = shipStub();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/10/widget", "status: in-review\nbranch: feature/widget\nnext-step: review");
  const before = refState(repo);
  const { code, json } = shipRun(build, env, "feature", "widget");
  assert.equal(code, 3);
  assert.equal(json.status, "rejected");
  assert.match(json.reason, /^wrong window: role=build \(.*feature-widget, branch feature\/widget\)$/);
  const record = run(build, "session").json;
  assert.deepEqual(json.allowed, record.allowed);
  assert.deepEqual(json.elsewhere, record.elsewhere);
  assert.deepEqual(json.actions, []);
  assert.deepEqual(refState(repo), before);
  assert.ok(calls().every((c) => !/ pr (merge|ready|create)/.test(c)), calls().join("\n"));
});

test("ship warns and continues when origin is unreachable, and fails with a re-login command on an authentication failure before any write", () => {
  const { repo } = makeWorktreeRepo();
  const { env } = shipStub();
  git(repo, "remote", "set-url", "origin", path.join(path.dirname(repo), "missing.git"));
  const offline = shipRun(repo, env, "feature", "widget");
  assert.ok(offline.json.warnings.some((w) => /^fetch: product .*missing\.git not fetched \(.*\); continuing from local refs$/.test(w)), JSON.stringify(offline.json));
  assert.ok(offline.json.preflight.some((p) => p.id === "git-remote" && p.status === "warn"), "doctor warns about the unreachable origin");

  const ssh = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agento-ssh-")), "ssh");
  fs.writeFileSync(ssh, "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n", { mode: 0o755 });
  git(repo, "remote", "set-url", "origin", "git@example.invalid:o/r.git");
  const before = refState(repo);
  const auth = shipRun(repo, { ...env, GIT_SSH_COMMAND: ssh }, "feature", "widget");
  assert.equal(auth.code, 3);
  assert.equal(auth.json.status, "failed");
  assert.equal(auth.json.reason, "fetch-auth");
  assert.match(auth.json.message, /Permission denied \(publickey\)/);
  assert.match(auth.json.reauth, /git@example\.invalid:o\/r\.git/);
  assert.deepEqual(auth.json.actions, []);
  assert.deepEqual(refState(repo), before);
});

// An in-repo delivery: `<type>/<slug>` published from main with its roadmap (status
// `in-review` by default) and, with `owner`, a managed worktree on it.


// A companion-mode delivery: code branch in the product, roadmap branch in the companion.


test("ship passes resolver errors and a primary on the branch through as rejected; a remote-only roadmap is valid", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { env } = shipStub({ product: { prs: { "feature/dup": {}, "feature/odd": {}, "feature/here": {}, "feature/remote": {} } } });
  writeRoadmap(repo, "features/2026/09/dup", "status: in-review\nbranch: feature/dup\nnext-step: x");
  writeRoadmap(repo, "features/2026/10/dup", "status: in-review\nbranch: feature/dup\nnext-step: x");
  roadmapFor("feature", "odd", "in-review", "feature/other")(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "roadmaps");
  git(repo, "push", "-q", "origin", "main");
  for (const [slug, reason] of [["dup", "multiple-roadmaps"], ["odd", "branch-mismatch"], ["nope", "no-resolvable-roadmap"]]) {
    const { code, json } = shipRun(repo, env, "feature", slug);
    assert.equal(code, 3, slug);
    assert.equal(json.status, "rejected", slug);
    assert.equal(json.reason, reason, slug);
    assert.ok(json.message, slug);
    assert.deepEqual(json.actions, []);
  }

  inRepoDelivery(fixture, "here", { owner: false });
  git(repo, "switch", "-q", "feature/here");
  const primaryOwns = shipRun(repo, env, "feature", "here");
  assert.equal(primaryOwns.code, 3);
  assert.equal(primaryOwns.json.reason, "primary-owns-branch");
  assert.equal(primaryOwns.json.fix, "git switch main");
  git(repo, "switch", "-q", "main");

  inRepoDelivery(fixture, "remote", { owner: false });
  const remote = shipRun(repo, env, "feature", "remote");
  assert.notEqual(remote.json.reason, "no-resolvable-roadmap", JSON.stringify(remote.json));
  assert.equal(remote.json.resumedAt, "audit");
  assert.equal(remote.json.audit.owner, null);
  assert.equal(remote.json.audit.roadmapPath, "features/2026/10/remote/roadmap.md");
  assert.match(remote.json.audit.artifactRef, /^origin\/feature\/remote$/);

  const noPr = shipRun(repo, shipStub().env, "feature", "remote");
  assert.equal(noPr.json.status, "rejected");
  assert.equal(noPr.json.reason, "pr-missing");
});

test("ship derives the phase from git and GitHub state in the in-repo layout and resumes from every interruption", () => {
  const fixture = makeWorktreeRepo();
  const { repo, wt } = fixture;
  const { branch, owner } = inRepoDelivery(fixture, "widget");
  const PENDING = [[{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null }]];

  const open = shipRun(repo, shipStub({ product: { prs: { [branch]: {} } } }).env, "feature", "widget");
  assert.equal(open.json.resumedAt, "audit", JSON.stringify(open.json));
  assert.equal(open.json.mode, "in-repo");
  assert.equal(open.json.pr.number, 15);
  assert.equal(open.json.companionPr, null);
  assert.equal(open.json.audit.owner.path, owner);
  assert.deepEqual(open.json.audit.ownerTree, { tracked: [], untracked: [], ahead: 0 });

  // A roadmap already `complete` on the open branch means the confirm writes landed: resume at checks (still pending here).
  const stamped = path.join(owner, "features/2026/10/widget/roadmap.md");
  fs.writeFileSync(stamped, fs.readFileSync(stamped, "utf8").replace("status: in-review", "status: complete"));
  git(owner, "commit", "-qam", "docs(feature): ship widget");
  git(owner, "push", "-q");
  const checks = shipRun(repo, shipStub({ product: { prs: { [branch]: { rollups: PENDING } } } }).env, "feature", "widget", "--wait", "0");
  assert.equal(checks.json.resumedAt, "checks", JSON.stringify(checks.json));
  assert.equal(checks.json.status, "pending");
  assert.equal(checks.json.phase, "checks");
  assert.ok(fs.existsSync(owner));

  // Merged on origin, remote branch gone, local main behind: sync, then the owner is torn down.
  landBranch(repo, branch, { syncMain: false });
  const merged = shipStub({ product: { prs: { [branch]: { state: "MERGED", isDraft: false, mergeCommit: git(repo, "rev-parse", "origin/main") } } } });
  const behind = shipRun(repo, merged.env, "feature", "widget");
  assert.equal(behind.json.status, "ok", JSON.stringify(behind.json));
  assert.equal(behind.json.resumedAt, "sync");
  assert.equal(behind.json.mergeSha, git(repo, "rev-parse", "origin/main"));
  assert.equal(behind.json.audit.artifactRef, "origin/main");
  assert.deepEqual(stepsOf(behind.json), ["sync", "teardown"]);
  assert.equal(behind.json.outcome, "shipped");
  assert.equal(fs.existsSync(owner), false);
  assert.ok(merged.calls().every((c) => !/ pr (merge|ready|create)/.test(c)), "a merged PR is never merged again");

  // Synced, no owner: done.
  const done = shipRun(repo, merged.env, "feature", "widget").json;
  assert.equal(done.resumedAt, "done");
  assert.equal(done.outcome, "already-shipped");
  assert.deepEqual(done.actions, []);

  // Synced with an owner still present: teardown.
  const other = inRepoDelivery(fixture, "other", { status: "complete" });
  landBranch(repo, other.branch);
  const teardown = shipRun(repo, shipStub({ product: { prs: { [other.branch]: { state: "MERGED", isDraft: false } } } }).env, "feature", "other").json;
  assert.equal(teardown.resumedAt, "teardown", JSON.stringify(teardown));
  assert.deepEqual(stepsOf(teardown), ["teardown"]);
  assert.equal(fs.existsSync(other.owner), false);
  assert.deepEqual(fs.readdirSync(wt), []);

  // A post-ship step left unticked on the default: epilogue.
  fs.writeFileSync(stamped.replace(owner, repo), "```yaml\nstatus: complete\nbranch: feature/widget\nnext-step: \"\"\n```\n\n## Phase 1\n\n- [x] 1.1 done — verify: x\n- [ ] 1.2 (manual, post-ship) check prod — verify: y\n");
  git(repo, "commit", "-qam", "post-ship step");
  git(repo, "push", "-q", "origin", "main");
  const epilogue = shipRun(repo, merged.env, "feature", "widget");
  assert.equal(epilogue.json.resumedAt, "epilogue", JSON.stringify(epilogue.json));

  // A release workflow precedes teardown and the epilogue.
  const withRelease = makeWorktreeRepo();
  fs.writeFileSync(path.join(withRelease.repo, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, checks: { releaseWorkflow: "release.yml" } }));
  git(withRelease.repo, "commit", "-qam", "release workflow");
  git(withRelease.repo, "push", "-q", "origin", "main");
  const rel = inRepoDelivery(withRelease, "rel");
  landBranch(withRelease.repo, rel.branch);
  const release = shipRun(withRelease.repo, shipStub({ product: { prs: { [rel.branch]: { state: "MERGED", isDraft: false } } } }).env, "feature", "rel");
  assert.equal(release.json.resumedAt, "release", JSON.stringify(release.json));
});

test("ship derives the phase in companion mode and resumes a half-shipped pair at the companion merge, then syncs both defaults", () => {
  const pair = makePairRepo();
  const { repo, docs, wt, docsWt } = pair;
  const { branch, owner, half } = pairDelivery(pair, "widget");
  const both = (product, companion) => shipStub({ product: { prs: { [branch]: product } }, companion: { prs: { [branch]: { number: 7, ...companion } } } });

  const open = shipRun(repo, both({}, {}).env, "feature", "widget");
  assert.equal(open.json.mode, "companion", JSON.stringify(open.json));
  assert.equal(open.json.resumedAt, "audit");
  assert.equal(open.json.pr.number, 15);
  assert.equal(open.json.companionPr.number, 7);
  assert.equal(open.json.audit.companion.path, half);
  assert.deepEqual(open.json.audit.companionGaps, []);
  assert.deepEqual(open.json.audit.companionTree, { tracked: [], untracked: [] });
  assert.equal(open.json.audit.artifactsRoot, docs);
  assert.equal(git(docs, "branch", "--show-current"), "main", "the companion clone is never switched");

  // Code merged, companion still open with pending checks: resume at the companion merge, nothing merged yet.
  landBranch(repo, branch, { syncMain: false });
  const halfShipped = shipRun(repo, both({ state: "MERGED", isDraft: false }, { state: "OPEN", rollups: [[{ name: "Docs", status: "IN_PROGRESS", conclusion: null }]] }).env, "feature", "widget", "--wait", "0");
  assert.equal(halfShipped.json.resumedAt, "merge-companion", JSON.stringify(halfShipped.json));
  assert.equal(halfShipped.json.status, "pending");
  assert.equal(halfShipped.json.phase, "merge-companion");
  assert.ok(fs.existsSync(owner) && fs.existsSync(half));

  // Both merged, both defaults behind: sync both, then teardown; the re-send is done.
  landBranch(docs, branch, { syncMain: false });
  const merged = both({ state: "MERGED", isDraft: false }, { state: "MERGED", isDraft: false });
  const synced = shipRun(repo, merged.env, "feature", "widget").json;
  assert.equal(synced.resumedAt, "sync", JSON.stringify(synced));
  assert.deepEqual(stepsOf(synced), ["sync", "sync", "teardown"]);
  assert.equal(synced.audit.owner.path, owner);
  assert.equal(synced.audit.artifactRef, "origin/main");
  assert.equal(synced.audit.roadmapPath, "features/2026/10/widget/roadmap.md");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
  assert.deepEqual(fs.readdirSync(wt), []);
  assert.deepEqual(fs.readdirSync(docsWt), []);
  assert.ok(merged.calls().every((c) => !/ pr (merge|ready|create)/.test(c)));
  const done = shipRun(repo, merged.env, "feature", "widget").json;
  assert.equal(done.resumedAt, "done");
  assert.equal(done.outcome, "already-shipped");
});

// Writers for a shippable artifact set: every step ticked, review approved.


// A delivery whose roadmap is shippable; `extra` adds files to the branch commit.


test("ship audit: a clean in-repo feature is awaiting-confirm with a stable token, and the audit call writes nothing", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { body: "Body" } } } });
  const before = [refState(repo), JSON.stringify(stub.state())];

  const { code, json } = shipRun(repo, stub.env, "feature", "widget");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.phase, "audit");
  assert.equal(json.outcome, "awaiting-confirm");
  assert.deepEqual(json.gaps, { hard: [], confirm: [] });
  assert.match(json.confirmToken, /^[0-9a-f]{12}$/);
  assert.equal(json.rejectTo, null);
  assert.deepEqual(json.next, ["/agento ship widget"]);
  assert.deepEqual(json.actions, []);
  assert.deepEqual(json.audit.roadmap, { status: "in-review", unticked: [], postShip: [] });
  assert.equal(json.audit.review.present, true);
  assert.equal(json.audit.review.verdict, "approve");
  assert.equal(json.audit.review.stale, false);
  assert.match(json.audit.review.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(json.audit.review.lastCodeCommit.sha, /^[0-9a-f]{40}$/);
  assert.equal(json.audit.issue, null);
  assert.deepEqual(json.audit.changelog, { versionChanged: false, from: null, to: null, unreleasedHeading: null, needsStamp: false, headingWithoutVersionChange: false });
  assert.ok(json.audit.diffFiles.includes("src.js"), json.audit.diffFiles.join(","));
  assert.equal(json.audit.pr.title, branch);
  assert.equal(json.audit.owner.path, owner);
  assert.deepEqual([refState(repo), JSON.stringify(stub.state())], before, "the audit call changed refs, worktrees, or PR state");

  // Stable across unrelated commits on main and a re-committed review; changed by a new confirm gap.
  const token = json.confirmToken;
  fs.writeFileSync(path.join(repo, "other.txt"), "unrelated\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "unrelated");
  git(repo, "push", "-q", "origin", "main");
  assert.equal(shipRun(repo, stub.env, "feature", "widget").json.confirmToken, token);
  fs.writeFileSync(path.join(owner, "scratch.png"), "bytes");
  const withByproduct = shipRun(repo, stub.env, "feature", "widget").json;
  assert.deepEqual(codes(withByproduct.gaps.confirm), ["untracked-byproducts"]);
  assert.deepEqual(withByproduct.gaps.confirm[0].paths, ["scratch.png"]);
  assert.notEqual(withByproduct.confirmToken, token);
  assert.ok(fs.existsSync(path.join(owner, "scratch.png")), "the audit never cleans");

  // A stale token is rejected with both tokens and the current confirm list; nothing is written.
  const stale = shipRun(repo, stub.env, "feature", "widget", "--confirm", token);
  assert.equal(stale.code, 3);
  assert.equal(stale.json.status, "rejected");
  assert.equal(stale.json.reason, "confirm-stale");
  assert.equal(stale.json.providedToken, token);
  assert.equal(stale.json.confirmToken, withByproduct.confirmToken);
  assert.deepEqual(codes(stale.json.gaps.confirm), ["untracked-byproducts"]);
  assert.deepEqual(stale.json.actions, []);
  assert.ok(fs.existsSync(path.join(owner, "scratch.png")));
});

test("ship audit: every hard gap code in the in-repo layout rejects with the right reject-back command and no writes", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const stubFor = (branch, pr = {}) => shipStub({ product: { prs: { [branch]: pr } } });
  const expectHard = (slug, expected, { pr = {}, rejectTo } = {}) => {
    const stub = stubFor(`feature/${slug}`, pr);
    const before = [refState(repo), JSON.stringify(stub.state())];
    const { code, json } = shipRun(repo, stub.env, "feature", slug);
    assert.equal(code, 3, `${slug}: ${JSON.stringify(json)}`);
    assert.equal(json.status, "rejected", slug);
    assert.equal(json.reason, "audit-gaps", slug);
    assert.deepEqual(codes(json.gaps.hard), expected, slug);
    if (rejectTo) assert.deepEqual(json.rejectTo, rejectTo, slug);
    assert.deepEqual(json.next, [json.rejectTo.command], slug);
    assert.deepEqual(json.actions, [], slug);
    assert.deepEqual([refState(repo), JSON.stringify(stub.state())], before, `${slug}: the rejected audit wrote something`);
    return json;
  };

  shippable(fixture, "steps", { roadmap: { steps: "- [x] 1.1 done — verify: x\n- [ ] 1.2 todo — verify: y\n" } });
  const steps = expectHard("steps", ["unticked-steps"], { rejectTo: { command: "/agento build-feature steps", window: "build" } });
  assert.deepEqual(steps.audit.roadmap.unticked, ["1.2 todo — verify: y"]);

  shippable(fixture, "noreview", { roadmap: { verdict: null } });
  expectHard("noreview", ["review-missing"], { rejectTo: { command: "/agento review-feature noreview", window: "build" } });
  shippable(fixture, "changes", { roadmap: { verdict: "request-changes" } });
  expectHard("changes", ["review-request-changes"], { rejectTo: { command: "/agento review-feature changes", window: "build" } });

  // A code commit newer than the review makes it stale.
  const staleDelivery = shippable(fixture, "stale");
  fs.writeFileSync(path.join(staleDelivery.owner, "late.js"), "late\n");
  git(staleDelivery.owner, "add", "-A");
  const future = new Date(Date.now() + 120_000).toISOString();
  execFileSync("git", ["-C", staleDelivery.owner, "commit", "-q", "-m", "late code"], { env: { ...process.env, GIT_COMMITTER_DATE: future, GIT_AUTHOR_DATE: future } });
  git(staleDelivery.owner, "push", "-q");
  const stale = expectHard("stale", ["review-stale"], { rejectTo: { command: "/agento review-feature stale", window: "build" } });
  assert.equal(stale.audit.review.stale, true);
  assert.equal(stale.audit.review.lastCodeCommit.sha, git(staleDelivery.owner, "rev-parse", "HEAD"));

  // Owner tree: tracked changes, unpushed commits, both; unreadable when the directory is gone.
  const dirty = shippable(fixture, "dirty");
  fs.appendFileSync(path.join(dirty.owner, `${dirty.dir}/plan.md`), "edit\n");
  const dirtyJson = expectHard("dirty", ["owner-tree-dirty"], { rejectTo: { command: "/agento build-feature dirty", window: "build" } });
  assert.deepEqual(dirtyJson.gaps.hard[0].paths, [`${dirty.dir}/plan.md`]);
  git(dirty.owner, "commit", "-qam", "unpushed");
  expectHard("dirty", ["owner-ahead"]);
  fs.writeFileSync(path.join(dirty.owner, "x.txt"), "x");
  git(dirty.owner, "add", "x.txt");
  expectHard("dirty", ["owner-tree-dirty", "owner-ahead"]);
  const gone = shippable(fixture, "gone");
  fs.rmSync(gone.owner, { recursive: true, force: true });
  expectHard("gone", ["owner-tree-unreadable"]);

  shippable(fixture, "conflict");
  const conflict = expectHard("conflict", ["pr-conflicting"], { pr: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } });
  assert.match(conflict.gaps.hard[0].detail, /conflicts with main/);

  shippable(fixture, "heading", { extra: writeFile("CHANGELOG.md", "# Changelog\n\n## 1.2.0 (unreleased)\n\n- thing\n") });
  const heading = expectHard("heading", ["changelog-heading-without-version"]);
  assert.equal(heading.audit.changelog.unreleasedHeading, "1.2.0");
  assert.equal(heading.audit.changelog.headingWithoutVersionChange, true);

  shippable(fixture, "postship", { roadmap: { steps: `${DONE_STEPS}- [ ] 2.1 (manual, post-ship) check production — verify: dashboard\n` } });
  const unjustified = expectHard("postship", ["post-ship-unjustified"]);
  assert.deepEqual(unjustified.audit.roadmap.postShip, [{ id: "2.1", text: "(manual, post-ship) check production — verify: dashboard", ticked: false }]);
  assert.deepEqual(unjustified.audit.roadmap.unticked, [], "post-ship steps are not unticked-steps gaps");

  // Several gaps at once reject back to the build window; with no owner, to a resumed session.
  shippable(fixture, "many", { owner: false, roadmap: { verdict: null, steps: "- [ ] 1.1 todo — verify: x\n" } });
  expectHard("many", ["unticked-steps", "review-missing"], { rejectTo: { command: "/agento start-session feature/many --resume", window: "primary" } });
});

test("ship audit: post-ship steps justified under ## Risks, a version bump with and without the (unreleased) heading, and a behind PR are confirm-path or clean", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "package");
  git(repo, "push", "-q", "origin", "main");
  const stubFor = (branch, pr = {}) => shipStub({ product: { prs: { [branch]: pr } } });

  const justified = shippable(fixture, "justified", { roadmap: { steps: `${DONE_STEPS}- [ ] 2.1 (manual, post-ship) check production — verify: dashboard\n`, plan: "# Plan\n\n## Risks\n\nThe production check is a post-ship exception accepted by the user.\n\n## Out of scope\n\nnone\n" } });
  const ok = shipRun(repo, stubFor(justified.branch).env, "feature", "justified").json;
  assert.equal(ok.outcome, "awaiting-confirm", JSON.stringify(ok));
  assert.deepEqual(ok.gaps.hard, []);
  assert.equal(ok.audit.roadmap.postShip.length, 1);

  const bump = shippable(fixture, "bump", { extra: both(writeFile("package.json", JSON.stringify({ name: "p", version: "1.1.0" })), writeFile("CHANGELOG.md", "# Changelog\n\n## 1.1.0 (unreleased)\n\n- feature\n\n## 1.0.0 (2026-01-01)\n")) });
  const stamp = shipRun(repo, stubFor(bump.branch, { mergeStateStatus: "BEHIND" }).env, "feature", "bump").json;
  assert.equal(stamp.outcome, "awaiting-confirm", JSON.stringify(stamp));
  assert.deepEqual(stamp.audit.changelog, { versionChanged: true, from: "1.0.0", to: "1.1.0", unreleasedHeading: "1.1.0", needsStamp: true, headingWithoutVersionChange: false });
  assert.deepEqual(codes(stamp.gaps.confirm), ["changelog-unstamped", "pr-behind"]);
  assert.match(stamp.gaps.confirm[1].detail, /origin\/main will be merged into feature\/bump \(never rebased\)/);

  const noHeading = shippable(fixture, "noheading", { extra: writeFile("package.json", JSON.stringify({ name: "p", version: "1.2.0" })) });
  const plain = shipRun(repo, stubFor(noHeading.branch).env, "feature", "noheading").json;
  assert.equal(plain.outcome, "awaiting-confirm", JSON.stringify(plain));
  assert.deepEqual(plain.audit.changelog, { versionChanged: true, from: "1.0.0", to: "1.2.0", unreleasedHeading: null, needsStamp: false, headingWithoutVersionChange: false });
  assert.deepEqual(plain.gaps.confirm, []);
});

test("ship audit on an issue: Fixes #<n> is appended through the REST PATCH with a real blank line, only when absent", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch } = shippable(fixture, "bug", { type: "issue", roadmap: { header: 'status: in-review\nbranch: issue/bug\ngithub-issue: "#12"\nnext-step: "review"', plan: "# Plan\n\n## Resolution\n\nfixed\n" } });
  const stub = shipStub({ product: { prs: { [branch]: { body: "Reproduces the bug.  \n" } } } });
  const { code, json } = shipRun(repo, stub.env, "issue", "bug");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "awaiting-confirm");
  assert.deepEqual(json.audit.issue, { githubIssue: "12", fixesLine: true, resolutionWritten: true });
  assert.deepEqual(json.actions, [{ step: "fixes-line-added", detail: "Fixes #12 appended to the body of PR #15" }]);
  assert.equal(stub.state().product.prs[branch].body, "Reproduces the bug.\n\nFixes #12");
  const patches = stub.calls().filter((c) => / api repos\/acme\/project\/pulls\/15 -X PATCH -f body=/.test(c));
  assert.equal(patches.length, 1, stub.calls().join("\n"));
  assert.ok(stub.calls().some((c) => / repo view --json nameWithOwner -q \.nameWithOwner$/.test(c)));

  stub.reset();
  const again = shipRun(repo, stub.env, "issue", "bug").json;
  assert.deepEqual(again.actions, []);
  assert.equal(again.audit.issue.fixesLine, true);
  assert.ok(stub.calls().every((c) => !/ -X PATCH /.test(c)), "a present Fixes line is never patched again");

  // No github-issue header: nothing to patch, reported as null.
  const { branch: plainBranch } = shippable(fixture, "plain", { type: "issue", roadmap: { plan: "# Plan\n" } });
  const plain = shipRun(repo, shipStub({ product: { prs: { [plainBranch]: {} } } }).env, "issue", "plain").json;
  assert.deepEqual(plain.audit.issue, { githubIssue: null, fixesLine: false, resolutionWritten: false });
  assert.deepEqual(plain.actions, []);
});

test("ship audit in companion mode: companion half and companion PR gaps are hard, a behind companion PR is confirm-path", () => {
  const pair = makePairRepo();
  const { repo, docs, wt, docsWt } = pair;
  const open = (slug, { owner = true } = {}) => {
    const branch = `feature/${slug}`;
    publishBranch(repo, branch, writeFile("src.js", "code\n"), { keepLocal: owner });
    publishBranch(docs, branch, shipReady("feature", slug), { keepLocal: owner });
    if (owner) {
      git(repo, "worktree", "add", "-q", path.join(wt, `feature-${slug}`), branch);
      git(docs, "worktree", "add", "-q", path.join(docsWt, `feature-${slug}`), branch);
      fs.writeFileSync(path.join(wt, `feature-${slug}.code-workspace`), "{}\n");
    }
    return { branch, owner: path.join(wt, `feature-${slug}`), half: path.join(docsWt, `feature-${slug}`) };
  };
  const stubFor = (branch, companion = {}) => shipStub({ product: { prs: { [branch]: {} } }, companion: { prs: companion === null ? {} : { [branch]: { number: 7, ...companion } } } });
  const audit = (slug, companion) => {
    const stub = stubFor(`feature/${slug}`, companion);
    const before = [refState(repo, docs), JSON.stringify(stub.state())];
    const json = shipRun(repo, stub.env, "feature", slug).json;
    assert.deepEqual([refState(repo, docs), JSON.stringify(stub.state())], before, `${slug}: the audit wrote something`);
    return json;
  };

  const clean = open("clean");
  const ok = audit("clean");
  assert.equal(ok.outcome, "awaiting-confirm", JSON.stringify(ok));
  assert.equal(ok.mode, "companion");
  assert.deepEqual(ok.gaps, { hard: [], confirm: [] });
  assert.equal(ok.audit.companion.path, clean.half);
  assert.equal(ok.audit.companionPr.number, 7);
  assert.ok(ok.audit.diffFiles.includes("src.js"));
  assert.equal(ok.audit.review.present, true, "the review is read from the companion branch");
  assert.equal(git(docs, "branch", "--show-current"), "main");

  const behind = audit("clean", { mergeStateStatus: "BEHIND" });
  assert.deepEqual(codes(behind.gaps.confirm), ["companion-pr-behind"]);
  assert.notEqual(behind.confirmToken, ok.confirmToken);
  assert.deepEqual(codes(audit("clean", { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }).gaps.hard), ["companion-pr-conflicting"]);
  assert.deepEqual(codes(audit("clean", { state: "CLOSED" }).gaps.hard), ["companion-pr-not-open"]);
  const missing = audit("clean", null);
  assert.deepEqual(codes(missing.gaps.hard), ["companion-missing-pr"]);
  assert.deepEqual(missing.rejectTo, { command: "/agento build-feature clean", window: "build" });

  // Half gaps: dirty (with the paths), unpushed, behind — each with its fix text.
  fs.writeFileSync(path.join(clean.half, "notes.md"), "draft\n");
  const dirty = audit("clean");
  assert.deepEqual(codes(dirty.gaps.hard), ["companion-dirty"]);
  assert.deepEqual(dirty.gaps.hard[0].paths, ["notes.md"]);
  assert.match(dirty.gaps.hard[0].detail, /commit and push it \(or discard the changes\)/);
  git(clean.half, "add", "-A");
  git(clean.half, "commit", "-q", "-m", "notes");
  assert.deepEqual(codes(audit("clean").gaps.hard), ["companion-unpushed"]);
  git(clean.half, "push", "-q");
  git(clean.half, "reset", "-q", "--hard", "HEAD~1");
  const lagging = audit("clean");
  assert.deepEqual(codes(lagging.gaps.hard), ["companion-behind"]);
  assert.match(lagging.gaps.hard[0].detail, /merge origin\/feature\/clean \(a fast-forward\)/);
});

test("ship audit rejects a PR GitHub reports as conflicting (#107 ship-conflict-gate)", () => {
  // GitHub reports a conflict as mergeable: CONFLICTING / mergeStateStatus: DIRTY.
  const CONFLICT = { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch } = shippable(fixture, "conflict107");
  const stub = shipStub({ product: { prs: { [branch]: CONFLICT } } });
  const before = [refState(repo), JSON.stringify(stub.state())];
  const { code, json } = shipRun(repo, stub.env, "feature", "conflict107");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "rejected");
  assert.equal(json.reason, "audit-gaps");
  assert.deepEqual(codes(json.gaps.hard), ["pr-conflicting"]);
  assert.deepEqual(json.rejectTo, { command: "/agento build-feature conflict107", window: "build" });
  assert.deepEqual(json.actions, []);
  assert.deepEqual([refState(repo), JSON.stringify(stub.state())], before, "the rejected audit wrote something");

  const pair = makePairRepo();
  const paired = pairShippable(pair, "conflict107");
  const pairedStub = shipStub({ product: { prs: { [paired.branch]: {} } }, companion: { prs: { [paired.branch]: { number: 7, ...CONFLICT } } } });
  const pairedBefore = [refState(pair.repo, pair.docs), JSON.stringify(pairedStub.state())];
  const companion = shipRun(pair.repo, pairedStub.env, "feature", "conflict107");
  assert.equal(companion.code, 3, JSON.stringify(companion.json));
  assert.equal(companion.json.status, "rejected");
  assert.equal(companion.json.reason, "audit-gaps");
  assert.deepEqual(codes(companion.json.gaps.hard), ["companion-pr-conflicting"]);
  assert.deepEqual(companion.json.rejectTo, { command: "/agento build-feature conflict107", window: "build" });
  assert.deepEqual([refState(pair.repo, pair.docs), JSON.stringify(pairedStub.state())], pairedBefore, "the rejected companion audit wrote something");
});

test("ship audit: an open PR whose mergeability GitHub has not computed yet is a warning, not a gap", () => {
  const fixture = makeWorktreeRepo();
  const { branch } = shippable(fixture, "unknown");
  const { code, json } = shipRun(fixture.repo, shipStub({ product: { prs: { [branch]: { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" } } } }).env, "feature", "unknown");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "awaiting-confirm");
  assert.deepEqual(json.gaps, { hard: [], confirm: [] });
  assert.equal(json.pr.mergeable, "UNKNOWN");
  assert.deepEqual(json.warnings, ["pr-mergeable-unknown: GitHub has not computed mergeability for PR #15 yet; re-send to re-check"]);
});

const today = () => new Date().toISOString().slice(0, 10);

test("ship --confirm (in-repo, owner): cleans the listed byproducts, completes the roadmap with follow-ups, stamps the changelog, readies, waits, merges, deletes the branch, syncs, and tears down", () => {
  const fixture = makeWorktreeRepo();
  const { repo, wt } = fixture;
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "package");
  git(repo, "push", "-q", "origin", "main");
  const { branch, owner, dir } = shippable(fixture, "widget", { extra: both(writeFile("src.js", "code\n"), writeFile("package.json", JSON.stringify({ name: "p", version: "1.1.0" })), writeFile("CHANGELOG.md", "# Changelog\n\n## 1.1.0 (unreleased)\n\n- feature\n")) });
  fs.writeFileSync(path.join(owner, "shot[1].png"), "bytes");
  fs.writeFileSync(path.join(owner, "shot1.png"), "bytes");
  git(owner, "add", "shot1.png");
  // Same second as the review commit: a later second would make the review stale.
  const reviewSecond = `@${git(owner, "log", "-1", "--format=%ct")} +0000`;
  execFileSync("git", ["-C", owner, "commit", "-q", "-m", "tracked shot"], { env: { ...process.env, GIT_AUTHOR_DATE: reviewSecond, GIT_COMMITTER_DATE: reviewSecond } });
  git(owner, "push", "-q");
  const stub = shipStub({ product: { prs: { [branch]: { rollups: PASSING } } } });

  const audit = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(audit.outcome, "awaiting-confirm", JSON.stringify(audit));
  assert.deepEqual(codes(audit.gaps.confirm), ["untracked-byproducts", "changelog-unstamped"]);
  assert.deepEqual(audit.gaps.confirm[0].paths, ["shot[1].png"]);

  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", audit.confirmToken, "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.phase, "done");
  assert.equal(json.outcome, "shipped");
  assert.equal(json.resumedAt, "audit");
  assert.deepEqual(stepsOf(json), ["clean", "roadmap-complete", "changelog-stamp", "push", "pr-ready", "merge-code", "delete-branch", "sync", "teardown"]);
  assert.match(json.actions[0].detail, /removed 1 untracked file\(s\) from .*feature-widget: shot\[1\]\.png$/);
  assert.equal(json.pr.state, "MERGED");
  assert.equal(json.mergeSha, git(repo, "rev-parse", "origin/main"));
  assert.equal(json.teardown.product.removed, true);
  assert.equal(json.teardown.branches.product.action, "deleted");
  assert.deepEqual(json.next, []);

  // The literal pathspec removed shot[1].png only; the tracked shot1.png survived the clean and shipped.
  assert.equal(git(repo, "show", "origin/main:shot1.png"), "bytes");
  assert.ok(!git(repo, "ls-tree", "-r", "--name-only", "origin/main").split("\n").includes("shot[1].png"), "the untracked byproduct never shipped");
  assert.equal(fs.existsSync(path.join(owner, "shot[1].png")), false, "the owner worktree is gone with its byproduct");
  const roadmap = git(repo, "show", `origin/main:${dir}/roadmap.md`);
  assert.match(roadmap, /^status: complete$/m);
  assert.match(roadmap, new RegExp(`^last-updated: ${today()}$`, "m"));
  assert.match(roadmap, /^next-step: ""$/m);
  assert.match(roadmap, /## Follow-ups \(accepted at ship\)\n\n- untracked-byproducts: .*\(shot\[1\]\.png\) — accepted \d{4}-\d{2}-\d{2}\n- changelog-unstamped: /);
  assert.match(git(repo, "show", "origin/main:CHANGELOG.md"), new RegExp(`^## 1\\.1\\.0 \\(${today()}\\)$`, "m"));
  assert.match(git(repo, "log", "--format=%s", "origin/main"), /^docs\(feature\): ship widget$/m);
  assert.match(git(repo, "log", "--format=%s", "origin/main"), /^chore\(release\): stamp CHANGELOG 1\.1\.0/m);

  // gh saw exactly: ready, one bounded poll, a plain --merge; never admin/squash/rebase/delete-branch.
  const gh = stub.calls().map((c) => c.replace(`${repo} `, "")).filter((c) => !/^--version|^auth status|^pr view feature\/widget --json number,state/.test(c));
  assert.deepEqual(gh.filter((c) => /^pr (ready|merge)/.test(c)), ["pr ready 15", "pr merge 15 --merge"]);
  assert.ok(gh.some((c) => c.startsWith("pr view 15 --json statusCheckRollup,mergeStateStatus --jq ")), gh.join("\n"));

  // Remote branch gone, primary on main at origin/main and clean, owner worktree and local branch removed.
  git(repo, "fetch", "-q", "--prune", "origin");
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature/widget"), "the remote branch is deleted");
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(worktreeCount(repo), 1);
  assert.equal(fs.existsSync(owner), false);
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"));
  assert.deepEqual(fs.readdirSync(wt), []);

  // A re-send after the ship is a sync-only report with no second merge, push, or PR.
  stub.reset();
  const again = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(again.status, "ok", JSON.stringify(again));
  assert.equal(again.phase, "done");
  assert.equal(again.outcome, "already-shipped");
  assert.equal(again.resumedAt, "done");
  assert.deepEqual(again.actions, []);
  assert.ok(stub.calls().every((c) => !/ pr (merge|ready|create)/.test(c)), stub.calls().join("\n"));
});

test("ship --confirm: pending checks return exit 2 with the same --confirm command and the re-send continues; a failing check stops before the merge", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner, dir } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { rollups: [[{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null }], ...PASSING] } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;

  const first = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(first.code, 2, JSON.stringify(first.json));
  assert.equal(first.json.status, "pending");
  assert.equal(first.json.phase, "checks");
  assert.deepEqual(stepsOf(first.json), ["roadmap-complete", "push", "pr-ready"]);
  assert.deepEqual(first.json.next, [`/agento ship widget --confirm ${token}`]);
  assert.match(first.json.message, /PR #15: RESULT: still pending/);
  assert.equal(stub.state().product.prs[branch].state, "OPEN", "nothing merged while pending");
  assert.match(git(repo, "show", `origin/${branch}:${dir}/roadmap.md`), /^status: complete$/m);

  // The re-send finds the roadmap complete on the open branch, skips the audit and the token, and merges.
  const second = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(second.json.resumedAt, "checks");
  assert.equal(second.json.outcome, "shipped");
  assert.deepEqual(stepsOf(second.json), ["merge-code", "delete-branch", "sync", "teardown"]);
  assert.equal(stub.calls().filter((c) => / pr merge 15 --merge$/.test(c)).length, 1);
  assert.equal(stub.calls().filter((c) => / pr ready 15$/.test(c)).length, 1, "ready is not repeated once the PR is ready");
  assert.equal(fs.existsSync(owner), false);

  // A failing required check: failed / checks-failed, nothing merged, resumable.
  const failing = shippable(fixture, "broken", { extra: writeFile("src.js", "code\n") });
  const failStub = shipStub({ product: { prs: { [failing.branch]: { number: 16, rollups: [[{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" }]] } } } });
  const failToken = shipRun(repo, failStub.env, "feature", "broken").json.confirmToken;
  const failed = shipRun(repo, failStub.env, "feature", "broken", "--confirm", failToken, "--wait", "0");
  assert.equal(failed.code, 3);
  assert.equal(failed.json.status, "failed");
  assert.equal(failed.json.reason, "checks-failed");
  assert.deepEqual(failed.json.rejectTo, { command: "/agento build-feature broken", window: "build" });
  assert.equal(failStub.state().product.prs[failing.branch].state, "OPEN");
  assert.ok(failStub.calls().every((c) => !/ pr merge/.test(c)));
  assert.ok(fs.existsSync(failing.owner));
  // The failing check reopened the roadmap, so the next send runs the audit (#107).
  assert.ok(stepsOf(failed.json).includes("roadmap-reopened"), JSON.stringify(failed.json.actions));
  git(repo, "fetch", "-q", "origin");
  assert.match(git(repo, "show", `origin/${failing.branch}:${failing.dir}/roadmap.md`), /^status: in-progress$/m);
  assert.match(git(repo, "log", "-1", "--format=%s", `origin/${failing.branch}`), /^docs\(feature\): reopen broken \(checks-failed\)$/);
  assert.equal(git(failing.owner, "status", "--porcelain"), "");
  assert.equal(shipRun(repo, failStub.env, "feature", "broken").json.resumedAt, "audit");

  // No owner: the primary is switched onto the branch for the reopen and back; the handoff resumes a session.
  const orphan = shippable(fixture, "orphan", { owner: false, extra: writeFile("src.js", "code\n") });
  const orphanStub = shipStub({ product: { prs: { [orphan.branch]: { number: 17, rollups: [[{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" }]] } } } });
  const orphanToken = shipRun(repo, orphanStub.env, "feature", "orphan").json.confirmToken;
  const orphaned = shipRun(repo, orphanStub.env, "feature", "orphan", "--confirm", orphanToken, "--wait", "0");
  assert.equal(orphaned.json.status, "failed", JSON.stringify(orphaned.json));
  assert.equal(orphaned.json.reason, "checks-failed");
  assert.deepEqual(orphaned.json.rejectTo, { command: "/agento start-session feature/orphan --resume", window: "primary" });
  assert.ok(stepsOf(orphaned.json).includes("roadmap-reopened"));
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "status", "--porcelain"), "");
  git(repo, "fetch", "-q", "origin");
  assert.match(git(repo, "show", `origin/${orphan.branch}:${orphan.dir}/roadmap.md`), /^status: in-progress$/m);
});

test("reopenRoadmap reopens to in-progress with a Ship reopen phase named by next-step, and removes only the accepted-at-ship follow-ups", () => {
  const original = '```yaml\nstatus: in-review\nbranch: feature/widget\nlast-updated: 2026-10-01\nnext-step: "review"\n```\n\n## Phase 1\n\n- [x] 1.1 done — verify: x\n\n## Follow-ups\n\n- later\n';
  const completed = completeRoadmap(original, { date: "2026-10-10", followups: [{ code: "pr-behind", detail: "PR #15 is behind main" }, { code: "untracked-byproducts", detail: "1 untracked file(s)", paths: ["a.png"] }] });
  assert.match(completed, /^status: complete$/m);
  assert.match(completed, /## Follow-ups \(accepted at ship\)\n\n- pr-behind: .*\n- untracked-byproducts: /);

  const reopened = reopenRoadmap(completed, { date: "2026-10-11", codes: ["pr-conflicting"] });
  assert.match(reopened, /^status: in-progress$/m);
  assert.match(reopened, /^last-updated: 2026-10-11$/m);
  assert.match(reopened, /^next-step: "2\.1 \(added 2026-10-11\)"$/m);
  assert.match(reopened, /^## Phase 2: Ship reopen \(2026-10-11\)$/m);
  assert.match(reopened, /^- \[ \] 2\.1 \(added 2026-10-11\) Merge `origin\/main` into the branch with `agento\.mjs sync` and resolve the conflict per the concurrent-delivery hotspot recipes — verify: `sync` reports no `integration-conflict`; `gh pr view <n> --json mergeable,mergeStateStatus` is not CONFLICTING\/DIRTY; the full test command passes$/m);
  assert.doesNotMatch(reopened, /## Follow-ups \(accepted at ship\)/);
  assert.match(reopened, /^## Follow-ups$/m, "the pre-existing Follow-ups section is kept");

  // A richer step text from the caller wins over the default.
  const rich = reopenRoadmap(completed, { date: "2026-10-11", codes: ["pr-conflicting"], stepText: { "pr-conflicting": "Merge `origin/main` into `feature/widget` — verify: `sync` reports no `integration-conflict`" } });
  assert.match(rich, /2\.1 \(added 2026-10-11\) Merge `origin\/main` into `feature\/widget` — verify: `sync` reports no `integration-conflict`$/m);

  // Without the accepted-at-ship section the header changes and the Ship reopen phase is appended.
  const done = original.replace("status: in-review", "status: complete");
  const plain = reopenRoadmap(done, { date: "2026-10-11", codes: ["checks-failed", "pr-conflicting"] });
  assert.match(plain, /^status: in-progress$/m);
  assert.match(plain, /^last-updated: 2026-10-11$/m);
  assert.match(plain, /^next-step: "2\.1 \(added 2026-10-11\)"$/m);
  assert.match(plain, /^- \[ \] 2\.1 \(added 2026-10-11\) Fix the failing required check — verify: `scripts\/wait-for-checks\.sh pr <n>` succeeds$/m);
  assert.match(plain, /^- \[ \] 2\.2 \(added 2026-10-11\) Merge `origin\/main` into the branch with `agento\.mjs sync` and resolve the conflict per the concurrent-delivery hotspot recipes/m);
  assert.equal(reopenRoadmap(plain, { date: "2026-10-11", codes: ["checks-failed", "pr-conflicting"] }), plain, "idempotent");

  // A second reopen with a different code adds exactly that code's step and no
  // duplicate of the existing ones.
  const second = reopenRoadmap(plain, { date: "2026-10-12", codes: ["companion-pr-conflicting"] });
  assert.match(second, /^- \[ \] 2\.3 \(added 2026-10-12\) Merge `origin\/main` into the companion half with `agento\.mjs sync`/m);
  assert.equal([...second.matchAll(/^- \[ \] 2\.1 \(added /gm)].length, 1, "no duplicate checks-failed step");
  assert.equal([...second.matchAll(/^- \[ \] 2\.2 \(added /gm)].length, 1, "no duplicate pr-conflicting step");
  assert.equal([...second.matchAll(/^- \[ \] 2\./gm)].length, 3, "exactly three steps in the reused section");

  // A reopen after the earlier step was ticked and the roadmap completed yields
  // exactly one unticked step named by next-step, on that step's own date.
  const ticked = reopened.replace("- [ ] 2.1 (added 2026-10-11)", "- [x] 2.1 (added 2026-10-11)");
  const completedAgain = completeRoadmap(ticked, { date: "2026-10-12", followups: [] });
  const third = reopenRoadmap(completedAgain, { date: "2026-10-13", codes: ["checks-failed"] });
  assert.match(third, /^next-step: "2\.2 \(added 2026-10-13\)"$/m);
  assert.equal([...third.matchAll(/^- \[ \] 2\./gm)].length, 1, "exactly one unticked step after the reopen");
  assert.match(third, /^- \[ \] 2\.2 \(added 2026-10-13\) Fix the failing required check/m);
  assert.equal([...third.matchAll(/^- \[x\] 2\.1 \(added /gm)].length, 1, "the ticked step is kept");
});

test("ship --confirm at checks with a conflicting PR reopens the roadmap and rejects (#107 ship-conflict-gate)", () => {
  const PENDING = [[{ name: "Unit tests", status: "IN_PROGRESS", conclusion: null }]];
  const CONFLICT = { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" };

  // In-repo, owner: the confirm lands the complete roadmap, then the PR turns conflicting.
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner, dir } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { rollups: PENDING } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const pending = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(pending.json.status, "pending", JSON.stringify(pending.json));
  assert.match(git(repo, "show", `origin/${branch}:${dir}/roadmap.md`), /^status: complete$/m);
  stub.update((s) => Object.assign(s.product.prs[branch], CONFLICT));
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "rejected");
  assert.equal(json.reason, "audit-gaps");
  assert.equal(json.resumedAt, "checks");
  assert.deepEqual(codes(json.gaps.hard), ["pr-conflicting"]);
  assert.ok(stepsOf(json).includes("roadmap-reopened"), JSON.stringify(json.actions));
  assert.deepEqual(json.rejectTo, { command: "/agento build-feature widget", window: "build" });
  assert.deepEqual(json.next, ["/agento build-feature widget"]);
  git(repo, "fetch", "-q", "origin");
  const roadmap = git(repo, "show", `origin/${branch}:${dir}/roadmap.md`);
  assert.match(roadmap, /^status: in-progress$/m);
  assert.doesNotMatch(roadmap, /## Follow-ups \(accepted at ship\)/);
  assert.match(git(repo, "log", "-1", "--format=%s", `origin/${branch}`), /^docs\(feature\): reopen widget \(pr-conflicting\)$/);
  assert.ok(stub.calls().every((c) => !/ pr merge/.test(c)), stub.calls().join("\n"));
  assert.equal(stub.state().product.prs[branch].state, "OPEN");
  assert.ok(fs.existsSync(owner));
  assert.equal(git(owner, "status", "--porcelain"), "");
  assert.equal(git(owner, "rev-parse", "HEAD"), git(repo, "rev-parse", `origin/${branch}`));

  // The third send derives the audit again and writes nothing; the reopen step now
  // shows up as an unticked Builder step alongside the conflict.
  const before = [refState(repo), JSON.stringify(stub.state())];
  const third = shipRun(repo, stub.env, "feature", "widget");
  assert.equal(third.json.resumedAt, "audit", JSON.stringify(third.json));
  assert.equal(third.json.reason, "audit-gaps");
  assert.deepEqual(codes(third.json.gaps.hard), ["unticked-steps", "pr-conflicting"]);
  assert.deepEqual(third.json.actions, []);
  assert.deepEqual([refState(repo), JSON.stringify(stub.state())], before);

  // Companion mode, owner: the companion PR conflicts; the reopen commit lands in the half, the product branch is untouched.
  const pair = makePairRepo();
  const paired = pairShippable(pair, "widget");
  const pairedStub = pairStub(paired.branch, { rollups: PENDING });
  const pairedToken = shipRun(pair.repo, pairedStub.env, "feature", "widget").json.confirmToken;
  assert.equal(shipRun(pair.repo, pairedStub.env, "feature", "widget", "--confirm", pairedToken, "--wait", "0").json.status, "pending");
  const productHead = git(pair.repo, "rev-parse", `origin/${paired.branch}`);
  pairedStub.update((s) => Object.assign(s.companion.prs[paired.branch], CONFLICT));
  const companion = shipRun(pair.repo, pairedStub.env, "feature", "widget", "--confirm", pairedToken, "--wait", "0");
  assert.equal(companion.code, 3, JSON.stringify(companion.json));
  assert.equal(companion.json.reason, "audit-gaps");
  assert.equal(companion.json.resumedAt, "checks");
  assert.deepEqual(codes(companion.json.gaps.hard), ["companion-pr-conflicting"]);
  assert.ok(stepsOf(companion.json).includes("roadmap-reopened"));
  git(pair.repo, "fetch", "-q", "origin");
  git(pair.docs, "fetch", "-q", "origin");
  assert.equal(git(pair.repo, "rev-parse", `origin/${paired.branch}`), productHead, "the product branch is untouched");
  assert.match(git(pair.docs, "show", `origin/${paired.branch}:${paired.dir}/roadmap.md`), /^status: in-progress$/m);
  assert.match(git(pair.docs, "log", "-1", "--format=%s", `origin/${paired.branch}`), /^docs\(feature\): reopen widget \(companion-pr-conflicting\)$/);
  assert.equal(git(paired.half, "status", "--porcelain"), "");
  assert.ok(pairedStub.calls().every((c) => !/ pr merge/.test(c)));
  assert.equal(shipRun(pair.repo, pairedStub.env, "feature", "widget").json.resumedAt, "audit");
});

test("ship --confirm: a merge refused as not mergeable reopens the roadmap on the no-owner path; any other merge failure does not (#107 ship-conflict-gate)", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  // Clean when audited and when the checks pass, refused by GitHub at the merge itself.
  const { branch, dir } = shippable(fixture, "widget", { owner: false, extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { rollups: PASSING, refuseMerge: true } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "rejected");
  assert.equal(json.reason, "audit-gaps");
  assert.deepEqual(codes(json.gaps.hard), ["pr-conflicting"]);
  assert.ok(stepsOf(json).includes("roadmap-reopened"), JSON.stringify(json.actions));
  assert.deepEqual(json.rejectTo, { command: "/agento start-session feature/widget --resume", window: "primary" });
  assert.equal(git(repo, "branch", "--show-current"), "main", "the primary is switched back");
  assert.equal(git(repo, "status", "--porcelain"), "");
  git(repo, "fetch", "-q", "origin");
  const roadmap = git(repo, "show", `origin/${branch}:${dir}/roadmap.md`);
  assert.match(roadmap, /^status: in-progress$/m);
  assert.doesNotMatch(roadmap, /## Follow-ups \(accepted at ship\)/);
  assert.equal(stub.state().product.prs[branch].state, "OPEN");

  // Any other merge failure keeps gh-error and the complete roadmap.
  const other = shippable(fixture, "other", { owner: false, extra: writeFile("src.js", "code\n") });
  const otherStub = shipStub({ product: { prs: { [other.branch]: { number: 16, rollups: PASSING, refuseMerge: "GraphQL: Something went wrong while executing your query (mergePullRequest)" } } } });
  const otherToken = shipRun(repo, otherStub.env, "feature", "other").json.confirmToken;
  const failed = shipRun(repo, otherStub.env, "feature", "other", "--confirm", otherToken, "--wait", "0");
  assert.equal(failed.json.status, "failed", JSON.stringify(failed.json));
  assert.equal(failed.json.reason, "gh-error");
  assert.ok(!stepsOf(failed.json).includes("roadmap-reopened"));
  git(repo, "fetch", "-q", "origin");
  assert.match(git(repo, "show", `origin/${other.branch}:${other.dir}/roadmap.md`), /^status: complete$/m);
  assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("ship --confirm (in-repo, no owner): the primary is switched onto the branch for the writes and back; a behind PR is integrated by merge; a conflicting integration aborts and rejects", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  fs.writeFileSync(path.join(repo, "shared.txt"), "main v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "shared");
  git(repo, "push", "-q", "origin", "main");
  const { branch, dir } = shippable(fixture, "widget", { owner: false, extra: writeFile("src.js", "code\n") });
  fs.writeFileSync(path.join(repo, "other.txt"), "main moves on\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main advances");
  git(repo, "push", "-q", "origin", "main");
  const stub = shipStub({ product: { prs: { [branch]: { mergeStateStatus: "BEHIND", rollups: PASSING } } } });

  const audit = shipRun(repo, stub.env, "feature", "widget").json;
  assert.deepEqual(codes(audit.gaps.confirm), ["pr-behind"]);
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", audit.confirmToken, "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "shipped");
  assert.deepEqual(stepsOf(json), ["integrate", "roadmap-complete", "push", "pr-ready", "merge-code", "delete-branch", "sync", "delete-local-branch"]);
  assert.equal(json.teardown, null);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"), "the local branch the writes used is deleted once merged");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(git(repo, "show", "origin/main:other.txt"), "main moves on");
  assert.equal(git(repo, "show", "origin/main:src.js"), "code");
  assert.match(git(repo, "show", `origin/main:${dir}/roadmap.md`), /^status: complete$/m);
  assert.match(git(repo, "show", `origin/main:${dir}/roadmap.md`), /- pr-behind: PR #15 is behind main/);
  assert.equal(worktreeCount(repo), 1);

  // A conflicting integration: merge --abort, clean tree, rejected with the resume-session handoff, nothing pushed.
  const conflict = shippable(fixture, "clash", { owner: false, extra: writeFile("shared.txt", "branch v2\n") });
  fs.writeFileSync(path.join(repo, "shared.txt"), "main v3\n");
  git(repo, "commit", "-qam", "main edits shared");
  git(repo, "push", "-q", "origin", "main");
  const clashStub = shipStub({ product: { prs: { [conflict.branch]: { number: 16, mergeStateStatus: "BEHIND", rollups: PASSING } } } });
  const clashToken = shipRun(repo, clashStub.env, "feature", "clash").json.confirmToken;
  const remoteRefs = () => [git(repo, "for-each-ref", "refs/remotes"), git(repo, "worktree", "list", "--porcelain")];
  const before = remoteRefs();
  const rejected = shipRun(repo, clashStub.env, "feature", "clash", "--confirm", clashToken, "--wait", "0");
  assert.equal(rejected.code, 3, JSON.stringify(rejected.json));
  assert.equal(rejected.json.status, "rejected");
  assert.equal(rejected.json.reason, "integration-conflict");
  assert.match(rejected.json.message, /the merge was aborted and the tree is clean again/);
  assert.deepEqual(rejected.json.rejectTo, { command: "/agento start-session feature/clash --resume", window: "primary" });
  assert.deepEqual(rejected.json.actions, []);
  assert.equal(git(repo, "branch", "--show-current"), "main", "the primary is switched back");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual(remoteRefs(), before);
  assert.equal(git(repo, "rev-parse", "refs/heads/feature/clash"), git(repo, "rev-parse", "origin/feature/clash"), "the local branch left behind is exactly origin/feature/clash");
  assert.equal(clashStub.state().product.prs[conflict.branch].state, "OPEN");
});

// #132: a policy-blocked merge (required status check never reported) must not be
// misreported as a conflict, and a genuine conflict or failed check must reopen the
// roadmap to in-progress so the build window routes to the Builder — not to a
// stale re-review or a second ship.
test("ship #132 ship-merge-refusal-loop: a BLOCKED merge refusal waits for the missing required check, then reports merge-blocked without reopening", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner, dir } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({
    product: { prs: { [branch]: { rollups: PASSING, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", refuseMerge: "X Pull request #15 is not mergeable: the base branch policy prohibits the merge." } }, rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Unit tests" }, { context: "Vercel" }] } }] },
  });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const reviewBefore = git(repo, "show", `origin/${branch}:${dir}/review.md`);
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  // Within the grace: pending, naming the missing Vercel context; never a conflict, never reopened.
  assert.equal(code, 2, JSON.stringify(json));
  assert.equal(json.status, "pending");
  assert.equal(json.phase, "checks");
  assert.match(json.message, /Vercel/);
  assert.deepEqual(codes(json.gaps.hard), []);
  assert.ok(!stepsOf(json).includes("roadmap-reopened"));

  // Move the head commit out of the 10-minute grace and re-send the same confirm.
  execFileSync("git", ["-C", owner, "commit", "-q", "--allow-empty", "-m", "old head"], { env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
  git(owner, "push", "-q");
  const blocked = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(blocked.code, 3, JSON.stringify(blocked.json));
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.reason, "merge-blocked");
  assert.deepEqual(blocked.json.next, ["/agento ship widget"]);
  assert.ok(!stepsOf(blocked.json).includes("roadmap-reopened"));
  git(repo, "fetch", "-q", "origin");
  assert.match(git(repo, "show", `origin/${branch}:${dir}/roadmap.md`), /^status: complete$/m);
  assert.equal(git(repo, "show", `origin/${branch}:${dir}/review.md`), reviewBefore, "review.md is untouched");
});

test("ship #132 ship-merge-refusal-loop: unknown required contexts are reported with gh's refusal, never guessed", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  // No ruleset and no classic protection → both endpoints 404, so ghRequiredContexts
  // returns known: false. The refusal classifies as blocked, and ship must quote it
  // instead of guessing "required reviews or conversation resolution".
  const stub = shipStub({ product: { prs: { [branch]: { rollups: PASSING, refuseMerge: "X Pull request #15 is not mergeable: the base branch policy prohibits the merge." } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "blocked");
  assert.equal(json.reason, "merge-blocked");
  assert.match(json.message, /required status checks could not be read/);
  assert.match(json.message, /X Pull request #15 is not mergeable: the base branch policy prohibits the merge/);
  assert.doesNotMatch(json.message, /required reviews or conversation resolution/);
  assert.deepEqual(json.next, ["/agento ship widget"]);
});

test("ship #132 ship-merge-refusal-loop: a DIRTY refusal reopens to in-progress and routes the build window to the Builder", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner, dir } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { rollups: PASSING, refuseMerge: "X Pull request #15 is not mergeable: the merge commit cannot be cleanly created." } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const shipped = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(shipped.code, 3, JSON.stringify(shipped.json));
  assert.equal(shipped.json.status, "rejected");
  assert.equal(shipped.json.reason, "audit-gaps");
  assert.deepEqual(codes(shipped.json.gaps.hard), ["pr-conflicting"]);

  // The roadmap on origin is in-progress with a Ship reopen step named by next-step.
  git(repo, "fetch", "-q", "origin");
  const roadmap = git(repo, "show", `origin/${branch}:${dir}/roadmap.md`);
  assert.match(roadmap, /^status: in-progress$/m);
  assert.match(roadmap, /^## Phase \d+: Ship reopen \(/m);
  assert.match(roadmap.match(/^next-step: "(.*)"$/m)[1], /^2\.1 \(added /);

  // The owner build window derives build-feature; session allows build and ap.
  const next = runWith({ cwd: owner, env: stub.env }, "next");
  assert.equal(next.json.next && next.json.next.invocation, "/agento build-feature widget", JSON.stringify(next.json));
  const session = runWith({ cwd: owner, env: stub.env }, "session");
  assert.ok(session.json.allowed.includes("/agento build-feature widget"), JSON.stringify(session.json.allowed));
  assert.ok(session.json.allowed.includes("/agento ap widget"), JSON.stringify(session.json.allowed));

  // Ship's receipt names the build window, not the primary create commands.
  assert.ok(!shipped.json.allowed.includes("/agento new-feature"), JSON.stringify(shipped.json.allowed));
  assert.deepEqual(shipped.json.elsewhere, [{ command: "/agento build-feature widget", window: "build", reason: "ship reopened the roadmap to in-progress; resolve the reopen step in the build window, then re-review" }]);
});

test("ship #132 ship-merge-refusal-loop: checks-failed reopens to in-progress with the fix-the-check step", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, dir } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const stub = shipStub({ product: { prs: { [branch]: { number: 16, rollups: [[{ name: "Unit tests", status: "COMPLETED", conclusion: "FAILURE" }]] } } } });
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "failed");
  assert.equal(json.reason, "checks-failed");
  git(repo, "fetch", "-q", "origin");
  const roadmap = git(repo, "show", `origin/${branch}:${dir}/roadmap.md`);
  assert.match(roadmap, /^status: in-progress$/m);
  assert.match(roadmap, /^## Phase \d+: Ship reopen \(/m);
  assert.match(roadmap.match(/^next-step: "(.*)"$/m)[1], /^2\.1 \(added /);
});

test("ghRequiredContexts stub endpoints: the ruleset and classic protection are served, an absent classic protection is 404", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch } = shippable(fixture, "widget", { extra: writeFile("src.js", "code\n") });
  const gh = (stub, ...args) => spawnSync("gh", args, { cwd: repo, env: stub.env, encoding: "utf8" });
  const stub = shipStub({
    product: {
      prs: { [branch]: { rollups: PASSING } },
      rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "Unit tests" }, { context: "Vercel" }] } }],
    },
  });
  const rules = gh(stub, "api", "-H", "Accept: application/vnd.github+json", "repos/acme/project/rules/branches/main");
  assert.equal(rules.status, 0, rules.stderr);
  assert.deepEqual(JSON.parse(rules.stdout), stub.state().product.rules);
  const absent = gh(stub, "api", "-H", "Accept: application/vnd.github+json", "repos/acme/project/branches/main/protection/required_status_checks");
  assert.equal(absent.status, 1, "classic protection absent is 404");
  assert.match(absent.stderr, /Not Found/);
  stub.update((s) => { s.product.protection = { contexts: ["Unit tests"], checks: [] }; });
  const classic = gh(stub, "api", "-H", "Accept: application/vnd.github+json", "repos/acme/project/branches/main/protection/required_status_checks");
  assert.equal(classic.status, 0, classic.stderr);
  assert.deepEqual(JSON.parse(classic.stdout), { contexts: ["Unit tests"], checks: [] });
});

// A companion-mode delivery ready to ship: code on the product branch, artifacts on the
// companion branch, optionally a managed pair with its workspace file.
function pairShippable(pair, slug, { owner = true, extra = writeFile("src.js", "code\n") } = {}) {
  const { repo, docs, wt, docsWt } = pair;
  const branch = `feature/${slug}`;
  publishBranch(repo, branch, extra, { keepLocal: owner });
  publishBranch(docs, branch, shipReady("feature", slug), { keepLocal: owner });
  if (owner) {
    git(repo, "worktree", "add", "-q", path.join(wt, `feature-${slug}`), branch);
    git(docs, "worktree", "add", "-q", path.join(docsWt, `feature-${slug}`), branch);
    fs.writeFileSync(path.join(wt, `feature-${slug}.code-workspace`), "{}\n");
  }
  return { branch, owner: owner ? path.join(wt, `feature-${slug}`) : null, half: owner ? path.join(docsWt, `feature-${slug}`) : null, workspace: path.join(wt, `feature-${slug}.code-workspace`), dir: `features/2026/10/${slug}` };
}
const pairStub = (branch, product = {}, companion = {}) => shipStub({ product: { prs: { [branch]: { rollups: PASSING, ...product } } }, companion: { prs: { [branch]: { number: 7, rollups: PASSING, ...companion } } } });

test("ship --confirm (companion, owner): the roadmap commit lands in the companion half, both PRs are readied, code merges first, then the companion, both defaults sync, both halves and the workspace file go", () => {
  const pair = makePairRepo();
  const { repo, docs, wt, docsWt } = pair;
  const { branch, owner, half, workspace, dir } = pairShippable(pair, "widget");
  const stub = pairStub(branch);
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;

  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "companion");
  assert.equal(json.outcome, "shipped");
  assert.deepEqual(stepsOf(json), ["roadmap-complete", "push", "pr-ready", "companion-pr-ready", "merge-code", "delete-branch", "merge-companion", "companion-delete-branch", "sync", "sync", "teardown"]);
  assert.match(json.actions[0].detail, new RegExp(`committed at ${half.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.match(json.actions[1].detail, /^companion: pushed feature\/widget/);
  assert.equal(json.pr.state, "MERGED");
  assert.equal(json.companionPr.state, "MERGED");
  assert.deepEqual([json.teardown.product.removed, json.teardown.companion.removed, json.teardown.workspace.removed], [true, true, true]);
  assert.deepEqual([json.teardown.branches.product.action, json.teardown.branches.companion.action], ["deleted", "deleted"]);

  // Order: code merged from the product checkout before the companion merged from inside its clone.
  const merges = stub.calls().filter((c) => / pr merge /.test(c));
  assert.deepEqual(merges, [`${repo} pr merge 15 --merge`, `${docs} pr merge 7 --merge`]);
  const readies = stub.calls().filter((c) => / pr ready /.test(c));
  assert.deepEqual(readies, [`${repo} pr ready 15`, `${docs} pr ready 7`]);
  assert.ok(stub.calls().some((c) => c.startsWith(`${docs} pr view 7 --repo acme/project-docs --json statusCheckRollup,mergeStateStatus --jq `)), "the companion wait names its repository");

  // Both defaults carry the delivery, both remote branches are gone, both clones are on their default and clean.
  assert.equal(git(repo, "show", "origin/main:src.js"), "code");
  assert.match(git(docs, "show", `origin/main:${dir}/roadmap.md`), /^status: complete$/m);
  assert.equal(git(repo, "ls-tree", "-r", "--name-only", "origin/main", dir), "", "the product receives no roadmap");
  for (const clone of [repo, docs]) {
    assert.throws(() => git(clone, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/feature/widget"), clone);
    assert.equal(git(clone, "branch", "--show-current"), "main", clone);
    assert.equal(git(clone, "rev-parse", "HEAD"), git(clone, "rev-parse", "origin/main"), clone);
    assert.equal(git(clone, "status", "--porcelain"), "", clone);
    assert.equal(worktreeCount(clone), 1, clone);
    assert.throws(() => git(clone, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"), clone);
  }
  assert.equal(fs.existsSync(owner), false);
  assert.equal(fs.existsSync(half), false);
  assert.equal(fs.existsSync(workspace), false);
  assert.deepEqual(fs.readdirSync(wt), []);
  assert.deepEqual(fs.readdirSync(docsWt), []);
});

test("ship resumes a half-shipped pair at the companion merge, and a failed companion merge reports the exact resumable sentence", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { branch, owner, half } = pairShippable(pair, "widget");
  // Simulate the code merge having landed: origin/main carries the branch, the remote branch is gone.
  landBranch(repo, branch, { syncMain: false });
  const mergeSha = git(repo, "rev-parse", "origin/main");
  const failing = pairStub(branch, { state: "MERGED", isDraft: false, mergeCommit: mergeSha }, { rollups: [[{ name: "Docs", status: "COMPLETED", conclusion: "FAILURE" }]] });
  const failed = shipRun(repo, failing.env, "feature", "widget", "--wait", "0");
  assert.equal(failed.code, 3, JSON.stringify(failed.json));
  assert.equal(failed.json.status, "failed");
  assert.equal(failed.json.reason, "companion-merge");
  assert.equal(failed.json.resumedAt, "merge-companion");
  assert.equal(failed.json.phase, "merge-companion");
  assert.equal(failed.json.message, "code PR #15 merged, companion PR #7 open at https://example.test/companion/pull/7; re-send /agento ship widget to resume at the companion merge");
  assert.deepEqual(stepsOf(failed.json), ["companion-pr-ready"]);
  assert.ok(failing.calls().every((c) => !/ pr merge /.test(c)));
  assert.ok(fs.existsSync(owner) && fs.existsSync(half), "nothing torn down");

  const passing = pairStub(branch, { state: "MERGED", isDraft: false, mergeCommit: mergeSha }, { isDraft: false });
  const resumed = shipRun(repo, passing.env, "feature", "widget", "--wait", "0");
  assert.equal(resumed.code, 0, JSON.stringify(resumed.json));
  assert.equal(resumed.json.resumedAt, "merge-companion");
  assert.equal(resumed.json.outcome, "shipped");
  assert.equal(resumed.json.mergeSha, mergeSha);
  assert.deepEqual(stepsOf(resumed.json), ["merge-companion", "companion-delete-branch", "sync", "sync", "teardown"]);
  assert.deepEqual(passing.calls().filter((c) => / pr (merge|ready) /.test(c)), [`${docs} pr merge 7 --merge`]);
  assert.equal(fs.existsSync(owner), false);
  assert.equal(fs.existsSync(half), false);
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
});

test("ship --confirm (companion, no owner): the companion clone is switched onto the mirrored branch for the roadmap commit and back; both local branches are deleted after the merge", () => {
  const pair = makePairRepo();
  const { repo, docs, wt, docsWt } = pair;
  const { branch, dir } = pairShippable(pair, "widget", { owner: false });
  const stub = pairStub(branch);
  const token = shipRun(repo, stub.env, "feature", "widget").json.confirmToken;
  const { code, json } = shipRun(repo, stub.env, "feature", "widget", "--confirm", token, "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "shipped");
  assert.equal(json.teardown, null);
  assert.deepEqual(stepsOf(json), ["roadmap-complete", "push", "pr-ready", "companion-pr-ready", "merge-code", "delete-branch", "merge-companion", "companion-delete-branch", "sync", "sync", "delete-local-branch", "delete-local-branch"]);
  assert.match(git(docs, "show", `origin/main:${dir}/roadmap.md`), /^status: complete$/m);
  for (const clone of [repo, docs]) {
    assert.equal(git(clone, "branch", "--show-current"), "main", clone);
    assert.equal(git(clone, "status", "--porcelain"), "", clone);
    assert.throws(() => git(clone, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"), clone);
  }
  assert.deepEqual(fs.readdirSync(wt), []);
  assert.deepEqual(fs.readdirSync(docsWt), []);
});

test("ship sync and done: merged deliveries with a default behind origin are fast-forwarded and reported already-shipped, and re-sends never merge, push, or open a PR again", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { branch } = pairShippable(pair, "widget", { owner: false });
  landBranch(repo, `origin/${branch}`, { syncMain: false, remote: branch });
  landBranch(docs, `origin/${branch}`, { syncMain: false, remote: branch });
  const stub = pairStub(branch, { state: "MERGED", isDraft: false, mergeCommit: git(repo, "rev-parse", "origin/main") }, { state: "MERGED", isDraft: false });
  const first = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(first.status, "ok", JSON.stringify(first));
  assert.equal(first.resumedAt, "sync");
  assert.equal(first.phase, "done");
  assert.equal(first.outcome, "already-shipped");
  assert.deepEqual(stepsOf(first), ["sync", "sync"]);
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));

  stub.reset();
  const second = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(second.resumedAt, "done");
  assert.equal(second.outcome, "already-shipped");
  assert.deepEqual(second.actions, []);
  assert.ok(stub.calls().every((c) => /(--version|auth status| pr view | repo view )/.test(c)), stub.calls().join("\n"));

  // In-repo: the same sync-only report.
  const fixture = makeWorktreeRepo();
  const inRepo = shippable(fixture, "solo", { owner: false });
  landBranch(fixture.repo, `origin/${inRepo.branch}`, { syncMain: false, remote: inRepo.branch });
  const solo = shipRun(fixture.repo, shipStub({ product: { prs: { [inRepo.branch]: { state: "MERGED", isDraft: false } } } }).env, "feature", "solo").json;
  assert.equal(solo.outcome, "already-shipped", JSON.stringify(solo));
  assert.deepEqual(stepsOf(solo), ["sync"]);
  assert.equal(git(fixture.repo, "rev-parse", "HEAD"), git(fixture.repo, "rev-parse", "origin/main"));
});

// A merged in-repo delivery (owner still present) in a repository with checks.releaseWorkflow.
function releasedFixture() {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, checks: { releaseWorkflow: "release.yml" } }));
  git(repo, "commit", "-qam", "release workflow");
  git(repo, "push", "-q", "origin", "main");
  const delivery = shippable(fixture, "widget");
  landBranch(repo, delivery.branch);
  const mergeSha = git(repo, "rev-parse", "origin/main");
  const stubFor = (api, runs = []) => shipStub({ product: { prs: { [delivery.branch]: { state: "MERGED", isDraft: false, mergeCommit: mergeSha } } }, api, runs });
  return { ...fixture, ...delivery, mergeSha, stubFor };
}

test("ship release phase: success advances to teardown; pending is exit 2 with the owner intact; failed and no-run stop; gh auth failures name the re-login", () => {
  const success = releasedFixture();
  const ok = shipRun(success.repo, success.stubFor(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(101)] } })).env, "feature", "widget", "--wait", "0");
  assert.equal(ok.code, 0, JSON.stringify(ok.json));
  assert.equal(ok.json.resumedAt, "release");
  assert.equal(ok.json.outcome, "shipped");
  assert.deepEqual(stepsOf(ok.json), ["release", "teardown"]);
  assert.equal(ok.json.release.verdict, "success");
  assert.equal(ok.json.release.workflow, "release.yml");
  assert.equal(ok.json.release.run.url, "https://github.test/runs/101");
  assert.equal(ok.json.release.dispatched, false);
  assert.equal(fs.existsSync(success.owner), false);

  const pending = releasedFixture();
  const inProgress = { workflow_runs: [releaseRun(102, { status: "in_progress", conclusion: null })] };
  const stub = pending.stubFor(releaseRoutes({ [`${RUNS}?head_sha=`]: [inProgress, { workflow_runs: [releaseRun(102)] }] }));
  const first = shipRun(pending.repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(first.code, 2, JSON.stringify(first.json));
  assert.equal(first.json.status, "pending");
  assert.equal(first.json.phase, "release");
  assert.equal(first.json.release.verdict, "pending");
  assert.deepEqual(first.json.next, ["/agento ship widget"]);
  assert.ok(fs.existsSync(pending.owner), "the owner stays until the release lands");
  const second = shipRun(pending.repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(second.json.release.verdict, "success");
  assert.equal(fs.existsSync(pending.owner), false);

  const failing = releasedFixture();
  const failed = shipRun(failing.repo, failing.stubFor(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(103, { conclusion: "failure" })] } })).env, "feature", "widget", "--wait", "0");
  assert.equal(failed.code, 3);
  assert.equal(failed.json.status, "failed");
  assert.equal(failed.json.reason, "release-failed");
  assert.match(failed.json.message, /https:\/\/github\.test\/runs\/103/);
  assert.ok(fs.existsSync(failing.owner));
  const noRun = shipRun(failing.repo, failing.stubFor(releaseRoutes()).env, "feature", "widget", "--wait", "0");
  assert.equal(noRun.json.reason, "release-no-run");

  const auth = shipRun(failing.repo, failing.stubFor(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: { __stderr: "gh: Bad credentials (HTTP 401)" } })).env, "feature", "widget", "--wait", "0");
  assert.equal(auth.json.status, "failed");
  assert.equal(auth.json.reason, "gh-auth");
  assert.equal(auth.json.reauth, "gh auth login");

  // superseded-success and not-triggered advance like success.
  const superseded = releasedFixture();
  const sup = shipRun(superseded.repo, superseded.stubFor(releaseRoutes({
    [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(104, { conclusion: "cancelled" })] },
    [`${RUNS}?branch=`]: { workflow_runs: [releaseRun(105, { head_sha: LATER, created_at: "2026-10-07T10:05:00Z" })] },
    [`repos/{owner}/{repo}/compare/${MERGE}...${LATER}`]: { status: "ahead" },
  })).env, "feature", "widget", "--wait", "0");
  assert.equal(sup.json.outcome, "shipped", JSON.stringify(sup.json));
  assert.equal(sup.json.release.verdict, "superseded-success");
  assert.equal(sup.json.release.supersededBy.url, "https://github.test/runs/105");
  const docsOnly = releasedFixture();
  const nt = shipRun(docsOnly.repo, docsOnly.stubFor(releaseRoutes({ [`repos/{owner}/{repo}/compare/${PARENT}...`]: { status: "ahead", files: [{ filename: "docs/a.md" }] } })).env, "feature", "widget", "--wait", "0");
  assert.equal(nt.json.release.verdict, "not-triggered", JSON.stringify(nt.json));
  assert.equal(nt.json.outcome, "shipped");
});

test("ship release phase: dispatch-required dispatches exactly once across re-sends, follows the run it created, and advances when it succeeds", () => {
  const fx = releasedFixture();
  const stub = fx.stubFor(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  workflow_dispatch:\n") }));
  const dispatched = shipRun(fx.repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(dispatched.code, 2, JSON.stringify(dispatched.json));
  assert.equal(dispatched.json.phase, "release");
  assert.equal(dispatched.json.release.dispatched, true);
  assert.deepEqual(stepsOf(dispatched.json), ["release-dispatch"]);
  assert.deepEqual(stub.calls().filter((c) => / workflow run /.test(c)), [`${fx.repo} workflow run release.yml --ref main`]);
  assert.ok(stub.calls().some((c) => / run list --workflow release\.yml --event workflow_dispatch --json databaseId,createdAt,url,status,conclusion/.test(c)));

  const following = shipRun(fx.repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(following.code, 2, JSON.stringify(following.json));
  assert.equal(following.json.release.dispatched, false);
  assert.equal(following.json.release.run.id, 900);
  assert.deepEqual(following.json.actions, []);
  assert.equal(stub.calls().filter((c) => / workflow run /.test(c)).length, 1, "never a second dispatch");
  assert.ok(stub.calls().some((c) => / run view 900 --json status,conclusion,url --jq /.test(c)), "the created run is followed");
  assert.ok(fs.existsSync(fx.owner));

  stub.update((s) => Object.assign(s.runs[0], { status: "completed", conclusion: "success" }));
  const landed = shipRun(fx.repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(landed.code, 0, JSON.stringify(landed.json));
  assert.equal(landed.json.release.verdict, "success");
  assert.equal(landed.json.release.run.url, "https://example.test/runs/900");
  assert.deepEqual(stepsOf(landed.json), ["release", "teardown"]);
  assert.equal(stub.calls().filter((c) => / workflow run /.test(c)).length, 1);
  assert.equal(fs.existsSync(fx.owner), false);

  // A failed dispatch run stops.
  const broken = releasedFixture();
  const brokenStub = broken.stubFor(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  workflow_dispatch:\n") }), [{ id: 901, createdAt: new Date().toISOString(), url: "https://example.test/runs/901", status: "completed", conclusion: "failure" }]);
  const stopped = shipRun(broken.repo, brokenStub.env, "feature", "widget", "--wait", "0");
  assert.equal(stopped.json.status, "failed");
  assert.equal(stopped.json.reason, "release-failed");
  assert.ok(brokenStub.calls().every((c) => !/ workflow run /.test(c)), "a run created after the merge is never re-dispatched");
});

// A merged companion-mode delivery whose owner pair is still present (both defaults synced).
function mergedPair() {
  const pair = makePairRepo();
  const delivery = pairShippable(pair, "widget");
  landBranch(pair.repo, delivery.branch);
  landBranch(pair.docs, delivery.branch);
  const stub = pairStub(delivery.branch, { state: "MERGED", isDraft: false, mergeCommit: git(pair.repo, "rev-parse", "origin/main") }, { state: "MERGED", isDraft: false });
  return { ...pair, ...delivery, stub };
}

test("ship teardown: a live process inside a half blocks with paused-teardown and the flagged path, changes nothing, and the re-send resumes once it leaves", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const fx = mergedPair();
  const { repo, docs, owner, half, workspace, stub } = fx;
  const child = spawn("sleep", ["30"], { cwd: half, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const before = [cloneState(repo, docs), fs.readFileSync(workspace, "utf8")];
    const { code, json } = shipRun(repo, stub.env, "feature", "widget");
    assert.equal(code, 3, JSON.stringify(json));
    assert.equal(json.status, "blocked");
    assert.equal(json.reason, "occupied");
    assert.equal(json.phase, "teardown");
    assert.equal(json.resumedAt, "teardown");
    assert.equal(json.outcome, "paused-teardown");
    assert.equal(json.teardown.pausedPath, half);
    assert.deepEqual(json.teardown.occupants, { product: [], companion: [`PID ${child.pid} (sleep)`] });
    assert.equal(json.teardown.product.removed, false);
    assert.equal(json.teardown.companion.removed, false);
    assert.equal(json.teardown.workspace.removed, false);
    assert.match(json.message, new RegExp(`^paused at teardown \\(worktree ${half.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} still open\\): companion half .*: PID \\d+ \\(sleep\\); close that VS Code window or terminal, then re-send /agento ship widget$`));
    assert.deepEqual(json.next, ["/agento ship widget"]);
    assert.deepEqual(json.actions, []);
    assert.deepEqual([cloneState(repo, docs), fs.readFileSync(workspace, "utf8")], before);
    assert.ok(fs.existsSync(owner) && fs.existsSync(half));
    const again = shipRun(repo, stub.env, "feature", "widget").json;
    assert.equal(again.status, "blocked", "still blocked while the occupant lives");
    assert.deepEqual([cloneState(repo, docs), fs.readFileSync(workspace, "utf8")], before);
  } finally {
    child.kill();
  }
  await new Promise((resolve) => child.once("exit", resolve));
  const resumed = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(resumed.status, "ok", JSON.stringify(resumed));
  assert.equal(resumed.outcome, "shipped");
  assert.deepEqual(stepsOf(resumed), ["teardown"]);
  assert.equal(fs.existsSync(owner), false);
  assert.equal(fs.existsSync(half), false);
  assert.equal(fs.existsSync(workspace), false);
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"));
  assert.throws(() => git(docs, "rev-parse", "--verify", "--quiet", "refs/heads/feature/widget"));
});

test("ship teardown: code --status naming a half as a Folder or a Workspace window blocks with the first flagged half; a half removed earlier is skipped on the re-send", () => {
  const fx = mergedPair();
  const { repo, docs, owner, half, workspace, stub } = fx;
  const before = [cloneState(repo, docs), fs.readFileSync(workspace, "utf8")];
  for (const status of ["|    Folder (feature-widget): 12 files", "|  Window (roadmap.md - feature-widget (Workspace) - Visual Studio Code)"]) {
    fs.writeFileSync(path.join(stub.bin, "code"), `#!/bin/sh\nprintf '%s\\n' '${status}'\n`, { mode: 0o755 });
    const { code, json } = shipRun(repo, stub.env, "feature", "widget");
    assert.equal(code, 3, status);
    assert.equal(json.status, "blocked");
    assert.equal(json.outcome, "paused-teardown");
    assert.equal(json.teardown.pausedPath, owner, "the product half is the first flagged");
    assert.equal(json.teardown.occupants.product.length, 1);
    assert.equal(json.teardown.occupants.companion.length, 1);
    assert.deepEqual([cloneState(repo, docs), fs.readFileSync(workspace, "utf8")], before);
  }
  fs.rmSync(path.join(stub.bin, "code"));
  git(docs, "worktree", "remove", half);
  const resumed = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(resumed.outcome, "shipped", JSON.stringify(resumed));
  assert.equal(resumed.teardown.product.removed, true);
  assert.deepEqual(resumed.teardown.companion, { path: half, branch: null, detached: false, registered: false, onDisk: false, removed: false });
  assert.equal(resumed.teardown.workspace.removed, true);
  assert.equal(resumed.teardown.branches.companion.action, "deleted");
  assert.equal(worktreeCount(repo), 1);
  assert.equal(fs.existsSync(workspace), false);
});

const POST_SHIP = `${DONE_STEPS}- [ ] 2.1 (manual, post-ship) check production — verify: dashboard\n`;
const RISKS = "# Plan\n\n## Risks\n\nThe production check is a post-ship exception the user accepted.\n";

test("ship epilogue (in-repo): post-ship/<slug> is created from the default, pending steps are reported with evidencePresent and never ticked by the CLI, and ticked steps with evidence land through a PR", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, dir } = shippable(fixture, "widget", { owner: false, roadmap: { steps: POST_SHIP, plan: RISKS, header: 'status: complete\nbranch: feature/widget\nlast-updated: 2026-10-10\nnext-step: ""' } });
  landBranch(repo, `origin/${branch}`, { remote: branch });
  const stub = shipStub({ product: { prs: { [branch]: { state: "MERGED", isDraft: false, mergeCommit: git(repo, "rev-parse", "origin/main") } } } });

  const first = shipRun(repo, stub.env, "feature", "widget");
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.equal(first.json.status, "ok");
  assert.equal(first.json.resumedAt, "epilogue");
  assert.equal(first.json.phase, "epilogue");
  assert.equal(first.json.outcome, "post-ship-pending");
  assert.deepEqual(first.json.postShip, { branch: "post-ship/widget", path: repo, steps: [{ id: "2.1", text: "(manual, post-ship) check production — verify: dashboard", ticked: false, evidence: null, evidencePresent: false }], pr: null });
  assert.deepEqual(stepsOf(first.json), ["post-ship-branch"]);
  assert.deepEqual(first.json.next, ["/agento ship widget"]);
  assert.equal(git(repo, "branch", "--show-current"), "post-ship/widget");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.match(fs.readFileSync(path.join(repo, dir, "roadmap.md"), "utf8"), /^- \[ \] 2\.1 \(manual, post-ship\)/m, "the CLI never ticks a post-ship step");

  // Ticked with a link but the file is missing: still pending, nothing committed, no PR.
  const roadmap = path.join(repo, dir, "roadmap.md");
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replace("- [ ] 2.1 (manual, post-ship) check production — verify: dashboard", "- [x] 2.1 (manual, post-ship) check production — verify: dashboard — [evidence](evidence/step-2-1-prod.png) (2026-10-11)"));
  const missing = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(missing.outcome, "post-ship-pending", JSON.stringify(missing));
  assert.deepEqual(missing.postShip.steps[0], { id: "2.1", text: "(manual, post-ship) check production — verify: dashboard — [evidence](evidence/step-2-1-prod.png) (2026-10-11)", ticked: true, evidence: "evidence/step-2-1-prod.png", evidencePresent: false });
  assert.deepEqual(missing.actions, []);
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"), "nothing committed");
  assert.ok(stub.calls().every((c) => !/ pr create/.test(c)));

  // With the evidence file: one commit, push, PR, merge, default synced, branch gone.
  fs.mkdirSync(path.join(repo, dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(repo, dir, "evidence", "step-2-1-prod.png"), "png");
  const landed = shipRun(repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(landed.code, 0, JSON.stringify(landed.json));
  assert.equal(landed.json.outcome, "shipped");
  assert.equal(landed.json.phase, "done");
  assert.deepEqual(stepsOf(landed.json), ["post-ship-commit", "push", "post-ship-pr", "post-ship-merge", "switch", "sync", "post-ship-cleanup"]);
  assert.equal(landed.json.postShip.pr.number, 100);
  assert.equal(landed.json.postShip.pr.state, "MERGED");
  assert.deepEqual(stub.calls().filter((c) => / pr (create|merge) /.test(c)), [`${repo} pr create --base main --head post-ship/widget --title docs(post-ship): widget evidence --body Post-ship evidence for feature/widget: 2.1.`, `${repo} pr merge 100 --merge`]);
  assert.match(git(repo, "show", `origin/main:${dir}/roadmap.md`), /^- \[x\] 2\.1 \(manual, post-ship\).*evidence\/step-2-1-prod\.png/m);
  assert.equal(git(repo, "show", `origin/main:${dir}/evidence/step-2-1-prod.png`), "png");
  assert.match(git(repo, "log", "-1", "--format=%s", "origin/main^2"), /^docs\(post-ship\): widget evidence$/);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/post-ship/widget"));
  assert.throws(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/post-ship/widget"));

  stub.reset();
  const done = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(done.resumedAt, "done");
  assert.equal(done.outcome, "already-shipped");
  assert.ok(stub.calls().every((c) => !/ pr (create|merge)/.test(c)));
});

test("ship epilogue (companion): the post-ship branch, commit, PR, and merge happen in the companion clone; a pending check is exit 2 and the re-send reuses the open PR", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const branch = "feature/widget";
  const dir = "features/2026/10/widget";
  publishBranch(repo, branch, writeFile("src.js", "code\n"));
  publishBranch(docs, branch, shipReady("feature", "widget", { steps: POST_SHIP, plan: RISKS, header: 'status: complete\nbranch: feature/widget\nlast-updated: 2026-10-10\nnext-step: ""' }));
  landBranch(repo, `origin/${branch}`, { remote: branch });
  landBranch(docs, `origin/${branch}`, { remote: branch });
  const stub = shipStub({
    product: { prs: { [branch]: { state: "MERGED", isDraft: false, mergeCommit: git(repo, "rev-parse", "origin/main") } } },
    companion: { prs: { [branch]: { number: 7, state: "MERGED", isDraft: false }, "post-ship/widget": { number: 8, isDraft: false, rollups: [[{ name: "Docs", status: "IN_PROGRESS", conclusion: null }], PASSING[0]] } } },
  });

  const first = shipRun(repo, stub.env, "feature", "widget").json;
  assert.equal(first.outcome, "post-ship-pending", JSON.stringify(first));
  assert.equal(first.postShip.path, docs);
  assert.equal(git(docs, "branch", "--show-current"), "post-ship/widget");
  assert.equal(git(repo, "branch", "--show-current"), "main", "the product never gets a post-ship branch");

  const roadmap = path.join(docs, dir, "roadmap.md");
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replace("- [ ] 2.1 (manual, post-ship) check production — verify: dashboard", "- [x] 2.1 (manual, post-ship) check production — verify: dashboard — [evidence](evidence/step-2-1-prod.png) (2026-10-11)"));
  fs.mkdirSync(path.join(docs, dir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(docs, dir, "evidence", "step-2-1-prod.png"), "png");
  const pending = shipRun(repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(pending.code, 2, JSON.stringify(pending.json));
  assert.equal(pending.json.phase, "epilogue");
  assert.equal(pending.json.postShip.pr.number, 8, "the branch's open PR is reused");
  assert.deepEqual(stepsOf(pending.json), ["post-ship-commit", "push"]);
  assert.ok(stub.calls().every((c) => !/ pr create/.test(c)));
  assert.ok(stub.calls().some((c) => c.startsWith(`${docs} pr view 8 --repo acme/project-docs --json statusCheckRollup`)));
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/post-ship/widget"));

  const landed = shipRun(repo, stub.env, "feature", "widget", "--wait", "0");
  assert.equal(landed.code, 0, JSON.stringify(landed.json));
  assert.equal(landed.json.outcome, "shipped");
  assert.deepEqual(stepsOf(landed.json), ["post-ship-merge", "switch", "sync", "post-ship-cleanup"]);
  assert.deepEqual(stub.calls().filter((c) => / pr merge /.test(c)), [`${docs} pr merge 8 --merge`]);
  assert.match(git(docs, "show", `origin/main:${dir}/roadmap.md`), /^- \[x\] 2\.1 \(manual, post-ship\)/m);
  assert.equal(git(docs, "branch", "--show-current"), "main");
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
  assert.throws(() => git(docs, "rev-parse", "--verify", "--quiet", "refs/heads/post-ship/widget"));
  assert.equal(git(repo, "ls-tree", "-r", "--name-only", "origin/main", dir), "", "the product receives no post-ship commit");
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

// --- sync and step-commit ----------------------------------------------------------

// Commit `file` = `text` on <branch> through a throwaway clone of `work`'s origin and push it.
function advanceRemote(work, branch, file, text) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agento-other-"));
  execFileSync("git", ["clone", "-q", "--branch", branch, git(work, "remote", "get-url", "origin"), tmp]);
  git(tmp, "config", "user.email", "other@example.com");
  git(tmp, "config", "user.name", "Other");
  fs.writeFileSync(path.join(tmp, file), text);
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", `other: ${file}`);
  git(tmp, "push", "-q", "origin", branch);
}

const syncRun = (cwd, env = baseEnv) => runWith({ cwd, env }, "sync", "feature", "widget");
const remoteHead = (dir, branch) => git(dir, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
const parentsOf = (dir, rev = "HEAD") => git(dir, "log", "-1", "--format=%P", rev).split(" ").filter(Boolean);

test("sync and step-commit are listed in the usage header and validate their arguments", () => {
  const { repo } = makeWorktreeRepo();
  const usage = run(repo).json.usage.join("\n");
  assert.match(usage, /sync <feature\|issue> <slug> /);
  assert.match(usage, /step-commit <feature\|issue> <slug> \[--step N\.M\] --message-file <file\|->/);
  for (const args of [["sync"], ["sync", "feature"], ["sync", "chore", "x"], ["sync", "feature", "widget", "extra"], ["step-commit", "feature", "widget"], ["step-commit", "feature", "widget", "--step", "1", "--message-file", "-"], ["step-commit", "feature", "widget", "--message-file"]]) {
    const { code, json } = run(repo, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
});

test("sync (companion) merges an advanced origin/main into both halves with merge commits and pushes product first; a re-send is a no-op", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { branch, owner, half } = pairDelivery(pair, "widget", { status: "in-progress" });
  advanceRemote(repo, "main", "main.txt", "product main\n");
  advanceRemote(docs, "main", "main.md", "docs main\n");

  const { code, json } = syncRun(owner);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "companion");
  assert.equal(json.merged, true);
  assert.deepEqual(json.halves.product.merged, ["origin/main"]);
  assert.deepEqual(json.halves.companion.merged, ["origin/main"]);
  assert.deepEqual(json.pushed, ["product", "companion"]);
  assert.deepEqual(json.actions.map((a) => a.step), ["integrate", "integrate", "push", "push"]);
  for (const dir of [owner, half]) {
    assert.equal(parentsOf(dir).length, 2, `a merge commit, never a rebase, at ${dir}`);
    assert.equal(remoteHead(dir, branch), git(dir, "rev-parse", "HEAD"));
    assert.equal(git(dir, "status", "--porcelain"), "");
  }
  assert.ok(fs.existsSync(path.join(owner, "main.txt")) && fs.existsSync(path.join(half, "main.md")));

  const again = syncRun(owner);
  assert.equal(again.code, 0);
  assert.equal(again.json.merged, false);
  assert.equal(again.json.outcome, "up-to-date");
  assert.deepEqual(again.json.actions, []);
});

test("sync (companion) merges a remote-ahead origin/<branch> into the half", () => {
  const pair = makePairRepo();
  const { docs } = pair;
  const { branch, owner, half } = pairDelivery(pair, "widget", { status: "in-progress" });
  advanceRemote(docs, branch, "note.md", "from another machine\n");
  const { code, json } = syncRun(owner);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.halves.companion.merged, [`origin/${branch}`]);
  assert.deepEqual(json.halves.product.merged, []);
  assert.equal(json.merged, true);
  assert.ok(fs.existsSync(path.join(half, "note.md")));
  assert.equal(git(half, "rev-parse", "HEAD"), remoteHead(half, branch));
});

test("sync (in-repo) aborts a conflicting default merge with the conflicted files, a clean tree, and nothing pushed", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner } = inRepoDelivery(fixture, "widget", { status: "in-progress", write: writeFile("shared.txt", "branch\n") });
  advanceRemote(repo, "main", "shared.txt", "main\n");
  const before = remoteHead(owner, branch);
  const head = git(owner, "rev-parse", "HEAD");
  const { code, json } = syncRun(owner);
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "rejected");
  assert.equal(json.reason, "integration-conflict");
  assert.equal(json.half, "product");
  assert.equal(json.ref, "origin/main");
  assert.deepEqual(json.conflicts, ["shared.txt"]);
  assert.match(json.message, /aborted and the tree is clean again; nothing was pushed/);
  assert.equal(git(owner, "status", "--porcelain"), "");
  assert.equal(git(owner, "rev-parse", "HEAD"), head);
  assert.equal(remoteHead(owner, branch), before);
});

test("sync rejects from the primary, from a plan window, and with a dirty half, writing nothing", () => {
  const pair = makePairRepo();
  const { repo, docs, wt } = pair;
  const { owner, half, dir } = pairDelivery(pair, "widget", { status: "in-progress" });
  advanceRemote(repo, "main", "main.txt", "x\n");
  const before = refState(repo, docs);

  const primary = syncRun(repo);
  assert.equal(primary.code, 3);
  assert.match(primary.json.reason, /^wrong window: role=primary /);
  assert.deepEqual(primary.json.allowed, run(repo, "session").json.allowed);

  const plan = path.join(wt, "plan-20260101-000000");
  git(repo, "worktree", "add", "-q", "--detach", plan);
  const planned = syncRun(plan);
  assert.equal(planned.code, 3);
  assert.match(planned.json.reason, /^wrong window: role=plan /);

  fs.appendFileSync(path.join(half, dir, "roadmap.md"), "\nedited\n");
  const dirty = syncRun(owner);
  assert.equal(dirty.code, 3);
  assert.equal(dirty.json.reason, "dirty");
  assert.equal(dirty.json.half, "companion");
  assert.deepEqual(dirty.json.paths, [`${dir}/roadmap.md`]);
  assert.deepEqual(dirty.json.actions, []);
  git(repo, "worktree", "remove", "--force", plan);
  assert.deepEqual(refState(repo, docs), before);
});

function stepCommitRun(cwd, env, message, ...args) {
  const result = spawnSync("node", [cli, "step-commit", "feature", "widget", ...args, ...(args.includes("--message-file") ? [] : ["--message-file", "-"])], { cwd, encoding: "utf8", env, input: message });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(`non-JSON output: ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
}

const tick = (dir, rel, id) => {
  const file = path.join(dir, rel, "roadmap.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`- [ ] ${id} `, `- [x] ${id} `));
};
const setNextStep = (dir, rel, value) => {
  const file = path.join(dir, rel, "roadmap.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^next-step: .*$/m, `next-step: "${value}"`));
};
const cleanAndPushed = (dir, branch) => {
  assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "", `clean at ${dir}`);
  assert.equal(git(dir, "rev-parse", "HEAD"), remoteHead(dir, branch), `pushed from ${dir}`);
};

test("step-commit (companion): product commit and push precede the companion tick; missing draft PRs, the cross-link, and artifact-pr: are created once", () => {
  const pair = makePairRepo();
  const { branch, owner, half, dir } = pairDelivery(pair, "widget", { status: "in-progress" });
  const stub = shipStub();
  fs.writeFileSync(path.join(owner, "src.js"), "code\n");
  tick(half, dir, "1.2");

  const { code, json } = stepCommitRun(owner, stub.env, "feat(widget): add src (step 1.2)\n", "--step", "1.2");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "committed");
  assert.deepEqual(json.actions.map((a) => a.step), ["commit", "commit", "push", "push", "pr-create", "companion-pr-create", "pr-cross-link", "commit", "push"]);
  assert.match(json.actions[0].detail, /^product: [0-9a-f]{7} feat\(widget\): add src \(step 1\.2\) \(src\.js\)$/);
  assert.match(json.actions[1].detail, new RegExp(`^companion: [0-9a-f]{7} feat\\(widget\\): add src \\(step 1\\.2\\) \\(${dir}/roadmap\\.md\\)$`));
  assert.match(json.actions[2].detail, /^product: pushed/);
  assert.match(json.actions[3].detail, /^companion: pushed/);
  assert.equal(git(owner, "log", "-1", "--format=%s", "HEAD"), "feat(widget): add src (step 1.2)");
  assert.equal(git(half, "log", "-1", "--format=%s", "HEAD"), "docs(feature): record artifact PR for widget");
  assert.equal(git(half, "log", "-1", "--format=%s", "HEAD~1"), "feat(widget): add src (step 1.2)");
  const state = stub.state();
  assert.equal(state.product.prs[branch].isDraft, true);
  assert.equal(state.product.prs[branch].title, "widget");
  assert.equal(state.companion.prs[branch].title, "docs(feature): widget");
  assert.match(state.product.prs[branch].body, new RegExp(`^Plan: .*/blob/${branch}/${dir}/plan\\.md\\n\\nCompanion PR: ${state.companion.prs[branch].url}$`));
  const roadmap = fs.readFileSync(path.join(half, dir, "roadmap.md"), "utf8");
  assert.match(roadmap, /- \[x\] 1\.2 /);
  assert.equal(roadmap.match(/^artifact-pr: "#\d+"$/gm).length, 1);
  assert.equal(json.pr.number, state.product.prs[branch].number);
  assert.equal(json.companionPr.number, state.companion.prs[branch].number);
  cleanAndPushed(owner, branch);
  cleanAndPushed(half, branch);

  // Re-send with nothing to do: already-pushed, no second PR or header.
  stub.reset();
  const again = stepCommitRun(owner, stub.env, "feat(widget): add src (step 1.2)\n", "--step", "1.2");
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.outcome, "already-pushed");
  assert.deepEqual(again.json.actions, []);
  assert.ok(stub.calls().every((c) => !/ pr create| api /.test(c)), stub.calls().join("\n"));

  // A no-code step is one companion commit.
  setNextStep(half, dir, "1.3 next");
  const docsOnly = stepCommitRun(owner, stub.env, "docs(feature): session break for widget\n");
  assert.equal(docsOnly.code, 0, JSON.stringify(docsOnly.json));
  assert.equal(docsOnly.json.commits.product, null);
  assert.equal(docsOnly.json.commits.companion, git(half, "rev-parse", "HEAD"));
  assert.deepEqual(docsOnly.json.pushed, ["companion"]);
  cleanAndPushed(owner, branch);
  cleanAndPushed(half, branch);
});

test("step-commit (in-repo): one commit carries the code and the roadmap tick; Fixes-free body for a feature; an existing PR is reused", () => {
  const fixture = makeWorktreeRepo();
  const { branch, owner, dir } = inRepoDelivery(fixture, "widget", { status: "in-progress" });
  const stub = shipStub({ product: { prs: { [branch]: { number: 15 } } } });
  fs.writeFileSync(path.join(owner, "src.js"), "code\n");
  tick(owner, dir, "1.2");
  const messageFile = path.join(os.tmpdir(), `agento-msg-${process.pid}.txt`);
  fs.writeFileSync(messageFile, "feat(widget): add src (step 1.2)\n\nBody line.\n");
  const { code, json } = stepCommitRun(owner, stub.env, "", "--step", "1.2", "--message-file", messageFile);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "in-repo");
  assert.deepEqual(json.actions.map((a) => a.step), ["commit", "push"]);
  assert.deepEqual(git(owner, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [`${dir}/roadmap.md`, "src.js"]);
  assert.equal(git(owner, "log", "-1", "--format=%B").trim(), "feat(widget): add src (step 1.2)\n\nBody line.");
  assert.equal(json.pr.number, 15);
  assert.equal(json.companionPr, null);
  assert.ok(stub.calls().every((c) => !/ pr create/.test(c)));
  cleanAndPushed(owner, branch);
  fs.rmSync(messageFile);
});

test("step-commit stops with reverify (exit 2, nothing pushed) when origin/main merged, and the re-send pushes; a conflicting default aborts with its files", () => {
  const fixture = makeWorktreeRepo();
  const { repo } = fixture;
  const { branch, owner, dir } = inRepoDelivery(fixture, "widget", { status: "in-progress", write: writeFile("shared.txt", "branch\n") });
  const stub = shipStub({ product: { prs: { [branch]: { number: 15 } } } });
  advanceRemote(repo, "main", "other.txt", "main\n");
  const before = remoteHead(owner, branch);
  fs.writeFileSync(path.join(owner, "src.js"), "code\n");
  tick(owner, dir, "1.2");
  const first = stepCommitRun(owner, stub.env, "feat(widget): add src (step 1.2)", "--step", "1.2");
  assert.equal(first.code, 2, JSON.stringify(first.json));
  assert.equal(first.json.status, "reverify");
  assert.deepEqual(first.json.integrated, [{ half: "product", ref: "origin/main", kind: "default" }]);
  assert.equal(remoteHead(owner, branch), before, "nothing pushed before the re-verify");
  assert.equal(parentsOf(owner).length, 2);

  const resend = stepCommitRun(owner, stub.env, "feat(widget): add src (step 1.2)", "--step", "1.2");
  assert.equal(resend.code, 0, JSON.stringify(resend.json));
  assert.equal(resend.json.outcome, "pushed");
  cleanAndPushed(owner, branch);

  advanceRemote(repo, "main", "shared.txt", "main\n");
  setNextStep(owner, dir, "1.3 next");
  const pushed = remoteHead(owner, branch);
  const conflict = stepCommitRun(owner, stub.env, "docs(feature): next step");
  assert.equal(conflict.code, 3, JSON.stringify(conflict.json));
  assert.equal(conflict.json.reason, "integration-conflict");
  assert.deepEqual(conflict.json.conflicts, ["shared.txt"]);
  assert.equal(git(owner, "status", "--porcelain"), "");
  assert.equal(remoteHead(owner, branch), pushed, "nothing pushed on a conflict");
});

test("step-commit guard equivalence: every rejection leaves both halves unchanged", () => {
  const pair = makePairRepo();
  const { repo, docs, wt } = pair;
  const { owner, half, dir } = pairDelivery(pair, "widget", { status: "in-progress", writeCompanion: writeFile("features/2026/10/other/plan.md", "other\n") });
  const stub = shipStub();
  const snapshot = () => [refState(repo, docs), git(owner, "status", "--porcelain", "--untracked-files=all"), git(half, "status", "--porcelain", "--untracked-files=all")];
  const rejects = (cwd, message, args, reason, prepare = null, undo = null) => {
    prepare?.();
    const before = snapshot();
    const { code, json } = stepCommitRun(cwd, stub.env, message, ...args);
    assert.equal(code, 3, `${reason}: ${JSON.stringify(json)}`);
    assert.equal(json.status, "rejected", reason);
    if (reason instanceof RegExp) assert.match(json.reason, reason);
    else assert.equal(json.reason, reason);
    assert.deepEqual(json.actions, [], reason);
    assert.deepEqual(snapshot(), before, `${reason}: nothing written`);
    undo?.();
    return json;
  };
  const ok = "feat(widget): add src (step 1.2)";
  fs.writeFileSync(path.join(owner, "src.js"), "code\n");

  // The default branch is the primary's; a plan window is not the slug's build window.
  rejects(repo, ok, ["--step", "1.2"], /^wrong window: role=primary /);
  const plan = path.join(wt, "plan-20260101-000000");
  git(repo, "worktree", "add", "-q", "--detach", plan);
  rejects(plan, ok, ["--step", "1.2"], /^wrong window: role=plan /);
  git(repo, "worktree", "remove", "--force", plan);
  rejects(owner, ok, ["--step", "1.2"], "detached-head", () => git(half, "switch", "-q", "--detach"), () => git(half, "switch", "-q", "feature/widget"));
  // The half on the default branch still holding the slug's roadmap (staged from the branch).
  const toDefault = () => {
    git(half, "checkout", "-q", "--ignore-other-worktrees", "main");
    git(half, "checkout", "-q", "feature/widget", "--", dir);
  };
  const onDefault = rejects(owner, ok, ["--step", "1.2"], "default-branch", toDefault, () => git(half, "checkout", "-q", "-f", "feature/widget"));
  assert.match(onDefault.message, /the companion half .* is on main; never commit or push to the default branch/);
  const mismatch = rejects(owner, ok, ["--step", "1.2"], "branch-mismatch", () => git(half, "switch", "-q", "-c", "feature/elsewhere"), () => {
    git(half, "switch", "-q", "feature/widget");
    git(half, "branch", "-q", "-D", "feature/elsewhere");
  });
  assert.match(mismatch.message, /the companion half .* is on feature\/elsewhere, but the roadmap names feature\/widget/);

  // Unticked step, no roadmap change, messages, and companion byproducts.
  rejects(owner, ok, ["--step", "1.2"], "step-not-ticked");
  rejects(owner, ok, [], "roadmap-not-updated");
  tick(half, dir, "1.2");
  rejects(owner, "added src for 1.2", ["--step", "1.2"], "message-not-conventional");
  rejects(owner, "feat(widget): add src", ["--step", "1.2"], "message-missing-step");
  rejects(owner, "feat(widget): add src (step 1.1)", ["--step", "1.1"], "step-not-ticked");
  const inside = path.join(half, "message.txt");
  rejects(owner, "", ["--step", "1.2", "--message-file", inside], "message-file-inside-half", () => fs.writeFileSync(inside, ok), () => fs.rmSync(inside));
  const stray = path.join(half, "stray.log");
  const json = rejects(owner, ok, ["--step", "1.2"], "companion-outside-slug", () => fs.writeFileSync(stray, "x"), () => fs.rmSync(stray));
  assert.deepEqual(json.paths, ["stray.log"]);
  // A staged rename from outside into the slug directory: status -z shows only the destination.
  const origin = "features/2026/10/other/plan.md";
  const renamed = rejects(owner, ok, ["--step", "1.2"], "companion-outside-slug", () => git(half, "mv", origin, `${dir}/stolen.md`), () => git(half, "mv", `${dir}/stolen.md`, origin));
  assert.deepEqual(renamed.paths, [origin]);

  // The same state is accepted once the byproduct is gone.
  const accepted = stepCommitRun(owner, stub.env, ok, "--step", "1.2");
  assert.equal(accepted.code, 0, JSON.stringify(accepted.json));
  assert.equal(git(half, "cat-file", "-t", `HEAD:${origin}`), "blob", "the file outside the slug directory is untouched");
});

test("step-commit reports a gh authentication failure with the re-login command after pushing", () => {
  const fixture = makeWorktreeRepo();
  const { branch, owner, dir } = inRepoDelivery(fixture, "widget", { status: "in-progress" });
  const { log, env } = gitLoggingPath({ gh: "#!/bin/sh\necho 'HTTP 401: Bad credentials (https://api.github.com/graphql). Try authenticating with: gh auth login' >&2\nexit 1\n" });
  tick(owner, dir, "1.2");
  const { code, json } = stepCommitRun(owner, env, "docs(feature): tick (step 1.2)", "--step", "1.2");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "failed");
  assert.equal(json.reason, "gh-auth");
  assert.equal(json.reauth, "gh auth login");
  cleanAndPushed(owner, branch);
  // A full refspec on every push, so no branch name can turn into a forced push.
  const pushes = fs.readFileSync(log, "utf8").split("\n").filter((l) => / push /.test(` ${l} `));
  assert.deepEqual(pushes.map((l) => l.replace(/^-C \S+ /, "")), [`push origin refs/heads/${branch}:refs/heads/${branch}`]);
});

// --- plan-publish -------------------------------------------------------------------

// A promoted planning worktree (in-repo) or pair (companion) on <type>/<slug> holding
// unpublished plan.md and roadmap.md in the artifact half.
function planningDelivery({ companion = false, type = "feature", slug = "widget", issue = null } = {}) {
  const fixture = companion ? makePairRepo() : makeWorktreeRepo();
  const id = "20261012-000000";
  const branch = `${type}/${slug}`;
  const product = path.join(fixture.wt, `plan-${id}`);
  git(fixture.repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(product, "switch", "-q", "-c", branch);
  let half = null;
  if (companion) {
    half = path.join(fixture.docsWt, `plan-${id}`);
    git(fixture.docs, "worktree", "add", "-q", "--detach", half, "origin/main");
    git(half, "switch", "-q", "-c", branch);
    fs.writeFileSync(path.join(fixture.wt, `plan-${id}.code-workspace`), "{}\n");
  }
  const dir = `${type === "feature" ? "features" : "issues"}/2026/10/${slug}`;
  const artifactHalf = half ?? product;
  writeRoadmap(artifactHalf, dir, `status: planned\nbranch: ${branch}\nlast-updated: 2026-10-12\nnext-step: "1.1"${issue ? `\ngithub-issue: "#${issue}"` : ""}`);
  fs.writeFileSync(path.join(artifactHalf, dir, "plan.md"), `# ${slug}\n`);
  return { ...fixture, product, half, artifactHalf, branch, dir };
}

const planPublishRun = (cwd, env, type = "feature", slug = "widget") => runWith({ cwd, env }, "plan-publish", type, slug);
const neverReadiesOrMerges = (stub) => assert.ok(stub.calls().every((c) => !/ pr (ready|merge)\b/.test(c)), stub.calls().join("\n"));

test("plan-publish is listed in the usage header and validates its arguments", () => {
  const { repo } = makeWorktreeRepo();
  assert.match(run(repo).json.usage.join("\n"), /plan-publish <feature\|issue> <slug> /);
  for (const args of [["plan-publish"], ["plan-publish", "feature"], ["plan-publish", "chore", "x"], ["plan-publish", "feature", "widget", "extra"]]) {
    const { code, json } = run(repo, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
});

test("plan-publish (companion): the plan commit in the half, one empty product commit, both draft PRs, the cross-link, and artifact-pr:; a re-send creates nothing; an edit is a revise commit", () => {
  const d = planningDelivery({ companion: true });
  const stub = shipStub();
  const { code, json } = planPublishRun(d.product, stub.env);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "companion");
  assert.equal(json.outcome, "committed");
  assert.deepEqual(json.actions.map((a) => a.step), ["commit", "commit", "push", "push", "pr-create", "companion-pr-create", "pr-cross-link", "commit", "push"]);
  assert.match(json.actions[0].detail, /^companion: [0-9a-f]{7} docs\(feature\): plan widget \(/);
  assert.match(json.actions[1].detail, /^product: [0-9a-f]{7} chore\(feature\): open widget$/);
  assert.match(json.actions[2].detail, /^product: pushed/);
  assert.match(json.actions[3].detail, /^companion: pushed/);
  assert.equal(git(d.product, "diff", "--name-only", "HEAD~1", "HEAD"), "", "the product commit is empty");
  assert.equal(git(d.half, "log", "-1", "--format=%s", "HEAD~1"), "docs(feature): plan widget");
  assert.equal(git(d.half, "log", "-1", "--format=%s"), "docs(feature): record artifact PR for widget");
  const state = stub.state();
  assert.equal(state.product.prs[d.branch].isDraft, true);
  assert.equal(state.companion.prs[d.branch].isDraft, true);
  assert.equal(state.companion.prs[d.branch].title, "docs(feature): widget");
  assert.match(state.product.prs[d.branch].body, new RegExp(`^Plan: .*/blob/${d.branch}/${d.dir}/plan\\.md\\n\\nCompanion PR: ${state.companion.prs[d.branch].url}$`));
  assert.equal(fs.readFileSync(path.join(d.half, d.dir, "roadmap.md"), "utf8").match(/^artifact-pr: "#\d+"$/gm).length, 1);
  assert.equal(json.pr.number, state.product.prs[d.branch].number);
  assert.equal(json.companionPr.number, state.companion.prs[d.branch].number);
  cleanAndPushed(d.product, d.branch);
  cleanAndPushed(d.half, d.branch);
  neverReadiesOrMerges(stub);

  stub.reset();
  const heads = [git(d.product, "rev-parse", "HEAD"), git(d.half, "rev-parse", "HEAD")];
  const again = planPublishRun(d.product, stub.env);
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.outcome, "already-published");
  assert.deepEqual(again.json.actions, []);
  assert.deepEqual([git(d.product, "rev-parse", "HEAD"), git(d.half, "rev-parse", "HEAD")], heads);
  assert.ok(stub.calls().every((c) => !/ pr create| api /.test(c)), stub.calls().join("\n"));

  fs.appendFileSync(path.join(d.half, d.dir, "plan.md"), "More detail.\n");
  const revised = planPublishRun(d.product, stub.env);
  assert.equal(revised.code, 0, JSON.stringify(revised.json));
  assert.equal(revised.json.outcome, "committed");
  assert.deepEqual(revised.json.actions.map((a) => a.step), ["commit", "push"]);
  assert.equal(git(d.half, "log", "-1", "--format=%s"), "docs(feature): revise plan widget");
  assert.equal(git(d.product, "rev-parse", "HEAD"), heads[0], "no second empty product commit");
  assert.equal(Object.keys(stub.state().product.prs).length, 1);
  assert.equal(Object.keys(stub.state().companion.prs).length, 1);
  cleanAndPushed(d.half, d.branch);
  neverReadiesOrMerges(stub);
});

test("plan-publish (in-repo): one docs(delivery) commit, the push, and a draft PR whose issue body starts with Fixes #<n>", () => {
  const d = planningDelivery({ type: "issue", slug: "crash", issue: 42 });
  const stub = shipStub();
  const { code, json } = planPublishRun(d.product, stub.env, "issue", "crash");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "in-repo");
  assert.deepEqual(json.actions.map((a) => a.step), ["commit", "push", "pr-create"]);
  assert.equal(git(d.product, "log", "-1", "--format=%s"), "docs(delivery): plan crash");
  assert.deepEqual(git(d.product, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), [`${d.dir}/plan.md`, `${d.dir}/roadmap.md`]);
  const pr = stub.state().product.prs[d.branch];
  assert.equal(pr.isDraft, true);
  assert.equal(pr.title, "crash");
  assert.equal(pr.body, `Fixes #42\n\nPlan: ${d.dir}/plan.md`);
  assert.equal(json.companionPr, null);
  cleanAndPushed(d.product, d.branch);
  neverReadiesOrMerges(stub);
});

test("plan-publish rejections write nothing: wrong window, detached or default-branch half, outside-slug changes, missing plan.md", () => {
  const d = planningDelivery({ companion: true });
  const stub = shipStub();
  const snapshot = () => [refState(d.repo, d.docs), git(d.product, "status", "--porcelain", "--untracked-files=all"), git(d.half, "status", "--porcelain", "--untracked-files=all")];
  const rejects = (cwd, reason, prepare = null, undo = null) => {
    prepare?.();
    const before = snapshot();
    const { code, json } = planPublishRun(cwd, stub.env);
    assert.equal(code, 3, `${reason}: ${JSON.stringify(json)}`);
    assert.equal(json.status, "rejected", String(reason));
    if (reason instanceof RegExp) assert.match(json.reason, reason);
    else assert.equal(json.reason, reason);
    assert.deepEqual(json.actions, [], String(reason));
    assert.deepEqual(snapshot(), before, `${reason}: nothing written`);
    undo?.();
    return json;
  };

  rejects(d.repo, /^wrong window: role=primary /);
  rejects(d.product, "detached-head", () => git(d.half, "switch", "-q", "--detach"), () => git(d.half, "switch", "-q", d.branch));
  rejects(d.product, "default-branch", () => git(d.half, "checkout", "-q", "--ignore-other-worktrees", "main"), () => git(d.half, "checkout", "-q", d.branch));
  const stray = path.join(d.half, "stray.md");
  const strayJson = rejects(d.product, "outside-slug", () => fs.writeFileSync(stray, "x\n"), () => fs.rmSync(stray));
  assert.deepEqual([strayJson.half, strayJson.paths], ["companion", ["stray.md"]]);
  const code = path.join(d.product, "src.js");
  const codeJson = rejects(d.product, "outside-slug", () => fs.writeFileSync(code, "x\n"), () => fs.rmSync(code));
  assert.deepEqual([codeJson.half, codeJson.paths], ["product", ["src.js"]]);
  const plan = path.join(d.half, d.dir, "plan.md");
  const aside = path.join(os.tmpdir(), `agento-plan-${process.pid}.md`);
  rejects(d.product, "artifact-missing", () => fs.renameSync(plan, aside), () => fs.renameSync(aside, plan));
  assert.ok(stub.calls().every((c) => !/ pr create| api /.test(c)), stub.calls().join("\n"));

  const accepted = planPublishRun(d.product, stub.env);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.json));
  neverReadiesOrMerges(stub);
});

// --- review-publish -----------------------------------------------------------------

const reviewPublishRun = (cwd, env, ...args) => runWith({ cwd, env }, "review-publish", "feature", "widget", ...args);
const writeReview = (dir, rel, text) => fs.writeFileSync(path.join(dir, rel, "review.md"), text);
const MARKED = /^Verdict: (approve|request-changes)\n\nReview: .*\/blob\/feature\/widget\/features\/2026\/10\/widget\/review\.md\n\n(?:[\s\S]*\n\n)?<!-- agento:review feature\/widget -->$/;

test("review-publish is listed in the usage header and validates its arguments", () => {
  const { repo } = makeWorktreeRepo();
  assert.match(run(repo).json.usage.join("\n"), /review-publish <feature\|issue> <slug> \[--body-file <file\|->\]/);
  for (const args of [["review-publish"], ["review-publish", "feature"], ["review-publish", "feature", "widget", "extra"], ["review-publish", "feature", "widget", "--body-file"]]) {
    const { code, json } = run(repo, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
});

test("review-publish (companion): one review commit in the half, only the companion default merged, one verdict comment; a re-review edits that same comment", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { branch, owner, half, dir } = pairDelivery(pair, "widget", { status: "in-review" });
  const stub = shipStub({ product: { prs: { [branch]: { number: 15 } } }, companion: { prs: { [branch]: { number: 16 } } } });
  advanceRemote(repo, "main", "main.txt", "product main\n");
  advanceRemote(docs, "main", "docs-main.md", "docs main\n");
  const productHead = git(owner, "rev-parse", "HEAD");
  writeReview(half, dir, "# Review: widget\n\nVerdict: request-changes\n");

  const first = reviewPublishRun(owner, stub.env);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.equal(first.json.verdict, "request-changes");
  assert.deepEqual(first.json.actions.map((a) => a.step), ["commit", "integrate", "push", "comment-post"]);
  assert.deepEqual(first.json.integrated, [{ half: "companion", ref: "origin/main", kind: "default" }]);
  assert.equal(git(half, "log", "-1", "--format=%s", "HEAD^1"), "docs(feature): review widget — request-changes");
  assert.ok(fs.existsSync(path.join(half, "docs-main.md")), "the companion default is merged");
  assert.equal(git(owner, "rev-parse", "HEAD"), productHead, "the reviewed code is not merged with main");
  let comments = stub.state().product.comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue, 15);
  assert.match(comments[0].body, MARKED);
  assert.equal(first.json.comment.action, "posted");
  cleanAndPushed(owner, branch);
  cleanAndPushed(half, branch);
  neverReadiesOrMerges(stub);

  writeReview(half, dir, "# Review: widget\n\nVerdict: approve\n");
  const summary = path.join(os.tmpdir(), `agento-review-summary-${process.pid}.md`);
  fs.writeFileSync(summary, "All acceptance items pass.\n");
  const second = reviewPublishRun(owner, stub.env, "--body-file", summary);
  fs.rmSync(summary);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.deepEqual(second.json.actions.map((a) => a.step), ["commit", "push", "comment-update"]);
  assert.equal(git(half, "log", "-1", "--format=%s"), "docs(feature): review widget — approve");
  comments = stub.state().product.comments;
  assert.equal(comments.filter((c) => c.body.includes("<!-- agento:review feature/widget -->")).length, 1, "never a second comment");
  assert.match(comments[0].body, /^Verdict: approve\n/);
  assert.match(comments[0].body, /\n\nAll acceptance items pass\.\n\n<!-- agento:review/);
  assert.equal(second.json.comment.id, first.json.comment.id);

  stub.reset();
  const third = reviewPublishRun(owner, stub.env, "--body-file", "/dev/null");
  assert.equal(third.code, 0, JSON.stringify(third.json));
  assert.equal(third.json.outcome, "already-published");
  assert.deepEqual(third.json.actions.map((a) => a.step), ["comment-update"], "a changed summary edits the comment again");
  const fourth = reviewPublishRun(owner, stub.env, "--body-file", "/dev/null");
  assert.deepEqual(fourth.json.actions, []);
  assert.equal(fourth.json.comment.action, "unchanged");
  assert.equal(stub.state().product.comments.length, 1);
  cleanAndPushed(half, branch);
});

test("review-publish (in-repo): the review commit is pushed without merging main, and another user's marked comment is left alone", () => {
  const fixture = makeWorktreeRepo();
  const { branch, owner, dir } = inRepoDelivery(fixture, "widget", { status: "in-review" });
  const foreign = { id: 1, issue: 15, user: { login: "someone-else" }, body: "Verdict: approve\n\n<!-- agento:review feature/widget -->" };
  const stub = shipStub({ product: { prs: { [branch]: { number: 15 } }, comments: [foreign] } });
  advanceRemote(fixture.repo, "main", "main.txt", "x\n");
  writeReview(owner, dir, "# Review: widget\n\nVerdict: approve\n");
  const { code, json } = reviewPublishRun(owner, stub.env);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.mode, "in-repo");
  assert.deepEqual(json.actions.map((a) => a.step), ["commit", "push", "comment-post"]);
  assert.equal(git(owner, "log", "-1", "--format=%s"), "docs(feature): review widget — approve");
  assert.ok(!fs.existsSync(path.join(owner, "main.txt")), "the in-repo product half is not merged with main");
  const comments = stub.state().product.comments;
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], foreign);
  assert.match(comments[1].body, MARKED);
  cleanAndPushed(owner, branch);
});

test("review-publish rejections write nothing: missing review, a missing or duplicated Verdict line, the heading, outside-slug changes, pr-missing, wrong window", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const { branch, owner, half, dir } = pairDelivery(pair, "widget", { status: "in-review" });
  const stub = shipStub({ product: { prs: { [branch]: { number: 15 } } } });
  const snapshot = () => [refState(repo, docs), git(owner, "status", "--porcelain", "--untracked-files=all"), git(half, "status", "--porcelain", "--untracked-files=all")];
  const rejects = (cwd, env, reason, prepare = null, undo = null) => {
    prepare?.();
    const before = snapshot();
    const { code, json } = reviewPublishRun(cwd, env);
    assert.equal(code, 3, `${reason}: ${JSON.stringify(json)}`);
    assert.equal(json.status, "rejected", String(reason));
    if (reason instanceof RegExp) assert.match(json.reason, reason);
    else assert.equal(json.reason, reason);
    assert.deepEqual(json.actions, [], String(reason));
    assert.deepEqual(snapshot(), before, `${reason}: nothing written`);
    undo?.();
    return json;
  };
  const review = (text) => () => writeReview(half, dir, text);

  rejects(repo, stub.env, /^wrong window: role=primary /);
  rejects(owner, stub.env, "review-missing");
  rejects(owner, stub.env, "verdict-invalid", review("# Review: widget\n\nNo verdict yet.\n"));
  const twice = rejects(owner, stub.env, "verdict-invalid", review("# Review: widget\n\nVerdict: approve\n\nVerdict: request-changes\n"));
  assert.deepEqual(twice.verdicts, ["approve", "request-changes"]);
  rejects(owner, stub.env, "verdict-invalid", review("# Review: widget\n\nVerdict: maybe\n"));
  rejects(owner, stub.env, "review-heading", review("# Review\n\nVerdict: approve\n"));
  writeReview(half, dir, "# Review: widget\n\nVerdict: approve\n");
  const stray = path.join(half, "stray.md");
  rejects(owner, stub.env, "outside-slug", () => fs.writeFileSync(stray, "x\n"), () => fs.rmSync(stray));
  const code = path.join(owner, "src.js");
  const dirty = rejects(owner, stub.env, "outside-slug", () => fs.writeFileSync(code, "x\n"), () => fs.rmSync(code));
  assert.equal(dirty.half, "product");
  rejects(owner, shipStub().env, "pr-missing");
  assert.ok(stub.calls().every((c) => !/comments/.test(c)), stub.calls().join("\n"));

  const accepted = reviewPublishRun(owner, stub.env);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.json));
  assert.equal(stub.state().product.comments.length, 1);
});

// --- publish-pr ---------------------------------------------------------------------

// A changes branch in `dir` with one commit adding `file`; the checkout stays on it.
function changesBranch(dir, branch = "changes/tidy", file = "tidy.txt", text = "tidy\n") {
  git(dir, "switch", "-q", "-c", branch);
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `chore: add ${file}`);
  return branch;
}

const publishPrRun = (cwd, env, ...args) => runWith({ cwd, env }, "publish-pr", ...args);
const ciCheck = (name, conclusion) => ({ name, status: conclusion ? "COMPLETED" : "IN_PROGRESS", conclusion });
const mergeCalls = (stub) => stub.calls().filter((c) => / pr merge /.test(c)).map((c) => c.replace(/^\S+ /, ""));

test("publish-pr is listed in the usage header and validates its arguments", () => {
  const { repo } = makeWorktreeRepo();
  assert.match(run(repo).json.usage.join("\n"), /publish-pr \[--dir <path>\] \[--branch <name>\] \[--title <text>\] \[--body-file <file\|->\] \[--merge\] \[--wait N\]/);
  for (const args of [["publish-pr", "extra"], ["publish-pr", "--wait", "61"], ["publish-pr", "--dir"], ["publish-pr", "--title"], ["publish-pr", "--branch", "--merge"]]) {
    const { code, json } = run(repo, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error", args.join(" "));
  }
});

test("publish-pr refuses the default branch, a detached HEAD, every delivery prefix, an unknown repo, dirt, an empty branch, and a body file inside the checkout, writing nothing", () => {
  const { repo } = makeWorktreeRepo();
  const stub = shipStub();
  const snapshot = () => [refState(repo), git(repo, "status", "--porcelain", "--untracked-files=all")];
  const refuses = (reason, args = [], prepare = null, undo = null) => {
    prepare?.();
    const before = snapshot();
    const { code, json } = publishPrRun(repo, stub.env, "--merge", ...args);
    assert.equal(code, 3, `${reason}: ${JSON.stringify(json)}`);
    assert.equal(json.status, "rejected", reason);
    assert.equal(json.reason, reason);
    assert.deepEqual(json.actions, [], reason);
    assert.deepEqual(snapshot(), before, `${reason}: nothing written`);
    undo?.();
    return json;
  };

  refuses("default-branch");
  for (const branch of ["feature/x", "issue/x", "post-ship/x"]) {
    const json = refuses("delivery-branch", [], () => git(repo, "switch", "-q", "-c", branch), () => {
      git(repo, "switch", "-q", "main");
      git(repo, "branch", "-q", "-D", branch);
    });
    assert.match(json.message, /merged only by \/agento ship/);
  }
  refuses("detached-head", [], () => git(repo, "switch", "-q", "--detach"), () => git(repo, "switch", "-q", "main"));
  refuses("unknown-repo", ["--dir", makeRepo()]);
  refuses("nothing-to-publish", [], () => git(repo, "switch", "-q", "-c", "changes/empty"), () => {
    git(repo, "switch", "-q", "main");
    git(repo, "branch", "-q", "-D", "changes/empty");
  });
  changesBranch(repo);
  const dirty = refuses("dirty", [], () => fs.writeFileSync(path.join(repo, "tidy.txt"), "edited\n"), () => git(repo, "checkout", "-q", "--", "tidy.txt"));
  assert.deepEqual(dirty.paths, ["tidy.txt"]);
  const inside = path.join(repo, "body.md");
  refuses("body-file-inside-checkout", ["--body-file", inside], () => fs.writeFileSync(inside, "x\n"), () => fs.rmSync(inside));
  assert.ok(stub.calls().every((c) => !/ pr (create|merge)/.test(c)), stub.calls().join("\n"));
});

test("publish-pr without --merge pushes and opens one non-draft PR; a re-send reuses it", () => {
  const { repo } = makeWorktreeRepo();
  const stub = shipStub();
  const branch = changesBranch(repo);
  const bodyFile = path.join(os.tmpdir(), `agento-pr-body-${process.pid}.md`);
  fs.writeFileSync(bodyFile, "Why: tidy.\n");
  const { code, json } = publishPrRun(repo, stub.env, "--title", "chore: tidy the repo", "--body-file", bodyFile);
  fs.rmSync(bodyFile);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "opened");
  assert.deepEqual(json.checkout, { path: repo, repo: "product", linked: false, defaultBranch: "main" });
  assert.deepEqual(json.actions.map((a) => a.step), ["push", "pr-create"]);
  const pr = stub.state().product.prs[branch];
  assert.equal(pr.isDraft, false);
  assert.equal(pr.title, "chore: tidy the repo");
  assert.equal(pr.body, "Why: tidy.\n");
  assert.equal(json.pr.number, pr.number);
  assert.equal(remoteHead(repo, branch), git(repo, "rev-parse", "HEAD"));
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${branch}`);

  const again = publishPrRun(repo, stub.env);
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.outcome, "opened");
  assert.deepEqual(again.json.actions, []);
  assert.equal(Object.keys(stub.state().product.prs).length, 1);
  neverReadiesOrMerges(stub);
});

test("publish-pr --merge: pending (exit 2) names the identical re-send, which merges with --merge only, deletes the remote branch, and syncs the default; --branch resumes after the merge", () => {
  const { repo } = makeWorktreeRepo();
  const branch = changesBranch(repo);
  const stub = shipStub({ product: { prs: { [branch]: { number: 15, isDraft: false, rollups: [[ciCheck("Unit tests", null)], [ciCheck("Unit tests", "SUCCESS")]] } } } });

  const first = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(first.code, 2, JSON.stringify(first.json));
  assert.equal(first.json.status, "pending");
  assert.equal(first.json.phase, "checks");
  assert.deepEqual(first.json.next, ["node <agento-root>/scripts/agento.mjs publish-pr --merge --wait 0"]);
  assert.deepEqual(first.json.actions.map((a) => a.step), ["push"]);
  assert.equal(stub.state().product.prs[branch].state, "OPEN");

  const second = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(second.json.outcome, "merged");
  assert.deepEqual(second.json.actions.map((a) => a.step), ["merge", "delete-branch", "switch", "sync", "delete-local-branch"]);
  assert.deepEqual(mergeCalls(stub), ["pr merge 15 --merge"]);
  assert.equal(git(repo, "branch", "--show-current"), "main");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(second.json.mergeSha, git(repo, "rev-parse", "HEAD"));
  assert.ok(fs.existsSync(path.join(repo, "tidy.txt")));
  assert.equal(git(repo, "branch", "--list", branch), "");
  assert.equal(git(repo, "ls-remote", "--heads", "origin", branch), "");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual(second.json.sync, { switched: true, fastForwarded: true, branchDeleted: true, skipped: null });

  const resumed = publishPrRun(repo, stub.env, "--branch", branch, "--merge");
  assert.equal(resumed.code, 0, JSON.stringify(resumed.json));
  assert.equal(resumed.json.outcome, "already-merged");
  assert.deepEqual(resumed.json.actions, []);
  assert.deepEqual(mergeCalls(stub), ["pr merge 15 --merge"], "a merged PR is never merged again");
});

test("publish-pr --branch resumes an interrupted publish at delete-branch and sync", () => {
  const { repo } = makeWorktreeRepo();
  const branch = changesBranch(repo);
  const stub = shipStub();
  assert.equal(publishPrRun(repo, stub.env).code, 0);
  spawnSync("gh", ["pr", "merge", "100", "--merge"], { cwd: repo, env: stub.env });
  git(repo, "switch", "-q", "main");
  const { code, json } = publishPrRun(repo, stub.env, "--branch", branch, "--merge");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "already-merged");
  assert.deepEqual(json.actions.map((a) => a.step), ["delete-branch", "sync", "delete-local-branch"]);
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
  assert.equal(git(repo, "branch", "--list", branch), "");
  const unmerged = publishPrRun(repo, stub.env, "--branch", "changes/never", "--merge");
  assert.equal(unmerged.code, 3);
  assert.equal(unmerged.json.reason, "default-branch");
});

test("publish-pr --merge stops blocked on a failing check with nothing merged", () => {
  const { repo } = makeWorktreeRepo();
  const branch = changesBranch(repo);
  const stub = shipStub({ product: { prs: { [branch]: { number: 15, isDraft: false, rollups: [[ciCheck("Unit tests", "FAILURE")]] } } } });
  const main = git(repo, "rev-parse", "origin/main");
  const { code, json } = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(code, 3, JSON.stringify(json));
  assert.equal(json.status, "blocked");
  assert.equal(json.reason, "checks-failed");
  assert.match(json.message, /^PR #15 has a failing required check \(RESULT: failed\); nothing was merged/);
  assert.deepEqual(mergeCalls(stub), []);
  assert.equal(stub.state().product.prs[branch].state, "OPEN");
  git(repo, "fetch", "-q", "origin");
  assert.equal(git(repo, "rev-parse", "origin/main"), main);
  assert.equal(git(repo, "branch", "--show-current"), branch);
});

test("publish-pr merges origin/<default> into a BEHIND branch (a merge commit, pushed) and keeps waiting; a conflict aborts with its files", () => {
  const { repo } = makeWorktreeRepo();
  const branch = changesBranch(repo);
  advanceRemote(repo, "main", "other.txt", "main\n");
  const stub = shipStub({ product: { prs: { [branch]: { number: 15, isDraft: false, mergeStateStatus: "BEHIND" } } } });
  const first = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(first.code, 2, JSON.stringify(first.json));
  assert.deepEqual(first.json.actions.map((a) => a.step), ["push", "integrate", "push"]);
  assert.equal(parentsOf(repo).length, 2, "a merge commit, never a rebase");
  assert.equal(remoteHead(repo, branch), git(repo, "rev-parse", "HEAD"));
  stub.update((s) => Object.assign(s.product.prs[branch], { mergeStateStatus: "CLEAN" }));
  const second = publishPrRun(repo, stub.env, "--merge", "--wait", "0");
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(second.json.outcome, "merged");
  assert.ok(fs.existsSync(path.join(repo, "other.txt")) && fs.existsSync(path.join(repo, "tidy.txt")));

  const clash = makeWorktreeRepo().repo;
  const clashBranch = changesBranch(clash, "changes/clash", "shared.txt", "branch\n");
  advanceRemote(clash, "main", "shared.txt", "main\n");
  const clashStub = shipStub({ product: { prs: { [clashBranch]: { number: 15, isDraft: false, mergeStateStatus: "BEHIND" } } } });
  const head = git(clash, "rev-parse", "HEAD");
  const conflict = publishPrRun(clash, clashStub.env, "--merge", "--wait", "0");
  assert.equal(conflict.code, 3, JSON.stringify(conflict.json));
  assert.equal(conflict.json.reason, "integration-conflict");
  assert.deepEqual(conflict.json.conflicts, ["shared.txt"]);
  assert.equal(git(clash, "status", "--porcelain"), "");
  assert.equal(git(clash, "rev-parse", "HEAD"), head);
  assert.deepEqual(mergeCalls(clashStub), []);
});

test("publish-pr in a linked worktree merges but leaves the worktree on its branch with the close-session handoff", () => {
  const { repo, wt } = makeWorktreeRepo();
  const free = path.join(wt, "freehand-tidy");
  git(repo, "worktree", "add", "-q", "-b", "changes/tidy", free, "origin/main");
  fs.writeFileSync(path.join(free, "tidy.txt"), "tidy\n");
  git(free, "add", "-A");
  git(free, "commit", "-q", "-m", "chore: tidy");
  const stub = shipStub();
  const { code, json } = publishPrRun(free, stub.env, "--merge", "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "merged");
  assert.equal(json.checkout.linked, true);
  assert.deepEqual(json.actions.map((a) => a.step), ["push", "pr-create", "merge", "delete-branch"]);
  assert.deepEqual(json.next, ["/agento close-session changes/tidy"]);
  assert.match(json.sync.skipped, /linked worktree .* stays on changes\/tidy/);
  assert.equal(git(free, "branch", "--show-current"), "changes/tidy");
  assert.notEqual(git(repo, "branch", "--list", "changes/tidy"), "");
  assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("publish-pr --dir publishes a companion clone branch through the companion repository", () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const branch = changesBranch(docs, "changes/initiative-x", "x.md", "x\n");
  const stub = shipStub();
  const before = refState(repo);
  const { code, json } = publishPrRun(repo, stub.env, "--dir", docs, "--merge", "--wait", "0");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.checkout.repo, "companion");
  assert.equal(json.outcome, "merged");
  assert.equal(stub.state().companion.prs[branch].state, "MERGED");
  assert.deepEqual(Object.keys(stub.state().product.prs), []);
  assert.ok(stub.calls().some((c) => / --repo acme\/project-docs/.test(c)), stub.calls().join("\n"));
  assert.equal(git(docs, "branch", "--show-current"), "main");
  assert.equal(git(docs, "rev-parse", "HEAD"), git(docs, "rev-parse", "origin/main"));
  assert.deepEqual(refState(repo), before, "the product checkout is untouched");
});

test("publish-pr reports gh and push authentication failures with a reauth command", () => {
  const { repo } = makeWorktreeRepo();
  changesBranch(repo);
  const { env } = gitLoggingPath({ gh: "#!/bin/sh\necho 'HTTP 401: Bad credentials (https://api.github.com/graphql). Try authenticating with: gh auth login' >&2\nexit 1\n" });
  const gh = publishPrRun(repo, env, "--merge");
  assert.equal(gh.code, 3, JSON.stringify(gh.json));
  assert.equal(gh.json.status, "failed");
  assert.equal(gh.json.reason, "gh-auth");
  assert.equal(gh.json.reauth, "gh auth login");

  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 1\n", { mode: 0o755 });
  const push = publishPrRun(repo, shipStub().env, "--merge");
  assert.equal(push.code, 3, JSON.stringify(push.json));
  assert.equal(push.json.reason, "push-auth");
  assert.ok(push.json.reauth, "a reauth command");
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

// --- windows / handoff -----------------------------------------------------------

// A repo with one managed worktree, a VS Code user dir whose storage.json records a
// running workspace window holding the primary checkout, a `code` stub that prints
// that window for `--status` and logs every other call, and a private queue dir.
function handoffFixture({ code = true } = {}) {
  const { repo, wt } = makeWorktreeRepo();
  const worktree = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", worktree);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agento-handoff-"));
  const userDir = path.join(home, "vscode-user");
  const primaryWorkspace = path.join(home, "prim.code-workspace");
  fs.writeFileSync(primaryWorkspace, JSON.stringify({ folders: [{ path: repo }, { path: path.join(home, "docs") }] }));
  fs.mkdirSync(path.join(userDir, "globalStorage"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "globalStorage", "storage.json"), JSON.stringify({
    windowsState: { openedWindows: [{ workspaceIdentifier: { id: "p", configURIPath: `file://${primaryWorkspace}` } }] },
  }));
  const log = path.join(home, "code.log");
  const stubs = code
    ? { code: `#!/bin/sh\nif [ "$1" = "--status" ]; then printf '%s\\n' '|  Window (prim (Workspace) - Visual Studio Code)'; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\n` }
    : {};
  const { env } = restrictedPath(stubs);
  const configHome = path.join(home, "config");
  Object.assign(env, { AGENTO_VSCODE_USER_DIR: userDir, AGENTO_CONFIG_HOME: configHome });
  const queue = path.join(configHome, "pending-dispatch");
  const records = () => (fs.existsSync(queue) ? fs.readdirSync(queue).map((f) => JSON.parse(fs.readFileSync(path.join(queue, f), "utf8"))) : []);
  const opened = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { repo, worktree, primaryWorkspace, env, records, opened };
}

test("windows reports the running window holding each registered checkout and the target to open", () => {
  const fx = handoffFixture();
  const { code, json } = runWith({ cwd: fx.repo, env: fx.env }, "windows", fx.repo, fx.worktree, "/tmp/not-a-checkout");
  assert.equal(code, 0);
  assert.deepEqual(json.windows, [
    { checkout: fx.repo, known: true, role: "primary", open: true, target: fx.primaryWorkspace, kind: "workspace" },
    { checkout: fx.worktree, known: true, role: "build", open: false, target: fx.worktree, kind: "folder" },
    { checkout: "/tmp/not-a-checkout", known: false, open: false, target: null, kind: null },
  ]);
  assert.equal(runWith({ cwd: fx.repo, env: fx.env }, "windows").code, 1);
});

test("handoff queues the command for the target window and focuses or opens it with code", () => {
  const fx = handoffFixture();
  const ship = runWith({ cwd: fx.worktree, env: fx.env }, "handoff", fx.repo, "/agento ship widget");
  assert.equal(ship.code, 0, JSON.stringify(ship.json));
  assert.equal(ship.json.target, fx.primaryWorkspace, "the open workspace window holding the primary checkout");
  assert.equal(ship.json.wasOpen, true);
  assert.equal(ship.json.opened, true);
  const build = runWith({ cwd: fx.repo, env: fx.env }, "handoff", fx.worktree, "/agento build-feature widget");
  assert.equal(build.json.target, fx.worktree);
  assert.equal(build.json.wasOpen, false);
  assert.deepEqual(fx.opened(), [fx.primaryWorkspace, fx.worktree], "code <target>, never --new-window, so an open window is focused");
  const byTarget = Object.fromEntries(fx.records().map((r) => [r.target, r.command]));
  assert.deepEqual(byTarget, { [fx.primaryWorkspace]: "/agento ship widget", [fx.worktree]: "/agento build-feature widget" });

  const quiet = runWith({ cwd: fx.repo, env: fx.env }, "handoff", fx.worktree, "/agento ap widget", "--no-open");
  assert.equal(quiet.json.opened, false);
  assert.equal(quiet.json.openCommand, `code ${fx.worktree}`);
  assert.equal(fx.opened().length, 2);
  assert.equal(fx.records().find((r) => r.target === fx.worktree).command, "/agento ap widget", "a newer handoff replaces the queued one");
});

test("handoff rejects unknown checkouts and non-canonical commands, and unqueues when code is missing", () => {
  const fx = handoffFixture();
  const unknown = runWith({ cwd: fx.repo, env: fx.env }, "handoff", "/tmp/not-a-checkout", "/agento delivery-status");
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.reason, "unknown-checkout");
  assert.equal(runWith({ cwd: fx.repo, env: fx.env }, "handoff", fx.repo, "rm -rf /").code, 1);
  assert.equal(runWith({ cwd: fx.repo, env: fx.env }, "handoff", fx.repo).code, 1);
  assert.deepEqual(fx.records(), []);

  const bare = handoffFixture({ code: false });
  const failed = runWith({ cwd: bare.repo, env: bare.env }, "handoff", bare.worktree, "/agento build-feature widget");
  assert.equal(failed.code, 3);
  assert.equal(failed.json.status, "failed");
  assert.match(failed.json.reason, /code CLI not found/);
  assert.deepEqual(bare.records(), [], "a window that never opens leaves nothing queued");
});

// --- artifacts -------------------------------------------------------------------

test("artifacts reads plan, roadmap, and review from the artifacts checkout", () => {
  const repo = makeRepo();
  const dir = "features/2026/10/widget";
  writeRoadmap(repo, dir, "status: in-review\nbranch: feature/widget");
  fs.writeFileSync(path.join(repo, dir, "plan.md"), "# Widget plan\n");
  fs.writeFileSync(path.join(repo, dir, "review.md"), "Verdict: approve\n");
  const { code, json } = run(repo, "artifacts", "feature", "widget");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.source, "checkout");
  assert.equal(json.dir, dir);
  assert.equal(json.files.plan.content, "# Widget plan\n");
  assert.match(json.files.roadmap.content, /branch: feature\/widget/);
  assert.equal(json.files.review.content, "Verdict: approve\n");
  assert.equal(json.files.plan.path, path.join(repo, dir, "plan.md"));
});

test("artifacts prefers the delivery's own managed worktree over the checkout's older copy", () => {
  const { repo, wt } = makeWorktreeRepo();
  const dir = "features/2026/10/widget";
  writeRoadmap(repo, dir, "status: planned\nbranch: feature/widget");
  fs.writeFileSync(path.join(repo, dir, "plan.md"), "# Old plan\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plan widget");
  const worktree = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", worktree);
  fs.writeFileSync(path.join(worktree, dir, "plan.md"), "# Revised plan\n");
  const { json } = run(repo, "artifacts", "feature", "widget");
  assert.equal(json.source, "worktree");
  assert.equal(json.base, worktree);
  assert.equal(json.files.plan.content, "# Revised plan\n");
  assert.deepEqual(json.files.review, { exists: false });
});

test("artifacts falls back to the delivery branch, then reports missing", () => {
  const repo = makeRepo();
  const dir = "issues/2026/10/gadget";
  git(repo, "switch", "-q", "-c", "issue/gadget");
  writeRoadmap(repo, dir, "status: in-progress\nbranch: issue/gadget");
  fs.writeFileSync(path.join(repo, dir, "plan.md"), "# Gadget\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "plan gadget");
  git(repo, "switch", "-q", "main");
  const { code, json } = run(repo, "artifacts", "issue", "gadget");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.source, "local-branch");
  assert.equal(json.ref, "issue/gadget");
  assert.equal(json.files.plan.content, "# Gadget\n");
  assert.equal(json.files.plan.path, null);

  const missing = run(repo, "artifacts", "feature", "nothing-here");
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "missing");
  assert.equal(run(repo, "artifacts", "feature").code, 1);
  assert.equal(run(repo, "artifacts", "bogus", "x").code, 1);
});
