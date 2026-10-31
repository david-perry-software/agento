// The status/initiative/metrics/dashboard document builders and their metrics and
// initiative helpers, moved unchanged from the legacy `scripts/agento.mjs`.
// They are shared by the status command family, `next`, and `preflight`.

import { execFileSync } from "node:child_process";
import path from "node:path";

import { aggregateMetrics, deriveMetrics, parseArtifactLog, parseMergeLog } from "../delivery-metrics.mjs";
import { deriveAllowed, deriveLifecycle, findOwner, LIFECYCLES } from "../session-state.mjs";
import {
  agit,
  artifacts,
  artifactsRoot,
  config,
  currentBranch,
  git,
  primaryWorktreesDir,
  productWorktrees,
  root,
  source,
} from "./context.mjs";
import { doctorDocument, doctorProbes, LOCAL_DOCTOR_CHECKS, runDoctor } from "./doctor.mjs";
import { lookupCompanionPullRequest, lookupPullRequest, lookupPullRequests, prefetchedLookup } from "./github.mjs";
import { checkoutLayout } from "./layout.mjs";
import { execAsync, probeAsync } from "./probe.mjs";
import { allRoadmaps, parseBreakdown, walkBreakdowns } from "./records.mjs";
import { companionOfOwner, describeWorkspace, managedHalves, sessionContext, sessionRecord } from "./session.mjs";

// --- initiatives -----------------------------------------------------------

function mergedAnomalies(features) {
  // Informational only (plan Decision 3): reflects the last fetch, never changes state or exit code.
  const merged = new Set(
    git(root, "branch", "-r", "--merged", `origin/${config.branches.default}`)
      .split("\n")
      .map((l) => l.trim().split(" ")[0])
      .filter(Boolean),
  );
  return features
    .filter((f) => f.roadmap && f.state !== "complete" && merged.has(`origin/${f.branch}`))
    .map((f) => ({ slug: f.slug, kind: "merged-but-not-complete", branch: f.branch }));
}

function allBreakdowns() {
  const base = path.join(artifactsRoot, config.artifacts.initiatives);
  return [...walkBreakdowns(base)].sort().map((file) => parseBreakdown(file));
}

