#!/usr/bin/env node
// Agento CLI: the deterministic half of the delivery workflow. Prompts call this
// instead of re-deriving slug resolution, status listings, and config lookups in
// prose. Always prints one JSON document; exit 0 when the result is usable, 1 on a
// usage error, 3 when the resolution itself failed (conflict, mismatch, missing).
//
//   node scripts/agento.mjs config
//   node scripts/agento.mjs resolve <feature|issue> <slug>
//   node scripts/agento.mjs find <slug>                 (type-agnostic)
//   node scripts/agento.mjs status [feature|issue] [slug] [--pr]   (--pr adds pr + companionPr per non-complete item)
//   node scripts/agento.mjs close-decision <feature|issue> <slug>
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug> [--pr]   (--pr adds pr + companionPr + warnings; companion PR gaps join companionGaps)
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>   (+ companion half and .code-workspace in companion mode)
//   node scripts/agento.mjs initiative [<slug>]
//   node scripts/agento.mjs session [--pr]             (role, worktree, worktrees, companion, workspace, delivery, lifecycle, allowed; hosted flag; --pr adds pr + companionPr)
//   node scripts/agento.mjs next [<slug>]              (the one legal transition: command, args, window, target { path, workspace }, dispatch paths)
//   node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)
//   node scripts/agento.mjs migrate <companion-checkout> [--apply]   (move in-repo artifact roots into the companion; dry run without --apply)
//
// Options: --root <dir> (default: the git toplevel of the cwd; a companion clone or
// companion half re-anchors on its product checkout).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentoConfig, parseConfigText, resolveArtifactsRoot } from "./agento-config.mjs";
import {
  closeBuildSessionDecision,
  evaluateShipPreflight,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";
import { classifyWorktrees, deriveAllowed, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, LIFECYCLES, pairFor, parseWorktreeList, resolveNextTarget } from "./session-state.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22);
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
    else if (arg === "--apply") options.apply = true;
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
const toplevel = git(startDir, "rev-parse", "--show-toplevel") || startDir;

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function hasCompanionConfig(dir) {
  try {
    const repo = loadAgentoConfig(dir).config.artifacts?.repo ?? {};
    return repo.name != null || repo.dir != null;
  } catch {
    return false;
  }
}

const MANAGED_HALF = /^(plan|feature|issue|freehand)-(.+)$/;

// A cwd inside a companion clone or a companion half (`<clone>-worktrees/<kind>-<id>`)
// has no artifacts.repo of its own. Re-anchor on the product checkout: the sibling
// git checkout of the clone whose config resolves artifacts.dir to that clone — and,
// for a half, the product half of the same name when it exists. Zero matches keep
// today's behaviour silently (an in-repo project's own managed worktree looks the
// same); several matches keep it too and warn.
function anchorRoot(dir) {
  if (hasCompanionConfig(dir)) return { root: dir, warnings: [] };
  const ownList = parseWorktreeList(git(dir, "worktree", "list", "--porcelain"));
  const clone = ownList[0]?.path ?? dir;
  if (!samePath(clone, dir) && hasCompanionConfig(clone)) return { root: dir, warnings: [] };
  const halfName = path.basename(dir);
  const looksLikeHalf = !samePath(clone, dir) && MANAGED_HALF.test(halfName) && path.basename(path.dirname(dir)) === `${path.basename(clone)}-worktrees`;
  const parent = path.dirname(clone);
  let siblings;
  try {
    siblings = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return { root: dir, warnings: [] };
  }
  const matches = [];
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(parent, entry.name);
    if (samePath(candidate, clone) || !fs.existsSync(path.join(candidate, ".git"))) continue;
    try {
      const resolved = resolveArtifactsRoot({ config: loadAgentoConfig(candidate).config, rootDir: candidate });
      if (resolved.external && samePath(resolved.dir, clone)) matches.push(candidate);
    } catch {
      // unreadable or malformed config: not a product checkout
    }
  }
  if (matches.length === 1) {
    const product = matches[0];
    const productHalf = path.resolve(product, loadAgentoConfig(product).config.worktrees.dir, halfName);
    const anchored = looksLikeHalf && fs.existsSync(productHalf) ? productHalf : product;
    return { root: anchored, warnings: [`anchored-from-companion: ${dir} is a companion checkout of ${product}; the record describes ${anchored}`] };
  }
  if (matches.length > 1) return { root: dir, warnings: [`companion-anchor: ${matches.length} sibling checkouts name ${clone} as their artifacts.repo (${matches.join(", ")}); keep one product per companion`] };
  return { root: dir, warnings: [] };
}

const anchor = anchorRoot(toplevel);
const root = anchor.root;
const { config, source } = loadAgentoConfig(root);
const repoName = path.basename(root);
const worktreesDir = path.resolve(root, config.worktrees.dir);
const currentBranch = git(root, "branch", "--show-current");
const gitAdapter = {
  lsTree: (ref) => git(root, "ls-tree", "-r", "--name-only", ref),
  show: (spec) => git(root, "show", spec),
};

