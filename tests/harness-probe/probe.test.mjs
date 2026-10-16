import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDeny } from "./probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const logger = path.join(here, "plugin", "log-payload.mjs");
const probeCli = path.join(here, "probe.mjs");

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

test("logger records env-var names, never token values", () => {
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
  // A token value must never leak into the log.
  assert.ok(!raw.includes("tok-secret-999"), "token value leaked into the log");
  // The PLUGIN_ROOT value is a path, not a token; the diagnostic records it alone.
  assert.equal(record.diagnostic.pluginRootEnv.CLAUDE_PLUGIN_ROOT, "/top/secret/root");
  assert.ok(!("COPILOT_TOKEN" in record.diagnostic.pluginRootEnv), "non-PLUGIN_ROOT var leaked into the diagnostic");
  rmSync(logDir, { recursive: true, force: true });
});

test("logger records a token-free diagnostic entry (cwd, node, PLUGIN_ROOT values)", () => {
  const { res, logDir } = runLogger({
    source: "plugin",
    event: "SessionStart",
    stdin: "{}",
    env: { CLAUDE_PLUGIN_ROOT: "/tmp/probe-root", PLUGIN_ROOT: "/tmp/probe-root2" },
  });
  assert.equal(res.status, 0);
  const files = logFiles(logDir);
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(path.join(logDir, files[0]), "utf8"));
  assert.equal(typeof record.diagnostic.cwd, "string");
  assert.ok(record.diagnostic.cwd.length > 0);
  assert.equal(typeof record.diagnostic.nodeCommandV, "string");
  assert.ok(record.diagnostic.nodeCommandV.length > 0);
  assert.equal(record.diagnostic.pluginRootEnv.CLAUDE_PLUGIN_ROOT, "/tmp/probe-root");
  assert.equal(record.diagnostic.pluginRootEnv.PLUGIN_ROOT, "/tmp/probe-root2");
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

// --- probe.mjs (setup / status / teardown) ---

function runProbe(args, { home: h, env = {} } = {}) {
  const e = { ...process.env, HOME: h, ...env };
  delete e.AGENTO_PROBE_LOG_DIR; // force the default cache/log layout under the temp HOME
  const res = spawnSync(process.execPath, [probeCli, ...args], { encoding: "utf8", env: e });
  return { res };
}

function mkHome() {
  return mkdtempSync(path.join(tmpdir(), "agento-probe-home-"));
}

test("setup installs workspace, symlink, copy, and log dir in a temp HOME", () => {
  const h = mkHome();
  const { res } = runProbe(["setup"], { home: h });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.ok(report.workspace.startsWith(path.join(h, ".cache")), "workspace not under the temp HOME cache");
  const wsProbeJson = path.join(report.workspace, ".github", "hooks", "probe.json");
  const probeJson = readFileSync(wsProbeJson, "utf8");
  assert.ok(probeJson.includes("log-payload.mjs"), "probe.json not rewritten with the logger path");
  assert.ok(!probeJson.includes("__AGENTO_PROBE_LOGGER__"), "placeholder left in probe.json");
  assert.ok(existsSync(path.join(report.workspace, ".git")), "workspace not git-init'ed");
  const link = path.join(h, ".copilot", "skills", "agento");
  assert.ok(lstatSync(link).isSymbolicLink(), "agento skill is not a symlink");
  assert.equal(readlinkSync(link), path.join(here, "skills", "agento"));
  const copy = path.join(h, ".copilot", "skills", "agento-probe-copy");
  assert.ok(existsSync(path.join(copy, ".agento-probe-owned")), "copy ownership marker missing");
  assert.ok(report.promptsPath.endsWith("PROMPTS.md"));
  assert.ok(report.pluginDir.endsWith("plugin"));
  assert.ok(report.openCommand.startsWith("code --new-window"));
  rmSync(h, { recursive: true, force: true });
});

test("setup refuses a foreign ~/.copilot/skills/agento", () => {
  const h = mkHome();
  const skills = path.join(h, ".copilot", "skills");
  mkdirSync(skills, { recursive: true });
  mkdirSync(path.join(skills, "agento"));
  const { res } = runProbe(["setup"], { home: h });
  assert.notEqual(res.status, 0, "setup should refuse a foreign agento path");
  assert.match(res.stderr, /refusing/);
  rmSync(h, { recursive: true, force: true });
});

test("teardown removes probe-owned entries and leaves foreign entries untouched", () => {
  const h = mkHome();
  const skills = path.join(h, ".copilot", "skills");
  mkdirSync(skills, { recursive: true });
  const foreignAgent = path.join(skills, "agento");
  mkdirSync(foreignAgent);
  writeFileSync(path.join(foreignAgent, "keep.txt"), "foreign\n");
  const foreignCopy = path.join(skills, "agento-probe-copy");
  mkdirSync(foreignCopy); // no ownership marker
  writeFileSync(path.join(foreignCopy, "keep.txt"), "foreign\n");
  const cache = path.join(h, ".cache", "agento-harness-probe");
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "log.json"), "{}");

  const { res } = runProbe(["teardown"], { home: h });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.ok(report.removed.includes(cache), "cache dir not removed");
  assert.ok(existsSync(path.join(foreignAgent, "keep.txt")), "foreign agento removed");
  assert.ok(existsSync(path.join(foreignCopy, "keep.txt")), "foreign copy removed");
  assert.ok(report.kept.some((k) => k.path === foreignAgent), "foreign agento not reported kept");
  assert.ok(report.kept.some((k) => k.path === foreignCopy), "foreign copy not reported kept");
  rmSync(h, { recursive: true, force: true });
});

