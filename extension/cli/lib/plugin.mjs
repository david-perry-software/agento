// The shared plugin-location model: VS Code does not load an agent plugin from
// its `chat.pluginLocations` directory directly — it stages a full copy under
// `<config>/Code/agentPlugins/<location-dir>/<hex-nonce>/` and runs from the
// newest snapshot. This module names and lists those staged copies, classifies
// the registered locations, and owns the VS Code settings helpers that doctor
// and the `plugin` command family both need.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseJsonc } from "../vscode-windows.mjs";
import { gitRun } from "./git.mjs";

// VS Code's user settings.json; AGENTO_VSCODE_SETTINGS overrides the platform default.
export function vscodeSettingsPath(env = process.env) {
  if (env.AGENTO_VSCODE_SETTINGS) return env.AGENTO_VSCODE_SETTINGS;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "settings.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code", "User", "settings.json");
}

export const expandHome = (dir) => (dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir);

// The directory VS Code stages plugin snapshots under; AGENTO_VSCODE_AGENT_PLUGINS
// overrides the platform default (mirrors vscodeSettingsPath's platform layout).
export function agentPluginsDir(env = process.env) {
  if (env.AGENTO_VSCODE_AGENT_PLUGINS) return env.AGENTO_VSCODE_AGENT_PLUGINS;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "agentPlugins");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code", "agentPlugins");
}

// VS Code names the staged directory for a `file:` location as `file-` + the
// location path with `/` replaced by `-` and the leading `/` dropped (rule
// confirmed on this machine in roadmap step 1.1).
export function snapshotDirName(location) {
  const pathOnly = typeof location === "string" && location.startsWith("file://") ? location.slice("file://".length) : location;
  return `file-${expandHome(pathOnly).replace(/^\/+/, "").replace(/\//g, "-")}`;
}

// Hex-named children only: a nonce is the hex millisecond mtime of the location
// directory at snapshot time, so every snapshot directory is hex-named.
const HEX_NAME = /^[0-9a-f]+$/i;

// Allocated bytes of a path (du-style `st_blocks * 512`), so totals line up with
// `du -sh`; on filesystems that report zero blocks fall back to apparent size.
function allocatedBytes(p) {
  const stat = fs.lstatSync(p);
  const bytes = stat.blocks > 0 ? stat.blocks * 512 : stat.size;
  if (!stat.isDirectory()) return bytes;
  let total = bytes;
  for (const name of fs.readdirSync(p)) total += allocatedBytes(path.join(p, name));
  return total;
}

// The staged snapshots of a plugin location, oldest first; the newest snapshot is
// the largest nonce. Returns [{ nonce, path, bytes, mtime }].
export function listSnapshots(location, env = process.env) {
  const dir = path.join(agentPluginsDir(env), snapshotDirName(location));
  const snapshots = [];
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return snapshots;
  }
  if (!stat.isDirectory()) return snapshots;
  for (const name of fs.readdirSync(dir)) {
    if (!HEX_NAME.test(name)) continue;
    const full = path.join(dir, name);
    let child;
    try {
      child = fs.statSync(full);
    } catch {
      continue;
    }
    if (!child.isDirectory()) continue;
    snapshots.push({ nonce: name, path: full, bytes: allocatedBytes(full), mtime: Math.floor(child.mtimeMs) });
  }
  snapshots.sort((a, b) => (BigInt(`0x${a.nonce}`) < BigInt(`0x${b.nonce}`) ? -1 : 1));
  return snapshots;
}

function isAgentoClone(p) {
  const inside = gitRun(p, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout !== "true") return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(p, ".claude-plugin", "plugin.json"), "utf8"));
    return manifest?.name === "agento";
  } catch {
    return false;
  }
}

