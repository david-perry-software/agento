// Deterministic before/after replay of the publish flows rewired by publish-cli.
//
// For each flow, two identical scratch sandboxes (product and companion clones with
// local bare origins, a fake `gh` on PATH logging every call) run (a) "before": the
// hand-run git/gh sequence the pre-publish-cli prompts and agents prescribed, one
// shell command per tool call, and (b) "after": the single agento.mjs call. Both must
// reach the same end state; the counts are reported as test diagnostics.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "scripts", "agento.mjs");
const waitForChecks = path.join(repoRoot, "scripts", "wait-for-checks.sh");

const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], quiet).trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const which = (tool) => execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();

function cloneWithOrigin(base, name, config) {
  const origin = path.join(base, `${name}.git`);
  const work = path.join(base, name);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin], quiet);
  execFileSync("git", ["clone", "-q", origin, work], quiet);
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

function advanceRemote(work, branch, file, text) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-other-"));
  execFileSync("git", ["clone", "-q", "--branch", branch, git(work, "remote", "get-url", "origin"), tmp], quiet);
  git(tmp, "config", "user.email", "other@example.com");
  git(tmp, "config", "user.name", "Other");
  fs.writeFileSync(path.join(tmp, file), text);
  git(tmp, "add", "-A");
  git(tmp, "commit", "-q", "-m", `other: ${file}`);
  git(tmp, "push", "-q", "origin", branch);
}

