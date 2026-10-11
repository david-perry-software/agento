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
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug> [--pr]   (+ ownerTree { tracked, untracked, ahead } and companionTree { tracked, untracked }, null when absent; --pr adds pr + companionPr + warnings; companion PR gaps join companionGaps)
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>   (+ worktreeState { onDisk, registeredIn, origin, expectedOrigin, ok }; + companion half and .code-workspace in companion mode, with companion.state likewise)
//   node scripts/agento.mjs workspace <feature|issue|plan|freehand> <slug|session-id> [--write]   (pair workspace file status; write the canonical document with --write)
//   node scripts/agento.mjs start-session [<feature|issue>/<slug> | <session-id>] [--resume] [--no-open]   (window check, doctor, fetch, worktree pair, post-add check, workspace file, code --new-window)
//   node scripts/agento.mjs close-session <feature|issue>/<slug> | changes/<slug> | <session-id> [--dry-run] [--ignore-occupants]   (window check, fetch --prune, close decision, clean/pushed checks, occupant gate, remove pair + workspace file, delete merged local branches)
//   node scripts/agento.mjs ship <feature|issue> <slug> [--confirm <token>] [--wait N]   (audit → --confirm → ready, checks, merge, companion merge, sync, release wait, teardown, epilogue; resumes from git + GitHub state; exit 0 ok, 2 pending, 3 rejected/blocked/failed)
//   node scripts/agento.mjs initiative [<slug>]
//   node scripts/agento.mjs metrics [<slug>]           (phase durations, review rounds, pauses, merge date, post-ship latency from git history; + aggregate medians)
//   node scripts/agento.mjs session [--pr]             (role, worktree, worktrees, companion, workspace, delivery, lifecycle, allowed; hosted flag; --pr adds pr + companionPr)
//   node scripts/agento.mjs next [<slug>]              (the one legal transition: command, args, window, target { path, workspace }, dispatch paths)
//   node scripts/agento.mjs doctor [--for <command>]   (environment checks: ok | warn | fail, with fallbacks)
//   node scripts/agento.mjs dashboard [--pr] [--plugin-root <dir>]   (session, doctor, deliveries (= status), initiatives { list, details }, metrics and timings in one document; a failing section is { status: "error", message })
//   node scripts/agento.mjs migrate <companion-checkout> [--apply]   (move in-repo artifact roots into the companion; dry run without --apply)
//   node scripts/agento.mjs models [list | pins | show <name> | apply <name> | clear | init] [--plugin-root <dir>]   (pin agent/prompt model: lines from ~/.config/agento/model-profiles.json)
//   node scripts/agento.mjs release <merge-sha> [--wait N] [--interval N]   (deploy-wait verdict for checks.releaseWorkflow; exit 0 done, 2 pending/dispatch-required, 3 gh/auth, 4 failed/no-run)
//
// Options: --root <dir> (default: the git toplevel of the cwd; a companion clone or
// companion half re-anchors on its product checkout).

import { execFile, execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadAgentoConfig, parseConfigText, resolveArtifactsRoot } from "./agento-config.mjs";
import {
  closeBuildSessionDecision,
  evaluateShipPreflight,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";
import { aggregateMetrics, deriveMetrics, parseArtifactLog, parseMergeLog } from "./delivery-metrics.mjs";
import { AGENT_ALIASES, byokTierWarning, detectActive, differsBeyondModel, errorsFor, frontmatterField, handoffTargets, parseModelValue, parseProfiles, profilesFile, readModel, resolveTargets, setHandoffModels, setModel, unqualifiedWarning } from "./model-profiles.mjs";
import { GRACE_SECONDS, parseWorkflowTriggers, releaseVerdict as deriveReleaseVerdict } from "./release-state.mjs";
import { classifyFetchFailure, classifyWorktrees, companionWarning, deriveAllowed, deriveDelivery, deriveLifecycle, deriveNext, deriveRole, findOwner, halfState, LIFECYCLES, nextSessionId, pairFor, parseWorktreeList, resolveNextTarget, sessionWorkspaceDocument, splitPorcelain } from "./session-state.mjs";
import { defaultCodeStatus, findOccupants } from "./worktree-occupants.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30);
  emit({ status: "usage-error", message, usage: lines.map((l) => l.replace(/^\/\/ ?/, "")) }, 1);
}

function emit(result, code = 0) {
  // Piped stdout is async on POSIX; process.exit() would truncate output beyond the 64 KB pipe buffer.
  const buffer = Buffer.from(JSON.stringify(result, null, 2) + "\n");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
    }
  }
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
    else if (arg === "--write") options.write = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--ignore-occupants") options.ignoreOccupants = true;
    else if (arg === "--confirm") {
      options.confirm = argv[++i];
      if (!options.confirm || options.confirm.startsWith("--")) usage("--confirm takes the confirmToken reported by the audit");
    }
    else if (arg === "--plugin-root") {
      options.pluginRoot = argv[++i];
      if (!options.pluginRoot) usage("--plugin-root takes a directory");
    }
    else if (arg === "--for") {
      options.for = argv[++i];
      if (!options.for || !/^[a-z0-9-]+$/.test(options.for)) usage(`--for takes a command name matching [a-z0-9-]+, got ${JSON.stringify(options.for ?? "")}`);
    } else if (arg === "--wait" || arg === "--interval") {
      const value = argv[++i];
      const [min, max] = arg === "--wait" ? [0, 60] : [1, 60];
      if (!/^\d+$/.test(value ?? "") || Number(value) < min || Number(value) > max) usage(`${arg} takes an integer from ${min} to ${max} seconds, got ${JSON.stringify(value ?? "")}`);
      options[arg.slice(2)] = Number(value);
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

// anchorRoot's own worktree listing, reused as the product list when it anchors on that same dir.
let anchorListing = null;

// A cwd inside a companion clone or a companion half (`<clone>-worktrees/<kind>-<id>`)
// has no artifacts.repo of its own. Re-anchor on the product checkout: the sibling
// git checkout of the clone whose config resolves artifacts.dir to that clone — and,
// for a half, the product half of the same name when it exists. Zero matches keep
// today's behaviour silently (an in-repo project's own managed worktree looks the
// same); several matches keep it too and warn.
function anchorRoot(dir) {
  if (hasCompanionConfig(dir)) return { root: dir, warnings: [], fromClone: false };
  anchorListing = { dir, text: git(dir, "worktree", "list", "--porcelain") };
  const ownList = parseWorktreeList(anchorListing.text);
  const clone = ownList[0]?.path ?? dir;
  if (!samePath(clone, dir) && hasCompanionConfig(clone)) return { root: dir, warnings: [], fromClone: false };
  const halfName = path.basename(dir);
  const looksLikeHalf = !samePath(clone, dir) && MANAGED_HALF.test(halfName) && path.basename(path.dirname(dir)) === `${path.basename(clone)}-worktrees`;
  const parent = path.dirname(clone);
  let siblings;
  try {
    siblings = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return { root: dir, warnings: [], fromClone: false };
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
    return {
      root: anchored,
      warnings: [`anchored-from-companion: ${dir} is a companion checkout of ${product}; the record describes ${anchored}`],
      fromClone: samePath(clone, dir) && !looksLikeHalf,
    };
  }
  if (matches.length > 1) return { root: dir, warnings: [`companion-anchor: ${matches.length} sibling checkouts name ${clone} as their artifacts.repo (${matches.join(", ")}); keep one product per companion`], fromClone: false };
  return { root: dir, warnings: [], fromClone: false };
}

const anchor = anchorRoot(toplevel);
const root = anchor.root;

// The product clone's `git worktree list --porcelain`, read at most once per process;
// `fresh` re-reads it after this process itself has added a worktree.
let productWorktreeCache = anchorListing?.dir === root ? anchorListing.text : null;
function productWorktreeText({ fresh = false } = {}) {
  if (fresh || productWorktreeCache === null) productWorktreeCache = git(root, "worktree", "list", "--porcelain");
  return productWorktreeCache;
}
const productWorktrees = ({ fresh = false } = {}) => parseWorktreeList(productWorktreeText({ fresh }));
const worktreesDirByPrimary = new Map();
const roleCwd = anchor.fromClone ? root : startDir;
const { config, source } = loadAgentoConfig(root);
const repoName = path.basename(root);
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
  const primaryRoot = productWorktrees()[0]?.path ?? root;
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
  const primaryRoot = productWorktrees()[0]?.path ?? root;
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

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])]));
  }
  return value;
}

function workspaceDocumentCurrent(file, expected) {
  if (!fs.existsSync(file)) return false;
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8"));
    return JSON.stringify(canonicalizeJson(current)) === JSON.stringify(canonicalizeJson(expected));
  } catch {
    return false;
  }
}

function managedWorktreePath(worktrees, kind, id, worktreesBaseDir) {
  const name = `${kind}-${id}`;
  const direct = worktrees.find((w) => path.basename(w.path) === name && samePath(path.dirname(w.path), worktreesBaseDir));
  if (direct) return direct.path;
  const fallback = worktrees.find((w) => path.basename(w.path) === name);
  return fallback?.path ?? path.join(worktreesBaseDir, name);
}

function resolveSessionPaths(kind, id, layoutOverride = null) {
  const prefixes = { feature: config.branches.feature, issue: config.branches.issue, freehand: config.branches.freehand };
  const artifactRel = kind === "feature" ? config.artifacts.features : kind === "issue" ? config.artifacts.issues : null;
  const branch = kind === "plan" ? null : `${prefixes[kind]}${id}`;
  // Deliveries are branch-aware: an in-repo checkout whose delivery branch flips to
  // a companion reports that companion's roots and pair (plan/freehand unchanged).
  const branchLayout = !layoutOverride && artifactRel !== null && !artifacts.external ? layoutFor(branch) : null;
  const layout = layoutOverride ?? (branchLayout && !branchLayout.absent ? branchLayout : checkoutLayout());
  const productList = productWorktrees();
  const worktree = managedWorktreePath(productList, kind, id, primaryWorktreesDir(productList));
  const companion = layout.artifacts.external
    ? {
        worktreesDir: layout.companionWorktreesDir,
        worktree: managedWorktreePath(layout.companionWorktrees, kind, id, layout.companionWorktreesDir),
        branch,
      }
    : null;
  const workspace = layout.artifacts.external ? path.join(path.dirname(worktree), `${kind}-${id}.code-workspace`) : null;
  return { kind, id, branch, artifactRel, layout, worktree, companion, workspace, productWorktrees: productList };
}

const originOf = (dir) => git(dir, "remote", "get-url", "origin") || null;

// The pair's `.code-workspace` document for a resolved session (companion mode);
// with `write`, written when missing or stale.
function writeSessionWorkspace(resolved, { write = true } = {}) {
  const autoApprove = resolved.layout.config.worktrees?.autoApprove !== false;
  const document = sessionWorkspaceDocument({ product: resolved.worktree, companion: resolved.companion.worktree, autoApprove });
  let exists = fs.existsSync(resolved.workspace);
  let current = exists ? workspaceDocumentCurrent(resolved.workspace, document) : false;
  let written = false;
  if (write && !current) {
    fs.mkdirSync(path.dirname(resolved.workspace), { recursive: true });
    fs.writeFileSync(resolved.workspace, JSON.stringify(document, null, 2) + "\n");
    exists = true;
    current = true;
    written = true;
  }
  return { exists, current, autoApprove, document, written };
}

