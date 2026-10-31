// Roadmap/breakdown record reading shared by status, next, resolve, migrate,
// and the initiative/dashboard documents. Moved unchanged from `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { agit, artifactsRoot, config, git, samePath } from "./context.mjs";

export function header(content, key) {
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

export const walkRoadmaps = (base) => walkFiles(base, "roadmap.md");
export const walkBreakdowns = (base) => walkFiles(base, "breakdown.md");

// One roadmap record from its content plus the sibling artifacts; `dir` and
// `roadmap` are repository-relative. Shared by the checkout and git-ref readers.
export function describeContent({ type, dir, roadmap, content, planExists, reviewContent }) {
  const steps = [...content.matchAll(/^- \[( |x)\] \d+\.\d+/gm)];
  return {
    type,
    slug: path.posix.basename(dir),
    dir,
    roadmap,
    plan: planExists ? `${dir}/plan.md` : null,
    review: reviewContent !== null ? `${dir}/review.md` : null,
    reviewVerdict: reviewContent !== null ? (reviewContent.match(/^Verdict:\s*(approve|request-changes)/m)?.[1] ?? null) : null,
    status: header(content, "status"),
    branch: header(content, "branch"),
    lastUpdated: header(content, "last-updated"),
    nextStep: header(content, "next-step"),
    githubIssue: header(content, "github-issue") || null,
    artifactPr: header(content, "artifact-pr") || null,
    initiative: header(content, "initiative") || null,
    steps: { ticked: steps.filter((m) => m[1] === "x").length, total: steps.length },
    postShipPending: (content.match(/^- \[ \] \d+\.\d+ \(manual, post-ship\)/gm) ?? []).length,
  };
}

export function describe(file, type, base = artifactsRoot) {
  const dir = path.dirname(file);
  const rel = (p) => path.relative(base, p).split(path.sep).join("/");
  const review = path.join(dir, "review.md");
  return describeContent({
    type,
    dir: rel(dir),
    roadmap: rel(file),
    content: fs.readFileSync(file, "utf8"),
    planExists: fs.existsSync(path.join(dir, "plan.md")),
    reviewContent: fs.existsSync(review) ? fs.readFileSync(review, "utf8") : null,
  });
}

// The same record read from a git ref (`origin/<branch>` or a local branch), for
// roadmaps that exist only on a delivery branch. `roadmap` is repository-relative;
// `g` is the git binding of the checkout that holds the ref (the artifacts root).
export function describeFromRef(ref, roadmap, type, g = agit) {
  const content = g("show", `${ref}:${roadmap}`);
  if (!content) return null;
  const dir = path.posix.dirname(roadmap);
  const tree = new Set(g("ls-tree", "--name-only", ref, `${dir}/`).split("\n").filter(Boolean));
  return describeContent({
    type,
    dir,
    roadmap,
    content,
    planExists: tree.has(`${dir}/plan.md`),
    reviewContent: tree.has(`${dir}/review.md`) ? g("show", `${ref}:${dir}/review.md`) : null,
  });
}

// The base directory each `allRoadmaps` record was read from (a managed half or the
// artifacts root), kept off the record so its shape stays the status contract.
export const recordBases = new WeakMap();

// `halves`: extra bases walked before the artifacts root — registered companion
// halves (companion mode) or managed build worktrees (in-repo), whose working trees
// carry roadmaps the artifact checkout's <default> has not merged yet. One
// repository-relative roadmap path seen in several bases resolves to the copy whose
// `branch:` header equals its base's checked-out branch (that delivery's own half is
// its truth); else the artifacts root's copy; else the first base listed. Null and
// missing bases are skipped, so `[]` is today's behaviour in the in-repo layout.
export function allRoadmaps(typeFilter, halves = []) {
  const bases = [];
  for (const base of [...halves, artifactsRoot]) {
    if (base && fs.existsSync(base) && !bases.some((b) => samePath(b, base))) bases.push(base);
  }
  const candidates = new Map();
  for (const base of bases) {
    const isRoot = samePath(base, artifactsRoot);
    let baseBranch = null;
    for (const type of ["feature", "issue"]) {
      if (typeFilter && type !== typeFilter) continue;
      const top = path.join(base, type === "feature" ? config.artifacts.features : config.artifacts.issues);
      for (const file of walkRoadmaps(top)) {
        const record = describe(file, type, base);
        recordBases.set(record, base);
        baseBranch ??= git(base, "branch", "--show-current");
        const entry = { record, matched: Boolean(baseBranch) && record.branch === baseBranch, isRoot };
        const list = candidates.get(record.roadmap);
        if (list) list.push(entry);
        else candidates.set(record.roadmap, [entry]);
      }
    }
  }
  const out = [];
  for (const list of candidates.values()) {
    const pick = list.find((e) => e.matched) ?? list.find((e) => e.isRoot) ?? list[0];
    out.push(pick.record);
  }
  return out;
}

// A root still holds artifacts when any file other than the scaffold's .gitkeep is under it.
export function holdsArtifacts(base) {
  if (!fs.existsSync(base)) return false;
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
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.name !== ".gitkeep") return true;
    }
  }
  return false;
}

function slugList(value) {
  const cleaned = value.replace(/`/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) return [];
  return cleaned.split(/[\s,]+/).filter(Boolean);
}

export function parseBreakdown(file, base = artifactsRoot) {
  const content = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const rel = (p) => path.relative(base, p).split(path.sep).join("/");
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