// The fake gh: the scripts/agento.test.mjs shipStub pattern (state file, `$PWD $*`
// call log, a real merge into the bare origin), plus the hand-run forms the old prose
// used: `pr view --jq .<field>`, `repo view -q .url`, and `pr comment`.
function fakeGh({ product = {}, companion = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-gh-"));
  const green = [[{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" }]];
  const state = { product: { nameWithOwner: "acme/project", prs: {}, comments: [], ...product }, companion: { nameWithOwner: "acme/project-docs", prs: {}, comments: [], ...companion }, nextNumber: 100, rollups: green };
  for (const repo of ["product", "companion"]) {
    for (const [branch, pr] of Object.entries(state[repo].prs)) {
      state[repo].prs[branch] = { state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: branch, body: "", baseRefName: "main", mergeCommit: null, rollups: green, rollupCalls: 0, url: `https://github.test/${state[repo].nameWithOwner}/pull/${pr.number}`, ...pr };
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
const jq = opt("--jq") ?? opt("-q");
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] === "auth") { console.log("Logged in"); process.exit(0); }
if (args[0] === "repo" && args[1] === "view") {
  const view = { nameWithOwner: repo.nameWithOwner, url: "https://github.test/" + repo.nameWithOwner };
  console.log(jq ? view[jq.slice(1)] : JSON.stringify(view)); process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const pr = findPr(args[2]);
  if (!pr) die("no pull requests found for branch \\"" + args[2] + "\\"");
  const fields = (opt("--json") || "").split(",").filter(Boolean);
  if (fields.includes("statusCheckRollup") && jq) {
    const rollup = pr.rollups[Math.min(pr.rollupCalls || 0, pr.rollups.length - 1)];
    pr.rollupCalls = (pr.rollupCalls || 0) + 1; save();
    const bucket = (c) => c.status !== "COMPLETED" ? "pending" : (c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL") ? "pass" : c.conclusion === "SKIPPED" ? "skipped" : "fail";
    const rows = rollup.map((c) => ({ name: c.name, bucket: bucket(c) }));
    const count = (b) => rows.filter((r) => r.bucket === b).length;
    console.log([count("pass"), count("fail"), count("pending"), count("skipped"), pr.mergeStateStatus || "UNKNOWN"].join(" ") + " | " + rows.filter((r) => r.bucket !== "pass").map((r) => r.name + "=" + r.bucket).join(", "));
    process.exit(0);
  }
  const view = {};
  for (const f of fields) view[f] = f === "mergeCommit" ? (pr.mergeCommit ? { oid: pr.mergeCommit } : null) : f === "statusCheckRollup" ? [] : (pr[f] ?? null);
  if (jq && /^\\.\\w+$/.test(jq)) { process.stdout.write(String(view[jq.slice(1)] ?? "") + "\\n"); process.exit(0); }
  console.log(JSON.stringify(fields.length ? view : pr));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "ready") { const pr = findPr(args[2]); if (!pr) die("not found"); pr.isDraft = false; save(); process.exit(0); }
if (args[0] === "pr" && args[1] === "merge") {
  const pr = findPr(args[2]);
  if (!pr) die("not found");
  if (pr.state !== "OPEN") die("Pull request #" + pr.number + " is not open");
  if (pr.isDraft) die("Pull request #" + pr.number + " is still a draft");
  if (args.some((a) => ["--admin", "--squash", "--rebase", "--auto", "--delete-branch"].includes(a))) die("forbidden merge flag: " + args.slice(3).join(" "));
  const branch = Object.keys(repo.prs).find((b) => repo.prs[b] === pr);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-merge-"));
  git("clone", "-q", git("-C", process.cwd(), "remote", "get-url", "origin"), tmp);
  git("-C", tmp, "config", "user.email", "bot@example.com"); git("-C", tmp, "config", "user.name", "gh-stub");
  git("-C", tmp, "merge", "-q", "--no-ff", "-m", "Merge pull request #" + pr.number + " from " + branch, "origin/" + branch);
  git("-C", tmp, "push", "-q", "origin", "main");
  pr.state = "MERGED"; pr.mergeCommit = git("-C", tmp, "rev-parse", "HEAD"); pr.mergeStateStatus = "UNKNOWN"; save();
  console.log("Merged pull request #" + pr.number); process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = opt("--head") || git("-C", process.cwd(), "branch", "--show-current");
  if (repo.prs[head] && repo.prs[head].state === "OPEN") die("a pull request for branch \\"" + head + "\\" already exists: " + repo.prs[head].url);
  const number = state.nextNumber++;
  repo.prs[head] = { number, state: "OPEN", isDraft: args.includes("--draft"), mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: opt("--title") || head, body: opt("--body") || "", baseRefName: opt("--base") || "main", mergeCommit: null, rollups: state.rollups, rollupCalls: 0, url: "https://github.test/" + repo.nameWithOwner + "/pull/" + number };
  save(); console.log(repo.prs[head].url); process.exit(0);
}
if (args[0] === "pr" && args[1] === "comment") {
  const pr = findPr(args[2]);
  if (!pr) die("not found");
  const mine = repo.comments.filter((c) => c.issue === pr.number && c.user.login === "agento-bot");
  if (args.includes("--edit-last")) { if (!mine.length) die("no comments found for current user"); mine.at(-1).body = opt("--body"); }
  else repo.comments.push({ id: 7000 + repo.comments.length, issue: pr.number, user: { login: "agento-bot" }, body: opt("--body") });
  save(); console.log(pr.url + "#issuecomment"); process.exit(0);
}
if (args[0] === "api" && args[1] === "user") { console.log(JSON.stringify({ login: "agento-bot" })); process.exit(0); }
if (args[0] === "api" && (args[1] || "").split("?")[0].split("/")[3] === "issues") {
  const parts = args[1].split("?")[0].split("/");
  const method = opt("-X") || "GET";
  const text = (args.find((a) => a.startsWith("body=")) || "").slice(5);
  if (parts[4] === "comments" && method === "PATCH") { const c = repo.comments.find((x) => String(x.id) === parts[5]); if (!c) die("Not Found (HTTP 404)"); c.body = text; save(); console.log(JSON.stringify(c)); process.exit(0); }
  if (parts[5] === "comments" && method === "POST") { const id = 7000 + repo.comments.length; const c = { id, issue: Number(parts[4]), user: { login: "agento-bot" }, body: text, html_url: "https://github.test/comment/" + id }; repo.comments.push(c); save(); console.log(JSON.stringify(c)); process.exit(0); }
  if (parts[5] === "comments") { console.log(JSON.stringify(repo.comments.filter((c) => c.issue === Number(parts[4])))); process.exit(0); }
}
if (args[0] === "api" && opt("-X") === "PATCH") {
  const m = (args[1] || "").match(/pulls\\/(\\d+)$/);
  const pr = m && findPr(m[1]);
  if (!pr) die("Not Found (HTTP 404)");
  const field = args.find((a) => a.startsWith("body="));
  if (field) pr.body = field.slice(5);
  save(); console.log(JSON.stringify({ number: pr.number, body: pr.body })); process.exit(0);
}
die("gh stub: unsupported " + args.join(" "));
`;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-bin-"));
  fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const tool of ["git", "bash", "grep", "sed", "sleep"]) fs.symlinkSync(which(tool), path.join(bin, tool));
  const env = { ...process.env, PATH: bin, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
  delete env.CODESPACES;
  delete env.GITHUB_ACTIONS;
  env.AGENTO_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-config-"));
  env.AGENTO_VSCODE_SETTINGS = path.join(env.AGENTO_CONFIG_HOME, "vscode-settings.json");
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  return { env, bash: path.join(bin, "bash"), calls, state: () => JSON.parse(fs.readFileSync(stateFile, "utf8")) };
}

// One tool call each. `shell` and `lookup` run one bash command (`lookup` only fills a
// placeholder the prose leaves to the agent); `edit` is a file-edit tool call.
function replay(gh, steps) {
  const ctx = {};
  const tally = { shell: 0, lookup: 0, edit: 0 };
  for (const step of steps) {
    tally[step.kind] += 1;
    if (step.kind === "edit") {
      step.apply(ctx);
      continue;
    }
    const command = step.cmd(ctx);
    const result = spawnSync(gh.bash, ["-c", command], { cwd: step.cwd, env: gh.env, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}\n${result.stdout}\n${result.stderr}`);
    step.out?.(result.stdout.trim(), ctx);
  }
  return { tally, toolCalls: tally.shell + tally.lookup + tally.edit };
}

function agento(gh, cwd, args, input = undefined) {
  const result = spawnSync("node", [cli, ...args], { cwd, env: gh.env, encoding: "utf8", input });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    assert.fail(`non-JSON output: ${result.stdout}\n${result.stderr}`);
  }
  return { code: result.status, json };
}

const remoteHead = (dir, branch) => git(dir, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0] ?? "";
const half = (dir) => ({ branch: git(dir, "branch", "--show-current"), clean: git(dir, "status", "--porcelain", "--untracked-files=all") === "", pushed: git(dir, "rev-parse", "HEAD") === remoteHead(dir, git(dir, "branch", "--show-current")) });
const readiedOrMerged = (gh) => gh.calls().filter((c) => / pr (ready|merge)\b/.test(c)).length;
const prNumber = (url) => Number(url.match(/\/pull\/(\d+)$/)[1]);

function report(t, flow, before, after, ghBefore, ghAfter) {
  const { shell, lookup, edit } = before.tally;
  t.diagnostic(`${flow}: before ${before.toolCalls} tool calls (${shell} shell, ${lookup} lookup, ${edit} file edit); after ${after.toolCalls} (agento.mjs); fake gh invocations before ${ghBefore}, after ${ghAfter}`);
}

// --- new-feature, companion layout: Planner step 8 → agento.mjs plan-publish ------

const SLUG_DIR = "features/2026/10/widget";
const BRANCH = "feature/widget";

function planningSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-"));
  const repo = cloneWithOrigin(base, "project", { worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } });
  const docs = cloneWithOrigin(base, "project-docs");
  const id = "20261012-000000";
  const product = path.join(base, "wt", `plan-${id}`);
  const companion = path.join(base, "project-docs-worktrees", `plan-${id}`);
  fs.mkdirSync(path.dirname(product));
  fs.mkdirSync(path.dirname(companion));
  git(repo, "worktree", "add", "-q", "--detach", product, "origin/main");
  git(product, "switch", "-q", "-c", BRANCH);
  git(docs, "worktree", "add", "-q", "--detach", companion, "origin/main");
  git(companion, "switch", "-q", "-c", BRANCH);
  fs.writeFileSync(path.join(base, "wt", `plan-${id}.code-workspace`), "{}\n");
  fs.mkdirSync(path.join(companion, SLUG_DIR), { recursive: true });
  fs.writeFileSync(path.join(companion, SLUG_DIR, "roadmap.md"), "```yaml\nstatus: planned\nbranch: feature/widget\nlast-updated: 2026-10-12\nnext-step: \"1.1\"\n```\n\n## Phase 1\n\n- [ ] 1.1 build it — verify: x\n");
  fs.writeFileSync(path.join(companion, SLUG_DIR, "plan.md"), "# widget\n");
  return { product, companion };
}

