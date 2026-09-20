import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LIFECYCLES } from "./session-state.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "scripts", "agento.mjs");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// A working clone with a bare origin, so remote fallbacks exercise real git.
// `companion: true` adds a sibling `<base>/project-docs` clone (own bare origin,
// `main` pushed) for artifacts.repo tests; the caller sets the config key.
function makeRepo({ config, companion = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-cli-"));
  const work = cloneWithOrigin(base, "project", config);
  if (companion) cloneWithOrigin(base, "project-docs");
  return work;
}

function cloneWithOrigin(base, name, config) {
  const origin = path.join(base, `${name}.git`);
  const work = path.join(base, name);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");
  if (config) {
    fs.mkdirSync(path.join(work, ".github"), { recursive: true });
    fs.writeFileSync(path.join(work, ".github", "agento.json"), JSON.stringify(config));
    git(work, "add", "-A");
  }
  git(work, "commit", "-q", "--allow-empty", "-m", "init");
  git(work, "push", "-q", "-u", "origin", "main");
  return work;
}

const companionOf = (repo) => path.join(path.dirname(repo), "project-docs");

function writeRoadmap(root, rel, header, steps = "- [x] 1.1 done — verify: x\n- [ ] 1.2 todo — verify: y\n") {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "roadmap.md"), "```yaml\n" + header + "\n```\n\n## Phase 1\n\n" + steps);
}

// features: [{ slug, requires?, recommendedAfter?, wave? }] in listed order; the
// header defaults to the initiative slug derived from the directory name.
function writeBreakdown(root, rel, header, features) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const list = (v) => (v && v.length ? v.join(", ") : "none");
  const blocks = features
    .map((f) => [`### ${f.slug}`, `- Summary: ${f.slug}`, `- Requires: ${list(f.requires)}`, `- Recommended after: ${list(f.recommendedAfter)}`, ...(f.wave ? [`- Wave: ${f.wave}`] : []), "- Size: S"].join("\n"))
    .join("\n\n");
  const yaml = header ?? `initiative: ${path.basename(rel)}\ncreated: 2026-09-01\nlast-updated: 2026-09-02`;
  fs.writeFileSync(
    path.join(dir, "breakdown.md"),
    "```yaml\n" + yaml + "\n```\n\n# Title\n\n## Goal\n\ng\n\n## Features\n\n" + blocks + "\n\n## Recommended order\n\no\n",
  );
}

function run(cwd, ...args) {
  return runWith({ cwd }, ...args);
}

// CI itself runs under GITHUB_ACTIONS=true; strip the hosted markers so the
// path-based role assertions hold everywhere, and inject them only on purpose.
const baseEnv = { ...process.env };
delete baseEnv.CODESPACES;
delete baseEnv.GITHUB_ACTIONS;

