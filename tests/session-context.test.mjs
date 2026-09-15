import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hook = path.join(repoRoot, "scripts", "hooks", "session-context.sh");

function makeRepo({ branch = "feature/widget", config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-session-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-m", "init");
  if (branch !== "main") git("switch", "-c", branch);
  if (config) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "agento.json"), JSON.stringify(config));
  }
  return dir;
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
  assert.match(sessionLines[0], /^Session: role=primary worktree=\S+ branch=main delivery=none lifecycle=no-delivery allowed=\[\/agento start-session; .*\/agento delivery-status\] elsewhere=\[\]$/);
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
  assert.match(session, /^Session: role=build worktree=\S+\/feature-widget branch=feature\/widget delivery=feature\/widget lifecycle=building allowed=\[\/agento build-feature widget; \/agento delivery-status\] elsewhere=\[\/agento ship widget@primary\]$/);
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
