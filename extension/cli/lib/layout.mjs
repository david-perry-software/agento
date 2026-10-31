// The layout/discovery helpers shared by every slug-targeted read and decision
// (resolve/find, preflight, close-decision, ship-preflight, paths/session, …),
// moved unchanged from the legacy `scripts/agento.mjs`.

import { parseConfigText, resolveArtifactsRoot } from "../agento-config.mjs";
import { resolveRoadmapArtifact } from "../delivery-roadmap-resolver.mjs";
import { parseWorktreeList } from "../session-state.mjs";
import {
  agit,
  artifacts,
  artifactsGit,
  artifactsRoot,
  companionWorktrees,
  companionWorktreesDir,
  config,
  currentBranch,
  git,
  productWorktrees,
  root,
  samePath,
} from "./context.mjs";

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
export {
  checkoutLayout,
  layoutFor,
  deliveryBranch,
  resolveWithLayout,
  withLayout,
  decideWithLayout,
};
