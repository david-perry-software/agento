import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LIFECYCLES, SESSION_WORKSPACE_SETTINGS } from "./session-state.mjs";

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
// Never read the real ~/.config/agento/model-profiles.json.
baseEnv.AGENTO_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agento-config-home-"));

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

const okStubs = {
  gh: "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh version 9.9.9'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'Logged in' >&2; exit 0; fi\nexit 1\n",
  code: "#!/bin/sh\necho 1.99.0\n",
};

const byId = (json) => Object.fromEntries(json.checks.map((c) => [c.id, c]));

test("doctor reports eight checks and includes session-workspace and model-profile", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: repo, env }, "doctor");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.for, null);
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "git-remote", "gh", "code", "worktrees-dir", "session-workspace", "artifact-repo", "model-profile"]);
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
  const { env, bin } = restrictedPath({ code: okStubs.code });

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

test("doctor warns (exit 0) when code is missing and reports its fallback; no Python check remains", () => {
  const repo = makeRepo();
  const { env } = restrictedPath({ gh: okStubs.gh });
  const { code, json } = runWith({ cwd: repo, env }, "doctor");
  assert.equal(code, 0);
  assert.equal(json.status, "warn");
  const checks = byId(json);
  assert.equal(checks.code.status, "warn");
  assert.match(checks.code.detail, /code CLI not found/);
  assert.match(checks.code.fallback, /code --new-window <worktree-path>/);
  assert.deepEqual(Object.keys(checks).filter((id) => id.startsWith("python")), []);
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
  assert.deepEqual(local.json.checks.map((c) => c.id), ["node", "worktrees-dir", "session-workspace", "artifact-repo"]);
  assert.ok(!fs.existsSync(marker), "gh was invoked for a terminal-only command");

  const ship = runWith({ cwd: repo, env }, "doctor", "--for", "ship");
  assert.equal(ship.code, 0);
  assert.deepEqual(ship.json.for, { command: "ship", needs: ["terminal", "gh", "network"] });
  assert.deepEqual(ship.json.checks.map((c) => c.id), ["node", "git-remote", "gh", "worktrees-dir", "session-workspace", "artifact-repo"]);
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
// checkout, `companion` for anything under project-docs. Logs `$PWD $*` to marker;
// `logVersion` logs the `--version` probe too.
function prStub(marker, { product = "OPEN", companion = "OPEN", companionMerge = "CLEAN", logVersion = false } = {}) {
  const versionLog = logVersion ? `echo "$PWD $*" >> ${JSON.stringify(marker)}; ` : "";
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then ${versionLog}exit 0; fi\necho "$PWD $*" >> ${JSON.stringify(marker)}\ncase "$PWD" in *project-docs*) n=7; s=${companion}; m=${companionMerge};; *) n=15; s=${product}; m=CLEAN;; esac\nif [ "$s" = "NONE" ]; then echo 'no pull requests found for branch' >&2; exit 1; fi\necho "{\\"number\\":$n,\\"state\\":\\"$s\\",\\"isDraft\\":false,\\"mergeStateStatus\\":\\"$m\\",\\"url\\":\\"https://example.test/pr/$n\\"}"\n`;
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

// --- models ---------------------------------------------------------------

// A git-tracked copy of this repository's agents, prompts, command mirrors, and
// profile template, plus a private AGENTO_CONFIG_HOME.
function modelsFixture({ gitInit = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-models-"));
  const plugin = path.join(base, "plugin");
  for (const rel of [".github/agents", ".github/prompts", "commands"]) fs.cpSync(path.join(repoRoot, rel), path.join(plugin, rel), { recursive: true });
  fs.mkdirSync(path.join(plugin, "templates"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "templates", "model-profiles.json"), path.join(plugin, "templates", "model-profiles.json"));
  if (gitInit) {
    execFileSync("git", ["init", "-q", "-b", "main", plugin]);
    git(plugin, "config", "user.email", "test@example.com");
    git(plugin, "config", "user.name", "Test");
    git(plugin, "add", "-A");
    git(plugin, "commit", "-q", "-m", "init");
  }
  const home = path.join(base, "config");
  const env = { ...baseEnv, AGENTO_CONFIG_HOME: home };
  const models = (...args) => runWith({ cwd: plugin, env }, "models", ...args, "--plugin-root", plugin);
  const writeProfiles = (profiles) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "model-profiles.json"), JSON.stringify({ profiles }));
  };
  return { plugin, home, env, models, writeProfiles };
}

test("models list without a profiles file reports nothing applied", () => {
  const { plugin, home, models } = modelsFixture();
  const { code, json } = models();
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.verb, "list");
  assert.deepEqual(json.profiles, []);
  assert.deepEqual(json.profilesFile, { path: path.join(home, "model-profiles.json"), exists: false });
  assert.equal(json.pluginRoot, plugin);
  assert.equal(json.active, null);
  assert.deepEqual(json.skipWorktree, []);
  assert.deepEqual(json.dirty, []);
  assert.match(json.hint, /models clear.*git pull.*models apply/);
});

test("models init copies the template once; show reports placeholders and unknown profiles", () => {
  const { home, models } = modelsFixture();
  const first = models("init");
  assert.equal(first.code, 0);
  assert.equal(first.json.created, true);
  assert.equal(first.json.profilesFile.exists, true);
  const file = path.join(home, "model-profiles.json");
  assert.equal(fs.readFileSync(file, "utf8"), fs.readFileSync(path.join(repoRoot, "templates", "model-profiles.json"), "utf8"));
  fs.appendFileSync(file, " ");
  const second = models("init");
  assert.equal(second.code, 0);
  assert.equal(second.json.created, false);
  assert.match(fs.readFileSync(file, "utf8"), / $/);

  const list = models("list");
  assert.deepEqual(list.json.profiles.map((p) => p.name), ["mixed"]);
  assert.ok(list.json.profiles[0].errors.length > 0);

  const show = models("show", "mixed");
  assert.equal(show.code, 3);
  assert.equal(show.json.status, "invalid");
  assert.ok(show.json.errors.every((e) => /placeholder/.test(e)), JSON.stringify(show.json.errors));

  const unknown = models("show", "nope");
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.status, "not-found");
  assert.deepEqual(unknown.json.known, ["mixed"]);
});

