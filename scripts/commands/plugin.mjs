// The `plugin` command family: export a clean plugin tree for VS Code to stage,
// and list/prune the staged snapshots VS Code keeps under `agentPlugins/`.
// Subcommands: export | snapshots | prune-snapshots.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { config, emit, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import { loadProfiles, modelsState, modelTargetFiles } from "../lib/models.mjs";
import { agentPluginsDir, classifyLocation, expandHome, listSnapshots, pluginLocations, snapshotDirName, snapshotsToPrune } from "../lib/plugin.mjs";
import { handoffModelLines, parseModelValue, readModel, setHandoffModels, setModel } from "../model-profiles.mjs";

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

// The single enabled Agento plugin location (an export or a clone) from
// `chat.pluginLocations`; refused with the candidates listed when there are none
// or several.
function resolveAgentoLocation() {
  const candidates = pluginLocations().filter((entry) => entry.kind === "export" || entry.kind === "clone");
  if (candidates.length === 0) throw refusal("no enabled chat.pluginLocations entry is an Agento plugin (an export or a clone); pass --dest <dir>");
  if (candidates.length > 1) throw refusal("several enabled chat.pluginLocations entries are Agento plugins; pass --dest <dir>", { candidates: candidates.map((entry) => entry.path) });
  return candidates[0].path;
}

function resolveDest() {
  return options.dest !== undefined ? expandHome(options.dest) : resolveAgentoLocation();
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

// The destination safety rules (roadmap step 2.3). A missing or empty destination
// is always fine; a non-empty destination must be an earlier export, or — only
// with `--replace-clone` — an Agento git clone with no changes beyond model pins,
// no untracked non-ignored files, no commits missing from every remote, and no
// stash entries. Returns the ignored bytes that the export will drop.
function checkDestination(dest) {
  let stat;
  try {
    stat = fs.lstatSync(dest);
  } catch {
    return { droppedIgnoredBytes: 0 };
  }
  if (!stat.isDirectory()) throw refusal(`destination ${dest} exists and is not a directory`);
  if (fs.readdirSync(dest).length === 0) return { droppedIgnoredBytes: 0 };
  const kind = classifyLocation(dest);
  if (kind === "export") return { droppedIgnoredBytes: 0 };
  if (kind === "clone") {
    if (!options.replaceClone) throw refusal(`destination ${dest} is an Agento git clone; pass --replace-clone to replace it with an export`);
    const blockers = cloneBlockers(dest);
    if (blockers.length) throw refusal(`destination ${dest} is a clone with ${blockers.join("; ")}`, { blockers });
    return { droppedIgnoredBytes: droppedIgnoredBytes(dest) };
  }
  throw refusal(`destination ${dest} is non-empty and is neither an earlier export nor (with --replace-clone) an Agento git clone`, { kind });
}

function cloneBlockers(dest) {
  const blockers = [];
  const state = modelsState(dest, loadProfiles());
  if (state.dirtyBeyondModel.length) blockers.push(`changes beyond model pins in ${state.dirtyBeyondModel.join(", ")}`);
  const untracked = gitTry(dest, "status", "--porcelain", "--untracked-files=all");
  const untrackedFiles = untracked.ok ? untracked.stdout.split("\n").filter((line) => line.startsWith("??")).map((line) => line.slice(3).trim()) : [];
  if (untrackedFiles.length) blockers.push(`untracked non-ignored files: ${untrackedFiles.join(", ")}`);
  const missing = gitTry(dest, "log", "--branches", "--not", "--remotes", "--oneline");
  if (missing.ok && missing.stdout.trim()) blockers.push(`commits missing from every remote (${missing.stdout.split("\n")[0]})`);
  const stash = gitTry(dest, "stash", "list");
  if (stash.ok && stash.stdout.trim()) blockers.push("stash entries");
  return blockers;
}

function droppedIgnoredBytes(dest) {
  const list = gitTry(dest, "ls-files", "--others", "--ignored", "--exclude-standard", "-z");
  if (!list.ok) return 0;
  let total = 0;
  for (const rel of list.stdout.split("\0").filter(Boolean)) {
    try {
      total += fs.lstatSync(path.join(dest, rel)).size;
    } catch {
      // already gone
    }
  }
  return total;
}

// Parse the value of a `model: <value>` line (the shape `handoffModelLines` and
// `renderModel` use), matching `parseModelValue`'s scalar/list handling.
function parseModelLineValue(line) {
  if (line === null) return null;
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}

// Carry the old destination's model pins (top-level `model:` line and handoff
// `model:` lines, read from the working tree so a filter-applied clone and an
// earlier export both work) into the freshly built tree. Files with no prior pin
// are listed under `unpinned`; `fallback` names the `models apply` to pin them.
function carryPins(oldDest, newTree) {
  const newFiles = modelTargetFiles(newTree).files;
  const oldFiles = new Set(modelTargetFiles(oldDest).files);
  const carriedPins = [];
  const unpinned = [];
  for (const file of newFiles) {
    const newPath = path.join(newTree, file);
    let newText = fs.readFileSync(newPath, "utf8");
    if (!oldFiles.has(file)) {
      unpinned.push(file);
      continue;
    }
    const oldText = fs.readFileSync(path.join(oldDest, file), "utf8");
    if (readModel(oldText) === null) {
      unpinned.push(file);
      continue;
    }
    const top = parseModelValue(oldText);
    const handoffs = handoffModelLines(oldText).map((item) => ({ target: item.target, value: parseModelLineValue(item.line) }));
    newText = setModel(newText, top);
    newText = setHandoffModels(newText, handoffs);
    fs.writeFileSync(newPath, newText);
    carriedPins.push(file);
  }
  const oldState = fs.existsSync(oldDest) ? modelsState(oldDest, loadProfiles()) : null;
  const activeName = oldState?.active && oldState.active !== "custom" ? oldState.active : "<name>";
  return { carriedPins, unpinned, fallback: `models apply ${activeName} --plugin-root <dest>` };
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
    const safety = checkDestination(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    tempDir = `${dest}.agento-export-${process.pid}`;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    archiveInto(source, commit, tempDir);
    const carry = carryPins(dest, tempDir);
    const remote = gitTry(source, "remote", "get-url", "origin");
    const exportedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(tempDir, ".agento-export.json"),
      JSON.stringify({ source: { remote: remote.ok ? remote.stdout : null, ref, commit }, exportedAt, carriedPins: carry.carriedPins }, null, 2) + "\n",
    );
    swap(dest, tempDir);
    tempDir = null;
    emit({
      status: "ok",
      dest,
      source: { remote: remote.ok ? remote.stdout : null, ref, commit },
      exportedAt,
      carriedPins: carry.carriedPins,
      unpinned: carry.unpinned,
      fallback: carry.fallback,
      droppedIgnoredBytes: safety.droppedIgnoredBytes,
    });
  } catch (error) {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    refuse(`plugin export: ${error.message}`, error.data ?? {});
  }
}

