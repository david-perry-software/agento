// Temporary differential test (hooks-node-port step 2.1): every case runs through the
// Python and the Node implementation of each hook and the stdout must be byte-identical.
// Deleted together with the Python heredocs and the AGENTO_HOOK_IMPL switch (step 3.1).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guard = path.join(repoRoot, "scripts", "hooks", "delivery-guard.sh");
const sessionHook = path.join(repoRoot, "scripts", "hooks", "session-context.sh");

function runHook(script, input, { cwd = os.tmpdir(), impl }) {
  const result = spawnSync("bash", [script], {
    input,
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, AGENTO_HOOK_IMPL: impl },
  });
  assert.equal(result.status, 0, `${impl} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

// Runs every case through both implementations; returns the differing cases.
function differences(script, cases) {
  const diffs = [];
  for (const { label, input, cwd } of cases) {
    const python = runHook(script, input, { cwd, impl: "python" });
    const node = runHook(script, input, { cwd, impl: "node" });
    if (python !== node) diffs.push({ label, python, node });
  }
  return diffs;
}

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

function initRepo(dir, defaultBranch = "main") {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", defaultBranch);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

const commandPayload = (command, cwd) => JSON.stringify({ tool_name: "run_in_terminal", tool_input: { command }, cwd });

function fixtureCommands(file) {
  return fs.readFileSync(path.join(repoRoot, "tests", file), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.replace(/^(allow|ask|deny)\s+/, ""));
}

// The replay harness's throwaway repo; with `companion`, its REPLAY_COMPANION layout.
function replayRepo({ companion = false } = {}) {
  const cwd = tmp("agento-parity-replay-");
  initRepo(cwd);
  git(cwd, "switch", "-q", "-c", "feature/replay");
  if (!companion) return { cwd };
  const docs = `${cwd}-docs`;
  initRepo(docs, "trunk");
  git(docs, "switch", "-q", "-c", "feature/replay");
  fs.mkdirSync(path.join(cwd, ".github"));
  fs.writeFileSync(path.join(cwd, ".github", "agento.json"), JSON.stringify({ artifacts: { repo: { dir: `../${path.basename(cwd)}-docs` } }, branches: { default: "trunk" } }) + "\n");
  git(cwd, "add", ".github/agento.json");
  git(cwd, "commit", "-q", "-m", "companion config");
  return { cwd, docs };
}

// A managed session pair: product + companion clones, halves under <name>-worktrees/plan-1.
function sessionPair() {
  const base = tmp("agento-parity-pair-");
  const product = path.join(base, "project");
  const companion = path.join(base, "project-docs");
  initRepo(product);
  initRepo(companion);
  fs.mkdirSync(path.join(product, ".github"));
  fs.writeFileSync(path.join(product, ".github", "agento.json"), JSON.stringify({ artifacts: { repo: { name: "project-docs" } } }));
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "companion config");
  const productHalf = path.join(base, "project-worktrees", "plan-1");
  const companionHalf = path.join(base, "project-docs-worktrees", "plan-1");
  git(product, "worktree", "add", "-q", "-b", "feature/widget", productHalf);
  git(companion, "worktree", "add", "-q", "-b", "feature/widget", companionHalf);
  return { product, companion, productHalf, companionHalf };
}

function guardTestCorpus() {
  const repo = tmp("agento-parity-guard-");
  initRepo(repo);
  git(repo, "switch", "-q", "-c", "feature/widget");
  fs.mkdirSync(path.join(repo, "features", "widget"), { recursive: true });
  fs.writeFileSync(path.join(repo, "features", "widget", "roadmap.md"), "status: planned\n");
  fs.writeFileSync(path.join(repo, "code.js"), "export {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  fs.writeFileSync(path.join(repo, "code.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(repo, "other.js"), "export {};\n");
  git(repo, "add", "other.js");

  const inRepo = [
    "git commit -m 'feat: widget'",
    "git commit -am 'feat: x'",
    "git commit -m 'feat: x' code.js",
    "git commit -m 'feat: x' code.js features/widget/roadmap.md",
    'git add features/widget/roadmap.md && git commit -m "docs(feature): widget in-review" 2>&1',
    "git commit -m 'docs: x' 2>/dev/null",
    "git commit -m 'docs: x' >/tmp/agento-guard-out.txt",
    "git commit -m 'docs: x' > /tmp/agento-guard-out.txt 2>&1",
    "git commit -m 'docs: x' &>/dev/null",
    "git commit -m 'feat: x' 2>/dev/null code.js",
    "git commit -m 'feat: x' > /tmp/agento-guard-out.txt code.js",
    "git commit -F msg.txt",
    "git commit --message x --all",
    "git commit -C HEAD",
    "git commit -m x -- code.js",
    "git commit -m 'üñí ✓' code.js",
    "git switch main && git commit --allow-empty -m x",
    "git checkout main; git merge feature/widget",
    "git switch main && git merge --ff-only origin/main",
    "git switch main && git switch -c feature/other && git commit --allow-empty -m x",
    "git stash && git switch main && git stash pop",
    "if true; then git push origin main; fi",
    "git status && echo done",
    "git branch --delete --force feature/x",
    "git reset --hard",
    "git push origin main-thing",
    "git push --force-with-lease=origin/x origin feature/x",
    "git worktree remove /nonexistent/agento-parity-path",
    "git -C /tmp/agento-parity-nonexistent commit -m x",
    "cd ~ && git status",
    "rm scripts/hooks/delivery-guard.sh",
    "cp /tmp/x scripts/hooks/delivery-guard.sh",
    "cp scripts/hooks/delivery-guard.sh /tmp/x",
    "perl -pi -e 's/a/b/' scripts/hooks/delivery-guard.sh",
    "git checkout HEAD~1 -- scripts/hooks/delivery-guard.sh",
    "chmod +x scripts/hooks/new.sh",
    "env FOO=1 timeout 5 rm scripts/hooks/x.sh",
    "sudo tee .github/hooks/hooks.json",
    "echo \"unbalanced > scripts/hooks/x.sh",
    "cat scripts/hooks/delivery-guard.sh | grep deny",
    "nohup gh run watch 1 &",
    "env GH_TOKEN=x gh pr checks 5 --watch",
    "timeout 600 vercel deploy --wait",
    "sudo -u bob gh run watch 1",
    "gh pr merge 5 --squash --admin",
    "gh pr merge 5 --rebase",
  ].map((command) => ({ label: command, input: commandPayload(command, repo) }));

  const pair = sessionPair();
  fs.writeFileSync(path.join(pair.productHalf, "code.js"), "export {};\n");
  git(pair.productHalf, "add", "code.js");
  const companionCases = [
    "git commit -m 'feat: widget'",
    `git -C ${pair.companionHalf} commit -m x`,
    `git -C ${pair.companionHalf} push origin main`,
    `git -C ${pair.companionHalf} push -u origin feature/widget`,
    `cd ${pair.companion} && git push origin HEAD:main`,
    `git -C ${pair.companion} push origin feature/widget`,
    `git -C ${pair.companion} switch main && git -C ${pair.companion} commit -m x`,
  ].map((command) => ({ label: `pair: ${command}`, input: commandPayload(command, pair.productHalf) }));

  const raw = [
    { label: "edit tool on a hook file", input: JSON.stringify({ tool_name: "replace_string_in_file", tool_input: { filePath: path.join(repoRoot, "scripts", "hooks", "delivery-guard.sh") }, cwd: repo }) },
    { label: "camelCase create on .github/hooks", input: JSON.stringify({ toolName: "create_file", toolInput: { file_path: ".github/hooks/x.json" } }) },
    { label: "read tool on a hook file", input: JSON.stringify({ tool_name: "read_file", tool_input: { filePath: "scripts/hooks/x" } }) },
    { label: "malformed JSON", input: "not json", cwd: repo },
    { label: "empty input", input: "", cwd: repo },
    { label: "non-object JSON", input: "[1, 2]", cwd: repo },
    { label: "string tool_input", input: JSON.stringify({ tool_name: "run_in_terminal", tool_input: "git push origin main" }), cwd: repo },
  ];
  return [...inRepo, ...companionCases, ...raw];
}

function writeRoadmap(root, rel, header) {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  fs.writeFileSync(path.join(root, rel, "roadmap.md"), "```yaml\n" + header + "\n```\n");
}

function sessionCorpus() {
  const cases = [];
  const add = (label, cwd) => cases.push({ label, input: JSON.stringify({ cwd }) });

  const empty = tmp("agento-parity-session-");
  initRepo(empty);
  git(empty, "switch", "-q", "-c", "feature/widget");
  add("plain, no work", empty);

  const plain = tmp("agento-parity-session-");
  initRepo(plain);
  git(plain, "switch", "-q", "-c", "feature/widget");
  writeRoadmap(plain, "features/2026/09/alpha", 'status: in-progress\nnext-step: "1.2 wire it"');
  writeRoadmap(plain, "features/2026/09/gamma", "status: complete\nnext-step: x");
  writeRoadmap(plain, "issues/2026/09/beta", "status: paused\nnext-step: 2.1 blocked on auth # comment");
  add("plain, resumable roadmaps", plain);

  const quoted = tmp("agento-parity-session-");
  initRepo(quoted);
  writeRoadmap(quoted, "features/2026/09/alpha", 'status: in-review\nnext-step: "say \\"hi\\"\tC:\\path é"');
  add("plain on main, quotes/tabs/non-ASCII in next-step", quoted);

  const custom = tmp("agento-parity-session-");
  initRepo(custom);
  fs.mkdirSync(path.join(custom, ".github"));
  fs.writeFileSync(path.join(custom, ".github", "agento.json"), JSON.stringify({ artifacts: { features: "planning/features", issues: null } }));
  writeRoadmap(custom, "planning/features/2026/09/alpha", "status: in-review\nnext-step: review");
  add("custom roots", custom);

  const managedBase = tmp("agento-parity-session-");
  const managedPrimary = path.join(managedBase, "project");
  initRepo(managedPrimary);
  fs.mkdirSync(path.join(managedPrimary, ".github"));
  fs.writeFileSync(path.join(managedPrimary, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: path.join(managedBase, "wt") } }));
  git(managedPrimary, "add", "-A");
  git(managedPrimary, "commit", "-q", "-m", "config");
  const build = path.join(managedBase, "wt", "feature-widget");
  git(managedPrimary, "worktree", "add", "-q", "-b", "feature/widget", build);
  writeRoadmap(build, "features/2026/09/widget", 'status: in-progress\nbranch: feature/widget\nnext-step: "1.1 step"');
  add("managed build worktree", build);

  const pair = sessionPair();
  writeRoadmap(pair.companionHalf, "features/2026/09/widget", 'status: in-progress\nnext-step: "1.1 step"');
  writeRoadmap(pair.companion, "features/2026/09/clone-only", "status: in-progress\nnext-step: x");
  add("pair: product half", pair.productHalf);
  add("pair: primary", pair.product);
  add("pair: companion clone as cwd", pair.companion);

  const detached = sessionPair();
  git(detached.companionHalf, "switch", "-q", "--detach", "HEAD");
  add("pair: detached half", detached.productHalf);

  const noHalf = sessionPair();
  git(noHalf.companion, "worktree", "remove", "--force", noHalf.companionHalf);
  add("pair: no companion half", noHalf.productHalf);

  const missing = sessionPair();
  fs.rmSync(missing.companion, { recursive: true, force: true });
  add("companion: missing clone", missing.product);

  const flipBase = tmp("agento-parity-session-");
  const flipPrimary = path.join(flipBase, "project");
  initRepo(flipPrimary);
  initRepo(path.join(flipBase, "project-docs"));
  writeRoadmap(path.join(flipBase, "project-docs"), "features/2026/09/widget", "status: in-progress\nnext-step: x");
  const flip = path.join(flipBase, "wt", "plan-1");
  git(flipPrimary, "worktree", "add", "-q", "-b", "feature/widget", flip);
  fs.mkdirSync(path.join(flip, ".github"));
  fs.writeFileSync(path.join(flip, ".github", "agento.json"), JSON.stringify({ artifacts: { repo: { name: "project-docs" } } }));
  add("worktree config wins over a primary without artifacts.repo", flip);
  add("its primary stays in-repo", flipPrimary);

  add("not a git repository", tmp("agento-parity-nogit-"));
  cases.push({ label: "malformed payload", input: "not json", cwd: plain });
  return cases;
}

test("parity: guard fixtures (tests/guard-fixtures.txt)", (t) => {
  const { cwd } = replayRepo();
  const cases = fixtureCommands("guard-fixtures.txt").map((command) => ({ label: command, input: commandPayload(command, cwd) }));
  t.diagnostic(`guard-fixtures.txt: ${cases.length} commands`);
  assert.deepEqual(differences(guard, cases), []);
});

test("parity: companion guard fixtures (tests/guard-fixtures-companion.txt)", (t) => {
  const { cwd, docs } = replayRepo({ companion: true });
  const cases = fixtureCommands("guard-fixtures-companion.txt")
    .map((command) => command.replaceAll("{companion}", docs))
    .map((command) => ({ label: command, input: commandPayload(command, cwd) }));
  t.diagnostic(`guard-fixtures-companion.txt: ${cases.length} commands`);
  assert.deepEqual(differences(guard, cases), []);
});

test("parity: guard-test corpus", (t) => {
  const cases = guardTestCorpus();
  t.diagnostic(`guard-test corpus: ${cases.length} payloads`);
  assert.ok(cases.length >= 40);
  assert.deepEqual(differences(guard, cases), []);
});

test("parity: SessionStart corpus", (t) => {
  const cases = sessionCorpus();
  t.diagnostic(`SessionStart corpus: ${cases.length} payloads`);
  assert.deepEqual(differences(sessionHook, cases), []);
});