test("teardown after setup removes the probe's own symlink, copy, and cache", () => {
  const h = mkHome();
  runProbe(["setup"], { home: h });
  const { res } = runProbe(["teardown"], { home: h });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  const link = path.join(h, ".copilot", "skills", "agento");
  const copy = path.join(h, ".copilot", "skills", "agento-probe-copy");
  const cache = path.join(h, ".cache", "agento-harness-probe");
  assert.ok(report.removed.includes(link), "agento symlink not removed");
  assert.ok(report.removed.includes(copy), "copy not removed");
  assert.ok(report.removed.includes(cache), "cache not removed");
  assert.ok(!existsSync(link));
  assert.ok(!existsSync(copy));
  assert.ok(!existsSync(cache));
  rmSync(h, { recursive: true, force: true });
});

test("teardown reports a leftover chat.pluginLocations entry without editing settings.json", () => {
  const h = mkHome();
  const cfgHome = path.join(h, ".config");
  const userDir = path.join(cfgHome, "Code", "User");
  mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ "chat.pluginLocations": [path.join(here, "plugin")] }));
  const { res } = runProbe(["teardown"], { home: h, env: { XDG_CONFIG_HOME: cfgHome } });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.ok(report.pluginLocations.entries.length >= 1, "leftover plugin location not reported");
  assert.ok(readFileSync(settingsPath, "utf8").includes("chat.pluginLocations"), "settings.json was edited (must not be)");
  rmSync(h, { recursive: true, force: true });
});

test("status reports the installed state", () => {
  const h = mkHome();
  runProbe(["setup"], { home: h });
  const { res } = runProbe(["status"], { home: h });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.installed.workspace, true);
  assert.equal(typeof report.installed.agentoSymlink, "object");
  assert.equal(report.installed.agentoProbeCopy, true);
  assert.equal(report.installed.logDir, true);
  rmSync(h, { recursive: true, force: true });
});

// --- probe.mjs collect (step 1.4) ---

