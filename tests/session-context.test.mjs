import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(repoRoot, "scripts", "hooks", "session-context.sh");

function makeRepo({ branch = "feature/widget", config, companion = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-session-"));
  const dir = companion ? path.join(base, "project") : base;
  const initRepo = (target) => {
    fs.mkdirSync(target, { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", target, ...args], { encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "init");
    return git;
  };
  const git = initRepo(dir);
  if (branch !== "main") git("switch", "-c", branch);
  if (companion) {
    initRepo(path.join(base, "project-docs"));
    config = { ...config, artifacts: { repo: { name: "project-docs" }, ...config?.artifacts } };
  }
  if (config) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "agento.json"), JSON.stringify(config));
  }
  return companion ? { product: dir, companion: path.join(base, "project-docs") } : dir;
}

function writeRoadmap(root, rel, header) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "roadmap.md"), "```yaml\n" + header + "\n```\n\n## Phase 1\n\n- [ ] 1.1 step — verify: x\n");
}

function run(cwd, env) {
  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const result = spawnSync(bash, [hook], { input: JSON.stringify({ cwd }), encoding: "utf8", timeout: 20000, env: env ?? process.env });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

// A PATH with only the tools the hook itself needs (no node), to exercise the fallback.
function pathWithoutNode() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-nonode-"));
  for (const tool of ["bash", "python3", "git", "cat", "dirname"]) {
    fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
  }
  return { ...process.env, PATH: bin };
}