// The multi-root workspace file a paired session opens (product side, next to the
// product half); null for the primary, unmanaged cwds, and in-repo mode.
function describeWorkspace(worktree, sessionWorktreesDir) {
  if (!artifacts.external || !worktree?.isManaged) return null;
  const file = path.join(sessionWorktreesDir, `${worktree.dirPrefix}-${worktree.id}.code-workspace`);
  const exists = fs.existsSync(file);
  if (!exists) return { path: file, exists, current: null };
  const companion = describeCompanion(worktree);
  const expected = sessionWorkspaceDocument({ product: worktree.path, companion: companion.path, autoApprove: config.worktrees?.autoApprove !== false });
  return { path: file, exists, current: workspaceDocumentCurrent(file, expected) };
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

function companionGapMessage(companion, gaps, type, slug) {
  const behindOnly = gaps.length === 1 && gaps[0] === "behind";
  const fix = behindOnly
    ? `run git -C ${companion.path} merge origin/${companion.branch} (a fast-forward) before closing ${type}/${slug}`
    : `commit and push it (or discard the changes) before closing ${type}/${slug}, or its artifact work is lost`;
  const state = gaps.map((g) => (g === "behind" ? "behind its upstream" : g)).join(" and ");
  return `The companion half at ${companion.path} is ${state}; ${fix}.`;
}

// ship-preflight: a checkout's dirt split into tracked and untracked (non-ignored)
// files, plus `ahead` counted like describeCompanion; null when the directory is missing.
function treeState(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  let porcelain = "";
  try {
    // Not git(): its trim() would eat the leading space of a ` M` status.
    porcelain = execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const upstream = git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  const count = upstream ? git(dir, "rev-list", "--count", "@{upstream}..HEAD") : git(dir, "rev-list", "--count", "HEAD", "--not", "--remotes");
  return { ...splitPorcelain(porcelain), ahead: Number.parseInt(count, 10) || 0 };
}

function ownerTreeOf(owner) {
  if (!owner || owner.role === "primary") return null;
  return treeState(owner.path);
}

function companionTreeOf(companion) {
  if (!companion?.registered) return null;
  const tree = treeState(companion.path);
  return tree && { tracked: tree.tracked, untracked: tree.untracked };
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
  if (!ghVersion().ok) return ghMissingLookup(label);
  try {
    return { pr: JSON.parse(execFileSync("gh", prViewArgs(branch), opts)), warnings: [] };
  } catch (error) {
    return failedLookup(label, branch, error);
  }
}

const prViewArgs = (branch) => ["pr", "view", branch, "--json", "number,state,isDraft,mergeStateStatus,url"];
const ghMissingLookup = (label) => ({ pr: null, warnings: [`${label}: gh CLI not found on PATH; install GitHub CLI to include pull request state`] });

function failedLookup(label, branch, error) {
  const stderr = (error?.stderr ?? "").toString().trim().split("\n")[0] || error?.message || "unknown error";
  return { pr: null, warnings: [`${label}: gh pr view ${branch} failed: ${stderr}`] };
}

const execFileAsync = promisify(execFile);

// execFile with stdin closed, like the synchronous calls' `stdio: ["ignore", …]`.
function execAsync(cmd, args, opts) {
  const pending = execFileAsync(cmd, args, { encoding: "utf8", ...opts });
  pending.child.stdin?.end();
  return pending;
}

// lookupPullRequest's exact result, without blocking the process.
async function lookupPullRequestAsync(branch, { cwd = root, label = "pr" } = {}) {
  if (!branch) return lookupPullRequest(branch, { cwd, label });
  if (!(await probeAsync("gh", ["--version"])).ok) return ghMissingLookup(label);
  try {
    const { stdout } = await execAsync("gh", prViewArgs(branch), { cwd, timeout: 15000 });
    return { pr: JSON.parse(stdout), warnings: [] };
  } catch (error) {
    return failedLookup(label, branch, error);
  }
}

// Runs the thunks with at most `limit` in flight; results keep the input order.
async function runPool(tasks, limit = 4) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const lookupKey = (cwd, branch) => `${cwd}\0${branch}`;

// Prefetch: the deduplicated `{ cwd, branch, label }` PR lookups and the doctor's
// external probes (into the probe cache), through one pool. `gh --version` goes first
// so the lookups waiting on it never hold the pool's slots, then the lookups (network
// round-trips of up to a second each), then the probes. Returns the lookups keyed by
// cwd + branch.
async function lookupPullRequests(requests, { probes = [] } = {}) {
  const unique = new Map();
  for (const request of requests) {
    const cwd = request.cwd ?? root;
    if (request.branch && !unique.has(lookupKey(cwd, request.branch))) unique.set(lookupKey(cwd, request.branch), { ...request, cwd });
  }
  const results = new Map();
  const ghFirst = unique.size ? [["gh", ["--version"]]] : [];
  const probeTask = ([cmd, args]) => () => probeAsync(cmd, args);
  const lookupTasks = [...unique].map(([key, { branch, cwd, label }]) => async () => results.set(key, await lookupPullRequestAsync(branch, { cwd, label })));
  await runPool([...ghFirst.map(probeTask), ...lookupTasks, ...probes.map(probeTask)]);
  return results;
}

// A lookupPullRequest-compatible function answering from `lookupPullRequests` results.
const prefetchedLookup = (results) => (branch, opts = {}) => results.get(lookupKey(opts.cwd ?? root, branch)) ?? lookupPullRequest(branch, opts);

// The mirrored artifact PR: the same branch name looked up in the companion clone
// the layout names. In-repo layout → null with no gh call, so today's output is unchanged.
function lookupCompanionPullRequest(branch, layout = checkoutLayout(), lookup = lookupPullRequest) {
  if (!layout.artifacts.external) return { pr: null, warnings: [] };
  return lookup(branch, { cwd: layout.artifactsRoot, label: "companionPr" });
}

// worktrees.dir is relative to the primary checkout; resolving it against a
// secondary worktree's own basename would name the wrong sibling directory.
function primaryWorktreesDir(worktrees = productWorktrees()) {
  const primaryRoot = worktrees[0]?.path ?? root;
  if (!worktreesDirByPrimary.has(primaryRoot)) {
    const primaryConfig = primaryRoot === root ? config : loadAgentoConfig(primaryRoot).config;
    worktreesDirByPrimary.set(primaryRoot, path.resolve(primaryRoot, primaryConfig.worktrees.dir));
  }
  return worktreesDirByPrimary.get(primaryRoot);
}

// The `session` record: role, worktree, worktrees, companion, workspace, delivery,
// lifecycle, allowed/elsewhere, warnings; `pr` adds the PR lookups (`lookup`: a
// lookupPullRequest-compatible function, e.g. one answering from prefetched results).
// `context` is sessionContext(), passed in when the caller needed `prBranch` first.
function sessionRecord({ pr: withPr = false, lookup = lookupPullRequest } = {}, context = sessionContext()) {
  const { worktrees, sessionWorktreesDir, role, worktree, hosted, hostedReason, classified, companion, delivery, prBranch } = context;
  const { pr, warnings: prWarnings } = withPr ? lookup(prBranch) : { pr: null, warnings: [] };
  const { pr: companionPr, warnings: companionPrWarnings } = withPr ? lookupCompanionPullRequest(prBranch, undefined, lookup) : { pr: null, warnings: [] };
  const { lifecycle, warnings } = deriveLifecycle({ delivery, pr, companionPr });
  const { allowed, elsewhere } = deriveAllowed({ role, lifecycle, delivery, worktree });
  const unregistered = companionWarning({ pair: companion, onDisk: Boolean(companion) && fs.existsSync(companion.path), productWorktrees: worktrees, companionClone: artifacts.dir, productRoot: worktrees[0]?.path ?? root });
  return {
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
    warnings: [...(hostedReason ? [hostedReason] : []), ...anchor.warnings, ...prWarnings, ...companionPrWarnings, ...warnings, ...(unregistered ? [unregistered] : [])],
    root,
    configSource: source,
  };
}

// Everything the session record derives before its PR lookups, including the branch they use.
function sessionContext() {
  // roleCwd: a subdirectory inside a worktree resolves to that worktree's entry; the companion clone resolves to the anchored product primary.
  const worktrees = productWorktrees();
  const sessionWorktreesDir = primaryWorktreesDir(worktrees);
  const { role, worktree, hosted, reason: hostedReason } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
  const classified = classifyWorktrees({ worktrees, worktreesDir: sessionWorktreesDir, config, companionWorktreesDir, companionWorktrees: companionWorktrees() });
  const companion = describeCompanion(worktree);
  const delivery = deriveDelivery({ branch: worktree.branch, dirPrefix: worktree.dirPrefix, id: worktree.id, roadmaps: allRoadmaps(null, [companionHalfOf(companion)]), config });
  return { worktrees, sessionWorktreesDir, role, worktree, hosted, hostedReason, classified, companion, delivery, prBranch: delivery?.branch ?? worktree.branch };
}

// --- doctor ----------------------------------------------------------------

const probeCache = new Map();
const probeKey = (cmd, args) => [cmd, ...args].join("\0");
const probeOptions = () => ({ cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function probeFailure(cmd, error) {
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

// Every probe is bounded and never throws: a missing binary, a nonzero exit, and a
// timeout all become a result the caller maps to ok | warn | fail. Each command +
// arguments runs at most once per process (probeAsync may have run it already).
function probe(cmd, args) {
  const key = probeKey(cmd, args);
  if (!probeCache.has(key)) {
    try {
      probeCache.set(key, { ok: true, out: execFileSync(cmd, args, { ...probeOptions(), stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0] ?? "" });
    } catch (error) {
      probeCache.set(key, probeFailure(cmd, error));
    }
  }
  return probeCache.get(key);
}

const probesInFlight = new Map();

// probe() without blocking the process; concurrent callers share one run.
function probeAsync(cmd, args) {
  const key = probeKey(cmd, args);
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key));
  if (!probesInFlight.has(key)) {
    probesInFlight.set(
      key,
      execAsync(cmd, args, probeOptions()).then(
        ({ stdout }) => ({ ok: true, out: stdout.trim().split("\n")[0] ?? "" }),
        (error) => probeFailure(cmd, error),
      ).then((result) => {
        probeCache.set(key, result);
        return result;
      }),
    );
  }
  return probesInFlight.get(key);
}

const ghVersion = () => probe("gh", ["--version"]);
const lsRemoteArgs = () => ["-C", root, "ls-remote", "--exit-code", "--heads", "origin", config.branches.default];

// The external commands DOCTOR_CHECKS probe, so `dashboard` can run them concurrently first.
const doctorProbes = () => [["gh", ["--version"]], ["gh", ["auth", "status"]], ["git", lsRemoteArgs()], ["code", ["--version"]]];

const DOCTOR_CHECKS = {
  node() {
    const version = process.versions.node;
    const major = Number.parseInt(version.split(".")[0], 10);
    return major >= 20
      ? { status: "ok", detail: `node v${version}`, fallback: null }
      : { status: "fail", detail: `node v${version} is below the required 20`, fallback: "install Node >= 20 (AGENTS.md); the Agento CLI, both hooks (delivery guard and SessionStart context), and the tests need it" };
  },
  "git-remote"() {
    const url = git(root, "remote", "get-url", "origin");
    if (!url) return { status: "fail", detail: "no `origin` remote", fallback: "add the remote (`git remote add origin <url>`) or work in a clone; push and PR steps need origin" };
    const reach = probe("git", lsRemoteArgs());
    return reach.ok
      ? { status: "ok", detail: `origin ${url}, ${config.branches.default} reachable`, fallback: null }
      : { status: "warn", detail: `origin ${url} unreachable: ${reach.detail}`, fallback: "work offline; fetch, push, and PR steps will fail until the network is back — retry them before ending the turn" };
  },
  gh() {
    const version = ghVersion();
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
  "worktrees-dir"() {
    const dir = primaryWorktreesDir();
    let existing = dir;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    try {
      fs.accessSync(existing, fs.constants.W_OK);
      return { status: "ok", detail: existing === dir ? `${dir} writable` : `${dir} absent; ${existing} writable, it will be created`, fallback: null };
    } catch {
      return { status: "fail", detail: `${dir} not writable (${existing} denies write)`, fallback: "create the directory with write permission or change worktrees.dir in .github/agento.json" };
    }
  },
  "session-workspace"() {
    const worktrees = productWorktrees();
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { worktree } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
    const workspace = describeWorkspace(worktree, sessionWorktreesDir);
    if (!workspace) return { status: "ok", detail: "not a managed pair", fallback: null };
    if (workspace.current) return { status: "ok", detail: `${workspace.path} carries the session auto-approve settings`, fallback: null };
    return {
      status: "warn",
      detail: `${workspace.path} lacks the session auto-approve settings`,
      fallback: `run node ${path.join(PLUGIN_ROOT, "scripts", "agento.mjs")} workspace ${worktree.dirPrefix} ${worktree.id} --write, then Developer: Reload Window`,
    };
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
    const primaryRoot = productWorktrees()[0]?.path ?? root;
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
  // Not in CAPABILITY_CHECKS: informational, so `doctor --for` never runs it.
  "model-profile"() {
    const pluginRoot = path.resolve(options.pluginRoot ?? PLUGIN_ROOT);
    if (!fs.existsSync(path.join(pluginRoot, ".github", "agents"))) return { status: "ok", detail: `no Agento plugin clone at ${pluginRoot}`, fallback: null };
    const loaded = loadProfiles();
    const cli = `agento.mjs models --plugin-root ${pluginRoot}`;
    if (loaded.errors.length) {
      return { status: "warn", detail: `${loaded.profilesFile.path} has ${loaded.errors.length} error(s), first: ${loaded.errors[0]}`, fallback: `fix the file (\`${cli}\` lists every error) or delete it; Agento runs fine without profiles` };
    }
    const { active } = modelsState(pluginRoot, loaded);
    if (active === null) return { status: "ok", detail: `no profile applied to ${pluginRoot}`, fallback: null };
    if (active !== "custom") {
      const pins = modelsPins(pluginRoot);
      const warns = pinWarnings(pins);
      if (warns.byok || warns.unqualified) {
        const fallbacks = [
          warns.byok && `pin autopilot at least as high as the highest-tier model it delegates to, then \`agento.mjs models apply <name> --plugin-root ${pluginRoot}\``,
          warns.unqualified && `qualify each named value as "<picker name> (<vendor>)" in ${loaded.profilesFile.path}, then \`agento.mjs models apply ${active} --plugin-root ${pluginRoot}\``,
        ];
        return { status: "warn", detail: [warns.byok, warns.unqualified].filter(Boolean).join("; "), fallback: fallbacks.filter(Boolean).join("; ") };
      }
      return { status: "ok", detail: `${active} applied to ${pluginRoot}`, fallback: null };
    }
    return {
      status: "warn",
      detail: `model: lines in ${pluginRoot} match no profile in ${loaded.profilesFile.path} (hand-edited, or the profile changed after it was applied)`,
      fallback: `re-pin with \`agento.mjs models apply <name> --plugin-root ${pluginRoot}\` or unpin with \`agento.mjs models clear --plugin-root ${pluginRoot}\`; before a git pull that touches pinned files: clear, then git pull, then apply`,
    };
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
  terminal: ["node", "worktrees-dir", "artifact-repo", "session-workspace"],
  "ask-questions": [],
  browser: [],
  gh: ["gh"],
  code: ["code"],
  network: ["git-remote"],
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
  models: ["terminal"],
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

// Each check runs at most once per process, so `dashboard` can run the local ones early.
const doctorResults = new Map();

function runDoctor(ids) {
  const checks = ids.map((id) => {
    if (!doctorResults.has(id)) {
      try {
        doctorResults.set(id, { id, ...DOCTOR_CHECKS[id]() });
      } catch (error) {
        doctorResults.set(id, { id, status: "fail", detail: `check threw: ${error?.message ?? error}`, fallback: "report this as an Agento bug; run the probe by hand" });
      }
    }
    return doctorResults.get(id);
  });
  const status = checks.reduce((worst, c) => (STATUS_RANK[c.status] > STATUS_RANK[worst] ? c.status : worst), "ok");
  return { status, checks };
}

// The checks that run no external probe (doctorProbes) and so need no network.
const LOCAL_DOCTOR_CHECKS = ["node", "worktrees-dir", "session-workspace", "artifact-repo", "model-profile"];

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

// --- start-session ---------------------------------------------------------

const SESSION_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

function startSessionArgs() {
  if (rest.length > 1) usage(`start-session takes at most one argument (<feature|issue>/<slug> or a session id), got ${JSON.stringify(rest.join(" "))}`);
  const arg = rest[0] ?? null;
  const build = arg?.match(/^(feature|issue)\/(.*)$/);
  if (build) return { mode: "build", type: build[1], slug: requireSlug(build[2]), subject: `${build[1]}/${build[2]}` };
  if (arg === null) {
    if (options.resume) usage("start-session --resume needs a session id or <feature|issue>/<slug>");
    return { mode: "plan", id: null };
  }
  if (!SESSION_ID.test(arg)) usage(`start-session takes <feature|issue>/<slug> or a session id matching [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(arg)}`);
  return { mode: "plan", id: arg };
}

// A bounded, prompt-free git call that reports stderr instead of swallowing it.
function gitRun(dir, args, timeout = 30000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  try {
    const stdout = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env });
    return { ok: true, stdout: stdout.trim(), stderr: "", timedOut: false };
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT" || Boolean(error?.signal && !error?.status);
    const stderr = (error?.stderr ?? "").toString().trim();
    return { ok: false, stdout: (error?.stdout ?? "").toString().trim(), stderr: timedOut ? `git ${args[0]} timed out after ${timeout / 1000} s` : stderr || error?.message || "unknown error", timedOut };
  }
}

// The same shape for gh: stdin closed, stderr captured, never a prompt.
function ghRun(cwd, args, timeout = 30000) {
  try {
    const stdout = execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } });
    return { ok: true, stdout: stdout.trim(), stderr: "", timedOut: false, missing: false };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    const timedOut = error?.code === "ETIMEDOUT" || Boolean(error?.signal && !error?.status);
    const stderr = (error?.stderr ?? "").toString().trim();
    const message = missing ? "gh CLI not found on PATH" : timedOut ? `gh ${args[0]} timed out after ${timeout / 1000} s` : stderr || error?.message || "unknown error";
    return { ok: false, stdout: (error?.stdout ?? "").toString().trim(), stderr: message, timedOut, missing };
  }
}

function reauthFor(url) {
  if (/^https:\/\/github\.com\//.test(url ?? "")) return "gh auth login";
  return `re-authenticate the credentials for ${url ?? "origin"} (credential helper or SSH key)`;
}

function capabilityOf(checkId) {
  return Object.entries(CAPABILITY_CHECKS).find(([, ids]) => ids.includes(checkId))?.[0] ?? checkId;
}

// Ids already used by a managed plan session in either clone (path on disk,
// registered worktree, or workspace file), so a generated id never collides.
function takenPlanIds(dirs, lists) {
  const ids = new Set();
  const add = (name) => {
    const match = name.match(/^plan-(.+?)(\.code-workspace)?$/);
    if (match) ids.add(match[1]);
  };
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) add(name);
  }
  for (const list of lists) for (const w of list) add(path.basename(w.path));
  return ids;
}

const registeredAt = (list, p) => list.find((w) => samePath(w.path, p)) ?? null;

function startSession() {
  const args = startSessionArgs();
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const out = {
    status: "ok",
    mode: args.mode,
    subject: args.mode === "build" ? args.subject : args.id,
    outcome: null,
    product: null,
    companion: null,
    workspace: null,
    target: null,
    opened: false,
    openCommand: null,
    next: [],
    preflight: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, result.status === "ok" ? 0 : 3);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });

  // Window check (§11): the primary checkout, on the default branch, clean.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);
  if (worktree.branch !== config.branches.default) reject(`primary checkout not on ${config.branches.default} (${where})`);
  if (git(primary, "status", "--porcelain") !== "") reject(`primary checkout is dirty (${worktree.path}); commit, stash, or discard its changes first`);

  // Capability preflight (§10): fail rejects, warn proceeds with the fallback.
  const doctor = runDoctor(checksFor(COMMAND_NEEDS["start-session"]));
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) reject(failed.detail, { capability: capabilityOf(failed.id), check: failed.id, fallback: failed.fallback });
  out.preflight = doctor.checks.filter((c) => c.status === "warn").map(({ id, status, detail, fallback }) => ({ id, capability: capabilityOf(id), status, detail, fallback }));

  const fetch = (dir, label) => {
    const result = gitRun(dir, ["fetch", "origin"]);
    if (result.ok) return;
    const url = originOf(dir);
    if (!result.timedOut && classifyFetchFailure(result.stderr) === "auth") {
      fail("fetch-auth", `git -C ${dir} fetch origin: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(url) });
    }
    out.warnings.push(`fetch: ${label} ${url ?? "origin"} not fetched (${result.stderr.split("\n")[0]}); continuing from local refs`);
  };
  fetch(primary, "product");

  // Which halves this session uses, before anything is written.
  let resolved;
  let productBranch = null;
  if (args.mode === "plan") {
    const productList = productWorktrees();
    const id = args.id ?? nextSessionId({ now: new Date(), taken: takenPlanIds([primaryWorktreesDir(productList), companionWorktreesDir], [productList, companionWorktrees()]) });
    out.subject = id;
    resolved = resolveSessionPaths("plan", id, checkoutLayout());
    out.next = ["/agento new-feature <description>", "/agento new-issue <description>"];
  } else {
    const { type, slug } = args;
    const { result, layout } = resolveWithLayout(type, slug);
    if (result.status !== "ok") reject(result.message, { resolution: result.status });
    const content = result.source === "local" ? fs.readFileSync(result.path, "utf8") : layout.agit("show", `origin/${result.branch}:${result.path}`);
    if (header(content, "status") === "complete") reject(`${type}/${slug} is complete (status: complete); no build session is needed`);
    productBranch = result.branch;
    const productList = productWorktrees();
    // The window check already keeps the primary on the default branch, so an owner here is managed.
    const owner = findOwner({ worktrees: productList, worktreesDir: primaryWorktreesDir(productList), branch: productBranch, config });
    resolved = owner ? resolveSessionPaths(owner.dirPrefix, owner.id, layout) : resolveSessionPaths(type, slug, layout);
    if (!owner && !registeredAt(productList, resolved.worktree)) {
      const local = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${productBranch}`);
      const remote = git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${productBranch}`);
      if (!local && !remote) reject(`${productBranch} exists neither locally nor on origin; the delivery planner must publish it`);
    }
    out.next = [`/agento build-${type} ${slug}`];
  }

  const companionClone = resolved.companion ? resolved.layout.artifactsRoot : null;
  if (companionClone) fetch(companionClone, "companion");
  const defaultRef = `origin/${config.branches.default}`;
  const companionDefault = `origin/${resolved.layout.config.branches.default}`;

  // Product half: reuse when registered, never touch an unregistered path on disk.
  const productList = productWorktrees();
  if (registeredAt(productList, resolved.worktree)) out.outcome = "resumed";
  else if (!fs.existsSync(resolved.worktree)) {
    let addArgs;
    if (args.mode === "plan") addArgs = ["worktree", "add", "--detach", resolved.worktree, defaultRef];
    else if (git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${productBranch}`)) addArgs = ["worktree", "add", resolved.worktree, productBranch];
    else addArgs = ["worktree", "add", "--track", "-b", productBranch, resolved.worktree, `origin/${productBranch}`];
    const add = gitRun(primary, addArgs, 120000);
    if (!add.ok) fail("worktree-add", `git -C ${primary} ${addArgs.join(" ")}: ${add.stderr}`, { half: "product" });
    if (args.mode === "plan" && git(resolved.worktree, "rev-parse", "HEAD") !== git(root, "rev-parse", defaultRef)) {
      fail("worktree-add", `${resolved.worktree} is not detached at ${defaultRef}`, { half: "product" });
    }
    out.outcome = "created";
  } else out.outcome = "resumed";

  // Companion half: same name, same branch (build) or detached at its default (plan).
  if (resolved.companion) {
    const half = resolved.companion.worktree;
    const list = parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain"));
    if (!registeredAt(list, half) && !fs.existsSync(half)) {
      const branch = args.mode === "build" ? productBranch : null;
      let addArgs;
      if (!branch) addArgs = ["worktree", "add", "--detach", half, companionDefault];
      else if (git(companionClone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) addArgs = ["worktree", "add", half, branch];
      else if (git(companionClone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) addArgs = ["worktree", "add", "--track", "-b", branch, half, `origin/${branch}`];
      else {
        addArgs = ["worktree", "add", "--no-track", "-b", branch, half, companionDefault];
        out.warnings.push(`companion-branch: ${branch} did not exist in ${companionClone}; created from ${companionDefault} without upstream — publish it with git -C ${half} push -u origin ${branch}`);
      }
      const add = gitRun(companionClone, addArgs, 120000);
      if (!add.ok) fail("worktree-add", `git -C ${companionClone} ${addArgs.join(" ")}: ${add.stderr}`, { half: "companion" });
    }
  }

  // Post-add check on both halves, created or reused: right clone, right origin.
  const freshProduct = productWorktrees({ fresh: true });
  const freshCompanion = companionClone ? parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain")) : [];
  const describeHalf = (halfPath, own, clone) => {
    const onDisk = fs.existsSync(halfPath);
    const state = halfState({ path: halfPath, own, worktrees: freshProduct, companionWorktrees: freshCompanion, origin: onDisk ? originOf(halfPath) : null, expectedOrigin: originOf(clone), onDisk });
    const entry = registeredAt(own === "product" ? freshProduct : freshCompanion, halfPath);
    return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, state };
  };
  out.product = describeHalf(resolved.worktree, "product", root);
  out.companion = resolved.companion ? describeHalf(resolved.companion.worktree, "companion", companionClone) : null;
  for (const [half, described] of [["product", out.product], ["companion", out.companion]]) {
    if (!described || described.state.ok) continue;
    const { registeredIn, origin, expectedOrigin } = described.state;
    const clone = registeredIn === "product" ? primary : registeredIn === "companion" ? companionClone : null;
    const message = registeredIn
      ? `${half} half ${described.path} is registered in the ${registeredIn} clone with origin ${origin ?? "none"} (expected ${expectedOrigin}); nothing was removed`
      : `${half} half ${described.path} exists but is not a registered worktree of either clone; nothing was removed`;
    fail("post-add-check", message, { half, registeredIn, origin, expectedOrigin, fix: clone ? `git -C ${clone} worktree remove ${described.path}` : null });
  }

  if (resolved.companion && resolved.workspace) {
    const { written } = writeSessionWorkspace(resolved);
    out.workspace = { path: resolved.workspace, written };
    out.target = { kind: "workspace", path: resolved.workspace };
  } else out.target = { kind: "folder", path: out.product.path };

  out.openCommand = `code --new-window ${out.target.path}`;
  if (!options.noOpen) {
    try {
      execFileSync("code", ["--new-window", out.target.path], { cwd: root, stdio: "ignore", timeout: 15000 });
      out.opened = true;
    } catch (error) {
      out.warnings.push(`open: ${error?.code === "ENOENT" ? "code CLI not found on PATH" : `code --new-window failed: ${error?.message ?? error}`}; run ${out.openCommand}`);
    }
  }
  finish();
}

