import fs from "node:fs";
import path from "node:path";

const CONFIG_RELATIVE_PATHS = [".github/agento.json", "agento.json"];

export function defaultConfig(rootDir) {
  const repoName = path.basename(path.resolve(rootDir));
  return {
    artifacts: { features: "features", issues: "issues", initiatives: "initiatives", repo: { name: null, dir: null } },
    worktrees: { dir: path.join("..", `${repoName}-worktrees`) },
    branches: {
      default: "main",
      feature: "feature/",
      issue: "issue/",
      freehand: "changes/",
      postShip: "post-ship/",
    },
    checks: { releaseWorkflow: null },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else if (value !== undefined && value !== null) {
      // null in agento.json means "keep the default" (the template ships nulls).
      merged[key] = value;
    }
  }
  return merged;
}

// The config a JSON text denotes for `rootDir`: null keeps the default (the
// template ships nulls). Shared by the file loader and by readers of a branch's
// committed `.github/agento.json` (`git show <ref>:.github/agento.json`).
export function parseConfigText(text, rootDir) {
  return mergeConfig(defaultConfig(rootDir), JSON.parse(text));
}

export function loadAgentoConfig(rootDir) {
  for (const rel of CONFIG_RELATIVE_PATHS) {
    const file = path.join(rootDir, rel);
    if (!fs.existsSync(file)) continue;
    return { config: parseConfigText(fs.readFileSync(file, "utf8"), rootDir), source: file };
  }
  return { config: defaultConfig(rootDir), source: null };
}

// Where delivery artifacts live. `artifacts.repo` unset (both null) keeps the
// in-repo layout: `root` is the checkout itself. A non-null `name` or `dir`
// selects a sibling companion checkout, resolved against the primary checkout
// (like worktrees.dir) so managed worktrees never point into the worktrees dir.
// `worktreesDir` is the companion's parallel worktrees directory (`<dir>-worktrees`),
// derived only — there is no config key for it.
export function resolveArtifactsRoot({ config, rootDir, primaryRoot = rootDir }) {
  const repo = config.artifacts?.repo ?? {};
  if (repo.name == null && repo.dir == null) {
    return { external: false, name: null, dir: null, root: rootDir, worktreesDir: null };
  }
  const dir = path.resolve(primaryRoot, repo.dir ?? path.join("..", repo.name));
  const name = repo.name ?? path.basename(dir);
  return { external: true, name, dir, root: dir, worktreesDir: `${dir}-worktrees` };
}
