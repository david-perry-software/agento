import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveGitDir } from "../../src/gitDir.js";

test("resolveGitDir resolves repositories and linked worktrees", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "agento-git-dir-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, "repo");
  const worktree = path.join(parent, "worktree");

  execFileSync("git", ["init", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Agento Test", "-c", "user.email=agento@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
  execFileSync("git", ["worktree", "add", "-b", "fixture-worktree", worktree], { cwd: repo });

  const repositoryDirectories = await resolveGitDir(repo);
  assert.deepEqual(repositoryDirectories, {
    gitDir: path.join(repo, ".git"),
    commonDir: path.join(repo, ".git"),
  });

  const worktreeDirectories = await resolveGitDir(worktree);
  assert.equal(path.dirname(worktreeDirectories.gitDir), path.join(repo, ".git", "worktrees"));
  assert.equal(worktreeDirectories.commonDir, path.join(repo, ".git"));
});