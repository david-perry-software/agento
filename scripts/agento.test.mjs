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
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8" });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(`non-JSON output: ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
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
