#!/usr/bin/env node
// Agento CLI: the deterministic half of the delivery workflow. Prompts call this
// instead of re-deriving slug resolution, status listings, and config lookups in
// prose. Always prints one JSON document; exit 0 when the result is usable, 1 on a
// usage error, 3 when the resolution itself failed (conflict, mismatch, missing).
//
//   node scripts/agento.mjs config
//   node scripts/agento.mjs resolve <feature|issue> <slug>
//   node scripts/agento.mjs find <slug>                 (type-agnostic)
//   node scripts/agento.mjs status [feature|issue] [slug]
//   node scripts/agento.mjs close-decision <feature|issue> <slug>
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug>
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>
//   node scripts/agento.mjs initiative [<slug>]
//   node scripts/agento.mjs session [--pr]             (role, worktree, worktrees, delivery, lifecycle, allowed; hosted flag)
//   node scripts/agento.mjs next [<slug>]              (the one legal transition: command, args, window, dispatch paths)
//   node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)
//
// Options: --root <dir> (default: the git toplevel of the cwd).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentoConfig, resolveArtifactsRoot } from "./agento-config.mjs";
import {
  closeBuildSessionDecision,
  evaluateShipPreflight,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";
import { classifyWorktrees, deriveAllowed, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, parseWorktreeList } from "./session-state.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 20);
  emit({ status: "usage-error", message, usage: lines.map((l) => l.replace(/^\/\/ ?/, "")) }, 1);
}

function emit(result, code = 0) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(code);
}

function git(root, ...args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg === "--pr") options.pr = true;
    else if (arg === "--for") {
      options.for = argv[++i];
      if (!options.for || !/^[a-z0-9-]+$/.test(options.for)) usage(`--for takes a command name matching [a-z0-9-]+, got ${JSON.stringify(options.for ?? "")}`);
    } else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const startDir = path.resolve(options.root ?? process.cwd());
const root = git(startDir, "rev-parse", "--show-toplevel") || startDir;
const { config, source } = loadAgentoConfig(root);
const repoName = path.basename(root);
const worktreesDir = path.resolve(root, config.worktrees.dir);
const currentBranch = git(root, "branch", "--show-current");
const gitAdapter = {
  lsTree: (ref) => git(root, "ls-tree", "-r", "--name-only", ref),
  show: (spec) => git(root, "show", spec),
};

// Artifact roots may live in a sibling companion checkout (artifacts.repo). Like
// worktrees.dir, the path is relative to the primary checkout and read from the
// primary's config when this root is a secondary worktree. Unset → the checkout
// itself, with no extra git call.
function resolveArtifacts() {
  const repo = config.artifacts.repo ?? {};
  if (repo.name == null && repo.dir == null) return resolveArtifactsRoot({ config, rootDir: root });
  const primaryRoot = parseWorktreeList(git(root, "worktree", "list", "--porcelain"))[0]?.path ?? root;
  const primaryConfig = primaryRoot === root ? config : loadAgentoConfig(primaryRoot).config;
  return resolveArtifactsRoot({ config: primaryConfig, rootDir: root, primaryRoot });
}
const artifacts = resolveArtifacts();
const artifactsRoot = artifacts.root;
const artifactsGit = artifacts.external
  ? {
      lsTree: (ref) => git(artifactsRoot, "ls-tree", "-r", "--name-only", ref),
      show: (spec) => git(artifactsRoot, "show", spec),
    }
  : gitAdapter;
const agit = (...args) => git(artifactsRoot, ...args);

function requireType(type) {
  if (type !== "feature" && type !== "issue") usage(`type must be feature or issue, got ${JSON.stringify(type ?? "")}`);
  return type;
}

function requireSlug(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) usage(`slug must match [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(slug ?? "")}`);
  return slug;
}

function header(content, key) {
  // Quoted values may contain `#` (github-issue: "#12"); bare values stop at a comment.
  const match = content.match(new RegExp(`(?:^|\\n)${key}:[ \\t]*("[^"\\n]*"|'[^'\\n]*'|[^\\n#]*)`));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function* walkFiles(base, name) {
  if (!fs.existsSync(base)) return;
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && entry.name === name) yield child;
    }
  }
}

const walkRoadmaps = (base) => walkFiles(base, "roadmap.md");
const walkBreakdowns = (base) => walkFiles(base, "breakdown.md");

