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

test("status walks registered companion halves and managed build worktrees; the branch-matching copy wins, a detached half loses to the clone", () => {
  // Companion mode: a roadmap committed only on a registered half's branch.
  const { repo, docs, wt, docsWt } = makePairRepo();
  const product = path.join(wt, "feature-xray");
  const half = path.join(docsWt, "feature-xray");
  git(repo, "worktree", "add", "-q", "-b", "feature/xray", product);
  git(docs, "worktree", "add", "-q", "--no-track", "-b", "feature/xray", half, "origin/main");
  writeRoadmap(half, "features/2026/09/xray", "status: in-progress\nbranch: feature/xray\nnext-step: \"1.2\"");
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "docs(feature): xray");
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  const only = run(repo, "status");
  assert.equal(only.code, 0);
  assert.deepEqual(only.json.items.map((i) => [i.slug, i.status, i.roadmap]), [["xray", "in-progress", "features/2026/09/xray/roadmap.md"]]);
  assert.deepEqual(only.json.duplicates, []);
  assert.deepEqual(only.json.resumable, ["xray"]);

  // A same-path clone copy with another status is shadowed by the half whose branch matches the header.
  writeRoadmap(docs, "features/2026/09/xray", "status: planned\nbranch: feature/xray\nnext-step: \"1.1\"");
  assert.deepEqual(run(repo, "status").json.items.map((i) => [i.slug, i.status]), [["xray", "in-progress"]]);
  assert.deepEqual(run(repo, "status", "feature", "xray").json.items.map((i) => i.status), ["in-progress"]);

  // A detached half (plan pair, not promoted on the companion side) loses the tie to the clone copy.
  const plan = path.join(wt, "plan-1");
  const planHalf = path.join(docsWt, "plan-1");
  git(repo, "worktree", "add", "-q", "--detach", plan, "origin/main");
  git(docs, "worktree", "add", "-q", "--detach", planHalf, "origin/main");
  writeRoadmap(docs, "features/2026/09/yank", "status: in-review\nbranch: feature/yank\nnext-step: review");
  writeRoadmap(planHalf, "features/2026/09/yank", "status: planned\nbranch: feature/yank\nnext-step: \"1.1\"");
  const tie = run(repo, "status").json;
  assert.deepEqual(tie.items.map((i) => [i.slug, i.status]), [["xray", "in-progress"], ["yank", "in-review"]]);
  // A roadmap only the detached half carries is still listed (its sole copy).
  writeRoadmap(planHalf, "features/2026/09/zeta", "status: planned\nbranch: feature/zeta\nnext-step: \"1.1\"");
  assert.deepEqual(run(repo, "status").json.items.map((i) => i.slug), ["xray", "yank", "zeta"]);
  // A half whose branch differs from the header also loses to the clone copy.
  git(planHalf, "switch", "-q", "-c", "feature/elsewhere");
  assert.deepEqual(run(repo, "status", "feature", "yank").json.items.map((i) => i.status), ["in-review"]);
  assert.equal(git(docs, "branch", "--show-current"), "main", "the companion clone is never switched");

  // In-repo layout: a roadmap present only in a managed build worktree's working tree is listed from the primary.
  const inRepo = makeWorktreeRepo();
  const build = path.join(inRepo.wt, "feature-widget");
  git(inRepo.repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  writeRoadmap(inRepo.repo, "features/2026/09/main-only", "status: planned\nbranch: feature/main-only\nnext-step: \"1.1\"");
  const fromPrimary = run(inRepo.repo, "status").json;
  assert.deepEqual(fromPrimary.items.map((i) => [i.slug, i.status]), [["widget", "in-progress"], ["main-only", "planned"]]);
  assert.deepEqual(fromPrimary.resumable, ["widget"]);
  // The worktree's copy of a shared path wins on its own branch; a plan worktree (no delivery branch) is not walked.
  writeRoadmap(inRepo.repo, "features/2026/09/widget", "status: planned\nbranch: feature/widget\nnext-step: \"1.1\"");
  assert.deepEqual(run(inRepo.repo, "status", "feature", "widget").json.items.map((i) => i.status), ["in-progress"]);
  const planWt = path.join(inRepo.wt, "plan-2");
  git(inRepo.repo, "worktree", "add", "-q", "--detach", planWt, "origin/main");
  writeRoadmap(planWt, "features/2026/09/draft", "status: planned\nbranch: feature/draft\nnext-step: \"1.1\"");
  assert.ok(!run(inRepo.repo, "status").json.items.some((i) => i.slug === "draft"));
  // From the build worktree itself the listing agrees.
  assert.deepEqual(run(build, "status", "feature", "widget").json.items.map((i) => i.status), ["in-progress"]);
});

