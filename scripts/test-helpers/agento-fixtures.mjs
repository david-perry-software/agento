import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setHandoffModels, setModel } from "../model-profiles.mjs";

// Fixtures shared by scripts/commands/*.test.mjs. This module resolves the CLI
// path from its own location (scripts/test-helpers), never from the test file's
// location, per plan.md Approach rule 7.
const fixturesDir = path.dirname(fileURLToPath(import.meta.url)); // scripts/test-helpers
const cli = path.join(path.dirname(fixturesDir), "agento.mjs"); // scripts/agento.mjs
const repoRoot = path.dirname(path.dirname(cli)); // repo root

// Original shared fixtures (moved in step 4.1).
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

// A working clone with a bare origin, so remote fallbacks exercise real git.
// `companion: true` adds a sibling `<base>/project-docs` clone (own bare origin,
// `main` pushed) for artifacts.repo tests; the caller sets the config key.
function makeRepo({ config, companion = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-cli-"));
  const work = cloneWithOrigin(base, "project", config);
  if (companion) cloneWithOrigin(base, "project-docs");
  return work;
}

function cloneWithOrigin(base, name, config) {
  const origin = path.join(base, `${name}.git`);
  const work = path.join(base, name);
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

const companionOf = (repo) => path.join(path.dirname(repo), "project-docs");

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
// Never read the real ~/.config/agento/model-profiles.json.
baseEnv.AGENTO_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agento-config-home-"));
// Never read the real VS Code user settings (doctor hook-wiring).
baseEnv.AGENTO_VSCODE_SETTINGS = path.join(baseEnv.AGENTO_CONFIG_HOME, "vscode-settings.json");
// Never read the real VS Code window state (windows, handoff).
baseEnv.AGENTO_VSCODE_USER_DIR = path.join(baseEnv.AGENTO_CONFIG_HOME, "vscode-user");
// Never touch the real ~/.copilot/skills (harness install/status/uninstall).
baseEnv.AGENTO_COPILOT_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agento-skills-"));
// Never touch the real ~/.copilot/extensions (harness canvas link).
baseEnv.AGENTO_COPILOT_EXTENSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agento-extensions-"));

function runWith({ cwd, env, input }, ...args) {
  const result = spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", env: env ?? baseEnv, input: input ?? undefined });
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


// Shared fixtures moved during Phase 4 (steps 4.2/4.3).
function makeFlipRepo() {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" } }, companion: true });
  const docs = companionOf(repo);
  fs.mkdirSync(path.join(path.dirname(repo), "wt"));
  git(repo, "switch", "-q", "-c", "feature/flip");
  fs.writeFileSync(path.join(repo, ".github", "agento.json"), JSON.stringify({ worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: flip to companion");
  git(repo, "push", "-q", "-u", "origin", "feature/flip");
  git(repo, "switch", "-q", "main");
  git(docs, "switch", "-q", "-c", "feature/flip");
  writeRoadmap(docs, "features/2026/09/flip", "status: in-review\nbranch: feature/flip\nnext-step: review\nartifact-pr: \"#7\"");
  git(docs, "add", "-A");
  git(docs, "commit", "-q", "-m", "docs(feature): flip");
  git(docs, "push", "-q", "-u", "origin", "feature/flip");
  git(docs, "switch", "-q", "main");
  assert.ok(!fs.existsSync(path.join(docs, "features")));
  assert.ok(!fs.existsSync(path.join(repo, "features")));
  return { repo, docs };
}

function makePairRepo(extraConfig = {}) {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" }, artifacts: { repo: { name: "project-docs" } }, ...extraConfig }, companion: true });
  const base = path.dirname(repo);
  const docs = companionOf(repo);
  const wt = path.join(base, "wt");
  const docsWt = path.join(base, "project-docs-worktrees");
  fs.mkdirSync(wt);
  fs.mkdirSync(docsWt);
  return { repo, docs, wt, docsWt };
}

const strip = (record) => {
  const { companion, workspace, worktrees, warnings, ...rest } = record;
  return rest;
};

const okStubs = {
  gh: "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'gh version 9.9.9'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo 'Logged in' >&2; exit 0; fi\nexit 1\n",
  code: "#!/bin/sh\necho 1.99.0\n",
};

const byId = (json) => Object.fromEntries(json.checks.map((c) => [c.id, c]));

function harnessFixture({ canvas = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-harness-"));
  const plugin = path.join(base, "plugin");
  fs.mkdirSync(path.join(plugin, "skills", "agento"), { recursive: true });
  fs.writeFileSync(path.join(plugin, "skills", "agento", "SKILL.md"), "---\ndescription: router\n---\n\n# agento\n");
  if (canvas) {
    fs.mkdirSync(path.join(plugin, "canvas", "agento-mission-control"), { recursive: true });
    fs.writeFileSync(path.join(plugin, "canvas", "agento-mission-control", "extension.mjs"), "export default {};\n");
  }
  fs.mkdirSync(path.join(plugin, ".github", "agents"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".github", "agents", "delivery-builder.agent.md"), "---\nname: builder\n---\n# builder\n");
  execFileSync("git", ["init", "-q", "-b", "main", plugin]);
  git(plugin, "config", "user.email", "test@example.com");
  git(plugin, "config", "user.name", "Test");
  git(plugin, "add", "-A");
  git(plugin, "commit", "-q", "-m", "init");
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), "agento-skills-"));
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), "agento-extensions-"));
  const env = { ...baseEnv, AGENTO_COPILOT_SKILLS_DIR: skills, AGENTO_COPILOT_EXTENSIONS_DIR: extensions };
  const runHarness = (...args) => runWith({ cwd: plugin, env }, "harness", ...args);
  const link = path.join(skills, "agento");
  const canvasLink = path.join(extensions, "agento-mission-control");
  const canvasExpected = path.join(plugin, "canvas", "agento-mission-control");
  return { plugin, env, runHarness, link, canvasLink, canvasExpected };
}

function makeWorktreeRepo() {
  const repo = makeRepo({ config: { worktrees: { dir: "../wt" } } });
  const wt = path.join(path.dirname(repo), "wt");
  fs.mkdirSync(wt);
  return { repo, wt };
}

function prStub(marker, { product = "OPEN", companion = "OPEN", companionMerge = "CLEAN", companionMergeable = "MERGEABLE", logVersion = false } = {}) {
  const versionLog = logVersion ? `echo "$PWD $*" >> ${JSON.stringify(marker)}; ` : "";
  return `#!/bin/sh\nif [ "$1" = "--version" ]; then ${versionLog}exit 0; fi\necho "$PWD $*" >> ${JSON.stringify(marker)}\ncase "$PWD" in *project-docs*) n=7; s=${companion}; m=${companionMerge}; g=${companionMergeable};; *) n=15; s=${product}; m=CLEAN; g=MERGEABLE;; esac\nif [ "$s" = "NONE" ]; then echo 'no pull requests found for branch' >&2; exit 1; fi\necho "{\\"number\\":$n,\\"state\\":\\"$s\\",\\"isDraft\\":false,\\"mergeStateStatus\\":\\"$m\\",\\"mergeable\\":\\"$g\\",\\"url\\":\\"https://example.test/pr/$n\\"}"\n`;
}

function modelsFixture({ gitInit = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-models-"));
  const plugin = path.join(base, "plugin");
  for (const rel of [".github/agents", ".github/prompts", "skills/agento/commands"]) {
    fs.mkdirSync(path.join(plugin, path.dirname(rel)), { recursive: true });
    fs.cpSync(path.join(repoRoot, rel), path.join(plugin, rel), { recursive: true });
  }
  // A pinned clone running the suite (its worktrees inherit the pins) must not seed them here.
  for (const rel of [".github/agents", ".github/prompts", "skills/agento/commands"]) {
    for (const file of fs.readdirSync(path.join(plugin, rel))) {
      const abs = path.join(plugin, rel, file);
      fs.writeFileSync(abs, setHandoffModels(setModel(fs.readFileSync(abs, "utf8"), null), null));
    }
  }
  fs.mkdirSync(path.join(plugin, "templates"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "templates", "model-profiles.json"), path.join(plugin, "templates", "model-profiles.json"));
  if (gitInit) {
    execFileSync("git", ["init", "-q", "-b", "main", plugin]);
    git(plugin, "config", "user.email", "test@example.com");
    git(plugin, "config", "user.name", "Test");
    git(plugin, "add", "-A");
    git(plugin, "commit", "-q", "-m", "init");
  }
  const home = path.join(base, "config");
  const env = { ...baseEnv, AGENTO_CONFIG_HOME: home };
  const models = (...args) => runWith({ cwd: plugin, env }, "models", ...args, "--plugin-root", plugin);
  const modelsInput = (input, ...args) => runWith({ cwd: plugin, env, input }, "models", ...args, "--plugin-root", plugin);
  const writeProfiles = (profiles) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "model-profiles.json"), JSON.stringify({ profiles }));
  };
  return { plugin, home, env, models, modelsInput, writeProfiles };
}

