import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copilotHome, countMcpTimeouts, parseMcpConfig, readMcpConfigs, readMcpTimeouts, readSessions } from "./copilot-runtime.mjs";

// Sanitized fixtures: paths reduced to fixture dirs, fake token values. The real
// config is only ever inspected for its shape, never its values.
const configWithSecrets = JSON.stringify({
  mcpServers: {
    railway: {
      type: "local",
      command: "railway",
      args: ["mcp"],
      tools: ["*"],
      env: { RAILWAY_TOKEN: "secret-token-value" },
      headers: { Authorization: "Bearer secret-header-value" },
    },
    github: {
      type: "http",
      url: "https://api.github.com/mcp",
      tools: ["list_issues", "create_issue"],
      env: { GH_TOKEN: "gh-secret-token" },
    },
    narrow: { type: "local", command: "node", args: ["server.js"], tools: ["read", "write"] },
    remoteProxy: { type: "local", command: "npx", args: ["-y", "mcp-remote", "https://example.com/mcp"] },
  },
});

test("parseMcpConfig: wildcard, remote (url/http/mcp-remote) and narrow servers; env/headers never reach output", () => {
  const parsed = parseMcpConfig(JSON.parse(configWithSecrets), "user mcp-config.json");
  assert.deepEqual(parsed, [
    { name: "railway", source: "user mcp-config.json", wildcard: true, remote: false },
    { name: "github", source: "user mcp-config.json", wildcard: false, remote: true },
    { name: "narrow", source: "user mcp-config.json", wildcard: false, remote: false },
    { name: "remoteProxy", source: "user mcp-config.json", wildcard: false, remote: true },
  ]);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes("secret-token-value"), false);
  assert.equal(serialized.includes("secret-header-value"), false);
  assert.equal(serialized.includes("gh-secret-token"), false);
  assert.equal(serialized.includes("env"), false);
  assert.equal(serialized.includes("headers"), false);
});

test("parseMcpConfig: the workspace `servers` key and missing config return empty", () => {
  assert.deepEqual(parseMcpConfig({ servers: { w: { command: "x", args: [] } } }, "workspace .vscode/mcp.json"), [
    { name: "w", source: "workspace .vscode/mcp.json", wildcard: false, remote: false },
  ]);
  assert.deepEqual(parseMcpConfig(null, "user mcp-config.json"), []);
  assert.deepEqual(parseMcpConfig({}, "user mcp-config.json"), []);
  assert.deepEqual(parseMcpConfig({ mcpServers: [] }, "user mcp-config.json"), []);
});

// The exact two observed timeout line shapes from plan.md Research, sanitized.
const timeoutLines = [
  "2026-10-13T06:41:15.357Z [WARNING] [rust:copilot_runtime::session::mcp::tool_catalog] Failed to refresh persisted MCP tools for railway; continuing with cached tools: MCP request timed out after 60000 ms",
  "2026-10-13T06:42:15.433Z [WARNING] [rust:copilot_runtime::session::mcp::tool_catalog] Failed to list MCP tools; retaining any previous tools and retrying on a later projection {\"server\":\"railway\",\"error\":\"MCP request timed out after 59999 ms\",\"retry_delay_ms\":60000}",
  "2026-10-13T06:43:15.579Z [WARNING] [rust:copilot_runtime::session::mcp::tool_catalog] Failed to list MCP tools; retaining any previous tools and retrying on a later projection {\"server\":\"github\",\"error\":\"MCP request timed out after 59999 ms\",\"retry_delay_ms\":60000}",
  "2026-10-13T06:44:00.000Z [INFO] some unrelated line with no timeout",
].join("\n");

test("countMcpTimeouts: both line shapes counted per server with the latest timestamp", () => {
  const counted = countMcpTimeouts(timeoutLines);
  assert.deepEqual([...counted.entries()], [
    ["railway", { count: 2, lastAt: "2026-10-13T06:42:15.433Z" }],
    ["github", { count: 1, lastAt: "2026-10-13T06:43:15.579Z" }],
  ]);
});