// --- close-session ---------------------------------------------------------

function closeSessionArgs() {
  const freehand = config.branches.freehand;
  if (rest.length !== 1) usage(`close-session takes exactly one argument (<feature|issue>/<slug>, ${freehand}<slug>, or a session id), got ${JSON.stringify(rest.join(" "))}`);
  const arg = rest[0];
  const build = arg.match(/^(feature|issue)\/(.*)$/);
  if (build) return { mode: "build", type: build[1], slug: requireSlug(build[2]), subject: arg };
  if (arg.startsWith(freehand)) return { mode: "freehand", slug: requireSlug(arg.slice(freehand.length)), subject: arg };
  if (!SESSION_ID.test(arg)) usage(`close-session takes <feature|issue>/<slug>, ${freehand}<slug>, or a session id matching [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(arg)}`);
  return { mode: "plan", id: arg, subject: arg };
}

const isAncestor = (dir, a, b) => gitRun(dir, ["merge-base", "--is-ancestor", a, b]).ok;
const logLines = (dir, ...range) => git(dir, "log", "--format=%h %s", ...range).split("\n").filter(Boolean);

// Commits in a half that exist nowhere safe. Plan halves must sit inside the
// default branch. Otherwise none when HEAD is in the default branch; else those past
// a live upstream; else (upstream gone, never set, or detached) those on no remote
// ref — except a freehand branch that never had an upstream, whose commits survive
// on the retained local branch.
function unpushedCommits(dir, defaultRef, mode) {
  if (isAncestor(dir, "HEAD", defaultRef)) return [];
  if (mode === "plan") return logLines(dir, `${defaultRef}..HEAD`);
  if (git(dir, "rev-parse", "--verify", "--quiet", "@{upstream}")) return logLines(dir, "@{upstream}..HEAD");
  const current = git(dir, "branch", "--show-current");
  if (mode === "freehand" && current && !git(dir, "for-each-ref", "--format=%(upstream)", `refs/heads/${current}`)) return [];
  return logLines(dir, "HEAD", "--not", "--remotes");
}