// `du -h`'s human form of an allocated byte count: integer for >= 10 of a unit,
// one decimal below 10, K/M/G powers of 1024.
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}`;
  const kib = bytes / 1024;
  if (kib < 1024) return kib < 10 ? `${kib.toFixed(1)}K` : `${Math.ceil(kib)}K`;
  const mib = kib / 1024;
  if (mib < 1024) return mib < 10 ? `${mib.toFixed(1)}M` : `${Math.ceil(mib)}M`;
  const gib = mib / 1024;
  return gib < 10 ? `${gib.toFixed(1)}G` : `${Math.ceil(gib)}G`;
}

// Reference paths from running processes, for in-use snapshot detection. Linux:
// read /proc/<pid>/{cwd,exe,cmdline,environ}; the current process's plugin-root
// env vars are the strongest signal and are added even when /proc hides an
// environ entry. Returns a Set of paths, or null when the platform cannot
// enumerate processes (non-Linux).
export function defaultProcessScan(procDir = "/proc") {
  if (process.platform !== "linux") return null;
  const referenced = new Set();
  const add = (p) => {
    if (typeof p === "string" && p.startsWith("/")) referenced.add(p);
  };
  let pids = [];
  try {
    pids = fs.readdirSync(procDir).filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return null;
  }
  for (const pid of pids) {
    for (const file of ["cwd", "exe"]) {
      try {
        add(fs.readlinkSync(path.join(procDir, pid, file)));
      } catch {
        // the process exited, or the link is unreadable
      }
    }
    try {
      for (const arg of fs.readFileSync(path.join(procDir, pid, "cmdline"), "utf8").split("\0")) add(arg);
    } catch {
      // cmdline unreadable
    }
    try {
      for (const entry of fs.readFileSync(path.join(procDir, pid, "environ"), "utf8").split("\0")) {
        const eq = entry.indexOf("=");
        add(eq >= 0 ? entry.slice(eq + 1) : entry);
      }
    } catch {
      // environ unreadable
    }
  }
  for (const key of ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT", "COPILOT_PLUGIN_ROOT"]) add(process.env[key]);
  return referenced;
}

// The snapshots that running processes reference (their cwd, exe, cmdline args,
// or environ values fall inside a snapshot): the paths, or null when detection is
// unavailable. `scan` is injectable for tests.
export function inUseSnapshots(snapshots, { scan = defaultProcessScan } = {}) {
  const referenced = scan();
  if (referenced === null) return null;
  const inUse = [];
  for (const snapshot of snapshots) {
    const prefix = `${snapshot.path}${path.sep}`;
    for (const p of referenced) {
      if (p === snapshot.path || p.startsWith(prefix)) {
        inUse.push(snapshot.path);
        break;
      }
    }
  }
  return inUse;
}

const contains = (dir, snapshotPath) => dir === snapshotPath || dir.startsWith(`${snapshotPath}${path.sep}`);

// Which snapshots prune keeps and which it deletes: always the newest (largest
// nonce), plus the snapshot the running CLI lives in (so a session running from a
// staged copy is never unlinked underneath itself), plus any snapshot a running
// process still references (an open VS Code window's plugin hooks run from the
// snapshot that window loaded). Pure: the caller performs the deletion. `inUse`
// is an array of paths (or snapshot paths) to keep; the returned `inUse` names
// the snapshots kept only because they are in use.
export function snapshotsToPrune(snapshots, pluginRoot, inUse = []) {
  if (!snapshots.length) return { keep: [], remove: [], inUse: [] };
  const newest = snapshots[snapshots.length - 1].path;
  const keep = new Set([newest]);
  for (const snapshot of snapshots) {
    if (contains(pluginRoot, snapshot.path)) keep.add(snapshot.path);
  }
  for (const dir of inUse) {
    for (const snapshot of snapshots) {
      if (contains(dir, snapshot.path)) keep.add(snapshot.path);
    }
  }
  const keptForUse = snapshots.filter(
    (snapshot) => keep.has(snapshot.path) && snapshot.path !== newest && !contains(pluginRoot, snapshot.path),
  );
  return {
    keep: [...keep],
    remove: snapshots.filter((snapshot) => !keep.has(snapshot.path)),
    inUse: keptForUse.map((snapshot) => snapshot.path),
  };
}

// The pure prune decision: `detection` is what `inUseSnapshots` returned (an
// array of paths, or null when unavailable). Deletion without detection is
// blocked unless `force` is set (the safe default on non-Linux); a dry run is
// always allowed and reports what a forced run would remove.
export function planPrune(snapshots, pluginRoot, detection, { force = false, dryRun = false } = {}) {
  const available = detection !== null;
  if (!available && !dryRun && !force) {
    return {
      available,
      forced: false,
      blocked: true,
      reason: "in-use snapshot detection is unavailable on this platform; reload any open VS Code windows and re-run, or pass --force to prune without detection",
      keep: [],
      remove: [],
      inUse: [],
    };
  }
  const { keep, remove, inUse } = snapshotsToPrune(snapshots, pluginRoot, available ? detection : []);
  return { available, forced: !available && Boolean(force), blocked: false, reason: null, keep, remove, inUse };
}

// The plugin's executable hook scripts, relative to the plugin root. VS Code
// stages a full copy but drops the +x bit on shell scripts, so doctor warns when
// these are missing their executable bit in the newest snapshot.
export const HOOK_SCRIPTS = [
  "scripts/hooks/delivery-guard.sh",
  "scripts/hooks/replay-guard.sh",
  "scripts/hooks/session-context.sh",
];

// The hook scripts under `snapshotPath` that exist but are not executable by
// anyone (mode has no 0o111 bit). Missing scripts are not flagged here — the
// `harness` doctor check owns hook-wiring completeness.
export function nonExecutableHookScripts(snapshotPath) {
  const notExecutable = [];
  for (const rel of HOOK_SCRIPTS) {
    try {
      if (!(fs.statSync(path.join(snapshotPath, rel)).mode & 0o111)) notExecutable.push(rel);
    } catch {
      // missing — out of scope for the executable-bit check
    }
  }
  return notExecutable;
}

// Classify an expanded plugin-location path: `missing` (directory gone), `export`
// (has `.agento-export.json`), `clone` (git checkout whose `.claude-plugin/plugin.json`
// is Agento's), or `other`.
export function classifyLocation(expanded) {
  if (!fs.existsSync(expanded)) return "missing";
  if (fs.existsSync(path.join(expanded, ".agento-export.json"))) return "export";
  if (isAgentoClone(expanded)) return "clone";
  return "other";
}

// The enabled `chat.pluginLocations` entries from VS Code's user settings, each
// classified as `missing` (directory gone), `export` (has `.agento-export.json`),
// `clone` (git checkout whose `.claude-plugin/plugin.json` is Agento's), or
// `other`. Returns [{ dir, path, kind }]; `dir` is the raw settings entry and
// `path` its expanded absolute form.
export function pluginLocations(env = process.env) {
  let settings;
  try {
    settings = parseJsonc(fs.readFileSync(vscodeSettingsPath(env), "utf8"));
  } catch {
    return [];
  }
  const locations = settings?.["chat.pluginLocations"];
  if (!locations || typeof locations !== "object" || Array.isArray(locations)) return [];
  return Object.entries(locations)
    .filter(([, enabled]) => enabled === true)
    .map(([dir]) => {
      const expanded = expandHome(dir);
      return { dir, path: expanded, kind: classifyLocation(expanded) };
    });
}