// A primary plugin clone plus managed worktrees: `plan-1` on feature/x (role build)
// and `freehand-1` on changes/fh (role freehand), for role-resolved pins tests.

const commonDirOf = (plugin) => git(plugin, "rev-parse", "--path-format=absolute", "--git-common-dir");

function legacyPins(plugin, pins) {
  for (const [file, value] of Object.entries(pins)) {
    const abs = path.join(plugin, file);
    fs.writeFileSync(abs, setModel(fs.readFileSync(abs, "utf8"), value));
  }
  git(plugin, "update-index", "--skip-worktree", "--", ...Object.keys(pins));
}

function publishBranch(work, branch, write = null, { keepLocal = false, localAhead = false } = {}) {
  git(work, "switch", "-q", "-c", branch);
  write?.(work);
  git(work, "add", "-A");
  git(work, "commit", "-q", "--allow-empty", "-m", `plan ${branch}`);
  git(work, "push", "-q", "-u", "origin", branch);
  if (localAhead) git(work, "commit", "-q", "--allow-empty", "-m", `local ${branch}`);
  git(work, "switch", "-q", "main");
  if (!keepLocal && !localAhead) git(work, "branch", "-q", "-D", branch);
}

const roadmapFor = (type, slug, status = "in-progress", branch = `${type}/${slug}`) => (w) =>
  writeRoadmap(w, `${type === "feature" ? "features" : "issues"}/2026/10/${slug}`, `status: ${status}\nbranch: ${branch}\nnext-step: "1.2"`);