// Artifact roots may live in a sibling companion checkout (artifacts.repo). The
// layout rule: the checkout decides, the primary anchors. This checkout's own
// config unset → in-repo, with no extra git call. Set → companion mode, resolved
// against the primary checkout (like worktrees.dir); the primary's own
// `artifacts.repo` wins when it is set too, else this checkout's values are used —
// so a delivery branch that flips a project to a companion reads it before `main` does.
function resolveArtifacts() {
  const repo = config.artifacts.repo ?? {};
  if (repo.name == null && repo.dir == null) return resolveArtifactsRoot({ config, rootDir: root });
  const primaryRoot = parseWorktreeList(git(root, "worktree", "list", "--porcelain"))[0]?.path ?? root;
  const primaryConfig = primaryRoot === root ? config : loadAgentoConfig(primaryRoot).config;
  const primaryRepo = primaryConfig.artifacts.repo ?? {};
  const anchored = primaryRepo.name != null || primaryRepo.dir != null ? primaryConfig : config;
  return resolveArtifactsRoot({ config: anchored, rootDir: root, primaryRoot });
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

// Companion mode only: the companion clone's registered worktrees, read once.
const companionWorktreesDir = artifacts.external ? artifacts.worktreesDir : null;
let companionWorktreesCache = null;
function companionWorktrees() {
  if (!artifacts.external) return [];
  companionWorktreesCache ??= parseWorktreeList(git(artifacts.dir, "worktree", "list", "--porcelain"));
  return companionWorktreesCache;
}

// The artifact objects a slug-targeted read works against. `layout: "checkout"` is
// this checkout's own resolution (the module-level objects). `layout: "branch"` is
// the branch-aware fallback: from an in-repo checkout, the delivery branch's own
// committed `.github/agento.json` (origin/<branch>, then <branch>) names a companion
// that exists beside the primary, so the read is redone against that clone —
// `/agento ship` from a `main` that is still in-repo finds a migrated roadmap this
// way. Null when the branch sets no companion; `absent: true` (with `artifactsRoot`
// naming the missing clone) when it names one that is not on disk — never auto-cloned.
function checkoutLayout() {
  return { layout: "checkout", config, artifacts, artifactsRoot, artifactsGit, agit, companionWorktreesDir, companionWorktrees: companionWorktrees(), absent: false };
}

function layoutFor(branch) {
  if (artifacts.external) return checkoutLayout();
  if (!branch) return null;
  const text = git(root, "show", `origin/${branch}:.github/agento.json`) || git(root, "show", `${branch}:.github/agento.json`);
  if (!text) return null;
  let branchConfig;
  try {
    branchConfig = parseConfigText(text, root);
  } catch {
    return null;
  }
  const primaryRoot = parseWorktreeList(git(root, "worktree", "list", "--porcelain"))[0]?.path ?? root;
  const resolved = resolveArtifactsRoot({ config: branchConfig, rootDir: root, primaryRoot });
  if (!resolved.external) return null;
  const dir = resolved.dir;
  const toplevel = git(dir, "rev-parse", "--show-toplevel");
  const bound = (...args) => git(dir, ...args);
  if (!toplevel || !samePath(toplevel, dir)) {
    return { layout: "branch", config: branchConfig, artifacts: resolved, artifactsRoot: dir, artifactsGit: null, agit: bound, companionWorktreesDir: resolved.worktreesDir, companionWorktrees: [], absent: true };
  }
  return {
    layout: "branch",
    config: branchConfig,
    artifacts: resolved,
    artifactsRoot: dir,
    artifactsGit: { lsTree: (ref) => bound("ls-tree", "-r", "--name-only", ref), show: (spec) => bound("show", spec) },
    agit: bound,
    companionWorktreesDir: resolved.worktreesDir,
    companionWorktrees: parseWorktreeList(bound("worktree", "list", "--porcelain")),
    absent: false,
  };
}

const deliveryBranch = (type, slug) => `${type === "feature" ? config.branches.feature : config.branches.issue}${slug}`;

// The slug-targeted read: this checkout's layout first; when that is `missing` in
// an in-repo checkout, the delivery branch's own layout (`layoutFor`). Returns the
// resolution and the layout it came from; an absent companion stays `missing` with
// the clone named in the message.
function resolveWithLayout(type, slug) {
  const base = checkoutLayout();
  const first = resolveRoadmapArtifact({ rootDir: root, artifactsRoot, type, slug, currentBranch, git: artifactsGit, config });
  if (first.status !== "missing" || artifacts.external) return { result: first, layout: base };
  const branch = deliveryBranch(type, slug);
  const alt = layoutFor(branch);
  if (!alt) return { result: first, layout: base };
  if (alt.absent) {
    return { result: { ...first, message: `${first.message} ${branch} sets artifacts.repo to ${alt.artifacts.name}, but the companion checkout ${alt.artifactsRoot} is not on disk; clone it with /agento agento-init.` }, layout: base };
  }
  const second = resolveRoadmapArtifact({ rootDir: root, artifactsRoot: alt.artifactsRoot, type, slug, currentBranch, git: alt.artifactsGit, config: alt.config });
  return second.status === "missing" ? { result: first, layout: base } : { result: second, layout: alt };
}

const withLayout = (result, layout) => ({ ...result, layout: layout.layout, artifactsRoot: layout.artifactsRoot });

// The same retry for the resolver's decision helpers (close-decision, ship-preflight),
// which report a missing roadmap as `reason: "no-resolvable-roadmap"`.
function decideWithLayout(type, slug, decide) {
  const base = checkoutLayout();
  const first = decide(base);
  if (first.reason !== "no-resolvable-roadmap" || artifacts.external) return { decision: first, layout: base };
  const branch = deliveryBranch(type, slug);
  const alt = layoutFor(branch);
  if (!alt) return { decision: first, layout: base };
  if (alt.absent) {
    return { decision: { ...first, message: `${first.message} ${branch} sets artifacts.repo to ${alt.artifacts.name}, but the companion checkout ${alt.artifactsRoot} is not on disk; clone it with /agento agento-init.` }, layout: base };
  }
  const second = decide(alt);
  return second.reason === "no-resolvable-roadmap" ? { decision: first, layout: base } : { decision: second, layout: alt };
}

// The companion half paired with a managed product worktree, with the git facts the
// close and ship decisions need: `dirty` (uncommitted changes), `ahead` (commits
// not on the upstream, or on no remote ref at all when there is no upstream), and
// `behind` (upstream commits not in HEAD; 0 without an upstream). `layout` names
// the companion objects (this checkout's by default; a branch's for the fallback).
function describeCompanion(worktree, layout = checkoutLayout()) {
  const pair = pairFor({ worktree, companionWorktreesDir: layout.companionWorktreesDir, companionWorktrees: layout.companionWorktrees });
  if (!pair) return null;
  if (!pair.registered || !fs.existsSync(pair.path)) return { ...pair, dirty: false, ahead: 0, behind: 0 };
  const dirty = git(pair.path, "status", "--porcelain") !== "";
  const upstream = git(pair.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const count = upstream ? git(pair.path, "rev-list", "--count", "@{upstream}..HEAD") : git(pair.path, "rev-list", "--count", "HEAD", "--not", "--remotes");
  const behind = upstream ? git(pair.path, "rev-list", "--count", "HEAD..@{upstream}") : "0";
  return { path: pair.path, branch: pair.branch, detached: pair.detached, dirty, ahead: Number.parseInt(count, 10) || 0, behind: Number.parseInt(behind, 10) || 0, registered: true };
}

// The multi-root workspace file a paired session opens (product side, next to the
// product half); null for the primary, unmanaged cwds, and in-repo mode.
function describeWorkspace(worktree, sessionWorktreesDir) {
  if (!artifacts.external || !worktree?.isManaged) return null;
  const file = path.join(sessionWorktreesDir, `${worktree.dirPrefix}-${worktree.id}.code-workspace`);
  return { path: file, exists: fs.existsSync(file) };
}

// close-decision / ship-preflight: the companion half owned alongside the product
// half, or null when no managed worktree owns the branch (or in-repo mode).
function companionOfOwner(owner, layout) {
  if (!owner || owner.role === "primary" || !owner.dirPrefix) return null;
  return describeCompanion({ isManaged: true, dirPrefix: owner.dirPrefix, id: owner.id }, layout);
}

function companionGaps(companion) {
  if (!companion?.registered) return [];
  return [...(companion.dirty ? ["dirty"] : []), ...(companion.ahead > 0 ? ["unpushed"] : []), ...(companion.behind > 0 ? ["behind"] : [])];
}

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
    artifactPr: header(content, "artifact-pr") || null,
    initiative: header(content, "initiative") || null,
    steps: { ticked: steps.filter((m) => m[1] === "x").length, total: steps.length },
    postShipPending: (content.match(/^- \[ \] \d+\.\d+ \(manual, post-ship\)/gm) ?? []).length,
  };
}