test("initiative walks the same managed halves as status: a member planned only on its unmerged branch is in flight, not ready", () => {
  // Companion mode: the breakdown is on the companion's main; the member's roadmap
  // exists only in the promoted plan pair's companion half.
  const { repo, docs, wt, docsWt } = makePairRepo();
  writeBreakdown(docs, "initiatives/2026/10/mod", null, [{ slug: "kernel" }, { slug: "routes", requires: ["kernel"] }, { slug: "folders", requires: ["routes"] }]);
  writeRoadmap(docs, "features/2026/10/kernel", 'status: complete\nbranch: feature/kernel\ninitiative: "mod"\nnext-step: ""');
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "docs: breakdown");
  const before = run(repo, "initiative", "mod").json;
  assert.deepEqual(before.features.map((f) => [f.slug, f.state, f.ready]), [["kernel", "complete", false], ["routes", "unplanned", true], ["folders", "unplanned", false]]);
  assert.equal(before.next, "routes");

  const product = path.join(wt, "plan-20261003-144724");
  const half = path.join(docsWt, "plan-20261003-144724");
  git(repo, "worktree", "add", "-q", "-b", "feature/routes", product);
  git(docs, "worktree", "add", "-q", "--no-track", "-b", "feature/routes", half, "origin/main");
  writeRoadmap(half, "features/2026/10/routes", 'status: in-progress\nbranch: feature/routes\ninitiative: "mod"\nnext-step: "1.2 todo"');
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "docs(feature): routes plan");
  assert.ok(!fs.existsSync(path.join(docs, "features/2026/10/routes")));

  for (const cwd of [repo, product]) {
    const detail = run(cwd, "initiative", "mod").json;
    assert.equal(detail.status, "ok");
    assert.deepEqual(detail.features.map((f) => [f.slug, f.state, f.ready, f.roadmap]), [
      ["kernel", "complete", false, "features/2026/10/kernel/roadmap.md"],
      ["routes", "in-progress", false, "features/2026/10/routes/roadmap.md"],
      ["folders", "unplanned", false, null],
    ]);
    assert.equal(detail.next, null);
    assert.deepEqual(run(cwd, "initiative").json.items.map((i) => [i.slug, i.inFlight, i.ready]), [["mod", 1, 0]]);
  }

  // In-repo layout: a roadmap only in a managed build worktree counts the same way.
  const inRepo = makeWorktreeRepo();
  writeBreakdown(inRepo.repo, "initiatives/2026/10/solo", null, [{ slug: "widget" }]);
  assert.deepEqual(run(inRepo.repo, "initiative", "solo").json.features.map((f) => [f.slug, f.state, f.ready]), [["widget", "unplanned", true]]);
  const buildWt = path.join(inRepo.wt, "feature-widget");
  git(inRepo.repo, "worktree", "add", "-q", "-b", "feature/widget", buildWt);
  writeRoadmap(buildWt, "features/2026/10/widget", 'status: planned\nbranch: feature/widget\ninitiative: "solo"\nnext-step: "1.1"');
  assert.deepEqual(run(inRepo.repo, "initiative", "solo").json.features.map((f) => [f.slug, f.state, f.ready]), [["widget", "planned", false]]);
  assert.deepEqual(run(inRepo.repo, "initiative").json.items.map((i) => [i.slug, i.inFlight, i.ready]), [["solo", 1, 0]]);
});

test("status lists roadmaps with progress, verdicts, and duplicate slugs", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nlast-updated: 2026-09-01\nnext-step: \"1.2 todo\"\nartifact-pr: \"#7\"");
  writeRoadmap(repo, "issues/2026/09/beta", "status: in-review\nbranch: issue/beta\nnext-step: review\ngithub-issue: \"#12\"");
  fs.writeFileSync(path.join(repo, "issues/2026/09/beta/review.md"), "# Review: beta\n\nVerdict: request-changes\n");
  writeRoadmap(repo, "features/2026/08/beta", "status: complete\nbranch: feature/beta\nnext-step: \"\"");

  const { code, json } = run(repo, "status");
  assert.equal(code, 0);
  assert.deepEqual(json.items.map((i) => i.slug), ["alpha", "beta", "beta"]);
  const alpha = json.items[0];
  assert.deepEqual(alpha.steps, { ticked: 1, total: 2 });
  assert.equal(alpha.nextStep, "1.2 todo");
  assert.equal(alpha.artifactPr, "#7");
  const betaIssue = json.items.find((i) => i.type === "issue");
  assert.equal(betaIssue.reviewVerdict, "request-changes");
  assert.equal(betaIssue.githubIssue, "#12");
  assert.equal(betaIssue.artifactPr, null);
  assert.equal(json.duplicates.length, 1);
  assert.equal(json.duplicates[0].slug, "beta");
  assert.deepEqual([...json.duplicates[0].paths].sort(), ["features/2026/08/beta/roadmap.md", "issues/2026/09/beta/roadmap.md"]);
  assert.deepEqual(json.resumable, ["alpha", "beta"]);

  const filtered = run(repo, "status", "issue");
  assert.deepEqual(filtered.json.items.map((i) => i.type), ["issue"]);
});