function runWith({ cwd, env }, ...args) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: env ?? baseEnv });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(`non-JSON output: ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
}

// A PATH holding only node and git (plus any extra executables), so gh lookups are deterministic.
function restrictedPath(extra = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-bin-"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(bin, "git"));
  for (const [name, script] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return { bin, env: { ...baseEnv, PATH: bin } };
}

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

// --- artifacts.repo (companion checkout) -------------------------------------

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

// In-repo primary; product `feature/flip` commits only the companion config; the
// companion's `feature/flip` (pushed to its origin) carries the roadmap.
function makeFlipRepo() {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" } }, companion: true });
  const docs = companionOf(repo);
  fs.mkdirSync(path.join(path.dirname(repo), "wt"));
  git(repo, "switch", "-q", "-c", "feature/flip");
  fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: flip to companion");
  git(repo, "push", "-q", "-u", "origin", "feature/flip");
  git(repo, "switch", "-q", "main");
  git(docs, "switch", "-q", "-c", "feature/flip");
  writeRoadmap(docs, "features/2026/09/flip", "status: in-review\nbranch: feature/flip\nnext-step: review\nartifact-pr: \"#7\"");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "docs(feature): flip");
  git(docs, "push", "-q", "-u", "origin", "feature/flip");
  git(docs, "switch", "-q", "main");
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  assert.ok(!fs.existsSync(path.join(repo, "features")));
  return { repo, docs };
}

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

// --- paired worktrees (companion mode) -----------------------------------------

// Product `<base>/project` (worktrees in ../wt) + companion `<base>/project-docs`
// (halves in ../project-docs-worktrees). Returns the paths the pair tests share.
function makePairRepo(extraConfig = {}) {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } }, ...extraConfig }, companion: true });
  const base = path.dirname(repo);
  const docs = companionOf(repo);
  const wt = path.join(base, "wt");
  const docsWt = path.join(base, "project-docs-worktrees");
  fs.mkdirSync(wt);
  fs.mkdirSync(docsWt);
  return { repo, docs, wt, docsWt };
}

const strip = (record) => {
  const { companion, workspace, worktrees, warnings, ...rest } = record;
  return rest;
};

test("paths in companion mode adds the companion half and the workspace file; in-repo mode reports null", () => {
  const { repo, docsWt, wt } = makePairRepo();
  for (const [kind, id, branch] of [["plan", "20260916-1", null], ["feature", "widget", "feature/widget"], ["issue", "bug", "issue/bug"], ["freehand", "tidy", "changes/tidy"]]) {
    const { code, json } = run(repo, "paths", kind, id);
    assert.equal(code, 0);
    assert.equal(json.worktree, path.join(wt, `${kind}-${id}`));
    assert.equal(json.branch, branch);
    assert.deepEqual(json.companion, { worktreesDir: docsWt, worktree: path.join(docsWt, `${kind}-${id}`), branch });
    assert.equal(json.workspace, path.join(wt, `${kind}-${id}.code-workspace`));
    assert.equal(json.layout, "checkout");
  }
  const inRepo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  for (const [kind, id] of [["plan", "20260916-1"], ["feature", "widget"], ["freehand", "tidy"]]) {
    const json = run(inRepo, "paths", kind, id).json;
    assert.equal(json.status, "ok");
    assert.equal(json.companion, null);
    assert.equal(json.workspace, null);
    assert.equal(json.layout, "checkout");
    assert.equal(json.artifactsRoot, inRepo);
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
  assert.deepEqual(flip.companion, { worktreesDir: docsWt, worktree: path.join(docsWt, "feature-flip"), branch: "feature/flip" });
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

  // The primary and the companion clone: primary → primary with companion: null; clone → unmanaged, anchored on the product primary.
  const primary = run(repo, "session").json;
  assert.equal(primary.role, "primary");
  assert.equal(primary.companion, null);
  assert.equal(primary.workspace, null);
  const clone = run(docs, "session").json;
  assert.equal(clone.role, "unmanaged");
  assert.equal(clone.root, repo);
  assert.match(clone.warnings[0], /^anchored-from-companion: /);
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

test("doctor artifact-repo warns when the companion worktrees dir exists but is not writable", () => {
  const { repo, docsWt } = makePairRepo();
  const { env } = restrictedPath(okStubs);
  const check = () => byId(runWith({ cwd: repo, env }, "doctor").json)["artifact-repo"];
  assert.equal(check().status, "ok");
  fs.chmodSync(docsWt, 0o555);
  try {
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const warned = check();
    assert.equal(warned.status, "warn");
    assert.match(warned.detail, new RegExp(`main present; ${docsWt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} not writable$`));
    assert.match(warned.fallback, /companion half of every paired session/);
  } finally {
    fs.chmodSync(docsWt, 0o755);
  }
  assert.equal(check().status, "ok");
  // Absent dir: nothing to check.
  fs.rmdirSync(docsWt);
  assert.equal(check().status, "ok");
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
  assert.deepEqual(widget.allowed, ["/agento continue", "/agento build-feature widget", "/agento ap widget", "/agento delivery-status"]);
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
    assert.deepEqual(item.pr, { number: 15, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", url: "https://example.test/pr/15" });
    assert.equal(item.companionPr, null);
  }
  const done = withPr.json.items.find((i) => i.slug === "done");
  assert.equal(done.pr, null);
  assert.equal(done.companionPr, null);
  assert.equal(done.lifecycle, "shipped");
  assert.deepEqual(withPr.json.warnings, []);
  assert.deepEqual(
    calls().sort(),
    [`${repo} pr view feature/alpha --json number,state,isDraft,mergeStateStatus,url`, `${repo} pr view issue/bug --json number,state,isDraft,mergeStateStatus,url`],
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
    [`${pair.repo} pr view feature/widget --json number,state,isDraft,mergeStateStatus,url`, `${pair.docs} pr view feature/widget --json number,state,isDraft,mergeStateStatus,url`],
  );
  assert.deepEqual(both.json.warnings, []);

  assert.match(run(repo).json.usage.join("\n"), /status \[feature\|issue\] \[slug\] \[--pr\]/);
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

const okStubs = {
  gh: "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh version 9.9.9'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'Logged in' >&2; exit 0; fi\nexit 1\n",
  code: "#!/bin/sh\necho 1.99.0\n",
  python3: "#!/bin/sh\necho 'Python 3.12.0'\n",
};

const byId = (json) => Object.fromEntries(json.checks.map((c) => [c.id, c]));

test("doctor reports eight checks and includes session-workspace", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: repo, env }, "doctor");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.for, null);
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "git-remote", "gh", "code", "python3", "worktrees-dir", "session-workspace", "artifact-repo"]);
  for (const check of json.checks) {
    assert.equal(check.status, "ok", JSON.stringify(check));
    assert.equal(typeof check.detail, "string");
    assert.equal(check.fallback, null);
  }
  const checks = byId(json);
  assert.match(checks.gh.detail, /gh version 9\.9\.9; authenticated/);
  assert.match(checks["git-remote"].detail, /main reachable/);
  assert.match(checks["worktrees-dir"].detail, /project-worktrees absent; .* writable, it will be created/);
  assert.equal(checks["artifact-repo"].detail, "in-repo layout (artifacts.repo unset)");
  assert.equal(checks["session-workspace"].detail, "not a managed pair");
});

test("doctor session-workspace is ok for non-pairs, warn for stale/missing, and ok after workspace --write", () => {
  const { repo, docs, wt, docsWt } = makePairRepo();
  const { env } = restrictedPath(okStubs);

  // Non-pair: primary checkout reports ok with a neutral detail.
  const primaryCheck = byId(runWith({ cwd: repo, env }, "doctor").json)["session-workspace"];
  assert.equal(primaryCheck.status, "ok");
  assert.equal(primaryCheck.detail, "not a managed pair");

  // Pair: build worktree with no workspace file warns.
  const product = path.join(wt, "feature-widget");
  const half = path.join(docsWt, "feature-widget");
  git(repo, "worktree", "add", "-q", "-b", "feature/widget", product);
  git(docs, "worktree", "add", "-q", "-b", "feature/widget", half);
  writeRoadmap(half, "features/2026/09/widget", "status: in-progress\nbranch: feature/widget\nnext-step: \"1.2\"");

  const missing = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(missing.status, "warn");
  assert.match(missing.detail, /feature-widget\.code-workspace lacks the session auto-approve settings$/);
  assert.match(missing.fallback, /workspace feature widget --write, then Developer: Reload Window$/);

  // Stale file still warns.
  const workspacePath = path.join(wt, "feature-widget.code-workspace");
  fs.writeFileSync(workspacePath, "{}\n");
  const stale = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(stale.status, "warn");

  // CLI-written canonical file is ok.
  run(repo, "workspace", "feature", "widget", "--write");
  const current = byId(runWith({ cwd: product, env }, "doctor", "--for", "start-session").json)["session-workspace"];
  assert.equal(current.status, "ok");
  assert.match(current.detail, /feature-widget\.code-workspace carries the session auto-approve settings$/);
});

test("doctor artifact-repo passes a valid companion, fails a missing or broken one naming /agento agento-init, and warns on stale in-repo roots", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: "project-docs" } } }, companion: true });
  const docs = companionOf(repo);
  const { env } = restrictedPath(okStubs);
  const check = (...args) => {
    const result = runWith({ cwd: repo, env }, "doctor", ...args);
    return { code: result.code, status: result.json.status, check: byId(result.json)["artifact-repo"] };
  };

  const valid = check();
  assert.equal(valid.code, 0);
  assert.deepEqual(valid.check, { id: "artifact-repo", status: "ok", detail: `${docs} (project-docs), origin ${path.join(path.dirname(repo), "project-docs.git")}, main present`, fallback: null });

  // Stale pre-migration roots in the product repo: ignored by readers, surfaced once here.
  fs.mkdirSync(path.join(repo, "initiatives"), { recursive: true });
  fs.writeFileSync(path.join(repo, "initiatives", ".gitkeep"), "");
  assert.equal(check().check.status, "ok", "a .gitkeep-only root is not stale");
  writeRoadmap(repo, "features/2026/09/stale", "status: complete\nbranch: feature/stale");
  fs.mkdirSync(path.join(repo, "issues", "2026", "09", "old"), { recursive: true });
  fs.writeFileSync(path.join(repo, "issues", "2026", "09", "old", "plan.md"), "# old\n");
  const stale = check();
  assert.equal(stale.code, 0);
  assert.equal(stale.status, "warn");
  assert.equal(stale.check.status, "warn");
  assert.match(stale.check.detail, /main present; stale in-repo roots: features\/, issues\/$/);
  assert.match(stale.check.fallback, /agento agento-init --migrate/);

  // Default branch missing from the companion.
  git(docs, "branch", "-m", "main", "trunk");
  git(docs, "update-ref", "-d", "refs/remotes/origin/main");
  const noBranch = check("--for", "close-session");
  assert.equal(noBranch.code, 3);
  assert.equal(noBranch.check.status, "fail");
  assert.match(noBranch.check.detail, /neither origin\/main nor main/);
  assert.match(noBranch.check.fallback, /`\/agento agento-init`.*project-docs/);

  // No origin remote.
  git(docs, "remote", "remove", "origin");
  assert.match(check().check.detail, /no `origin` remote/);

  // Not a git checkout toplevel (a plain directory), then absent altogether.
  fs.rmSync(path.join(docs, ".git"), { recursive: true, force: true });
  const notRepo = check();
  assert.equal(notRepo.check.status, "fail");
  assert.match(notRepo.check.detail, /not a git checkout toplevel/);
  fs.rmSync(docs, { recursive: true, force: true });
  const absent = check();
  assert.equal(absent.code, 3);
  assert.equal(absent.check.status, "fail");
  assert.equal(absent.check.detail, `${docs} absent`);
  assert.match(absent.check.fallback, /run `\/agento agento-init` to create and clone the companion repository project-docs at /);
});

test("doctor fails with exit 3 and the install or reauth fallback when gh is missing or unauthenticated", () => {
  const repo = makeRepo();
  const { env, bin } = restrictedPath({ code: okStubs.code, python3: okStubs.python3 });

  const missing = runWith({ cwd: repo, env }, "doctor");
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "fail");
  const gh = byId(missing.json).gh;
  assert.equal(gh.status, "fail");
  assert.match(gh.detail, /gh CLI not found on PATH/);
  assert.match(gh.fallback, /install GitHub CLI/);
  // Every other check is unaffected by the failing one.
  assert.deepEqual(missing.json.checks.filter((c) => c.id !== "gh").map((c) => c.status), ["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);

  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh version 9.9.9'; exit 0; fi\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n", { mode: 0o755 });
  const unauth = runWith({ cwd: repo, env }, "doctor");
  assert.equal(unauth.code, 3);
  const auth = byId(unauth.json).gh;
  assert.equal(auth.status, "fail");
  assert.match(auth.detail, /gh auth status failed: You are not logged into any GitHub hosts/);
  assert.match(auth.fallback, /`gh auth login`/);
});

test("doctor warns (exit 0) when code or python3 is missing and reports their fallbacks", () => {
  const repo = makeRepo();
  const { env } = restrictedPath({ gh: okStubs.gh });
  const { code, json } = runWith({ cwd: repo, env }, "doctor");
  assert.equal(code, 0);
  assert.equal(json.status, "warn");
  const checks = byId(json);
  assert.equal(checks.code.status, "warn");
  assert.match(checks.code.detail, /code CLI not found/);
  assert.match(checks.code.fallback, /code --new-window <worktree-path>/);
  assert.equal(checks.python3.status, "warn");
  assert.match(checks.python3.detail, /python3 not found/);
  assert.match(checks.python3.fallback, /hooks do not run/);
  assert.equal(checks.gh.status, "ok");
});

test("doctor fails without an origin remote and warns when origin is unreachable", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);

  git(repo, "remote", "set-url", "origin", path.join(path.dirname(repo), "does-not-exist.git"));
  const unreachable = runWith({ cwd: repo, env }, "doctor");
  assert.equal(unreachable.code, 0);
  assert.equal(unreachable.json.status, "warn");
  const remote = byId(unreachable.json)["git-remote"];
  assert.equal(remote.status, "warn");
  assert.match(remote.detail, /^origin .*does-not-exist\.git unreachable: /);
  assert.match(remote.fallback, /work offline/);

  git(repo, "remote", "remove", "origin");
  const none = runWith({ cwd: repo, env }, "doctor");
  assert.equal(none.code, 3);
  assert.equal(none.json.status, "fail");
  const missing = byId(none.json)["git-remote"];
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /no `origin` remote/);
  assert.match(missing.fallback, /git remote add origin/);
});

test("doctor --for runs only the command's declared checks and reports its needs", () => {
  const repo = makeRepo();
  const marker = path.join(path.dirname(repo), "gh-invoked");
  const { env } = restrictedPath({
    ...okStubs,
    gh: `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n${okStubs.gh.replace("#!/bin/sh\n", "")}`,
  });

  const local = runWith({ cwd: repo, env }, "doctor", "--for", "close-session");
  assert.equal(local.code, 0);
  assert.deepEqual(local.json.for, { command: "close-session", needs: ["terminal"] });
  assert.deepEqual(local.json.checks.map((c) => c.id), ["node", "python3", "worktrees-dir", "session-workspace", "artifact-repo"]);
  assert.ok(!fs.existsSync(marker), "gh was invoked for a terminal-only command");

  const ship = runWith({ cwd: repo, env }, "doctor", "--for", "ship");
  assert.equal(ship.code, 0);
  assert.deepEqual(ship.json.for, { command: "ship", needs: ["terminal", "gh", "network"] });
  assert.deepEqual(ship.json.checks.map((c) => c.id), ["node", "git-remote", "gh", "python3", "worktrees-dir", "session-workspace", "artifact-repo"]);
  assert.match(fs.readFileSync(marker, "utf8"), /auth status/);

  const unknown = runWith({ cwd: repo, env }, "doctor", "--for", "nope");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.json.status, "usage-error");
  assert.match(unknown.json.message, /unknown command nope/);
});

// Primary clone plus managed worktrees under <base>/wt (worktrees.dir: ../wt).
function makeWorktreeRepo() {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  const wt = path.join(path.dirname(repo), "wt");
  fs.mkdirSync(wt);
  return { repo, wt };
}

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
  // The build row applies: no roadmap yet, so only delivery-status here and start-session elsewhere.
  assert.equal(actions.lifecycle, "no-delivery");
  assert.deepEqual(actions.allowed, ["/agento continue", "/agento delivery-status"]);
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
  assert.match(fs.readFileSync(marker, "utf8"), /pr view feature\/widget --json number,state,isDraft,mergeStateStatus,url/);

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

// A stub gh answering `pr view` with a per-repo state: `product` for the product
// checkout, `companion` for anything under project-docs. Logs `$PWD $*` to marker.
function prStub(marker, { product = "OPEN", companion = "OPEN", companionMerge = "CLEAN" } = {}) {
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho "$PWD $*" >> ${JSON.stringify(marker)}\ncase "$PWD" in *project-docs*) n=7; s=${companion}; m=${companionMerge};; *) n=15; s=${product}; m=CLEAN;; esac\nif [ "$s" = "NONE" ]; then echo 'no pull requests found for branch' >&2; exit 1; fi\necho "{\\"number\\":$n,\\"state\\":\\"$s\\",\\"isDraft\\":false,\\"mergeStateStatus\\":\\"$m\\",\\"url\\":\\"https://example.test/pr/$n\\"}"\n`;
}

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
  assert.match(inRepoCalls[0], new RegExp(`^${repo} pr view feature/widget --json number,state,isDraft,mergeStateStatus,url$`));

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
  assert.deepEqual(both.json.pr, { number: 15, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", url: "https://example.test/pr/15" });
  assert.deepEqual(both.json.companionPr, { number: 7, state: "OPEN", isDraft: false, mergeStateStatus: "CLEAN", url: "https://example.test/pr/7" });
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
  assert.deepEqual(shipWith({ companionMerge: "CONFLICTING" }).json.companionGaps, ["conflicting-pr"]);
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

// --- next -------------------------------------------------------------------

// Commits with a fixed clock so review-freshness comparisons are deterministic.
function commitAt(dir, message, iso) {
  git(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
}

const T1 = "2026-09-10T10:00:00Z";
const T2 = "2026-09-10T11:00:00Z";
const T3 = "2026-09-10T12:00:00Z";

function assertDispatch(json, agentExpected) {
  assert.ok(json.dispatch, "dispatch missing");
  assert.equal(json.dispatch.prompt, path.join(repoRoot, "commands", `${json.next.command}.md`));
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

// --- migrate ------------------------------------------------------------------

// An in-repo product with one feature (plan, roadmap, binary evidence), one issue,
// and one initiative, all committed on main so the tree is clean before the move.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x7f]);
function seedInRepoTree(repo, { config } = {}) {
  writeRoadmap(repo, "features/2026/09/x", 'status: in-progress\nbranch: feature/x\ninitiative: "init"\nnext-step: "1.2 todo"');
  fs.writeFileSync(path.join(repo, "features/2026/09/x/plan.md"), "# x\n");
  fs.mkdirSync(path.join(repo, "features/2026/09/x/evidence"), { recursive: true });
  fs.writeFileSync(path.join(repo, "features/2026/09/x/evidence/step-1-1-x.png"), PNG);
  writeRoadmap(repo, "issues/2026/09/bug", "status: planned\nbranch: issue/bug\nnext-step: \"1.1\"");
  writeBreakdown(repo, "initiatives/2026/09/init", null, [{ slug: "x" }, { slug: "y", requires: ["x"] }]);
  if (config) {
    fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify(config));
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed artifacts");
}

const porcelain = (dir) => git(dir, "status", "--porcelain");

test("migrate: the dry run lists both roots' files and the records and writes nothing", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  const { code, json } = run(repo, "migrate", docs);
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "dry-run");
  assert.equal(json.source, repo);
  assert.equal(json.destination, docs);
  assert.equal(json.clone, docs);
  assert.equal(json.name, "project-docs");
  assert.equal(json.configSet, false);
  assert.deepEqual(json.roots.map((r) => [r.rel, r.files]), [["features", 3], ["issues", 1], ["initiatives", 1]]);
  assert.ok(json.roots.every((r) => r.bytes > 0));
  assert.deepEqual(json.conflicts, []);
  assert.deepEqual(json.records.roadmaps.map((r) => [r.type, r.slug, r.roadmap]), [
    ["feature", "x", "features/2026/09/x/roadmap.md"],
    ["issue", "bug", "issues/2026/09/bug/roadmap.md"],
  ]);
  assert.deepEqual(json.records.breakdowns, [{ slug: "init", dir: "initiatives/2026/09/init", breakdown: "initiatives/2026/09/init/breakdown.md", features: ["x", "y"] }]);
  assert.equal(porcelain(repo), "");
  assert.equal(porcelain(docs), "");
  assert.ok(!fs.existsSync(path.join(repo, ".github", "agento.json")));
});

test("migrate: a destination conflict exits 3 naming the file and writes nothing", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  writeRoadmap(docs, "features/2026/09/x", "status: planned\nbranch: feature/x\nnext-step: \"1.1\"");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "pre-existing");
  // .gitkeep placeholders (the init scaffold) never count as conflicts.
  fs.mkdirSync(path.join(docs, "issues"), { recursive: true });
  fs.writeFileSync(path.join(docs, "issues", ".gitkeep"), "");
  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 3);
  assert.equal(json.status, "conflict");
  assert.equal(json.mode, "apply");
  assert.deepEqual(json.conflicts, ["features/2026/09/x/roadmap.md"]);
  assert.match(json.message, /nothing was written/);
  assert.equal(porcelain(repo), "");
  assert.ok(fs.existsSync(path.join(repo, "features/2026/09/x/roadmap.md")));
  assert.ok(!fs.existsSync(path.join(docs, "features/2026/09/x/plan.md")));
  assert.ok(!fs.existsSync(path.join(repo, ".github", "agento.json")));
});