function planState(s, gh) {
  const { product: p, companion: c } = gh.state();
  const code = p.prs[BRANCH];
  const docs = c.prs[BRANCH];
  const log = (dir) => git(dir, "log", "--format=%s", `origin/main..HEAD`).split("\n");
  const changed = (dir) => git(dir, "diff", "--name-only", "origin/main", "HEAD").split("\n").filter(Boolean).sort();
  return {
    product: { ...half(s.product), subjects: log(s.product), changed: changed(s.product) },
    companion: { ...half(s.companion), subjects: log(s.companion), changed: changed(s.companion), artifactPr: fs.readFileSync(path.join(s.companion, SLUG_DIR, "roadmap.md"), "utf8").match(/^artifact-pr: (.*)$/gm) },
    codePr: { number: code.number, state: code.state, isDraft: code.isDraft, base: code.baseRefName, title: code.title, linksPlan: code.body.includes(`https://github.test/acme/project-docs/blob/${BRANCH}/${SLUG_DIR}/plan.md`), crossLink: (code.body.match(new RegExp(`Companion PR: ${docs.url}`, "g")) ?? []).length },
    companionPr: { number: docs.number, state: docs.state, isDraft: docs.isDraft, base: docs.baseRefName, title: docs.title, linksCodePr: docs.body.includes(code.url) },
    readiedOrMerged: readiedOrMerged(gh),
  };
}