// One roadmap record from its content plus the sibling artifacts; `dir` and
// `roadmap` are repository-relative. Shared by the checkout and git-ref readers.
function describeContent({ type, dir, roadmap, content, planExists, reviewContent }) {
  const steps = [...content.matchAll(/^- \[( |x)\] \d+\.\d+/gm)];
  return {
    type,
    slug: path.posix.basename(dir),
    dir,
    roadmap,
    plan: planExists ? `${dir}/plan.md` : null,
    review: reviewContent !== null ? `${dir}/review.md` : null,
    reviewVerdict: reviewContent !== null ? (reviewContent.match(/^Verdict:\s*(approve|request-changes)/m)?.[1] ?? null) : null,
    status: header(content, "status"),
    branch: header(content, "branch"),
    lastUpdated: header(content, "last-updated"),
    nextStep: header(content, "next-step"),
    githubIssue: header(content, "github-issue") || null,
    initiative: header(content, "initiative") || null,
    steps: { ticked: steps.filter((m) => m[1] === "x").length, total: steps.length },
    postShipPending: (content.match(/^- \[ \] \d+\.\d+ \(manual, post-ship\)/gm) ?? []).length,
  };
}

function describe(file, type) {
  const dir = path.dirname(file);
  const rel = (p) => path.relative(artifactsRoot, p).split(path.sep).join("/");
  const review = path.join(dir, "review.md");
  return describeContent({
    type,
    dir: rel(dir),
    roadmap: rel(file),
    content: fs.readFileSync(file, "utf8"),
    planExists: fs.existsSync(path.join(dir, "plan.md")),
    reviewContent: fs.existsSync(review) ? fs.readFileSync(review, "utf8") : null,
  });
}

// The same record read from a git ref (`origin/<branch>` or a local branch), for
// roadmaps that exist only on a delivery branch. `roadmap` is repository-relative.
function describeFromRef(ref, roadmap, type) {
  const content = agit("show", `${ref}:${roadmap}`);
  if (!content) return null;
  const dir = path.posix.dirname(roadmap);
  const tree = new Set(agit("ls-tree", "--name-only", ref, `${dir}/`).split("\n").filter(Boolean));
  return describeContent({
    type,
    dir,
    roadmap,
    content,
    planExists: tree.has(`${dir}/plan.md`),
    reviewContent: tree.has(`${dir}/review.md`) ? agit("show", `${ref}:${dir}/review.md`) : null,
  });
}

function allRoadmaps(typeFilter) {
  const out = [];
  for (const type of ["feature", "issue"]) {
    if (typeFilter && type !== typeFilter) continue;
    const base = path.join(artifactsRoot, type === "feature" ? config.artifacts.features : config.artifacts.issues);
    for (const file of walkRoadmaps(base)) out.push(describe(file, type));
  }
  return out;
}

function withExit(result) {
  emit({ ...result, root, configSource: source }, result.status === "ok" ? 0 : 3);
}

// Only `session --pr` reaches this; every failure is a warning, never an exit code.
function lookupPullRequest(branch) {
  if (!branch) return { pr: null, warnings: ["pr: no branch to look up (detached HEAD)"] };
  const opts = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 };
  try {
    execFileSync("gh", ["--version"], opts);
  } catch {
    return { pr: null, warnings: ["pr: gh CLI not found on PATH; install GitHub CLI to include pull request state"] };
  }
  try {
    const out = execFileSync("gh", ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,url"], opts);
    return { pr: JSON.parse(out), warnings: [] };
  } catch (error) {
    const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0] || error?.message || "unknown error";
    return { pr: null, warnings: [`pr: gh pr view ${branch} failed: ${stderr}`] };
  }
}

// worktrees.dir is relative to the primary checkout; resolving it against a
// secondary worktree's own basename would name the wrong sibling directory.
function primaryWorktreesDir(worktrees) {
  const primaryRoot = worktrees[0]?.path ?? root;
  const primaryConfig = primaryRoot === root ? config : loadAgentoConfig(primaryRoot).config;
  return path.resolve(primaryRoot, primaryConfig.worktrees.dir);
}

// --- doctor ----------------------------------------------------------------

// Every probe is bounded and never throws: a missing binary, a nonzero exit, and a
// timeout all become a result the caller maps to ok | warn | fail.
function probe(cmd, args) {
  const opts = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  try {
    return { ok: true, out: execFileSync(cmd, args, opts).trim().split("\n")[0] ?? "" };
  } catch (error) {
    const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0];
    const stdout = (error?.stdout ?? "").toString().trim().split("\n")[0];
    const timedOut = error?.code === "ETIMEDOUT" || (error?.signal && !error?.status);
    return {
      ok: false,
      missing: error?.code === "ENOENT",
      timedOut,
      detail: timedOut ? `${cmd} timed out after 10 s` : stderr || stdout || error?.message || "unknown error",
    };
  }
}

