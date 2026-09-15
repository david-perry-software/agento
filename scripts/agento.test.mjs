import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "scripts", "agento.mjs");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// A working clone with a bare origin, so remote fallbacks exercise real git.
function makeRepo({ config } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-cli-"));
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "project");
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
});

test("status lists roadmaps with progress, verdicts, and duplicate slugs", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nlast-updated: 2026-09-01\nnext-step: \"1.2 todo\"");
  writeRoadmap(repo, "issues/2026/09/beta", "status: in-review\nbranch: issue/beta\nnext-step: review\ngithub-issue: \"#12\"");
  fs.writeFileSync(path.join(repo, "issues/2026/09/beta/review.md"), "# Review: beta\n\nVerdict: request-changes\n");
  writeRoadmap(repo, "features/2026/08/beta", "status: complete\nbranch: feature/beta\nnext-step: \"\"");

  const { code, json } = run(repo, "status");
  assert.equal(code, 0);
  assert.deepEqual(json.items.map((i) => i.slug), ["alpha", "beta", "beta"]);
  const alpha = json.items[0];
  assert.deepEqual(alpha.steps, { ticked: 1, total: 2 });
  assert.equal(alpha.nextStep, "1.2 todo");
  const betaIssue = json.items.find((i) => i.type === "issue");
  assert.equal(betaIssue.reviewVerdict, "request-changes");
  assert.equal(betaIssue.githubIssue, "#12");
  assert.equal(json.duplicates.length, 1);
  assert.equal(json.duplicates[0].slug, "beta");
  assert.deepEqual([...json.duplicates[0].paths].sort(), ["features/2026/08/beta/roadmap.md", "issues/2026/09/beta/roadmap.md"]);
  assert.deepEqual(json.resumable, ["alpha", "beta"]);

  const filtered = run(repo, "status", "issue");
  assert.deepEqual(filtered.json.items.map((i) => i.type), ["issue"]);
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

  const a = run(repo, "ports", "widget").json;
  const b = run(repo, "ports", "widget").json;
  assert.deepEqual(a, b);
  assert.ok(a.WEB_PORT >= 3100 && a.WEB_PORT < 3190);
  assert.equal(a.API_PORT - a.WEB_PORT, 1000);
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

test("doctor reports six ok checks with exit 0 when every capability is present", () => {
  const repo = makeRepo();
  const { env } = restrictedPath(okStubs);
  const { code, json } = runWith({ cwd: repo, env }, "doctor");
  assert.equal(code, 0);
  assert.equal(json.status, "ok");
  assert.equal(json.for, null);
  assert.deepEqual(json.checks.map((c) => c.id), ["node", "git-remote", "gh", "code", "python3", "worktrees-dir"]);
  for (const check of json.checks) {
    assert.equal(check.status, "ok", JSON.stringify(check));
    assert.equal(typeof check.detail, "string");
    assert.equal(check.fallback, null);
  }
  const checks = byId(json);
  assert.match(checks.gh.detail, /gh version 9\.9\.9; authenticated/);
  assert.match(checks["git-remote"].detail, /main reachable/);
  assert.match(checks["worktrees-dir"].detail, /project-worktrees absent; .* writable, it will be created/);
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
  assert.deepEqual(missing.json.checks.filter((c) => c.id !== "gh").map((c) => c.status), ["ok", "ok", "ok", "ok", "ok"]);

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
  assert.deepEqual(local.json.checks.map((c) => c.id), ["node", "python3", "worktrees-dir"]);
  assert.ok(!fs.existsSync(marker), "gh was invoked for a terminal-only command");

  const ship = runWith({ cwd: repo, env }, "doctor", "--for", "ship");
  assert.equal(ship.code, 0);
  assert.deepEqual(ship.json.for, { command: "ship", needs: ["terminal", "gh", "network"] });
  assert.deepEqual(ship.json.checks.map((c) => c.id), ["node", "git-remote", "gh", "python3", "worktrees-dir"]);
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
  assert.deepEqual(json.worktrees, [{ path: repo, branch: "main", detached: false, role: "primary", dirPrefix: null, id: null, isPrimary: true, isManaged: false }]);

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
    { path: repo, branch: "main", detached: false, role: "primary", dirPrefix: null, id: null, isPrimary: true, isManaged: false },
    { path: build, branch: "feature/widget", detached: false, role: "build", dirPrefix: "feature", id: "widget", isPrimary: false, isManaged: true },
    { path: stray, branch: "issue/bug", detached: false, role: "unmanaged", dirPrefix: null, id: null, isPrimary: false, isManaged: false },
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
  assert.deepEqual(actions.allowed, ["/agento delivery-status"]);
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
  assert.deepEqual(first.json.waves, [["a", "b"], ["c"]]);
  assert.equal(first.json.next, "a");
  assert.equal(first.json.done, false);
  assert.deepEqual(first.json.anomalies, []);

  writeRoadmap(repo, "features/2026/09/a", 'status: complete\nbranch: feature/a\ninitiative: "demo"\nnext-step: ""');
  writeRoadmap(repo, "features/2026/09/b", 'status: in-review\nbranch: feature/b\ninitiative: "demo"\nnext-step: review');
  const second = run(repo, "initiative", "demo").json;
  assert.deepEqual(second.features.map((f) => [f.slug, f.state, f.ready]), [
    ["a", "complete", false],
    ["b", "in-review", false],
    ["c", "unplanned", false],
  ]);
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
