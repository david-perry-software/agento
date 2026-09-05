import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guardScript = path.join(repoRoot, "scripts", "hooks", "delivery-guard.sh");

function decide(command, { cwd, filePath, tool = "run_in_terminal" } = {}) {
  const payload = {
    tool_name: tool,
    tool_input: filePath ? { filePath } : { command },
    cwd: cwd ?? os.tmpdir(),
  };
  const result = spawnSync("bash", [guardScript], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(result.status, 0, `guard exited ${result.status}: ${result.stderr}`);
  const stdout = result.stdout.trim();
  if (!stdout) return { decision: "allow", reason: "" };
  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason ?? "" };
}

function makeGitRepo({ config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-guard-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-m", "init");
  if (config) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "agento.json"), JSON.stringify(config));
  }
  return dir;
}

test("denies pushes to the default branch", () => {
  const { decision, reason } = decide("git push origin main");
  assert.equal(decision, "deny");
  assert.match(reason, /main/u);
});

test("denies force-push", () => {
  assert.equal(decide("git push --force-with-lease origin feature/x").decision, "deny");
  assert.equal(decide("git push -f origin feature/x").decision, "deny");
});

test("denies open-ended watchers", () => {
  for (const command of ["gh pr checks 5 --watch", "gh run watch 123", "vercel --wait"]) {
    const { decision, reason } = decide(command);
    assert.equal(decision, "deny", command);
    assert.match(reason, /wait-for-checks/);
  }
});

test("denies destructive shell changes targeting hook files", () => {
  assert.equal(decide("rm scripts/hooks/delivery-guard.sh").decision, "deny");
  assert.equal(decide("rm -rf .github/hooks/").decision, "deny");
});

test("allows ordinary commands and read-only git", () => {
  assert.equal(decide("ls -la").decision, "allow");
  assert.equal(decide("git status").decision, "allow");
  assert.equal(decide("git log --oneline -5").decision, "allow");
  assert.equal(decide("echo 'push origin main'").decision, "allow");
});

test("allows pushes to work branches", () => {
  assert.equal(decide("git push origin feature/widget").decision, "allow");
});

test("asks before committing on a feature branch without a roadmap update", () => {
  const repo = makeGitRepo();
  execFileSync("git", ["-C", repo, "switch", "-c", "feature/widget"]);
  fs.writeFileSync(path.join(repo, "code.js"), "export {};\n");
  execFileSync("git", ["-C", repo, "add", "code.js"]);

  const { decision, reason } = decide("git commit -m 'feat: widget'", { cwd: repo });
  assert.equal(decision, "ask");
  assert.match(reason, /roadmap\.md/);

  fs.mkdirSync(path.join(repo, "features", "widget"), { recursive: true });
  fs.writeFileSync(path.join(repo, "features", "widget", "roadmap.md"), "status: in-progress\nbranch: feature/widget\n");
  execFileSync("git", ["-C", repo, "add", "features/widget/roadmap.md"]);
  assert.equal(decide("git commit -m 'feat: widget'", { cwd: repo }).decision, "allow");
});

