// Which VS Code window holds a checkout, so a cross-window handoff can focus the
// window that is already open instead of opening a duplicate.
//
// Two sources, combined: VS Code's `storage.json` (`windowsState`) names the exact
// workspace file or folder each window was opened from, and `code --status` lists
// the windows actually running (storage.json keeps entries after a crash). A
// workspace window holds every folder its `.code-workspace` file lists, so the
// primary checkout opened through `agento.code-workspace` resolves to that file.
// `code <target>` then focuses the open window, or opens a new one. The caller
// supplies `code --status` text (worktree-occupants.mjs `defaultCodeStatus`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// VS Code's user data directory; AGENTO_VSCODE_USER_DIR overrides the platform default.
export function vscodeUserDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.AGENTO_VSCODE_USER_DIR) return env.AGENTO_VSCODE_USER_DIR;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Code", "User");
}

function filePathOf(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

// Windows recorded in storage.json: [{ kind: "workspace" | "folder", path }], local
// files only, de-duplicated. A missing or unreadable file yields [].
export function storedWindows(storageText) {
  let data;
  try {
    data = JSON.parse(storageText);
  } catch {
    return [];
  }
  const state = data?.windowsState ?? {};
  const entries = [state.lastActiveWindow, ...(Array.isArray(state.openedWindows) ? state.openedWindows : [])];
  const seen = new Set();
  const windows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const workspace = filePathOf(entry.workspaceIdentifier?.configURIPath);
    const folder = filePathOf(entry.folder);
    const window = workspace ? { kind: "workspace", path: workspace } : folder ? { kind: "folder", path: folder } : null;
    if (!window || seen.has(`${window.kind}:${window.path}`)) continue;
    seen.add(`${window.kind}:${window.path}`);
    windows.push(window);
  }
  return windows;
}

// The names `code --status` reports for running windows: workspace names (from
// `Window (… <name> (Workspace) …)` titles or `Workspace (<name>)`) and folder
// names (`Folder (<name>): …`).
export function runningNames(statusText) {
  const text = String(statusText ?? "");
  const all = (regex) => [...text.matchAll(regex)].map((m) => m[1]);
  return {
    workspaces: new Set([...all(/^\|\s+Workspace \(([^)]+)\)/gm), ...all(/^\|\s+Window \(.*?(\S+) \(Workspace\)/gm)]),
    folders: new Set(all(/^\|\s+Folder \(([^)]+)\):/gm)),
  };
}

// Strip // and /* */ comments (outside strings) and trailing commas: the JSONC
// VS Code accepts in .code-workspace files.
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Absolute folder paths a .code-workspace file lists (relative entries resolve
// against the file's directory); [] when unreadable.
export function workspaceFolders(file, readFile = (p) => fs.readFileSync(p, "utf8")) {
  try {
    const doc = parseJsonc(readFile(file));
    return (Array.isArray(doc?.folders) ? doc.folders : [])
      .map((f) => (typeof f?.path === "string" ? path.resolve(path.dirname(file), f.path) : filePathOf(f?.uri)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isRunning(window, names) {
  if (window.kind === "workspace") return names.workspaces.has(path.basename(window.path).replace(/\.code-workspace$/, ""));
  return names.folders.has(path.basename(window.path));
}

// Running windows with the folders each holds: [{ kind, path, folders }].
export function openWindows({ storageText, statusText, readFile }) {
  const names = runningNames(statusText);
  return storedWindows(storageText)
    .filter((window) => isRunning(window, names))
    .map((window) => ({ ...window, folders: window.kind === "workspace" ? workspaceFolders(window.path, readFile) : [window.path] }));
}

// The window to open or focus for `checkout`: a running window holding it (exact
// workspace-file match first, then a window whose first folder — its main root —
// is the checkout, then any window listing it) or, when none is open, `fallback`
// (the checkout's session workspace file, or the checkout).
export function windowFor(checkout, windows, fallback = checkout) {
  const resolved = path.resolve(checkout);
  const lists = (w) => w.folders.some((folder) => path.resolve(folder) === resolved);
  const exact = windows.find((w) => w.kind === "workspace" && fallback && path.resolve(fallback) === w.path);
  const rooted = windows.find((w) => w.folders.length && path.resolve(w.folders[0]) === resolved);
  const holding = exact ?? rooted ?? windows.find(lists);
  if (holding) return { open: true, target: holding.path, kind: holding.kind };
  const kind = fallback && fallback.endsWith(".code-workspace") ? "workspace" : "folder";
  return { open: false, target: fallback ?? resolved, kind };
}

export function readStorage(env = process.env) {
  try {
    return fs.readFileSync(path.join(vscodeUserDir(env), "globalStorage", "storage.json"), "utf8");
  } catch {
    return "";
  }
}