function deriveInitiative(breakdown, roadmaps) {
  const errors = [];
  const known = new Map();
  for (const f of breakdown.features) {
    if (known.has(f.slug)) errors.push(`duplicate feature block "### ${f.slug}"`);
    else known.set(f.slug, f);
  }
  for (const f of breakdown.features) {
    for (const d of f.requires) if (!known.has(d)) errors.push(`${f.slug}: Requires unknown feature "${d}"`);
    for (const d of f.recommendedAfter) if (!known.has(d)) errors.push(`${f.slug}: Recommended after unknown feature "${d}"`);
  }
  const roadmapBySlug = new Map();
  for (const r of roadmaps) if (!roadmapBySlug.has(r.slug)) roadmapBySlug.set(r.slug, r);
  for (const f of known.values()) {
    const r = roadmapBySlug.get(f.slug);
    if (!r) continue;
    if (!r.initiative) errors.push(`${f.slug}: roadmap ${r.roadmap} has no initiative: header (expected "${breakdown.slug}")`);
    else if (r.initiative !== breakdown.slug) errors.push(`${f.slug}: roadmap ${r.roadmap} names initiative "${r.initiative}", expected "${breakdown.slug}"`);
  }

  // Kahn's algorithm over Requires: computed wave = 1 + max(wave of requirements).
  const level = new Map();
  const indegree = new Map(breakdown.features.map((f) => [f.slug, f.requires.filter((d) => known.has(d)).length]));
  const dependents = new Map(breakdown.features.map((f) => [f.slug, []]));
  for (const f of breakdown.features) for (const d of f.requires) if (known.has(d)) dependents.get(d).push(f.slug);
  const queue = breakdown.features.filter((f) => indegree.get(f.slug) === 0).map((f) => f.slug);
  for (const slug of queue) level.set(slug, 1);
  while (queue.length) {
    const slug = queue.shift();
    for (const next of dependents.get(slug)) {
      level.set(next, Math.max(level.get(next) ?? 1, level.get(slug) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const cyclic = [...indegree.entries()].filter(([, n]) => n > 0).map(([slug]) => slug);
  if (cyclic.length) errors.push(`dependency cycle among: ${cyclic.join(", ")}`);

  const features = breakdown.features.map((f) => {
    const roadmap = roadmapBySlug.get(f.slug) ?? null;
    const state = roadmap ? roadmap.status : "unplanned";
    // Only `status: complete` satisfies Requires (plan Decision 3).
    const blockedBy = f.requires.filter((d) => roadmapBySlug.get(d)?.status !== "complete");
    return {
      slug: f.slug,
      state,
      roadmap: roadmap ? roadmap.roadmap : null,
      branch: roadmap ? roadmap.branch : `${config.branches.feature}${f.slug}`,
      artifactPr: roadmap?.artifactPr ?? null,
      requires: f.requires,
      recommendedAfter: f.recommendedAfter,
      wave: f.wave,
      computedWave: level.get(f.slug) ?? null,
      order: f.order,
      blockedBy,
      ready: state === "unplanned" && blockedBy.length === 0,
    };
  });

  const waves = [];
  for (const f of features) {
    if (f.computedWave === null) continue;
    (waves[f.computedWave - 1] ??= []).push(f.slug);
  }
  const rank = (f) => [f.wave ?? f.computedWave ?? Number.MAX_SAFE_INTEGER, f.computedWave ?? Number.MAX_SAFE_INTEGER, f.order];
  const next = features
    .filter((f) => f.ready)
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    })[0]?.slug ?? null;

  return {
    status: errors.length ? "invalid" : "ok",
    errors,
    features,
    waves: waves.map((w) => w ?? []),
    next,
    done: features.length > 0 && features.every((f) => f.state === "complete"),
  };
}
// The ref a delivery branch is judged from: origin/<branch> when fetched, else the
// local branch (with a warning: no fetch happens here), else HEAD. `g` binds the
// checkout holding the artifacts (this one's, or a branch layout's companion).
function refFor(branch, g = agit) {
  if (branch && g("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`)) return { ref: `origin/${branch}`, warning: null };
  if (branch && g("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) {
    return { ref: branch, warning: `${branch}: origin/${branch} is absent, so review freshness and roadmap state reflect the local branch as of the last fetch` };
  }
  return { ref: "HEAD", warning: null };
}
// --- documents -------------------------------------------------------------

const STATUS_ORDER = ["in-progress", "paused", "in-review", "planned", "complete"];
const byStatusOrder = (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.slug.localeCompare(b.slug);

// What `status` emits. `lookup` as in sessionRecord; `roadmaps` replaces the walk.
function statusDocument({ typeFilter = null, slugFilter = null, pr: withPr = false, lookup = lookupPullRequest, roadmaps = null } = {}) {
  const worktrees = productWorktrees();
  const sessionWorktreesDir = primaryWorktreesDir(worktrees);
  const items = (roadmaps ?? allRoadmaps(typeFilter, managedHalves(worktrees))).filter((r) => !slugFilter || r.slug === slugFilter);
  const bySlug = new Map();
  for (const item of items) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item.roadmap]);
  const duplicates = [...bySlug.entries()].filter(([, paths]) => paths.length > 1).map(([slug, paths]) => ({ slug, paths }));
  items.sort(byStatusOrder);
  // Additive dashboard fields (lifecycle, ownership, PR state) so renderers never re-derive them.
  const warnings = [];
  const layout = checkoutLayout();
  for (const item of items) {
    // Complete roadmaps skip the lookup: their PRs are merged history, not dashboard state.
    const looked = withPr && item.status !== "complete";
    const { pr, warnings: prWarnings } = looked ? lookup(item.branch) : { pr: null, warnings: [] };
    const { pr: companionPr, warnings: companionPrWarnings } = looked ? lookupCompanionPullRequest(item.branch, layout, lookup) : { pr: null, warnings: [] };
    const { lifecycle, warnings: lifecycleWarnings } = deriveLifecycle({ delivery: item, pr, companionPr });
    const owner = findOwner({ worktrees, worktreesDir: sessionWorktreesDir, branch: item.branch, config });
    const managedOwner = owner && owner.role !== "primary" && owner.dirPrefix ? { isManaged: true, dirPrefix: owner.dirPrefix, id: owner.id } : null;
    item.lifecycle = lifecycle;
    item.owner = owner;
    item.workspace = managedOwner ? describeWorkspace(managedOwner, sessionWorktreesDir) : null;
    item.companion = companionOfOwner(owner, layout);
    const actions = deriveAllowed({ role: owner?.role ?? "primary", lifecycle, delivery: item, worktree: owner });
    item.allowed = actions.allowed;
    item.elsewhere = actions.elsewhere;
    item.pr = pr;
    item.companionPr = companionPr;
    warnings.push(...[...prWarnings, ...companionPrWarnings, ...lifecycleWarnings].map((w) => `${item.slug}: ${w}`));
  }
  return {
    status: "ok",
    root,
    currentBranch,
    defaultBranch: config.branches.default,
    items,
    duplicates,
    resumable: items.filter((i) => ["in-progress", "paused", "in-review"].includes(i.status)).map((i) => i.slug),
    lifecycles: LIFECYCLES,
    warnings,
  };
}

// The roadmaps `initiative` derives from. Same bases as `status`: a member planned on
// an unmerged delivery branch lives only in its managed half and must not stay
// "unplanned"/ready here (the Initiatives view would otherwise keep its plan play
// button, which starts a second session instead of offering build/ap).
const initiativeRoadmaps = () => allRoadmaps("feature", managedHalves(productWorktrees()));

// What `initiative` emits.
function initiativeListDocument(roadmaps, breakdowns = allBreakdowns()) {
  const items = breakdowns.map((b) => {
    const d = deriveInitiative(b, roadmaps);
    return {
      slug: b.slug,
      dir: b.dir,
      created: b.created,
      lastUpdated: b.lastUpdated,
      total: d.features.length,
      complete: d.features.filter((f) => f.state === "complete").length,
      inFlight: d.features.filter((f) => !["unplanned", "complete"].includes(f.state)).length,
      ready: d.features.filter((f) => f.ready).length,
      done: d.done,
      valid: d.status === "ok",
    };
  });
  return { status: "ok", initiativesRoot: config.artifacts.initiatives, items, root, configSource: source };
}

// What `initiative <slug>` emits.
function initiativeDetailDocument(slug, roadmaps, breakdowns = allBreakdowns()) {
  const breakdown = breakdowns.find((b) => b.slug === slug);
  if (!breakdown) return { status: "missing", message: `No breakdown.md for initiative ${slug} under ${config.artifacts.initiatives}/.`, root, configSource: source };
  const derived = deriveInitiative(breakdown, roadmaps);
  return {
    ...derived,
    initiative: { slug: breakdown.slug, dir: breakdown.dir, breakdown: breakdown.breakdown, created: breakdown.created, lastUpdated: breakdown.lastUpdated },
    anomalies: mergedAnomalies(derived.features),
    root,
    configSource: source,
  };
}

// --- metrics: git history only, never gh, never network ------------------------

// Fixed diff output whatever the user's git config says (prefixes, colour, external diff, renames).
const METRICS_PATCH = ["--reverse", "--format=%x00commit %H %cI", "-p", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
const METRICS_MAX_BUFFER = 256 * 1024 * 1024;

// origin/<default>, else <default>, else HEAD — in the clone `g` binds.
function defaultRefIn(g) {
  const name = config.branches.default;
  if (g("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`)) return `origin/${name}`;
  if (g("rev-parse", "--verify", "--quiet", `refs/heads/${name}`)) return name;
  return "HEAD";
}

// The git logs `metrics` reads, as [cwd, args] pairs: one patch log over every
// roadmap.md/review.md on the artifact default ref, one branch-only patch log per
// non-complete item whose delivery branch resolves, one first-parent merge log of
// the product default.
function metricsPlan(roadmaps) {
  const artifactRef = defaultRefIn(agit);
  const productRef = artifacts.external ? defaultRefIn((...args) => git(root, ...args)) : artifactRef;
  const pathspecs = [config.artifacts.features, config.artifacts.issues].flatMap((r) => [`:(glob)${r}/**/roadmap.md`, `:(glob)${r}/**/review.md`]);
  const branches = [];
  for (const record of roadmaps) {
    if (record.status === "complete" || !record.branch) continue;
    const { ref } = refFor(record.branch, agit);
    if (ref === "HEAD") continue;
    branches.push({ roadmap: record.roadmap, ref, run: [artifactsRoot, ["log", ref, "--not", artifactRef, ...METRICS_PATCH, "--", `${record.dir}/roadmap.md`, `${record.dir}/review.md`]] });
  }
  return {
    ref: { artifacts: artifactRef, product: productRef },
    artifacts: [artifactsRoot, ["log", artifactRef, ...METRICS_PATCH, "--", ...pathspecs]],
    branches,
    product: [root, ["log", "--first-parent", "--merges", productRef, "--format=%H%x09%cI%x09%s"]],
  };
}

// A missing ref or a failed log reads as no history (the items then carry warnings).
function gitLogText(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: METRICS_MAX_BUFFER });
  } catch {
    return "";
  }
}

async function gitLogTextAsync(cwd, args) {
  try {
    return (await execAsync("git", ["-C", cwd, ...args], { maxBuffer: METRICS_MAX_BUFFER })).stdout;
  } catch {
    return "";
  }
}

function readMetricsLogs(plan) {
  return {
    artifacts: gitLogText(...plan.artifacts),
    branches: new Map(plan.branches.map((b) => [b.roadmap, gitLogText(...b.run)])),
    product: gitLogText(...plan.product),
  };
}

async function readMetricsLogsAsync(plan) {
  const [artifactsText, productText, ...branchTexts] = await Promise.all([plan.artifacts, plan.product, ...plan.branches.map((b) => b.run)].map((run) => gitLogTextAsync(...run)));
  return { artifacts: artifactsText, branches: new Map(plan.branches.map((b, i) => [b.roadmap, branchTexts[i]])), product: productText };
}

// What `metrics [<slug>]` emits. `roadmaps` replaces the walk; `plan` and `logs` are
// the dashboard's injection point (it reads the logs asynchronously beside its PR lookups).
function metricsDocument({ slugFilter = null, roadmaps = null, now = Date.now(), plan = null, logs = null } = {}) {
  const records = [...(roadmaps ?? allRoadmaps(null, managedHalves(productWorktrees())))].filter((r) => !slugFilter || r.slug === slugFilter).sort(byStatusOrder);
  if (slugFilter && !records.length) return { status: "missing", message: `No roadmap for slug ${slugFilter} under ${config.artifacts.features}/ or ${config.artifacts.issues}/.`, root, configSource: source };
  const planned = plan ?? metricsPlan(records);
  const read = logs ?? readMetricsLogs(planned);
  const byDir = parseArtifactLog(read.artifacts);
  const merged = parseMergeLog(read.product);
  const items = records.map((record) => {
    const branch = planned.branches.find((b) => b.roadmap === record.roadmap);
    const events = [...(byDir.get(record.dir) ?? [])];
    if (branch) events.push(...(parseArtifactLog(read.branches.get(record.roadmap) ?? "").get(record.dir) ?? []));
    return deriveMetrics({ record, events, merged, now, ref: branch?.ref ?? planned.ref.artifacts });
  });
  return { status: "ok", generatedAt: new Date(now).toISOString(), ref: planned.ref, items, aggregate: aggregateMetrics(items), root, configSource: source };
}
// What `dashboard` emits: the session, doctor, status (`deliveries`), initiative, and
// metrics documents from one process. The roadmaps are walked once for deliveries,
// initiatives, and metrics; every PR lookup (with `pr`) and the doctor's probes run
// through one bounded pool, and the metrics git logs run beside it, while the local
// doctor checks and the initiatives are computed. A section that throws becomes
// { status: "error", message }.
async function dashboardDocument({ pr: withPr = false } = {}) {
  const started = performance.now();
  const attempt = (build) => {
    try {
      return { value: build() };
    } catch (error) {
      return { error };
    }
  };
  const session = attempt(() => sessionContext());
  const roadmaps = attempt(() => allRoadmaps(null, managedHalves(productWorktrees())));

  const requests = [];
  if (withPr) {
    const layout = checkoutLayout();
    const branches = [session.value?.prBranch, ...(roadmaps.value ?? []).filter((r) => r.status !== "complete").map((r) => r.branch)];
    for (const branch of branches) {
      requests.push({ branch, cwd: root, label: "pr" });
      if (layout.artifacts.external) requests.push({ branch, cwd: layout.artifactsRoot, label: "companionPr" });
    }
  }
  const timings = {};
  const section = (name, build) => {
    const sectionStarted = performance.now();
    try {
      return build();
    } catch (error) {
      return { status: "error", message: error?.message ?? String(error) };
    } finally {
      timings[name] = Math.round(performance.now() - sectionStarted);
    }
  };
  const valueOf = (attempted) => {
    if (attempted.error) throw attempted.error;
    return attempted.value;
  };

  // The lookups wait on `gh --version`; with it cached they spawn on the next turn,
  // before the synchronous work below blocks the event loop.
  if (requests.length) await probeAsync("gh", ["--version"]);
  const prefetch = lookupPullRequests(requests, { probes: doctorProbes() });
  // The metrics logs (git only) overlap the PR lookups and the synchronous sections below.
  const metricsPlanned = attempt(() => metricsPlan(valueOf(roadmaps)));
  const metricsLogs = metricsPlanned.error ? Promise.resolve(null) : readMetricsLogsAsync(metricsPlanned.value);
  await new Promise((resolve) => setImmediate(resolve));
  const initiatives = section("initiatives", () => {
    const features = valueOf(roadmaps).filter((r) => r.type === "feature");
    const breakdowns = allBreakdowns();
    const list = initiativeListDocument(features, breakdowns);
    return { list, details: Object.fromEntries(list.items.map((item) => [item.slug, initiativeDetailDocument(item.slug, features, breakdowns)])) };
  });
  runDoctor(LOCAL_DOCTOR_CHECKS);
  const lookup = prefetchedLookup(await prefetch);
  const logs = await metricsLogs;

  const document = {
    status: "ok",
    session: section("session", () => sessionRecord({ pr: withPr, lookup }, valueOf(session))),
    doctor: section("doctor", () => doctorDocument()),
    // statusDocument adds fields to its items; the initiatives read the records unchanged.
    deliveries: section("deliveries", () => statusDocument({ pr: withPr, lookup, roadmaps: valueOf(roadmaps).map((r) => ({ ...r })) })),
    initiatives,
    metrics: section("metrics", () => metricsDocument({ roadmaps: valueOf(roadmaps), plan: valueOf(metricsPlanned), logs })),
  };
  timings.total = Math.round(performance.now() - started);
  return { ...document, timings, root, configSource: source };
}

export {
  statusDocument,
  initiativeRoadmaps,
  initiativeListDocument,
  initiativeDetailDocument,
  allBreakdowns,
  deriveInitiative,
  mergedAnomalies,
  refFor,
  metricsDocument,
  dashboardDocument,
};
