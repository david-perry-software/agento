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

function run(cwd) {
  const result = spawnSync("bash", [hook], { input: JSON.stringify({ cwd }), encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
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
