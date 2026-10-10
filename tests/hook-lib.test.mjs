import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadHookConfig, resolveArtifacts, runGit, shellSplit, toJson } from "../scripts/hooks/hook-lib.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

function writeConfig(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return git;
}

test("shellSplit: quoting cases the guard relies on", () => {
  assert.deepEqual(shellSplit("git commit -m 'feat: widget'"), ["git", "commit", "-m", "feat: widget"]);
  assert.deepEqual(shellSplit('git commit -m "docs(feature): x" 2>&1'), ["git", "commit", "-m", "docs(feature): x", "2>&1"]);
  assert.deepEqual(shellSplit("git show --name-only --format= HEAD"), ["git", "show", "--name-only", "--format=", "HEAD"]);
  assert.deepEqual(shellSplit("touch a\\ b"), ["touch", "a b"]);
  assert.deepEqual(shellSplit('echo "a \\"b\\" \\\\c \\d"'), ["echo", 'a "b" \\c \\d']);
  assert.deepEqual(shellSplit("a '' b"), ["a", "", "b"]);
  assert.deepEqual(shellSplit("x'y z'\"w\""), ["xy zw"]);
  assert.deepEqual(shellSplit("  \t "), []);
});

test("shellSplit: unbalanced quotes and a trailing backslash fall back to a whitespace split", () => {
  assert.deepEqual(shellSplit("echo \"it's  open"), ["echo", "\"it's", "open"]);
  assert.deepEqual(shellSplit("echo 'open"), ["echo", "'open"]);
  assert.deepEqual(shellSplit("echo x\\"), ["echo", "x\\"]);
});

test("loadHookConfig: defaults, nulls keep defaults, nested artifacts.repo", () => {
  const root = tmp("agento-hooklib-");
  assert.equal(loadHookConfig(root).branches.default, "main");
  assert.deepEqual(loadHookConfig(root).artifacts.repo, { name: null, dir: null });

  writeConfig(root, ".github/agento.json", JSON.stringify({
    branches: { default: null, feature: "feat/" },
    artifacts: { features: null, repo: { name: "docs", dir: null } },
  }));
  const config = loadHookConfig(root);
  assert.equal(config.branches.default, "main");
  assert.equal(config.branches.feature, "feat/");
  assert.equal(config.artifacts.features, "features");
  assert.deepEqual(config.artifacts.repo, { name: "docs", dir: null });
});

test("loadHookConfig: invalid JSON falls through to agento.json, then to the defaults", () => {
  const root = tmp("agento-hooklib-");
  writeConfig(root, ".github/agento.json", "{ not json");
  assert.equal(loadHookConfig(root).branches.default, "main");
  writeConfig(root, "agento.json", JSON.stringify({ branches: { default: "trunk" } }));
  assert.equal(loadHookConfig(root).branches.default, "trunk");
  writeConfig(root, ".github/agento.json", "[1, 2]");
  assert.equal(loadHookConfig(root).branches.default, "main");
  writeConfig(root, ".github/agento.json", JSON.stringify({ branches: "oops", artifacts: { repo: "oops" } }));
  const config = loadHookConfig(root);
  assert.equal(config.branches.default, "main");
  assert.deepEqual(config.artifacts.repo, { name: null, dir: null });
});

test("resolveArtifacts: in-repo, companion by name, companion by dir", () => {
  const base = tmp("agento-hooklib-");
  const root = path.join(base, "project");
  initRepo(root);
  assert.deepEqual(resolveArtifacts(root), {
    external: false, companionPath: null, name: null, companionWorktreesDir: null, primaryRoot: root,
  });

  writeConfig(root, ".github/agento.json", JSON.stringify({ artifacts: { repo: { name: "project-docs" } } }));
  assert.deepEqual(resolveArtifacts(root), {
    external: true,
    companionPath: path.join(base, "project-docs"),
    name: "project-docs",
    companionWorktreesDir: path.join(base, "project-docs-worktrees"),
    primaryRoot: root,
  });

  writeConfig(root, ".github/agento.json", JSON.stringify({ artifacts: { repo: { dir: "../elsewhere/docs" } } }));
  const byDir = resolveArtifacts(root);
  assert.equal(byDir.companionPath, path.join(base, "elsewhere", "docs"));
  assert.equal(byDir.name, "docs");
  assert.equal(byDir.companionWorktreesDir, path.join(base, "elsewhere", "docs-worktrees"));
});

test("resolveArtifacts: a managed worktree resolves against the primary checkout", () => {
  const base = tmp("agento-hooklib-");
  const primary = path.join(base, "project");
  const git = initRepo(primary);
  writeConfig(primary, ".github/agento.json", JSON.stringify({ artifacts: { repo: { name: "project-docs" } } }));
  git("add", "-A");
  git("commit", "-q", "-m", "config");
  const worktree = path.join(base, "project-worktrees", "plan-1");
  git("worktree", "add", "-q", "-b", "feature/x", worktree);

  const resolved = resolveArtifacts(worktree);
  assert.equal(resolved.external, true);
  assert.equal(resolved.companionPath, path.join(base, "project-docs"));
  assert.equal(resolved.primaryRoot, primary);
});

test("resolveArtifacts: the worktree's own config wins when the primary sets no artifacts.repo", () => {
  const base = tmp("agento-hooklib-");
  const primary = path.join(base, "project");
  const git = initRepo(primary);
  const worktree = path.join(base, "wt", "plan-1");
  git("worktree", "add", "-q", "-b", "feature/x", worktree);
  writeConfig(worktree, ".github/agento.json", JSON.stringify({ artifacts: { repo: { name: "project-docs" } } }));

  const resolved = resolveArtifacts(worktree);
  assert.equal(resolved.companionPath, path.join(base, "project-docs"));
  assert.equal(resolved.primaryRoot, primary);
  assert.equal(resolveArtifacts(primary).external, false);
});

test("runGit: trimmed stdout, empty on failure", () => {
  const dir = tmp("agento-hooklib-");
  initRepo(dir);
  assert.equal(runGit(dir, "branch", "--show-current"), "main");
  assert.equal(runGit(path.join(dir, "missing"), "rev-parse", "--show-toplevel"), "");
});

test("toJson: Python json.dumps spelling", () => {
  assert.equal(toJson({ a: "b", c: { d: "\n\t\"é\u007f" } }), '{"a": "b", "c": {"d": "\\n\\t\\"\\u00e9\\u007f"}}');
});
