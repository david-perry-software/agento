// Pure helpers behind `agento.mjs session`: where am I (role/worktree), what is
// active (delivery/lifecycle), and what may I run next (allowed/elsewhere). No git
// or filesystem walking happens here beyond realpath, so every rule is unit-testable.

import fs from "node:fs";
import path from "node:path";

const MANAGED_DIR = /^(plan|feature|issue|freehand)-(.+)$/;

export const SESSION_WORKSPACE_SETTINGS = Object.freeze({
  "chat.tools.terminal.autoApprove": {
    "/[\\s\\S]*/": { approve: true, matchCommandLine: true },
    "/.*/": true,
  },
  "chat.tools.terminal.ignoreDefaultAutoApproveRules": true,
  "chat.tools.terminal.blockDetectedFileWrites": "never",
  "chat.tools.edits.autoApprove": {
    "**/*": true,
  },
});

export function sessionWorkspaceDocument({ product, companion, autoApprove = true }) {
  return {
    folders: [{ path: product }, { path: companion }],
    settings: autoApprove ? SESSION_WORKSPACE_SETTINGS : {},
  };
}

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

// The managed `<kind>-<id>` directory name a cwd sits under, when `managedDir` is
// the worktrees dir that holds it (never the dir itself).
function managedTop(managedDir, real) {
  if (!managedDir) return null;
  const managedRoot = realpath(managedDir);
  if (!isWithin(managedRoot, real) || real === managedRoot) return null;
  const top = path.relative(managedRoot, real).split(path.sep)[0];
  return top.match(MANAGED_DIR) ? top : null;
}

function roleForManaged(worktree, config) {
  if (worktree.dirPrefix === "freehand") return "freehand";
  const { branch } = worktree;
  if (branch && (branch.startsWith(config.branches.feature) || branch.startsWith(config.branches.issue))) return "build";
  return "plan";
}

// `companionWorktreesDir` (companion mode only) is the parallel directory holding the
// companion half of every managed pair; a cwd inside `<companionWorktreesDir>/<kind>-<id>`
// resolves to the *product* half's record and `half: "companion"`.
function classifyByPath({ cwd, worktrees, worktreesDir, config, companionWorktreesDir = null }) {
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
    return { role: "primary", worktree: { ...worktree, isPrimary: true }, half: "product" };
  }

  const top = managedTop(worktreesDir, real);
  if (top) {
    const match = top.match(MANAGED_DIR);
    worktree.isManaged = true;
    worktree.dirPrefix = match[1];
    worktree.id = match[2];
    if (!owner) worktree.path = path.join(worktreesDir, top);
    return { role: roleForManaged(worktree, config), worktree, half: "product" };
  }

  const companionTop = owner ? null : managedTop(companionWorktreesDir, real);
  if (companionTop) {
    const match = companionTop.match(MANAGED_DIR);
    const productPath = path.join(worktreesDir, companionTop);
    const productReal = realpath(productPath);
    const product = entries.find((w) => w.realPath === productReal) ?? null;
    const paired = {
      path: product ? product.path : productPath,
      branch: product?.branch ?? null,
      detached: product ? product.detached : true,
      isPrimary: false,
      isManaged: true,
      dirPrefix: match[1],
      id: match[2],
    };
    return { role: roleForManaged(paired, config), worktree: paired, half: "companion" };
  }

  return { role: "unmanaged", worktree, half: "product" };
}

// In a hosted workspace (Codespaces, Actions) the path rules do not apply: the role
// comes from the branch alone and `reason` explains why, for `warnings[]`.
export function deriveRole({ cwd, worktrees, worktreesDir, config, env, companionWorktreesDir = null }) {
  const result = classifyByPath({ cwd, worktrees, worktreesDir, config, companionWorktreesDir });
  const hostedVar = HOSTED_VARS.find((v) => env?.[v] === "true");
  if (!hostedVar) return { ...result, hosted: false };
  const { branch } = result.worktree;
  const isDelivery = Boolean(branch && (branch.startsWith(config.branches.feature) || branch.startsWith(config.branches.issue)));
  return {
    role: isDelivery ? "build" : "primary",
    worktree: result.worktree,
    half: result.half,
    hosted: true,
    reason: `hosted-workspace: role derived from the branch (${hostedVar}=true)`,
  };
}

