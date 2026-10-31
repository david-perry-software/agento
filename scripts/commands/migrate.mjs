// The `migrate` subcommand and its helpers, moved unchanged from
// `scripts/agento.mjs`.

import fs from "node:fs";
import path from "node:path";

import { parseWorktreeList } from "../session-state.mjs";
import { config, emit, git, options, PLUGIN_ROOT, productWorktrees, rest, root, samePath, source, usage } from "../lib/context.mjs";
import { describe, holdsArtifacts, parseBreakdown, walkBreakdowns, walkRoadmaps } from "../lib/records.mjs";

const ROOT_KEYS = ["features", "issues", "initiatives"];

// Every regular file under `base` as { rel (posix, relative to base), bytes }.
function listFiles(base) {
  const out = [];
  if (!fs.existsSync(base)) return out;
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
      else if (entry.isFile()) out.push({ rel: path.relative(base, child).split(path.sep).join("/"), bytes: fs.statSync(child).size });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// The three artifact roots under `base`: their relative path, file count, and bytes.
const describeRoots = (base) =>
  ROOT_KEYS.map((key) => {
    const rel = config.artifacts[key];
    const files = listFiles(path.join(base, rel));
    return { rel, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  });

// Every roadmap and breakdown record under the roots at `base`, in path order, so
// the same tree read before and after a move compares equal.
function recordsUnder(base) {
  const roadmaps = [];
  for (const type of ["feature", "issue"]) {
    const top = path.join(base, type === "feature" ? config.artifacts.features : config.artifacts.issues);
    for (const file of walkRoadmaps(top)) roadmaps.push(describe(file, type, base));
  }
  const breakdowns = [...walkBreakdowns(path.join(base, config.artifacts.initiatives))]
    .map((file) => parseBreakdown(file, base))
    .map((b) => ({ slug: b.slug, dir: b.dir, breakdown: b.breakdown, features: b.features.map((f) => f.slug) }));
  const byPath = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
  return { roadmaps: roadmaps.sort(byPath("roadmap")), breakdowns: breakdowns.sort(byPath("breakdown")) };
}

// `<owner>/<repo>` of the product's origin when it parses, else the primary's basename.
function productName(primaryRoot) {
  const url = git(root, "remote", "get-url", "origin");
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : path.basename(primaryRoot);
}

// Set only artifacts.repo.name in the product config, creating it from the plugin
// template when absent; every other key is preserved verbatim.
function writeCompanionName(name) {
  const file = path.join(root, ".github", "agento.json");
  let raw;
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8"));
  else raw = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "templates", "agento.json"), "utf8"));
  raw.artifacts ??= {};
  raw.artifacts.repo = { ...(raw.artifacts.repo ?? {}), name };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return file;
}

const MIGRATED_HEADING = "## Migrated history";

function appendMigrationNote(destination, product) {
  const file = path.join(destination, "README.md");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (new RegExp(`^${MIGRATED_HEADING}\\s*$`, "m").test(existing)) return false;
  const note = [
    MIGRATED_HEADING,
    "",
    "The delivery artifacts under `features/`, `issues/`, and `initiatives/` were",
    `moved here from the product repository \`${product}\` by \`/agento agento-init --migrate\`.`,
    "Plans written before the migration link to the product repository with",
    "`../../../../<path>` relative to their old location; read them against",
    `\`${product}\` at the time of writing.`,
    "",
  ].join("\n");
  const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${existing}${separator}${note}`);
  return true;
}

function recordsDiff(before, after) {
  const diff = [];
  for (const kind of ["roadmaps", "breakdowns"]) {
    const key = kind === "roadmaps" ? "roadmap" : "breakdown";
    const b = new Map(before[kind].map((r) => [r[key], JSON.stringify(r)]));
    const a = new Map(after[kind].map((r) => [r[key], JSON.stringify(r)]));
    for (const [p, v] of b) diff.push(...(!a.has(p) ? [{ path: p, kind: "missing" }] : a.get(p) !== v ? [{ path: p, kind: "changed" }] : []));
    for (const p of a.keys()) if (!b.has(p)) diff.push({ path: p, kind: "added" });
  }
  return diff;
}

export const commands = {
  migrate() {
    // Filesystem work only: the caller stages, commits, and pushes both sides so
    // the delivery guard keeps governing every write to git.
    if (!rest[0]) usage("migrate takes the companion checkout to move the artifact roots into: migrate <companion-checkout> [--apply]");
    const destination = path.resolve(process.cwd(), rest[0]);
    const destTop = git(destination, "rev-parse", "--show-toplevel");
    const fail = (reason, message, extra = {}) => emit({ status: "error", reason, source: root, destination, message, ...extra, root, configSource: source }, 3);
    if (!destTop || !samePath(destTop, destination)) fail("not-a-checkout", `${destination} is not the toplevel of a git checkout; pass the companion clone or one of its worktrees.`);
    const clone = parseWorktreeList(git(destination, "worktree", "list", "--porcelain"))[0]?.path ?? destination;
    const primaryRoot = productWorktrees()[0]?.path ?? root;
    if (samePath(clone, primaryRoot) || !samePath(path.dirname(clone), path.dirname(primaryRoot))) {
      fail("not-sibling", `${clone} must be a sibling checkout of the primary ${primaryRoot} (the companion is resolved as ../<name> from there).`, { clone, primary: primaryRoot });
    }
    const name = path.basename(clone);
    const repo = config.artifacts.repo ?? {};
    const configSet = repo.name != null || repo.dir != null;
    const sourceRoots = describeRoots(root);
    const base = { source: root, destination, clone, name, configSet };
    const movable = ROOT_KEYS.some((key) => holdsArtifacts(path.join(root, config.artifacts[key])));
    if (!movable) emit({ status: "ok", mode: "nothing-to-migrate", ...base, roots: sourceRoots, root, configSource: source });
    const conflicts = [];
    for (const key of ROOT_KEYS) {
      const rel = config.artifacts[key];
      for (const file of listFiles(path.join(root, rel))) {
        const target = path.join(destination, rel, file.rel);
        if (path.basename(target) !== ".gitkeep" && fs.existsSync(target)) conflicts.push(path.posix.join(rel, file.rel));
      }
    }
    const records = recordsUnder(root);
    if (conflicts.length) emit({ status: "conflict", mode: options.apply ? "apply" : "dry-run", ...base, roots: sourceRoots, conflicts, records, message: `${conflicts.length} file(s) already exist under ${destination} and would be overwritten; nothing was written.`, root, configSource: source }, 3);
    if (!options.apply) emit({ status: "ok", mode: "dry-run", ...base, roots: sourceRoots, conflicts, records, root, configSource: source });
    const moved = [];
    for (const key of ROOT_KEYS) {
      const rel = config.artifacts[key];
      const src = path.join(root, rel);
      if (!fs.existsSync(src)) continue;
      fs.cpSync(src, path.join(destination, rel), { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      moved.push(rel);
    }
    const configWritten = writeCompanionName(name);
    const readmeNoteAdded = appendMigrationNote(destination, productName(primaryRoot));
    const after = recordsUnder(destination);
    const diff = recordsDiff(records, after);
    emit({
      status: "ok",
      mode: "applied",
      ...base,
      configSet: true,
      roots: describeRoots(destination),
      moved,
      configWritten,
      readmeNoteAdded,
      records: { ...after, identical: diff.length === 0, diff },
      root,
      configSource: source,
    });
  },
};
