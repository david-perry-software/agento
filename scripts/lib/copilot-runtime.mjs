// Copilot runtime data: MCP server configuration, MCP timeout log lines, and the
// bounded session readers. The pure halves (`parseMcpConfig`, `countMcpTimeouts`)
// parse supplied text only and never touch the filesystem; the readers (below the
// pure section) do the bounded `~/.copilot` reads behind `readSessions`,
// `readMcpConfigs`, and `readMcpTimeouts`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCopilotEvents } from "../delivery-metrics.mjs";

const MCP_TIMEOUT_MARK = "MCP request timed out";
const TAIL_BYTES = 16 * 1024 * 1024; // 16 MB tail reads for events.jsonl and logs
const MAX_SESSIONS = 50;

// `parseMcpConfig(json, source)` → `[{ name, source, wildcard, remote }]`. Reads
// only the server name, type, tools, url presence, and an `mcp-remote` arg; `env`,
// `headers`, and any other value-bearing field never reaches the output. Accepts
// both `~/.copilot/mcp-config.json` (`mcpServers`) and `<root>/.vscode/mcp.json`
// (`servers`).
export function parseMcpConfig(json, source) {
  const servers = json?.mcpServers ?? json?.servers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers).map(([name, server]) => {
    const tools = Array.isArray(server?.tools) ? server.tools : [];
    const args = Array.isArray(server?.args) ? server.args : [];
    const type = server?.type;
    return {
      name,
      source,
      wildcard: tools.includes("*"),
      remote:
        Boolean(server?.url) ||
        type === "http" ||
        type === "sse" ||
        args.some((arg) => typeof arg === "string" && (arg === "mcp-remote" || arg === "--mcp-remote" || arg.includes("mcp-remote"))),
    };
  });
}

// `countMcpTimeouts(text, { since })` → Map<server, { count, lastAt }> over both
// observed timeout line shapes, restricted to lines timestamped at/after `since`
// (a Date, an ISO string, or epoch ms; omitted → all lines). Lines start with an
// ISO timestamp.
export function countMcpTimeouts(text, { since = null } = {}) {
  const sinceMs = since == null ? null : since instanceof Date ? since.getTime() : typeof since === "string" ? Date.parse(since) : since;
  const counted = new Map();
  const bump = (server, at) => {
    if (!server) return;
    const entry = counted.get(server) ?? { count: 0, lastAt: null };
    entry.count += 1;
    if (entry.lastAt === null || Date.parse(at) > Date.parse(entry.lastAt)) entry.lastAt = at;
    counted.set(server, entry);
  };
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes(MCP_TIMEOUT_MARK)) continue;
    const at = line.match(/^(\S+)\s/)?.[1] ?? null;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    if (sinceMs != null && !Number.isNaN(sinceMs) && Date.parse(at) < sinceMs) continue;
    // Shape 1: "Failed to refresh persisted MCP tools for <server>; continuing …"
    const refresh = line.match(/Failed to refresh persisted MCP tools for (\S+);/)?.[1];
    if (refresh) {
      bump(refresh, at);
      continue;
    }
    // Shape 2: "Failed to list MCP tools; … {"server":"<server>","error":"…"}"
    const listed = line.match(/Failed to list MCP tools;.*\{"server":"([^"]+)"/)?.[1];
    if (listed) bump(listed, at);
  }
  return counted;
}

// --- Bounded readers -------------------------------------------------------

// The Copilot home directory: `$AGENTO_COPILOT_HOME` (test override), then
// `$COPILOT_HOME` when non-empty, else `~/.copilot`.
export function copilotHome(env = process.env) {
  const override = env.AGENTO_COPILOT_HOME;
  if (typeof override === "string" && override.length > 0) return override;
  const home = env.COPILOT_HOME;
  if (typeof home === "string" && home.length > 0) return home;
  return path.join(os.homedir(), ".copilot");
}

// Last `maxBytes` of a file as text ("" when the file is missing).
function tailText(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// `workspace.yaml`'s flat `key: value` lines → an object. Values may themselves
// contain colons (ISO timestamps), so only the first colon splits.
function parseWorkspaceYaml(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (key) out[key] = line.slice(i + 1).trim();
  }
  return out;
}