function runProbeCollect(args, env) {
  const res = spawnSync(process.execPath, [probeCli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { res };
}

test("collect sanitizes logs into fixtures and empties the log dir", () => {
  const h = mkHome();
  const logDir = mkdtempSync(path.join(tmpdir(), "agento-probe-log-"));
  const fixturesDir = mkdtempSync(path.join(tmpdir(), "agento-probe-fx-"));
  const record = {
    source: "workspace",
    event: "PreToolUse",
    argv: ["workspace", "PreToolUse"],
    cwd: path.join(h, "DP", "agento-worktrees", "x"),
    envVarNames: ["CLAUDE_PLUGIN_ROOT"],
    diagnostic: {
      cwd: path.join(h, "DP", "agento-worktrees", "x"),
      nodeCommandV: path.join(h, ".nvm", "versions", "node"),
      pluginRootEnv: { CLAUDE_PLUGIN_ROOT: path.join(h, "DP", "agento-worktrees", "x", "tests", "harness-probe", "plugin") },
    },
    stdin: JSON.stringify({
      session_id: "123e4567-e89b-12d3-a456-426614174000",
      at: "2026-10-13T12:00:00.000Z",
      env: { SECRET: "x", HOME: path.join(h, "home") },
      token: "topsecret",
      tool_input: { content: "hi" },
    }),
  };
  writeFileSync(path.join(logDir, "workspace-PreToolUse-1.json"), JSON.stringify(record, null, 2));

  const { res } = runProbeCollect(["collect", "--harness", "local"], {
    HOME: h,
    AGENTO_PROBE_LOG_DIR: logDir,
    AGENTO_PROBE_FIXTURES_DIR: fixturesDir,
  });
  assert.equal(res.status, 0, res.stderr);
  const fxDir = path.join(fixturesDir, "local");
  const files = readdirSync(fxDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(files[0], "workspace-PreToolUse-1.json");
  const text = readFileSync(path.join(fxDir, files[0]), "utf8");
  assert.ok(!text.includes(h), "temp home path leaked into the fixture");
  assert.ok(!text.includes("topsecret"), "token value leaked into the fixture");
  assert.ok(!text.includes("SECRET"), "env object not dropped");
  assert.ok(text.includes("<HOME>"), "home path not replaced with <HOME>");
  assert.ok(text.includes("<UUID-"), "UUID not replaced");
  assert.ok(text.includes("<TS-"), "timestamp not replaced");
  const clean = JSON.parse(text);
  assert.ok(clean.diagnostic.pluginRootEnv.CLAUDE_PLUGIN_ROOT.includes("<HOME>"), "diagnostic PLUGIN_ROOT value not scrubbed");
  assert.ok(clean.diagnostic.nodeCommandV.includes("<HOME>"), "diagnostic node path not scrubbed");
  assert.equal(readdirSync(logDir).filter((f) => f.endsWith(".json")).length, 0, "log dir not emptied");
  rmSync(logDir, { recursive: true, force: true });
  rmSync(fixturesDir, { recursive: true, force: true });
  rmSync(h, { recursive: true, force: true });
});

test("collect refuses on a planted /home/x and writes nothing", () => {
  const h = mkHome();
  const logDir = mkdtempSync(path.join(tmpdir(), "agento-probe-log-"));
  const fixturesDir = mkdtempSync(path.join(tmpdir(), "agento-probe-fx-"));
  writeFileSync(
    path.join(logDir, "workspace-SessionStart-1.json"),
    JSON.stringify({ source: "workspace", event: "SessionStart", stdin: "/home/x/some/file" }),
  );
  const { res } = runProbeCollect(["collect", "--harness", "local"], {
    HOME: h,
    AGENTO_PROBE_LOG_DIR: logDir,
    AGENTO_PROBE_FIXTURES_DIR: fixturesDir,
  });
  assert.notEqual(res.status, 0, "collect should refuse a /home/ path");
  assert.match(res.stderr, /refused/);
  assert.ok(!existsSync(path.join(fixturesDir, "local")), "fixtures written despite refusal");
  assert.equal(readdirSync(logDir).filter((f) => f.endsWith(".json")).length, 1, "log dir must not be emptied on refusal");
  rmSync(logDir, { recursive: true, force: true });
  rmSync(fixturesDir, { recursive: true, force: true });
  rmSync(h, { recursive: true, force: true });
});

test("collect refuses on a planted ghp_ token and writes nothing", () => {
  const h = mkHome();
  const logDir = mkdtempSync(path.join(tmpdir(), "agento-probe-log-"));
  const fixturesDir = mkdtempSync(path.join(tmpdir(), "agento-probe-fx-"));
  writeFileSync(
    path.join(logDir, "workspace-PreToolUse-1.json"),
    JSON.stringify({ source: "workspace", event: "PreToolUse", stdin: "ghp_abcdef0123456789" }),
  );
  const { res } = runProbeCollect(["collect", "--harness", "copilot"], {
    HOME: h,
    AGENTO_PROBE_LOG_DIR: logDir,
    AGENTO_PROBE_FIXTURES_DIR: fixturesDir,
  });
  assert.notEqual(res.status, 0, "collect should refuse a ghp_ token");
  assert.match(res.stderr, /refused/);
  assert.ok(!existsSync(path.join(fixturesDir, "copilot")), "fixtures written despite refusal");
  rmSync(logDir, { recursive: true, force: true });
  rmSync(fixturesDir, { recursive: true, force: true });
  rmSync(h, { recursive: true, force: true });
});

test("committed fixtures contain no deny patterns", () => {
  const root = path.join(here, "fixtures");
  const files = [];
  (function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (lstatSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) files.push(p);
    }
  })(root);
  for (const f of files) {
    const deny = findDeny(readFileSync(f, "utf8"));
    assert.equal(deny, null, `${path.relative(here, f)} contains ${deny?.pattern}`);
  }
});

test("every relative link in docs/copilot-harness.md resolves", () => {
  const doc = path.join(here, "..", "..", "docs", "copilot-harness.md");
  assert.ok(existsSync(doc), "docs/copilot-harness.md is missing");
  const docDir = path.dirname(doc);
  const text = readFileSync(doc, "utf8");
  const links = [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const broken = [];
  for (const target of links) {
    if (/^(?:https?:|#|mailto:)/i.test(target)) continue;
    const file = target.split("#")[0];
    if (!file) continue;
    if (!existsSync(path.resolve(docDir, file))) broken.push(target);
  }
  assert.deepEqual(broken, [], "docs/copilot-harness.md has unresolved relative links");
});

// --- probe agents (agents-copilot-models member, step 1.1) ---

const agentsDir = path.join(here, "workspace", ".github", "agents");

function agentFrontmatter(name) {
  const file = path.join(agentsDir, name);
  assert.ok(existsSync(file), `${name} is missing`);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0].replace(/\r$/, ""), "---", `${name}: no frontmatter opener`);
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, "") === "---");
  assert.ok(end > 0, `${name}: no frontmatter closer`);
  return { text, body: lines.slice(end + 1).join("\n"), fm: lines.slice(1, end).join("\n") };
}

