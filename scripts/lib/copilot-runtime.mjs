// Copilot runtime data: MCP server configuration, MCP timeout log lines, and the
// bounded session readers. The pure halves (`parseMcpConfig`, `countMcpTimeouts`)
// parse supplied text only and never touch the filesystem; the readers (below the
// pure section) do the bounded `~/.copilot` reads behind `readSessions`,
// `readMcpConfigs`, and `readMcpTimeouts`.

const MCP_TIMEOUT_MARK = "MCP request timed out";

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