test("roadmap nudge sees -a commits and explicit pathspecs, not just the index", () => {
  const repo = makeGitRepo();
  execFileSync("git", ["-C", repo, "switch", "-c", "feature/widget"]);
  fs.mkdirSync(path.join(repo, "features", "widget"), { recursive: true });
  fs.writeFileSync(path.join(repo, "features", "widget", "roadmap.md"), "status: planned\n");
  fs.writeFileSync(path.join(repo, "code.js"), "export {};\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);

  // Nothing staged, a tracked file modified: -a would commit it without the roadmap.
  fs.writeFileSync(path.join(repo, "code.js"), "export const x = 1;\n");
  assert.equal(decide("git commit -am 'feat: x'", { cwd: repo }).decision, "ask");
  assert.equal(decide("git commit -m 'feat: x' code.js", { cwd: repo }).decision, "ask");
  assert.equal(decide("git commit -m 'feat: x' code.js features/widget/roadmap.md", { cwd: repo }).decision, "allow");
  // Only -a is denied a free pass; a plain commit with an empty index has nothing to nudge about.
  assert.equal(decide("git commit -m 'feat: x'", { cwd: repo }).decision, "allow");
});

test("tracks a plain switch/checkout to the default branch through a chain", () => {
  const repo = makeGitRepo();
  execFileSync("git", ["-C", repo, "switch", "-c", "feature/widget"]);
  assert.equal(decide("git switch main && git commit --allow-empty -m x", { cwd: repo }).decision, "deny");
  assert.equal(decide("git checkout main; git merge feature/widget", { cwd: repo }).decision, "deny");
  assert.equal(decide("git switch main && git merge --ff-only origin/main", { cwd: repo }).decision, "allow");
  assert.equal(decide("git switch main && git switch -c feature/other && git commit --allow-empty -m x", { cwd: repo }).decision, "allow");
});

test("decision reasons survive colons intact", () => {
  const { decision, reason } = decide("gh pr merge 5 --admin");
  assert.equal(decision, "deny");
  assert.match(reason, /bypasses the repository ruleset; wait for required checks/);
  const denied = decide("gh run watch 1");
  assert.match(denied.reason, /exit 2 = rerun/);
});

test("hook-file writes are judged by the command word, reads pass", () => {
  assert.equal(decide("cp /tmp/x scripts/hooks/delivery-guard.sh").decision, "deny");
  assert.equal(decide("cp scripts/hooks/delivery-guard.sh /tmp/x").decision, "allow");
  assert.equal(decide("perl -pi -e 's/a/b/' scripts/hooks/delivery-guard.sh").decision, "deny");
  assert.equal(decide("git checkout HEAD~1 -- scripts/hooks/delivery-guard.sh").decision, "deny");
  assert.equal(decide("chmod +x scripts/hooks/new.sh").decision, "ask");
  assert.equal(decide("shellcheck scripts/hooks/delivery-guard.sh").decision, "allow");
  assert.equal(decide("./scripts/hooks/replay-guard.sh < tests/guard-fixtures.txt").decision, "allow");
});

test("asks before edits to protected hook files via edit tools", () => {
  const { decision } = decide(null ?? "", {
    filePath: path.join(repoRoot, "scripts", "hooks", "delivery-guard.sh"),
    tool: "replace_string_in_file",
  });
  assert.equal(decision, "ask");
});

test("honours a custom default branch and feature prefix from .github/agento.json", () => {
  const repo = makeGitRepo({
    config: { branches: { default: "trunk", feature: "feat/" } },
  });

  const denied = decide("git push origin trunk", { cwd: repo });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /trunk/);
  assert.equal(decide("git push origin main", { cwd: repo }).decision, "allow");

  execFileSync("git", ["-C", repo, "switch", "-c", "feat/widget"]);
  fs.writeFileSync(path.join(repo, "code.js"), "export {};\n");
  execFileSync("git", ["-C", repo, "add", "code.js"]);
  assert.equal(decide("git commit -m 'feat: widget'", { cwd: repo }).decision, "ask");
});

test("null values in .github/agento.json keep the default branch protected", () => {
  const repo = makeGitRepo({
    config: { branches: { default: null, feature: null }, worktrees: { dir: null } },
  });
  assert.equal(decide("git push origin main", { cwd: repo }).decision, "deny");
  assert.equal(decide("git commit -m x", { cwd: repo }).decision, "deny");
});

test("allows worktree removal with no occupants", () => {
  const missing = path.join(os.tmpdir(), `agento-no-such-worktree-${process.pid}`);
  assert.equal(decide(`git worktree remove ${missing}`).decision, "allow");
});

test("denies a main commit reached through a tilde-prefixed cd", () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), "agento-guard-tilde-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-m", "init");

    const rel = path.relative(os.homedir(), dir);
    const { decision, reason } = decide(`cd ~/${rel} && git commit --allow-empty -m x`);
    assert.equal(decision, "deny");
    assert.match(reason, /main/u);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