function closeSession() {
  let args = closeSessionArgs();
  const dryRun = Boolean(options.dryRun);
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const out = {
    status: "ok",
    mode: args.mode,
    subject: args.subject,
    outcome: null,
    applied: false,
    product: null,
    companion: null,
    workspace: null,
    branches: { product: null, companion: null },
    occupants: { product: [], companion: [] },
    dirty: { product: [], companion: [] },
    next: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, result.status === "ok" ? 0 : 3);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });

  // Window check (§11): the primary checkout; its branch and cleanliness do not matter here.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);

  // --prune, so a remote branch deleted after its merge reads as gone.
  const fetched = new Set();
  const fetch = (dir, label) => {
    if (fetched.has(path.resolve(dir))) return;
    fetched.add(path.resolve(dir));
    const result = gitRun(dir, ["fetch", "--prune", "origin"]);
    if (result.ok) return;
    const url = originOf(dir);
    if (!result.timedOut && classifyFetchFailure(result.stderr) === "auth") {
      fail("fetch-auth", `git -C ${dir} fetch --prune origin: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(url) });
    }
    out.warnings.push(`fetch: ${label} ${url ?? "origin"} not fetched (${result.stderr.split("\n")[0]}); continuing from local refs`);
  };
  fetch(primary, "product");
  if (artifacts.external) fetch(artifactsRoot, "companion");

  // A plan-<id> worktree on a delivery branch was promoted: close it as that build.
  if (args.mode === "plan") {
    const entry = registeredAt(productWorktrees(), resolveSessionPaths("plan", args.id, checkoutLayout()).worktree);
    const type = !entry || entry.detached ? null : ["feature", "issue"].find((t) => entry.branch?.startsWith(config.branches[t]));
    const slug = type ? entry.branch.slice(config.branches[type].length) : null;
    if (type && SESSION_ID.test(slug)) {
      args = { mode: "build", type, slug, subject: `${type}/${slug}` };
      out.mode = "build";
      out.subject = args.subject;
    }
  }

  // Which halves, which branch, which clones — every check below precedes the first write.
  let layout = checkoutLayout();
  let paths;
  let branch = null;
  let outcome = null;
  if (args.mode === "build") {
    const { type, slug } = args;
    const decided = decideWithLayout(type, slug, (l) =>
      closeBuildSessionDecision({ type, slug, currentBranch, worktreeList: productWorktreeText(), git: l.artifactsGit, rootDir: root, artifactsRoot: l.artifactsRoot, config: l.config }),
    );
    const { decision } = decided;
    layout = decided.layout;
    if (decision.status !== "ok") reject(decision.reason, { message: decision.message });
    if (decision.reason === "primary-owns-branch") reject("primary-owns-branch", { message: decision.message, fix: `git switch ${config.branches.default}` });
    if (layout.artifacts.external) fetch(layout.artifactsRoot, "companion");
    branch = deliveryBranch(type, slug);
    if (decision.reason === "managed-worktree-present") {
      const { owner } = decision;
      const companion = companionOfOwner(owner, layout);
      const gaps = companionGaps(companion);
      if (gaps.length) reject("companion-unpushed", { message: companionGapMessage(companion, gaps, type, slug) });
      const resolved = resolveSessionPaths(owner.dirPrefix, owner.id, layout);
      paths = { product: owner.path, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
      outcome = "closed";
    } else {
      const resolved = resolveSessionPaths(type, slug, layout);
      paths = { product: resolved.worktree, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
      outcome = "already-closed";
    }
    let roadmapStatus = null;
    try {
      const { result, layout: found } = resolveWithLayout(type, slug);
      if (result.status === "ok") roadmapStatus = header(result.source === "local" ? fs.readFileSync(result.path, "utf8") : found.agit("show", `origin/${result.branch}:${result.path}`), "status");
    } catch {
      roadmapStatus = null;
    }
    if (roadmapStatus !== "complete") out.next = [`/agento ship ${slug}`];
  } else {
    const kind = args.mode;
    const id = kind === "plan" ? args.id : args.slug;
    if (kind === "freehand") branch = `${config.branches.freehand}${args.slug}`;
    const resolved = resolveSessionPaths(kind, id, layout);
    paths = { product: resolved.worktree, companion: resolved.companion?.worktree ?? null, workspace: resolved.workspace };
  }

  const companionClone = layout.artifacts.external ? layout.artifactsRoot : null;
  const productList = productWorktrees({ fresh: true });
  const companionList = companionClone ? parseWorktreeList(git(companionClone, "worktree", "list", "--porcelain")) : [];
  const inspect = (halfPath, list) => {
    const entry = registeredAt(list, halfPath);
    return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, registered: Boolean(entry), onDisk: fs.existsSync(halfPath), removed: false };
  };
  out.product = inspect(paths.product, productList);
  out.companion = paths.companion ? inspect(paths.companion, companionList) : null;
  out.workspace = paths.workspace ? { path: paths.workspace, existed: fs.existsSync(paths.workspace), removed: false } : null;
  const halves = [
    ["product", out.product, primary, productList, `origin/${config.branches.default}`],
    ...(out.companion ? [["companion", out.companion, companionClone, companionList, `origin/${layout.config.branches.default}`]] : []),
  ];

  for (const [label, half, clone] of halves) {
    if ([primary, companionClone].some((protectedPath) => protectedPath && samePath(half.path, protectedPath))) {
      reject("protected-path", { message: `${label} half ${half.path} is the clone itself (${clone}); close-session never removes a primary checkout` });
    }
    if (half.onDisk && !half.registered) {
      reject("unregistered", { message: `${label} half ${half.path} exists but is not a registered worktree of ${clone}; nothing was removed` });
    }
    if (!half.registered) continue;
    const expected = args.mode === "plan" ? half.detached : half.branch === branch || (label === "companion" && half.detached);
    if (!expected) {
      const want = args.mode === "plan" ? "detached (a planning session)" : `on ${branch}`;
      reject("branch-mismatch", { message: `${label} half ${half.path} is ${half.detached ? "detached" : `on ${half.branch}`}, expected ${want}; nothing was removed` });
    }
  }

  for (const [label, half] of halves) {
    if (!half.registered || !half.onDisk) continue;
    const tree = treeState(half.path);
    out.dirty[label] = tree ? [...tree.tracked, ...tree.untracked] : [];
  }
  const dirtyHalves = halves.filter(([label]) => out.dirty[label].length);
  if (dirtyHalves.length) {
    reject("dirty", { message: dirtyHalves.map(([label, half]) => `${label} half ${half.path} has uncommitted changes: ${out.dirty[label].join(", ")}`).join("; ") });
  }

  const commits = { product: [], companion: [] };
  for (const [label, half, , , defaultRef] of halves) {
    if (half.registered && half.onDisk) commits[label] = unpushedCommits(half.path, defaultRef, args.mode);
  }
  const unpushed = halves.filter(([label]) => commits[label].length);
  if (unpushed.length) {
    const message = unpushed.map(([label, half, , , defaultRef]) => `${label} half ${half.path} has ${commits[label].length} commit(s) on neither its upstream nor ${defaultRef}: ${commits[label].join("; ")}`).join("; ");
    reject("unpushed", { message, commits, next: args.mode === "freehand" ? ["/agento finish-freehand"] : out.next });
  }

  const anyHalf = halves.some(([, half]) => half.registered);
  out.outcome = outcome ?? (anyHalf || out.workspace?.existed ? "closed" : "nothing-to-close");

  // A local branch goes only when it is gone from origin, merged into that clone's
  // origin/<default>, checked out nowhere else, and `git branch -d` would accept it.
  if (branch) {
    for (const [label, clone, list, defaultRef] of [
      ["product", primary, productList, `origin/${config.branches.default}`],
      ...(companionClone ? [["companion", companionClone, companionList, `origin/${layout.config.branches.default}`]] : []),
    ]) {
      const ownHalf = out[label];
      out.branches[label] = branchVerdict(clone, list, branch, defaultRef, ownHalf?.registered ? ownHalf.path : null);
    }
    const unmerged = Object.values(out.branches).some((v) => v?.action === "retained" && !v.mergedIntoDefault);
    if (args.mode === "freehand" && unmerged) out.next = [`/agento start-freehand ${args.slug} --resume`];
  }

  // Occupant gate and apply block, shared with the ship teardown.
  const removal = removeSessionPair({
    halves: halves.map(([label, half, clone]) => ({ label, half, clone })),
    workspace: out.workspace,
    branches: out.branches,
    ignoreOccupants: Boolean(options.ignoreOccupants),
    dryRun,
  });
  out.occupants = removal.occupants;
  out.warnings.push(...removal.warnings);
  out.applied = removal.applied;
  if (removal.status === "blocked") finish({ status: "blocked", reason: removal.reason, message: removal.message });
  if (removal.status === "failed") fail(removal.reason, removal.message, { half: removal.half });
  finish();
}

// Whether `git branch -d <branch>` in `clone` is safe and wanted: the local branch
// exists, is gone from origin, is merged into `defaultRef`, is checked out nowhere
// but `ownHalfPath` (which is about to be removed), and is reachable from HEAD.
function branchVerdict(clone, list, branch, defaultRef, ownHalfPath = null) {
  const local = git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  const verdict = {
    name: branch,
    upstream: local ? git(clone, "for-each-ref", "--format=%(upstream:short)", `refs/heads/${branch}`) || null : null,
    remoteExists: Boolean(git(clone, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)),
    mergedIntoDefault: Boolean(local) && isAncestor(clone, `refs/heads/${branch}`, defaultRef),
    action: "retained",
    reason: null,
  };
  const holder = list.find((w) => w.branch === branch && !(ownHalfPath && samePath(w.path, ownHalfPath)));
  const head = git(clone, "symbolic-ref", "--short", "-q", "HEAD") || "HEAD";
  if (!local) Object.assign(verdict, { action: "absent", reason: `no local ${branch} in ${clone}` });
  else if (verdict.remoteExists) verdict.reason = `origin/${branch} still exists`;
  else if (!verdict.mergedIntoDefault) verdict.reason = `not merged into ${defaultRef}`;
  else if (holder) verdict.reason = `checked out at ${holder.path}`;
  else if (!isAncestor(clone, `refs/heads/${branch}`, "HEAD")) verdict.reason = `merged into ${defaultRef} but not into ${head} at ${clone}, so git branch -d would refuse; run git -C ${clone} pull --ff-only, then re-send`;
  else Object.assign(verdict, { action: "deleted", reason: `merged into ${defaultRef} and gone from origin` });
  return verdict;
}

// The occupant gate and the removal of a managed pair (companion half, prune,
// product half, prune, workspace file, merged local branches), as a result instead
// of an emission so close-session and the ship teardown share one implementation.
// `halves` are `{ label, half: { path, registered, onDisk, removed }, clone }` in
// product-first order; `branches.<label>` verdicts with `action: "deleted"` are
// deleted after the halves. The half, workspace, and branch objects are updated in
// place. The guard cannot see removals made from inside this process, so the gate
// runs here on every call.
function removeSessionPair({ halves, workspace = null, branches = { product: null, companion: null }, ignoreOccupants = false, dryRun = false, codeStatus = once(defaultCodeStatus) }) {
  const out = {
    status: "ok",
    reason: null,
    message: null,
    half: null,
    applied: false,
    occupants: { product: [], companion: [] },
    product: halves.find((h) => h.label === "product")?.half ?? null,
    companion: halves.find((h) => h.label === "companion")?.half ?? null,
    workspace,
    branches,
    warnings: [],
  };
  for (const { label, half } of halves) {
    if (half.registered && half.onDisk) out.occupants[label] = findOccupants(half.path, { codeStatus }).details;
  }
  const occupied = halves.filter(({ label }) => out.occupants[label].length);
  if (occupied.length) {
    const summary = occupied.map(({ label, half }) => `${label} half ${half.path}: ${out.occupants[label].join(", ")}`).join("; ");
    if (!ignoreOccupants) {
      return { ...out, status: "blocked", reason: "occupied", half: occupied[0].label, message: `Active worktree occupants detected - ${summary}. Close their terminals or VS Code window before removal, or re-send with --ignore-occupants.` };
    }
    out.warnings.push(`occupants: ignored (--ignore-occupants) - ${summary}`);
  }

  for (const { half } of halves) half.removed = half.registered;
  if (workspace) workspace.removed = workspace.existed;
  if (dryRun) return out;

  // Apply: companion half, prune, product half, prune, workspace file, merged branches.
  out.applied = true;
  for (const { label, half, clone } of [...halves].reverse()) {
    if (half.registered) {
      const removal = gitRun(clone, ["worktree", "remove", half.path], 120000);
      if (!removal.ok) {
        half.removed = false;
        if (label === "companion" && out.product) out.product.removed = false;
        if (workspace) workspace.removed = false;
        for (const verdict of Object.values(branches)) if (verdict?.action === "deleted") Object.assign(verdict, { action: "retained", reason: "not attempted: a worktree removal failed" });
        return { ...out, status: "failed", reason: "worktree-remove", half: label, message: `git -C ${clone} worktree remove ${half.path}: ${removal.stderr}` };
      }
    }
    gitRun(clone, ["worktree", "prune"]);
  }
  if (workspace?.existed) fs.rmSync(workspace.path, { force: true });
  for (const { label, clone } of halves) {
    const verdict = branches[label];
    if (verdict?.action !== "deleted") continue;
    const deletion = gitRun(clone, ["branch", "-d", verdict.name]);
    if (!deletion.ok) {
      Object.assign(verdict, { action: "retained", reason: `git branch -d failed: ${deletion.stderr.split("\n")[0]}` });
      return { ...out, status: "failed", reason: "branch-delete", half: label, message: `git -C ${clone} branch -d ${verdict.name}: ${deletion.stderr}` };
    }
  }
  return out;
}

// --- ship ------------------------------------------------------------------

const SHIP_EXIT = { ok: 0, pending: 2, rejected: 3, blocked: 3, failed: 3 };
const SHIP_PR_FIELDS = "number,state,isDraft,mergeStateStatus,mergeable,url,title,body,mergeCommit,baseRefName";
const WAIT_FOR_CHECKS = path.join(PLUGIN_ROOT, "scripts", "wait-for-checks.sh");

function shipArgs() {
  const type = requireType(rest[0]);
  const slug = requireSlug(rest[1]);
  if (rest.length > 2) usage(`ship takes exactly <feature|issue> <slug>, got extra ${JSON.stringify(rest.slice(2).join(" "))}`);
  return { type, slug, confirm: options.confirm ?? null, wait: options.wait ?? 50 };
}

// `gh pr view <branch>` with the fields the ship audit and merge need; a merged PR
// is still found by its head branch after the remote branch is deleted.
function shipPrLookup(branch, cwd, label) {
  const result = ghRun(cwd, ["pr", "view", branch, "--json", SHIP_PR_FIELDS], 20000);
  if (!result.ok) return { pr: null, warning: `${label}: gh pr view ${branch} failed: ${result.stderr.split("\n")[0]}` };
  try {
    return { pr: JSON.parse(result.stdout), warning: null };
  } catch {
    return { pr: null, warning: `${label}: gh pr view ${branch} returned non-JSON output` };
  }
}

const prSummary = (pr) => (pr ? { number: pr.number, state: pr.state, isDraft: Boolean(pr.isDraft), mergeStateStatus: pr.mergeStateStatus ?? null, url: pr.url ?? null, mergeCommit: pr.mergeCommit?.oid ?? null } : null);

const utcDate = () => new Date().toISOString().slice(0, 10);

function ship() {
  const { type, slug, confirm, wait } = shipArgs();
  const startedAt = Date.now();
  const remainingSeconds = () => Math.max(0, wait - Math.floor((Date.now() - startedAt) / 1000));
  const record = sessionRecord();
  const primary = record.worktrees[0]?.path ?? root;
  const defaultBranch = config.branches.default;
  const shipCommand = (token = null) => `/agento ship ${slug}${token ? ` --confirm ${token}` : ""}`;
  const out = {
    status: "ok",
    type,
    slug,
    branch: deliveryBranch(type, slug),
    mode: "in-repo",
    phase: null,
    resumedAt: null,
    outcome: null,
    audit: null,
    gaps: { hard: [], confirm: [] },
    confirmToken: null,
    rejectTo: null,
    actions: [],
    pr: null,
    companionPr: null,
    mergeSha: null,
    release: null,
    teardown: null,
    postShip: null,
    next: [],
    preflight: [],
    reason: null,
    message: null,
    fix: null,
    reauth: null,
    allowed: record.allowed,
    elsewhere: record.elsewhere,
    warnings: [...record.warnings],
    root,
    configSource: source,
  };
  const finish = (fields = {}) => {
    const result = { ...out, ...fields };
    emit(result, SHIP_EXIT[result.status]);
  };
  const reject = (reason, fields = {}) => finish({ status: "rejected", reason, ...fields });
  const fail = (reason, message, fields = {}) => finish({ status: "failed", reason, message, ...fields });
  const act = (step, detail) => out.actions.push({ step, detail });

  // Window check (§11): the primary checkout.
  const { worktree } = record;
  const where = `${worktree.path}, branch ${worktree.detached || !worktree.branch ? "detached" : worktree.branch}`;
  if (record.role !== "primary") reject(`wrong window: role=${record.role} (${where})`);

  // Capability preflight (§10): fail rejects, warn proceeds with the fallback.
  const doctor = runDoctor(checksFor(COMMAND_NEEDS.ship));
  const failed = doctor.checks.find((c) => c.status === "fail");
  if (failed) reject(failed.detail, { capability: capabilityOf(failed.id), check: failed.id, fallback: failed.fallback });
  out.preflight = doctor.checks.filter((c) => c.status === "warn").map(({ id, status, detail, fallback }) => ({ id, capability: capabilityOf(id), status, detail, fallback }));

  // --prune, so a remote branch deleted by an earlier call reads as gone.
  const fetched = new Set();
  const fetch = (dir, label) => {
    if (fetched.has(path.resolve(dir))) return;
    fetched.add(path.resolve(dir));
    const result = gitRun(dir, ["fetch", "--prune", "origin"]);
    if (result.ok) return;
    const url = originOf(dir);
    if (!result.timedOut && classifyFetchFailure(result.stderr) === "auth") {
      fail("fetch-auth", `git -C ${dir} fetch --prune origin: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(url) });
    }
    out.warnings.push(`fetch: ${label} ${url ?? "origin"} not fetched (${result.stderr.split("\n")[0]}); continuing from local refs`);
  };
  fetch(primary, "product");
  if (artifacts.external) fetch(artifactsRoot, "companion");

  // Preflight: the ship-preflight computation in process. After the merge the remote
  // branch is gone and the roadmap lives on the artifact default; resume from there.
  const worktreeList = productWorktreeText({ fresh: true });
  const decided = decideWithLayout(type, slug, (l) =>
    evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot: l.artifactsRoot, currentBranch, git: l.artifactsGit, config: l.config, worktreeList }),
  );
  let preflight = decided.decision;
  const { layout } = decided;
  const external = layout.artifacts.external;
  const artifactsClone = layout.artifactsRoot;
  const artifactDefault = layout.config.branches.default;
  const branch = out.branch;
  let roadmapRel = null;
  if (preflight.status === "ok") {
    const { result } = resolveWithLayout(type, slug);
    roadmapRel = result.source === "local" ? path.relative(layout.artifactsRoot, result.path).split(path.sep).join("/") : result.path;
  } else if (preflight.reason === "no-resolvable-roadmap") {
    roadmapRel = roadmapPathOnRef(layout, `origin/${artifactDefault}`, type, slug);
    if (roadmapRel) {
      const owner = findOwner({ worktrees: parseWorktreeList(worktreeList), worktreesDir: primaryWorktreesDir(), branch, config });
      preflight = { status: "ok", resolutionSource: "default", branch, owner, message: `Roadmap for ${type}/${slug} resolved from origin/${artifactDefault}; the delivery branch is already merged.` };
    }
  }
  if (preflight.status !== "ok") reject(preflight.reason, { message: preflight.message });
  if (external) fetch(artifactsClone, "companion");
  out.mode = external ? "companion" : "in-repo";
  const { owner } = preflight;
  if (owner?.role === "primary") {
    reject("primary-owns-branch", { message: `The primary worktree at ${owner.path} is on ${branch}; return it to ${defaultBranch} first.`, fix: `git switch ${defaultBranch}` });
  }
  const companion = companionOfOwner(owner, layout);
  const ownerTree = ownerTreeOf(owner);
  const companionTree = companionTreeOf(companion);

  // Pull requests: the code PR in the product, the artifact PR inside the companion clone.
  const codeLookup = shipPrLookup(branch, root, "pr");
  if (codeLookup.warning) out.warnings.push(codeLookup.warning);
  const pr = codeLookup.pr;
  let companionPr = null;
  if (external) {
    const lookup = shipPrLookup(branch, artifactsClone, "companionPr");
    if (lookup.warning) out.warnings.push(lookup.warning);
    companionPr = lookup.pr;
  }
  out.pr = prSummary(pr);
  out.companionPr = prSummary(companionPr);
  if (!pr) reject("pr-missing", { message: `no pull request found for ${branch} in the product repository; the Builder opens the draft PR on its first push` });
  if (pr.state === "CLOSED") reject("pr-closed", { message: `pull request #${pr.number} for ${branch} is closed without a merge; reopen it or start the delivery over` });
  out.mergeSha = pr.mergeCommit?.oid ?? null;

  // Artifact reads: the branch while the PR is open, the artifact default once merged.
  const artifactRef = pr.state === "MERGED" ? `origin/${artifactDefault}` : refFor(branch, layout.agit).ref;
  const artifactDir = path.posix.dirname(roadmapRel);
  const readArtifact = (name) => layout.agit("show", `${artifactRef}:${artifactDir}/${name}`) || null;
  const roadmapContent = readArtifact("roadmap.md") ?? "";
  const steps = parseRoadmapSteps(roadmapContent);
  const postShipPending = steps.filter((s) => s.postShip && !s.ticked);
  const behindDefault = (clone, name) => (git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`) ? Number.parseInt(git(clone, "rev-list", "--count", `${name}..origin/${name}`), 10) || 0 : 0);

  // Phase derivation from git + GitHub state, never from a journal.
  let phase;
  if (pr.state === "OPEN") phase = header(roadmapContent, "status") === "complete" ? "checks" : "audit";
  else if (external && companionPr?.state === "OPEN") phase = "merge-companion";
  else if (behindDefault(primary, defaultBranch) > 0 || (external && behindDefault(artifactsClone, artifactDefault) > 0)) phase = "sync";
  else if (config.checks?.releaseWorkflow) phase = "release";
  else if (owner) phase = "teardown";
  else if (postShipPending.length) phase = "epilogue";
  else phase = "done";
  out.resumedAt = phase;
  out.phase = phase;
  out.audit = { owner, ownerTree, companion, companionGaps: companionGaps(companion), companionTree, layout: layout.layout, artifactsRoot: artifactsClone, artifactRef, roadmapPath: roadmapRel };

  // Code-side facts shared by the audit and the write phase.
  const pgit = (...args) => git(root, ...args);
  const codeRef = pr.state === "MERGED" ? `origin/${defaultBranch}` : refFor(branch, pgit).ref;
  const versionOf = (ref, file) => pgit("show", `${ref}:${file}`).match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const changelogFacts = () => {
    let from = null;
    let to = null;
    for (const file of [".claude-plugin/plugin.json", "package.json"]) {
      const before = versionOf(`origin/${defaultBranch}`, file);
      const after = versionOf(codeRef, file);
      if (after && after !== before) {
        from = before;
        to = after;
        break;
      }
    }
    const versionChanged = to !== null;
    const heading = pgit("show", `${codeRef}:CHANGELOG.md`).match(/^## (\S+) \(unreleased\)/m)?.[1] ?? null;
    return { versionChanged, from, to, unreleasedHeading: heading, needsStamp: versionChanged && heading !== null, headingWithoutVersionChange: heading !== null && !versionChanged };
  };

  // ---- audit (the PR is open and the confirm writes have not landed) ----
  let acceptedGaps = [];
  let changelog = null;
  if (phase === "audit") {
    const reviewContent = readArtifact("review.md");
    const planContent = readArtifact("plan.md") ?? "";
    const reviewTs = reviewContent === null ? null : Number(layout.agit("log", "-1", "--format=%ct", artifactRef, "--", `${artifactDir}/review.md`)) || null;
    const codeLine = pgit("log", "-1", "--format=%H %ct", codeRef, "--", ".", `:(exclude)${artifactDir}`) || pgit("log", "-1", "--format=%H %ct", codeRef);
    const [codeSha, codeTs] = codeLine ? codeLine.split(" ") : [null, null];
    const iso = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString() : null);
    const review = {
      present: reviewContent !== null,
      verdict: reviewContent?.match(/^Verdict:\s*(approve|request-changes)/m)?.[1] ?? null,
      stale: reviewTs !== null && codeTs !== null && reviewTs < Number(codeTs),
      reviewedAt: iso(reviewTs),
      lastCodeCommit: codeSha ? { sha: codeSha, at: iso(codeTs) } : null,
    };
    const issueNumber = type === "issue" ? header(roadmapContent, "github-issue").match(/\d+/)?.[0] ?? null : null;
    const issue = type === "issue" ? { githubIssue: issueNumber, fixesLine: issueNumber !== null && (pr.body ?? "").includes(`Fixes #${issueNumber}`), resolutionWritten: /^## Resolution\b/m.test(planContent) } : null;
    changelog = changelogFacts();
    const diffFiles = pgit("diff", "--name-only", `origin/${defaultBranch}...${codeRef}`).split("\n").filter(Boolean);
    const postShipSteps = steps.filter((s) => s.postShip);
    const risks = planContent.match(/^## Risks\b[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? "";
    Object.assign(out.audit, {
      roadmap: { status: header(roadmapContent, "status"), unticked: steps.filter((s) => !s.ticked && !s.postShip).map((s) => `${s.id} ${s.text}`), postShip: postShipSteps.map((s) => ({ id: s.id, text: s.text, ticked: s.ticked })) },
      review,
      issue,
      changelog,
      pr: { ...out.pr, title: pr.title ?? null, mergeable: pr.mergeable ?? null },
      companionPr: companionPr ? { ...out.companionPr, title: companionPr.title ?? null, mergeable: companionPr.mergeable ?? null } : null,
      diffFiles,
    });

    // Gap sorting: the two pinned lists; nothing else counts as a gap.
    const hard = [];
    const confirmGaps = [];
    const unticked = out.audit.roadmap.unticked;
    if (unticked.length) hard.push({ code: "unticked-steps", detail: `${unticked.length} unticked step(s) that are not (manual, post-ship): ${steps.filter((s) => !s.ticked && !s.postShip).map((s) => s.id).join(", ")}` });
    if (!review.present) hard.push({ code: "review-missing", detail: `${artifactDir}/review.md is absent on ${artifactRef}` });
    else if (review.verdict === "request-changes") hard.push({ code: "review-request-changes", detail: `${artifactDir}/review.md ends with Verdict: request-changes` });
    else if (review.verdict !== "approve") hard.push({ code: "review-missing", detail: `${artifactDir}/review.md carries no Verdict: approve line` });
    if (review.present && review.stale) hard.push({ code: "review-stale", detail: `review.md (${review.reviewedAt}) is older than the last code commit ${codeSha.slice(0, 7)} (${review.lastCodeCommit.at}) on ${codeRef}` });
    if (owner && ownerTree === null) hard.push({ code: "owner-tree-unreadable", detail: `the owner worktree ${owner.path} could not be read, so it cannot be shown clean` });
    if (ownerTree?.tracked.length) hard.push({ code: "owner-tree-dirty", detail: `uncommitted tracked changes in ${owner.path}: ${ownerTree.tracked.join(", ")}`, paths: ownerTree.tracked });
    if (ownerTree?.ahead > 0) hard.push({ code: "owner-ahead", detail: `${ownerTree.ahead} commit(s) in ${owner.path} are not pushed to origin/${branch}` });
    for (const gap of out.audit.companionGaps) {
      const entry = { code: `companion-${gap}`, detail: companionGapMessage(companion, [gap], type, slug) };
      if (gap === "dirty" && companionTree) entry.paths = [...companionTree.tracked, ...companionTree.untracked];
      hard.push(entry);
    }
    if (external) {
      if (!companionPr) hard.push({ code: "companion-missing-pr", detail: `no pull request for ${branch} in the companion repository at ${artifactsClone}; open it from the companion half` });
      else if (companionPr.state !== "OPEN") hard.push({ code: "companion-pr-not-open", detail: `companion PR #${companionPr.number} is ${companionPr.state.toLowerCase()} (${companionPr.url}); the code PR is still open` });
      else if (companionPr.mergeStateStatus === "CONFLICTING") hard.push({ code: "companion-pr-conflicting", detail: `companion PR #${companionPr.number} (${companionPr.url}) conflicts with ${artifactDefault}; resolve it in the companion half` });
    }
    if (pr.mergeStateStatus === "CONFLICTING") hard.push({ code: "pr-conflicting", detail: `PR #${pr.number} (${pr.url}) conflicts with ${defaultBranch}; resolve it in the build window per the concurrent-delivery hotspot recipes` });
    if (changelog.headingWithoutVersionChange) hard.push({ code: "changelog-heading-without-version", detail: `CHANGELOG.md carries "## ${changelog.unreleasedHeading} (unreleased)" but the branch does not change "version" in .claude-plugin/plugin.json or package.json` });
    if (postShipSteps.length && !/post-ship/i.test(risks)) hard.push({ code: "post-ship-unjustified", detail: `${postShipSteps.length} (manual, post-ship) step(s) without a post-ship justification under plan.md ## Risks: ${postShipSteps.map((s) => s.id).join(", ")}` });
    if (ownerTree && !ownerTree.tracked.length && ownerTree.ahead === 0 && ownerTree.untracked.length) {
      confirmGaps.push({ code: "untracked-byproducts", detail: `${ownerTree.untracked.length} untracked file(s) in ${owner.path} will be deleted`, paths: ownerTree.untracked });
    }
    if (changelog.needsStamp) confirmGaps.push({ code: "changelog-unstamped", detail: `CHANGELOG.md "## ${changelog.unreleasedHeading} (unreleased)" will be stamped with today's UTC date in the product` });
    if (pr.mergeStateStatus === "BEHIND") confirmGaps.push({ code: "pr-behind", detail: `PR #${pr.number} is behind ${defaultBranch}; origin/${defaultBranch} will be merged into ${branch} (never rebased)` });
    if (external && companionPr?.mergeStateStatus === "BEHIND") confirmGaps.push({ code: "companion-pr-behind", detail: `companion PR #${companionPr.number} is behind ${artifactDefault}; origin/${artifactDefault} will be merged into the companion half` });

    out.gaps = { hard, confirm: confirmGaps };
    out.confirmToken = confirmTokenFor({ slug, pr: pr.number, companionPr: companionPr?.number ?? null, confirm: confirmGaps });
    const reviewOnly = hard.length > 0 && hard.every((g) => g.code.startsWith("review-"));
    out.rejectTo = !hard.length ? null : reviewOnly ? { command: `/agento review-${type} ${slug}`, window: "build" } : owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : { command: `/agento start-session ${type}/${slug} --resume`, window: "primary" };
    if (hard.length) reject("audit-gaps", { message: `${hard.length} hard gap(s): ${hard.map((g) => g.code).join(", ")}`, next: [out.rejectTo.command] });

    // Not a gap: an issue PR without its closing keyword gets it, idempotently.
    if (issue && issue.githubIssue && !issue.fixesLine) {
      const nwo = ghRun(root, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
      if (!nwo.ok) fail("gh-error", `gh repo view --json nameWithOwner: ${nwo.stderr}`);
      const body = `${(pr.body ?? "").replace(/\s+$/, "")}\n\nFixes #${issue.githubIssue}`.replace(/^\n+/, "");
      const patch = ghRun(root, ["api", `repos/${nwo.stdout}/pulls/${pr.number}`, "-X", "PATCH", "-f", `body=${body}`], 20000);
      if (!patch.ok) fail("gh-error", `gh api repos/${nwo.stdout}/pulls/${pr.number} -X PATCH: ${patch.stderr}`);
      issue.fixesLine = true;
      act("fixes-line-added", `Fixes #${issue.githubIssue} appended to the body of PR #${pr.number}`);
    }

    if (!confirm) finish({ outcome: "awaiting-confirm", next: [shipCommand()] });
    if (confirm !== out.confirmToken) reject("confirm-stale", { message: `--confirm ${confirm} does not match the recomputed token ${out.confirmToken}; the confirmation gaps changed — present them again`, providedToken: confirm, next: [shipCommand()] });
    acceptedGaps = confirmGaps;
  }

  // Restorations for the no-owner path (the primary or the companion clone switched
  // onto the branch) run on exit, whichever result line ends the call.
  const restores = [];
  process.on("exit", () => {
    for (const restore of restores.reverse()) restore();
  });
  const switchTo = (clone, target, label) => {
    if (git(clone, "branch", "--show-current") === target) return;
    if (git(clone, "status", "--porcelain") !== "") reject("primary-dirty", { message: `${label} checkout ${clone} has uncommitted changes; with no owner worktree the ship writes happen there — commit, stash, or discard them first` });
    const back = git(clone, "branch", "--show-current");
    const sw = gitRun(clone, ["switch", target]);
    if (!sw.ok) fail("switch-failed", `git -C ${clone} switch ${target}: ${sw.stderr}`);
    restores.push(() => gitRun(clone, ["switch", back || layout.config.branches.default]));
  };
  const integrate = (dir, defaultRef, label) => {
    const merge = gitRun(dir, ["merge", "--no-edit", defaultRef], 120000);
    if (merge.ok) {
      if (!/Already up to date/.test(merge.stdout)) act("integrate", `${label}: merged ${defaultRef} into ${branch} at ${dir}`);
      return;
    }
    gitRun(dir, ["merge", "--abort"]);
    const clean = git(dir, "status", "--porcelain") === "";
    out.rejectTo = owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : { command: `/agento start-session ${type}/${slug} --resume`, window: "primary" };
    reject("integration-conflict", { message: `merging ${defaultRef} into ${branch} at ${dir} conflicts (${merge.stderr.split("\n")[0]}); the merge was aborted${clean ? " and the tree is clean again" : " but the tree is NOT clean — inspect it"}; resolve it in the build window`, next: [out.rejectTo.command] });
  };
  const push = (dir, label, refspec = branch) => {
    const result = gitRun(dir, ["push", "origin", refspec], 120000);
    if (!result.ok) {
      if (classifyFetchFailure(result.stderr) === "auth") fail("push-auth", `git -C ${dir} push origin ${refspec}: ${result.stderr.split("\n")[0]}`, { reauth: reauthFor(originOf(dir)) });
      fail("push-failed", `git -C ${dir} push origin ${refspec}: ${result.stderr.split("\n")[0]}`);
    }
    act("push", `${label}: pushed ${refspec} from ${dir}`);
  };
  const nameWithOwner = (cwd) => {
    const result = ghRun(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], 15000);
    if (!result.ok) fail("gh-error", `gh repo view --json nameWithOwner in ${cwd}: ${result.stderr}`);
    return result.stdout;
  };
  // scripts/wait-for-checks.sh in the foreground, bounded by the remaining budget.
  const waitForChecks = (kind, target, cwd, { repo = null } = {}) => {
    const args = [WAIT_FOR_CHECKS, kind, String(target), "--max-seconds", String(remainingSeconds()), "--interval", "10", ...(repo ? ["--repo", repo] : [])];
    const result = spawnSync("bash", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    const lines = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").filter(Boolean);
    return { code: result.status ?? 3, last: lines.at(-1) ?? (result.error?.message ?? "wait-for-checks.sh produced no output") };
  };
  const pending = (atPhase, message) => finish({ status: "pending", phase: atPhase, message, next: [shipCommand(atPhase === "checks" ? confirm : null)] });
  const ghFailure = (result, what) => {
    if (result.missing || /HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(result.stderr)) fail("gh-auth", `${what}: ${result.stderr.split("\n")[0]}`, { reauth: "gh auth login" });
    fail("gh-error", `${what}: ${result.stderr.split("\n")[0]}`);
  };
  let shippedHere = false;

  // ---- confirm → checks → merge-code (the PR is still open) ----
  if (phase === "audit" || phase === "checks") {
    const accepted = new Set(acceptedGaps.map((g) => g.code));
    const productTarget = owner ? owner.path : primary;
    const artifactTarget = !external ? productTarget : companion?.registered ? companion.path : artifactsClone;
    if (!owner) switchTo(primary, branch, "primary");
    if (external && !companion?.registered) switchTo(artifactsClone, branch, "companion");

    if (phase === "audit") {
      out.phase = "confirm";
      // Untracked byproducts first: exactly the listed paths, literal, never -d or -x.
      const byproducts = acceptedGaps.find((g) => g.code === "untracked-byproducts");
      if (byproducts) {
        const clean = gitRun(owner.path, ["--literal-pathspecs", "clean", "-f", "--", ...byproducts.paths]);
        if (!clean.ok) fail("clean-failed", `git -C ${owner.path} --literal-pathspecs clean -f -- …: ${clean.stderr}`);
        act("clean", `removed ${byproducts.paths.length} untracked file(s) from ${owner.path}: ${byproducts.paths.join(", ")}`);
        const after = treeState(owner.path);
        if (!after || after.tracked.length || after.untracked.length || after.ahead !== 0) {
          reject("owner-tree-changed", { message: `${owner.path} is not clean after the byproduct cleanup (tracked: ${after?.tracked.join(", ") || "none"}; untracked: ${after?.untracked.join(", ") || "none"}; ahead: ${after?.ahead ?? "?"}); nothing else was written`, ownerTreeAfter: after });
        }
      }
    }

    // The write targets sit at origin/<branch> (owners are never ahead here); then the accepted integrations.
    for (const [dir, ref, label] of [[productTarget, `origin/${branch}`, "product"], ...(external ? [[artifactTarget, `origin/${branch}`, "companion"]] : [])]) {
      if (!git(dir, "rev-parse", "--verify", "--quiet", ref)) continue;
      const ff = gitRun(dir, ["merge", "--ff-only", ref]);
      if (!ff.ok) reject("owner-diverged", { message: `${label} checkout ${dir} cannot fast-forward to ${ref}: ${ff.stderr.split("\n")[0]}; reconcile it in the build window` });
    }
    const behindNow = phase === "checks" && pr.mergeStateStatus === "BEHIND";
    if (accepted.has("pr-behind") || behindNow) integrate(productTarget, `origin/${defaultBranch}`, "product");
    if (external && (accepted.has("companion-pr-behind") || (phase === "checks" && companionPr?.mergeStateStatus === "BEHIND"))) integrate(artifactTarget, `origin/${artifactDefault}`, "companion");

    const today = utcDate();
    if (phase === "audit") {
      // Roadmap: status complete, the accepted gaps as Follow-ups; one artifact commit.
      const roadmapFile = path.join(artifactTarget, roadmapRel);
      fs.writeFileSync(roadmapFile, completeRoadmap(fs.readFileSync(roadmapFile, "utf8"), { date: today, followups: acceptedGaps }));
      gitRun(artifactTarget, ["add", "--", roadmapRel]);
      const commit = gitRun(artifactTarget, ["commit", "-q", "-m", `docs(${type}): ship ${slug}`]);
      if (!commit.ok) fail("commit-failed", `git -C ${artifactTarget} commit (roadmap): ${commit.stderr}`);
      act("roadmap-complete", `roadmap status: complete${acceptedGaps.length ? ` with ${acceptedGaps.length} accepted gap(s) under ## Follow-ups (accepted at ship)` : ""} committed at ${artifactTarget}`);
      if (changelog.needsStamp) stampChangelog(productTarget, changelog.unreleasedHeading, today, act);
    } else {
      // Resume on a later UTC date: refresh a stamp older than today before the merge.
      const facts = changelogFacts();
      const stamped = pgit("show", `${codeRef}:CHANGELOG.md`).match(/^## (\S+) \((\d{4}-\d{2}-\d{2})\)/m);
      if (facts.versionChanged && stamped && stamped[1] === facts.to && stamped[2] !== today) stampChangelog(productTarget, facts.to, today, act, stamped[2]);
    }

    // Push product first, then companion, so the tick never precedes its code.
    if (git(productTarget, "rev-parse", "HEAD") !== pgit("rev-parse", `origin/${branch}`)) push(productTarget, "product");
    if (external && git(artifactTarget, "rev-parse", "HEAD") !== layout.agit("rev-parse", `origin/${branch}`)) push(artifactTarget, "companion");
    for (const restore of restores.splice(0)) restore();

    // Ready, wait, merge — the code PR first; the companion PR is readied now and merged after.
    out.phase = "checks";
    if (pr.isDraft) {
      const ready = ghRun(root, ["pr", "ready", String(pr.number)], 30000);
      if (!ready.ok) ghFailure(ready, `gh pr ready ${pr.number}`);
      act("pr-ready", `PR #${pr.number} marked ready for review`);
    }
    if (external && companionPr?.isDraft) {
      const ready = ghRun(artifactsClone, ["pr", "ready", String(companionPr.number)], 30000);
      if (!ready.ok) ghFailure(ready, `gh pr ready ${companionPr.number} (companion)`);
      companionPr.isDraft = false;
      act("companion-pr-ready", `companion PR #${companionPr.number} marked ready for review`);
    }
    const checks = waitForChecks("pr", pr.number, root);
    if (checks.code === 2) pending("checks", `PR #${pr.number}: ${checks.last}`);
    if (checks.code === 1) fail("checks-failed", `PR #${pr.number} has a failing required check (${checks.last}); fix it in the build window, then re-send`, { rejectTo: owner ? { command: `/agento build-${type} ${slug}`, window: "build" } : null });
    if (checks.code !== 0) fail("gh-auth", `wait-for-checks.sh pr ${pr.number}: ${checks.last}`, { reauth: "gh auth login" });

    out.phase = "merge-code";
    const merge = ghRun(root, ["pr", "merge", String(pr.number), "--merge"], 120000);
    if (!merge.ok) ghFailure(merge, `gh pr merge ${pr.number} --merge`);
    act("merge-code", `PR #${pr.number} merged into ${defaultBranch} with a merge commit`);
    shippedHere = true;
    const del = gitRun(primary, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) act("delete-branch", `origin/${branch} deleted from the product`);
    else out.warnings.push(`delete-branch: git push origin --delete ${branch} failed (${del.stderr.split("\n")[0]}); the remote branch may already be gone`);
    gitRun(primary, ["fetch", "--prune", "origin"]);
    const merged = shipPrLookup(branch, root, "pr");
    if (merged.pr) {
      out.pr = prSummary(merged.pr);
      out.mergeSha = merged.pr.mergeCommit?.oid ?? null;
    }
  }

  // ---- merge-companion (companion mode; the resume point of the half-shipped case) ----
  if (external && companionPr?.state === "OPEN") {
    out.phase = "merge-companion";
    const halfShipped = `code PR #${pr.number} merged, companion PR #${companionPr.number} open at ${companionPr.url}; re-send /agento ship ${slug} to resume at the companion merge`;
    const companionFail = (detail) => fail("companion-merge", halfShipped, { detail });
    if (companionPr.isDraft) {
      const ready = ghRun(artifactsClone, ["pr", "ready", String(companionPr.number)], 30000);
      if (!ready.ok) companionFail(`gh pr ready ${companionPr.number}: ${ready.stderr}`);
      act("companion-pr-ready", `companion PR #${companionPr.number} marked ready for review`);
    }
    const checks = waitForChecks("pr", companionPr.number, artifactsClone, { repo: nameWithOwner(artifactsClone) });
    if (checks.code === 2) pending("merge-companion", `companion PR #${companionPr.number}: ${checks.last}`);
    if (checks.code !== 0) companionFail(`wait-for-checks.sh pr ${companionPr.number}: ${checks.last}`);
    const merge = ghRun(artifactsClone, ["pr", "merge", String(companionPr.number), "--merge"], 120000);
    if (!merge.ok) companionFail(`gh pr merge ${companionPr.number} --merge: ${merge.stderr}`);
    act("merge-companion", `companion PR #${companionPr.number} merged into ${artifactDefault} with a merge commit`);
    shippedHere = true;
    const del = gitRun(artifactsClone, ["push", "origin", "--delete", branch], 60000);
    if (del.ok) act("companion-delete-branch", `origin/${branch} deleted from the companion`);
    else out.warnings.push(`companion-delete-branch: git -C ${artifactsClone} push origin --delete ${branch} failed (${del.stderr.split("\n")[0]}); the remote branch may already be gone`);
    gitRun(artifactsClone, ["fetch", "--prune", "origin"]);
    const merged = shipPrLookup(branch, artifactsClone, "companionPr");
    if (merged.pr) out.companionPr = prSummary(merged.pr);
  }

  // ---- sync: both defaults fast-forwarded to their origin ----
  out.phase = "sync";
  const postBranch = `${config.branches.postShip}${slug}`;
  const syncDefault = (clone, name, label, { keepPostShip = true } = {}) => {
    gitRun(clone, ["fetch", "--prune", "origin"]);
    const current = git(clone, "branch", "--show-current");
    if (current !== name) {
      // The epilogue works on post-ship/<slug> in this checkout: update the default in place.
      if (keepPostShip && current === postBranch && postShipPending.length) {
        const before = git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
        const ff = gitRun(clone, ["fetch", "origin", `${name}:${name}`], 120000);
        if (!ff.ok) fail("sync-failed", `git -C ${clone} fetch origin ${name}:${name}: ${ff.stderr.split("\n")[0]}; reconcile ${name} by hand, then re-send`);
        if (git(clone, "rev-parse", name) !== before) act("sync", `${label}: ${name} fast-forwarded to origin/${name} at ${clone} (kept on ${postBranch})`);
        return;
      }
      if (git(clone, "status", "--porcelain") !== "") {
        out.warnings.push(`sync: ${label} checkout ${clone} is on ${current || "a detached HEAD"} with uncommitted changes; ${name} was not fast-forwarded`);
        return;
      }
      const sw = gitRun(clone, ["switch", name]);
      if (!sw.ok) fail("sync-failed", `git -C ${clone} switch ${name}: ${sw.stderr}`);
      act("switch", `${label}: switched ${clone} to ${name}`);
    }
    const before = git(clone, "rev-parse", "HEAD");
    const ff = gitRun(clone, ["merge", "--ff-only", `origin/${name}`], 120000);
    if (!ff.ok) fail("sync-failed", `git -C ${clone} merge --ff-only origin/${name}: ${ff.stderr.split("\n")[0]}; reconcile ${name} by hand, then re-send`);
    if (git(clone, "rev-parse", "HEAD") !== before) act("sync", `${label}: ${name} fast-forwarded to origin/${name} at ${clone}`);
    const ahead = Number.parseInt(git(clone, "rev-list", "--count", `origin/${name}..HEAD`), 10) || 0;
    if (ahead || git(clone, "status", "--porcelain") !== "") out.warnings.push(`sync: ${label} ${name} at ${clone} is ${ahead ? `${ahead} commit(s) ahead of origin/${name}` : "not clean"} after the fast-forward`);
  };
  syncDefault(primary, defaultBranch, "product");
  if (external) syncDefault(artifactsClone, artifactDefault, "companion");
  // No owner: the local branch the writes used (or an earlier session left) goes once merged.
  if (!owner) {
    for (const [clone, defaultRef, label] of [[primary, `origin/${defaultBranch}`, "product"], ...(external ? [[artifactsClone, `origin/${artifactDefault}`, "companion"]] : [])]) {
      const verdict = branchVerdict(clone, parseWorktreeList(git(clone, "worktree", "list", "--porcelain")), branch, defaultRef);
      if (verdict.action !== "deleted") continue;
      const deletion = gitRun(clone, ["branch", "-d", branch]);
      if (deletion.ok) act("delete-local-branch", `${label}: local ${branch} deleted at ${clone} (${verdict.reason})`);
      else out.warnings.push(`delete-local-branch: git -C ${clone} branch -d ${branch} failed: ${deletion.stderr.split("\n")[0]}`);
    }
  }

  // ---- release: the deploy verdict for the merge commit, bounded by the remaining budget ----
  if (config.checks?.releaseWorkflow) {
    out.phase = "release";
    const workflow = config.checks.releaseWorkflow;
    if (!out.mergeSha) {
      const fresh = shipPrLookup(branch, root, "pr");
      out.mergeSha = fresh.pr?.mergeCommit?.oid ?? null;
    }
    if (!out.mergeSha) fail("release-no-merge-sha", `PR #${pr.number} reports no merge commit yet; re-send in a moment`);
    const short = out.mergeSha.slice(0, 7);
    const { fields } = releaseVerdict(out.mergeSha, { wait: remainingSeconds(), interval: 10 });
    out.release = { verdict: fields.verdict, workflow, run: fields.run, supersededBy: fields.supersededBy, reason: fields.reason ?? null, mergeDate: fields.mergeDate ?? null, dispatched: false };
    if (fields.status === "error") {
      if (fields.reason === "gh-missing" || fields.reason === "auth") fail("gh-auth", fields.message, { reauth: "gh auth login" });
      fail("gh-error", fields.message);
    }
    if (fields.verdict === "pending") pending("release", `release ${workflow} for ${short}: ${fields.reason ?? "run in progress"}`);
    if (fields.verdict === "dispatch-required") {
      // Follow a dispatch run created after the merge; otherwise dispatch exactly once and let the re-send find it.
      const list = ghRun(root, ["run", "list", "--workflow", workflow, "--event", "workflow_dispatch", "--json", "databaseId,createdAt,url,status,conclusion", "--limit", "20"], 30000);
      if (!list.ok) ghFailure(list, `gh run list --workflow ${workflow} --event workflow_dispatch`);
      let runs = [];
      try {
        runs = JSON.parse(list.stdout || "[]");
      } catch {
        fail("gh-error", `gh run list --workflow ${workflow} returned non-JSON output`);
      }
      const run = runs.filter((r) => fields.mergeDate && r.createdAt > fields.mergeDate).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
      if (!run) {
        const dispatch = ghRun(root, ["workflow", "run", workflow, "--ref", defaultBranch], 30000);
        if (!dispatch.ok) ghFailure(dispatch, `gh workflow run ${workflow} --ref ${defaultBranch}`);
        out.release.dispatched = true;
        act("release-dispatch", `gh workflow run ${workflow} --ref ${defaultBranch} (no workflow_dispatch run after ${fields.mergeDate})`);
        pending("release", `release ${workflow} dispatched for ${short}; the re-send follows the run it created`);
      }
      out.release.run = { id: run.databaseId, event: "workflow_dispatch", status: run.status ?? null, conclusion: run.conclusion ?? null, url: run.url ?? null, headSha: null };
      if (run.status !== "completed") {
        const follow = waitForChecks("run", run.databaseId, root);
        if (follow.code === 2) pending("release", `release run ${run.url ?? run.databaseId}: ${follow.last}`);
        if (follow.code === 1) fail("release-failed", `release run ${run.url ?? run.databaseId} failed: ${follow.last}`);
        if (follow.code !== 0) fail("gh-auth", `wait-for-checks.sh run ${run.databaseId}: ${follow.last}`, { reauth: "gh auth login" });
        Object.assign(out.release.run, { status: "completed", conclusion: "success" });
      } else if (run.conclusion !== "success") fail("release-failed", `release run ${run.url ?? run.databaseId} concluded ${run.conclusion}`);
      out.release.verdict = "success";
    }
    if (fields.verdict === "failed" || fields.verdict === "no-run") {
      fail(`release-${fields.verdict}`, `release ${workflow} for ${short}: ${fields.verdict}${fields.reason ? ` (${fields.reason})` : ""}${fields.run?.url ? ` — ${fields.run.url}` : ""}; re-sending re-derives the verdict, never a second release`);
    }
    act("release", `${workflow} for ${short}: ${out.release.verdict}${out.release.run?.url ? ` (${out.release.run.url})` : ""}${out.release.supersededBy?.url ? `, superseded by ${out.release.supersededBy.url}` : ""}`);
  }

  // ---- teardown: the owner's halves, workspace file, and merged local branches ----
  if (owner) {
    out.phase = "teardown";
    const productList = productWorktrees({ fresh: true });
    const companionList = external ? parseWorktreeList(git(artifactsClone, "worktree", "list", "--porcelain")) : [];
    const resolved = resolveSessionPaths(owner.dirPrefix, owner.id, layout);
    const inspect = (halfPath, list) => {
      const entry = registeredAt(list, halfPath);
      return { path: entry?.path ?? halfPath, branch: entry?.branch ?? null, detached: entry ? Boolean(entry.detached) : false, registered: Boolean(entry), onDisk: fs.existsSync(halfPath), removed: false };
    };
    const halves = [{ label: "product", half: inspect(owner.path, productList), clone: primary }];
    if (external) halves.push({ label: "companion", half: inspect(companion?.path ?? resolved.companion.worktree, companionList), clone: artifactsClone });
    const workspace = resolved.workspace ? { path: resolved.workspace, existed: fs.existsSync(resolved.workspace), removed: false } : null;
    const branches = {
      product: branchVerdict(primary, productList, branch, `origin/${defaultBranch}`, halves[0].half.path),
      companion: external ? branchVerdict(artifactsClone, companionList, branch, `origin/${artifactDefault}`, halves[1].half.path) : null,
    };
    const removal = removeSessionPair({ halves, workspace, branches });
    out.teardown = { product: removal.product, companion: removal.companion, workspace, branches, occupants: removal.occupants, pausedPath: null };
    if (removal.status === "blocked") {
      const flagged = halves.find((h) => h.label === removal.half).half.path;
      out.teardown.pausedPath = flagged;
      const summary = halves.filter((h) => removal.occupants[h.label].length).map((h) => `${h.label} half ${h.half.path}: ${removal.occupants[h.label].join(", ")}`).join("; ");
      finish({ status: "blocked", reason: "occupied", outcome: "paused-teardown", message: `paused at teardown (worktree ${flagged} still open): ${summary}; close that VS Code window or terminal, then re-send /agento ship ${slug}`, next: [shipCommand()] });
    }
    if (removal.status === "failed") fail(removal.reason, removal.message, { half: removal.half });
    const removed = halves.filter((h) => h.half.removed).map((h) => h.half.path);
    act("teardown", `removed ${removed.length ? removed.join(", ") : "no registered half"}${workspace?.removed ? ` and ${workspace.path}` : ""}; branches: product ${branches.product.action}${branches.companion ? `, companion ${branches.companion.action}` : ""}`);
    shippedHere = true;
  }

  // ---- epilogue: (manual, post-ship) steps land from a post-ship branch of the artifact checkout ----
  if (postShipPending.length) {
    out.phase = "epilogue";
    const checkout = external ? artifactsClone : primary;
    const label = external ? "companion" : "product";
    gitRun(checkout, ["fetch", "--prune", "origin"]);
    if (git(checkout, "branch", "--show-current") !== postBranch) {
      if (git(checkout, "status", "--porcelain") !== "") {
        reject("primary-dirty", { message: `${label} checkout ${checkout} has uncommitted changes; the post-ship evidence lands from ${postBranch} there — commit, stash, or discard them first` });
      }
      const exists = git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${postBranch}`);
      const sw = exists ? gitRun(checkout, ["switch", postBranch]) : gitRun(checkout, ["switch", "-c", postBranch, "--no-track", `origin/${artifactDefault}`]);
      if (!sw.ok) fail("switch-failed", `git -C ${checkout} switch ${exists ? "" : "-c "}${postBranch}: ${sw.stderr}`);
      act(exists ? "switch" : "post-ship-branch", exists ? `${label}: switched ${checkout} to ${postBranch}` : `${label}: created ${postBranch} from origin/${artifactDefault} at ${checkout}`);
    }
    const roadmapFile = path.join(checkout, roadmapRel);
    const working = fs.existsSync(roadmapFile) ? fs.readFileSync(roadmapFile, "utf8") : roadmapContent;
    const evidenceOf = (text) => text.match(/\((evidence\/[^)\s]+)\)/)?.[1] ?? text.match(/\bevidence\/[^\s)]+/)?.[0] ?? null;
    const postSteps = parseRoadmapSteps(working).filter((s) => s.postShip).map((s) => {
      const evidence = evidenceOf(s.text);
      return { id: s.id, text: s.text, ticked: s.ticked, evidence, evidencePresent: evidence !== null && fs.existsSync(path.join(checkout, artifactDir, evidence)) };
    });
    const existing = shipPrLookup(postBranch, checkout, "postShipPr");
    let postPr = existing.pr?.state === "OPEN" ? existing.pr : null;
    out.postShip = { branch: postBranch, path: checkout, steps: postSteps, pr: prSummary(postPr) };
    const remaining = postSteps.filter((s) => !s.ticked || !s.evidencePresent);
    if (!postSteps.length || remaining.length) {
      finish({ outcome: "post-ship-pending", message: `${remaining.length} (manual, post-ship) step(s) await a tick with a linked evidence file under ${checkout}/${artifactDir}/evidence/: ${remaining.map((s) => s.id).join(", ")}`, next: [shipCommand()] });
    }
    if (git(checkout, "status", "--porcelain") !== "") {
      gitRun(checkout, ["add", "--", artifactDir]);
      const commit = gitRun(checkout, ["commit", "-q", "-m", `docs(post-ship): ${slug} evidence`]);
      if (!commit.ok) fail("commit-failed", `git -C ${checkout} commit (post-ship evidence): ${commit.stderr}`);
      act("post-ship-commit", `evidence and roadmap ticks committed on ${postBranch} at ${checkout}`);
    }
    if (git(checkout, "rev-parse", "HEAD") !== git(checkout, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${postBranch}`)) push(checkout, label, postBranch);
    if (!postPr) {
      const create = ghRun(checkout, ["pr", "create", "--base", artifactDefault, "--head", postBranch, "--title", `docs(post-ship): ${slug} evidence`, "--body", `Post-ship evidence for ${type}/${slug}: ${postSteps.map((s) => s.id).join(", ")}.`], 60000);
      if (!create.ok) ghFailure(create, `gh pr create --head ${postBranch}`);
      postPr = shipPrLookup(postBranch, checkout, "postShipPr").pr;
      if (!postPr) fail("gh-error", `gh pr create for ${postBranch} returned but the PR cannot be looked up`);
      act("post-ship-pr", `opened PR #${postPr.number} for ${postBranch} (${postPr.url})`);
    }
    out.postShip.pr = prSummary(postPr);
    const checks = waitForChecks("pr", postPr.number, checkout, external ? { repo: nameWithOwner(checkout) } : {});
    if (checks.code === 2) pending("epilogue", `post-ship PR #${postPr.number}: ${checks.last}`);
    if (checks.code === 1) fail("post-ship-checks-failed", `post-ship PR #${postPr.number} has a failing required check (${checks.last})`);
    if (checks.code !== 0) fail("gh-auth", `wait-for-checks.sh pr ${postPr.number}: ${checks.last}`, { reauth: "gh auth login" });
    const merge = ghRun(checkout, ["pr", "merge", String(postPr.number), "--merge"], 120000);
    if (!merge.ok) ghFailure(merge, `gh pr merge ${postPr.number} --merge`);
    act("post-ship-merge", `post-ship PR #${postPr.number} merged into ${artifactDefault}`);
    const del = gitRun(checkout, ["push", "origin", "--delete", postBranch], 60000);
    if (!del.ok) out.warnings.push(`post-ship-delete-branch: git -C ${checkout} push origin --delete ${postBranch} failed (${del.stderr.split("\n")[0]})`);
    syncDefault(checkout, artifactDefault, label, { keepPostShip: false });
    const deletion = gitRun(checkout, ["branch", "-d", postBranch]);
    if (deletion.ok) act("post-ship-cleanup", `${label}: local ${postBranch} deleted at ${checkout}`);
    else out.warnings.push(`post-ship-cleanup: git -C ${checkout} branch -d ${postBranch} failed: ${deletion.stderr.split("\n")[0]}`);
    const landed = shipPrLookup(postBranch, checkout, "postShipPr").pr;
    if (landed) out.postShip.pr = prSummary(landed);
    shippedHere = true;
  }
  finish({ phase: "done", outcome: shippedHere ? "shipped" : "already-shipped", next: [] });
}

// roadmap.md → status complete, last-updated today, next-step cleared, and the
// accepted confirm gaps recorded under `## Follow-ups (accepted at ship)`.
function completeRoadmap(content, { date, followups }) {
  const setHeader = (text, key, value) => (new RegExp(`(^|\\n)${key}:[^\\n]*`).test(text) ? text.replace(new RegExp(`(^|\\n)${key}:[^\\n]*`), `$1${key}: ${value}`) : text.replace(/(^|\n)(status:[^\n]*)/, `$1$2\n${key}: ${value}`));
  let next = setHeader(content, "status", "complete");
  next = setHeader(next, "last-updated", date);
  next = setHeader(next, "next-step", '""');
  if (followups.length) {
    const lines = followups.map((g) => `- ${g.code}: ${g.detail}${g.paths?.length ? ` (${g.paths.join(", ")})` : ""} — accepted ${date}`);
    next = `${next.replace(/\s+$/, "")}\n\n## Follow-ups (accepted at ship)\n\n${lines.join("\n")}\n`;
  }
  return next;
}

// `## <version> (unreleased)` → `## <version> (<date>)` in CHANGELOG.md, one product commit.
function stampChangelog(dir, version, date, act, previous = null) {
  const file = path.join(dir, "CHANGELOG.md");
  const before = fs.readFileSync(file, "utf8");
  const from = previous ? `## ${version} (${previous})` : `## ${version} (unreleased)`;
  if (!before.includes(from)) return;
  fs.writeFileSync(file, before.replace(from, `## ${version} (${date})`));
  gitRun(dir, ["add", "--", "CHANGELOG.md"]);
  const commit = gitRun(dir, ["commit", "-q", "-m", `chore(release): stamp CHANGELOG ${version} (${date})`]);
  if (!commit.ok) emit({ status: "failed", reason: "commit-failed", message: `git -C ${dir} commit (changelog stamp): ${commit.stderr}` }, 3);
  act("changelog-stamp", `CHANGELOG.md "## ${version} (${previous ?? "unreleased"})" stamped (${date}) at ${dir}`);
}

// First 12 hex characters of SHA-256 over the canonical JSON of the accepted gap set,
// so the token survives the CLI's own later commits and dies with any change to the gaps.
function confirmTokenFor(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalizeJson(payload))).digest("hex").slice(0, 12);
}