test("migrate --apply moves the tree byte-identically, writes the config from the template, and notes the README once", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  fs.writeFileSync(path.join(docs, "README.md"), "# project-docs\n");
  const before = run(repo, "migrate", docs).json.records;

  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.mode, "applied");
  assert.equal(json.name, "project-docs");
  assert.equal(json.configSet, true);
  assert.deepEqual(json.moved, ["features", "issues", "initiatives"]);
  assert.equal(json.configWritten, path.join(repo, ".github", "agento.json"));
  assert.equal(json.readmeNoteAdded, true);
  assert.equal(json.records.identical, true);
  assert.deepEqual(json.records.diff, []);
  assert.deepEqual(json.records.roadmaps.map((r) => r.slug), before.roadmaps.map((r) => r.slug));
  assert.deepEqual(json.roots.map((r) => [r.rel, r.files]), [["features", 3], ["issues", 1], ["initiatives", 1]]);

  // Source roots are gone; the binary evidence arrived byte-equal.
  for (const rel of ["features", "issues", "initiatives"]) assert.ok(!fs.existsSync(path.join(repo, rel)), `${rel} still present`);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(docs, "features/2026/09/x/evidence/step-1-1-x.png")), PNG), 0);
  assert.ok(fs.existsSync(path.join(docs, "features/2026/09/x/plan.md")));

  // Config created from the plugin template with only the name set.
  const written = JSON.parse(fs.readFileSync(json.configWritten, "utf8"));
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "templates", "agento.json"), "utf8"));
  assert.equal(written.artifacts.repo.name, "project-docs");
  assert.deepEqual(written.branches, template.branches);
  assert.equal(fs.readFileSync(json.configWritten, "utf8").endsWith("}\n"), true);

  // README note appended after the existing content, once.
  const readme = fs.readFileSync(path.join(docs, "README.md"), "utf8");
  assert.ok(readme.startsWith("# project-docs\n"));
  assert.equal(readme.match(/^## Migrated history$/gm).length, 1);
  assert.match(readme, /\/agento agento-init --migrate/);
  assert.match(readme, /`\.\.\/\.\.\/\.\.\/\.\.\/<path>`/);

  // After committing both sides the product reads the companion and sees the same slugs.
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "move");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "import");
  const status = run(repo, "status");
  assert.equal(status.code, 0);
  assert.deepEqual(status.json.items.map((i) => i.slug), before.roadmaps.map((r) => r.slug));
  const init = run(repo, "initiative", "init");
  assert.equal(init.code, 0);
  assert.deepEqual(init.json.features.map((f) => [f.slug, f.state]), [["x", "in-progress"], ["y", "unplanned"]]);
  assert.equal(run(repo, "config").json.artifactsRoot, docs);

  // A second --apply has nothing left to move and leaves the README byte-unchanged.
  const again = run(repo, "migrate", docs, "--apply");
  assert.equal(again.code, 0);
  assert.equal(again.json.mode, "nothing-to-migrate");
  assert.equal(again.json.configSet, true);
  assert.equal(fs.readFileSync(path.join(docs, "README.md"), "utf8"), readme);
  assert.equal(porcelain(docs), "");
});

