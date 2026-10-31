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