function roadmapPathOnRef(layout, ref, type, slug) {
  const top = type === "feature" ? layout.config.artifacts.features : layout.config.artifacts.issues;
  return layout.agit("ls-tree", "-r", "--name-only", ref, `${top}/`).split("\n").find((p) => p.endsWith(`/${slug}/roadmap.md`)) ?? null;
}

// `- [ ] N.M (manual, post-ship) text — verify: …` lines of a roadmap.
function parseRoadmapSteps(content) {
  return [...content.matchAll(/^- \[( |x)\] (\d+\.\d+) (.*)$/gm)].map(([, mark, id, text]) => ({
    id,
    text,
    ticked: mark === "x",
    manual: /^\(manual/.test(text),
    postShip: text.startsWith("(manual, post-ship)"),
  }));
}

// --- model profiles --------------------------------------------------------

const MODELS_HINT =
  "pinned files are marked skip-worktree; a git pull or merge that touches one stops with 'Your local changes … would be overwritten': run `models clear`, then `git pull`, then `models apply <name>` again";

// The files a profile rewrites, relative to the plugin root: every agent, every
// prompt, and each prompt's commands/<name>.md mirror (what plugin mode reads).
function modelTargetFiles(pluginRoot) {
  const list = (rel, suffix) => {
    const dir = path.join(pluginRoot, rel);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => `${rel}/${f}`) : [];
  };
  const read = (file) => fs.readFileSync(path.join(pluginRoot, file), "utf8");
  const agents = list(".github/agents", ".agent.md").map((file) => ({ file, name: frontmatterField(read(file), "name"), handoffs: handoffTargets(read(file)) }));
  const prompts = list(".github/prompts", ".prompt.md").map((file) => ({ file, name: path.basename(file, ".prompt.md"), agent: frontmatterField(read(file), "agent") }));
  const mirrors = {};
  for (const prompt of prompts) {
    const mirror = `commands/${prompt.name}.md`;
    if (fs.existsSync(path.join(pluginRoot, mirror))) mirrors[prompt.file] = mirror;
  }
  const files = [...agents.map((a) => a.file), ...prompts.flatMap((p) => (mirrors[p.file] ? [p.file, mirrors[p.file]] : [p.file]))];
  return { agents, prompts, mirrors, files };
}