test("emit flushes output larger than the pipe buffer before exiting", () => {
  const repo = makeRepo();
  for (let i = 0; i < 200; i += 1) {
    writeRoadmap(repo, `features/2026/09/slug-${String(i).padStart(3, "0")}`, `status: complete\nbranch: feature/slug-${i}\nnext-step: ""`);
  }
  const result = spawnSync("node", [cli, "status"], { cwd: repo, encoding: "utf8", env: baseEnv, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 65536, `expected output above 64 KiB, got ${result.stdout.length}`);
  assert.equal(JSON.parse(result.stdout).items.length, 200);
});

test("status adds lifecycle, owner, workspace, companion, pr/companionPr per item and lifecycles/warnings on top; sort and resumable unchanged", () => {
  const { repo, wt } = makeWorktreeRepo();
  const build = path.join(wt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", build);
  const postShip = "- [x] 1.1 done — verify: x\n- [ ] 1.2 (manual, post-ship) rotate — verify: y\n";
  writeRoadmap(repo, "features/2026/09/planned", "status: planned\nbranch: feature/planned\nnext-step: \"1.1\"");
  writeRoadmap(repo, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  writeRoadmap(repo, "features/2026/09/paused", "status: paused\nbranch: feature/paused\nnext-step: \"1.2\"");
  writeRoadmap(repo, "issues/2026/09/review", "status: in-review\nbranch: issue/review\nnext-step: review");
  writeRoadmap(repo, "features/2026/09/approved", "status: in-review\nbranch: feature/approved\nnext-step: ship");
  fs.writeFileSync(path.join(repo, "features/2026/09/approved/review.md"), "# Review\n\nVerdict: approve\n");
  writeRoadmap(repo, "features/2026/09/changes", "status: in-review\nbranch: feature/changes\nnext-step: fix");
  fs.writeFileSync(path.join(repo, "features/2026/09/changes/review.md"), "# Review\n\nVerdict: request-changes\n");
  writeRoadmap(repo, "features/2026/08/shipped", "status: complete\nbranch: feature/shipped\nnext-step: \"\"");
  writeRoadmap(repo, "features/2026/08/pending", "status: complete\nbranch: feature/pending\nnext-step: \"1.2\"", postShip);
  writeRoadmap(repo, "features/2026/09/bogus", "status: wat\nbranch: feature/bogus\nnext-step: \"1.1\"");

  const { code, json } = run(repo, "status");
  assert.equal(code, 0);
  // Today's sort (unknown status first, then in-progress, paused, in-review, planned, complete; slug within) and resumable.
  assert.deepEqual(json.items.map((i) => i.slug), ["bogus", "widget", "paused", "approved", "changes", "review", "planned", "pending", "shipped"]);
  assert.deepEqual(json.resumable, ["widget", "paused", "approved", "changes", "review"]);
  assert.deepEqual(json.duplicates, []);
  const lifecycleOf = Object.fromEntries(json.items.map((i) => [i.slug, i.lifecycle]));
  assert.deepEqual(lifecycleOf, {
    planned: "planned",
    widget: "building",
    paused: "paused",
    review: "in-review",
    changes: "in-review",
    approved: "approved",
    shipped: "shipped",
    pending: "post-ship-pending",
    bogus: "no-delivery",
  });
  assert.deepEqual(json.lifecycles, LIFECYCLES);
  assert.deepEqual(json.warnings, [`bogus: unknown-roadmap-status: features/2026/09/bogus/roadmap.md has status "wat"`]);
  const widget = json.items.find((i) => i.slug === "widget");
  assert.deepEqual(widget.owner, { path: build, role: "build", dirPrefix: "feature", id: "widget" });
  assert.deepEqual(widget.allowed, ["/agento continue", "/agento build-feature widget", "/agento ap widget", "/agento delivery-status", "/agento next-feature"]);
  assert.deepEqual(widget.elsewhere.map((entry) => [entry.command, entry.window]), [["/agento ship widget", "primary"]]);
  for (const item of json.items) {
    if (item.slug !== "widget") assert.equal(item.owner, null, item.slug);
    assert.equal(item.workspace, null, item.slug);
    assert.equal(item.companion, null, item.slug);
    assert.equal(item.pr, null, item.slug);
    assert.equal(item.companionPr, null, item.slug);
    assert.ok(Array.isArray(item.allowed), item.slug);
    assert.ok(Array.isArray(item.elsewhere), item.slug);
    // Every pre-existing field is still there with its type.
    assert.deepEqual(Object.keys(item.steps), ["ticked", "total"]);
    assert.equal(typeof item.status, "string");
    assert.equal(typeof item.branch, "string");
  }
  // A clean listing has no warnings.
  fs.rmSync(path.join(repo, "features/2026/09/bogus"), { recursive: true });
  const clean = run(repo, "status").json;
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.items.map((i) => i.slug), ["widget", "paused", "approved", "changes", "review", "planned", "pending", "shipped"]);

  // Companion mode: an item on an owned branch reports its half and the pair's workspace file.
  const pair = makePairRepo();
  const product = path.join(pair.wt, "feature-widget");
  const half = path.join(pair.docsWt, "feature-widget");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(pair.docs, "worktree", "add", "-q", "--no-track", "-b", "feature/widget", half, "origin/main");
  writeRoadmap(half, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");
  git(half, "add", "-A");
  git(half, "commit", "-q", "-m", "docs(feature): widget");
  writeRoadmap(pair.docs, "features/2026/09/unowned", "status: planned\nbranch: feature/unowned\nnext-step: \"1.1\"");
  const workspaceFile = path.join(pair.wt, "feature-widget.code-workspace");
  let items = run(pair.repo, "status").json.items;
  let owned = items.find((i) => i.slug === "widget");
  assert.deepEqual(owned.owner, { path: product, role: "build", dirPrefix: "feature", id: "widget" });
  assert.deepEqual(owned.companion, { path: half, branch: "feature/widget", detached: false, dirty: false, ahead: 1, behind: 0, registered: true });
  assert.deepEqual(owned.workspace, { path: workspaceFile, exists: false, current: null });
  const unowned = items.find((i) => i.slug === "unowned");
  assert.equal(unowned.owner, null);
  assert.equal(unowned.companion, null);
  assert.equal(unowned.workspace, null);
  assert.ok(unowned.allowed.includes("/agento start-session feature/unowned"));
  assert.deepEqual(unowned.elsewhere.map((entry) => [entry.command, entry.window]), [["/agento build-feature unowned", "secondary"]]);
  fs.writeFileSync(path.join(half, "scratch.md"), "wip\n");
  fs.writeFileSync(workspaceFile, "{}\n");
  items = run(pair.repo, "status").json.items;
  owned = items.find((i) => i.slug === "widget");
  assert.equal(owned.companion.dirty, true);
  assert.equal(owned.companion.ahead, 1);
  assert.deepEqual(owned.workspace, { path: workspaceFile, exists: true, current: false });
});

test("status --pr looks up PRs for non-complete items only, warns per slug on failure, and never changes lifecycle", () => {
  const { repo, wt } = makeWorktreeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: \"1.2\"");
  writeRoadmap(repo, "issues/2026/09/bug", "status: in-review\nbranch: issue/bug\nnext-step: review");
  writeRoadmap(repo, "features/2026/08/done", "status: complete\nbranch: feature/done\nnext-step: \"\"");
  const marker = path.join(wt, "gh-invoked");
  const calls = () => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : []);

  // Without --pr: no gh process, every pr/companionPr null.
  const plain = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker) }).env }, "status");
  assert.equal(plain.code, 0);
  assert.ok(!fs.existsSync(marker), "gh was invoked without --pr");
  assert.ok(plain.json.items.every((i) => i.pr === null && i.companionPr === null));

  // With --pr in the in-repo layout: one call per non-complete item, none for the complete one.
  const withPr = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker) }).env }, "status", "--pr");
  assert.equal(withPr.code, 0);
  assert.deepEqual(withPr.json.items.map((i) => i.slug), ["alpha", "bug", "done"]);
  for (const slug of ["alpha", "bug"]) {
    const item = withPr.json.items.find((i) => i.slug === slug);
    assert.deepEqual(item.pr, { number: 15, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", url: "https://example.test/pr/15" });
    assert.equal(item.companionPr, null);
  }
  const done = withPr.json.items.find((i) => i.slug === "done");
  assert.equal(done.pr, null);
  assert.equal(done.companionPr, null);
  assert.equal(done.lifecycle, "shipped");
  assert.deepEqual(withPr.json.warnings, []);
  assert.deepEqual(
    calls().sort(),
    [`${repo} pr view feature/alpha --json number,state,isDraft,mergeStateStatus,mergeable,url`, `${repo} pr view issue/bug --json number,state,isDraft,mergeStateStatus,mergeable,url`],
  );

  // A failing gh: pr null plus one slug-prefixed warning; exit code and lifecycle unchanged.
  fs.rmSync(marker, { force: true });
  const failing = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker, { product: "NONE" }) }).env }, "status", "feature", "alpha", "--pr");
  assert.equal(failing.code, 0);
  assert.equal(failing.json.items[0].pr, null);
  assert.equal(failing.json.items[0].lifecycle, "building");
  assert.deepEqual(failing.json.warnings, ["alpha: pr: gh pr view feature/alpha failed: no pull requests found for branch"]);

  // A merged PR on an in-progress roadmap warns but keeps lifecycle building.
  const merged = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(marker, { product: "MERGED" }) }).env }, "status", "feature", "alpha", "--pr");
  assert.equal(merged.json.items[0].lifecycle, "building");
  assert.equal(merged.json.items[0].pr.state, "MERGED");
  assert.deepEqual(merged.json.warnings, ["alpha: merged-but-not-complete: PR #15 for feature/alpha is merged but features/2026/09/alpha/roadmap.md has status in-progress"]);

  // Companion mode: one call from the product checkout and one from inside the companion clone per item.
  const pair = makePairRepo();
  writeRoadmap(pair.docs, "features/2026/09/widget", "status: in-review\nbranch: feature/widget\nnext-step: review\nartifact-pr: \"#7\"");
  writeRoadmap(pair.docs, "features/2026/08/done", "status: complete\nbranch: feature/done\nnext-step: \"\"");
  const pairMarker = path.join(pair.wt, "gh-invoked");
  const both = runWith({ cwd: pair.repo, env: restrictedPath({ gh: prStub(pairMarker) }).env }, "status", "--pr");
  assert.equal(both.code, 0);
  const widget = both.json.items.find((i) => i.slug === "widget");
  assert.equal(widget.pr.number, 15);
  assert.equal(widget.companionPr.number, 7);
  const pairDone = both.json.items.find((i) => i.slug === "done");
  assert.equal(pairDone.pr, null);
  assert.equal(pairDone.companionPr, null);
  assert.deepEqual(
    fs.readFileSync(pairMarker, "utf8").trim().split("\n").sort(),
    [`${pair.repo} pr view feature/widget --json number,state,isDraft,mergeStateStatus,mergeable,url`, `${pair.docs} pr view feature/widget --json number,state,isDraft,mergeStateStatus,mergeable,url`],
  );
  assert.deepEqual(both.json.warnings, []);

  assert.match(run(repo).json.usage.join("\n"), /status \[feature\|issue\] \[slug\] \[--pr\]/);
});