// du -h's human form of an allocated byte count: integer for >= 10 of a unit,
// one decimal below 10, K/M/G powers of 1024.
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}`;
  const kib = bytes / 1024;
  if (kib < 1024) return kib < 10 ? `${kib.toFixed(1)}K` : `${Math.ceil(kib)}K`;
  const mib = kib / 1024;
  if (mib < 1024) return mib < 10 ? `${mib.toFixed(1)}M` : `${Math.ceil(mib)}M`;
  const gib = mib / 1024;
  return gib < 10 ? `${gib.toFixed(1)}G` : `${Math.ceil(gib)}G`;
}

function runSnapshots() {
  try {
    const dest = resolveDest();
    const snapshots = listSnapshots(dest);
    const newest = snapshots.length ? snapshots[snapshots.length - 1].nonce : null;
    const total = snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
    emit({
      status: "ok",
      dest,
      locationDir: snapshotDirName(dest),
      count: snapshots.length,
      snapshots: snapshots.map((snapshot) => ({ ...snapshot, size: humanSize(snapshot.bytes) })),
      newest,
      total,
      totalSize: humanSize(total),
    });
  } catch (error) {
    refuse(`plugin snapshots: ${error.message}`, error.data ?? {});
  }
}

function runPruneSnapshots() {
  try {
    const dest = resolveDest();
    const snapshots = listSnapshots(dest);
    const { keep, remove } = snapshotsToPrune(snapshots, PLUGIN_ROOT);
    const freed = remove.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
    const removed = [];
    if (!options.dryRun) {
      for (const snapshot of remove) {
        fs.rmSync(snapshot.path, { recursive: true, force: true });
        removed.push(snapshot.nonce);
      }
    }
    emit({
      status: "ok",
      dest,
      locationDir: snapshotDirName(dest),
      dryRun: Boolean(options.dryRun),
      kept: keep.map((p) => path.basename(p)),
      removed,
      wouldRemove: options.dryRun ? remove.map((snapshot) => snapshot.nonce) : [],
      freedBytes: freed,
      freedSize: humanSize(freed),
      advice: "reload any open VS Code windows so they stop running from the deleted snapshots",
    });
  } catch (error) {
    refuse(`plugin prune-snapshots: ${error.message}`, error.data ?? {});
  }
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