// The companion half paired with a managed product worktree: its path is derived,
// `registered` says whether the companion clone lists it (branch/detached come from
// that entry). Null for the primary, unmanaged entries, and in-repo mode.
export function pairFor({ worktree, companionWorktreesDir, companionWorktrees }) {
  if (!companionWorktreesDir || !worktree?.isManaged) return null;
  const pairPath = path.join(companionWorktreesDir, `${worktree.dirPrefix}-${worktree.id}`);
  const pairReal = realpath(pairPath);
  const entry = (companionWorktrees ?? []).find((w) => realpath(w.path) === pairReal) ?? null;
  return {
    path: entry ? entry.path : pairPath,
    branch: entry?.branch ?? null,
    detached: entry ? Boolean(entry.detached) : false,
    registered: Boolean(entry),
  };
}

// One classified record per registered worktree entry; the list describes on-disk
// checkouts, so the hosted flag never applies here. Product entries come first
// (`repo: "product"`, the primary at index 0); in companion mode the companion
// clone's entries follow with `repo: "companion"`, each half's role taken from its
// product half.
export function classifyWorktrees({ worktrees, worktreesDir, config, companionWorktreesDir = null, companionWorktrees = [] }) {
  const classify = (entry, repo) => {
    const { role, worktree } = classifyByPath({ cwd: entry.path, worktrees, worktreesDir, config, companionWorktreesDir });
    return {
      path: entry.path,
      branch: entry.branch ?? null,
      detached: Boolean(entry.detached),
      role,
      dirPrefix: worktree.dirPrefix,
      id: worktree.id,
      isPrimary: worktree.isPrimary,
      isManaged: worktree.isManaged,
      repo,
    };
  };
  return [
    ...(worktrees ?? []).map((entry) => classify(entry, "product")),
    ...(companionWorktreesDir ? companionWorktrees ?? [] : []).map((entry) => classify(entry, "companion")),
  ];
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

const ROADMAP_FIELDS = ["dir", "roadmap", "plan", "review", "reviewVerdict", "status", "lastUpdated", "nextStep", "githubIssue", "artifactPr", "initiative", "steps"];

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

// PR state never changes the lifecycle; a merged PR on a non-complete roadmap only
// warns, as does a merged code PR whose companion PR is still open (half-shipped).
export function deriveLifecycle({ delivery, pr, companionPr = null }) {
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
  if (pr && pr.state === "MERGED" && companionPr && companionPr.state === "OPEN") {
    warnings.push(`companion-pr-open: PR #${pr.number} for ${delivery.branch} is merged but companion PR #${companionPr.number} is still open`);
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
const AP = "/agento ap <slug>";
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
    planned: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    building: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    paused: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    "in-review": { allowed: [REVIEW, AP, STATUS], elsewhere: SHIP_LATER },
    approved: { allowed: [STATUS], elsewhere: SHIP_NOW },
    shipped: { allowed: [STATUS], elsewhere: TEARDOWN },
    "post-ship-pending": { allowed: [STATUS], elsewhere: [primary(SHIP, "post-ship steps complete from the primary window")] },
  },
  plan: {
    "no-delivery": { allowed: ["/agento new-feature", "/agento new-issue", STATUS], elsewhere: [] },
    planned: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    building: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    paused: { allowed: [BUILD, AP, STATUS], elsewhere: SHIP_LATER },
    "in-review": { allowed: [REVIEW, AP, STATUS], elsewhere: SHIP_LATER },
    approved: { allowed: [STATUS], elsewhere: SHIP_NOW },
    shipped: { allowed: [STATUS], elsewhere: TEARDOWN },
    "post-ship-pending": { allowed: [STATUS], elsewhere: [primary(SHIP, "post-ship steps complete from the primary window")] },
  },
};
const FREEHAND = { allowed: ["/agento finish-freehand <slug>", "/agento commit-current-changes"], elsewhere: [] };
const UNMANAGED = { allowed: [], elsewhere: [primary(START, "this directory is neither the primary worktree nor a managed Agento worktree")] };

const CONTINUE = "/agento continue";
// Every delivery-window row offers `/agento continue` first: it derives the same
// transition the rest of the row spells out (deriveNext). Freehand and unmanaged
// windows are outside the delivery lifecycle and keep their fixed rows.
for (const rows of Object.values(TABLE)) for (const row of Object.values(rows)) row.allowed = [CONTINUE, ...row.allowed];

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

// --- next: the one legal transition -----------------------------------------

export const NEXT_STATUSES = ["ok", "none", "ambiguous", "blocked", "unsupported", "missing"];

function transition(command, args, window, reason, then = null) {
  return { command, args, invocation: [`/agento ${command}`, ...args].join(" "), window, then, reason };
}

function summarizeCandidate(c) {
  return {
    kind: c.kind,
    slug: c.slug,
    type: c.type ?? "feature",
    status: c.kind === "delivery" ? (c.status ?? null) : "unplanned",
    initiative: c.initiative ?? null,
    artifactPr: c.kind === "delivery" ? (c.artifactPr ?? null) : null,
    layout: c.kind === "delivery" ? (c.layout ?? "checkout") : null,
    artifactsRoot: c.kind === "delivery" ? (c.artifactsRoot ?? null) : null,
    owner: c.owner ?? null,
    invocation: `${CONTINUE} ${c.slug}`,
  };
}

// Build/plan window with an active delivery: the lifecycle alone picks the command;
// review freshness decides between re-review, fix handoff, and ship.
function activeTransition({ delivery, lifecycle, reviewFresh }) {
  const { type, slug, status, reviewVerdict } = delivery;
  switch (lifecycle) {
    case "planned":
    case "building":
    case "paused":
      return transition(`build-${type}`, [slug], "here", `roadmap status ${status}: the Builder continues in this window`);
    case "in-review":
      if (reviewVerdict === "request-changes" && reviewFresh !== false) {
        return transition(`build-${type}`, [slug], "here", "review.md says request-changes and is current: the Builder fix handoff runs in this window");
      }
      return transition(
        `review-${type}`,
        [slug],
        "here",
        reviewVerdict ? "review.md is older than the last code commit: the Reviewer re-reviews in this window" : "status in-review with no verdict yet: the Reviewer runs in this window",
      );
    case "approved":
      if (reviewFresh === false) return transition(`review-${type}`, [slug], "here", "Verdict: approve predates the last code commit: re-review before shipping");
      return transition("ship", [slug], "primary", "Verdict: approve is current: ship from the primary window; it audits this worktree first and tears it down after the merge");
    case "shipped":
      return transition("ship", [slug], "primary", "the delivery is merged: re-send ship from the primary window to tear this worktree down");
    case "post-ship-pending":
      return transition("ship", [slug], "primary", "post-ship steps remain: ship completes them from the primary window");
    default:
      return null;
  }
}

// Primary window acting on one resolved candidate (a delivery seen from main or
// owned by a registered worktree, or a ready initiative member).
function primaryTransition({ target, owner, reviewFresh, config }) {
  if (target.kind === "initiative-member") {
    return {
      status: "ok",
      next: transition("start-session", [], "here", `${target.slug} is the ready member of initiative ${target.initiative}: open a plan window, then continue there`, `${CONTINUE} ${target.slug}`),
    };
  }
  const targetOwner = target.owner ?? owner ?? null;
  const fresh = target.reviewFresh ?? reviewFresh;
  if (targetOwner?.role === "primary") {
    return { status: "blocked", reason: `the primary checkout sits on ${target.branch}; return it to ${config.branches.default} before continuing ${target.slug}` };
  }
  const { lifecycle } = deriveLifecycle({
    delivery: { roadmap: target.roadmap ?? "roadmap.md", status: target.status, reviewVerdict: target.reviewVerdict ?? null, postShipPending: target.postShipPending ?? 0 },
    pr: null,
  });
  const resume = targetOwner ? ["--resume"] : [];
  const open = (why) => ({
    status: "ok",
    next: transition("start-session", [`${target.type}/${target.slug}`, ...resume], "here", why, `${CONTINUE} ${target.slug}`),
  });
  const ship = (why) => ({ status: "ok", next: transition("ship", [target.slug], "here", why) });
  switch (lifecycle) {
    case "planned":
    case "building":
    case "paused":
    case "in-review":
      return open(`${target.type}/${target.slug} is ${target.status}: ${targetOwner ? "reopen its worktree window" : "open its worktree window"}, then continue there`);
    case "approved":
      if (fresh === false) return open(`Verdict: approve predates the last code commit on ${target.branch}: reopen the worktree window and re-review`);
      return ship(`Verdict: approve is current: ship from here (audits the worktree first, tears it down after the merge)`);
    case "post-ship-pending":
      return ship(`post-ship steps remain for ${target.slug}: ship resumes at its epilogue`);
    case "shipped":
      if (targetOwner) return ship(`${target.slug} is complete but ${targetOwner.path} still owns ${target.branch}: ship resumes at teardown`);
      return { status: "none", reason: `${target.slug} is complete and no worktree owns ${target.branch}; nothing to continue` };
    default:
      return { status: "blocked", reason: `roadmap for ${target.slug} has an unknown status ${JSON.stringify(target.status ?? "")}; repair the header first` };
  }
}

// Pure transition function behind `agento.mjs next [<slug>]`. Inputs are plain data
// assembled by the CLI; `candidates` carry `kind: "delivery"` (type, slug, branch,
// status, reviewVerdict, postShipPending, owner, reviewFresh) or
// `kind: "initiative-member"` (slug, initiative). Never emits `/agento ap`.
export function deriveNext({ role, worktree, delivery, lifecycle, owner = null, reviewFresh = null, candidates = [], requestedSlug = null, config }) {
  const finish = (status, reason, list = []) => ({ status, next: null, candidates: list.map(summarizeCandidate), reason });
  const ok = (next) => ({ status: "ok", next, candidates: [], reason: next.reason });

  if (role === "freehand" || role === "unmanaged") {
    return finish("unsupported", `role ${role} has no delivery lifecycle to continue; use the session record's allowed commands`);
  }

  if (role === "build" || role === "plan") {
    if (delivery && lifecycle !== "no-delivery") {
      if (requestedSlug && requestedSlug !== delivery.slug) {
        return finish("blocked", `wrong window for ${requestedSlug}: this worktree owns ${delivery.type}/${delivery.slug}; continue ${requestedSlug} from the primary window or its own worktree`);
      }
      const next = activeTransition({ delivery, lifecycle, reviewFresh });
      return next ? ok(next) : finish("blocked", `no transition for lifecycle ${lifecycle} in a ${role} window`);
    }
    if (role === "build") {
      return finish("blocked", `branch ${worktree?.branch ?? "(detached)"} has no roadmap yet; plan it first (/agento new-feature or /agento new-issue in a plan window)`);
    }
    const members = candidates.filter((c) => c.kind === "initiative-member");
    const newFeature = (m) => ok(transition("new-feature", [`initiative:${m.initiative}/${m.slug}`], "here", `${m.slug} is a ready member of initiative ${m.initiative}: the Planner runs in this window`));
    if (requestedSlug) {
      const member = members.find((c) => c.slug === requestedSlug);
      if (member) return newFeature(member);
      const other = candidates.find((c) => c.slug === requestedSlug);
      return other
        ? finish("blocked", `${requestedSlug} is an existing ${other.type ?? "feature"} delivery (${other.status}); continue it from the primary window or its own worktree`)
        : finish("missing", `no ready initiative member named ${requestedSlug}`);
    }
    if (members.length === 0) return finish("none", "no ready initiative member; describe the work yourself with /agento new-feature <description> or /agento new-issue");
    if (members.length > 1) return finish("ambiguous", `${members.length} initiative members are ready; pick one`, members);
    return newFeature(members[0]);
  }

  // primary
  if (delivery) {
    return finish("blocked", `the primary checkout is on ${worktree?.branch ?? delivery.branch}; return it to ${config.branches.default} before continuing`);
  }
  let target;
  if (requestedSlug) {
    target = candidates.find((c) => c.slug === requestedSlug);
    if (!target) return finish("missing", `no roadmap or ready initiative member for slug ${requestedSlug}`);
  } else {
    if (candidates.length === 0) {
      return finish("none", "nothing is in flight and no initiative member is ready; start with /agento new-feature <description>, /agento new-issue, or /agento new-initiative");
    }
    if (candidates.length > 1) return finish("ambiguous", `${candidates.length} candidates could continue; pick one`, candidates);
    target = candidates[0];
  }
  const result = primaryTransition({ target, owner, reviewFresh, config });
  return result.status === "ok" ? ok(result.next) : finish(result.status, result.reason);
}

// Resolves a `deriveNext` window kind to the checkout a launcher opens:
// `{ path, workspace: { path, exists } | null } | null`. `here` needs no target.
export function resolveNextTarget({ next, worktrees, primaryPath, branch, workspaceFor }) {
  if (!next || next.window === "here") return null;
  if (next.window === "primary") return { path: primaryPath, workspace: null };
  const entry = branch ? worktrees.find((w) => w.repo === "product" && w.isManaged && w.branch === branch) : null;
  return entry ? { path: entry.path, workspace: workspaceFor(entry) } : null;
}