const chain = [{ slug: "a" }, { slug: "b", recommendedAfter: ["a"] }, { slug: "c", requires: ["b"] }];

test("initiative derives state, readiness, waves, and next; only complete roadmaps satisfy Requires", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, chain);

  const first = run(repo, "initiative", "demo");
  assert.equal(first.code, 0);
  assert.equal(first.json.status, "ok");
  assert.equal(first.json.initiative.slug, "demo");
  assert.equal(first.json.initiative.created, "2026-09-01");
  assert.equal(first.json.initiative.lastUpdated, "2026-09-02");
  assert.deepEqual(first.json.features.map((f) => [f.slug, f.state, f.ready, f.blockedBy]), [
    ["a", "unplanned", true, []],
    ["b", "unplanned", true, []],
    ["c", "unplanned", false, ["b"]],
  ]);
  assert.deepEqual(first.json.features[1].recommendedAfter, ["a"]);
  assert.deepEqual(first.json.features.map((f) => f.artifactPr), [null, null, null]);
  assert.deepEqual(first.json.waves, [["a", "b"], ["c"]]);
  assert.equal(first.json.next, "a");
  assert.equal(first.json.done, false);
  assert.deepEqual(first.json.anomalies, []);

  writeRoadmap(repo, "features/2026/09/a", 'status: complete\nbranch: feature/a\ninitiative: "demo"\nnext-step: ""');
  writeRoadmap(repo, "features/2026/09/b", 'status: in-review\nbranch: feature/b\ninitiative: "demo"\nnext-step: review\nartifact-pr: "#7"');
  const second = run(repo, "initiative", "demo").json;
  assert.deepEqual(second.features.map((f) => [f.slug, f.state, f.ready]), [
    ["a", "complete", false],
    ["b", "in-review", false],
    ["c", "unplanned", false],
  ]);
  // Members carry the companion PR from their roadmap header; null without one or without a roadmap.
  assert.deepEqual(second.features.map((f) => f.artifactPr), [null, "#7", null]);
  assert.deepEqual(second.features[2].blockedBy, ["b"]);
  assert.equal(second.next, null);

  writeRoadmap(repo, "features/2026/09/b", 'status: complete\nbranch: feature/b\ninitiative: "demo"\nnext-step: ""');
  const third = run(repo, "initiative", "demo").json;
  assert.equal(third.features[2].ready, true);
  assert.deepEqual(third.features[2].blockedBy, []);
  assert.equal(third.next, "c");
  assert.equal(third.done, false);

  writeRoadmap(repo, "features/2026/09/c", 'status: complete\nbranch: feature/c\ninitiative: "demo"\nnext-step: ""');
  assert.equal(run(repo, "initiative", "demo").json.done, true);
});