function describe(file, type, base = artifactsRoot) {
  const dir = path.dirname(file);
  const rel = (p) => path.relative(base, p).split(path.sep).join("/");
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
// roadmaps that exist only on a delivery branch. `roadmap` is repository-relative;
// `g` is the git binding of the checkout that holds the ref (the artifacts root).
function describeFromRef(ref, roadmap, type, g = agit) {
  const content = g("show", `${ref}:${roadmap}`);
  if (!content) return null;
  const dir = path.posix.dirname(roadmap);
  const tree = new Set(g("ls-tree", "--name-only", ref, `${dir}/`).split("\n").filter(Boolean));
  return describeContent({
    type,
    dir,
    roadmap,
    content,
    planExists: tree.has(`${dir}/plan.md`),
    reviewContent: tree.has(`${dir}/review.md`) ? g("show", `${ref}:${dir}/review.md`) : null,
  });
}

// `halves`: extra bases walked before the artifacts root — registered companion
// halves (companion mode) or managed build worktrees (in-repo), whose working trees
// carry roadmaps the artifact checkout's <default> has not merged yet. One
// repository-relative roadmap path seen in several bases resolves to the copy whose
// `branch:` header equals its base's checked-out branch (that delivery's own half is
// its truth); else the artifacts root's copy; else the first base listed. Null and
// missing bases are skipped, so `[]` is today's behaviour in the in-repo layout.
function allRoadmaps(typeFilter, halves = []) {
  const bases = [];
  for (const base of [...halves, artifactsRoot]) {
    if (base && fs.existsSync(base) && !bases.some((b) => samePath(b, base))) bases.push(base);
  }
  const candidates = new Map();
  for (const base of bases) {
    const isRoot = samePath(base, artifactsRoot);
    let baseBranch = null;
    for (const type of ["feature", "issue"]) {
      if (typeFilter && type !== typeFilter) continue;
      const top = path.join(base, type === "feature" ? config.artifacts.features : config.artifacts.issues);
      for (const file of walkRoadmaps(top)) {
        const record = describe(file, type, base);
        baseBranch ??= git(base, "branch", "--show-current");
        const entry = { record, matched: Boolean(baseBranch) && record.branch === baseBranch, isRoot };
        const list = candidates.get(record.roadmap);
        if (list) list.push(entry);
        else candidates.set(record.roadmap, [entry]);
      }
    }
  }
  const out = [];
  for (const list of candidates.values()) {
    const pick = list.find((e) => e.matched) ?? list.find((e) => e.isRoot) ?? list[0];
    out.push(pick.record);
  }
  return out;
}

// The extra roadmap bases `status` walks so an in-flight delivery is visible from
// the primary: in companion mode every registered companion half that is a managed
// `<kind>-<id>` directory under the companion worktrees dir; in the in-repo layout
// every managed product worktree with role build. Only bases present on disk.
function managedHalves(worktrees) {
  if (artifacts.external) {
    if (!companionWorktreesDir) return [];
    return companionWorktrees()
      .filter((w) => MANAGED_HALF.test(path.basename(w.path)) && samePath(path.dirname(w.path), companionWorktreesDir) && fs.existsSync(w.path))
      .map((w) => w.path);
  }
  const classified = classifyWorktrees({ worktrees, worktreesDir: primaryWorktreesDir(worktrees), config });
  return classified.filter((w) => w.isManaged && w.role === "build" && fs.existsSync(w.path)).map((w) => w.path);
}

// The companion half a session reads roadmaps from, or null (primary, unregistered
// pair, in-repo layout).
function companionHalfOf(companion) {
  return companion?.registered && fs.existsSync(companion.path) ? companion.path : null;
}

function withExit(result) {
  emit({ ...result, root, configSource: source }, result.status === "ok" ? 0 : 3);
}

// Only `session --pr` and `ship-preflight --pr` reach this; every failure is a warning, never an exit code.
// `label` names the field in warnings (`pr` for the code PR in the product checkout,
// `companionPr` for the artifact PR looked up in the companion clone).
function lookupPullRequest(branch, { cwd = root, label = "pr" } = {}) {
  if (!branch) return { pr: null, warnings: [`${label}: no branch to look up (detached HEAD)`] };
  const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 };
  try {
    execFileSync("gh", ["--version"], opts);
  } catch {
    return { pr: null, warnings: [`${label}: gh CLI not found on PATH; install GitHub CLI to include pull request state`] };
  }
  try {
    const out = execFileSync("gh", ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,url"], opts);
    return { pr: JSON.parse(out), warnings: [] };
  } catch (error) {
    const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0] || error?.message || "unknown error";
    return { pr: null, warnings: [`${label}: gh pr view ${branch} failed: ${stderr}`] };
  }
}