test("reports the branch and no work on an empty repo", () => {
  const repo = makeRepo();
  const context = run(repo);
  assert.match(context, /^Current git branch: feature\/widget$/m);
  assert.match(context, /No in-progress delivery work in features\/ or issues\//);
});

test("announces the Agento CLI path", () => {
  const context = run(makeRepo());
  assert.match(context, new RegExp(`^Agento CLI: node ${path.join(repoRoot, "scripts", "agento.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("lists resumable roadmaps and skips planned/complete ones", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: \"1.2 wire it\"");
  writeRoadmap(repo, "issues/2026/09/beta", "status: paused\nbranch: issue/beta\nnext-step: 2.1 blocked on auth");
  writeRoadmap(repo, "features/2026/09/gamma", "status: complete\nbranch: feature/gamma\nnext-step: \"\"");
  writeRoadmap(repo, "features/2026/09/delta", "status: planned\nbranch: feature/delta\nnext-step: 1.1");

  const context = run(repo);
  assert.match(context, /Delivery work: features\/2026\/09\/alpha \[status: in-progress\] next-step: "1\.2 wire it"/);
  assert.match(context, /Delivery work: issues\/2026\/09\/beta \[status: paused\] next-step: 2\.1 blocked on auth/);
  assert.doesNotMatch(context, /gamma|delta/);
  assert.doesNotMatch(context, /No in-progress delivery work/);
});

test("honours custom artifact roots from .github/agento.json", () => {
  const repo = makeRepo({ config: { artifacts: { features: "planning/features", issues: null } } });
  writeRoadmap(repo, "planning/features/2026/09/alpha", "status: in-review\nbranch: feature/alpha\nnext-step: review");
  writeRoadmap(repo, "features/2026/09/ignored", "status: in-progress\nbranch: feature/ignored\nnext-step: x");
  writeRoadmap(repo, "issues/2026/09/beta", "status: in-progress\nbranch: issue/beta\nnext-step: y");

  const context = run(repo);
  assert.match(context, /planning\/features\/2026\/09\/alpha \[status: in-review\]/);
  assert.match(context, /issues\/2026\/09\/beta/);
  assert.doesNotMatch(context, /09\/ignored/);
});

test("emits valid JSON when next-step contains quotes, backslashes, and tabs", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", 'status: in-progress\nbranch: feature/alpha\nnext-step: "say \\"hi\\"\tC:\\path"');
  const context = run(repo);
  assert.match(context, /say \\"hi\\"\tC:\\path/);
});

test("emits exactly one Session: line with role=primary on a plain repo, right after Agento CLI:", () => {
  const repo = makeRepo({ branch: "main" });
  const context = run(repo);
  const lines = context.split("\n");
  const sessionLines = lines.filter((l) => l.startsWith("Session: "));
  assert.equal(sessionLines.length, 1);
  assert.equal(lines[lines.findIndex((l) => l.startsWith("Agento CLI: ")) + 1], sessionLines[0]);
  assert.match(sessionLines[0], /^Session: role=primary worktree=\S+ branch=main delivery=none lifecycle=no-delivery allowed=\[\/agento continue; \/agento start-session; .*\/agento delivery-status\] elsewhere=\[\]$/);
});

test("reports role=build with the delivery and lifecycle from a managed worktree", () => {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-wt-"));
  const repo = makeRepo({ branch: "main", config: { worktrees: { dir: worktreesDir } } });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("add", "-A");
  git("commit", "-q", "-m", "config");
  const build = path.join(worktreesDir, "feature-widget");
  git("worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');

  const context = run(build);
  assert.match(context, /^Current git branch: feature\/widget$/m);
  const session = context.split("\n").find((l) => l.startsWith("Session: "));
  assert.match(session, /^Session: role=build worktree=\S+\/feature-widget branch=feature\/widget delivery=feature\/widget lifecycle=building allowed=\[\/agento continue; \/agento build-feature widget; \/agento delivery-status\] elsewhere=\[\/agento ship widget@primary\]$/);
  assert.match(context, /Delivery work: features\/2026\/09\/widget \[status: in-progress\]/);
});

test("falls back to the pre-feature output byte for byte when node is absent from PATH", () => {
  const repo = makeRepo();
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: \"1.2 wire it\"");
  const withNode = run(repo);
  assert.match(withNode, /^Session: /m);
  const withoutNode = run(repo, pathWithoutNode());
  assert.doesNotMatch(withoutNode, /^Session: /m);
  assert.equal(withoutNode, withNode.split("\n").filter((l) => !l.startsWith("Session: ")).join("\n"));
  assert.match(withoutNode, /^Agento CLI: node /m);
  assert.match(withoutNode, /Delivery work: features\/2026\/09\/alpha/);
});

test("companion: lists roadmaps from the companion checkout and ignores the product's own roots", () => {
  const { product, companion } = makeRepo({ companion: true });
  writeRoadmap(companion, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: \"1.2 wire it\"");
  writeRoadmap(product, "features/2026/09/ignored", "status: in-progress\nbranch: feature/ignored\nnext-step: x");

  const context = run(product);
  assert.match(context, /^Delivery work: features\/2026\/09\/alpha \[status: in-progress\] next-step: "1\.2 wire it"$/m);
  assert.doesNotMatch(context, /09\/ignored/);
  assert.doesNotMatch(context, /No in-progress delivery work/);
});

test("companion: exactly one Artifacts: line, directly after Session:", () => {
  const { product, companion } = makeRepo({ companion: true });
  const lines = run(product).split("\n");
  const artifactLines = lines.filter((l) => l.startsWith("Artifacts: "));
  assert.equal(artifactLines.length, 1);
  assert.equal(artifactLines[0], `Artifacts: ${companion} (branch main)`);
  assert.equal(lines[lines.findIndex((l) => l.startsWith("Session: ")) + 1], artifactLines[0]);
});

test("companion: a detached companion HEAD is reported as (branch detached)", () => {
  const { product, companion } = makeRepo({ companion: true });
  execFileSync("git", ["-C", companion, "switch", "-q", "--detach", "HEAD"]);
  assert.match(run(product), new RegExp(`^Artifacts: ${companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch detached\\)$`, "m"));
});

test("companion: a missing companion directory still names the path and reports no work", () => {
  const { product, companion } = makeRepo({ companion: true });
  fs.rmSync(companion, { recursive: true, force: true });
  const context = run(product);
  assert.match(context, new RegExp(`^Artifacts: ${companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch detached\\)$`, "m"));
  assert.match(context, /No in-progress delivery work in features\/ or issues\//);
});

test("companion: no Artifacts: line when artifacts.repo is unset", () => {
  const repo = makeRepo({ config: { artifacts: { repo: { name: null, dir: null } } } });
  writeRoadmap(repo, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: x");
  const context = run(repo);
  assert.doesNotMatch(context, /^Artifacts: /m);
  assert.match(context, /Delivery work: features\/2026\/09\/alpha/);
});

test("companion: the no-node fallback equals the with-node output minus Session:, Artifacts: included", () => {
  const { product, companion } = makeRepo({ companion: true });
  writeRoadmap(companion, "features/2026/09/alpha", "status: in-progress\nbranch: feature/alpha\nnext-step: \"1.2 wire it\"");
  const withNode = run(product);
  assert.match(withNode, /^Session: /m);
  const withoutNode = run(product, pathWithoutNode());
  assert.doesNotMatch(withoutNode, /^Session: /m);
  assert.equal(withoutNode, withNode.split("\n").filter((l) => !l.startsWith("Session: ")).join("\n"));
  assert.match(withoutNode, new RegExp(`^Artifacts: ${companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch main\\)$`, "m"));
  assert.match(withoutNode, /Delivery work: features\/2026\/09\/alpha/);
});

test("companion: a managed worktree resolves the companion relative to the primary checkout", () => {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-wt-"));
  const { product, companion } = makeRepo({ branch: "main", companion: true, config: { worktrees: { dir: worktreesDir } } });
  const git = (...args) => execFileSync("git", ["-C", product, ...args], { encoding: "utf8" });
  git("add", "-A");
  git("commit", "-q", "-m", "config");
  const build = path.join(worktreesDir, "feature-widget");
  git("worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(companion, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');

  const context = run(build);
  assert.match(context, /^Current git branch: feature\/widget$/m);
  assert.match(context, new RegExp(`^Artifacts: ${companion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch main\\)$`, "m"));
  assert.doesNotMatch(context, new RegExp(worktreesDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/project-docs"));
  assert.match(context, /Delivery work: features\/2026\/09\/widget \[status: in-progress\]/);
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Product primary + companion clone, a managed product half on feature/widget, and
// (when `pair` is set) the companion half at <companion>-worktrees/feature-widget.
function makePair({ pair = true } = {}) {
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-wt-"));
  const { product, companion } = makeRepo({ branch: "main", companion: true, config: { worktrees: { dir: worktreesDir } } });
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "config");
  const build = path.join(worktreesDir, "feature-widget");
  git(product, "worktree", "add", "-q", "-b", "feature/widget", build);
  const half = path.join(`${companion}-worktrees`, "feature-widget");
  if (pair) git(companion, "worktree", "add", "-q", "-b", "feature/widget", half);
  return { product, companion, build, half };
}

test("companion pair: from the product half, Artifacts: names the companion half and its branch and roadmaps are read from it", () => {
  const { companion, build, half } = makePair();
  writeRoadmap(half, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');
  writeRoadmap(companion, "features/2026/09/clone-only", "status: in-progress\nbranch: feature/clone-only\nnext-step: x");

  const lines = run(build).split("\n");
  const artifactLines = lines.filter((l) => l.startsWith("Artifacts: "));
  assert.equal(artifactLines.length, 1);
  assert.equal(artifactLines[0], `Artifacts: ${half} (branch feature/widget)`);
  assert.equal(lines[lines.findIndex((l) => l.startsWith("Session: ")) + 1], artifactLines[0]);
  const context = lines.join("\n");
  assert.match(context, /Delivery work: features\/2026\/09\/widget \[status: in-progress\]/);
  assert.doesNotMatch(context, /clone-only/);
});

test("companion pair: a detached companion half is reported as (branch detached)", () => {
  const { build, half } = makePair();
  execFileSync("git", ["-C", half, "switch", "-q", "--detach", "HEAD"]);
  assert.match(run(build), new RegExp(`^Artifacts: ${escapeRe(half)} \\(branch detached\\)$`, "m"));
});

test("companion pair: without a companion half the product half still names the clone", () => {
  const { companion, build, half } = makePair({ pair: false });
  const context = run(build);
  assert.match(context, new RegExp(`^Artifacts: ${escapeRe(companion)} \\(branch main\\)$`, "m"));
  assert.doesNotMatch(context, new RegExp(escapeRe(half)));
});

test("companion pair: the primary names the clone, not a half, even when halves exist", () => {
  const { product, companion } = makePair();
  const context = run(product);
  assert.match(context, new RegExp(`^Artifacts: ${escapeRe(companion)} \\(branch main\\)$`, "m"));
  assert.doesNotMatch(context, /-worktrees\/feature-widget/);
});

test("companion pair: the no-node fallback equals the with-node output minus Session:", () => {
  const { build, half } = makePair();
  writeRoadmap(half, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');
  const withNode = run(build);
  assert.match(withNode, /^Session: /m);
  const withoutNode = run(build, pathWithoutNode());
  assert.doesNotMatch(withoutNode, /^Session: /m);
  assert.equal(withoutNode, withNode.split("\n").filter((l) => !l.startsWith("Session: ")).join("\n"));
  assert.match(withoutNode, new RegExp(`^Artifacts: ${escapeRe(half)} \\(branch feature/widget\\)$`, "m"));
});

test("companion: a worktree whose branch sets artifacts.repo resolves the companion while the primary has none", () => {
  // The layout rule: the checkout decides, the primary anchors. Only the worktree's
  // branch commits `artifacts.repo`; the primary stays in-repo.
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-wt-"));
  const { product, companion } = makeRepo({ branch: "main", companion: true });
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  fs.writeFileSync(path.join(product, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: worktreesDir } }));
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "primary config without artifacts.repo");
  const build = path.join(worktreesDir, "plan-1");
  git(product, "worktree", "add", "-q", "-b", "feature/widget", build);
  fs.writeFileSync(path.join(build, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: worktreesDir }, artifacts: { repo: { name: "project-docs" } } }));
  git(build, "add", "-A");
  git(build, "commit", "-q", "-m", "flip to the companion");
  writeRoadmap(companion, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');
  writeRoadmap(build, "features/2026/09/product-only", "status: in-progress\nbranch: feature/product-only\nnext-step: x");

  const withNode = run(build);
  const lines = withNode.split("\n");
  const artifactLines = lines.filter((l) => l.startsWith("Artifacts: "));
  assert.equal(artifactLines.length, 1);
  assert.equal(artifactLines[0], `Artifacts: ${companion} (branch main)`);
  assert.equal(lines[lines.findIndex((l) => l.startsWith("Session: ")) + 1], artifactLines[0]);
  assert.doesNotMatch(withNode, new RegExp(escapeRe(worktreesDir) + "/project-docs"));
  assert.match(withNode, /Delivery work: features\/2026\/09\/widget \[status: in-progress\]/);
  assert.doesNotMatch(withNode, /product-only/);

  const withoutNode = run(build, pathWithoutNode());
  assert.doesNotMatch(withoutNode, /^Session: /m);
  assert.equal(withoutNode, withNode.split("\n").filter((l) => !l.startsWith("Session: ")).join("\n"));

  // The primary itself stays in-repo: no Artifacts: line, and it reads its own roots.
  const primary = run(product);
  assert.doesNotMatch(primary, /^Artifacts: /m);
  assert.doesNotMatch(primary, /Delivery work: features\/2026\/09\/widget/);
});
