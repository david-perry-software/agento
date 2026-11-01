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
