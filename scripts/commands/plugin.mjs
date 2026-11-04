// The `plugin` command family: export a clean plugin tree for VS Code to stage,
// and list/prune the staged snapshots VS Code keeps under `agentPlugins/`.
// Subcommands: export | snapshots | prune-snapshots.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config, emit, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import { expandHome, pluginLocations } from "../lib/plugin.mjs";

const refuse = (message, extra = {}) => emit({ status: "refused", message, ...extra }, 3);
const refusal = (message, data) => Object.assign(new Error(message), { data });

function gitTry(dir, ...args) {
  try {
    const stdout = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error?.stderr ?? error?.message ?? "").toString().trim() };
  }
}

// The source checkout: `--source` names one explicitly (refused when it is not a
// git checkout); otherwise the CLI's own checkout. A staged snapshot — a plain
// directory with no git metadata — is refused because it cannot be re-exported.
function resolveSourceRoot() {
  if (options.source !== undefined) {
    const dir = expandHome(options.source);
    const root = gitTry(dir, "rev-parse", "--show-toplevel");
    if (!root.ok || !root.stdout) throw refusal(`--source ${options.source} is not a git checkout; a staged snapshot cannot be exported — name the clone with --source`);
    return root.stdout;
  }
  const root = gitTry(PLUGIN_ROOT, "rev-parse", "--show-toplevel");
  if (!root.ok || !root.stdout) throw new Error("the CLI's own checkout is not a git repository");
  return root.stdout;
}

function resolveDest() {
  if (options.dest !== undefined) return expandHome(options.dest);
  const candidates = pluginLocations().filter((entry) => entry.kind === "export" || entry.kind === "clone");
  if (candidates.length === 0) throw refusal("no --dest and no enabled chat.pluginLocations entry is an Agento plugin (an export or a clone); pass --dest <dir>");
  if (candidates.length > 1) throw refusal("no --dest and several enabled chat.pluginLocations entries are Agento plugins; pass --dest <dir>", { candidates: candidates.map((entry) => entry.path) });
  return candidates[0].path;
}

// `git archive <commit>` piped into the temp tree — exactly the tracked files of
// the commit, no `.git`, no ignored or untracked content.
function archiveInto(source, commit, tempDir) {
  let tarBuffer;
  try {
    tarBuffer = execFileSync("git", ["-C", source, "archive", commit], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`git archive ${commit} failed: ${(error?.stderr ?? error?.message ?? "").toString().trim()}`);
  }
  try {
    execFileSync("tar", ["-xf", "-", "-C", tempDir], { input: tarBuffer, stdio: ["pipe", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`extracting the archive failed: ${(error?.stderr ?? error?.message ?? "").toString().trim()}`);
  }
}

// Atomically move the temp tree onto `dest`: old -> `<dest>.agento-old-<pid>`,
// temp -> `dest`, then delete the old tree. A failure before the swap leaves
// `dest` byte-identical.
function swap(dest, tempDir) {
  const old = `${dest}.agento-old-${process.pid}`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, old);
  try {
    fs.renameSync(tempDir, dest);
  } catch (error) {
    if (fs.existsSync(old) && !fs.existsSync(dest)) {
      try {
        fs.renameSync(old, dest);
      } catch {
        // keep the old tree where it is for manual recovery
      }
    }
    throw error;
  }
  if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
}

function runExport() {
  let tempDir = null;
  try {
    const source = resolveSourceRoot();
    const fetch = gitTry(source, "fetch");
    if (!fetch.ok) throw new Error(`git fetch failed: ${fetch.stderr}`);
    const ref = options.ref ?? `origin/${config.branches.default}`;
    const rev = gitTry(source, "rev-parse", "--verify", `${ref}^{commit}`);
    if (!rev.ok || !rev.stdout) throw refusal(`ref ${ref} does not resolve to a commit in ${source}`, { source });
    const commit = rev.stdout;
    const dest = resolveDest();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    tempDir = `${dest}.agento-export-${process.pid}`;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    archiveInto(source, commit, tempDir);
    const remote = gitTry(source, "remote", "get-url", "origin");
    const exportedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(tempDir, ".agento-export.json"),
      JSON.stringify({ source: { remote: remote.ok ? remote.stdout : null, ref, commit }, exportedAt, carriedPins: [] }, null, 2) + "\n",
    );
    swap(dest, tempDir);
    tempDir = null;
    emit({ status: "ok", dest, source: { remote: remote.ok ? remote.stdout : null, ref, commit }, exportedAt, carriedPins: [] });
  } catch (error) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    refuse(`plugin export: ${error.message}`, error.data ?? {});
  }
}

// Implemented in roadmap step 3.1.
function runSnapshots() {
  emit({ status: "ok", subcommand: "snapshots", stage: "registered" });
}

// Implemented in roadmap step 3.1.
function runPruneSnapshots() {
  emit({ status: "ok", subcommand: "prune-snapshots", stage: "registered" });
}

const SUBCOMMANDS = {
  export: runExport,
  snapshots: runSnapshots,
  "prune-snapshots": runPruneSnapshots,
};

export const commands = {
  plugin() {
    const [sub, ...args] = rest;
    const handler = SUBCOMMANDS[sub];
    if (!handler) usage(`plugin: unknown subcommand ${JSON.stringify(sub)}; known: export, snapshots, prune-snapshots`);
    if (args.length) usage(`plugin ${sub} takes no positional arguments, got ${JSON.stringify(args.join(" "))}`);
    handler();
  },
};
