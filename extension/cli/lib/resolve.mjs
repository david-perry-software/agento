// The `config`/resolve-family document builders and the shared type/slug
// argument validators, moved unchanged from the legacy `scripts/agento.mjs`.
// `resolveDocument`/`configDocument` live here because `preflight` also uses
// them, and `requireType`/`requireSlug` are shared by nearly every command.

import {
  artifacts,
  artifactsRoot,
  config,
  currentBranch,
  PLUGIN_ROOT,
  primaryWorktreesDir,
  repoName,
  root,
  source,
  usage,
} from "./context.mjs";
import { resolveWithLayout, withLayout } from "./layout.mjs";

function requireType(type) {
  if (type !== "feature" && type !== "issue") usage(`type must be feature or issue, got ${JSON.stringify(type ?? "")}`);
  return type;
}

function requireSlug(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) usage(`slug must match [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(slug ?? "")}`);
  return slug;
}
// What `config` emits.
function configDocument() {
  return {
    status: "ok",
    root,
    repoName,
    configSource: source,
    pluginRoot: PLUGIN_ROOT,
    currentBranch,
    artifactsRoot,
    config: { ...config, artifacts: { ...config.artifacts, repo: { name: artifacts.name, dir: artifacts.dir } }, worktrees: { dir: primaryWorktreesDir() } },
  };
}
// `resolve <type> <slug>`, or `find <slug>` when no type was passed.
function resolveDocument(type, slug) {
  if (type) {
    const { result, layout } = resolveWithLayout(type, slug);
    return { ...withLayout(result, layout), root, configSource: source };
  }
  const found = ["feature", "issue"]
    .map((t) => {
      const { result, layout } = resolveWithLayout(t, slug);
      return { type: t, ...withLayout(result, layout) };
    })
    .filter((r) => r.status !== "missing");
  if (found.length === 0) return { status: "missing", message: `No roadmap for slug ${slug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin.`, root, configSource: source };
  if (found.length > 1) return { status: "conflict", candidates: found, message: `Slug ${slug} exists as both a feature and an issue; specify the type.`, root, configSource: source };
  return { ...found[0], root, configSource: source };
}
export {
  requireType,
  requireSlug,
  configDocument,
  resolveDocument,
};