test("models show resolves agents, inherited prompts, and mirrors", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap", agents: { planner: "Strong" }, prompts: { doctor: "Tiny" } } });
  const { code, json } = models("show", "mixed");
  assert.equal(code, 0, JSON.stringify(json));
  const value = (file) => json.targets.find((t) => t.file === file)?.value;
  assert.equal(value(".github/agents/delivery-planner.agent.md"), "Strong");
  assert.equal(value(".github/agents/delivery-builder.agent.md"), "Cheap");
  assert.equal(value(".github/prompts/new-feature.prompt.md"), "Strong");
  assert.equal(value("commands/new-feature.md"), "Strong");
  assert.equal(value(".github/prompts/doctor.prompt.md"), "Tiny");
  assert.equal(value("commands/doctor.md"), "Tiny");
  assert.equal(value(".github/prompts/start-session.prompt.md"), "Cheap");
});

test("models usage errors: bad verb, arguments, profile name, and plugin root", () => {
  const { models, env, plugin } = modelsFixture();
  assert.equal(models("bogus").code, 1);
  assert.equal(models("show").code, 1);
  assert.equal(models("list", "extra").code, 1);
  assert.equal(models("pins", "extra").code, 1);
  assert.equal(models("apply", "Bad_Name").code, 1);
  const notPlugin = runWith({ cwd: plugin, env }, "models", "--plugin-root", path.dirname(plugin));
  assert.equal(notPlugin.code, 1);
  assert.match(notPlugin.json.message, /not an Agento plugin clone/);
  assert.equal(runWith({ cwd: plugin, env }, "models", "--plugin-root").code, 1);
});

test("models pins reads each agent's current pin and rejects an argument", () => {
  const { models, writeProfiles } = modelsFixture();
  assert.equal(models("pins", "extra").code, 1);

  // Unpinned: every model/subagentModel is null.
  const bare = models("pins");
  assert.equal(bare.code, 0, JSON.stringify(bare.json));
  assert.deepEqual(Object.keys(bare.json.pins).sort(), ["architect", "autopilot", "builder", "mechanic", "planner", "reviewer"]);
  for (const alias of Object.keys(bare.json.pins)) {
    assert.equal(bare.json.pins[alias].model, null, alias);
    assert.equal(bare.json.pins[alias].subagentModel, null, alias);
  }

  writeProfiles({ mixed: { agents: { planner: "Planner Model (copilot)", builder: "Builder Model (copilot)", reviewer: ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"], autopilot: "Autopilot Model (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  const pinned = models("pins");
  assert.equal(pinned.code, 0, JSON.stringify(pinned.json));
  assert.equal(pinned.json.pins.builder.model, "Builder Model (copilot)");
  assert.equal(pinned.json.pins.builder.subagentModel, "Builder Model (copilot)");
  assert.deepEqual(pinned.json.pins.reviewer.model, ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"]);
  assert.equal(pinned.json.pins.reviewer.subagentModel, "Reviewer Model (copilot)");
  assert.equal(pinned.json.pins.autopilot.model, "Autopilot Model (copilot)");
  assert.equal(pinned.json.pins.planner.name, "📋 Agento Planner");
  assert.equal(pinned.json.pins.builder.file, ".github/agents/delivery-builder.agent.md");
  assert.deepEqual(pinned.json.warnings, []);
});

test("models show, apply, and pins warn when autopilot is BYOK and delegates to a Copilot model", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { agents: { autopilot: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } });
  const show = models("show", "mixed");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  assert.equal(show.json.warnings.length, 1);
  assert.match(show.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)".*reviewer "Claude Fable 5.1 \(copilot\)"/);
  assert.match(show.json.warnings[0], /pin autopilot at least as high as the highest-tier model it delegates to/);

  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  assert.equal(apply.json.warnings.length, 1);
  assert.match(apply.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)"/);

  const pins = models("pins");
  assert.equal(pins.code, 0);
  assert.equal(pins.json.warnings.length, 1);
  assert.match(pins.json.warnings[0], /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)"/);
});

test("models: the usage header lists the subcommand and keeps the full Options paragraph", () => {
  const repo = makeRepo();
  const usage = run(repo, "bogus").json.usage;
  assert.ok(usage.some((line) => line.includes("models [list | pins | show <name> | apply <name> | clear | init] [--plugin-root <dir>]")), JSON.stringify(usage));
  const options = usage.slice(usage.findIndex((l) => l.startsWith("Options:"))).join(" ");
  assert.match(options, /^Options: --root <dir> .* re-anchors on its product checkout\)\.$/);
});

const sBits = (plugin) => git(plugin, "ls-files", "-v").split("\n").filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
const gitQuiet = (plugin, ...args) => spawnSync("git", ["-C", plugin, ...args]).status;

test("models apply pins agents, prompts, and mirrors under skip-worktree; clear restores HEAD", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({
    mixed: { default: "Cheap", agents: { planner: "Strong", reviewer: ["A (copilot)", "B"] }, prompts: { doctor: "Tiny" } },
    partial: { agents: { planner: "Strong" } },
  });
  const agents = fs.readdirSync(path.join(plugin, ".github", "agents"));
  const prompts = fs.readdirSync(path.join(plugin, ".github", "prompts"));
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.profile, "mixed");
  assert.equal(apply.json.active, "mixed");
  assert.equal(apply.json.changed.length, agents.length + 2 * prompts.length);
  const read = (rel) => fs.readFileSync(path.join(plugin, rel), "utf8");
  assert.match(read(".github/agents/delivery-planner.agent.md"), /^argument-hint: .*\nmodel: "Strong"\n/m);
  assert.match(read(".github/agents/delivery-reviewer.agent.md"), /^model: \["A \(copilot\)", "B"\]$/m);
  assert.match(read(".github/agents/delivery-builder.agent.md"), /^model: "Cheap"$/m);
  assert.match(read(".github/prompts/doctor.prompt.md"), /^model: "Tiny"$/m);
  assert.match(read(".github/prompts/new-feature.prompt.md"), /^model: "Strong"$/m);
  for (const p of prompts) assert.equal(read(`commands/${p.replace(".prompt.md", ".md")}`), read(`.github/prompts/${p}`), p);
  assert.equal(git(plugin, "status", "--porcelain"), "");
  assert.equal(sBits(plugin).length, apply.json.changed.length);
  assert.deepEqual(apply.json.skipWorktree.sort(), sBits(plugin).sort());

  const again = models("apply", "mixed");
  assert.equal(again.code, 0);
  assert.deepEqual(again.json.changed, []);
  assert.equal(models("list").json.active, "mixed");

  // Switching to a profile without a default unpins (and unflags) everything else.
  const partial = models("apply", "partial");
  assert.equal(partial.code, 0, JSON.stringify(partial.json));
  assert.equal(partial.json.active, "partial");
  assert.deepEqual(sBits(plugin).sort(), [".github/agents/delivery-planner.agent.md", ".github/prompts/new-feature.prompt.md", ".github/prompts/new-issue.prompt.md", "commands/new-feature.md", "commands/new-issue.md"]);
  assert.equal(git(plugin, "status", "--porcelain"), "");

  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.equal(clear.json.profile, null);
  assert.equal(clear.json.changed.length, 5);
  assert.equal(clear.json.active, null);
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  assert.deepEqual(sBits(plugin), []);
  assert.deepEqual(models("clear").json.changed, []);
});

test("issue #79 autopilot-subagent-model-pins: models apply pins handoffs[].model to the target agent's model; clear removes it", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({
    mixed: {
      agents: {
        planner: "Planner Model (copilot)",
        builder: "Builder Model (copilot)",
        reviewer: ["Reviewer Model (copilot)", "Reviewer Fallback (copilot)"],
        autopilot: "Autopilot Model (copilot)",
      },
    },
  });
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  const read = (rel) => fs.readFileSync(path.join(plugin, rel), "utf8");
  // Each handoff item gains a nested model: line carrying the target agent's pin:
  // planner → builder, builder → reviewer (first entry of its list), reviewer → autopilot.
  assert.match(read(".github/agents/delivery-planner.agent.md"), /^    model: "Builder Model \(copilot\)"$/m);
  assert.match(read(".github/agents/delivery-builder.agent.md"), /^    model: "Reviewer Model \(copilot\)"$/m);
  assert.match(read(".github/agents/delivery-reviewer.agent.md"), /^    model: "Autopilot Model \(copilot\)"$/m);
  assert.equal(models("list").json.active, "mixed");
  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  assert.deepEqual(sBits(plugin), []);
});

