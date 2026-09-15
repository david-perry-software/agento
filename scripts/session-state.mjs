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

const HOSTED_VARS = ["CODESPACES", "GITHUB_ACTIONS"];

function classifyByPath({ cwd, worktrees, worktreesDir, config }) {
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

// In a hosted workspace (Codespaces, Actions) the path rules do not apply: the role
// comes from the branch alone and `reason` explains why, for `warnings[]`.
export function deriveRole({ cwd, worktrees, worktreesDir, config, env }) {
  const result = classifyByPath({ cwd, worktrees, worktreesDir, config });
  const hostedVar = HOSTED_VARS.find((v) => env?.[v] === "true");
  if (!hostedVar) return { ...result, hosted: false };
  const { branch } = result.worktree;
  const isDelivery = Boolean(branch && (branch.startsWith(config.branches.feature) || branch.startsWith(config.branches.issue)));
  return {
    role: isDelivery ? "build" : "primary",
    worktree: result.worktree,
    hosted: true,
    reason: `hosted-workspace: role derived from the branch (${hostedVar}=true)`,
  };
}

// One classified record per registered worktree entry; the list describes on-disk
// checkouts, so the hosted flag never applies here.
export function classifyWorktrees({ worktrees, worktreesDir, config }) {
  return (worktrees ?? []).map((entry) => {
    const { role, worktree } = classifyByPath({ cwd: entry.path, worktrees, worktreesDir, config });
    return {
      path: entry.path,
      branch: entry.branch ?? null,
      detached: Boolean(entry.detached),
      role,
      dirPrefix: worktree.dirPrefix,
      id: worktree.id,
      isPrimary: worktree.isPrimary,
      isManaged: worktree.isManaged,
    };
  });
}

// Exact ownership of a branch: a managed entry inside worktrees.dir, the primary
// checkout, or nobody. An unmanaged entry on the branch is not an owner.
export function findOwner({ worktrees, worktreesDir, branch, config }) {
  if (!branch) return null;
  const classified = classifyWorktrees({ worktrees, worktreesDir, config }).filter((w) => w.branch === branch);
  const managed = classified.find((w) => w.isManaged);
  if (managed) return { path: managed.path, role: managed.role, dirPrefix: managed.dirPrefix, id: managed.id };
  const primary = classified.find((w) => w.isPrimary);
  if (primary) return { path: primary.path, role: "primary", dirPrefix: null, id: null };
  return null;
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

export const ROLES = ["primary", "build", "plan", "freehand", "unmanaged"];

const STATUS = "/agento delivery-status";
const START = "/agento start-session";
const CREATE = [START, "/agento new-feature", "/agento new-issue", "/agento new-initiative", STATUS];
const RESUME = `${START} <type>/<slug> --resume`;
const BUILD = "/agento build-<type> <slug>";
const REVIEW = "/agento review-<type> <slug>";
const CLOSE = "/agento close-session <type>/<slug>";
const SHIP = "/agento ship <slug>";

const secondary = (command, reason) => ({ command, window: "secondary", reason });
const primary = (command, reason) => ({ command, window: "primary", reason });
const SHIP_LATER = [
  primary(SHIP, "after Verdict: approve, ship from the primary window — ship audits here first and tears this worktree down after the merge"),
];
const SHIP_NOW = [primary(SHIP, "ship from the primary window — audits this worktree first, tears it down after the merge")];
// Merged while this worktree still exists: re-sending ship resumes at teardown.
const TEARDOWN = [
  primary(SHIP, "the delivery is merged; re-send ship from the primary window to tear this worktree down"),
  primary(CLOSE, "manual cleanup if you would rather close the session yourself"),
];

// Policy §8 as data: build/review in the secondary window; ship — which audits first
// and tears down — in the primary. close-session stays for plan/freehand sessions
// and for abandoning a build.
const TABLE = {
  primary: {
    "no-delivery": { allowed: CREATE, elsewhere: [] },
    planned: { allowed: [`${START} <type>/<slug>`, STATUS], elsewhere: [secondary(BUILD, "builds run in the secondary worktree window")] },
    building: { allowed: [RESUME, STATUS], elsewhere: [secondary(BUILD, "builds run in the secondary worktree window")] },
    paused: { allowed: [RESUME, STATUS], elsewhere: [secondary(BUILD, "builds resume in the secondary worktree window")] },
    "in-review": { allowed: [RESUME, STATUS], elsewhere: [secondary(REVIEW, "reviews run in the secondary worktree window")] },
    approved: { allowed: [SHIP, CLOSE, STATUS], elsewhere: [] },
    shipped: { allowed: CREATE, elsewhere: [] },
    "post-ship-pending": { allowed: [SHIP, STATUS], elsewhere: [] },
  },
  build: {
    "no-delivery": { allowed: [STATUS], elsewhere: [primary(START, "no roadmap for this branch yet; plan or start a session from the primary window")] },
    planned: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    building: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    paused: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    "in-review": { allowed: [REVIEW, STATUS], elsewhere: SHIP_LATER },
    approved: { allowed: [STATUS], elsewhere: SHIP_NOW },
    shipped: { allowed: [STATUS], elsewhere: TEARDOWN },
    "post-ship-pending": { allowed: [STATUS], elsewhere: [primary(SHIP, "post-ship steps complete from the primary window")] },
  },
  plan: {
    "no-delivery": { allowed: ["/agento new-feature", "/agento new-issue", STATUS], elsewhere: [] },
    planned: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    building: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    paused: { allowed: [BUILD, STATUS], elsewhere: SHIP_LATER },
    "in-review": { allowed: [REVIEW, STATUS], elsewhere: SHIP_LATER },
    approved: { allowed: [STATUS], elsewhere: SHIP_NOW },
    shipped: { allowed: [STATUS], elsewhere: TEARDOWN },
    "post-ship-pending": { allowed: [STATUS], elsewhere: [primary(SHIP, "post-ship steps complete from the primary window")] },
  },
};
const FREEHAND = { allowed: ["/agento finish-freehand <slug>", "/agento commit-current-changes"], elsewhere: [] };
const UNMANAGED = { allowed: [], elsewhere: [primary(START, "this directory is neither the primary worktree nor a managed Agento worktree")] };

export function deriveAllowed({ role, lifecycle, delivery, worktree }) {
  const row = role === "freehand" ? FREEHAND : role === "unmanaged" ? UNMANAGED : TABLE[role]?.[lifecycle];
  if (!row) return { allowed: [], elsewhere: [] };
  const slug = delivery?.slug ?? worktree?.id ?? "<slug>";
  const type = delivery?.type ?? "<type>";
  const fill = (s) => s.replace(/<type>/g, type).replace(/<slug>/g, slug);
  return {
    allowed: row.allowed.map(fill),
    elsewhere: row.elsewhere.map((e) => ({ ...e, command: fill(e.command) })),
  };
}