const DOCTOR_CHECKS = {
  node() {
    const version = process.versions.node;
    const major = Number.parseInt(version.split(".")[0], 10);
    return major >= 20
      ? { status: "ok", detail: `node v${version}`, fallback: null }
      : { status: "fail", detail: `node v${version} is below the required 20`, fallback: "install Node >= 20 (AGENTS.md); the Agento CLI and its tests need it" };
  },
  "git-remote"() {
    const url = git(root, "remote", "get-url", "origin");
    if (!url) return { status: "fail", detail: "no `origin` remote", fallback: "add the remote (`git remote add origin <url>`) or work in a clone; push and PR steps need origin" };
    const reach = probe("git", ["-C", root, "ls-remote", "--exit-code", "--heads", "origin", config.branches.default]);
    return reach.ok
      ? { status: "ok", detail: `origin ${url}, ${config.branches.default} reachable`, fallback: null }
      : { status: "warn", detail: `origin ${url} unreachable: ${reach.detail}`, fallback: "work offline; fetch, push, and PR steps will fail until the network is back — retry them before ending the turn" };
  },
  gh() {
    const version = probe("gh", ["--version"]);
    if (!version.ok) return { status: "fail", detail: version.missing ? "gh CLI not found on PATH" : `gh --version failed: ${version.detail}`, fallback: "install GitHub CLI (https://cli.github.com) — the user installs it; the agent does not" };
    const auth = probe("gh", ["auth", "status"]);
    return auth.ok
      ? { status: "ok", detail: `${version.out}; authenticated`, fallback: null }
      : { status: "fail", detail: `gh auth status failed: ${auth.detail}`, fallback: "stop; the user runs `gh auth login` in their own terminal, then re-sends the command (policy §1: never run it on their behalf)" };
  },
  code() {
    const version = probe("code", ["--version"]);
    return version.ok
      ? { status: "ok", detail: `code ${version.out}`, fallback: null }
      : { status: "warn", detail: version.missing ? "code CLI not found on PATH" : `code --version failed: ${version.detail}`, fallback: "keep the worktree and print `code --new-window <worktree-path>` for the user to run" };
  },
  python3() {
    const version = probe("python3", ["--version"]);
    return version.ok
      ? { status: "ok", detail: version.out, fallback: null }
      : { status: "warn", detail: version.missing ? "python3 not found on PATH" : `python3 --version failed: ${version.detail}`, fallback: "hooks do not run: the delivery guard and SessionStart context are unavailable — proceed with care and apply the policy by hand" };
  },
  "worktrees-dir"() {
    const dir = primaryWorktreesDir(parseWorktreeList(git(root, "worktree", "list", "--porcelain")));
    let existing = dir;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    try {
      fs.accessSync(existing, fs.constants.W_OK);
      return { status: "ok", detail: existing === dir ? `${dir} writable` : `${dir} absent; ${existing} writable, it will be created`, fallback: null };
    } catch {
      return { status: "fail", detail: `${dir} not writable (${existing} denies write)`, fallback: "create the directory with write permission or change worktrees.dir in .github/agento.json" };
    }
  },
};

const STATUS_RANK = { ok: 0, warn: 1, fail: 2 };

// Capability vocabulary (delivery-policy §10) in canonical order, each mapped to the
// doctor checks that prove it. Chat-tool capabilities have no CLI-side check.
const CAPABILITY_CHECKS = {
  terminal: ["node", "python3", "worktrees-dir"],
  "ask-questions": [],
  browser: [],
  gh: ["gh"],
  code: ["code"],
  network: ["git-remote"],
  python3: ["python3"],
};

// What each slash command declares on its `Needs:` line; the customizations test
// keeps this table and the prompt bodies in agreement.
const COMMAND_NEEDS = {
  "agento-init": ["terminal", "ask-questions", "gh", "network"],
  ap: ["terminal", "browser", "gh", "network"],
  "build-feature": ["terminal", "browser", "gh", "network"],
  "build-issue": ["terminal", "browser", "gh", "network"],
  "close-session": ["terminal"],
  "commit-current-changes": ["terminal", "gh", "network"],
  continue: ["terminal", "ask-questions", "browser", "gh", "code", "network"],
  "delivery-status": ["terminal"],
  doctor: ["terminal"],
  "extend-copilot": ["terminal"],
  "finish-freehand": ["terminal", "gh", "network"],
  "fix-copilot": ["terminal"],
  "install-skills": ["terminal", "ask-questions", "network"],
  "new-feature": ["terminal", "ask-questions", "gh", "network"],
  "new-initiative": ["terminal", "ask-questions", "gh", "network"],
  "new-issue": ["terminal", "ask-questions", "gh", "network"],
  "next-feature": ["terminal"],
  "quick-fix": ["terminal", "gh", "network"],
  "review-feature": ["terminal", "browser", "gh", "network"],
  "review-issue": ["terminal", "browser", "gh", "network"],
  ship: ["terminal", "gh", "network"],
  "start-freehand": ["terminal", "code"],
  "start-session": ["terminal", "code"],
  "triage-followups": ["terminal", "gh", "network"],
};