const worktreeCount = (clone) => git(clone, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

const cloneState = (...clones) => clones.map((c) => [git(c, "worktree", "list", "--porcelain"), git(c, "branch", "--list")]);

function landBranch(work, branch, { syncMain = true, remote = branch } = {}) {
  git(work, "push", "-q", "origin", `${branch}:main`);
  git(work, "push", "-q", "origin", "--delete", remote);
  git(work, "fetch", "-q", "--prune", "origin");
  if (syncMain) git(work, "merge", "-q", "--ff-only", "origin/main");
}

function shipStub({ product = {}, companion = {}, api = {}, runs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-ship-gh-"));
  const state = { product: { nameWithOwner: "acme/project", origin: null, defaultBranch: "main", prs: {}, ...product }, companion: { nameWithOwner: "acme/project-docs", origin: null, defaultBranch: "main", prs: {}, ...companion }, api, runs, nextNumber: 100, dispatched: [] };
  for (const repo of ["product", "companion"]) {
    for (const [branch, pr] of Object.entries(state[repo].prs)) {
      state[repo].prs[branch] = { number: 15, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: branch, body: "", baseRefName: "main", mergeCommit: null, rollups: [[]], rollupCalls: 0, ...pr, url: pr.url ?? `https://example.test/${repo}/pull/${pr.number ?? 15}` };
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
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] === "auth") { console.log("Logged in"); process.exit(0); }
if (args[0] === "repo" && args[1] === "view") { console.log(args.includes("-q") || args.includes("--jq") ? repo.nameWithOwner : JSON.stringify({ nameWithOwner: repo.nameWithOwner })); process.exit(0); }
if (args[0] === "pr" && args[1] === "view") {
  const pr = findPr(args[2]);
  if (!pr) die("no pull requests found for branch \\"" + args[2] + "\\"");
  const fields = (opt("--json") || "").split(",").filter(Boolean);
  const jq = opt("--jq") ?? opt("-q");
  if (fields.includes("statusCheckRollup") && jq) {
    const snapshots = pr.rollups || [[]];
    const rollup = snapshots[Math.min(pr.rollupCalls || 0, snapshots.length - 1)];
    pr.rollupCalls = (pr.rollupCalls || 0) + 1; save();
    const bucket = (c) => c.status !== "COMPLETED" ? "pending" : (c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL") ? "pass" : c.conclusion === "SKIPPED" ? "skipped" : "fail";
    const rows = rollup.map((c) => ({ name: c.name, bucket: bucket(c) }));
    const count = (b) => rows.filter((r) => r.bucket === b).length;
    console.log([count("pass"), count("fail"), count("pending"), count("skipped"), pr.mergeStateStatus || "UNKNOWN"].join(" ") + " | " + rows.filter((r) => r.bucket !== "pass").map((r) => r.name + "=" + r.bucket).join(", "));
    process.exit(0);
  }
  const view = {};
  for (const f of fields) {
    if (f === "mergeCommit") view[f] = pr.mergeCommit ? { oid: pr.mergeCommit } : null;
    else if (f === "statusCheckRollup") {
      const snapshots = pr.rollups || [[]];
      view[f] = snapshots[Math.min(pr.rollupCalls || 0, snapshots.length - 1)].map((c) => ({ __typename: "CheckRun", name: c.name, status: c.status, conclusion: c.conclusion }));
    } else view[f] = pr[f] ?? null;
  }
  console.log(JSON.stringify(fields.length ? view : pr));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "ready") { const pr = findPr(args[2]); if (!pr) die("not found"); pr.isDraft = false; save(); console.log("Pull request #" + pr.number + " is marked as ready for review"); process.exit(0); }
if (args[0] === "pr" && args[1] === "merge") {
  const pr = findPr(args[2]);
  if (!pr) die("not found");
  if (pr.state !== "OPEN") die("Pull request #" + pr.number + " is not open");
  if (pr.isDraft) die("Pull request #" + pr.number + " is still a draft");
  if (args.includes("--admin") || args.includes("--squash") || args.includes("--rebase") || args.includes("--delete-branch")) die("forbidden merge flag: " + args.slice(3).join(" "));
  if (pr.refuseMerge) die(typeof pr.refuseMerge === "string" ? pr.refuseMerge : "Pull request #" + pr.number + " is not mergeable: the merge commit cannot be cleanly created.");
  const branch = Object.keys(repo.prs).find((b) => repo.prs[b] === pr);
  const origin = repo.origin || git("-C", process.cwd(), "remote", "get-url", "origin");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-merge-"));
  git("clone", "-q", origin, tmp);
  git("-C", tmp, "config", "user.email", "bot@example.com"); git("-C", tmp, "config", "user.name", "gh-stub");
  git("-C", tmp, "switch", "-q", repo.defaultBranch);
  git("-C", tmp, "merge", "-q", "--no-ff", "-m", "Merge pull request #" + pr.number + " from " + branch, "origin/" + branch);
  git("-C", tmp, "push", "-q", "origin", repo.defaultBranch);
  pr.state = "MERGED"; pr.mergeCommit = git("-C", tmp, "rev-parse", "HEAD"); pr.mergeStateStatus = "UNKNOWN"; save();
  console.log("Merged pull request #" + pr.number); process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const head = opt("--head") || git("-C", process.cwd(), "branch", "--show-current");
  if (repo.prs[head] && repo.prs[head].state === "OPEN") die("a pull request for branch \\"" + head + "\\" already exists: " + repo.prs[head].url);
  const number = state.nextNumber++;
  repo.prs[head] = { number, state: "OPEN", isDraft: args.includes("--draft"), mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", title: opt("--title") || head, body: opt("--body") || "", baseRefName: opt("--base") || repo.defaultBranch, mergeCommit: null, rollups: [[]], rollupCalls: 0, url: "https://example.test/pull/" + number };
  save(); console.log(repo.prs[head].url); process.exit(0);
}
if (args[0] === "api" && args[1] === "user") { console.log(JSON.stringify({ login: "agento-bot" })); process.exit(0); }
if (args[0] === "api" && (args[1] || "").split("?")[0].split("/")[3] === "issues") {
  const parts = args[1].split("?")[0].split("/");
  const method = opt("-X") || "GET";
  const text = (args.find((a) => a.startsWith("body=")) || "").slice(5);
  repo.comments = repo.comments || [];
  if (parts[4] === "comments" && method === "PATCH") { const c = repo.comments.find((x) => String(x.id) === parts[5]); if (!c) die("Not Found (HTTP 404)"); c.body = text; save(); console.log(JSON.stringify(c)); process.exit(0); }
  if (parts[5] === "comments" && method === "POST") { const id = 7000 + repo.comments.length; const c = { id, issue: Number(parts[4]), user: { login: "agento-bot" }, body: text, html_url: "https://example.test/comment/" + id }; repo.comments.push(c); save(); console.log(JSON.stringify(c)); process.exit(0); }
  if (parts[5] === "comments") { console.log(JSON.stringify(repo.comments.filter((c) => c.issue === Number(parts[4])))); process.exit(0); }
}
if (args[0] === "api") {
  const target = args.filter((a) => !a.startsWith("-") && a !== "api" && !/^(Accept|body)=/.test(a) && !a.startsWith("Accept:"))[0];
  if (args.includes("-X") && opt("-X") === "PATCH") {
    const m = target.match(/pulls\\/(\\d+)$/);
    const pr = m && findPr(m[1]);
    if (!pr) die("Not Found (HTTP 404)");
    const field = args.find((a) => a.startsWith("body="));
    if (field) pr.body = field.slice(5);
    save(); console.log(JSON.stringify({ number: pr.number, body: pr.body })); process.exit(0);
  }
  // Native rules / classic-protection endpoints: serve repo.rules / repo.protection
  // when set, else fall through to the generic api map (which 404s when absent).
  const rulesMatch = target.match(/^repos\\/[^/]+\\/[^/]+\\/rules\\/branches\\/[^/]+$/);
  if (rulesMatch && repo.rules !== undefined && repo.rules !== null) { console.log(JSON.stringify(repo.rules)); process.exit(0); }
  const protectionMatch = target.match(/^repos\\/[^/]+\\/[^/]+\\/branches\\/[^/]+\\/protection\\/required_status_checks$/);
  if (protectionMatch && repo.protection !== undefined && repo.protection !== null) { console.log(JSON.stringify(repo.protection)); process.exit(0); }
  const key = Object.keys(state.api).filter((k) => target.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) die("gh: Not Found (HTTP 404)");
  let reply = state.api[key];
  if (Array.isArray(reply)) {
    state.apiCounts = state.apiCounts || {};
    const n = state.apiCounts[key] || 0; state.apiCounts[key] = n + 1; save();
    reply = reply[Math.min(n, reply.length - 1)];
  }
  if (reply && reply.__stderr) die(reply.__stderr, reply.__exit || 1);
  process.stdout.write(JSON.stringify(reply)); process.exit(0);
}
if (args[0] === "run" && args[1] === "list") { console.log(JSON.stringify(state.runs.map((r) => ({ databaseId: r.id, createdAt: r.createdAt, url: r.url, status: r.status, conclusion: r.conclusion })))); process.exit(0); }
if (args[0] === "run" && args[1] === "view") {
  const run = state.runs.find((r) => String(r.id) === String(args[2]));
  if (!run) die("could not resolve run " + args[2]);
  const jq = opt("--jq");
  console.log(jq ? run.status + " " + (run.conclusion || "-") + " " + run.url : JSON.stringify(run)); process.exit(0);
}
if (args[0] === "workflow" && args[1] === "run") {
  const id = 900 + state.dispatched.length;
  state.dispatched.push({ workflow: args[2], ref: opt("--ref") });
  state.runs.push({ id, createdAt: new Date().toISOString(), url: "https://example.test/runs/" + id, status: "in_progress", conclusion: null });
  save(); console.log("Created workflow_dispatch event"); process.exit(0);
}
die("gh stub: unsupported " + args.join(" "));
`;
  const { env, bin } = restrictedPath({ gh: script });
  // wait-for-checks.sh needs a shell and its few coreutils beside node, git, and gh.
  for (const tool of ["bash", "grep", "sed", "sleep"]) fs.symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean) : []);
  const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const update = (fn) => {
    const current = read();
    fn(current);
    fs.writeFileSync(stateFile, JSON.stringify(current));
  };
  return { env, bin, dir, calls, state: read, update, reset: () => fs.rmSync(path.join(dir, "calls.log"), { force: true }) };
}

const shipRun = (cwd, env, ...args) => runWith({ cwd, env }, "ship", ...args);

const refState = (...clones) => clones.map((c) => [git(c, "for-each-ref", "--exclude=refs/remotes/origin/HEAD"), git(c, "worktree", "list", "--porcelain")]);

function inRepoDelivery({ repo, wt }, slug, { type = "feature", status = "in-review", owner = true, write = null } = {}) {
  const branch = `${type}/${slug}`;
  publishBranch(repo, branch, (w) => {
    roadmapFor(type, slug, status)(w);
    write?.(w);
  }, { keepLocal: owner });
  if (owner) git(repo, "worktree", "add", "-q", path.join(wt, `${type}-${slug}`), branch);
  return { branch, owner: owner ? path.join(wt, `${type}-${slug}`) : null, dir: `${type === "feature" ? "features" : "issues"}/2026/10/${slug}` };
}

function pairDelivery(pair, slug, { status = "in-review", owner = true, write = null, writeCompanion = null } = {}) {
  const { repo, docs, wt, docsWt } = pair;
  const branch = `feature/${slug}`;
  publishBranch(repo, branch, write, { keepLocal: owner });
  publishBranch(docs, branch, (w) => {
    roadmapFor("feature", slug, status)(w);
    writeCompanion?.(w);
  }, { keepLocal: owner });
  if (owner) {
    git(repo, "worktree", "add", "-q", path.join(wt, `feature-${slug}`), branch);
    git(docs, "worktree", "add", "-q", path.join(docsWt, `feature-${slug}`), branch);
    fs.writeFileSync(path.join(wt, `feature-${slug}.code-workspace`), "{}\n");
  }
  return { branch, owner: owner ? path.join(wt, `feature-${slug}`) : null, half: owner ? path.join(docsWt, `feature-${slug}`) : null, dir: `features/2026/10/${slug}` };
}

const DONE_STEPS = "- [x] 1.1 done — verify: x\n- [x] 1.2 also done — verify: y\n";

const shipReady = (type, slug, { steps = DONE_STEPS, verdict = "approve", header = null, plan = "# Plan\n\n## Risks\n\nnone\n" } = {}) => (w) => {
  const dir = `${type === "feature" ? "features" : "issues"}/2026/10/${slug}`;
  writeRoadmap(w, dir, header ?? `status: in-review\nbranch: ${type}/${slug}\nlast-updated: 2026-10-01\nnext-step: "review"`, steps);
  if (verdict) fs.writeFileSync(path.join(w, dir, "review.md"), `# Review\n\nVerdict: ${verdict}\n`);
  if (plan) fs.writeFileSync(path.join(w, dir, "plan.md"), plan);
};

const writeFile = (rel, text) => (w) => {
  fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true });
  fs.writeFileSync(path.join(w, rel), text);
};

const both = (...writers) => (w) => writers.forEach((f) => f?.(w));

const codes = (gaps) => gaps.map((g) => g.code);

function shippable(fixture, slug, { type = "feature", owner = true, extra = null, roadmap = {} } = {}) {
  const branch = `${type}/${slug}`;
  publishBranch(fixture.repo, branch, both(shipReady(type, slug, roadmap), extra), { keepLocal: owner });
  if (owner) git(fixture.repo, "worktree", "add", "-q", path.join(fixture.wt, `${type}-${slug}`), branch);
  return { branch, owner: owner ? path.join(fixture.wt, `${type}-${slug}`) : null, dir: `${type === "feature" ? "features" : "issues"}/2026/10/${slug}` };
}

const PASSING = [[{ name: "Unit tests", status: "COMPLETED", conclusion: "SUCCESS" }]];

const stepsOf = (json) => json.actions.map((a) => a.step);

function gitLoggingPath(extra = {}) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agento-bin-"));
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const log = path.join(bin, "git.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  for (const [name, script] of Object.entries(extra)) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  return { log, env: { ...baseEnv, PATH: bin } };
}

function worktreeListCalls(log) {
  const counts = {};
  for (const line of fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n") : []) {
    const match = line.match(/^-C (.+) worktree list --porcelain$/);
    if (!match) continue;
    const dir = fs.realpathSync(match[1]);
    counts[dir] = (counts[dir] ?? 0) + 1;
  }
  fs.rmSync(log, { force: true });
  return counts;
}

function makeDashboardRepo({ companion }) {
  const pair = companion ? makePairRepo() : { ...makeWorktreeRepo(), docs: null };
  const artifacts = pair.docs ?? pair.repo;
  writeBreakdown(artifacts, "initiatives/2026/10/demo", null, [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma", requires: ["alpha"] }, { slug: "delta" }]);
  writeRoadmap(artifacts, "features/2026/10/alpha", 'status: in-progress\nbranch: feature/alpha\ninitiative: "demo"\nnext-step: "1.2"');
  writeRoadmap(artifacts, "features/2026/10/beta", 'status: planned\nbranch: feature/beta\ninitiative: "demo"\nnext-step: "1.1"');
  writeRoadmap(artifacts, "features/2026/10/omega", 'status: complete\nbranch: feature/omega\nnext-step: ""', "- [x] 1.1 done — verify: x\n");
  writeRoadmap(artifacts, "issues/2026/10/bug", 'status: in-review\nbranch: issue/bug\nnext-step: "review"');
  git(artifacts, "add", "-A");
  git(artifacts, "commit", "-q", "-m", "artifacts");
  const build = path.join(pair.wt, "feature-alpha");
  git(pair.repo, "worktree", "add", "-q", "-b", "feature/alpha", build);
  if (companion) git(pair.docs, "worktree", "add", "-q", "-b", "feature/alpha", path.join(pair.docsWt, "feature-alpha"));
  return { repo: pair.repo, docs: pair.docs, build, artifacts };
}

function stableMetrics(doc) {
  if (doc.status !== "ok") return doc;
  const fix = (interval) => (interval?.open ? { ...interval, seconds: null } : interval);
  return {
    ...doc,
    generatedAt: null,
    items: doc.items.map((item) => ({
      ...item,
      phases: Object.fromEntries(Object.entries(item.phases).map(([name, interval]) => [name, fix(interval)])),
      cycle: fix(item.cycle),
      pauses: fix(item.pauses),
    })),
  };
}

function assertDashboardMatches(cwd, env, { pr }) {
  const flag = pr ? ["--pr"] : [];
  const sub = (...args) => runWith({ cwd, env }, ...args).json;
  const dash = runWith({ cwd, env }, "dashboard", ...flag);
  assert.equal(dash.code, 0);
  assert.deepEqual(Object.keys(dash.json), ["status", "session", "doctor", "deliveries", "initiatives", "metrics", "timings", "root", "configSource"]);
  assert.equal(dash.json.status, "ok");
  for (const key of ["session", "doctor", "deliveries", "initiatives", "metrics", "total"]) assert.equal(typeof dash.json.timings[key], "number", key);
  assert.deepEqual(dash.json.session, sub("session", ...flag));
  assert.deepEqual(dash.json.doctor, sub("doctor"));
  assert.deepEqual(dash.json.deliveries, sub("status", ...flag));
  assert.deepEqual(stableMetrics(dash.json.metrics), stableMetrics(sub("metrics")));
  assert.deepEqual(dash.json.metrics.items.map((i) => i.roadmap), dash.json.deliveries.items.map((i) => i.roadmap));
  const list = sub("initiative");
  assert.deepEqual(dash.json.initiatives.list, list);
  assert.deepEqual(Object.keys(dash.json.initiatives.details), list.items.map((i) => i.slug));
  for (const item of list.items) assert.deepEqual(dash.json.initiatives.details[item.slug], sub("initiative", item.slug));
  return dash.json;
}

function commitAt(dir, message, iso) {
  git(dir, "add", "-A");
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
}

const T1 = "2026-09-10T10:00:00Z";

const MERGE = "1".repeat(40);

const PARENT = "0".repeat(40);

const LATER = "2".repeat(40);

const RUNS = "repos/{owner}/{repo}/actions/workflows/release.yml/runs";

const releaseRun = (id, fields = {}) => ({ id, event: "push", status: "completed", conclusion: "success", head_sha: MERGE, head_branch: "main", created_at: "2026-10-07T10:00:05Z", html_url: `https://github.test/runs/${id}`, ...fields });

const mergeCommitAt = (date) => ({ sha: MERGE, commit: { committer: { date } }, parents: [{ sha: PARENT }] });

const workflowFile = (text) => ({ content: Buffer.from(text).toString("base64"), encoding: "base64" });

function releaseGh(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-gh-"));
  fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(routes));
  const script = `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + "/calls.log", args.join(" ") + "\\n");
if (args[0] === "--version") { console.log("gh version 9.9.9"); process.exit(0); }
if (args[0] !== "api") process.exit(1);
const target = args[args.length - 1];
const routes = JSON.parse(fs.readFileSync(dir + "/routes.json", "utf8"));
const key = Object.keys(routes).filter((k) => target.startsWith(k)).sort((a, b) => b.length - a.length)[0];
if (!key) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
let reply = routes[key];
if (Array.isArray(reply)) {
  const counter = dir + "/count-" + Buffer.from(key).toString("hex").slice(0, 60);
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  reply = reply[Math.min(n, reply.length - 1)];
}
if (reply && reply.__stderr) { process.stderr.write(reply.__stderr + "\\n"); process.exit(reply.__exit || 1); }
process.stdout.write(JSON.stringify(reply));
`;
  const { env } = restrictedPath({ gh: script });
  const calls = () => (fs.existsSync(path.join(dir, "calls.log")) ? fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n") : []);
  return { env, calls, apiCalls: () => calls().filter((c) => c.startsWith("api ")) };
}

const releaseRoutes = (extra = {}) => ({
  [`repos/{owner}/{repo}/commits/`]: mergeCommitAt("2020-01-01T00:00:00Z"),
  [`${RUNS}?head_sha=`]: { total_count: 0, workflow_runs: [] },
  [`${RUNS}?branch=`]: { total_count: 0, workflow_runs: [] },
  [`repos/{owner}/{repo}/contents/.github/workflows/release.yml`]: workflowFile("on:\n  push:\n    branches: [main]\n    paths-ignore: ['docs/**']\n  workflow_dispatch:\n"),
  [`repos/{owner}/{repo}/compare/${PARENT}...`]: { status: "ahead", files: [{ filename: "src/app.js" }] },
  ...extra,
});

export {
  DONE_STEPS,
  LATER,
  MERGE,
  PARENT,
  PASSING,
  RUNS,
  T1,
  assertDashboardMatches,
  baseEnv,
  both,
  byId,
  cli,
  cloneState,
  cloneWithOrigin,
  codes,
  commitAt,
  commonDirOf,
  companionOf,
  git,
  gitLoggingPath,
  harnessFixture,
  inRepoDelivery,
  landBranch,
  legacyPins,
  makeDashboardRepo,
  makeFlipRepo,
  makePairRepo,
  makeRepo,
  makeWorktreeRepo,
  mergeCommitAt,
  modelsFixture,
  okStubs,
  pairDelivery,
  prStub,
  publishBranch,
  refState,
  releaseGh,
  releaseRoutes,
  releaseRun,
  repoRoot,
  restrictedPath,
  roadmapFor,
  run,
  runWith,
  shipReady,
  shipRun,
  shipStub,
  shippable,
  stableMetrics,
  stepsOf,
  strip,
  workflowFile,
  worktreeCount,
  worktreeListCalls,
  writeBreakdown,
  writeFile,
  writeRoadmap,
};
