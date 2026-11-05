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

test("ship teardown stops an orphaned Mission Control SDK host in a closed worktree and ships (#143 sdk-host-blocks-teardown)", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const fx = mergedPair();
  const { repo, docs, owner, half, workspace, stub } = fx;
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agento-sdk-host-")));
  fs.writeFileSync(path.join(stub.bin, "code"), "#!/bin/sh\nprintf '%s\\n' 'Version:          Code 1.99.0'\n", { mode: 0o755 });
  const env = { ...stub.env, COPILOT_AGENT_SESSION_ID: "caller-1111-session" };
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(tmpDir, "preloads", "extension_bootstrap.mjs")], {
    cwd: half,
    env: { ...process.env, SESSION_ID: "orphan-0000-session", EXTENSION_PATH: path.join(tmpDir, "extensions", "agento-mission-control", "extension.mjs"), COPILOT_EXTENSION_PARENT_PID: String(process.pid) },
    stdio: "ignore",
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const { code, json } = shipRun(repo, env, "feature", "widget");
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.status, "ok");
    assert.equal(json.outcome, "shipped");
    assert.ok(json.actions.some((a) => a.step === "stop-host" && a.detail.includes(`PID ${child.pid}`) && a.detail.includes("session orphan-0")), JSON.stringify(json.actions));
    const exit = await exited;
    assert.equal(exit.signal, "SIGTERM", JSON.stringify(exit));
    assert.equal(fs.existsSync(owner), false);
    assert.equal(fs.existsSync(half), false);
    assert.equal(fs.existsSync(workspace), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
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
