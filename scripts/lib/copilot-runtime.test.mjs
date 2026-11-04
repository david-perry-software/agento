import assert from "node:assert/strict";
import test from "node:test";

import { countMcpTimeouts, parseMcpConfig } from "./copilot-runtime.mjs";

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