test("initiative picks next by explicit wave, then computed level, then listed order", () => {
  const repo = makeRepo();
  // Listed order puts `late` first, but its explicit Wave: 2 loses to wave-1 `early`;
  // among wave-1 features the listed order decides (`early` before `also`).
  writeBreakdown(repo, "initiatives/2026/09/order", null, [
    { slug: "late", wave: 2 },
    { slug: "early", wave: 1 },
    { slug: "also", wave: 1 },
    { slug: "dep", requires: ["early"] },
  ]);
  const { json } = run(repo, "initiative", "order");
  assert.equal(json.status, "ok");
  assert.equal(json.next, "early");
  assert.deepEqual(json.features.map((f) => [f.slug, f.wave, f.computedWave]), [
    ["late", 2, 1],
    ["early", 1, 1],
    ["also", 1, 1],
    ["dep", null, 2],
  ]);

  writeRoadmap(repo, "features/2026/09/early", 'status: complete\nbranch: feature/early\ninitiative: "order"\nnext-step: ""');
  const after = run(repo, "initiative", "order").json;
  // `also` (explicit wave 1) beats `dep` (no explicit wave, computed level 2) and `late` (wave 2).
  assert.equal(after.next, "also");
  writeRoadmap(repo, "features/2026/09/also", 'status: in-progress\nbranch: feature/also\ninitiative: "order"\nnext-step: "1.2"');
  // `dep` has no explicit wave, so it ranks by computed level 2 and ties with `late` on the first key; `late`'s computed level 1 wins.
  assert.equal(run(repo, "initiative", "order").json.next, "late");
});

test("initiative rejects unknown slugs in Requires and Recommended after", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, [{ slug: "a", requires: ["ghost"] }, { slug: "b", recommendedAfter: ["phantom"] }]);
  const { code, json } = run(repo, "initiative", "demo");
  assert.equal(code, 3);
  assert.equal(json.status, "invalid");
  assert.deepEqual(json.errors, ['a: Requires unknown feature "ghost"', 'b: Recommended after unknown feature "phantom"']);
});

test("initiative rejects dependency cycles", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, [{ slug: "a", requires: ["c"] }, { slug: "b", requires: ["a"] }, { slug: "c", requires: ["b"] }, { slug: "free" }]);
  const { code, json } = run(repo, "initiative", "demo");
  assert.equal(code, 3);
  assert.equal(json.status, "invalid");
  assert.deepEqual(json.errors, ["dependency cycle among: a, b, c"]);
  assert.deepEqual(json.waves, [["free"]]);
  assert.equal(json.features.find((f) => f.slug === "a").computedWave, null);
});

test("initiative rejects duplicate feature blocks", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, [{ slug: "a" }, { slug: "b" }, { slug: "a" }]);
  const { code, json } = run(repo, "initiative", "demo");
  assert.equal(code, 3);
  assert.equal(json.status, "invalid");
  assert.deepEqual(json.errors, ['duplicate feature block "### a"']);
});

test("initiative rejects member roadmaps whose initiative header is missing or mismatched", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, chain);
  writeRoadmap(repo, "features/2026/09/b", "status: in-progress\nbranch: feature/b\nnext-step: \"1.2\"");
  const missing = run(repo, "initiative", "demo");
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "invalid");
  assert.deepEqual(missing.json.errors, ['b: roadmap features/2026/09/b/roadmap.md has no initiative: header (expected "demo")']);

  writeRoadmap(repo, "features/2026/09/b", 'status: in-progress\nbranch: feature/b\ninitiative: "other"\nnext-step: "1.2"');
  const mismatch = run(repo, "initiative", "demo");
  assert.equal(mismatch.code, 3);
  assert.deepEqual(mismatch.json.errors, ['b: roadmap features/2026/09/b/roadmap.md names initiative "other", expected "demo"']);
  // State is still derived so callers can show progress next to the errors.
  assert.equal(mismatch.json.features[1].state, "in-progress");

  writeRoadmap(repo, "features/2026/09/b", 'status: in-progress\nbranch: feature/b\ninitiative: "demo"\nnext-step: "1.2"');
  assert.equal(run(repo, "initiative", "demo").json.status, "ok");
});

test("initiative reports a missing breakdown with exit 3", () => {
  const repo = makeRepo();
  const { code, json } = run(repo, "initiative", "nothing-here");
  assert.equal(code, 3);
  assert.equal(json.status, "missing");
  assert.match(json.message, /nothing-here/);
  assert.match(json.message, /initiatives\//);
});

test("initiative list mode counts progress for every breakdown", () => {
  const repo = makeRepo();
  const empty = run(repo, "initiative");
  assert.equal(empty.code, 0);
  assert.equal(empty.json.status, "ok");
  assert.deepEqual(empty.json.items, []);
  assert.equal(empty.json.initiativesRoot, "initiatives");

  writeBreakdown(repo, "initiatives/2026/09/demo", null, chain);
  writeRoadmap(repo, "features/2026/09/a", 'status: complete\nbranch: feature/a\ninitiative: "demo"\nnext-step: ""');
  writeRoadmap(repo, "features/2026/09/b", 'status: in-progress\nbranch: feature/b\ninitiative: "demo"\nnext-step: "1.2"');
  writeBreakdown(repo, "initiatives/2026/08/broken", "initiative: broken\ncreated: 2026-08-01\nlast-updated: 2026-08-03", [{ slug: "x" }, { slug: "y", requires: ["nope"] }]);

  const { code, json } = run(repo, "initiative");
  assert.equal(code, 0);
  assert.deepEqual(json.items, [
    { slug: "broken", dir: "initiatives/2026/08/broken", created: "2026-08-01", lastUpdated: "2026-08-03", total: 2, complete: 0, inFlight: 0, ready: 1, done: false, valid: false },
    { slug: "demo", dir: "initiatives/2026/09/demo", created: "2026-09-01", lastUpdated: "2026-09-02", total: 3, complete: 1, inFlight: 1, ready: 0, done: false, valid: true },
  ]);
});

test("initiative header is carried by status items and the usage lists the subcommand", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/a", 'status: planned\nbranch: feature/a\ninitiative: "demo"\nnext-step: "1.1"');
  writeRoadmap(repo, "features/2026/09/solo", "status: planned\nbranch: feature/solo\nnext-step: \"1.1\"");
  const { json } = run(repo, "status");
  assert.deepEqual(json.items.map((i) => [i.slug, i.initiative]), [["a", "demo"], ["solo", null]]);

  const usage = run(repo, "bogus");
  assert.equal(usage.code, 1);
  assert.equal(usage.json.status, "usage-error");
  assert.ok(usage.json.usage.some((line) => line.includes("initiative [<slug>]")), JSON.stringify(usage.json.usage));
  assert.equal(run(repo, "initiative", "Bad_Slug").code, 1);
});