const inside = (dir, rootPath) => dir === rootPath || (typeof dir === "string" && dir.startsWith(`${rootPath}${path.sep}`));

// Bounded Copilot session reader. `roots` is the combined list of this clone's
// product worktrees and companion halves (session membership: `workspace.yaml`
// `cwd` or `git_root` inside one of them); `root` is this CLI's checkout root
// ("current" is the newest session whose `cwd` equals it). Reads at most
// MAX_SESSIONS sessions whose `events.jsonl` mtime is within `hours`, tail-reading
// 16 MB per file. Missing data yields empty results, never a throw.
export function readSessions({ roots = [], root = null, hours = 24, home = copilotHome(), now = Date.now() } = {}) {
  const stateDir = path.join(home, "session-state");
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return { current: null, sessions: [] };
  }
  const cutoff = nowMs - hours * 3600 * 1000;
  const candidates = [];
  for (const id of entries) {
    const dir = path.join(stateDir, id);
    const eventsFile = path.join(dir, "events.jsonl");
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(eventsFile).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) continue;
    candidates.push({ id, dir, eventsFile, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions = [];
  let current = null;
  for (const candidate of candidates.slice(0, MAX_SESSIONS)) {
    let workspace;
    try {
      workspace = parseWorkspaceYaml(fs.readFileSync(path.join(candidate.dir, "workspace.yaml"), "utf8"));
    } catch {
      continue; // no workspace.yaml → membership unknowable → excluded
    }
    const member = roots.some((rootPath) => inside(workspace.cwd, rootPath) || inside(workspace.git_root, rootPath));
    if (!member) continue;
    const parsed = parseCopilotEvents(tailText(candidate.eventsFile, TAIL_BYTES));
    const session = {
      id: candidate.id,
      sessionId: parsed.sessionId ?? candidate.id,
      at: new Date(candidate.mtimeMs).toISOString(),
      cwd: workspace.cwd ?? null,
      gitRoot: workspace.git_root ?? null,
      repository: workspace.repository ?? null,
      turnGaps: parsed.turnGaps,
      subagentStartups: parsed.subagentStartups,
    };
    sessions.push(session);
    if (!current && root != null && workspace.cwd === root) current = session;
  }
  return { current, sessions };
}

// Reads both MCP config sources: `~/.copilot/mcp-config.json` (`mcpServers`) and
// `<root>/.vscode/mcp.json` (`servers`). Missing or unparseable files contribute
// nothing; the parser never carries `env`/`headers` values forward.
export function readMcpConfigs({ root = null, home = copilotHome() } = {}) {
  const sources = [];
  const userFile = path.join(home, "mcp-config.json");
  try {
    sources.push(...parseMcpConfig(JSON.parse(fs.readFileSync(userFile, "utf8")), "user mcp-config.json"));
  } catch {
    // missing or unparseable → nothing
  }
  if (root != null) {
    const workspaceFile = path.join(root, ".vscode", "mcp.json");
    try {
      sources.push(...parseMcpConfig(JSON.parse(fs.readFileSync(workspaceFile, "utf8")), "workspace .vscode/mcp.json"));
    } catch {
      // missing or unparseable → nothing
    }
  }
  return sources;
}

// Merges `countMcpTimeouts` across `logs/process-*.log` modified within `hours`
// (16 MB tail per file) into a single Map<server, { count, lastAt }>.
export function readMcpTimeouts({ hours = 24, home = copilotHome(), now = Date.now() } = {}) {
  const logsDir = path.join(home, "logs");
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  const cutoff = nowMs - hours * 3600 * 1000;
  const merged = new Map();
  let files = [];
  try {
    files = fs.readdirSync(logsDir).filter((name) => name.startsWith("process-") && name.endsWith(".log"));
  } catch {
    return merged;
  }
  for (const name of files) {
    const file = path.join(logsDir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoff) continue;
    for (const [server, entry] of countMcpTimeouts(tailText(file, TAIL_BYTES), { since: cutoff })) {
      const previous = merged.get(server) ?? { count: 0, lastAt: null };
      previous.count += entry.count;
      if (previous.lastAt === null || Date.parse(entry.lastAt) > Date.parse(previous.lastAt)) previous.lastAt = entry.lastAt;
      merged.set(server, previous);
    }
  }
  return merged;
}
