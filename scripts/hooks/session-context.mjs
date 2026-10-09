// SessionStart context: the current branch, the Agento CLI path, a one-line `Session:`
// summary from `agento.mjs session`, the companion `Artifacts:` line in companion mode,
// and every resumable roadmap (status in-progress, paused, or in-review). The wrapper
// session-context.sh execs this module with the hook payload on stdin.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit, loadHookConfig, readPayload, realpath, resolveArtifacts, runGit } from "./hook-lib.mjs";

const SESSION_TIMEOUT_MS = 5000;
const RESUMABLE = new Set(["in-progress", "paused", "in-review"]);
const MANAGED_DIR = /^(plan|feature|issue|freehand)-(.+)$/;
const AGENTO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const show = (value) => (value == null ? "None" : String(value));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

// One `Session:` line from `agento.mjs session`; null on any failure so the rest of the
// context is unaffected.
export function sessionSummary(cli, cwd, nodeBin = process.execPath) {
  let data;
  try {
    const result = spawnSync(nodeBin, [cli, "session", "--root", cwd], {
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.error || result.status !== 0) return null;
    data = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!isObject(data) || data.status !== "ok") return null;
  const worktree = isObject(data.worktree) ? data.worktree : {};
  const delivery = data.delivery;
  const deliveryText = isObject(delivery) && delivery.slug ? `${show(delivery.type)}/${show(delivery.slug)}` : "none";
  const allowed = (Array.isArray(data.allowed) ? data.allowed : []).map(show).join("; ");
  const elsewhere = (Array.isArray(data.elsewhere) ? data.elsewhere : [])
    .filter(isObject)
    .map((e) => `${show(e.command)}@${show(e.window)}`)
    .join("; ");
  return (
    `Session: role=${show(data.role)} worktree=${show(worktree.path)} ` +
    `branch=${worktree.branch || "detached"} delivery=${deliveryText} ` +
    `lifecycle=${show(data.lifecycle)} allowed=[${allowed}] elsewhere=[${elsewhere}]`
  );
}

// Top-down directory walk that lists symlinked directories without descending into them.
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
  yield [dir, files];
  for (const entry of entries) {
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name));
  }
}

const headerValue = (content, key) => {
  const match = content.match(new RegExp(`^${key}:\\s*([^\\n#]+)`, "m"));
  return match ? match[1].trim() : "";
};

export function buildSessionContext({ payload = {}, agentoRoot = AGENTO_ROOT, nodeBin = process.execPath } = {}) {
  const cwd = payload.cwd || payload.workingDirectory || process.cwd();
  const root = runGit(cwd, "rev-parse", "--show-toplevel") || cwd;
  const branch = runGit(cwd, "branch", "--show-current") || "unknown";

  const config = loadHookConfig(root);
  const roots = [config.artifacts.features || "features", config.artifacts.issues || "issues"];
  const resolved = resolveArtifacts(root);
  let companion = resolved.companionPath;
  // A managed product half `<kind>-<id>` pairs with `<companion>-worktrees/<kind>-<id>`;
  // when that half exists it is the session's artifacts checkout, not the clone.
  if (resolved.external && realpath(root) !== realpath(resolved.primaryRoot) && MANAGED_DIR.test(path.basename(root))) {
    const half = path.join(resolved.companionWorktreesDir, path.basename(root));
    if (isDir(half)) companion = half;
  }
  // In companion mode the product's own features/ and issues/ are ignored.
  const walkRoot = resolved.external ? companion : root;

  const lines = [`Current git branch: ${branch}`];
  const cli = path.join(agentoRoot, "scripts", "agento.mjs");
  if (agentoRoot && isFile(cli)) {
    lines.push(`Agento CLI: node ${cli}`);
    const sessionLine = sessionSummary(cli, cwd, nodeBin);
    if (sessionLine) lines.push(sessionLine);
  }
  if (resolved.external) {
    const companionBranch = (isDir(companion) ? runGit(companion, "branch", "--show-current") : "") || "detached";
    lines.push(`Artifacts: ${companion} (branch ${companionBranch})`);
  }
  let found = false;
  for (const base of new Set(roots)) {
    for (const [dirpath, files] of walk(path.join(walkRoot, base))) {
      if (!files.includes("roadmap.md")) continue;
      let content;
      try {
        content = fs.readFileSync(path.join(dirpath, "roadmap.md"), "utf8");
      } catch {
        continue;
      }
      const status = headerValue(content, "status");
      if (!RESUMABLE.has(status)) continue;
      const nextStep = headerValue(content, "next-step");
      const rel = path.relative(walkRoot, dirpath) || ".";
      lines.push(`Delivery work: ${rel} [status: ${status}] next-step: ${nextStep}`);
      found = true;
    }
  }
  if (!found) lines.push(`No in-progress delivery work in ${roots[0]}/ or ${roots.at(-1)}/.`);
  return lines;
}

export function main() {
  try {
    const lines = buildSessionContext({ payload: readPayload() });
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
  } catch (error) {
    // A crashing hook must not fail session start: report it and add no context.
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
}

if (process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url))) main();