test("initiative flags merged-but-not-complete members without unblocking dependents", () => {
  const repo = makeRepo();
  writeBreakdown(repo, "initiatives/2026/09/demo", null, chain);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "breakdown");
  // `feature/b` lands on the temp origin's main while its roadmap still says in-review.
  git(repo, "switch", "-q", "-c", "feature/b");
  writeRoadmap(repo, "features/2026/09/b", 'status: in-review\nbranch: feature/b\ninitiative: "demo"\nnext-step: review');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "b");
  git(repo, "push", "-q", "-u", "origin", "feature/b");
  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--ff-only", "feature/b");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");

  const { code, json } = run(repo, "initiative", "demo");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.deepEqual(json.anomalies, [{ slug: "b", kind: "merged-but-not-complete", branch: "feature/b" }]);
  const c = json.features.find((f) => f.slug === "c");
  assert.equal(c.ready, false);
  assert.deepEqual(c.blockedBy, ["b"]);
  assert.equal(json.next, "a");

  // Once the roadmap says complete the branch may still exist on origin; that is normal, not an anomaly.
  writeRoadmap(repo, "features/2026/09/b", 'status: complete\nbranch: feature/b\ninitiative: "demo"\nnext-step: ""');
  const after = run(repo, "initiative", "demo").json;
  assert.deepEqual(after.anomalies, []);
  assert.equal(after.features.find((f) => f.slug === "c").ready, true);
});

// --- dashboard: one process per refresh ---------------------------------------

// A restricted PATH whose `git` appends its arguments to `log` before running the real binary.


// `worktree list --porcelain` calls per (real) `-C` directory; clears the log.



test("dashboard sections deep-equal session, doctor, status, initiative, and metrics in in-repo and companion fixtures", () => {
  for (const companion of [false, true]) {
    const { repo, build } = makeDashboardRepo({ companion });
    const marker = path.join(path.dirname(repo), "gh-calls");
    const open = restrictedPath({ gh: prStub(marker) }).env;
    for (const cwd of [repo, build]) for (const pr of [false, true]) assertDashboardMatches(cwd, open, { pr });
    const fromBuild = assertDashboardMatches(build, open, { pr: true });
    assert.equal(fromBuild.session.delivery.slug, "alpha");
    assert.equal(fromBuild.session.pr.number, 15);
    assert.deepEqual(fromBuild.deliveries.items.map((i) => [i.slug, i.status]), [["alpha", "in-progress"], ["bug", "in-review"], ["beta", "planned"], ["omega", "complete"]]);
    assert.deepEqual(fromBuild.initiatives.details.demo.features.filter((f) => f.ready).map((f) => f.slug), ["delta"]);
    // PR lookups that fail (no PR, no gh) match the synchronous lookups too.
    assertDashboardMatches(build, restrictedPath({ gh: prStub(marker, { product: "NONE", companion: "NONE" }) }).env, { pr: true });
    const noGh = assertDashboardMatches(build, restrictedPath().env, { pr: true });
    assert.ok(noGh.session.warnings.some((w) => /^pr: gh CLI not found on PATH/.test(w)), noGh.session.warnings.join("\n"));
  }
  assert.ok(run(makeRepo(), "nope").json.usage.some((line) => line.includes("agento.mjs dashboard [--pr] [--plugin-root <dir>]")));
});

test("dashboard runs no gh pr view without --pr; with --pr one gh --version and one pr view per distinct (clone, branch)", () => {
  for (const companion of [false, true]) {
    const { repo, docs, build } = makeDashboardRepo({ companion });
    const marker = path.join(path.dirname(repo), "gh-calls");
    const { env } = restrictedPath({ gh: prStub(marker, { logVersion: true }) });
    const calls = () => {
      const lines = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
      fs.rmSync(marker, { force: true });
      return lines;
    };
    assert.equal(runWith({ cwd: build, env }, "dashboard").code, 0);
    assert.deepEqual(calls().filter((l) => / pr view /.test(l)), [], "no pr view without --pr");
    assert.equal(runWith({ cwd: build, env }, "dashboard", "--pr").code, 0);
    const lines = calls();
    assert.equal(lines.filter((l) => l.endsWith(" --version")).length, 1);
    const views = lines.filter((l) => / pr view /.test(l));
    const byCwd = {};
    for (const line of views) {
      const [cwd, , , branch] = line.split(" ");
      (byCwd[cwd] ??= []).push(branch);
    }
    // The session's feature/alpha lookup is shared with the status item's.
    const expected = ["feature/alpha", "feature/beta", "issue/bug"];
    assert.deepEqual(Object.keys(byCwd).sort(), (companion ? [build, docs] : [build]).sort());
    for (const branches of Object.values(byCwd)) assert.deepEqual(branches.sort(), expected);
  }
});

test("dashboard --pr runs PR lookups concurrently, never more than four gh processes at once", () => {
  const { repo } = makeWorktreeRepo();
  const slugs = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
  for (const slug of slugs) writeRoadmap(repo, `features/2026/10/${slug}`, `status: in-progress\nbranch: feature/${slug}\nnext-step: "1.2"`);
  const active = fs.mkdtempSync(path.join(os.tmpdir(), "agento-gh-active-"));
  const log = path.join(path.dirname(active), `${path.basename(active)}.log`);
  const stub = `#!/bin/sh\nPATH=/usr/bin:/bin\ntouch ${JSON.stringify(active)}/$$\nn=$(ls ${JSON.stringify(active)} | wc -l)\necho "$n $*" >> ${JSON.stringify(log)}\nsleep 0.3\nrm -f ${JSON.stringify(active)}/$$\nif [ "$1" = "pr" ]; then echo '{"number":15,"state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","url":"https://example.test/pr/15"}'; fi\n`;
  const { env } = restrictedPath({ gh: stub });
  const { code, json } = runWith({ cwd: repo, env }, "dashboard", "--pr");
  assert.equal(code, 0);
  assert.deepEqual(json.deliveries.items.map((i) => [i.slug, i.pr?.number]), slugs.map((s) => [s, 15]));
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  // The primary session's own branch (main) is looked up too, as `session --pr` does.
  const viewed = lines.filter((l) => / pr view /.test(l)).map((l) => l.split(" ")[3]).sort();
  assert.deepEqual(viewed, ["feature/a1", "feature/a2", "feature/a3", "feature/a4", "feature/a5", "feature/a6", "feature/a7", "feature/a8", "main"]);
  const peak = Math.max(...lines.map((l) => Number.parseInt(l, 10)));
  assert.ok(peak <= 4, `peak ${peak} gh processes`);
  assert.ok(peak >= 2, `peak ${peak}: lookups ran serially`);
});