function checksFor(needs) {
  const ids = new Set(needs.flatMap((n) => CAPABILITY_CHECKS[n]));
  return Object.keys(DOCTOR_CHECKS).filter((id) => ids.has(id));
}

function runDoctor(ids) {
  const checks = ids.map((id) => {
    try {
      return { id, ...DOCTOR_CHECKS[id]() };
    } catch (error) {
      return { id, status: "fail", detail: `check threw: ${error?.message ?? error}`, fallback: "report this as an Agento bug; run the probe by hand" };
    }
  });
  const status = checks.reduce((worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst), "ok");
  return { status, checks };
}

// --- initiatives -----------------------------------------------------------

function slugList(value) {
  const cleaned = value.replace(/`/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) return [];
  return cleaned.split(/[\s,]+/).filter(Boolean);
}

function parseBreakdown(file) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const rel = (p) => path.relative(artifactsRoot, p).split(path.sep).join("/");
  const features = [];
  let inFeatures = false;
  let current = null;
  for (const line of content.split("\n")) {
    if (/^## /.test(line)) {
      inFeatures = /^## Features\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inFeatures) continue;
    const heading = line.match(/^### +(.+?)\s*$/);
    if (heading) {
      current = { slug: heading[1].replace(/`/g, ""), requires: [], recommendedAfter: [], wave: null, order: features.length };
      features.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^- (Requires|Recommended after|Wave):\s*(.*)$/i);
    if (!bullet) continue;
    const key = bullet[1].toLowerCase();
    const value = bullet[2];
    if (key === "wave") {
      const n = Number.parseInt(value.replace(/`/g, ""), 10);
      current.wave = Number.isNaN(n) ? null : n;
    } else if (key === "requires") current.requires = slugList(value);
    else current.recommendedAfter = slugList(value);
  }
  return {
    slug: path.basename(dir),
    dir: rel(dir),
    breakdown: rel(file),
    created: header(content, "created") || null,
    lastUpdated: header(content, "last-updated") || null,
    features,
  };
}

function mergedAnomalies(features) {
  // Informational only (plan Decision 3): reflects the last fetch, never changes state or exit code.
  const merged = new Set(
    git(root, "branch", "-r", "--merged", `origin/${config.branches.default}`)
      .split("\n")
      .map((l) => l.trim().split(" ")[0])
      .filter(Boolean),
  );
  return features
    .filter((f) => f.roadmap && f.state !== "complete" && merged.has(`origin/${f.branch}`))
    .map((f) => ({ slug: f.slug, kind: "merged-but-not-complete", branch: f.branch }));
}

function allBreakdowns() {
  const base = path.join(artifactsRoot, config.artifacts.initiatives);
  return [...walkBreakdowns(base)].sort().map(parseBreakdown);
}

function deriveInitiative(breakdown, roadmaps) {
  const errors = [];
  const known = new Map();
  for (const f of breakdown.features) {
    if (known.has(f.slug)) errors.push(`duplicate feature block "### ${f.slug}"`);
    else known.set(f.slug, f);
  }
  for (const f of breakdown.features) {
    for (const d of f.requires) if (!known.has(d)) errors.push(`${f.slug}: Requires unknown feature "${d}"`);
    for (const d of f.recommendedAfter) if (!known.has(d)) errors.push(`${f.slug}: Recommended after unknown feature "${d}"`);
  }
  const roadmapBySlug = new Map();
  for (const r of roadmaps) if (!roadmapBySlug.has(r.slug)) roadmapBySlug.set(r.slug, r);
  for (const f of known.values()) {
    const r = roadmapBySlug.get(f.slug);
    if (!r) continue;
    if (!r.initiative) errors.push(`${f.slug}: roadmap ${r.roadmap} has no initiative: header (expected "${breakdown.slug}")`);
    else if (r.initiative !== breakdown.slug) errors.push(`${f.slug}: roadmap ${r.roadmap} names initiative "${r.initiative}", expected "${breakdown.slug}"`);
  }

  // Kahn's algorithm over Requires: computed wave = 1 + max(wave of requirements).
  const level = new Map();
  const indegree = new Map(breakdown.features.map((f) => [f.slug, f.requires.filter((d) => known.has(d)).length]));
  const dependents = new Map(breakdown.features.map((f) => [f.slug, []]));
  for (const f of breakdown.features) for (const d of f.requires) if (known.has(d)) dependents.get(d).push(f.slug);
  const queue = breakdown.features.filter((f) => indegree.get(f.slug) === 0).map((f) => f.slug);
  for (const slug of queue) level.set(slug, 1);
  while (queue.length) {
    const slug = queue.shift();
    for (const next of dependents.get(slug)) {
      level.set(next, Math.max(level.get(next) ?? 1, level.get(slug) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const cyclic = [...indegree.entries()].filter(([, n]) => n > 0).map(([slug]) => slug);
  if (cyclic.length) errors.push(`dependency cycle among: ${cyclic.join(", ")}`);

  const features = breakdown.features.map((f) => {
    const roadmap = roadmapBySlug.get(f.slug) ?? null;
    const state = roadmap ? roadmap.status : "unplanned";
    // Only `status: complete` satisfies Requires (plan Decision 3).
    const blockedBy = f.requires.filter((d) => roadmapBySlug.get(d)?.status !== "complete");
    return {
      slug: f.slug,
      state,
      roadmap: roadmap ? roadmap.roadmap : null,
      branch: roadmap ? roadmap.branch : `${config.branches.feature}${f.slug}`,
      requires: f.requires,
      recommendedAfter: f.recommendedAfter,
      wave: f.wave,
      computedWave: level.get(f.slug) ?? null,
      order: f.order,
      blockedBy,
      ready: state === "unplanned" && blockedBy.length === 0,
    };
  });

  const waves = [];
  for (const f of features) {
    if (f.computedWave === null) continue;
    (waves[f.computedWave - 1] ??= []).push(f.slug);
  }
  const rank = (f) => [f.wave ?? f.computedWave ?? Number.MAX_SAFE_INTEGER, f.computedWave ?? Number.MAX_SAFE_INTEGER, f.order];
  const next = features
    .filter((f) => f.ready)
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    })[0]?.slug ?? null;

  return {
    status: errors.length ? "invalid" : "ok",
    errors,
    features,
    waves: waves.map((w) => w ?? []),
    next,
    done: features.length > 0 && features.every((f) => f.state === "complete"),
  };
}

// --- next ------------------------------------------------------------------

// The ref a delivery branch is judged from: origin/<branch> when fetched, else the
// local branch (with a warning: no fetch happens here), else HEAD.
function refFor(branch) {
  if (branch && agit("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) return { ref: `origin/${branch}`, warning: null };
  if (branch && agit("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
    return { ref: branch, warning: `${branch}: origin/${branch} is absent, so review freshness and roadmap state reflect the local branch as of the last fetch` };
  }
  return { ref: "HEAD", warning: null };
}

// review.md is fresh when its last commit is not older than the last commit that
// touched anything else on the branch; null when the branch has no review.md.
function reviewFreshness(branch, dir) {
  const { ref, warning } = refFor(branch);
  const reviewTs = agit("log", "-1", "--format=%ct", ref, "--", `${dir}/review.md`);
  if (!reviewTs) return { reviewFresh: null, ref, warning };
  const otherTs = agit("log", "-1", "--format=%ct", ref, "--", ".", `:(exclude)${dir}/review.md`);
  return { reviewFresh: Number(reviewTs) >= Number(otherTs || 0), ref, warning };
}

// A roadmap that lives only on its delivery branch: origin/<branch> first (via the
// shared resolver), then the unpushed local branch. Never fetches.
function roadmapOnBranch(type, slug) {
  const resolved = resolveRoadmapArtifact({ rootDir: root, artifactsRoot, type, slug, currentBranch, git: artifactsGit, config });
  if (resolved.status === "ok" && resolved.source === "remote") {
    const record = describeFromRef(`origin/${resolved.branch}`, resolved.path, type);
    if (record) return { record, source: "origin" };
  }
  const branch = `${type === "feature" ? config.branches.feature : config.branches.issue}${slug}`;
  if (!agit("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) return null;
  const top = type === "feature" ? config.artifacts.features : config.artifacts.issues;
  const roadmap = agit("ls-tree", "-r", "--name-only", branch)
    .split("\n")
    .find((p) => p.startsWith(`${top}/`) && p.endsWith(`/${slug}/roadmap.md`));
  if (!roadmap) return null;
  const record = describeFromRef(branch, roadmap, type);
  return record ? { record, source: "local-branch" } : null;
}

// Where `/agento continue` finds the files to follow for the emitted command: the
// plugin command file and, for custom-agent prompts, the agent file whose `name:`
// matches the prompt's `agent:` frontmatter.
function dispatchFor(command) {
  if (!command) return null;
  const prompt = path.join(PLUGIN_ROOT, "commands", `${command}.md`);
  if (!fs.existsSync(prompt)) return { prompt, agent: null };
  const agentName = fs.readFileSync(prompt, "utf8").match(/^agent:\s*"([^"\n]+)"/m)?.[1] ?? null;
  if (!agentName || agentName === "agent") return { prompt, agent: null };
  const agentsDir = path.join(PLUGIN_ROOT, ".github", "agents");
  const agent = fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith(".agent.md"))
    .map((f) => path.join(agentsDir, f))
    .find((f) => fs.readFileSync(f, "utf8").match(/^name:\s*"([^"\n]+)"/m)?.[1] === agentName);
  return { prompt, agent: agent ?? null };
}

switch (command) {
  case "config":
    emit({
      status: "ok",
      root,
      repoName,
      configSource: source,
      pluginRoot: PLUGIN_ROOT,
      currentBranch,
      artifactsRoot,
      config: { ...config, artifacts: { ...config.artifacts, repo: { name: artifacts.name, dir: artifacts.dir } }, worktrees: { dir: worktreesDir } },
    });
    break;

  case "resolve": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(resolveRoadmapArtifact({ rootDir: root, artifactsRoot, type, slug, currentBranch, git: artifactsGit, config }));
    break;
  }

  case "find": {
    const slug = requireSlug(rest[0]);
    const results = ["feature", "issue"].map((type) => ({
      type,
      ...resolveRoadmapArtifact({ rootDir: root, artifactsRoot, type, slug, currentBranch, git: artifactsGit, config }),
    }));
    const found = results.filter((r) => r.status !== "missing");
    if (found.length === 0) withExit({ status: "missing", message: `No roadmap for slug ${slug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin.` });
    if (found.length > 1) withExit({ status: "conflict", candidates: found, message: `Slug ${slug} exists as both a feature and an issue; specify the type.` });
    withExit(found[0]);
    break;
  }

  case "status": {
    const typeFilter = rest[0] ? requireType(rest[0]) : null;
    const slugFilter = rest[1] ? requireSlug(rest[1]) : null;
    const items = allRoadmaps(typeFilter).filter((r) => !slugFilter || r.slug === slugFilter);
    const bySlug = new Map();
    for (const item of items) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item.roadmap]);
    const duplicates = [...bySlug.entries()].filter(([, paths]) => paths.length > 1).map(([slug, paths]) => ({ slug, paths }));
    const order = ["in-progress", "paused", "in-review", "planned", "complete"];
    items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.slug.localeCompare(b.slug));
    emit({ status: "ok", root, currentBranch, defaultBranch: config.branches.default, items, duplicates, resumable: items.filter((i) => ["in-progress", "paused", "in-review"].includes(i.status)).map((i) => i.slug) });
    break;
  }

  case "close-decision": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(closeBuildSessionDecision({ type, slug, currentBranch, worktreeList: git(root, "worktree", "list", "--porcelain"), git: artifactsGit, rootDir: root, artifactsRoot, config }));
    break;
  }

  case "ship-preflight": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot, currentBranch, git: artifactsGit, config, worktreeList: git(root, "worktree", "list", "--porcelain") }));
    break;
  }

  case "ports": {
    // Stable per-slug ports so concurrent sessions never collide and a resumed
    // session reuses the same numbers (see concurrent-delivery.instructions.md).
    const slug = requireSlug(rest[0]);
    let hash = 0;
    for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const offset = hash % 90;
    emit({ status: "ok", slug, WEB_PORT: 3100 + offset, API_PORT: 4100 + offset, offset });
    break;
  }

  case "paths": {
    const kind = rest[0];
    const id = rest[1];
    if (!["feature", "issue", "plan", "freehand"].includes(kind)) usage("paths kind must be feature, issue, plan, or freehand");
    requireSlug(id);
    const prefixes = { feature: config.branches.feature, issue: config.branches.issue, freehand: config.branches.freehand };
    const artifactRel = kind === "feature" ? config.artifacts.features : kind === "issue" ? config.artifacts.issues : null;
    emit({
      status: "ok",
      worktreesDir,
      worktree: path.join(worktreesDir, `${kind}-${id}`),
      branch: kind === "plan" ? null : `${prefixes[kind]}${id}`,
      artifactsRoot,
      artifactRoot: artifactRel === null ? null : path.join(artifactsRoot, artifactRel),
      defaultBranch: config.branches.default,
      postShipBranch: kind === "plan" || kind === "freehand" ? null : `${config.branches.postShip}${id}`,
    });
    break;
  }

  case "initiative": {
    const slug = rest[0] ? requireSlug(rest[0]) : null;
    const breakdowns = allBreakdowns();
    if (!slug) {
      const roadmaps = allRoadmaps("feature");
      const items = breakdowns.map((b) => {
        const d = deriveInitiative(b, roadmaps);
        return {
          slug: b.slug,
          dir: b.dir,
          created: b.created,
          lastUpdated: b.lastUpdated,
          total: d.features.length,
          complete: d.features.filter((f) => f.state === "complete").length,
          inFlight: d.features.filter((f) => !["unplanned", "complete"].includes(f.state)).length,
          ready: d.features.filter((f) => f.ready).length,
          done: d.done,
          valid: d.status === "ok",
        };
      });
      withExit({ status: "ok", initiativesRoot: config.artifacts.initiatives, items });
    }
    const breakdown = breakdowns.find((b) => b.slug === slug);
    if (!breakdown) withExit({ status: "missing", message: `No breakdown.md for initiative ${slug} under ${config.artifacts.initiatives}/.` });
    const derived = deriveInitiative(breakdown, allRoadmaps("feature"));
    withExit({
      ...derived,
      initiative: { slug: breakdown.slug, dir: breakdown.dir, breakdown: breakdown.breakdown, created: breakdown.created, lastUpdated: breakdown.lastUpdated },
      anomalies: mergedAnomalies(derived.features),
    });
    break;
  }

  case "session": {
    if (rest.length) usage(`session takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    // startDir (not root): a subdirectory inside a worktree resolves to that worktree's entry.
    const worktrees = parseWorktreeList(git(root, "worktree", "list", "--porcelain"));
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { role, worktree, hosted, reason: hostedReason } = deriveRole({ cwd: startDir, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env });
    const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config });
    const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps: allRoadmaps(), config });
    const { pr, warnings: prWarnings } = options.pr ? lookupPullRequest(delivery?.branch ?? worktree.branch) : { pr: null, warnings: [] };
    const { lifecycle, warnings } = deriveLifecycle({ delivery, pr });
    const { allowed, elsewhere } = deriveAllowed({ role, lifecycle, delivery, worktree });
    emit({
      status: "ok",
      role,
      hosted,
      worktree,
      worktrees: classified,
      delivery,
      pr,
      lifecycle,
      allowed,
      elsewhere,
      warnings: [...(hostedReason ? [hostedReason] : []), ...prWarnings, ...warnings],
      root,
      configSource: source,
    });
    break;
  }

  case "doctor": {
    if (rest.length) usage(`doctor takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    const needs = options.for ? COMMAND_NEEDS[options.for] : null;
    if (options.for && !needs) usage(`--for: unknown command ${options.for}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
    const { status, checks } = runDoctor(needs ? checksFor(needs) : Object.keys(DOCTOR_CHECKS));
    // warn is usable (exit 0); only a failed hard requirement is a resolution failure (exit 3).
    emit({ status, for: needs ? { command: options.for, needs } : null, checks, root, configSource: source }, status === "fail" ? 3 : 0);
    break;
  }

  case "next": {
    if (rest.length > 1) usage(`next takes at most one slug, got ${JSON.stringify(rest.slice(1).join(" "))}`);
    const requestedSlug = rest[0] ? requireSlug(rest[0]) : null;
    const worktrees = parseWorktreeList(git(root, "worktree", "list", "--porcelain"));
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { role, worktree, reason: hostedReason } = deriveRole({ cwd: startDir, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env });
    const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config });
    const roadmaps = allRoadmaps();
    const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps, config });
    const { lifecycle, warnings } = deriveLifecycle({ delivery, pr: null });
    if (hostedReason) warnings.unshift(hostedReason);
    const ownerOf = (branch) => findOwner({ worktrees, worktreesDir: sessionWorktreesDir, branch, config });

    const toCandidate = (record, sourceKind) => {
      const fresh = reviewFreshness(record.branch, record.dir);
      if (fresh.warning) warnings.push(fresh.warning);
      return {
        kind: "delivery",
        type: record.type,
        slug: record.slug,
        branch: record.branch,
        dir: record.dir,
        roadmap: record.roadmap,
        status: record.status,
        reviewVerdict: record.reviewVerdict,
        postShipPending: record.postShipPending,
        owner: ownerOf(record.branch),
        reviewFresh: fresh.reviewFresh,
        source: sourceKind,
        ref: fresh.ref,
      };
    };

    // Candidates: non-complete roadmaps in this checkout, deliveries owned by managed
    // worktrees (read from their branch when not in this checkout), ready members.
    const candidates = [];
    const seen = new Set();
    const add = (c) => {
      if (!c || seen.has(c.slug)) return;
      seen.add(c.slug);
      candidates.push(c);
    };
    for (const r of roadmaps) if (r.status !== "complete" || r.postShipPending > 0) add(toCandidate(r, "local"));
    for (const w of classified) {
      if (!w.isManaged || w.role !== "build") continue;
      const d = deriveDelivery({ branch: w.branch, dirPrefix: w.dirPrefix, id: w.id, roadmaps, config });
      if (!d || seen.has(d.slug)) continue;
      if (d.roadmap) add(toCandidate(roadmaps.find((r) => r.type === d.type && r.slug === d.slug), "local"));
      else {
        const found = roadmapOnBranch(d.type, d.slug);
        if (found) add(toCandidate(found.record, found.source));
      }
    }
    const members = [];
    for (const b of allBreakdowns()) {
      const derived = deriveInitiative(b, roadmaps.filter((r) => r.type === "feature"));
      if (derived.status !== "ok") continue;
      for (const f of derived.features) if (f.ready) members.push({ kind: "initiative-member", slug: f.slug, type: "feature", initiative: b.slug, branch: f.branch });
    }
    for (const m of members) add(m);

    let missingMessage = null;
    if (requestedSlug && !seen.has(requestedSlug)) {
      const local = roadmaps.filter((r) => r.slug === requestedSlug);
      if (local.length === 1) add(toCandidate(local[0], "local"));
      else if (local.length > 1) {
        emit({ status: "ambiguous", role, lifecycle, slug: requestedSlug, type: null, next: null, candidates: local.map((r) => ({ kind: "delivery", slug: r.slug, type: r.type, status: r.status, initiative: r.initiative, owner: ownerOf(r.branch), invocation: `/agento continue ${r.slug}` })), reviewFresh: null, dispatch: null, warnings, reason: `Slug ${requestedSlug} exists as both a feature and an issue; specify which by its own worktree.`, root, configSource: source }, 3);
      } else {
        let resolved = null;
        for (const type of ["feature", "issue"]) {
          const found = roadmapOnBranch(type, requestedSlug);
          if (found) {
            resolved = found;
            break;
          }
        }
        if (resolved) add(toCandidate(resolved.record, resolved.source));
        else missingMessage = `No roadmap for slug ${requestedSlug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin, and no initiative member with that slug is ready.`;
      }
    }

    const active = delivery?.dir ? reviewFreshness(delivery.branch, delivery.dir) : null;
    if (active?.warning) warnings.push(active.warning);
    const result = deriveNext({
      role,
      worktree,
      delivery,
      lifecycle,
      owner: delivery ? ownerOf(delivery.branch) : null,
      reviewFresh: active?.reviewFresh ?? null,
      candidates,
      requestedSlug,
      config,
    });
    if (result.status === "missing" && missingMessage) result.reason = missingMessage;
    const target = requestedSlug ? candidates.find((c) => c.slug === requestedSlug) ?? null : delivery && lifecycle !== "no-delivery" ? delivery : candidates.length === 1 ? candidates[0] : null;
    const targetFresh = target === delivery ? active?.reviewFresh ?? null : target?.kind === "delivery" ? target.reviewFresh : null;
    emit(
      {
        status: result.status,
        role,
        lifecycle,
        slug: target?.slug ?? requestedSlug ?? null,
        type: target?.type ?? null,
        next: result.next,
        candidates: result.candidates,
        reviewFresh: targetFresh,
        dispatch: dispatchFor(result.next?.command),
        warnings: [...new Set(warnings)],
        reason: result.reason,
        root,
        configSource: source,
      },
      result.status === "ok" || result.status === "none" ? 0 : 3,
    );
    break;
  }

  default:
    usage(command ? `unknown command ${command}` : "missing command");
}
