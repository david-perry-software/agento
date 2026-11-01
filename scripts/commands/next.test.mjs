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