test("dashboard turns a throwing section into { status: error, message } and keeps the others and exit 0", { skip: process.getuid?.() === 0 ? "root reads unreadable files" : false }, () => {
  const { repo } = makeDashboardRepo({ companion: false });
  const unreadable = path.join(repo, "features/2026/10/beta/roadmap.md");
  fs.chmodSync(unreadable, 0o000);
  try {
    const { code, json } = runWith({ cwd: repo, env: restrictedPath().env }, "dashboard");
    assert.equal(code, 0);
    assert.equal(json.status, "ok");
    assert.equal(json.deliveries.status, "error");
    assert.match(json.deliveries.message, /EACCES/);
    assert.equal(typeof json.metrics.status, "string");
    assert.equal(json.metrics.status, "error");
    assert.equal(typeof json.timings.metrics, "number");
    assert.equal(typeof json.doctor.status, "string");
    assert.ok(json.doctor.checks.length > 0 && json.doctor.checks.every((c) => typeof c.id === "string"));
  } finally {
    fs.chmodSync(unreadable, 0o644);
  }
});

test("dashboard --plugin-root reaches the doctor section's model-profile check like doctor --plugin-root", () => {
  const { repo } = makeWorktreeRepo();
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-plugin-"));
  fs.mkdirSync(path.join(plugin, ".github", "agents"), { recursive: true });
  const modelProfile = (json) => json.checks.find((c) => c.id === "model-profile");
  const viaDashboard = modelProfile(run(repo, "dashboard", "--plugin-root", plugin).json.doctor);
  assert.deepEqual(viaDashboard, modelProfile(run(repo, "doctor", "--plugin-root", plugin).json));
  assert.match(viaDashboard.detail, new RegExp(plugin));
  assert.notDeepEqual(viaDashboard, modelProfile(run(repo, "dashboard").json.doctor));
});

// --- metrics: git history only ------------------------------------------------

const atUtc = (hhmm) => `2026-09-01T${hhmm}:00Z`;
const isoUtc = atUtc;
const postShipSteps = (ticked) => `- [x] 1.1 done — verify: x\n- [${ticked ? "x" : " "}] 2.1 (manual, post-ship) confirm the release — verify: y\n`;
const METRICS_X = "features/2026/09/xray";
const METRICS_Y = "features/2026/09/yank";

