// Pure view-model for the Mission Control canvas. Converts a `dashboard` document
// (the JSON `node scripts/agento.mjs dashboard` returns) into the render shape the
// panels consume, and diffs two snapshots into a feed of change events.
//
// No SDK imports: this module is unit-tested with node:test and shared by the
// canvas server (which runs the real CLI) and dev.mjs (which serves the fixture).

export const LANES = [
  { id: "planned", label: "Planned", statuses: ["planned"] },
  { id: "building", label: "Building", statuses: ["in-progress", "paused"] },
  { id: "in-review", label: "In Review", statuses: ["in-review"] },
  { id: "shipped", label: "Shipped", statuses: ["complete"] },
];

// Number of most-recent shipped cards kept expanded; the rest are collapsed.
const SHIPPED_VISIBLE = 10;

export function laneFor(status) {
  for (const lane of LANES) if (lane.statuses.includes(status)) return lane.id;
  return "other";
}

function cardFor(delivery) {
  const steps = delivery.steps ?? { ticked: 0, total: 0 };
  return {
    slug: delivery.slug,
    type: delivery.type,
    status: delivery.status,
    lifecycle: delivery.lifecycle ?? null,
    dir: delivery.dir ?? null,
    lane: laneFor(delivery.status),
    steps: { done: steps.ticked ?? 0, total: steps.total ?? 0 },
    pr: delivery.pr?.number ?? null,
    prState: delivery.pr?.state ?? null,
    companionPr: delivery.companionPr?.number ?? null,
    reviewVerdict: delivery.reviewVerdict ?? null,
    postShipPending: delivery.postShipPending ?? 0,
    owner: delivery.owner ?? null,
    workspace: delivery.workspace ?? null,
    companion: delivery.companion ?? null,
    allowed: Array.isArray(delivery.allowed) ? delivery.allowed : [],
    elsewhere: Array.isArray(delivery.elsewhere) ? delivery.elsewhere : [],
    initiative: delivery.initiative ?? null,
    nextStep: delivery.nextStep ?? null,
    lastUpdated: delivery.lastUpdated ?? null,
  };
}

function buildLanes(cards) {
  const lanes = LANES.map((lane) => ({ id: lane.id, label: lane.label, cards: [], collapsed: 0 }));
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  const other = [];
  for (const card of cards) {
    const lane = byId.get(card.lane);
    if (lane) lane.cards.push(card);
    else other.push(card);
  }
  // Collapse the oldest shipped cards beyond the visible window.
  const shipped = byId.get("shipped");
  if (shipped && shipped.cards.length > SHIPPED_VISIBLE) {
    shipped.cards.sort((a, b) => (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? ""));
    shipped.collapsed = shipped.cards.length - SHIPPED_VISIBLE;
    shipped.cards = shipped.cards.slice(0, SHIPPED_VISIBLE);
  }
  if (other.length) lanes.push({ id: "other", label: "Other", cards: other, collapsed: 0 });
  return lanes;
}

function initiativeView(slug, detail) {
  const features = Array.isArray(detail.features) ? detail.features : [];
  const nodes = features.map((f) => ({
    slug: f.slug,
    state: f.state ?? null,
    wave: f.computedWave ?? f.wave ?? null,
    declaredWave: f.wave ?? null,
    order: f.order ?? null,
    ready: Boolean(f.ready),
    blockedBy: Array.isArray(f.blockedBy) ? f.blockedBy : [],
    requires: Array.isArray(f.requires) ? f.requires : [],
    recommendedAfter: Array.isArray(f.recommendedAfter) ? f.recommendedAfter : [],
  }));
  const edges = [];
  for (const node of nodes) {
    for (const dep of node.requires) {
      // A requirement that is still blocking glows as a `blocking` edge; a
      // satisfied requirement is a plain `requires` edge. One edge per dependency.
      edges.push({ from: dep, to: node.slug, kind: node.blockedBy.includes(dep) ? "blocking" : "requires" });
    }
    for (const dep of node.recommendedAfter) edges.push({ from: dep, to: node.slug, kind: "recommendedAfter" });
  }
  return {
    slug,
    dir: detail.initiative?.dir ?? null,
    done: Boolean(detail.done),
    next: detail.next ?? null,
    waves: Array.isArray(detail.waves) ? detail.waves : [],
    nodes,
    edges,
    anomalies: Array.isArray(detail.anomalies) ? detail.anomalies : [],
  };
}

function buildInitiatives(initiatives) {
  const details = initiatives?.details ?? {};
  const views = [];
  for (const [slug, detail] of Object.entries(details)) {
    if (detail && typeof detail === "object") views.push(initiativeView(slug, detail));
  }
  views.sort((a, b) => a.slug.localeCompare(b.slug));
  return views;
}

function buildTimeline(metrics) {
  const items = Array.isArray(metrics?.items) ? metrics.items : [];
  const bands = items.map((m) => ({
    slug: m.slug,
    status: m.status ?? null,
    dir: m.dir ?? null,
    running: Boolean(m.cycle?.open),
    cycle: m.cycle ?? null,
    phases: {
      planned: m.phases?.planned ?? null,
      build: m.phases?.build ?? null,
      review: m.phases?.review ?? null,
      paused: m.pauses ? { count: m.pauses.count ?? 0, seconds: m.pauses.seconds ?? 0, open: Boolean(m.pauses.open) } : null,
    },
    reviewRounds: m.reviewRounds ?? 0,
    merged: m.merged ?? null,
  }));
  return { median: metrics?.aggregate?.median ?? null, bands };
}