test("countMcpTimeouts: `since` filters by timestamp, accepted as Date, ISO string, or epoch ms", () => {
  const sinceIso = "2026-10-13T06:43:00.000Z";
  assert.deepEqual([...countMcpTimeouts(timeoutLines, { since: sinceIso }).entries()], [
    ["github", { count: 1, lastAt: "2026-10-13T06:43:15.579Z" }],
  ]);
  const sinceDate = new Date(sinceIso);
  assert.deepEqual(countMcpTimeouts(timeoutLines, { since: sinceDate }).get("github").count, 1);
  const sinceMs = Date.parse(sinceIso);
  assert.deepEqual(countMcpTimeouts(timeoutLines, { since: sinceMs }).get("github").count, 1);
  assert.equal(countMcpTimeouts(timeoutLines, { since: "2026-10-14T00:00:00Z" }).size, 0);
});

test("countMcpTimeouts: empty or malformed input yields an empty map", () => {
  assert.equal(countMcpTimeouts("").size, 0);
  assert.equal(countMcpTimeouts(null).size, 0);
  assert.equal(countMcpTimeouts("garbage\nwithout the marker\n").size, 0);
});

// --- Readers over a fixture COPILOT_HOME tree ------------------------------

test("copilotHome: honours $COPILOT_HOME and falls back to ~/.copilot", () => {
  assert.equal(copilotHome({ COPILOT_HOME: "/fixture/home" }), "/fixture/home");
  assert.equal(copilotHome({ COPILOT_HOME: "" }), path.join(os.homedir(), ".copilot"));
  assert.equal(copilotHome({}), path.join(os.homedir(), ".copilot"));
});

const NOW = Date.parse("2026-11-03T12:00:00Z");
const eventLine = (type, data, timestamp) => JSON.stringify({ type, data, id: "id", timestamp, parentId: "parent" });
const sessionEventLines = (id) => [
  eventLine("session.start", { sessionId: id }, "2026-11-03T10:00:00.000Z"),
  eventLine("tool.execution_complete", { toolCallId: "t", turnId: "0" }, "2026-11-03T10:01:00.000Z"),
  eventLine("assistant.turn_end", { turnId: "0" }, "2026-11-03T10:02:00.000Z"),
];

function writeSession(home, id, { cwd, gitRoot, mtimeMs, lines = sessionEventLines(id) }) {
  const dir = path.join(home, "session-state", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    `id: ${id}\ncwd: ${cwd}\ngit_root: ${gitRoot}\nrepository: david-perry-software/agento\nbranch: feature/x\ncreated_at: 2026-11-03T10:00:00.000Z\nupdated_at: 2026-11-03T10:00:00.000Z\n`,
  );
  const file = path.join(dir, "events.jsonl");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const t = new Date(mtimeMs);
  fs.utimesSync(file, t, t);
  return file;
}

function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-runtime-"));
  return home;
}

test("readSessions: missing home, foreign-repo sessions, and 24 h mtime are excluded; current is the newest cwd === root", () => {
  const missing = readSessions({ roots: ["/repo"], root: "/repo", home: path.join(os.tmpdir(), "no-such-home"), now: NOW });
  assert.deepEqual(missing, { current: null, sessions: [] });

  const home = fixtureHome();
  const root = "/repo/plan-a";
  writeSession(home, "s1", { cwd: root, gitRoot: "/repo", mtimeMs: NOW - 1000 });
  writeSession(home, "s2", { cwd: root, gitRoot: "/repo", mtimeMs: NOW - 500 });
  writeSession(home, "sub", { cwd: `${root}/nested`, gitRoot: "/repo", mtimeMs: NOW - 2000 });
  writeSession(home, "foreign", { cwd: "/elsewhere/project", gitRoot: "/elsewhere/project", mtimeMs: NOW - 100 });
  writeSession(home, "stale", { cwd: root, gitRoot: "/repo", mtimeMs: NOW - 25 * 3600 * 1000 });

  const { current, sessions } = readSessions({ roots: [root], root, home, now: NOW });
  assert.equal(current.id, "s2");
  assert.deepEqual(sessions.map((s) => s.id), ["s2", "s1", "sub"]);
  assert.equal(sessions.some((s) => s.id === "foreign"), false);
  assert.equal(sessions.some((s) => s.id === "stale"), false);
  assert.equal(current.turnGaps.length, 1);
  assert.equal(current.sessionId, "s2");
});

