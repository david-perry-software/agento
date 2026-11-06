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
  assert.ok(!json.allowed.includes("/agento new-feature"), "new-feature runs in a plan window, not the primary");
  assert.deepEqual(json.elsewhere.map((e) => [e.command, e.window]), [["/agento new-feature", "secondary"], ["/agento new-issue", "secondary"]]);
  assert.match(json.elsewhere.map((e) => e.reason).join(" "), /start-session/);
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

function sdkHostChild(half, { sessionId = "orphan-0000-session", extension = "agento-mission-control" } = {}) {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agento-sdk-host-")));
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(tmpDir, "preloads", "extension_bootstrap.mjs")], {
    cwd: half,
    env: { ...process.env, SESSION_ID: sessionId, EXTENSION_PATH: path.join(tmpDir, "extensions", extension, "extension.mjs"), COPILOT_EXTENSION_PARENT_PID: String(process.pid) },
    stdio: "ignore",
  });
}

test("close-session: an orphaned Mission Control SDK host is stopped and the close proceeds", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const env = { ...closeSessionEnv(), COPILOT_AGENT_SESSION_ID: "caller-0000-session" };
  const { half, file } = planPair(pair, "20261009-2");
  const child = sdkHostChild(half);
  await new Promise((resolve) => child.once("spawn", resolve));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const { code, json } = closeSession(repo, env, "20261009-2");
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.outcome, "closed");
    assert.equal(json.applied, true);
    assert.ok(json.stoppedHosts.companion.some((l) => l.includes(`PID ${child.pid}`) && l.includes("Copilot SDK extension host: agento-mission-control")), JSON.stringify(json.stoppedHosts));
    const exit = await exited;
    assert.equal(exit.signal, "SIGTERM", JSON.stringify(exit));
    assert.equal(fs.existsSync(half), false);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test("close-session --dry-run: an orphaned Mission Control SDK host is reported would-stop and stays alive", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const env = { ...closeSessionEnv(), COPILOT_AGENT_SESSION_ID: "caller-0000-session" };
  const { half, file } = planPair(pair, "20261009-3");
  const child = sdkHostChild(half);
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const before = [cloneState(repo, docs), fs.readFileSync(file, "utf8")];
    const { code, json } = closeSession(repo, env, "20261009-3", "--dry-run");
    assert.equal(code, 3, JSON.stringify(json));
    assert.equal(json.status, "blocked");
    assert.equal(json.reason, "occupied");
    assert.equal(json.applied, false);
    assert.ok(json.stoppedHosts.companion.some((l) => l.includes(`PID ${child.pid}`)), JSON.stringify(json.stoppedHosts));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.ok(fs.existsSync(half));
    assert.ok(fs.existsSync(file));
    assert.deepEqual([cloneState(repo, docs), fs.readFileSync(file, "utf8")], before);
  } finally {
    child.kill();
  }
  await new Promise((resolve) => child.once("exit", resolve));
});

test("close-session: a foreign-extension SDK host blocks, names the host label, and ends with the kill command", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const pair = makePairRepo();
  const { repo, docs } = pair;
  const env = { ...closeSessionEnv(), COPILOT_AGENT_SESSION_ID: "caller-0000-session" };
  const { half, file } = planPair(pair, "20261009-4");
  const child = sdkHostChild(half, { sessionId: "orphan-0001-session", extension: "other-ext" });
  await new Promise((resolve) => child.once("spawn", resolve));
  try {
    const before = [cloneState(repo, docs), fs.readFileSync(file, "utf8")];
    const { code, json } = closeSession(repo, env, "20261009-4");
    assert.equal(code, 3, JSON.stringify(json));
    assert.equal(json.status, "blocked");
    assert.equal(json.reason, "occupied");
    assert.deepEqual(json.stoppedHosts, { product: [], companion: [] });
    assert.equal(json.occupants.companion.length, 1);
    assert.match(json.occupants.companion[0], /PID \d+ \(Copilot SDK extension host: other-ext, session orphan-0/);
    assert.match(json.message, new RegExp(`kill ${child.pid}\\.$`));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.deepEqual([cloneState(repo, docs), fs.readFileSync(file, "utf8")], before);
  } finally {
    child.kill();
  }
  await new Promise((resolve) => child.once("exit", resolve));
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