test("models apply refuses targets edited beyond their model line", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap" } });
  assert.equal(models("apply", "mixed").code, 0);
  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  fs.appendFileSync(file, "\nlocal edit\n");
  const refused = models("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "dirty");
  assert.deepEqual(refused.json.dirty, [".github/agents/delivery-builder.agent.md"]);
  // clear still works and exposes the edit instead of hiding it.
  const clear = models("clear");
  assert.equal(clear.code, 0);
  assert.deepEqual(sBits(plugin), []);
  assert.equal(git(plugin, "status", "--porcelain"), "M .github/agents/delivery-builder.agent.md");
});

test("models apply ignores handoff model: lines in dirty detection and still refuses other edits", () => {
  const { plugin, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { agents: { planner: "P (copilot)", builder: "B (copilot)", reviewer: "R (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  assert.deepEqual(models("list").json.dirty, []);
  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  assert.match(fs.readFileSync(file, "utf8"), /^    model: "R \(copilot\)"$/m);
  // A real edit beyond both the top-level and handoff model: lines refuses apply.
  fs.appendFileSync(file, "\nlocal edit\n");
  const refused = models("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "dirty");
  assert.deepEqual(refused.json.dirty, [".github/agents/delivery-builder.agent.md"]);
  // Dropping the local edit leaves only the applied pins, so it is clean again.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("\nlocal edit\n", ""));
  assert.deepEqual(models("list").json.dirty, []);
});

test("models apply refuses a linked-worktree plugin root; clear still runs there", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Cheap" } });
  const linked = path.join(path.dirname(plugin), "plan-1");
  git(plugin, "worktree", "add", "-q", "-b", "dev", linked);
  const inLinked = (...args) => runWith({ cwd: linked, env }, "models", ...args, "--plugin-root", linked);
  const refused = inLinked("apply", "mixed");
  assert.equal(refused.code, 3);
  assert.equal(refused.json.status, "worktree");
  assert.equal(refused.json.primaryCheckout, plugin);
  assert.match(refused.json.message, new RegExp(`--plugin-root ${plugin}$`));
  assert.equal(gitQuiet(linked, "diff", "--quiet"), 0);
  assert.deepEqual(sBits(linked), []);
  const clear = inLinked("clear");
  assert.equal(clear.code, 0);
  assert.deepEqual(clear.json.changed, []);
  assert.equal(models("apply", "mixed").code, 0);
});

test("models apply on a non-git plugin root rewrites without flags", () => {
  const { plugin, models, writeProfiles } = modelsFixture({ gitInit: false });
  writeProfiles({ mixed: { default: "Cheap" } });
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.skipWorktree, null);
  assert.deepEqual(apply.json.dirty, []);
  assert.ok(apply.json.changed.length > 0);
  assert.match(fs.readFileSync(path.join(plugin, ".github", "agents", "delivery-builder.agent.md"), "utf8"), /^model: "Cheap"$/m);
  assert.equal(models("clear").json.active, null);
});

test("models apply rejects the shipped template's placeholders and unknown profiles", () => {
  const { plugin, models } = modelsFixture();
  assert.equal(models("init").json.created, true);
  const apply = models("apply", "mixed");
  assert.equal(apply.code, 3);
  assert.equal(apply.json.status, "invalid");
  assert.ok(apply.json.errors.length >= 1 && apply.json.errors.every((e) => /placeholder/.test(e)), JSON.stringify(apply.json.errors));
  assert.equal(gitQuiet(plugin, "diff", "--quiet"), 0);
  const unknown = models("apply", "nope");
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.status, "not-found");
});

test("models apply reports resolution errors for prompts on custom agents", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ bad: { prompts: { "build-feature": "X", ghost: "Y" } } });
  const apply = models("apply", "bad");
  assert.equal(apply.code, 3);
  assert.equal(apply.json.status, "invalid");
  assert.ok(apply.json.errors.some((e) => /^profiles\.bad\.prompts\.build-feature: runs on 🔨 Agento Builder/.test(e)), JSON.stringify(apply.json.errors));
  assert.ok(apply.json.errors.some((e) => /^profiles\.bad\.prompts\.ghost: no prompt named/.test(e)));
});

