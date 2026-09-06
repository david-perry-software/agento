#!/usr/bin/env node
// Agento CLI: the deterministic half of the delivery workflow. Prompts call this
// instead of re-deriving slug resolution, status listings, and config lookups in
// prose. Always prints one JSON document; exit 0 when the result is usable, 1 on a
// usage error, 3 when the resolution itself failed (conflict, mismatch, missing).
//
//   node scripts/agento.mjs config
//   node scripts/agento.mjs resolve <feature|issue> <slug>
//   node scripts/agento.mjs find <slug>                 (type-agnostic)
//   node scripts/agento.mjs status [feature|issue] [slug]
//   node scripts/agento.mjs close-decision <feature|issue> <slug>
//   node scripts/agento.mjs ship-preflight <feature|issue> <slug>
//   node scripts/agento.mjs ports <slug>
//   node scripts/agento.mjs paths <feature|issue|plan|freehand> <slug|session-id>
//   node scripts/agento.mjs initiative [<slug>]
//
// Options: --root <dir> (default: the git toplevel of the cwd).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentoConfig } from "./agento-config.mjs";
import {
  closeBuildSessionDecision,
  evaluateShipPreflight,
  resolveRoadmapArtifact,
} from "./delivery-roadmap-resolver.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function usage(message) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17);
  emit({ status: "usage-error", message, usage: lines.map((l) => l.replace(/^\/\/ ?/, "")) }, 1);
}

function emit(result, code = 0) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(code);
}

function git(root, ...args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else positional.push(arg);
  }
  return { positional, options };
}

const { positional, options } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
const startDir = path.resolve(options.root ?? process.cwd());
const root = git(startDir, "rev-parse", "--show-toplevel") || startDir;
const { config, source } = loadAgentoConfig(root);
const repoName = path.basename(root);
const worktreesDir = path.resolve(root, config.worktrees.dir);
const currentBranch = git(root, "branch", "--show-current");
const gitAdapter = {
  lsTree: (ref) => git(root, "ls-tree", "-r", "--name-only", ref),
  show: (spec) => git(root, "show", spec),
};

function requireType(type) {
  if (type !== "feature" && type !== "issue") usage(`type must be feature or issue, got ${JSON.stringify(type ?? "")}`);
  return type;
}

function requireSlug(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) usage(`slug must match [a-z0-9][a-z0-9-]{1,63}, got ${JSON.stringify(slug ?? "")}`);
  return slug;
}

function header(content, key) {
  // Quoted values may contain `#` (github-issue: "#12"); bare values stop at a comment.
  const match = content.match(new RegExp(`(?:^|\\n)${key}:[ \\t]*("[^"\\n]*"|'[^'\\n]*'|[^\\n#]*)`));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function* walkFiles(base, name) {
  if (!fs.existsSync(base)) return;
  const stack = [base];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && entry.name === name) yield child;
    }
  }
}

const walkRoadmaps = (base) => walkFiles(base, "roadmap.md");
const walkBreakdowns = (base) => walkFiles(base, "breakdown.md");

function describe(file, type) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const steps = [...content.matchAll(/^- \[( |x)\] \d+\.\d+/gm)];
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  return {
    type,
    slug: path.basename(dir),
    dir: rel(dir),
    roadmap: rel(file),
    plan: fs.existsSync(path.join(dir, "plan.md")) ? rel(path.join(dir, "plan.md")) : null,
    review: fs.existsSync(path.join(dir, "review.md")) ? rel(path.join(dir, "review.md")) : null,
    reviewVerdict: fs.existsSync(path.join(dir, "review.md"))
      ? (fs.readFileSync(path.join(dir, "review.md"), "utf8").match(/^Verdict:\s*(approve|request-changes)/m)?.[1] ?? null)
      : null,
    status: header(content, "status"),
    branch: header(content, "branch"),
    lastUpdated: header(content, "last-updated"),
    nextStep: header(content, "next-step"),
    githubIssue: header(content, "github-issue") || null,
    initiative: header(content, "initiative") || null,
    steps: { ticked: steps.filter((m) => m[1] === "x").length, total: steps.length },
    postShipPending: (content.match(/^- \[ \] \d+\.\d+ \(manual, post-ship\)/gm) ?? []).length,
  };
}

function allRoadmaps(typeFilter) {
  const out = [];
  for (const type of ["feature", "issue"]) {
    if (typeFilter && type !== typeFilter) continue;
    const base = path.join(root, type === "feature" ? config.artifacts.features : config.artifacts.issues);
    for (const file of walkRoadmaps(base)) out.push(describe(file, type));
  }
  return out;
}

function withExit(result) {
  emit({ ...result, root, configSource: source }, result.status === "ok" ? 0 : 3);
}

// --- initiatives -----------------------------------------------------------

