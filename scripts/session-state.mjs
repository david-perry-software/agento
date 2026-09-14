// Pure helpers behind `agento.mjs session`: where am I (role/worktree), what is
// active (delivery/lifecycle), and what may I run next (allowed/elsewhere). No git
// or filesystem walking happens here beyond realpath, so every rule is unit-testable.

import fs from "node:fs";
import path from "node:path";

const MANAGED_DIR = /^(plan|feature|issue|freehand)-(.+)$/;

// `git worktree list --porcelain`: blank-line separated blocks of
// `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>` | `detached`.
export function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  for (const line of (porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, detached: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "") {
      current = null;
    }
  }
  return entries;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(dir, target) {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function deriveRole({ cwd, worktrees, worktreesDir, config }) {
  const real = realpath(cwd);
  const entries = (worktrees ?? []).map((w) => ({ ...w, realPath: realpath(w.path) }));
  const primary = entries[0] ?? null;
  // Deepest containing entry wins, so a worktree nested under another resolves to itself.
  const owner = entries.filter((w) => isWithin(w.realPath, real)).sort((a, b) => b.realPath.length - a.realPath.length)[0] ?? null;

  const worktree = {
    path: owner ? owner.path : cwd,
    branch: owner?.branch ?? null,
    detached: owner ? owner.detached : false,
    isPrimary: false,
    isManaged: false,
    dirPrefix: null,
    id: null,
  };

  if (owner && primary && owner.realPath === primary.realPath) {
    return { role: "primary", worktree: { ...worktree, isPrimary: true } };
  }

  const managedRoot = realpath(worktreesDir);
  if (isWithin(managedRoot, real) && real !== managedRoot) {
    const top = path.relative(managedRoot, real).split(path.sep)[0];
    const match = top.match(MANAGED_DIR);
    if (match) {
      worktree.isManaged = true;
      worktree.dirPrefix = match[1];
      worktree.id = match[2];
      if (!owner) worktree.path = path.join(worktreesDir, top);
      if (match[1] === "freehand") return { role: "freehand", worktree };
      const { branch } = worktree;
      if (branch && (branch.startsWith(config.branches.feature) || branch.startsWith(config.branches.issue))) {
        return { role: "build", worktree };
      }
      return { role: "plan", worktree };
    }
  }

  return { role: "unmanaged", worktree };
}

const ROADMAP_FIELDS = ["dir", "roadmap", "plan", "review", "reviewVerdict", "status", "lastUpdated", "nextStep", "githubIssue", "initiative", "steps"];

// Type/slug come from the branch prefix; a detached managed `feature-`/`issue-`
// worktree falls back to its directory name. Roadmap fields are null until one exists.
export function deriveDelivery({ branch, dirPrefix, id, roadmaps, config }) {
  const prefixes = { feature: config.branches.feature, issue: config.branches.issue };
  let type = null;
  let slug = null;
  for (const [t, prefix] of Object.entries(prefixes)) {
    if (branch && branch.startsWith(prefix) && branch.length > prefix.length) {
      type = t;
      slug = branch.slice(prefix.length);
      break;
    }
  }
  if (!type && !branch && (dirPrefix === "feature" || dirPrefix === "issue") && id) {
    type = dirPrefix;
    slug = id;
  }
  if (!type) return null;
  const roadmap = (roadmaps ?? []).find((r) => r.type === type && r.slug === slug) ?? null;
  const fields = Object.fromEntries(ROADMAP_FIELDS.map((k) => [k, roadmap ? roadmap[k] : null]));
  return {
    type,
    slug,
    branch: roadmap?.branch || `${prefixes[type]}${slug}`,
    ...fields,
    postShipPending: roadmap?.postShipPending ?? 0,
  };
}

export const LIFECYCLES = ["no-delivery", "planned", "building", "paused", "in-review", "approved", "shipped", "post-ship-pending"];

// PR state never changes the lifecycle; a merged PR on a non-complete roadmap only warns.
export function deriveLifecycle({ delivery, pr }) {
  const warnings = [];
  if (!delivery || !delivery.roadmap) return { lifecycle: "no-delivery", warnings };
  let lifecycle;
  switch (delivery.status) {
    case "planned":
      lifecycle = "planned";
      break;
    case "in-progress":
      lifecycle = "building";
      break;
    case "paused":
      lifecycle = "paused";
      break;
    case "in-review":
      lifecycle = delivery.reviewVerdict === "approve" ? "approved" : "in-review";
      break;
    case "complete":
      lifecycle = delivery.postShipPending > 0 ? "post-ship-pending" : "shipped";
      break;
    default:
      lifecycle = "no-delivery";
      warnings.push(`unknown-roadmap-status: ${delivery.roadmap} has status ${JSON.stringify(delivery.status ?? "")}`);
  }
  if (pr && pr.state === "MERGED" && delivery.status !== "complete") {
    warnings.push(`merged-but-not-complete: PR #${pr.number} for ${delivery.branch} is merged but ${delivery.roadmap} has status ${delivery.status}`);
  }
  return { lifecycle, warnings };
}
