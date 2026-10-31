// The session/companion/workspace helpers shared by session, status, start-session,
// ship, close-decision, next, and the dashboard, moved unchanged from the legacy
// `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import {
  classifyWorktrees,
  companionWarning,
  deriveAllowed,
  deriveDelivery,
  deriveLifecycle,
  deriveRole,
  pairFor,
  sessionWorkspaceDocument,
} from "../session-state.mjs";
import {
  anchor,
  artifacts,
  companionWorktrees,
  companionWorktreesDir,
  config,
  git,
  MANAGED_HALF,
  primaryWorktreesDir,
  productWorktrees,
  roleCwd,
  root,
  samePath,
  source,
} from "./context.mjs";
import { lookupCompanionPullRequest, lookupPullRequest } from "./github.mjs";
import { checkoutLayout } from "./layout.mjs";
import { allRoadmaps } from "./records.mjs";

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

function companionOfOwner(owner, layout) {
  if (!owner || owner.role === "primary" || !owner.dirPrefix) return null;
  return describeCompanion({ isManaged: true, dirPrefix: owner.dirPrefix, id: owner.id }, layout);
}
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

export {
  describeCompanion,
  canonicalizeJson,
  workspaceDocumentCurrent,
  describeWorkspace,
  companionOfOwner,
  managedHalves,
  companionHalfOf,
  sessionRecord,
  sessionContext,
};