// Delivery xray lived its whole lifecycle on feature/xray — planned, in-progress, in-review,
// request-changes, paused, in-progress, in-review, approve, complete — was merged as
// product PR #7 (the companion's own merge is #8), and had its post-ship step ticked
// on main later. Delivery yank is in flight: committed only on its managed half's
// feature/yank branch, pushed. Every commit carries a fixed clock.
function makeMetricsRepo({ companion }) {
  const pair = companion ? makePairRepo() : { ...makeWorktreeRepo(), docs: null };
  const artifacts = pair.docs ?? pair.repo;
  const header = (status) => `status: ${status}\nbranch: feature/xray\nnext-step: ""`;
  const step = (hhmm, status) => {
    writeRoadmap(artifacts, METRICS_X, header(status), postShipSteps(false));
    commitAt(artifacts, `docs(feature): xray ${status}`, atUtc(hhmm));
  };
  const verdict = (hhmm, value) => {
    fs.writeFileSync(path.join(artifacts, METRICS_X, "review.md"), `# Review: xray\n\nVerdict: ${value}\n\nRound at ${hhmm}.\n`);
    commitAt(artifacts, `docs(feature): review xray — ${value}`, atUtc(hhmm));
  };
  git(artifacts, "switch", "-q", "-c", "feature/xray");
  step("10:00", "planned");
  step("11:00", "in-progress");
  step("13:00", "in-review");
  verdict("13:30", "request-changes");
  step("14:00", "paused");
  step("14:30", "in-progress");
  step("15:00", "in-review");
  verdict("15:30", "approve");
  step("16:00", "complete");
  const merge = (clone, hhmm, pr) => {
    git(clone, "switch", "-q", "main");
    execFileSync("git", ["-C", clone, "merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from owner/feature/xray`, "feature/xray"], { env: { ...process.env, GIT_AUTHOR_DATE: atUtc(hhmm), GIT_COMMITTER_DATE: atUtc(hhmm) } });
  };
  if (companion) {
    git(pair.repo, "switch", "-q", "-c", "feature/xray");
    commitAt(pair.repo, "feat: xray", atUtc("15:45"));
    merge(artifacts, "16:20", 8);
  }
  merge(pair.repo, "16:30", 7);
  writeRoadmap(artifacts, METRICS_X, header("complete"), postShipSteps(true));
  commitAt(artifacts, "docs(feature): xray post-ship 2.1", atUtc("18:00"));
  for (const clone of new Set([artifacts, pair.repo])) git(clone, "push", "-q", "origin", "main");

  git(pair.repo, "worktree", "add", "-q", "-b", "feature/yank", path.join(pair.wt, "feature-yank"));
  const half = companion ? path.join(pair.docsWt, "feature-yank") : path.join(pair.wt, "feature-yank");
  if (companion) git(pair.docs, "worktree", "add", "-q", "-b", "feature/yank", half);
  for (const [hhmm, status] of [["19:00", "planned"], ["20:00", "in-progress"]]) {
    writeRoadmap(half, METRICS_Y, `status: ${status}\nbranch: feature/yank\nnext-step: "1.2"`);
    commitAt(half, `docs(feature): yank ${status}`, atUtc(hhmm));
  }
  git(half, "push", "-q", "-u", "origin", "feature/yank");
  return { repo: pair.repo, docs: pair.docs, artifacts, half };
}

const closedAt = (from, to, seconds) => ({ start: isoUtc(from), end: isoUtc(to), seconds, open: false });

function expectedMetricsX(product) {
  const status = (hhmm, value) => ({ at: isoUtc(hhmm), kind: "status", value });
  return {
    type: "feature",
    slug: "xray",
    dir: METRICS_X,
    roadmap: `${METRICS_X}/roadmap.md`,
    branch: "feature/xray",
    status: "complete",
    ref: "origin/main",
    events: [
      status("10:00", "planned"),
      status("11:00", "in-progress"),
      status("13:00", "in-review"),
      { at: isoUtc("13:30"), kind: "review", value: "request-changes" },
      status("14:00", "paused"),
      status("14:30", "in-progress"),
      status("15:00", "in-review"),
      { at: isoUtc("15:30"), kind: "review", value: "approve" },
      status("16:00", "complete"),
      { at: isoUtc("18:00"), kind: "post-ship-tick", value: "2.1" },
    ],
    phases: { planned: closedAt("10:00", "11:00", 3600), build: closedAt("11:00", "13:00", 7200), review: closedAt("13:00", "16:00", 10800) },
    cycle: closedAt("10:00", "16:00", 21600),
    reviewRounds: 1,
    pauses: { count: 1, seconds: 1800, open: false },
    merged: { at: isoUtc("16:30"), sha: git(product, "log", "-1", "--merges", "--format=%H", "origin/main"), pr: 7 },
    postShip: { total: 1, ticked: 1, lastTickAt: isoUtc("18:00"), latencySeconds: 5400, pending: false },
    warnings: [],
  };
}

const withoutShas = (item) => ({ ...item, events: item.events.map(({ sha, ...event }) => event) });

test("metrics derives phases, rounds, pauses, the merge, and post-ship latency from fixed-date history in both layouts", () => {
  for (const companion of [false, true]) {
    const { repo, artifacts } = makeMetricsRepo({ companion });
    const { code, json } = run(repo, "metrics");
    assert.equal(code, 0, JSON.stringify(json));
    assert.deepEqual(Object.keys(json), ["status", "generatedAt", "ref", "items", "aggregate", "root", "configSource"]);
    assert.equal(json.status, "ok");
    assert.ok(!Number.isNaN(Date.parse(json.generatedAt)));
    assert.deepEqual(json.ref, { artifacts: "origin/main", product: "origin/main" });
    assert.deepEqual(json.items.map((i) => i.slug), run(repo, "status").json.items.map((i) => i.slug));
    assert.deepEqual(json.items.map((i) => [i.slug, i.status]), [["yank", "in-progress"], ["xray", "complete"]]);
    const [y, x] = json.items;
    assert.deepEqual(withoutShas(x), expectedMetricsX(repo), `companion: ${companion}`);
    assert.ok(x.events.every((e) => git(artifacts, "cat-file", "-t", e.sha) === "commit"));

    // The in-flight item's events come from its branch only, read from origin/feature/yank.
    assert.equal(y.ref, "origin/feature/yank");
    assert.deepEqual(y.events.map((e) => [e.at, e.value]), [[isoUtc("19:00"), "planned"], [isoUtc("20:00"), "in-progress"]]);
    assert.deepEqual(y.phases.planned, closedAt("19:00", "20:00", 3600));
    assert.equal(y.phases.build.open, true);
    assert.equal(y.phases.build.end, null);
    assert.equal(y.phases.build.seconds, Math.round((Date.parse(json.generatedAt) - Date.parse(atUtc("20:00"))) / 1000));
    assert.equal(y.phases.review, null);
    assert.equal(y.cycle.open, true);
    assert.equal(y.merged, null);
    assert.deepEqual(y.warnings, []);

    assert.deepEqual(json.aggregate, {
      count: 2,
      complete: 1,
      median: { plannedSeconds: 3600, buildSeconds: 7200, reviewSeconds: 10800, cycleSeconds: 21600, pauseSeconds: 1800, reviewRounds: 1, postShipLatencySeconds: 5400 },
    });

    const one = run(repo, "metrics", "xray");
    assert.equal(one.code, 0);
    assert.deepEqual(one.json.items.map(withoutShas), [expectedMetricsX(repo)]);
    assert.deepEqual(one.json.aggregate.count, 1);
    const missing = run(repo, "metrics", "nope");
    assert.equal(missing.code, 3);
    assert.equal(missing.json.status, "missing");
    assert.match(missing.json.message, /No roadmap for slug nope/);

    // The dashboard carries the same document, read through its asynchronous logs.
    for (const pr of [false, true]) {
      const dash = runWith({ cwd: repo, env: restrictedPath({ gh: prStub(path.join(path.dirname(repo), "gh-calls")) }).env }, "dashboard", ...(pr ? ["--pr"] : []));
      assert.equal(dash.code, 0);
      assert.deepEqual(stableMetrics(dash.json.metrics), stableMetrics(json));
      assert.deepEqual(withoutShas(dash.json.metrics.items[1]), expectedMetricsX(repo));
    }
  }
});

test("metrics never invokes gh and reads history only through git log in the artifacts and product clones", () => {
  for (const companion of [false, true]) {
    const { repo, artifacts } = makeMetricsRepo({ companion });
    const marker = path.join(path.dirname(repo), "gh-called");
    const { log, env } = gitLoggingPath({ gh: `#!/bin/sh\necho "$*" >> ${JSON.stringify(marker)}\nexit 99\n` });
    const { code, json } = runWith({ cwd: repo, env }, "metrics");
    assert.equal(code, 0);
    assert.deepEqual(json.items.map((i) => i.slug), ["yank", "xray"]);
    assert.ok(!fs.existsSync(marker), "gh was invoked");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls.filter((l) => / (fetch|push|pull|ls-remote|remote) /.test(` ${l} `)), [], "no network git calls");
    const logs = calls.map((l) => l.match(/^-C (\S+) log (.*)$/)).filter(Boolean).map(([, dir, args]) => [fs.realpathSync(dir), args.split(" ")[0]]);
    const docsDir = fs.realpathSync(artifacts);
    const productDir = fs.realpathSync(repo);
    assert.deepEqual(logs.sort(), [[docsDir, "origin/feature/yank"], [docsDir, "origin/main"], [productDir, "--first-parent"]].sort());
  }
});