test("replay new-feature (companion): the Planner's hand-run publish vs one plan-publish call reach the same state in fewer calls", (t) => {
  const s = planningSandbox();
  const gh = fakeGh();
  const before = replay(gh, [
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} add ${SLUG_DIR}` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} commit -m "docs(feature): plan widget"` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} push -u origin ${BRANCH}` },
    { kind: "shell", cwd: s.product, cmd: () => `git commit --allow-empty -m "chore(feature): open widget"` },
    { kind: "shell", cwd: s.product, cmd: () => `git push -u origin ${BRANCH}` },
    { kind: "lookup", cwd: s.product, cmd: () => `cd ${q(s.companion)} && gh repo view --json url -q .url`, out: (o, ctx) => (ctx.docsUrl = o) },
    { kind: "shell", cwd: s.product, cmd: (ctx) => `gh pr create --draft --base main --title widget --body ${q(`Plan: ${ctx.docsUrl}/blob/${BRANCH}/${SLUG_DIR}/plan.md`)}`, out: (o, ctx) => (ctx.codeUrl = o) },
    { kind: "shell", cwd: s.product, cmd: (ctx) => `cd ${q(s.companion)} && gh pr create --draft --head ${BRANCH} --base main --title "docs(feature): widget" --body ${q(`Delivery artifacts for widget. Code PR: ${ctx.codeUrl}`)}`, out: (o, ctx) => (ctx.docsPrUrl = o) },
    { kind: "lookup", cwd: s.product, cmd: () => `gh repo view --json nameWithOwner -q .nameWithOwner`, out: (o, ctx) => (ctx.nwo = o) },
    { kind: "shell", cwd: s.product, cmd: (ctx) => `current_body=$(gh pr view ${prNumber(ctx.codeUrl)} --json body --jq '.body'); if ! printf '%s' "$current_body" | grep -Fq ${q(ctx.docsPrUrl)}; then gh api repos/${ctx.nwo}/pulls/${prNumber(ctx.codeUrl)} -X PATCH -f body="\${current_body}"$'\\n\\nCompanion PR: '${q(ctx.docsPrUrl)}; fi` },
    { kind: "edit", apply: (ctx) => {
      const file = path.join(s.companion, SLUG_DIR, "roadmap.md");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^(next-step: .*)$/m, `$1\nartifact-pr: "#${prNumber(ctx.docsPrUrl)}"`));
    } },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} commit -am "docs(feature): record artifact PR for widget"` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} push` },
  ]);
  const beforeState = planState(s, gh);
  const ghBefore = gh.calls().length;

  const s2 = planningSandbox();
  const gh2 = fakeGh();
  const { code, json } = agento(gh2, s2.product, ["plan-publish", "feature", "widget"]);
  assert.equal(code, 0, JSON.stringify(json));
  const after = { toolCalls: 1 };
  const afterState = planState(s2, gh2);

  assert.deepEqual(afterState, beforeState);
  assert.deepEqual(afterState.product, { branch: BRANCH, clean: true, pushed: true, subjects: ["chore(feature): open widget"], changed: [] });
  assert.deepEqual(afterState.companion.subjects, ["docs(feature): record artifact PR for widget", "docs(feature): plan widget"]);
  assert.deepEqual(afterState.companion.artifactPr, ['artifact-pr: "#101"']);
  assert.equal(afterState.codePr.isDraft && afterState.companionPr.isDraft, true);
  assert.equal(afterState.codePr.crossLink, 1);
  assert.equal(afterState.readiedOrMerged, 0);
  assert.ok(after.toolCalls < before.toolCalls);
  report(t, "new-feature companion (plan-publish)", before, after, ghBefore, gh2.calls().length);
});

// --- quick-fix: steps 7–9 → agento.mjs publish-pr --merge ---------------------------

const FIX = "changes/tidy-readme";
const TITLE = "docs: tidy the readme";
const BODY = "Tidy the readme wording. Verified: proofread.";

function quickFixSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-"));
  const repo = cloneWithOrigin(base, "project", { worktrees: { dir: "../wt" } });
  git(repo, "switch", "-q", "-c", FIX);
  fs.writeFileSync(path.join(repo, "README.md"), "Tidy.\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", TITLE);
  return { repo };
}

function quickFixState(s, gh) {
  const pr = gh.state().product.prs[FIX];
  return {
    ...half(s.repo),
    synced: git(s.repo, "rev-parse", "HEAD") === remoteHead(s.repo, "main"),
    mergeCommit: git(s.repo, "log", "-1", "--format=%P").split(" ").length === 2 && git(s.repo, "rev-parse", "HEAD") === pr.mergeCommit,
    hasChange: fs.readFileSync(path.join(s.repo, "README.md"), "utf8"),
    localBranch: git(s.repo, "branch", "--list", FIX),
    remoteBranch: remoteHead(s.repo, FIX),
    pr: { number: pr.number, state: pr.state, isDraft: pr.isDraft, base: pr.baseRefName, title: pr.title, body: pr.body.trimEnd() },
    merges: gh.calls().filter((c) => / pr merge /.test(c)).map((c) => c.replace(/^\S+ /, "")),
  };
}

test("replay quick-fix: the hand-run push → PR → wait → merge → sync vs one publish-pr --merge call reach the same state in fewer calls", (t) => {
  const s = quickFixSandbox();
  const gh = fakeGh();
  const before = replay(gh, [
    { kind: "shell", cwd: s.repo, cmd: () => `git push -u origin ${FIX}` },
    { kind: "shell", cwd: s.repo, cmd: () => `gh pr create --base main --title ${q(TITLE)} --body ${q(BODY)}`, out: (o, ctx) => (ctx.pr = prNumber(o)) },
    { kind: "shell", cwd: s.repo, cmd: (ctx) => `${q(waitForChecks)} pr ${ctx.pr}` },
    { kind: "shell", cwd: s.repo, cmd: (ctx) => `gh pr merge ${ctx.pr} --merge` },
    { kind: "shell", cwd: s.repo, cmd: () => `git push origin --delete ${FIX}` },
    { kind: "shell", cwd: s.repo, cmd: () => `git switch main` },
    { kind: "shell", cwd: s.repo, cmd: () => `git fetch origin --prune` },
    { kind: "shell", cwd: s.repo, cmd: () => `git merge --ff-only origin/main` },
    { kind: "shell", cwd: s.repo, cmd: () => `git branch -d ${FIX}` },
    { kind: "shell", cwd: s.repo, cmd: () => `git status --short --branch` },
  ]);
  const beforeState = quickFixState(s, gh);
  const ghBefore = gh.calls().length;

  const s2 = quickFixSandbox();
  const gh2 = fakeGh();
  const { code, json } = agento(gh2, s2.repo, ["publish-pr", "--title", TITLE, "--body-file", "-", "--merge"], `${BODY}\n`);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.outcome, "merged");
  const after = { toolCalls: 1 };
  const afterState = quickFixState(s2, gh2);

  assert.deepEqual(afterState, beforeState);
  assert.deepEqual(afterState, { branch: "main", clean: true, pushed: true, synced: true, mergeCommit: true, hasChange: "Tidy.\n", localBranch: "", remoteBranch: "", pr: { number: 100, state: "MERGED", isDraft: false, base: "main", title: TITLE, body: BODY }, merges: ["pr merge 100 --merge"] });
  assert.ok(after.toolCalls < before.toolCalls);
  report(t, "quick-fix (publish-pr --merge)", before, after, ghBefore, gh2.calls().length);
});

// --- review-feature, companion layout: Reviewer step 8 → agento.mjs review-publish --

function reviewSandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-replay-"));
  const repo = cloneWithOrigin(base, "project", { worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } });
  const docs = cloneWithOrigin(base, "project-docs");
  for (const [work, write] of [
    [repo, (w) => fs.writeFileSync(path.join(w, "widget.js"), "export const widget = 1;\n")],
    [docs, (w) => {
      fs.mkdirSync(path.join(w, SLUG_DIR), { recursive: true });
      fs.writeFileSync(path.join(w, SLUG_DIR, "roadmap.md"), "```yaml\nstatus: in-review\nbranch: feature/widget\nnext-step: \"review\"\n```\n\n## Phase 1\n\n- [x] 1.1 build it — verify: x\n");
    }],
  ]) {
    git(work, "switch", "-q", "-c", BRANCH);
    write(work);
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", `plan ${BRANCH}`);
    git(work, "push", "-q", "-u", "origin", BRANCH);
    git(work, "switch", "-q", "main");
  }
  const product = path.join(base, "wt", "feature-widget");
  const companion = path.join(base, "project-docs-worktrees", "feature-widget");
  git(repo, "worktree", "add", "-q", product, BRANCH);
  git(docs, "worktree", "add", "-q", companion, BRANCH);
  fs.writeFileSync(path.join(base, "wt", "feature-widget.code-workspace"), "{}\n");
  advanceRemote(docs, "main", "docs-main.md", "docs main\n");
  fs.writeFileSync(path.join(companion, SLUG_DIR, "review.md"), "# Review: widget\n\nVerdict: approve\n");
  return { product, companion, start: { product: git(product, "rev-parse", "HEAD"), companion: git(companion, "rev-parse", "HEAD") } };
}

