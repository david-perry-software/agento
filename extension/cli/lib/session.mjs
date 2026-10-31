// The session/companion/workspace helpers shared by session, status, start-session,
// ship, close-decision, next, and the dashboard, moved unchanged from the legacy
// `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { findOccupants, defaultCodeStatus } from "../worktree-occupants.mjs";

import {
  classifyWorktrees,
  companionWarning,
  deriveAllowed,
  deriveDelivery,
  deriveLifecycle,
  deriveRole,
  pairFor,
  sessionWorkspaceDocument,
  splitPorcelain,
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
import { gitRun, isAncestor } from "./git.mjs";
import { lookupCompanionPullRequest, lookupPullRequest } from "./github.mjs";
import { once } from "./release.mjs";
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
  companionGaps,
  companionGapMessage,
  treeState,
  branchVerdict,
  removeSessionPair,
};