test("doctor model-profile: ok without a clone, none, or a matching profile; warn on custom pins or an invalid file", () => {
  const { plugin, home, env, models, writeProfiles } = modelsFixture();
  const check = (root = plugin) => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", root).json)["model-profile"];

  const bundle = check(path.dirname(plugin));
  assert.equal(bundle.status, "ok");
  assert.match(bundle.detail, /^no Agento plugin clone at /);

  assert.deepEqual(check(), { id: "model-profile", status: "ok", detail: `no profile applied to ${plugin}`, fallback: null });

  writeProfiles({ mixed: { default: "Cheap (copilot)", agents: { planner: "Strong (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  assert.equal(check().detail, `mixed applied to ${plugin}`);

  const file = path.join(plugin, ".github", "agents", "delivery-builder.agent.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('model: "Cheap (copilot)"', 'model: "Edited"'));
  const custom = check();
  assert.equal(custom.status, "warn");
  assert.match(custom.detail, /match no profile/);
  assert.match(custom.fallback, /models apply <name>.*models clear.*clear, then git pull, then apply/);

  fs.writeFileSync(path.join(home, "model-profiles.json"), "{ nope");
  const invalid = check();
  assert.equal(invalid.status, "warn");
  assert.match(invalid.detail, /1 error\(s\), first: invalid JSON/);
});

test("doctor model-profile warns when autopilot is BYOK and delegates to a Copilot model", () => {
  const { plugin, env, models, writeProfiles } = modelsFixture();
  const check = (root = plugin) => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", root).json)["model-profile"];
  writeProfiles({ mixed: { agents: { autopilot: "DeepSeek V4 Pro (deepseek)", reviewer: "Claude Fable 5.1 (copilot)" } } });
  assert.equal(models("apply", "mixed").code, 0);
  const tier = check();
  assert.equal(tier.status, "warn");
  assert.match(tier.detail, /autopilot is pinned to "DeepSeek V4 Pro \(deepseek\)".*reviewer "Claude Fable 5.1 \(copilot\)"/);
  assert.match(tier.fallback, /pin autopilot at least as high as the highest-tier model it delegates to/);
});

test("models show, apply, and pins warn once about model values without a (vendor) suffix; apply still exits 0", () => {
  const { models, writeProfiles } = modelsFixture();
  writeProfiles({ mixed: { default: "Bare", agents: { planner: "P (copilot)", reviewer: ["R (copilot)", "Bare"] }, prompts: { doctor: "Tiny" } } });
  const show = models("show", "mixed");
  assert.equal(show.code, 0, JSON.stringify(show.json));
  assert.equal(show.json.warnings.length, 1);
  assert.match(show.json.warnings[0], /^model values without a \(vendor\) suffix: "Bare" \(default, reviewer\); "Tiny" \(prompts\.doctor\); /);

  const apply = models("apply", "mixed");
  assert.equal(apply.code, 0, JSON.stringify(apply.json));
  assert.equal(apply.json.active, "mixed");
  assert.deepEqual(apply.json.warnings, show.json.warnings);

  const pins = models("pins");
  assert.equal(pins.code, 0);
  assert.equal(pins.json.warnings.length, 1);
  assert.match(pins.json.warnings[0], /^model values without a \(vendor\) suffix: "Bare" \(builder, reviewer, autopilot, mechanic, architect\); /);

  assert.deepEqual(models("clear").json.warnings, []);
});

test("doctor model-profile warns on an applied profile with unqualified pins and is ok when every pin is qualified", () => {
  const { plugin, home, env, models, writeProfiles } = modelsFixture();
  const check = () => byId(runWith({ cwd: plugin, env }, "doctor", "--plugin-root", plugin).json)["model-profile"];
  writeProfiles({ bare: { agents: { planner: "Bare", builder: "B (copilot)" } }, qualified: { agents: { planner: "P (copilot)", builder: "B (copilot)" } } });
  assert.equal(models("apply", "bare").code, 0);
  const bare = check();
  assert.equal(bare.status, "warn");
  assert.match(bare.detail, /^model values without a \(vendor\) suffix: "Bare" \(planner\); /);
  assert.equal(bare.fallback, `qualify each named value as "<picker name> (<vendor>)" in ${path.join(home, "model-profiles.json")}, then \`agento.mjs models apply bare --plugin-root ${plugin}\``);

  assert.equal(models("apply", "qualified").code, 0);
  assert.deepEqual(check(), { id: "model-profile", status: "ok", detail: `qualified applied to ${plugin}`, fallback: null });
});

test("doctor --for models needs only the terminal checks", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: repo, env }, "doctor", "--for", "models");
  assert.equal(code, 0);
  assert.deepEqual(json.for, { command: "models", needs: ["terminal"] });
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "worktrees-dir", "session-workspace", "artifact-repo"]);
});

// --- release ---------------------------------------------------------------------

const MERGE = "1".repeat(40);
const PARENT = "0".repeat(40);
const LATER = "2".repeat(40);
const RUNS = "repos/{owner}/{repo}/actions/workflows/release.yml/runs";
const releaseConfig = { checks: { releaseWorkflow: "release.yml" } };
const releaseRun = (id, fields = {}) => ({ id, event: "push", status: "completed", conclusion: "success", head_sha: MERGE, head_branch: "main", created_at: "2026-10-07T10:00:05Z", html_url: `https://github.test/runs/${id}`, ...fields });
const mergeCommitAt = (date) => ({ sha: MERGE, commit: { committer: { date } }, parents: [{ sha: PARENT }] });
const workflowFile = (text) => ({ content: Buffer.from(text).toString("base64"), encoding: "base64" });

// A gh stub answering `gh api <path>` from routes keyed on path prefix (longest wins);
// an array value is a sequence, one entry per call, repeating the last.
function releaseGh(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-gh-"));
  fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(routes));
  const script = `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", args.join(" ") + "\\n");
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] !== "api") process.exit(1);
const target = args[args.length - 1];
const routes = JSON.parse(fs.readFileSync(dir + "/routes.json", "utf8"));
const key = Object.keys(routes).filter((k) => target.startsWith(k)).sort((a, b) => b.length - a.length)[0];
if (!key) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
let reply = routes[key];
if (Array.isArray(reply)) {
  const counter = dir + "/count-" + Buffer.from(key).toString("hex").slice(0, 60);
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  reply = reply[Math.min(n, reply.length - 1)];
}
if (reply && reply.__stderr) { process.stderr.write(reply.__stderr + "\\n"); process.exit(reply.__exit || 1); }
process.stdout.write(JSON.stringify(reply));
`;
  const { env } = restrictedPath({ gh: script });
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
  return { env, calls, apiCalls: () => calls().filter((c) => c.startsWith("api ")) };
}