function loadProfiles() {
  const file = profilesFile();
  const exists = fs.existsSync(file);
  if (!exists) return { profilesFile: { path: file, exists }, profiles: {}, errors: [] };
  const { profiles, errors } = parseProfiles(fs.readFileSync(file, "utf8"));
  return { profilesFile: { path: file, exists }, profiles, errors };
}

// Resolved targets (mirrors included) plus every error that blocks applying `name`.
function resolveProfile(loaded, name, layout) {
  const parseErrors = errorsFor(loaded.errors, name);
  if (parseErrors.length) return { targets: [], handoffs: {}, errors: parseErrors };
  const { targets, handoffs, errors } = resolveTargets({ profile: loaded.profiles[name], agents: layout.agents, prompts: layout.prompts });
  const withMirrors = targets.flatMap((t) => (layout.mirrors[t.file] ? [t, { file: layout.mirrors[t.file], value: t.value }] : [t]));
  return { targets: withMirrors, handoffs, errors: errors.map((e) => `profiles.${name}.${e}`) };
}

function gitShowHead(pluginRoot, file) {
  try {
    return execFileSync("git", ["-C", pluginRoot, "show", `HEAD:./${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// The derived state every `models` verb reports: no journal, read from the files.
function modelsState(pluginRoot, loaded) {
  const layout = modelTargetFiles(pluginRoot);
  const current = Object.fromEntries(layout.files.map((f) => [f, readModel(fs.readFileSync(path.join(pluginRoot, f), "utf8"))]));
  const names = loaded.errors.some((e) => !e.startsWith("profiles.")) ? [] : Object.keys(loaded.profiles);
  const resolved = names.map((name) => ({ name, ...resolveProfile(loaded, name, layout) }));
  const active = detectActive({ profiles: resolved.filter((p) => !p.errors.length), current });
  const isGit = git(pluginRoot, "rev-parse", "--show-toplevel") !== "";
  let skipWorktree = null;
  let tracked = new Set();
  let dirty = [];
  if (isGit) {
    const entries = git(pluginRoot, "ls-files", "-v", "--", ...layout.files).split("\n").filter(Boolean);
    tracked = new Set(entries.map((l) => l.slice(2)));
    skipWorktree = entries.filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
    dirty = layout.files.filter((f) => {
      if (!tracked.has(f)) return false;
      const head = gitShowHead(pluginRoot, f);
      return head !== null && differsBeyondModel(head, fs.readFileSync(path.join(pluginRoot, f), "utf8"));
    });
  }
  return { layout, current, resolved, active, isGit, tracked, skipWorktree, dirty };
}

// The main checkout when `pluginRoot` is a linked worktree (e.g. an Agento
// development worktree), else null.
function primaryCheckoutOf(pluginRoot) {
  const [gitDir, commonDir] = git(pluginRoot, "rev-parse", "--git-dir", "--git-common-dir").split("\n");
  if (!gitDir || !commonDir) return null;
  const common = path.resolve(pluginRoot, commonDir);
  if (path.resolve(pluginRoot, gitDir) === common) return null;
  return path.basename(common) === ".git" ? path.dirname(common) : common;
}

function modelsReport(pluginRoot, loaded, state) {
  return {
    profilesFile: loaded.profilesFile,
    pluginRoot,
    active: state.active,
    skipWorktree: state.skipWorktree,
    dirty: state.dirty,
    hint: MODELS_HINT,
  };
}

// The pin each agent file currently carries, read from the plugin root's files:
// { alias: { name, file, model, subagentModel } }. `model` is the parsed top-level
// pin (a string, a list, or null); `subagentModel` is the string or the first entry
// of a list; both are null when the agent is unpinned.
function modelsPins(pluginRoot) {
  const pins = {};
  for (const [alias, file] of Object.entries(AGENT_ALIASES)) {
    const rel = `.github/agents/${file}`;
    const abs = path.join(pluginRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const model = parseModelValue(text);
    pins[alias] = { name: frontmatterField(text, "name"), file: rel, model, subagentModel: Array.isArray(model) ? model[0] : model };
  }
  return pins;
}

// The pin a profile resolves for one agent alias, or null.
function agentTargetValue(targets, alias) {
  return targets.find((t) => t.file === `.github/agents/${AGENT_ALIASES[alias]}`)?.value ?? null;
}

// Model warnings for a resolved target set: the Decision 2 BYOK tier warning, then
// the unqualified-value warning over the profile's own entries (none for clear).
function tierWarnings(targets, profile = null) {
  const byok = byokTierWarning({ autopilot: agentTargetValue(targets, "autopilot"), builder: agentTargetValue(targets, "builder"), reviewer: agentTargetValue(targets, "reviewer") });
  const entries = profile
    ? [
        ...(profile.default !== undefined ? [{ where: "default", value: profile.default }] : []),
        ...Object.entries(profile.agents ?? {}).map(([alias, value]) => ({ where: alias, value })),
        ...Object.entries(profile.prompts ?? {}).map(([prompt, value]) => ({ where: `prompts.${prompt}`, value })),
      ]
    : [];
  return [byok, unqualifiedWarning(entries)].filter(Boolean);
}

// The same two warnings over the agents' current pins (`models pins`, doctor).
function pinWarnings(pins) {
  return {
    byok: byokTierWarning({ autopilot: pins.autopilot?.model, builder: pins.builder?.model, reviewer: pins.reviewer?.model }),
    unqualified: unqualifiedWarning(Object.entries(pins).map(([alias, pin]) => ({ where: alias, value: pin.model }))),
  };
}

// --- release ---------------------------------------------------------------

const RELEASE_EXIT = { success: 0, "superseded-success": 0, "not-triggered": 0, "not-configured": 0, pending: 2, "dispatch-required": 2, failed: 4, "no-run": 4 };
const RELEASE_STATUS = { 0: "ok", 2: "pending", 4: "failed" };

class GhFailure extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// `{owner}/{repo}` placeholders are filled in by gh from the cwd's git remote.
function ghApi(apiPath, { notFound = "gh-error" } = {}) {
  let out;
  try {
    out = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github+json", apiPath], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
  } catch (error) {
    if (error?.code === "ENOENT") throw new GhFailure("gh-missing", "gh CLI not found on PATH; install GitHub CLI, then re-run");
    const stderr = (error?.stderr ?? "").toString().trim();
    const first = stderr.split("\n")[0] || error?.message || "unknown error";
    if (/HTTP 401|HTTP 403|not logged in|authentication|gh auth login/i.test(stderr)) {
      throw new GhFailure("auth", `gh is not authenticated for this repository (${first}); run \`gh auth login\` in your own terminal, then re-run`);
    }
    if (/HTTP 404|HTTP 422/.test(stderr)) {
      if (notFound === null) return null;
      if (notFound === "unknown-sha") throw new GhFailure("unknown-sha", `GitHub does not know the commit: ${first}`);
    }
    if (error?.code === "ETIMEDOUT") throw new GhFailure("gh-error", `gh api ${apiPath} timed out after 15 s`);
    throw new GhFailure("gh-error", `gh api ${apiPath} failed: ${first}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new GhFailure("gh-error", `gh api ${apiPath} returned non-JSON output`);
  }
}

const runSummary = (run) => (run ? { id: run.id, event: run.event, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null, headSha: run.head_sha } : null);

function once(fn) {
  let done = false;
  let value;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

// The immutable facts about a merge commit, fetched at most once per call.
function releaseContext(workflow, shaArg) {
  const commit = ghApi(`repos/{owner}/{repo}/commits/${shaArg}`, { notFound: "unknown-sha" });
  const sha = commit.sha;
  const mergeDate = commit.commit?.committer?.date ?? null;
  const parent = commit.parents?.[0]?.sha ?? null;
  const runs = `repos/{owner}/{repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const diff = once(() => (parent ? ghApi(`repos/{owner}/{repo}/compare/${parent}...${sha}`) : null));
  const descendants = new Map();
  return {
    sha,
    mergeDate,
    exactRunsPath: `${runs}?head_sha=${sha}&per_page=100`,
    laterRunsPath: `${runs}?branch=${encodeURIComponent(config.branches.default)}&event=push&created=${encodeURIComponent(`>=${mergeDate}`)}&per_page=100`,
    // A missing or non-file workflow is treated as unparsed: wait for a run rather than declare none needed.
    triggers: once(() => {
      if (!/\.ya?ml$/.test(workflow)) return { push: null, dispatch: false, unparsed: true };
      const file = ghApi(`repos/{owner}/{repo}/contents/.github/workflows/${encodeURIComponent(workflow)}?ref=${sha}`, { notFound: null });
      if (!file?.content) return { push: null, dispatch: false, unparsed: true };
      return parseWorkflowTriggers(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString("utf8"));
    }),
    files: () => (diff()?.files ?? []).map((f) => f.filename),
    // GitHub caps compare files[] at 300; a root commit has no parent diff at all.
    filesTruncated: () => !diff() || (diff().files?.length ?? 0) >= 300,
    descendantOf: (head) => {
      if (!descendants.has(head)) descendants.set(head, ghApi(`repos/{owner}/{repo}/compare/${sha}...${head}`).status);
      return descendants.get(head);
    },
  };
}

function releaseSnapshot(ctx) {
  return deriveReleaseVerdict({
    sha: ctx.sha,
    defaultBranch: config.branches.default,
    mergeDate: ctx.mergeDate,
    now: Date.now(),
    exactRuns: () => ghApi(ctx.exactRunsPath).workflow_runs ?? [],
    laterRuns: () => ghApi(ctx.laterRunsPath).workflow_runs ?? [],
    triggers: ctx.triggers,
    files: ctx.files,
    filesTruncated: ctx.filesTruncated,
    descendantOf: ctx.descendantOf,
  });
}

// The `release` document and its exit code for a merge commit: one snapshot, then
// bounded polls while `pending` (dispatch-required never loops: only the caller can
// start that run). Shared by `case "release"` and the ship release phase.
function releaseVerdict(shaArg, { wait = 0, interval = 10 } = {}) {
  const workflow = config.checks?.releaseWorkflow ?? null;
  const base = { status: "ok", verdict: null, sha: shaArg, workflow, run: null, supersededBy: null, reason: null, mergeDate: null, graceSeconds: GRACE_SECONDS, polls: 0, waitedSeconds: 0 };
  if (!workflow) return { fields: { ...base, verdict: "not-configured", reason: "checks.releaseWorkflow is not set; there is no release to wait for" }, code: 0 };
  try {
    if (!ghVersion().ok) throw new GhFailure("gh-missing", "gh CLI not found on PATH; install GitHub CLI, then re-run");
    const ctx = releaseContext(workflow, shaArg);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    let result = releaseSnapshot(ctx);
    let polls = 1;
    let waited = 0;
    while (result.verdict === "pending" && waited + interval <= wait) {
      Atomics.wait(sleeper, 0, 0, interval * 1000);
      waited += interval;
      result = releaseSnapshot(ctx);
      polls += 1;
    }
    const code = RELEASE_EXIT[result.verdict];
    return { fields: { ...base, status: RELEASE_STATUS[code], verdict: result.verdict, sha: ctx.sha, run: runSummary(result.run), supersededBy: runSummary(result.supersededBy), reason: result.reason, mergeDate: ctx.mergeDate, polls, waitedSeconds: waited }, code };
  } catch (error) {
    if (!(error instanceof GhFailure)) throw error;
    return { fields: { ...base, status: "error", reason: error.reason, message: error.message }, code: 3 };
  }
}

// --- documents -------------------------------------------------------------

const STATUS_ORDER = ["in-progress", "paused", "in-review", "planned", "complete"];
const byStatusOrder = (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.slug.localeCompare(b.slug);

// What `status` emits. `lookup` as in sessionRecord; `roadmaps` replaces the walk.
function statusDocument({ typeFilter = null, slugFilter = null, pr: withPr = false, lookup = lookupPullRequest, roadmaps = null } = {}) {
  const worktrees = productWorktrees();
  const sessionWorktreesDir = primaryWorktreesDir(worktrees);
  const items = (roadmaps ?? allRoadmaps(typeFilter, managedHalves(worktrees))).filter((r) => !slugFilter || r.slug === slugFilter);
  const bySlug = new Map();
  for (const item of items) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item.roadmap]);
  const duplicates = [...bySlug.entries()].filter(([, paths]) => paths.length > 1).map(([slug, paths]) => ({ slug, paths }));
  items.sort(byStatusOrder);
  // Additive dashboard fields (lifecycle, ownership, PR state) so renderers never re-derive them.
  const warnings = [];
  const layout = checkoutLayout();
  for (const item of items) {
    // Complete roadmaps skip the lookup: their PRs are merged history, not dashboard state.
    const looked = withPr && item.status !== "complete";
    const { pr, warnings: prWarnings } = looked ? lookup(item.branch) : { pr: null, warnings: [] };
    const { pr: companionPr, warnings: companionPrWarnings } = looked ? lookupCompanionPullRequest(item.branch, layout, lookup) : { pr: null, warnings: [] };
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
  return {
    status: "ok",
    root,
    currentBranch,
    defaultBranch: config.branches.default,
    items,
    duplicates,
    resumable: items.filter((i) => ["in-progress", "paused", "in-review"].includes(i.status)).map((i) => i.slug),
    lifecycles: LIFECYCLES,
    warnings,
  };
}

// The roadmaps `initiative` derives from. Same bases as `status`: a member planned on
// an unmerged delivery branch lives only in its managed half and must not stay
// "unplanned"/ready here (the Initiatives view would otherwise keep its plan play
// button, which starts a second session instead of offering build/ap).
const initiativeRoadmaps = () => allRoadmaps("feature", managedHalves(productWorktrees()));

// What `initiative` emits.
function initiativeListDocument(roadmaps, breakdowns = allBreakdowns()) {
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
  return { status: "ok", initiativesRoot: config.artifacts.initiatives, items, root, configSource: source };
}

// What `initiative <slug>` emits.
function initiativeDetailDocument(slug, roadmaps, breakdowns = allBreakdowns()) {
  const breakdown = breakdowns.find((b) => b.slug === slug);
  if (!breakdown) return { status: "missing", message: `No breakdown.md for initiative ${slug} under ${config.artifacts.initiatives}/.`, root, configSource: source };
  const derived = deriveInitiative(breakdown, roadmaps);
  return {
    ...derived,
    initiative: { slug: breakdown.slug, dir: breakdown.dir, breakdown: breakdown.breakdown, created: breakdown.created, lastUpdated: breakdown.lastUpdated },
    anomalies: mergedAnomalies(derived.features),
    root,
    configSource: source,
  };
}

// What `doctor [--for <command>]` emits; `command` must name a COMMAND_NEEDS entry.
function doctorDocument(command = null) {
  const needs = command ? COMMAND_NEEDS[command] : null;
  const { status, checks } = runDoctor(needs ? checksFor(needs) : Object.keys(DOCTOR_CHECKS));
  return { status, for: needs ? { command, needs } : null, checks, root, configSource: source };
}

// --- metrics: git history only, never gh, never network ------------------------

// Fixed diff output whatever the user's git config says (prefixes, colour, external diff, renames).
const METRICS_PATCH = ["--reverse", "--format=%x00commit %H %cI", "-p", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
const METRICS_MAX_BUFFER = 256 * 1024 * 1024;

// origin/<default>, else <default>, else HEAD — in the clone `g` binds.
function defaultRefIn(g) {
  const name = config.branches.default;
  if (g("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`)) return `origin/${name}`;
  if (g("rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) return name;
  return "HEAD";
}

// The git logs `metrics` reads, as [cwd, args] pairs: one patch log over every
// roadmap.md/review.md on the artifact default ref, one branch-only patch log per
// non-complete item whose delivery branch resolves, one first-parent merge log of
// the product default.
function metricsPlan(roadmaps) {
  const artifactRef = defaultRefIn(agit);
  const productRef = artifacts.external ? defaultRefIn((...args) => git(root, ...args)) : artifactRef;
  const pathspecs = [config.artifacts.features, config.artifacts.issues].flatMap((r) => [`:(glob)${r}/**/roadmap.md`, `:(glob)${r}/**/review.md`]);
  const branches = [];
  for (const record of roadmaps) {
    if (record.status === "complete" || !record.branch) continue;
    const { ref } = refFor(record.branch, agit);
    if (ref === "HEAD") continue;
    branches.push({ roadmap: record.roadmap, ref, run: [artifactsRoot, ["log", ref, "--not", artifactRef, ...METRICS_PATCH, "--", `${record.dir}/roadmap.md`, `${record.dir}/review.md`]] });
  }
  return {
    ref: { artifacts: artifactRef, product: productRef },
    artifacts: [artifactsRoot, ["log", artifactRef, ...METRICS_PATCH, "--", ...pathspecs]],
    branches,
    product: [root, ["log", "--first-parent", "--merges", productRef, "--format=%H%x09%cI%x09%s"]],
  };
}

// A missing ref or a failed log reads as no history (the items then carry warnings).
function gitLogText(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: METRICS_MAX_BUFFER });
  } catch {
    return "";
  }
}

async function gitLogTextAsync(cwd, args) {
  try {
    return (await execAsync("git", ["-C", cwd, ...args], { maxBuffer: METRICS_MAX_BUFFER })).stdout;
  } catch {
    return "";
  }
}

function readMetricsLogs(plan) {
  return {
    artifacts: gitLogText(...plan.artifacts),
    branches: new Map(plan.branches.map((b) => [b.roadmap, gitLogText(...b.run)])),
    product: gitLogText(...plan.product),
  };
}

async function readMetricsLogsAsync(plan) {
  const [artifactsText, productText, ...branchTexts] = await Promise.all([plan.artifacts, plan.product, ...plan.branches.map((b) => b.run)].map((run) => gitLogTextAsync(...run)));
  return { artifacts: artifactsText, branches: new Map(plan.branches.map((b, i) => [b.roadmap, branchTexts[i]])), product: productText };
}

// What `metrics [<slug>]` emits. `roadmaps` replaces the walk; `plan` and `logs` are
// the dashboard's injection point (it reads the logs asynchronously beside its PR lookups).
function metricsDocument({ slugFilter = null, roadmaps = null, now = Date.now(), plan = null, logs = null } = {}) {
  const records = [...(roadmaps ?? allRoadmaps(null, managedHalves(productWorktrees())))].filter((r) => !slugFilter || r.slug === slugFilter).sort(byStatusOrder);
  if (slugFilter && !records.length) return { status: "missing", message: `No roadmap for slug ${slugFilter} under ${config.artifacts.features}/ or ${config.artifacts.issues}/.`, root, configSource: source };
  const planned = plan ?? metricsPlan(records);
  const read = logs ?? readMetricsLogs(planned);
  const byDir = parseArtifactLog(read.artifacts);
  const merged = parseMergeLog(read.product);
  const items = records.map((record) => {
    const branch = planned.branches.find((b) => b.roadmap === record.roadmap);
    const events = [...(byDir.get(record.dir) ?? [])];
    if (branch) events.push(...(parseArtifactLog(read.branches.get(record.roadmap) ?? "").get(record.dir) ?? []));
    return deriveMetrics({ record, events, merged, now, ref: branch?.ref ?? planned.ref.artifacts });
  });
  return { status: "ok", generatedAt: new Date(now).toISOString(), ref: planned.ref, items, aggregate: aggregateMetrics(items), root, configSource: source };
}

// What `dashboard` emits: the session, doctor, status (`deliveries`), initiative, and
// metrics documents from one process. The roadmaps are walked once for deliveries,
// initiatives, and metrics; every PR lookup (with `pr`) and the doctor's probes run
// through one bounded pool, and the metrics git logs run beside it, while the local
// doctor checks and the initiatives are computed. A section that throws becomes
// { status: "error", message }.
async function dashboardDocument({ pr: withPr = false } = {}) {
  const started = performance.now();
  const attempt = (build) => {
    try {
      return { value: build() };
    } catch (error) {
      return { error };
    }
  };
  const session = attempt(() => sessionContext());
  const roadmaps = attempt(() => allRoadmaps(null, managedHalves(productWorktrees())));

  const requests = [];
  if (withPr) {
    const layout = checkoutLayout();
    const branches = [session.value?.prBranch, ...(roadmaps.value ?? []).filter((r) => r.status !== "complete").map((r) => r.branch)];
    for (const branch of branches) {
      requests.push({ branch, cwd: root, label: "pr" });
      if (layout.artifacts.external) requests.push({ branch, cwd: layout.artifactsRoot, label: "companionPr" });
    }
  }
  const timings = {};
  const section = (name, build) => {
    const sectionStarted = performance.now();
    try {
      return build();
    } catch (error) {
      return { status: "error", message: error?.message ?? String(error) };
    } finally {
      timings[name] = Math.round(performance.now() - sectionStarted);
    }
  };
  const valueOf = (attempted) => {
    if (attempted.error) throw attempted.error;
    return attempted.value;
  };

  // The lookups wait on `gh --version`; with it cached they spawn on the next turn,
  // before the synchronous work below blocks the event loop.
  if (requests.length) await probeAsync("gh", ["--version"]);
  const prefetch = lookupPullRequests(requests, { probes: doctorProbes() });
  // The metrics logs (git only) overlap the PR lookups and the synchronous sections below.
  const metricsPlanned = attempt(() => metricsPlan(valueOf(roadmaps)));
  const metricsLogs = metricsPlanned.error ? Promise.resolve(null) : readMetricsLogsAsync(metricsPlanned.value);
  await new Promise((resolve) => setImmediate(resolve));
  const initiatives = section("initiatives", () => {
    const features = valueOf(roadmaps).filter((r) => r.type === "feature");
    const breakdowns = allBreakdowns();
    const list = initiativeListDocument(features, breakdowns);
    return { list, details: Object.fromEntries(list.items.map((item) => [item.slug, initiativeDetailDocument(item.slug, features, breakdowns)])) };
  });
  runDoctor(LOCAL_DOCTOR_CHECKS);
  const lookup = prefetchedLookup(await prefetch);
  const logs = await metricsLogs;

  const document = {
    status: "ok",
    session: section("session", () => sessionRecord({ pr: withPr, lookup }, valueOf(session))),
    doctor: section("doctor", () => doctorDocument()),
    // statusDocument adds fields to its items; the initiatives read the records unchanged.
    deliveries: section("deliveries", () => statusDocument({ pr: withPr, lookup, roadmaps: valueOf(roadmaps).map((r) => ({ ...r })) })),
    initiatives,
    metrics: section("metrics", () => metricsDocument({ roadmaps: valueOf(roadmaps), plan: valueOf(metricsPlanned), logs })),
  };
  timings.total = Math.round(performance.now() - started);
  return { ...document, timings, root, configSource: source };
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
      config: { ...config, artifacts: { ...config.artifacts, repo: { name: artifacts.name, dir: artifacts.dir } }, worktrees: { dir: primaryWorktreesDir() } },
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
    emit(statusDocument({ typeFilter, slugFilter, pr: Boolean(options.pr) }));
    break;
  }

  case "close-decision": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    const worktreeList = productWorktreeText();
    const { decision, layout } = decideWithLayout(type, slug, (l) =>
      closeBuildSessionDecision({ type, slug, currentBranch, worktreeList, git: l.artifactsGit, rootDir: root, artifactsRoot: l.artifactsRoot, config: l.config }),
    );
    if (decision.status !== "ok") withExit(withLayout(decision, layout));
    const companion = companionOfOwner(decision.owner, layout);
    const gaps = companionGaps(companion);
    if (gaps.length) {
      withExit(
        withLayout(
          {
            status: "error",
            reason: "companion-unpushed",
            owner: decision.owner,
            companion,
            message: companionGapMessage(companion, gaps, type, slug),
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
    const worktreeList = productWorktreeText();
    const { decision: preflight, layout } = decideWithLayout(type, slug, (l) =>
      evaluateShipPreflight({ type, slug, rootDir: root, artifactsRoot: l.artifactsRoot, currentBranch, git: l.artifactsGit, config: l.config, worktreeList }),
    );
    if (preflight.status !== "ok") withExit(withLayout(preflight, layout));
    const companion = companionOfOwner(preflight.owner, layout);
    const gaps = companionGaps(companion);
    const ownerTree = ownerTreeOf(preflight.owner);
    const companionTree = companionTreeOf(companion);
    if (!options.pr) withExit(withLayout({ ...preflight, companion, companionGaps: gaps, ownerTree, companionTree }, layout));
    const { pr, warnings: prWarnings } = lookupPullRequest(preflight.branch);
    const { pr: companionPr, warnings: companionPrWarnings } = lookupCompanionPullRequest(preflight.branch, layout);
    // A MERGED companion PR is the resume-at-teardown case, not a gap.
    if (layout.artifacts.external) {
      if (!companionPr) gaps.push("missing-pr");
      else if (companionPr.state === "CLOSED") gaps.push("pr-not-open");
      else if (companionPr.mergeStateStatus === "CONFLICTING") gaps.push("conflicting-pr");
    }
    withExit(withLayout({ ...preflight, companion, companionGaps: gaps, ownerTree, companionTree, pr, companionPr, warnings: [...prWarnings, ...companionPrWarnings] }, layout));
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
    const resolved = resolveSessionPaths(kind, id);
    const companionList = resolved.companion ? resolved.layout.companionWorktrees : [];
    const stateOf = (halfPath, own, expectedOrigin) => {
      const onDisk = fs.existsSync(halfPath);
      return halfState({ path: halfPath, own, worktrees: resolved.productWorktrees, companionWorktrees: companionList, origin: onDisk ? originOf(halfPath) : null, expectedOrigin, onDisk });
    };
    emit({
      status: "ok",
      worktreesDir: primaryWorktreesDir(resolved.productWorktrees),
      worktree: resolved.worktree,
      // Post-`git worktree add` check: on disk, registered in the right clone, right origin.
      worktreeState: stateOf(resolved.worktree, "product", originOf(root)),
      branch: resolved.branch,
      artifactsRoot: resolved.layout.artifactsRoot,
      artifactRoot: resolved.artifactRel === null ? null : path.join(resolved.layout.artifactsRoot, resolved.artifactRel),
      layout: resolved.layout.layout,
      defaultBranch: config.branches.default,
      postShipBranch: kind === "plan" || kind === "freehand" ? null : `${config.branches.postShip}${id}`,
      // Companion mode: the paired companion half (same <kind>-<id>, same branch) and the
      // two-folder workspace file the session opens; both null in the in-repo layout.
      companion: resolved.companion && { ...resolved.companion, state: stateOf(resolved.companion.worktree, "companion", originOf(resolved.layout.artifactsRoot)) },
      workspace: resolved.workspace,
    });
    break;
  }

  case "workspace": {
    const kind = rest[0];
    const id = rest[1];
    if (!["feature", "issue", "plan", "freehand"].includes(kind)) usage("workspace kind must be feature, issue, plan, or freehand");
    requireSlug(id);
    const resolved = resolveSessionPaths(kind, id);
    if (!resolved.layout.artifacts.external || !resolved.workspace || !resolved.companion) {
      emit({ status: "not-applicable", message: "workspace is only available in companion mode (artifacts.repo set)", root, configSource: source });
    }
    const folders = [
      { path: resolved.worktree, exists: fs.existsSync(resolved.worktree) },
      { path: resolved.companion.worktree, exists: fs.existsSync(resolved.companion.worktree) },
    ];
    const { exists, current, autoApprove, document, written } = writeSessionWorkspace(resolved, { write: Boolean(options.write) });
    emit({
      status: "ok",
      path: resolved.workspace,
      exists,
      current,
      autoApprove,
      folders,
      settings: document.settings,
      written,
      root,
      configSource: source,
    });
    break;
  }

  case "initiative": {
    const slug = rest[0] ? requireSlug(rest[0]) : null;
    const roadmaps = initiativeRoadmaps();
    const document = slug ? initiativeDetailDocument(slug, roadmaps) : initiativeListDocument(roadmaps);
    emit(document, document.status === "ok" ? 0 : 3);
    break;
  }

  case "metrics": {
    if (rest.length > 1) usage(`metrics takes at most one slug, got ${JSON.stringify(rest.slice(1).join(" "))}`);
    const document = metricsDocument({ slugFilter: rest[0] ? requireSlug(rest[0]) : null });
    emit(document, document.status === "ok" ? 0 : 3);
    break;
  }

  case "session": {
    if (rest.length) usage(`session takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    emit(sessionRecord({ pr: Boolean(options.pr) }));
    break;
  }

  case "start-session": {
    startSession();
    break;
  }

  case "close-session": {
    closeSession();
    break;
  }

  case "ship": {
    ship();
    break;
  }

  case "doctor": {
    if (rest.length) usage(`doctor takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    if (options.for && !COMMAND_NEEDS[options.for]) usage(`--for: unknown command ${options.for}; known: ${Object.keys(COMMAND_NEEDS).join(", ")}`);
    const document = doctorDocument(options.for ?? null);
    // warn is usable (exit 0); only a failed hard requirement is a resolution failure (exit 3).
    emit(document, document.status === "fail" ? 3 : 0);
    break;
  }

  case "dashboard": {
    if (rest.length) usage(`dashboard takes no positional arguments, got ${JSON.stringify(rest[0])}`);
    emit(await dashboardDocument({ pr: Boolean(options.pr) }));
    break;
  }

  case "next": {
    if (rest.length > 1) usage(`next takes at most one slug, got ${JSON.stringify(rest.slice(1).join(" "))}`);
    const requestedSlug = rest[0] ? requireSlug(rest[0]) : null;
    const worktrees = productWorktrees();
    const sessionWorktreesDir = primaryWorktreesDir(worktrees);
    const { role, worktree, reason: hostedReason } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir: sessionWorktreesDir, config, env: process.env, companionWorktreesDir });
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
    const primaryRoot = productWorktrees()[0]?.path ?? root;
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

  case "models": {
    const [verb = "list", name, ...extra] = rest;
    const verbs = { list: 0, pins: 0, show: 1, apply: 1, clear: 0, init: 0 };
    if (!Object.hasOwn(verbs, verb)) usage(`models: unknown verb ${verb}; known: ${Object.keys(verbs).join(", ")}`);
    if (extra.length || (verbs[verb] === 1 ? !name : name !== undefined)) usage(`models ${verb} takes ${verbs[verb] ? "exactly one profile name" : "no arguments"}`);
    if (verbs[verb] && !/^[a-z0-9-]+$/.test(name)) usage(`models ${verb}: profile names match [a-z0-9-]+, got ${JSON.stringify(name)}`);
    const pluginRoot = path.resolve(options.pluginRoot ?? PLUGIN_ROOT);
    if (!fs.existsSync(path.join(pluginRoot, ".github", "agents"))) usage(`--plugin-root ${pluginRoot} is not an Agento plugin clone (no .github/agents)`);
    const loaded = loadProfiles();

    if (verb === "init") {
      let created = false;
      if (!loaded.profilesFile.exists) {
        const template = path.join(pluginRoot, "templates", "model-profiles.json");
        if (!fs.existsSync(template)) emit({ status: "missing", verb, message: `${template} not found`, profilesFile: loaded.profilesFile, pluginRoot }, 3);
        fs.mkdirSync(path.dirname(loaded.profilesFile.path), { recursive: true });
        fs.copyFileSync(template, loaded.profilesFile.path, fs.constants.COPYFILE_EXCL);
        created = true;
      }
      const reloaded = loadProfiles();
      emit({ status: "ok", verb, created, ...modelsReport(pluginRoot, reloaded, modelsState(pluginRoot, reloaded)) });
    }

    const state = modelsState(pluginRoot, loaded);
    if (verb === "list") {
      const fileErrors = loaded.errors.filter((e) => !e.startsWith("profiles."));
      const profiles = Object.keys(loaded.profiles).map((n) => ({
        name: n,
        description: typeof loaded.profiles[n]?.description === "string" ? loaded.profiles[n].description : null,
        errors: state.resolved.find((p) => p.name === n)?.errors ?? errorsFor(loaded.errors, n),
      }));
      emit({ status: "ok", verb, profiles, errors: fileErrors, ...modelsReport(pluginRoot, loaded, state) });
    }

    if (verb === "show") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const { targets, errors } = resolveProfile(loaded, name, state.layout);
      const description = typeof loaded.profiles[name]?.description === "string" ? loaded.profiles[name].description : null;
      const warnings = tierWarnings(targets, loaded.profiles[name]);
      emit({ status: errors.length ? "invalid" : "ok", verb, profile: name, description, targets, errors, warnings, ...modelsReport(pluginRoot, loaded, state) }, errors.length ? 3 : 0);
    }

    if (verb === "pins") {
      const pins = modelsPins(pluginRoot);
      const { byok, unqualified } = pinWarnings(pins);
      const warnings = [byok, unqualified].filter(Boolean);
      emit({ status: "ok", verb, pins, warnings, ...modelsReport(pluginRoot, loaded, state) });
    }

    // apply | clear
    let targets = state.layout.files.map((file) => ({ file, value: null }));
    let handoffs = null;
    if (verb === "apply") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const resolved = resolveProfile(loaded, name, state.layout);
      if (resolved.errors.length) emit({ status: "invalid", verb, profile: name, errors: resolved.errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const primaryCheckout = state.isGit ? primaryCheckoutOf(pluginRoot) : null;
      if (primaryCheckout) {
        emit({ status: "worktree", verb, profile: name, primaryCheckout, message: `${pluginRoot} is a linked worktree of ${primaryCheckout}, not the registered plugin clone; skip-worktree would hide edits made here — apply to the clone with --plugin-root ${primaryCheckout}`, ...modelsReport(pluginRoot, loaded, state) }, 3);
      }
      if (state.dirty.length) {
        emit({ status: "dirty", verb, profile: name, message: "these files differ from HEAD beyond their model: lines; skip-worktree would hide those edits — commit, stash, or restore them first", ...modelsReport(pluginRoot, loaded, state) }, 3);
      }
      targets = resolved.targets;
      handoffs = resolved.handoffs;
    }
    const writes = [];
    for (const { file, value } of targets) {
      const abs = path.join(pluginRoot, file);
      const before = fs.readFileSync(abs, "utf8");
      let after;
      try {
        after = setModel(before, value);
        after = setHandoffModels(after, handoffs === null ? null : handoffs[file]);
      } catch (error) {
        emit({ status: "invalid", verb, profile: name ?? null, errors: [`${file}: ${error.message}`], ...modelsReport(pluginRoot, loaded, state) }, 3);
      }
      if (after !== before) writes.push({ file, abs, after });
    }
    for (const w of writes) fs.writeFileSync(w.abs, w.after);
    if (state.isGit) {
      const flagged = new Set(state.skipWorktree);
      const tracked = targets.filter((t) => state.tracked.has(t.file));
      const hasHandoffPin = (file) => (handoffs?.[file] ?? []).some((h) => h.value !== null);
      const pin = tracked.filter((t) => (t.value !== null || hasHandoffPin(t.file)) && !flagged.has(t.file)).map((t) => t.file);
      const unpin = tracked.filter((t) => t.value === null && !hasHandoffPin(t.file) && flagged.has(t.file)).map((t) => t.file);
      for (const [flag, files] of [["--skip-worktree", pin], ["--no-skip-worktree", unpin]]) {
        if (!files.length) continue;
        try {
          execFileSync("git", ["-C", pluginRoot, "update-index", flag, "--", ...files], { stdio: ["ignore", "ignore", "pipe"] });
        } catch (error) {
          emit({ status: "failed", verb, profile: name ?? null, changed: writes.map((w) => w.file), message: `git update-index ${flag} failed: ${(error?.stderr ?? "").toString().trim() || error.message}; re-run the same command` }, 3);
        }
      }
    }
    emit({ status: "ok", verb, profile: name ?? null, changed: writes.map((w) => w.file), warnings: tierWarnings(targets, verb === "apply" ? loaded.profiles[name] : null), ...modelsReport(pluginRoot, loaded, modelsState(pluginRoot, loaded)) });
    break;
  }

  case "release": {
    const [shaArg, ...extra] = rest;
    if (!shaArg || extra.length) usage("release takes exactly one <merge-sha>");
    if (!/^[0-9a-f]{7,40}$/.test(shaArg)) usage(`release: <merge-sha> must be 7-40 lowercase hex characters, got ${JSON.stringify(shaArg)}`);
    const { fields, code } = releaseVerdict(shaArg, { wait: options.wait ?? 0, interval: options.interval ?? 10 });
    emit({ ...fields, root, configSource: source }, code);
    break;
  }

  default:
    usage(command ? `unknown command ${command}` : "missing command");
}