test("migrate --apply preserves an existing config's other keys", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo, { config: { branches: { default: "trunk" }, worktrees: { dir: "../wt" } } });
  const { code, json } = run(repo, "migrate", docs, "--apply");
  assert.equal(code, 0);
  assert.equal(json.mode, "applied");
  const written = JSON.parse(fs.readFileSync(path.join(repo, ".github", "agento.json"), "utf8"));
  assert.equal(written.branches.default, "trunk");
  assert.equal(written.worktrees.dir, "../wt");
  assert.deepEqual(written.artifacts.repo, { name: "project-docs" });
});

test("migrate --apply into a registered companion half resolves the name from the clone", () => {
  const repo = makeRepo({ companion: true });
  const docs = companionOf(repo);
  seedInRepoTree(repo);
  const half = path.join(path.dirname(repo), "project-docs-worktrees", "plan-1");
  fs.mkdirSync(path.dirname(half), { recursive: true });
  git(docs, "worktree", "add", "-q", "--no-track", "-b", "feature/x", half, "origin/main");

  const dry = run(repo, "migrate", half);
  assert.equal(dry.code, 0);
  assert.equal(dry.json.destination, half);
  assert.equal(dry.json.clone, docs);
  assert.equal(dry.json.name, "project-docs");

  const { code, json } = run(repo, "migrate", half, "--apply");
  assert.equal(code, 0);
  assert.equal(json.mode, "applied");
  assert.equal(json.name, "project-docs");
  assert.ok(fs.existsSync(path.join(half, "features/2026/09/x/roadmap.md")));
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, ".github", "agento.json"), "utf8")).artifacts.repo.name, "project-docs");
  assert.ok(fs.existsSync(path.join(half, "README.md")));
});

test("migrate rejects a non-sibling destination and a non-checkout, writing nothing", () => {
  const repo = makeRepo();
  seedInRepoTree(repo);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "agento-far-"));
  const far = path.join(elsewhere, "other-docs");
  execFileSync("git", ["init", "-q", "-b", "main", far]);
  const { code, json } = run(repo, "migrate", far, "--apply");
  assert.equal(code, 3);
  assert.equal(json.status, "error");
  assert.equal(json.reason, "not-sibling");
  assert.equal(json.clone, far);
  assert.equal(json.primary, repo);
  assert.equal(porcelain(repo), "");
  assert.ok(fs.existsSync(path.join(repo, "features/2026/09/x/roadmap.md")));

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agento-plain-"));
  const notCheckout = run(repo, "migrate", plain);
  assert.equal(notCheckout.code, 3);
  assert.equal(notCheckout.json.reason, "not-a-checkout");

  const usage = run(repo, "migrate");
  assert.ok(usage.json.usage.some((line) => line.includes("migrate <companion-checkout> [--apply]")), JSON.stringify(usage.json.usage));
});
