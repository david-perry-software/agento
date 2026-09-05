import fs from "node:fs";
import path from "node:path";

const CONFIG_RELATIVE_PATHS = [".github/agento.json", "agento.json"];

export function defaultConfig(rootDir) {
  const repoName = path.basename(path.resolve(rootDir));
  return {
    artifacts: { features: "features", issues: "issues" },
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

export function loadAgentoConfig(rootDir) {
  const defaults = defaultConfig(rootDir);
  for (const rel of CONFIG_RELATIVE_PATHS) {
    const file = path.join(rootDir, rel);
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { config: mergeConfig(defaults, parsed), source: file };
  }
  return { config: defaults, source: null };
}