function buildWorktrees(session) {
  const worktrees = Array.isArray(session?.worktrees) ? session.worktrees : [];
  const currentPath = session?.worktree?.path ?? null;
  const entries = worktrees.map((wt) => ({
    path: wt.path ?? null,
    branch: wt.branch ?? null,
    detached: Boolean(wt.detached),
    role: wt.role ?? null,
    repo: wt.repo ?? "product",
    id: wt.id ?? null,
    dirPrefix: wt.dirPrefix ?? null,
    isPrimary: Boolean(wt.isPrimary),
    isManaged: Boolean(wt.isManaged),
    current: wt.path != null && wt.path === currentPath,
    delivery: null,
  }));
  const groups = [];
  const byRole = new Map();
  for (const entry of entries) {
    if (!byRole.has(entry.role)) {
      const group = { role: entry.role, worktrees: [] };
      byRole.set(entry.role, group);
      groups.push(group);
    }
    byRole.get(entry.role).worktrees.push(entry);
  }
  return { groups, entries, current: currentPath };
}

function allowedUnion(session, deliveries) {
  const union = [];
  const seen = new Set();
  const add = (commands) => {
    for (const command of commands ?? []) {
      if (typeof command !== "string" || seen.has(command)) continue;
      seen.add(command);
      union.push(command);
    }
  };
  add(session?.allowed);
  for (const delivery of deliveries ?? []) add(delivery.allowed);
  return union;
}

function sessionView(session) {
  return {
    role: session?.role ?? null,
    hosted: Boolean(session?.hosted),
    lifecycle: session?.lifecycle ?? null,
    worktree: session?.worktree ?? null,
    delivery: session?.delivery ?? null,
    allowed: Array.isArray(session?.allowed) ? session.allowed : [],
    elsewhere: Array.isArray(session?.elsewhere) ? session.elsewhere : [],
  };
}

// Map worktree path -> delivery slug for the worktree map panel.
function ownerByPath(deliveries) {
  const map = new Map();
  for (const d of deliveries ?? []) {
    if (d.owner?.path) map.set(d.owner.path, d.slug);
    if (d.companion?.path) map.set(d.companion.path, d.slug);
  }
  return map;
}

export function normalize(dashboard) {
  const deliveries = Array.isArray(dashboard?.deliveries?.items) ? dashboard.deliveries.items : [];
  const cards = deliveries.map(cardFor);
  const lanes = buildLanes(cards);
  const initiatives = buildInitiatives(dashboard?.initiatives);
  const timeline = buildTimeline(dashboard?.metrics);
  const worktrees = buildWorktrees(dashboard?.session);
  const owner = ownerByPath(deliveries);
  for (const entry of worktrees.entries) entry.delivery = owner.get(entry.path) ?? null;
  const allowed = allowedUnion(dashboard?.session, deliveries);
  return {
    lanes,
    cards,
    initiatives,
    timeline,
    worktrees,
    allowed,
    session: sessionView(dashboard?.session),
  };
}

// Diff two normalized snapshots into feed events. `prev` and `next` are the return
// values of `normalize`. Events are ordered and carry enough context for the feed
// panel to render them.
export function diff(prev, next) {
  const events = [];

  const prevCards = new Map((prev?.cards ?? []).map((c) => [c.slug, c]));
  for (const card of next?.cards ?? []) {
    const before = prevCards.get(card.slug);
    if (!before) continue;
    if (before.status !== card.status) {
      events.push({ type: "status-changed", slug: card.slug, from: before.status, to: card.status });
    }
    if (card.steps.done > before.steps.done) {
      events.push({ type: "step-ticked", slug: card.slug, from: before.steps.done, to: card.steps.done });
    }
    if (before.pr == null && card.pr != null) {
      events.push({ type: "pr-opened", slug: card.slug, pr: card.pr });
    }
    if ((before.reviewVerdict ?? null) !== (card.reviewVerdict ?? null)) {
      events.push({ type: "verdict-recorded", slug: card.slug, verdict: card.reviewVerdict });
    }
  }

  const prevPaths = new Set((prev?.worktrees?.entries ?? []).map((w) => w.path));
  const nextPaths = new Set((next?.worktrees?.entries ?? []).map((w) => w.path));
  for (const path of nextPaths) if (!prevPaths.has(path)) events.push({ type: "worktree-created", path });
  for (const path of prevPaths) if (!nextPaths.has(path)) events.push({ type: "worktree-removed", path });

  const prevInitiatives = new Map((prev?.initiatives ?? []).map((i) => [i.slug, i]));
  for (const initiative of next?.initiatives ?? []) {
    const before = prevInitiatives.get(initiative.slug);
    if (!before) continue;
    const beforeNodes = new Map((before.nodes ?? []).map((n) => [n.slug, n]));
    for (const node of initiative.nodes ?? []) {
      const previousNode = beforeNodes.get(node.slug);
      if (previousNode && previousNode.blockedBy.length > 0 && node.blockedBy.length === 0) {
        events.push({ type: "member-unblocked", initiative: initiative.slug, slug: node.slug });
      }
    }
  }

  return events;
}