const recent = () => new Date(Date.now() - 30_000).toISOString();
const releaseRoutes = (extra = {}) => ({
  [`repos/{owner}/{repo}/commits/`]: mergeCommitAt("2020-01-01T00:00:00Z"),
  [`${RUNS}?head_sha=`]: { total_count: 0, workflow_runs: [] },
  [`${RUNS}?branch=`]: { total_count: 0, workflow_runs: [] },
  [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  push:\n    branches: [main]\n    paths-ignore: ['docs/**']\n  workflow_dispatch:\n"),
  [`repos/{owner}/{repo}/compare/${PARENT}...`]: { status: "ahead", files: [{ filename: "src/app.js" }] },
  ...extra,
});
const release = (repo, gh, ...args) => runWith({ cwd: repo, env: gh.env }, "release", ...args);

test("release: unset checks.releaseWorkflow is not-configured, exit 0, with no gh call", () => {
  const repo = makeRepo();
  const gh = releaseGh(releaseRoutes());
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.verdict, "not-configured");
  assert.equal(json.workflow, null);
  assert.deepEqual(gh.calls(), []);
});

test("release: an exact successful push run is success, exit 0, in two API calls", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(101)] } }));
  const { code, json } = release(repo, gh, MERGE.slice(0, 7));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "ok");
  assert.equal(json.verdict, "success");
  assert.equal(json.sha, MERGE);
  assert.equal(json.workflow, "release.yml");
  assert.deepEqual(json.run, { id: 101, event: "push", status: "completed", conclusion: "success", url: "https://github.test/runs/101", headSha: MERGE });
  assert.equal(json.supersededBy, null);
  assert.equal(json.mergeDate, "2020-01-01T00:00:00Z");
  assert.equal(json.graceSeconds, 180);
  assert.equal(json.polls, 1);
  assert.equal(json.waitedSeconds, 0);
  for (const key of ["reason", "root", "configSource"]) assert.ok(key in json, key);
  assert.equal(gh.apiCalls().length, 2, gh.apiCalls().join("\n"));
  assert.match(gh.apiCalls()[1], new RegExp(`head_sha=${MERGE}&per_page=100$`));
});

test("release: an exact in-progress run is pending, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(102, { status: "in_progress", conclusion: null })] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 2);
  assert.equal(json.status, "pending");
  assert.equal(json.verdict, "pending");
});

test("release: a dispatch-only workflow is dispatch-required, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  workflow_dispatch:\n") }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 2);
  assert.equal(json.status, "pending");
  assert.equal(json.verdict, "dispatch-required");
  assert.ok(gh.apiCalls().every((c) => !c.includes("/compare/")), gh.apiCalls().join("\n"));
});

test("release: a failed exact run is failed, exit 4", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(103, { conclusion: "failure" })] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 4);
  assert.equal(json.status, "failed");
  assert.equal(json.verdict, "failed");
});

test("release: no run long after the merge is no-run, exit 4; within grace it is pending", () => {
  const repo = makeRepo({ config: releaseConfig });
  const late = release(repo, releaseGh(releaseRoutes()), MERGE);
  assert.equal(late.code, 4);
  assert.equal(late.json.verdict, "no-run");
  const early = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: mergeCommitAt(recent()) })), MERGE);
  assert.equal(early.code, 2);
  assert.equal(early.json.verdict, "pending");
});

test("release: a docs-only merge against paths-ignore is not-triggered, exit 0", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/compare/${PARENT}...`]: { status: "ahead", files: [{ filename: "docs/a.md" }] } }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0);
  assert.equal(json.verdict, "not-triggered");
});

test("release: a cancelled run with a passing descendant push run is superseded-success, exit 0", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({
    [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(104, { conclusion: "cancelled" })] },
    [`${RUNS}?branch=`]: { workflow_runs: [releaseRun(105, { head_sha: LATER, created_at: "2026-10-07T10:05:00Z" })] },
    [`repos/{owner}/{repo}/compare/${MERGE}...${LATER}`]: { status: "ahead" },
  }));
  const { code, json } = release(repo, gh, MERGE);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.verdict, "superseded-success");
  assert.equal(json.run.id, 104);
  assert.equal(json.supersededBy.id, 105);
  assert.equal(json.supersededBy.url, "https://github.test/runs/105");
  assert.ok(gh.apiCalls().some((c) => c.includes("branch=main&event=push&created=%3E%3D")), gh.apiCalls().join("\n"));
});

test("release: gh missing, HTTP 401, and an unknown SHA exit 3", () => {
  const repo = makeRepo({ config: releaseConfig });
  const missing = runWith({ cwd: repo, env: restrictedPath().env }, "release", MERGE);
  assert.equal(missing.code, 3);
  assert.equal(missing.json.status, "error");
  assert.equal(missing.json.reason, "gh-missing");

  const auth = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: { __stderr: "gh: Bad credentials (HTTP 401)" } })), MERGE);
  assert.equal(auth.code, 3);
  assert.equal(auth.json.reason, "auth");
  assert.match(auth.json.message, /gh auth login/);

  const unknown = release(repo, releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/commits/`]: { __stderr: "gh: No commit found for SHA: 1111111 (HTTP 422)" } })), MERGE);
  assert.equal(unknown.code, 3);
  assert.equal(unknown.json.reason, "unknown-sha");
});

test("release: usage errors exit 1 and the usage lists the subcommand", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes());
  for (const args of [[MERGE, "--wait", "61"], [MERGE, "--wait", "-1"], [MERGE, "--wait", "1.5"], [MERGE, "--interval", "0"], ["XYZ"], [], [MERGE, "extra"]]) {
    const { code, json } = release(repo, gh, ...args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(json.status, "usage-error");
  }
  assert.deepEqual(gh.calls(), []);
  assert.ok(run(repo, "bogus").json.usage.some((line) => line.includes("release <merge-sha> [--wait N] [--interval N]")));
});

test("release --wait polls until a pending run succeeds", () => {
  const repo = makeRepo({ config: releaseConfig });
  const pending = { workflow_runs: [releaseRun(106, { status: "in_progress", conclusion: null })] };
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: [pending, { workflow_runs: [releaseRun(106)] }] }));
  const { code, json } = release(repo, gh, MERGE, "--wait", "3", "--interval", "1");
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.verdict, "success");
  assert.ok(json.polls >= 2, String(json.polls));
  assert.equal(json.waitedSeconds, json.polls - 1);
  assert.equal(gh.apiCalls().filter((c) => c.includes("/commits/")).length, 1);
});