// The mirrored artifact PR: the same branch name looked up in the companion clone
// the layout names. In-repo layout → null with no gh call, so today's output is unchanged.
function lookupCompanionPullRequest(branch, layout = checkoutLayout()) {
  if (!layout.artifacts.external) return { pr: null, warnings: [] };
  return lookupPullRequest(branch, { cwd: layout.artifactsRoot, label: "companionPr" });
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
  "artifact-repo"() {
    if (!artifacts.external) return { status: "ok", detail: "in-repo layout (artifacts.repo unset)", fallback: null };
    const { name, dir } = artifacts;
    const fallback = `run \`/agento agento-init\` to create and clone the companion repository ${name} at ${dir}, or correct artifacts.repo in .github/agento.json`;
    const fail = (detail) => ({ status: "fail", detail, fallback });
    if (!fs.existsSync(dir)) return fail(`${dir} absent`);
    const toplevel = git(dir, "rev-parse", "--show-toplevel");
    if (!toplevel || fs.realpathSync(toplevel) !== fs.realpathSync(dir)) return fail(`${dir} is not a git checkout toplevel (git rev-parse --show-toplevel → ${toplevel || "nothing"})`);
    const url = git(dir, "remote", "get-url", "origin");
    if (!url) return fail(`${dir} has no \`origin\` remote`);
    const branch = config.branches.default;
    if (!git(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`) && !git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
      return fail(`${dir} has neither origin/${branch} nor ${branch}`);
    }
    const detail = `${dir} (${name}), origin ${url}, ${branch} present`;
    // Pre-migration leftovers in the product repo are ignored by every reader; say so once.
    const primaryRoot = parseWorktreeList(git(root, "worktree", "list", "--porcelain"))[0]?.path ?? root;
    const stale = [config.artifacts.features, config.artifacts.issues, config.artifacts.initiatives].filter((rel) => holdsArtifacts(path.join(primaryRoot, rel)));
    if (stale.length) {
      return { status: "warn", detail: `${detail}; stale in-repo roots: ${stale.map((r) => `${r}/`).join(", ")}`, fallback: "the in-repo roots are ignored while artifacts.repo is set; move them into the companion (`/agento agento-init --migrate`) or remove them" };
    }
    // The companion halves of paired sessions go under <dir>-worktrees (derived, no key).
    const pairDir = artifacts.worktreesDir;
    if (fs.existsSync(pairDir)) {
      try {
        fs.accessSync(pairDir, fs.constants.W_OK);
      } catch {
        return { status: "warn", detail: `${detail}; ${pairDir} not writable`, fallback: `give ${pairDir} write permission (it holds the companion half of every paired session) or remove it so it is recreated` };
      }
    }
    return { status: "ok", detail, fallback: null };
  },
};

// A root still holds artifacts when any file other than the scaffold's .gitkeep is under it.
function holdsArtifacts(base) {
  if (!fs.existsSync(base)) return false;
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
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.name !== ".gitkeep") return true;
    }
  }
  return false;
}

const STATUS_RANK = { ok: 0, warn: 1, fail: 2 };

// Capability vocabulary (delivery-policy §10) in canonical order, each mapped to the
// doctor checks that prove it. Chat-tool capabilities have no CLI-side check.
const CAPABILITY_CHECKS = {
  terminal: ["node", "python3", "worktrees-dir", "artifact-repo"],
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

function parseBreakdown(file, base = artifactsRoot) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const rel = (p) => path.relative(base, p).split(path.sep).join("/");
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
  return [...walkBreakdowns(base)].sort().map((file) => parseBreakdown(file));
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
      artifactPr: roadmap?.artifactPr ?? null,
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

// --- migrate ---------------------------------------------------------------

const ROOT_KEYS = ["features", "issues", "initiatives"];

// Every regular file under `base` as { rel (posix, relative to base), bytes }.
function listFiles(base) {
  const out = [];
  if (!fs.existsSync(base)) return out;
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
      else if (entry.isFile()) out.push({ rel: path.relative(base, child).split(path.sep).join("/"), bytes: fs.statSync(child).size });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// The three artifact roots under `base`: their relative path, file count, and bytes.
const describeRoots = (base) =>
  ROOT_KEYS.map((key) => {
    const rel = config.artifacts[key];
    const files = listFiles(path.join(base, rel));
    return { rel, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  });

// Every roadmap and breakdown record under the roots at `base`, in path order, so
// the same tree read before and after a move compares equal.
function recordsUnder(base) {
  const roadmaps = [];
  for (const type of ["feature", "issue"]) {
    const top = path.join(base, type === "feature" ? config.artifacts.features : config.artifacts.issues);
    for (const file of walkRoadmaps(top)) roadmaps.push(describe(file, type, base));
  }
  const breakdowns = [...walkBreakdowns(path.join(base, config.artifacts.initiatives))]
    .map((file) => parseBreakdown(file, base))
    .map((b) => ({ slug: b.slug, dir: b.dir, breakdown: b.breakdown, features: b.features.map((f) => f.slug) }));
  const byPath = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
  return { roadmaps: roadmaps.sort(byPath("roadmap")), breakdowns: breakdowns.sort(byPath("breakdown")) };
}

// `<owner>/<repo>` of the product's origin when it parses, else the primary's basename.
function productName(primaryRoot) {
  const url = git(root, "remote", "get-url", "origin");
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : path.basename(primaryRoot);
}

// Set only artifacts.repo.name in the product config, creating it from the plugin
// template when absent; every other key is preserved verbatim.
function writeCompanionName(name) {
  const file = path.join(root, ".github", "agento.json");
  let raw;
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  else raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agento.json"), "utf8"));
  raw.artifacts ??= {};
  raw.artifacts.repo = { ...(raw.artifacts.repo ?? {}), name };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return file;
}

const MIGRATED_HEADING = "## Migrated history";

function appendMigrationNote(destination, product) {
  const file = path.join(destination, "README.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (new RegExp(`^${MIGRATED_HEADING}\\s*$`, "m").test(existing)) return false;
  const note = [
    MIGRATED_HEADING,
    "",
    "The delivery artifacts under `features/`, `issues/`, and `initiatives/` were",
    `moved here from the product repository \`${product}\` by \`/agento agento-init --migrate\`.`,
    "Plans written before the migration link to the product repository with",
    "`../../../../<path>` relative to their old location; read them against",
    `\`${product}\` at the time of writing.`,
    "",
  ].join("\n");
  const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${existing}${separator}${note}`);
  return true;
}

function recordsDiff(before, after) {
  const diff = [];
  for (const kind of ["roadmaps", "breakdowns"]) {
    const key = kind === "roadmaps" ? "roadmap" : "breakdown";
    const b = new Map(before[kind].map((r) => [r[key], JSON.stringify(r)]));
    const a = new Map(after[kind].map((r) => [r[key], JSON.stringify(r)]));
    for (const [p, v] of b) diff.push(...(!a.has(p) ? [{ path: p, kind: "missing" }] : a.get(p) !== v ? [{ path: p, kind: "changed" }] : []));
    for (const p of a.keys()) if (!b.has(p)) diff.push({ path: p, kind: "added" });
  }
  return diff;
}

// --- next ------------------------------------------------------------------

// The ref a delivery branch is judged from: origin/<branch> when fetched, else the
// local branch (with a warning: no fetch happens here), else HEAD. `g` binds the
// checkout holding the artifacts (this one's, or a branch layout's companion).
function refFor(branch, g = agit) {
  if (branch && g("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) return { ref: `origin/${branch}`, warning: null };
  if (branch && g("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
    return { ref: branch, warning: `${branch}: origin/${branch} is absent, so review freshness and roadmap state reflect the local branch as of the last fetch` };
  }
  return { ref: "HEAD", warning: null };
}

// review.md is fresh when its last commit is not older than the last commit that
// touched anything else on the branch; null when the branch has no review.md.
function reviewFreshness(branch, dir, g = agit) {
  const { ref, warning } = refFor(branch, g);
  const reviewTs = g("log", "-1", "--format=%ct", ref, "--", `${dir}/review.md`);
  if (!reviewTs) return { reviewFresh: null, ref, warning };
  const otherTs = g("log", "-1", "--format=%ct", ref, "--", ".", `:(exclude)${dir}/review.md`);
  return { reviewFresh: Number(reviewTs) >= Number(otherTs || 0), ref, warning };
}

// A roadmap that lives only on its delivery branch: origin/<branch> first (via the
// shared resolver, branch-aware), then the unpushed local branch. Never fetches.
// The record carries the layout it was read from.
function roadmapOnBranch(type, slug) {
  const { result: resolved, layout } = resolveWithLayout(type, slug);
  const tag = (record) => ({ ...record, layout: layout.layout, artifactsRoot: layout.artifactsRoot });
  if (resolved.status === "ok" && resolved.source === "remote") {
    const record = describeFromRef(`origin/${resolved.branch}`, resolved.path, type, layout.agit);
    if (record) return { record: tag(record), source: "origin", layout };
  }
  const branch = deliveryBranch(type, slug);
  if (!layout.agit("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) return null;
  const top = type === "feature" ? layout.config.artifacts.features : layout.config.artifacts.issues;
  const roadmap = layout.agit("ls-tree", "-r", "--name-only", branch)
    .split("\n")
    .find((p) => p.startsWith(`${top}/`) && p.endsWith(`/${slug}/roadmap.md`));
  if (!roadmap) return null;
  const record = describeFromRef(branch, roadmap, type, layout.agit);
  return record ? { record: tag(record), source: "local-branch", layout } : null;
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
    const { result, layout } = resolveWithLayout(type, slug);
    withExit(withLayout(result, layout));
    break;
  }

  case "find": {
    const slug = requireSlug(rest[0]);
    const results = ["feature", "issue"].map((type) => {
      const { result, layout } = resolveWithLayout(type, slug);
      return { type, ...withLayout(result, layout) };
    });
    const found = results.filter((r) => r.status !== "missing");
    if (found.length === 0) withExit({ status: "missing", message: `No roadmap for slug ${slug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin.` });
    if (found.length > 1) withExit({ status: "conflict", candidates: found, message: `Slug ${slug} exists as both a feature and an issue; specify the type.` });
    withExit(found[0]);
    break;
  }

  case "status": {
    const typeFilter = rest[0] ? requireType(rest[0]) : null;
    const slugFilter = rest[1] ? requireSlug(rest[1]) : null;
    const worktrees = parseWorktreeList(git(root, "worktree", "list", "--porcelain"));
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const items = allRoadmaps(typeFilter, managedHalves(worktrees)).filter((r) => !slugFilter || r.slug === slugFilter);
    const bySlug = new Map();
    for (const item of items) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item.roadmap]);
    const duplicates = [...bySlug.entries()].filter(([, paths]) => paths.length > 1).map(([slug, paths]) => ({ slug, paths }));
    const order = ["in-progress", "paused", "in-review", "planned", "complete"];
    items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.slug.localeCompare(b.slug));
    // Additive dashboard fields (lifecycle, ownership, PR state) so renderers never re-derive them.
    const warnings = [];
    const layout = checkoutLayout();
    for (const item of items) {
      // Complete roadmaps skip the lookup: their PRs are merged history, not dashboard state.
      const lookup = options.pr && item.status !== "complete";
      const { pr, warnings: prWarnings } = lookup ? lookupPullRequest(item.branch) : { pr: null, warnings: [] };
      const { pr: companionPr, warnings: companionPrWarnings } = lookup ? lookupCompanionPullRequest(item.branch, layout) : { pr: null, warnings: [] };
      const { lifecycle, warnings: lifecycleWarnings } = deriveLifecycle({ delivery: item, pr, companionPr });
      const owner = findOwner({ worktrees, worktreesDir: sessionWorktreesDir, branch: item.branch, config });
      const managedOwner = owner && owner.role !== "primary" && owner.dirPrefix ? { isManaged: true, dirPrefix: owner.dirPrefix, id: owner.id } : null;
      item.lifecycle = lifecycle;
      item.owner = owner;
      item.workspace = managedOwner ? describeWorkspace(managedOwner, sessionWorktreesDir) : null;
      item.companion = companionOfOwner(owner, layout);
      const actions = deriveAllowed({ role: owner?.role ?? "primary", lifecycle, delivery: item, worktree: owner });
      item.allowed = actions.allowed;
      item.elsewhere = actions.elsewhere;
      item.pr = pr;
      item.companionPr = companionPr;
      warnings.push(...[...prWarnings, ...companionPrWarnings, ...lifecycleWarnings].map((w) => `${item.slug}: ${w}`));
    }
    emit({
      status: "ok",
      root,
      currentBranch,
      defaultBranch: config.branches.default,
      items,
      duplicates,
      resumable: items.filter((i) => ["in-progress", "paused", "in-review"].includes(i.status)).map((i) => i.slug),
      lifecycles: LIFECYCLES,
      warnings,
    });
    break;
  }

  case "close-decision": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    const worktreeList = git(root, "worktree", "list", "--porcelain");
    const { decision, layout } = decideWithLayout(type, slug, (l) =>
      closeBuildSessionDecision({ type, slug, currentBranch, worktreeList, git: l.artifactsGit, rootDir: root, artifactsRoot: l.artifactsRoot, config: l.config }),
    );
    if (decision.status !== "ok") withExit(withLayout(decision, layout));
    const companion = companionOfOwner(decision.owner, layout);
    const gaps = companionGaps(companion);
    if (gaps.length) {
      const behindOnly = gaps.length === 1 && gaps[0] === "behind";
      const fix = behindOnly
        ? `run git -C ${companion.path} merge origin/${companion.branch} (a fast-forward) before closing ${type}/${slug}`
        : `commit and push it (or discard the changes) before closing ${type}/${slug}, or its artifact work is lost`;
      const state = gaps.map((g) => (g === "behind" ? "behind its upstream" : g)).join(" and ");
      withExit(
        withLayout(
          {
            status: "error",
            reason: "companion-unpushed",
            owner: decision.owner,
            companion,
            message: `The companion half at ${companion.path} is ${state}; ${fix}.`,
          },
          layout,
        ),
      );
    }
    withExit(withLayout({ ...decision, companion }, layout));
    break;
  }

  case "ship-preflight": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    const worktreeList = git(root, "worktree", "list", "--porcelain");
    const { decision: preflight, layout } = decideWithLayout(type, slug, (l) =>
      evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot: l.artifactsRoot, currentBranch, git: l.artifactsGit, config: l.config, worktreeList }),
    );
    if (preflight.status !== "ok") withExit(withLayout(preflight, layout));
    const companion = companionOfOwner(preflight.owner, layout);
    const gaps = companionGaps(companion);
    if (!options.pr) withExit(withLayout({ ...preflight, companion, companionGaps: gaps }, layout));
    const { pr, warnings: prWarnings } = lookupPullRequest(preflight.branch);
    const { pr: companionPr, warnings: companionPrWarnings } = lookupCompanionPullRequest(preflight.branch, layout);
    // A MERGED companion PR is the resume-at-teardown case, not a gap.
    if (layout.artifacts.external) {
      if (!companionPr) gaps.push("missing-pr");
      else if (companionPr.state === "CLOSED") gaps.push("pr-not-open");
      else if (companionPr.mergeStateStatus === "CONFLICTING") gaps.push("conflicting-pr");
    }
    withExit(withLayout({ ...preflight, companion, companionGaps: gaps, pr, companionPr, warnings: [...prWarnings, ...companionPrWarnings] }, layout));
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
    const branch = kind === "plan" ? null : `${prefixes[kind]}${id}`;
    // Deliveries are branch-aware: an in-repo checkout whose delivery branch flips to
    // a companion reports that companion's roots and pair (plan/freehand unchanged).
    const branchLayout = artifactRel !== null && !artifacts.external ? layoutFor(branch) : null;
    const layout = branchLayout && !branchLayout.absent ? branchLayout : checkoutLayout();
    emit({
      status: "ok",
      worktreesDir,
      worktree: path.join(worktreesDir, `${kind}-${id}`),
      branch,
      artifactsRoot: layout.artifactsRoot,
      artifactRoot: artifactRel === null ? null : path.join(layout.artifactsRoot, artifactRel),
      layout: layout.layout,
      defaultBranch: config.branches.default,
      postShipBranch: kind === "plan" || kind === "freehand" ? null : `${config.branches.postShip}${id}`,
      // Companion mode: the paired companion half (same <kind>-<id>, same branch) and the
      // two-folder workspace file the session opens; both null in the in-repo layout.
      companion: layout.artifacts.external ? { worktreesDir: layout.companionWorktreesDir, worktree: path.join(layout.companionWorktreesDir, `${kind}-${id}`), branch } : null,
      workspace: layout.artifacts.external ? path.join(worktreesDir, `${kind}-${id}.code-workspace`) : null,
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
    const { role, worktree, hosted, reason: hostedReason } = deriveRole({ cwd: startDir, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
    const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config, companionWorktreesDir, companionWorktrees: companionWorktrees() });
    const companion = describeCompanion(worktree);
    const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps: allRoadmaps(null, [companionHalfOf(companion)]), config });
    const prBranch = delivery?.branch ?? worktree.branch;
    const { pr, warnings: prWarnings } = options.pr ? lookupPullRequest(prBranch) : { pr: null, warnings: [] };
    const { pr: companionPr, warnings: companionPrWarnings } = options.pr ? lookupCompanionPullRequest(prBranch) : { pr: null, warnings: [] };
    const { lifecycle, warnings } = deriveLifecycle({ delivery, pr, companionPr });
    const { allowed, elsewhere } = deriveAllowed({ role, lifecycle, delivery, worktree });
    emit({
      status: "ok",
      role,
      hosted,
      worktree,
      worktrees: classified,
      companion,
      workspace: describeWorkspace(worktree, sessionWorktreesDir),
      delivery,
      pr,
      companionPr,
      lifecycle,
      allowed,
      elsewhere,
      warnings: [...(hostedReason ? [hostedReason] : []), ...anchor.warnings, ...prWarnings, ...companionPrWarnings, ...warnings],
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
    const { role, worktree, reason: hostedReason } = deriveRole({ cwd: startDir, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
    const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config, companionWorktreesDir, companionWorktrees: companionWorktrees() });
    const roadmaps = allRoadmaps(null, [companionHalfOf(describeCompanion(worktree))]);
    const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps, config });
    const { lifecycle, warnings } = deriveLifecycle({ delivery, pr: null, companionPr: null });
    warnings.unshift(...anchor.warnings);
    if (hostedReason) warnings.unshift(hostedReason);
    const ownerOf = (branch) => findOwner({ worktrees, worktreesDir: sessionWorktreesDir, branch, config });

    const toCandidate = (record, sourceKind, layout = checkoutLayout()) => {
      const fresh = reviewFreshness(record.branch, record.dir, layout.agit);
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
        artifactPr: record.artifactPr,
        owner: ownerOf(record.branch),
        reviewFresh: fresh.reviewFresh,
        source: sourceKind,
        ref: fresh.ref,
        layout: layout.layout,
        artifactsRoot: layout.artifactsRoot,
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
        if (found) add(toCandidate(found.record, found.source, found.layout));
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
        if (resolved) add(toCandidate(resolved.record, resolved.source, resolved.layout));
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
    if (result.next) {
      result.next.target = resolveNextTarget({
        next: result.next,
        worktrees: classified,
        primaryPath: worktrees[0]?.path ?? root,
        branch: target?.branch ?? delivery?.branch ?? null,
        workspaceFor: (w) => describeWorkspace(w, sessionWorktreesDir),
      });
    }
    emit(
      {
        status: result.status,
        role,
        lifecycle,
        slug: target?.slug ?? requestedSlug ?? null,
        type: target?.type ?? null,
        artifactPr: target?.artifactPr ?? null,
        layout: target ? (target.layout ?? "checkout") : null,
        artifactsRoot: target ? (target.artifactsRoot ?? artifactsRoot) : null,
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

  case "migrate": {
    // Filesystem work only: the caller stages, commits, and pushes both sides so
    // the delivery guard keeps governing every write to git.
    if (!rest[0]) usage("migrate takes the companion checkout to move the artifact roots into: migrate <companion-checkout> [--apply]");
    const destination = path.resolve(process.cwd(), rest[0]);
    const destTop = git(destination, "rev-parse", "--show-toplevel");
    const fail = (reason, message, extra = {}) => emit({ status: "error", reason, source: root, destination, message, ...extra, root, configSource: source }, 3);
    if (!destTop || !samePath(destTop, destination)) fail("not-a-checkout", `${destination} is not the toplevel of a git checkout; pass the companion clone or one of its worktrees.`);
    const clone = parseWorktreeList(git(destination, "worktree", "list", "--porcelain"))[0]?.path ?? destination;
    const primaryRoot = parseWorktreeList(git(root, "worktree", "list", "--porcelain"))[0]?.path ?? root;
    if (samePath(clone, primaryRoot) || !samePath(path.dirname(clone), path.dirname(primaryRoot))) {
      fail("not-sibling", `${clone} must be a sibling checkout of the primary ${primaryRoot} (the companion is resolved as ../<name> from there).`, { clone, primary: primaryRoot });
    }
    const name = path.basename(clone);
    const repo = config.artifacts.repo ?? {};
    const configSet = repo.name != null || repo.dir != null;
    const sourceRoots = describeRoots(root);
    const base = { source: root, destination, clone, name, configSet };
    const movable = ROOT_KEYS.some((key) => holdsArtifacts(path.join(root, config.artifacts[key])));
    if (!movable) emit({ status: "ok", mode: "nothing-to-migrate", ...base, roots: sourceRoots, root, configSource: source });
    const conflicts = [];
    for (const key of ROOT_KEYS) {
      const rel = config.artifacts[key];
      for (const file of listFiles(path.join(root, rel))) {
        const target = path.join(destination, rel, file.rel);
        if (path.basename(target) !== ".gitkeep" && fs.existsSync(target)) conflicts.push(path.posix.join(rel, file.rel));
      }
    }
    const records = recordsUnder(root);
    if (conflicts.length) emit({ status: "conflict", mode: options.apply ? "apply" : "dry-run", ...base, roots: sourceRoots, conflicts, records, message: `${conflicts.length} file(s) already exist under ${destination} and would be overwritten; nothing was written.`, root, configSource: source }, 3);
    if (!options.apply) emit({ status: "ok", mode: "dry-run", ...base, roots: sourceRoots, conflicts, records, root, configSource: source });
    const moved = [];
    for (const key of ROOT_KEYS) {
      const rel = config.artifacts[key];
      const src = path.join(root, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(destination, rel), { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      moved.push(rel);
    }
    const configWritten = writeCompanionName(name);
    const readmeNoteAdded = appendMigrationNote(destination, productName(primaryRoot));
    const after = recordsUnder(destination);
    const diff = recordsDiff(records, after);
    emit({
      status: "ok",
      mode: "applied",
      ...base,
      configSet: true,
      roots: describeRoots(destination),
      moved,
      configWritten,
      readmeNoteAdded,
      records: { ...after, identical: diff.length === 0, diff },
      root,
      configSource: source,
    });
    break;
  }

  default:
    usage(command ? `unknown command ${command}` : "missing command");
}