const reviewPrs = () => ({ product: { prs: { [BRANCH]: { number: 15 } } }, companion: { prs: { [BRANCH]: { number: 16 } } } });

function reviewState(s, gh) {
  const { product: p } = gh.state();
  return {
    product: { ...half(s.product), unchanged: git(s.product, "rev-parse", "HEAD") === s.start.product },
    companion: {
      ...half(s.companion),
      firstParent: git(s.companion, "log", "--first-parent", "--format=%P%x09%s", `${s.start.companion}..HEAD`).split("\n").map((l) => (l.split("\t")[0].includes(" ") ? "(merge)" : l.split("\t")[1])),
      defaultMerged: spawnSync("git", ["-C", s.companion, "merge-base", "--is-ancestor", "origin/main", "HEAD"]).status === 0,
    },
    comments: p.comments.map((c) => ({ issue: c.issue, verdict: c.body.split("\n")[0], linksReview: c.body.includes(`https://github.test/acme/project-docs/blob/${BRANCH}/${SLUG_DIR}/review.md`) })),
    readiedOrMerged: readiedOrMerged(gh),
  };
}

test("replay review-feature (companion): the Reviewer's hand-run publish vs one review-publish call reach the same state in fewer calls", (t) => {
  const s = reviewSandbox();
  const gh = fakeGh(reviewPrs());
  const before = replay(gh, [
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} add ${SLUG_DIR}` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} commit -m "docs(feature): review widget — approve"` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} fetch origin` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} merge --no-edit origin/main` },
    { kind: "shell", cwd: s.product, cmd: () => `git -C ${q(s.companion)} push` },
    { kind: "shell", cwd: s.product, cmd: () => `node ${q(cli)} session`, out: (o) => {
      const record = JSON.parse(o);
      assert.equal(record.companion.dirty, false);
      assert.equal(record.companion.ahead, 0);
    } },
    { kind: "lookup", cwd: s.product, cmd: () => `cd ${q(s.companion)} && gh repo view --json url -q .url`, out: (o, ctx) => (ctx.docsUrl = o) },
    { kind: "shell", cwd: s.product, cmd: (ctx) => `gh pr comment 15 --body ${q(`Verdict: approve\n\nReview: ${ctx.docsUrl}/blob/${BRANCH}/${SLUG_DIR}/review.md`)}` },
  ]);
  const beforeState = reviewState(s, gh);
  const ghBefore = gh.calls().length;

  const s2 = reviewSandbox();
  const gh2 = fakeGh(reviewPrs());
  const { code, json } = agento(gh2, s2.product, ["review-publish", "feature", "widget"]);
  assert.equal(code, 0, JSON.stringify(json));
  const after = { toolCalls: 1 };
  const afterState = reviewState(s2, gh2);

  assert.deepEqual(afterState, beforeState);
  assert.deepEqual(afterState.companion, { branch: BRANCH, clean: true, pushed: true, firstParent: ["(merge)", "docs(feature): review widget — approve"], defaultMerged: true });
  assert.deepEqual(afterState.comments, [{ issue: 15, verdict: "Verdict: approve", linksReview: true }]);
  assert.equal(afterState.product.unchanged, true);
  assert.equal(afterState.readiedOrMerged, 0);
  assert.ok(after.toolCalls < before.toolCalls);
  report(t, "review-feature companion (review-publish)", before, after, ghBefore, gh2.calls().length);
});