test("release --wait gives up within its budget on an always-pending run, exit 2", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`${RUNS}?head_sha=`]: { workflow_runs: [releaseRun(107, { status: "queued", conclusion: null })] } }));
  const started = Date.now();
  const { code, json } = release(repo, gh, MERGE, "--wait", "2", "--interval", "1");
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assert.equal(code, 2);
  assert.equal(json.verdict, "pending");
  assert.equal(json.polls, 3);
  assert.equal(json.waitedSeconds, 2);
});

test("release --wait never loops on dispatch-required", () => {
  const repo = makeRepo({ config: releaseConfig });
  const gh = releaseGh(releaseRoutes({ [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on: workflow_dispatch\n") }));
  const { code, json } = release(repo, gh, MERGE, "--wait", "5", "--interval", "1");
  assert.equal(code, 2);
  assert.equal(json.verdict, "dispatch-required");
  assert.equal(json.polls, 1);
  assert.equal(json.waitedSeconds, 0);
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
function publishBranch(work, branch, write = null, { keepLocal = false, localAhead = false } = {}) {
  git(work, "switch", "-q", "-c", branch);
  write?.(work);
  git(work, "add", "-A");
  git(work, "commit", "-q", "--allow-empty", "-m", `plan ${branch}`);
  git(work, "push", "-q", "-u", "origin", branch);
  if (localAhead) git(work, "commit", "-q", "--allow-empty", "-m", `local ${branch}`);
  git(work, "switch", "-q", "main");
  if (!keepLocal && !localAhead) git(work, "branch", "-q", "-D", branch);
}

const roadmapFor = (type, slug, status = "in-progress", branch = `${type}/${slug}`) => (w) =>
  writeRoadmap(w, `${type === "feature" ? "features" : "issues"}/2026/10/${slug}`, `status: ${status}\nbranch: ${branch}\nnext-step: "1.2"`);

const worktreeCount = (clone) => git(clone, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

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
const cloneState = (...clones) => clones.map((c) => [git(c, "worktree", "list", "--porcelain"), git(c, "branch", "--list")]);

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
function landBranch(work, branch, { syncMain = true, remote = branch } = {}) {
  git(work, "push", "-q", "origin", `${branch}:main`);
  git(work, "push", "-q", "origin", "--delete", remote);
  git(work, "fetch", "-q", "--prune", "origin");
  if (syncMain) git(work, "merge", "-q", "--ff-only", "origin/main");
}

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
// mergeStateStatus, body, title, rollups: [ [ { name, status, conclusion } ] … ] } }`
// per repo (`product`, `companion`); the repo is chosen by `$PWD` (anything under
// project-docs is the companion). `pr merge <n> --merge` performs a real merge of the
// branch into the repo's bare origin default, so later fetches and `pr view` report
// `MERGED` with a `mergeCommit`. `api` routes are prefix-matched like `releaseGh`.
// Every call logs `$PWD $*` to `calls.log`; the state file is rewritten after writes.
function shipStub({ product = {}, companion = {}, api = {}, runs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-ship-gh-"));
  const state = { product: { nameWithOwner: "acme/project", origin: null, defaultBranch: "main", prs: {}, ...product }, companion: { nameWithOwner: "acme/project-docs", origin: null, defaultBranch: "main", prs: {}, ...companion }, api, runs, nextNumber: 100, dispatched: [] };
  for (const repo of ["product", "companion"]) {
    for (const [branch, pr] of Object.entries(state[repo].prs)) {
      state[repo].prs[branch] = { number: 15, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: branch, body: "", baseRefName: "main", mergeCommit: null, rollups: [[]], rollupCalls: 0, ...pr, url: pr.url ?? `https://example.test/${repo}/pull/${pr.number ?? 15}` };
    }
  }
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const script = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
const dir = ${JSON.stringify(dir)};
const stateFile = path.join(dir, "state.json");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), process.cwd() + " " + args.map((a) => a.replace(/\\n/g, "\\\\n")).join(" ") + "\\n");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const repo = process.cwd().includes("project-docs") ? state.companion : state.product;
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const die = (msg, code = 1) => { process.stderr.write(msg + "\\n"); process.exit(code); };
const findPr = (key) => Object.values(repo.prs).find((p) => String(p.number) === String(key)) ?? repo.prs[key] ?? null;
const git = (...a) => cp.execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] === "auth") { console.log("Logged in"); process.exit(0); }
if (args[0] === "repo" && args[1] === "view") { console.log(args.includes("-q") || args.includes("--jq") ? repo.nameWithOwner : JSON.stringify({ nameWithOwner: repo.nameWithOwner })); process.exit(0); }
if (args[0] === "pr" && args[1] === "view") {
  const pr = findPr(args[2]);
  if (!pr) die("no pull requests found for branch \\"" + args[2] + "\\"");
  const fields = (opt("--json") || "").split(",").filter(Boolean);
  const jq = opt("--jq") ?? opt("-q");
  if (fields.includes("statusCheckRollup") && jq) {
    const snapshots = pr.rollups || [[]];
    const rollup = snapshots[Math.min(pr.rollupCalls || 0, snapshots.length - 1)];
    pr.rollupCalls = (pr.rollupCalls || 0) + 1; save();
    const bucket = (c) => c.status !== "COMPLETED" ? "pending" : (c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL") ? "pass" : c.conclusion === "SKIPPED" ? "skipped" : "fail";
    const rows = rollup.map((c) => ({ name: c.name, bucket: bucket(c) }));
    const count = (b) => rows.filter((r) => r.bucket === b).length;
    console.log([count("pass"), count("fail"), count("pending"), count("skipped"), pr.mergeStateStatus || "UNKNOWN"].join(" ") + " | " + rows.filter((r) => r.bucket !== "pass").map((r) => r.name + "=" + r.bucket).join(", "));
    process.exit(0);
  }
  const view = {};
  for (const f of fields) view[f] = f === "mergeCommit" ? (pr.mergeCommit ? { oid: pr.mergeCommit } : null) : f === "statusCheckRollup" ? [] : (pr[f] ?? null);
  console.log(JSON.stringify(fields.length ? view : pr));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "ready") { const pr = findPr(args[2]); if (!pr) die("not found"); pr.isDraft = false; save(); console.log("Pull request #" + pr.number + " is marked as ready for review"); process.exit(0); }
if (args[0] === "pr" && args[1] === "merge") {
  const pr = findPr(args[2]);
  if (!pr) die("not found");
  if (pr.state !== "OPEN") die("Pull request #" + pr.number + " is not open");
  if (pr.isDraft) die("Pull request #" + pr.number + " is still a draft");
  if (args.includes("--admin") || args.includes("--squash") || args.includes("--rebase") || args.includes("--delete-branch")) die("forbidden merge flag: " + args.slice(3).join(" "));
  const branch = Object.keys(repo.prs).find((b) => repo.prs[b] === pr);
  const origin = repo.origin || git("-C", process.cwd(), "remote", "get-url", "origin");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-merge-"));
  git("clone", "-q", origin, tmp);
  git("-C", tmp, "config", "user.email", "bot@example.com"); git("-C", tmp, "config", "user.name", "gh-stub");
  git("-C", tmp, "switch", "-q", repo.defaultBranch);
  git("-C", tmp, "merge", "-q", "--no-ff", "-m", "Merge pull request #" + pr.number + " from " + branch, "origin/" + branch);
  git("-C", tmp, "push", "-q", "origin", repo.defaultBranch);
  pr.state = "MERGED"; pr.mergeCommit = git("-C", tmp, "rev-parse", "HEAD"); pr.mergeStateStatus = "UNKNOWN"; save();
  console.log("Merged pull request #" + pr.number); process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = opt("--head") || git("-C", process.cwd(), "branch", "--show-current");
  if (repo.prs[head] && repo.prs[head].state === "OPEN") die("a pull request for branch \\"" + head + "\\" already exists: " + repo.prs[head].url);
  const number = state.nextNumber++;
  repo.prs[head] = { number, state: "OPEN", isDraft: args.includes("--draft"), mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: opt("--title") || head, body: opt("--body") || "", baseRefName: opt("--base") || repo.defaultBranch, mergeCommit: null, rollups: [[]], rollupCalls: 0, url: "https://example.test/pull/" + number };
  save(); console.log(repo.prs[head].url); process.exit(0);
}
if (args[0] === "api") {
  const target = args.filter((a) => !a.startsWith("-") && a !== "api" && !/^(Accept|body)=/.test(a) && !a.startsWith("Accept:"))[0];
  if (args.includes("-X") && opt("-X") === "PATCH") {
    const m = target.match(/pulls\\/(\\d+)$/);
    const pr = m && findPr(m[1]);
    if (!pr) die("Not Found (HTTP 404)");
    const field = args.find((a) => a.startsWith("body="));
    if (field) pr.body = field.slice(5);
    save(); console.log(JSON.stringify({ number: pr.number, body: pr.body })); process.exit(0);
  }
  const key = Object.keys(state.api).filter((k) => target.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) die("gh: Not Found (HTTP 404)");
  let reply = state.api[key];
  if (Array.isArray(reply)) {
    state.apiCounts = state.apiCounts || {};
    const n = state.apiCounts[key] || 0; state.apiCounts[key] = n + 1; save();
    reply = reply[Math.min(n, reply.length - 1)];
  }
  if (reply && reply.__stderr) die(reply.__stderr, reply.__exit || 1);
  process.stdout.write(JSON.stringify(reply)); process.exit(0);
}
if (args[0] === "run" && args[1] === "list") { console.log(JSON.stringify(state.runs.map((r) => ({ databaseId: r.id, createdAt: r.createdAt, url: r.url, status: r.status, conclusion: r.conclusion })))); process.exit(0); }
if (args[0] === "run" && args[1] === "view") {
  const run = state.runs.find((r) => String(r.id) === String(args[2]));
  if (!run) die("could not resolve run " + args[2]);
  const jq = opt("--jq");
  console.log(jq ? run.status + " " + (run.conclusion || "-") + " " + run.url : JSON.stringify(run)); process.exit(0);
}
if (args[0] === "workflow" && args[1] === "run") {
  const id = 900 + state.dispatched.length;
  state.dispatched.push({ workflow: args[2], ref: opt("--ref") });
  state.runs.push({ id, createdAt: new Date().toISOString(), url: "https://example.test/runs/" + id, status: "in_progress", conclusion: null });
  save(); console.log("Created workflow_dispatch event"); process.exit(0);
}
die("gh stub: unsupported " + args.join(" "));
`;
  const { env, bin } = restrictedPath({ gh: script });
  // wait-for-checks.sh needs a shell and its few coreutils beside node, git, and gh.
  for (const tool of ["bash", "grep", "sed", "sleep"]) fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const update = (fn) => {
    const current = read();
    fn(current);
    fs.writeFileSync(stateFile, JSON.stringify(current));
  };
  return { env, bin, dir, calls, state: read, update, reset: () => fs.rmSync(path.join(dir, "calls.log"), { force: true }) };
}

const shipRun = (cwd, env, ...args) => runWith({ cwd, env }, "ship", ...args);

// Every ref and worktree registration of the clones, for "nothing changed" checks.
const refState = (...clones) => clones.map((c) => [git(c, "for-each-ref"), git(c, "worktree", "list", "--porcelain")]);

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
function inRepoDelivery({ repo, wt }, slug, { type = "feature", status = "in-review", owner = true, write = null } = {}) {
  const branch = `${type}/${slug}`;
  publishBranch(repo, branch, (w) => {
    roadmapFor(type, slug, status)(w);
    write?.(w);
  }, { keepLocal: owner });
  if (owner) git(repo, "worktree", "add", "-q", path.join(wt, `${type}-${slug}`), branch);
  return { branch, owner: owner ? path.join(wt, `${type}-${slug}`) : null, dir: `${type === "feature" ? "features" : "issues"}/2026/10/${slug}` };
}

// A companion-mode delivery: code branch in the product, roadmap branch in the companion.
function pairDelivery(pair, slug, { status = "in-review", owner = true, write = null, writeCompanion = null } = {}) {
  const { repo, docs, wt, docsWt } = pair;
  const branch = `feature/${slug}`;
  publishBranch(repo, branch, write, { keepLocal: owner });
  publishBranch(docs, branch, (w) => {
    roadmapFor("feature", slug, status)(w);
    writeCompanion?.(w);
  }, { keepLocal: owner });
  if (owner) {
    git(repo, "worktree", "add", "-q", path.join(wt, `feature-${slug}`), branch);
    git(docs, "worktree", "add", "-q", path.join(docsWt, `feature-${slug}`), branch);
    fs.writeFileSync(path.join(wt, `feature-${slug}.code-workspace`), "{}\n");
  }
  return { branch, owner: owner ? path.join(wt, `feature-${slug}`) : null, half: owner ? path.join(docsWt, `feature-${slug}`) : null, dir: `features/2026/10/${slug}` };
}

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
const DONE_STEPS = "- [x] 1.1 done — verify: x\n- [x] 1.2 also done — verify: y\n";
const shipReady = (type, slug, { steps = DONE_STEPS, verdict = "approve", header = null, plan = "# Plan\n\n## Risks\n\nnone\n" } = {}) => (w) => {
  const dir = `${type === "feature" ? "features" : "issues"}/2026/10/${slug}`;
  writeRoadmap(w, dir, header ?? `status: in-review\nbranch: ${type}/${slug}\nlast-updated: 2026-10-01\nnext-step: "review"`, steps);
  if (verdict) fs.writeFileSync(path.join(w, dir, "review.md"), `# Review\n\nVerdict: ${verdict}\n`);
  if (plan) fs.writeFileSync(path.join(w, dir, "plan.md"), plan);
};
const writeFile = (rel, text) => (w) => {
  fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true });
  fs.writeFileSync(path.join(w, rel), text);
};
const both = (...writers) => (w) => writers.forEach((f) => f?.(w));
const codes = (gaps) => gaps.map((g) => g.code);

// A delivery whose roadmap is shippable; `extra` adds files to the branch commit.
function shippable(fixture, slug, { type = "feature", owner = true, extra = null, roadmap = {} } = {}) {
  const branch = `${type}/${slug}`;
  publishBranch(fixture.repo, branch, both(shipReady(type, slug, roadmap), extra), { keepLocal: owner });
  if (owner) git(fixture.repo, "worktree", "add", "-q", path.join(fixture.wt, `${type}-${slug}`), branch);
  return { branch, owner: owner ? path.join(fixture.wt, `${type}-${slug}`) : null, dir: `${type === "feature" ? "features" : "issues"}/2026/10/${slug}` };
}

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
  const conflict = expectHard("conflict", ["pr-conflicting"], { pr: { mergeStateStatus: "CONFLICTING" } });
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
  assert.deepEqual(codes(audit("clean", { mergeStateStatus: "CONFLICTING" }).gaps.hard), ["companion-pr-conflicting"]);
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

const PASSING = [[{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" }]];
const stepsOf = (json) => json.actions.map((a) => a.step);
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
  git(owner, "commit", "-q", "-m", "tracked shot");
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

// --- dashboard: one process per refresh ---------------------------------------

// A restricted PATH whose `git` appends its arguments to `log` before running the real binary.
function gitLoggingPath(extra = {}) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-bin-"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const log = path.join(bin, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  for (const [name, script] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return { log, env: { ...baseEnv, PATH: bin } };
}

// `worktree list --porcelain` calls per (real) `-C` directory; clears the log.
function worktreeListCalls(log) {
  const counts = {};
  for (const line of fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []) {
    const match = line.match(/^-C (.+) worktree list --porcelain$/);
    if (!match) continue;
    const dir = fs.realpathSync(match[1]);
    counts[dir] = (counts[dir] ?? 0) + 1;
  }
  fs.rmSync(log, { force: true });
  return counts;
}

test("session, status --pr, initiative, and dashboard read each clone's worktree list once from a product cwd", () => {
  const { repo, wt } = makeWorktreeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2"');
  writeBreakdown(repo, "initiatives/2026/09/demo", null, [{ slug: "alpha" }, { slug: "beta" }]);
  git(repo, "worktree", "add", "-q", "-b", "feature/alpha", path.join(wt, "feature-alpha"));
  const { log, env } = gitLoggingPath();
  const commands = [["session"], ["status", "--pr"], ["initiative"], ["dashboard"], ["dashboard", "--pr"]];
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

// Product primary plus a build worktree on feature/alpha (and its companion half in
// companion mode); the artifact checkout holds a committed breakdown with in-flight,
// blocked, and ready members and in-progress, planned, in-review, and complete roadmaps.
function makeDashboardRepo({ companion }) {
  const pair = companion ? makePairRepo() : { ...makeWorktreeRepo(), docs: null };
  const artifacts = pair.docs ?? pair.repo;
  writeBreakdown(artifacts, "initiatives/2026/10/demo", null, [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma", requires: ["alpha"] }, { slug: "delta" }]);
  writeRoadmap(artifacts, "features/2026/10/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2"');
  writeRoadmap(artifacts, "features/2026/10/beta", 'status: planned\nbranch: feature/beta\ninitiative: "demo"\nnext-step: "1.1"');
  writeRoadmap(artifacts, "features/2026/10/omega", 'status: complete\nbranch: feature/omega\nnext-step: ""', "- [x] 1.1 done — verify: x\n");
  writeRoadmap(artifacts, "issues/2026/10/bug", 'status: in-review\nbranch: issue/bug\nnext-step: "review"');
  git(artifacts, "add", "-A");
  git(artifacts, "commit", "-q", "-m", "artifacts");
  const build = path.join(pair.wt, "feature-alpha");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/alpha", build);
  if (companion) git(pair.docs, "worktree", "add", "-q", "-b", "feature/alpha", path.join(pair.docsWt, "feature-alpha"));
  return { repo: pair.repo, docs: pair.docs, build, artifacts };
}

// `dashboard` from `cwd`: every section deep-equals its standalone subcommand run in the same state.
function assertDashboardMatches(cwd, env, { pr }) {
  const flag = pr ? ["--pr"] : [];
  const sub = (...args) => runWith({ cwd, env }, ...args).json;
  const dash = runWith({ cwd, env }, "dashboard", ...flag);
  assert.equal(dash.code, 0);
  assert.deepEqual(Object.keys(dash.json), ["status", "session", "doctor", "deliveries", "initiatives", "timings", "root", "configSource"]);
  assert.equal(dash.json.status, "ok");
  for (const key of ["session", "doctor", "deliveries", "initiatives", "total"]) assert.equal(typeof dash.json.timings[key], "number", key);
  assert.deepEqual(dash.json.session, sub("session", ...flag));
  assert.deepEqual(dash.json.doctor, sub("doctor"));
  assert.deepEqual(dash.json.deliveries, sub("status", ...flag));
  const list = sub("initiative");
  assert.deepEqual(dash.json.initiatives.list, list);
  assert.deepEqual(Object.keys(dash.json.initiatives.details), list.items.map((i) => i.slug));
  for (const item of list.items) assert.deepEqual(dash.json.initiatives.details[item.slug], sub("initiative", item.slug));
  return dash.json;
}

test("dashboard sections deep-equal session, doctor, status, and initiative in in-repo and companion fixtures", () => {
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