test("readSessions: oversize events.jsonl is tail-read and a truncated first line tolerated", () => {
  const home = fixtureHome();
  const root = "/repo/plan-a";
  const dir = path.join(home, "session-state", "big");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: big\ncwd: ${root}\ngit_root: /repo\n`);
  const file = path.join(dir, "events.jsonl");
  // > 16 MB of filler, then the real events at the end; the tail starts mid-filler
  // and the truncated first line is tolerated while the event lines parse.
  const filler = Buffer.alloc(16 * 1024 * 1024 + 100, 0x67); // 'g'
  fs.writeFileSync(file, filler);
  fs.appendFileSync(file, `\n${sessionEventLines("big-session").join("\n")}\n`);
  const t = new Date(NOW - 100);
  fs.utimesSync(file, t, t);

  const { current } = readSessions({ roots: [root], root, home, now: NOW });
  assert.equal(current.id, "big");
  assert.equal(current.sessionId, "big-session");
  assert.equal(current.turnGaps.length, 1);
});

test("readMcpConfigs: reads user and workspace sources, never env/headers values", () => {
  const home = fixtureHome();
  fs.writeFileSync(path.join(home, "mcp-config.json"), JSON.stringify({ mcpServers: { railway: { type: "local", command: "railway", args: [], tools: ["*"], env: { TOKEN: "secret" } } } }));
  const root = fixtureHome();
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".vscode", "mcp.json"), JSON.stringify({ servers: { gh: { type: "http", url: "https://x/mcp", tools: ["a"] } } }));

  const parsed = readMcpConfigs({ root, home });
  assert.deepEqual(parsed, [
    { name: "railway", source: "user mcp-config.json", wildcard: true, remote: false },
    { name: "gh", source: "workspace .vscode/mcp.json", wildcard: false, remote: true },
  ]);
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  // Missing sources contribute nothing.
  assert.deepEqual(readMcpConfigs({ root: fixtureHome(), home: fixtureHome() }), []);
});

test("readMcpTimeouts: merges counts across log files modified within 24 h", () => {
  const home = fixtureHome();
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const line1 = "2026-11-03T11:00:00.000Z [WARNING] Failed to refresh persisted MCP tools for railway; continuing with cached tools: MCP request timed out after 60000 ms";
  const line2 = "2026-11-03T11:30:00.000Z [WARNING] Failed to list MCP tools; retaining any previous tools and retrying on a later projection {\"server\":\"github\",\"error\":\"MCP request timed out after 59999 ms\"}";
  const fresh = path.join(logs, "process-1.log");
  fs.writeFileSync(fresh, `${line1}\n${line2}\n`);
  const t = new Date(NOW - 1000);
  fs.utimesSync(fresh, t, t);
  const stale = path.join(logs, "process-2.log");
  fs.writeFileSync(stale, line1);
  const old = new Date(NOW - 25 * 3600 * 1000);
  fs.utimesSync(stale, old, old);

  const counted = readMcpTimeouts({ home, now: NOW });
  assert.deepEqual([...counted.entries()], [
    ["railway", { count: 1, lastAt: "2026-11-03T11:00:00.000Z" }],
    ["github", { count: 1, lastAt: "2026-11-03T11:30:00.000Z" }],
  ]);
  assert.equal(readMcpTimeouts({ home: path.join(home, "missing"), now: NOW }).size, 0);
});
