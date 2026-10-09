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
      found.push(`PID ${name} (${comm})`);
    } catch {
      // the process exited or is not ours to read
    }
  }
  return found;
}

const allMatches = (text, regex) => [...text.matchAll(regex)].map((m) => m[1]);

export function findOccupants(target, { procDir, platform = process.platform, codeStatus = defaultCodeStatus } = {}) {
  const resolved = path.resolve(target);
  const processes = procDir || platform === "linux" ? scanProcesses(procDir ?? "/proc", resolved) : [];
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
  const details = processes.slice(0, 3);
  if (processes.length > 3) details.push(`and ${processes.length - 3} more processes`);
  if (folderWindow) details.push("a matching VS Code folder");
  if (workspaceWindow) details.push("a matching VS Code workspace window");
  return { processes, folderWindow, workspaceWindow, details };
}