function slugList(value) {
  const cleaned = value.replace(/`/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) return [];
  return cleaned.split(/[\s,]+/).filter(Boolean);
}

function parseBreakdown(file) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const features = [];
  let inFeatures = false;
  let current = null;
  for (const line of content.split("\n")) {
    if (/^## /.test(line)) {
      inFeatures = /^## Features\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inFeatures) continue;
    const heading = line.match(/^### +(.+?)\s*$/);
    if (heading) {
      current = { slug: heading[1].replace(/`/g, ""), requires: [], recommendedAfter: [], wave: null, order: features.length };
      features.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^- (Requires|Recommended after|Wave):\s*(.*)$/i);
    if (!bullet) continue;
    const key = bullet[1].toLowerCase();
    const value = bullet[2];
    if (key === "wave") {
      const n = Number.parseInt(value.replace(/`/g, ""), 10);
      current.wave = Number.isNaN(n) ? null : n;
    } else if (key === "requires") current.requires = slugList(value);
    else current.recommendedAfter = slugList(value);
  }
  return {
    slug: path.basename(dir),
    dir: rel(dir),
    breakdown: rel(file),
    created: header(content, "created") || null,
    lastUpdated: header(content, "last-updated") || null,
    features,
  };
}

function allBreakdowns() {
  const base = path.join(root, config.artifacts.initiatives);
  return [...walkBreakdowns(base)].sort().map(parseBreakdown);
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

switch (command) {
  case "config":
    emit({
      status: "ok",
      root,
      repoName,
      configSource: source,
      pluginRoot: PLUGIN_ROOT,
      currentBranch,
      config: { ...config, worktrees: { dir: worktreesDir } },
    });
    break;

  case "resolve": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(resolveRoadmapArtifact({ rootDir: root, type, slug, currentBranch, git: gitAdapter, config }));
    break;
  }

  case "find": {
    const slug = requireSlug(rest[0]);
    const results = ["feature", "issue"].map((type) => ({
      type,
      ...resolveRoadmapArtifact({ rootDir: root, type, slug, currentBranch, git: gitAdapter, config }),
    }));
    const found = results.filter((r) => r.status !== "missing");
    if (found.length === 0) withExit({ status: "missing", message: `No roadmap for slug ${slug} under ${config.artifacts.features}/ or ${config.artifacts.issues}/, locally or on origin.` });
    if (found.length > 1) withExit({ status: "conflict", candidates: found, message: `Slug ${slug} exists as both a feature and an issue; specify the type.` });
    withExit(found[0]);
    break;
  }

  case "status": {
    const typeFilter = rest[0] ? requireType(rest[0]) : null;
    const slugFilter = rest[1] ? requireSlug(rest[1]) : null;
    const items = allRoadmaps(typeFilter).filter((r) => !slugFilter || r.slug === slugFilter);
    const bySlug = new Map();
    for (const item of items) bySlug.set(item.slug, [...(bySlug.get(item.slug) ?? []), item.roadmap]);
    const duplicates = [...bySlug.entries()].filter(([, paths]) => paths.length > 1).map(([slug, paths]) => ({ slug, paths }));
    const order = ["in-progress", "paused", "in-review", "planned", "complete"];
    items.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.slug.localeCompare(b.slug));
    emit({ status: "ok", root, currentBranch, defaultBranch: config.branches.default, items, duplicates, resumable: items.filter((i) => ["in-progress", "paused", "in-review"].includes(i.status)).map((i) => i.slug) });
    break;
  }

  case "close-decision": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(closeBuildSessionDecision({ type, slug, currentBranch, worktreeList: git(root, "worktree", "list", "--porcelain"), git: gitAdapter, rootDir: root, config }));
    break;
  }

  case "ship-preflight": {
    const type = requireType(rest[0]);
    const slug = requireSlug(rest[1]);
    withExit(evaluateShipPreflight({ type, slug, rootDir: root, currentBranch, git: gitAdapter, config }));
    break;
  }

  case "ports": {
    // Stable per-slug ports so concurrent sessions never collide and a resumed
    // session reuses the same numbers (see concurrent-delivery.instructions.md).
    const slug = requireSlug(rest[0]);
    let hash = 0;
    for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const offset = hash % 90;
    emit({ status: "ok", slug, WEB_PORT: 3100 + offset, API_PORT: 4100 + offset, offset });
    break;
  }

  case "paths": {
    const kind = rest[0];
    const id = rest[1];
    if (!["feature", "issue", "plan", "freehand"].includes(kind)) usage("paths kind must be feature, issue, plan, or freehand");
    requireSlug(id);
    const prefixes = { feature: config.branches.feature, issue: config.branches.issue, freehand: config.branches.freehand };
    emit({
      status: "ok",
      worktreesDir,
      worktree: path.join(worktreesDir, `${kind}-${id}`),
      branch: kind === "plan" ? null : `${prefixes[kind]}${id}`,
      artifactRoot: kind === "feature" ? config.artifacts.features : kind === "issue" ? config.artifacts.issues : null,
      defaultBranch: config.branches.default,
      postShipBranch: kind === "plan" || kind === "freehand" ? null : `${config.branches.postShip}${id}`,
    });
    break;
  }

  case "initiative": {
    const slug = rest[0] ? requireSlug(rest[0]) : null;
    const breakdowns = allBreakdowns();
    if (!slug) {
      const items = breakdowns.map((b) => ({ slug: b.slug, dir: b.dir, created: b.created, lastUpdated: b.lastUpdated, total: b.features.length }));
      withExit({ status: "ok", initiativesRoot: config.artifacts.initiatives, items });
    }
    const breakdown = breakdowns.find((b) => b.slug === slug);
    if (!breakdown) withExit({ status: "missing", message: `No breakdown.md for initiative ${slug} under ${config.artifacts.initiatives}/.` });
    const derived = deriveInitiative(breakdown, allRoadmaps("feature"));
    withExit({
      ...derived,
      initiative: { slug: breakdown.slug, dir: breakdown.dir, breakdown: breakdown.breakdown, created: breakdown.created, lastUpdated: breakdown.lastUpdated },
      anomalies: [],
    });
    break;
  }

  default:
    usage(command ? `unknown command ${command}` : "missing command");
}
