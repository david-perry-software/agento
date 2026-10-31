// Shared import-time context for the Agento CLI. Everything a command handler
// needs that used to be evaluated at the top of `scripts/agento.mjs` lives here,
// evaluated once per process in the same order. ES modules are singletons, so
// every importer sees the same `root`, `config`, `agit`, and so on.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentoConfig, resolveArtifactsRoot } from "../agento-config.mjs";
import { parseWorktreeList } from "../session-state.mjs";

// The `scripts/` directory (approach rule 5): pinned to this module's location so
// every file that moves still resolves the CLI dir and the plugin root identically.
export const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ROOT = path.dirname(CLI_DIR);

function usage(message) {
  const lines = fs.readFileSync(path.join(CLI_DIR, "agento.mjs"), "utf8").split("\n").slice(1);
  const comments = lines.slice(0, lines.findIndex((l) => !l.startsWith("//")));
  emit({ status: "usage-error", message, usage: comments.map((l) => l.replace(/^\/\/ ?/, "")) }, 1);
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

// Raw stdout for subcommands whose contract is plain text, not one JSON document
// (`policy` prints Markdown sections; `--list` is the JSON view).
function emitRaw(text, code = 0) {
  const buffer = Buffer.from(text, "utf8");
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
    else if (arg === "--force") options.force = true;
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--full") options.full = true;
    else if (arg === "--from") {
      options.from = argv[++i];
      if (!options.from || options.from.startsWith("--")) usage("--from takes a profile name");
    }
    else if (arg === "--description") {
      options.description = argv[++i];
      if (!options.description || options.description.startsWith("--")) usage("--description takes a value");
    }
    else if (arg === "--expect") {
      options.expect = argv[++i];
      if (!/^[0-9a-f]{64}$/.test(options.expect ?? "")) usage(`--expect takes a 64-character lowercase sha256 hash, got ${JSON.stringify(options.expect ?? "")}`);
    }
    else if (arg === "--role") {
      options.role = argv[++i];
      if (options.role !== "primary" && options.role !== "secondary") usage(`--role takes primary or secondary, got ${JSON.stringify(options.role ?? "")}`);
    }
    else if (arg === "--ignore-occupants") options.ignoreOccupants = true;
    else if (arg === "--confirm") {
      options.confirm = argv[++i];
      if (!options.confirm || options.confirm.startsWith("--")) usage("--confirm takes the confirmToken reported by the audit");
    }
    else if (arg === "--plugin-root") {
      options.pluginRoot = argv[++i];
      if (!options.pluginRoot) usage("--plugin-root takes a directory");
    }
    else if (arg === "--step") {
      options.step = argv[++i];
      if (!/^\d+\.\d+$/.test(options.step ?? "")) usage(`--step takes a roadmap step id N.M, got ${JSON.stringify(options.step ?? "")}`);
    }
    else if (arg === "--message-file") {
      options.messageFile = argv[++i];
      if (!options.messageFile || (options.messageFile.startsWith("--"))) usage("--message-file takes a file path or - (stdin)");
    }
    else if (arg === "--body-file") {
      options.bodyFile = argv[++i];
      if (!options.bodyFile || options.bodyFile.startsWith("--")) usage("--body-file takes a file path or - (stdin)");
    }
    else if (arg === "--merge") options.merge = true;
    else if (arg === "--dir" || arg === "--branch" || arg === "--title") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) usage(`${arg} takes a value`);
      options[arg.slice(2)] = value;
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
export const [command, ...rest] = positional;
export { options };
const startDir = path.resolve(options.root ?? process.cwd());
export { startDir };
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

function withExit(result) {
  emit({ ...result, root, configSource: source }, result.status === "ok" ? 0 : 3);
}

export {
  usage,
  emit,
  emitRaw,
  withExit,
  git,
  samePath,
  MANAGED_HALF,
  anchor,
  root,
  roleCwd,
  config,
  source,
  repoName,
  currentBranch,
  artifacts,
  artifactsRoot,
  artifactsGit,
  agit,
  companionWorktreesDir,
  companionWorktrees,
  productWorktreeText,
  productWorktrees,
  primaryWorktreesDir,
};
