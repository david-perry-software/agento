import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = path.join(here, "log-payload.mjs");

function runLogger({ source, event, stdin = "", env = {}, args = [] }) {
  const logDir = mkdtempSync(path.join(tmpdir(), "agento-probe-log-"));
  const res = spawnSync(
    process.execPath,
    [logger, source, event, ...args],
    { input: stdin, encoding: "utf8", env: { ...process.env, AGENTO_PROBE_LOG_DIR: logDir, ...env } },
  );
  return { res, logDir };
}

function logFiles(logDir) {
  return existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith(".json")) : [];
}

test("logger writes one file per call recording source, event, argv, cwd, and stdin", () => {
  const payload = JSON.stringify({ session_id: "s-123", cwd: "/tmp" });
  const { res, logDir } = runLogger({ source: "workspace", event: "SessionStart", stdin: payload });
  assert.equal(res.status, 0);
  const files = logFiles(logDir);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(path.join(logDir, files[0]), "utf8"));
  assert.equal(record.source, "workspace");
  assert.equal(record.event, "SessionStart");
  assert.deepEqual(record.argv, ["workspace", "SessionStart"]);
  assert.equal(typeof record.cwd, "string");
  assert.equal(record.stdin, payload);
  assert.equal(record.parsedStdin.session_id, "s-123");
  rmSync(logDir, { recursive: true, force: true });
});

test("logger records env-var names, never values", () => {
  const { res, logDir } = runLogger({
    source: "plugin",
    event: "PreToolUse",
    env: { CLAUDE_PLUGIN_ROOT: "/top/secret/root", COPILOT_TOKEN: "tok-secret-999" },
  });
  assert.equal(res.status, 0);
  const files = logFiles(logDir);
  assert.equal(files.length, 1);
  const raw = readFileSync(path.join(logDir, files[0]), "utf8");
  const record = JSON.parse(raw);
  assert.ok(record.envVarNames.includes("CLAUDE_PLUGIN_ROOT"));
  assert.ok(record.envVarNames.includes("COPILOT_TOKEN"));
  assert.ok(!raw.includes("/top/secret/root"), "env value leaked into the log");
  assert.ok(!raw.includes("tok-secret-999"), "env value leaked into the log");
  rmSync(logDir, { recursive: true, force: true });
});

test("SessionStart emits nested and top-level context tokens", () => {
  const { res } = runLogger({ source: "workspace", event: "SessionStart", stdin: "{}" });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.additionalContext, "PROBE_CTX_NESTED");
  assert.equal(out.additionalContext, "PROBE_CTX_TOPLEVEL");
});

test("AGENTO_PROBE_DENY_NESTED denies inside hookSpecificOutput only", () => {
  const { res } = runLogger({
    source: "workspace",
    event: "PreToolUse",
    stdin: JSON.stringify({ tool_input: { content: "AGENTO_PROBE_DENY_NESTED" } }),
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.permissionDecision, undefined);
});

test("AGENTO_PROBE_DENY_TOPLEVEL denies at the top level only", () => {
  const { res } = runLogger({
    source: "plugin",
    event: "PreToolUse",
    stdin: JSON.stringify({ tool_input: { content: "AGENTO_PROBE_DENY_TOPLEVEL" } }),
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput, undefined);
});

test("AGENTO_PROBE_ASK_TOPLEVEL asks at the top level", () => {
  const { res } = runLogger({
    source: "workspace",
    event: "PreToolUse",
    stdin: JSON.stringify({ tool_input: { content: "AGENTO_PROBE_ASK_TOPLEVEL" } }),
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.permissionDecision, "ask");
});

test("AGENTO_PROBE_EXIT2 exits 2 (fail-closed check)", () => {
  const { res } = runLogger({
    source: "workspace",
    event: "PreToolUse",
    stdin: JSON.stringify({ tool_input: { content: "AGENTO_PROBE_EXIT2" } }),
  });
  assert.equal(res.status, 2);
});

test("malformed stdin exits 0 with no output", () => {
  const { res } = runLogger({ source: "workspace", event: "PreToolUse", stdin: "not json at all {" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("unmarked PreToolUse exits 0 with no output but still logs", () => {
  const { res, logDir } = runLogger({
    source: "workspace",
    event: "PreToolUse",
    stdin: JSON.stringify({ tool_input: { content: "ordinary" } }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(logFiles(logDir).length, 1);
  rmSync(logDir, { recursive: true, force: true });
});
