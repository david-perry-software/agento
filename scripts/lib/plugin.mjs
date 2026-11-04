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

function classifyLocation(expanded) {
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
