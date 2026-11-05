// Who is still inside a worktree about to be removed: processes whose cwd is in it
// (Linux /proc scan) and VS Code windows that have it open (`code --status`). A
// faithful port of the delivery guard's occupant check (scripts/hooks/delivery-guard.sh),
// so `agento.mjs close-session` — whose `git worktree remove` the guard cannot see —
// applies the same rule and prints the same wording.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CODE_STATUS_TIMEOUT_MS = 5000;

// `code --status` stdout; "" when code is missing or times out (no window match).
export function defaultCodeStatus() {
  try {
    return execFileSync("code", ["--status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: CODE_STATUS_TIMEOUT_MS });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ETIMEDOUT" || (error?.signal && error?.status === null)) return "";
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
}

// Only these keys are ever read from a host's /proc/<pid>/environ; every other
// key and value is discarded so a planted secret can never leak into a result.
const HOST_ENV_KEYS = ["SESSION_ID", "EXTENSION_PATH", "COPILOT_EXTENSION_PARENT_PID"];

function readCmdline(procDir, pid) {
  try {
    return fs.readFileSync(path.join(procDir, pid, "cmdline"), "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

// A Copilot SDK extension host is detected by its command line, not `comm`: the
// same runtime host may run as `code` or `node`.
const isExtensionHost = (cmdline) => cmdline.some((arg) => path.basename(arg) === "extension_bootstrap.mjs");

function readHostEnviron(procDir, pid) {
  const environ = {};
  try {
    const raw = fs.readFileSync(path.join(procDir, pid, "environ"), "utf8");
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const key = entry.slice(0, eq);
      if (HOST_ENV_KEYS.includes(key)) environ[key] = entry.slice(eq + 1);
    }
  } catch {
    // the process exited or its environ is not ours to read
  }
  return environ;
}

function scanProcesses(procDir, target) {
  const prefix = target + path.sep;
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cwd = fs.readlinkSync(path.join(procDir, name, "cwd"));
      if (cwd !== target && !cwd.startsWith(prefix)) continue;
      const comm = fs.readFileSync(path.join(procDir, name, "comm"), "utf8").trim().replace(/[^A-Za-z0-9_.+-]/g, "?");
      const host = isExtensionHost(readCmdline(procDir, name));
      found.push({ pid: Number(name), comm, host, environ: host ? readHostEnviron(procDir, name) : null });
    } catch {
      // the process exited or is not ours to read
    }
  }
  return found;
}

// True only for Agento's own Mission Control extension host (last two path
// segments `agento-mission-control/extension.mjs`).
export function isMissionControlHost(host) {
  return path.basename(path.dirname(host.extensionPath)) === "agento-mission-control" && path.basename(host.extensionPath) === "extension.mjs";
}

const allMatches = (text, regex) => [...text.matchAll(regex)].map((m) => m[1]);

export function findOccupants(target, { procDir, platform = process.platform, codeStatus = defaultCodeStatus } = {}) {
  const resolved = path.resolve(target);
  const scanned = procDir || platform === "linux" ? scanProcesses(procDir ?? "/proc", resolved) : [];
  let status = "";
  try {
    status = codeStatus() ?? "";
  } catch {
    status = "";
  }
  const name = path.basename(resolved);
  const folderWindow = allMatches(status, /^\|\s+Folder \(([^)]+)\):/gm).includes(name);
  // A pair's <name>.code-workspace window shows as `Window (… <name> (Workspace) …)`
  // (observed) or `Workspace (<name>)` (expected form); both halves share <name>.
  const workspaceWindow = [...allMatches(status, /^\|\s+Workspace \(([^)]+)\)/gm), ...allMatches(status, /^\|\s+Window \(.*?(\S+) \(Workspace\)/gm)].includes(name);
  const sdkHosts = [];
  const hostLabels = [];
  const otherLabels = [];
  for (const proc of scanned) {
    if (proc.host) {
      const extensionPath = proc.environ.EXTENSION_PATH ?? "";
      const host = {
        pid: proc.pid,
        sessionId: proc.environ.SESSION_ID ?? "",
        extensionPath,
        extension: extensionPath ? path.basename(path.dirname(extensionPath)) : "unknown",
        parentPid: proc.environ.COPILOT_EXTENSION_PARENT_PID !== undefined ? Number(proc.environ.COPILOT_EXTENSION_PARENT_PID) : null,
      };
      sdkHosts.push(host);
      hostLabels.push(`PID ${proc.pid} (Copilot SDK extension host: ${host.extension}, session ${host.sessionId.slice(0, 8)})`);
    } else {
      otherLabels.push(`PID ${proc.pid} (${proc.comm})`);
    }
  }
  const processes = [...hostLabels, ...otherLabels];
  const details = [...hostLabels, ...otherLabels.slice(0, 3)];
  if (otherLabels.length > 3) details.push(`and ${otherLabels.length - 3} more processes`);
  if (folderWindow) details.push("a matching VS Code folder");
  if (workspaceWindow) details.push("a matching VS Code workspace window");
  const result = { processes, folderWindow, workspaceWindow, details };
  if (sdkHosts.length) result.sdkHosts = sdkHosts;
  return result;
}