test("probe agents carry the four pin variants (picker, BYOK, list, unpinned)", () => {
  const pinned = agentFrontmatter("probe-pinned.agent.md");
  assert.match(pinned.fm, /^model: "Claude Opus 5\.5 \(copilot\)"$/m, "probe-pinned must pin the picker form");

  const byok = agentFrontmatter("probe-pinned-byok.agent.md");
  assert.match(byok.fm, /^model: "DeepSeek V4 Pro \(deepseek\)"$/m, "probe-pinned-byok must pin the BYOK picker form");

  const list = agentFrontmatter("probe-pinned-list.agent.md");
  assert.match(
    list.fm,
    /^model: \["Claude Opus 5\.5 \(copilot\)", "claude-opus-5\.5"\]$/m,
    "probe-pinned-list must pin the picker form first and the Copilot id candidate second",
  );

  const unpinned = agentFrontmatter("probe-unpinned.agent.md");
  assert.doesNotMatch(unpinned.fm, /^model:/m, "probe-unpinned must have no model pin");
});

test("every probe agent reports model, tools, ask-user, browser, and subagent model support", () => {
  for (const name of ["probe-pinned.agent.md", "probe-pinned-byok.agent.md", "probe-pinned-list.agent.md", "probe-unpinned.agent.md"]) {
    const { body } = agentFrontmatter(name);
    const tag = name.replace(/\.agent\.md$/, "");
    for (const line of ["model=", "tools=", "ask-user=", "browser=", "subagent-model-param="]) {
      assert.ok(body.includes(`${tag} ${line}`), `${name} body must contain a \`${tag} ${line}\` report line`);
    }
  }
});
