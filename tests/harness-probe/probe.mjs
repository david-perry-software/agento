#!/usr/bin/env node
// harness-probe CLI.
//
//   probe.mjs setup                 install the probe into ~/.cache and ~/.copilot/skills
//   probe.mjs status                report what is installed
//   probe.mjs collect --harness <h> sanitize logs into fixtures/<h>/ and empty the log dir
//   probe.mjs teardown              remove only probe-owned entries and report leftovers
//
// Honors HOME and AGENTO_PROBE_LOG_DIR so tests can run in a temp HOME. It never
// shells out with a command line that names a protected path (workspace copy,
// probe.json rewrite, symlink, and removals all happen in Node); the only shell
// calls are `git` on the copied workspace and `copilot plugin …`, neither of
// which names a protected path.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME || homedir();
const cacheDir = path.join(home, ".cache", "agento-harness-probe");
const logDir = process.env.AGENTO_PROBE_LOG_DIR || path.join(cacheDir, "logs");
const workspaceSrc = path.join(here, "workspace");
const workspaceDst = path.join(cacheDir, "workspace");
const loggerPath = path.join(here, "plugin", "log-payload.mjs");
const skillsRoot = path.join(home, ".copilot", "skills");
const agentoLink = path.join(skillsRoot, "agento");
const agentoSrc = path.join(here, "skills", "agento");
const copyLink = path.join(skillsRoot, "agento-probe-copy");
const copySrc = path.join(here, "skills", "agento-probe-copy");
const copyMarker = ".agento-probe-owned";
const pluginDir = path.join(here, "plugin");
const promptsPath = path.join(here, "PROMPTS.md");
const LOGGER_PLACEHOLDER = "__AGENTO_PROBE_LOGGER__";

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function git(ws, args) {
  return spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
}

function ensureSymlink(link, target) {
  const st = lstatOrNull(link);
  if (st) {
    if (st.isSymbolicLink()) {
      const existing = readlinkSync(link);
      if (existing === target) return "ok";
      throw new Error(`refusing: ${link} symlinks to ${existing}, not the probe's ${target}`);
    }
    throw new Error(`refusing: ${link} exists and is not the probe's symlink`);
  }
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
  return "created";
}

function setup() {
  // Refuse before mutating anything if a foreign agento skill is in the way.
  const agentoState = ensureSymlink(agentoLink, agentoSrc);

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  rmSync(workspaceDst, { recursive: true, force: true });
  cpSync(workspaceSrc, workspaceDst, { recursive: true });

  const probeJson = path.join(workspaceDst, ".github", "hooks", "probe.json");
  const raw = readFileSync(probeJson, "utf8");
  writeFileSync(probeJson, raw.split(LOGGER_PLACEHOLDER).join(loggerPath));

  const gitInit = git(workspaceDst, ["init", "-q"]);
  git(workspaceDst, ["add", "-A"]);
  const gitCommit = git(workspaceDst, [
    "-c", "user.name=agento-harness-probe",
    "-c", "user.email=probe@example.invalid",
    "commit", "-q", "-m", "initial probe workspace",
  ]);

  rmSync(copyLink, { recursive: true, force: true });
  cpSync(copySrc, copyLink, { recursive: true });
  writeFileSync(path.join(copyLink, copyMarker), "agento-harness-probe\n");

  console.log(
    JSON.stringify(
      {
        home,
        cacheDir,
        logDir,
        workspace: workspaceDst,
        pluginDir,
        promptsPath,
        openCommand: `code --new-window ${workspaceDst}`,
        skills: {
          agento: { path: agentoLink, target: agentoSrc, state: agentoState },
          agentoProbeCopy: { path: copyLink, source: copySrc, state: "copied" },
        },
        git: {
          init: gitInit.status === 0,
          commit: gitCommit.status === 0,
          commitMessage: "initial probe workspace",
        },
      },
      null,
      2,
    ),
  );
}

function status() {
  const st = lstatOrNull(agentoLink);
  const copyOwned = existsSync(path.join(copyLink, copyMarker));
  console.log(
    JSON.stringify(
      {
        home,
        cacheDir,
        logDir,
        workspace: workspaceDst,
        pluginDir,
        promptsPath,
        installed: {
          workspace: lstatOrNull(workspaceDst)?.isDirectory() ?? false,
          agentoSymlink:
            st?.isSymbolicLink() === true
              ? { target: readlinkSync(agentoLink) }
              : st
                ? "present-but-not-a-symlink"
                : false,
          agentoProbeCopy: copyOwned,
          logDir: lstatOrNull(logDir)?.isDirectory() ?? false,
          logFileCount:
            existsSync(logDir) && lstatOrNull(logDir)?.isDirectory()
              ? readdirSync(logDir).filter((f) => f.endsWith(".json")).length
              : 0,
        },
        pluginLocations: leftoverPluginLocations(),
      },
      null,
      2,
    ),
  );
}

function uninstallPlugin() {
  if (!haveCopilot()) return { copilot: false, note: "copilot CLI absent" };
  const list = spawnSync("copilot", ["plugin", "list"], { encoding: "utf8", timeout: 10000 });
  if (list.error) return { copilot: true, note: `copilot plugin list failed: ${list.error.message}` };
  if (!/agento-probe-plugin/.test(list.stdout)) return { copilot: true, installed: false };
  const un = spawnSync("copilot", ["plugin", "uninstall", "agento-probe-plugin"], {
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    copilot: true,
    installed: true,
    uninstalled: un.status === 0,
    output: `${un.stdout}${un.stderr}`.trim().slice(0, 500),
  };
}

function haveCopilot() {
  const res = spawnSync("copilot", ["--version"], { encoding: "utf8", timeout: 10000 });
  return res.error?.code !== "ENOENT";
}

function leftoverPluginLocations() {
  const cfgHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const settingsPath = path.join(cfgHome, "Code", "User", "settings.json");
  if (!existsSync(settingsPath)) return { settingsPath, entries: [] };
  let json;
  try {
    json = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { settingsPath, entries: [], note: "settings.json is not valid JSON" };
  }
  const locs = json["chat.pluginLocations"];
  if (locs == null) return { settingsPath, entries: [] };
  const flat = Array.isArray(locs) ? locs : typeof locs === "object" ? Object.values(locs) : [locs];
  const entries = flat.filter(
    (e) => typeof e === "string" && (e.includes("agento-probe-plugin") || e.includes(pluginDir)),
  );
  return { settingsPath, entries };
}

function teardown() {
  const report = { removed: [], kept: [], plugin: null, pluginLocations: [] };

  const st = lstatOrNull(agentoLink);
  if (st?.isSymbolicLink()) {
    const existing = readlinkSync(agentoLink);
    if (existing === agentoSrc) {
      rmSync(agentoLink, { force: true });
      report.removed.push(agentoLink);
    } else {
      report.kept.push({ path: agentoLink, reason: `foreign symlink to ${existing}` });
    }
  } else if (st) {
    report.kept.push({ path: agentoLink, reason: "not a symlink" });
  }

  if (existsSync(path.join(copyLink, copyMarker))) {
    rmSync(copyLink, { recursive: true, force: true });
    report.removed.push(copyLink);
  } else if (lstatOrNull(copyLink)) {
    report.kept.push({ path: copyLink, reason: "no probe-ownership marker" });
  }

  if (lstatOrNull(cacheDir)) {
    rmSync(cacheDir, { recursive: true, force: true });
    report.removed.push(cacheDir);
  }

  report.plugin = uninstallPlugin();
  report.pluginLocations = leftoverPluginLocations();

  console.log(JSON.stringify(report, null, 2));
}

function collect(args) {
  const harness = parseOpt(args, "--harness");
  if (!harness) {
    console.error("probe: collect requires --harness <label>");
    process.exit(2);
  }
  const fixturesRoot = process.env.AGENTO_PROBE_FIXTURES_DIR || path.join(here, "fixtures");
  const fixturesDir = path.join(fixturesRoot, harness);
  const files =
    existsSync(logDir) && lstatOrNull(logDir)?.isDirectory()
      ? readdirSync(logDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
      : [];
  if (files.length === 0) {
    console.log(JSON.stringify({ harness, fixturesDir, collected: 0, note: "no log files" }, null, 2));
    return;
  }

  const ctx = makeSanitizeCtx();
  const sanitized = [];
  for (const f of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(logDir, f), "utf8"));
    } catch {
      record = { source: "unknown", event: "unknown", stdin: readFileSync(path.join(logDir, f), "utf8") };
    }
    const clean = sanitizeRecord(record, ctx);
    const text = JSON.stringify(clean, null, 2);
    const deny = findDeny(text);
    if (deny) {
      console.error(`probe: collect refused: ${deny.pattern} found in ${f}; nothing written`);
      process.exit(1);
    }
    sanitized.push({ record: clean, text });
  }

  rmSync(fixturesDir, { recursive: true, force: true });
  mkdirSync(fixturesDir, { recursive: true });
  const counters = new Map();
  const names = [];
  for (const { record, text } of sanitized) {
    const key = `${record.source}-${record.event}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const name = `${record.source}-${record.event}-${n}.json`;
    names.push(name);
    writeFileSync(path.join(fixturesDir, name), text + "\n");
  }
  for (const f of files) rmSync(path.join(logDir, f), { force: true });

  console.log(JSON.stringify({ harness, fixturesDir, collected: sanitized.length, files: names }, null, 2));
}

const TOKEN_KEY = /token|secret|password|auth|cookie|credential|api[-_]?key/i;

const DENY_PATTERNS = [
  [/\/home\//i, "/home/ path"],
  [/\/Users\//, "/Users/ path"],
  [/C:\\Users/i, "C:\\Users path"],
  [/gh[pousr]_/, "GitHub token"],
  [/github_pat_/, "GitHub PAT"],
  [/\bsk-[A-Za-z0-9_-]{8,}/, "sk- key"],
  [/Bearer\s+/i, "Bearer header"],
];

function findDeny(text) {
  for (const [re, label] of DENY_PATTERNS) {
    if (re.test(text)) return { pattern: label };
  }
  return null;
}

function parseOpt(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return null;
}

function makeSanitizeCtx() {
  const homeDir = process.env.HOME || homedir();
  let username = process.env.USER || process.env.LOGNAME || "";
  if (!username) {
    try {
      username = userInfo().username;
    } catch {
      username = "";
    }
  }
  const repoRoot = path.resolve(here, "..", "..");
  const probeWs = path.join(homeDir, ".cache", "agento-harness-probe", "workspace");
  const counters = { TS: 0, UUID: 0, HEX: 0 };
  const paths = [
    [repoRoot, "<REPO>"],
    [probeWs, "<PROBE_WS>"],
    [homeDir, "<HOME>"],
    [username, "<USER>"],
  ].filter(([from]) => from);
  return { counters, paths };
}

function nextPlaceholder(ctx, kind) {
  ctx.counters[kind] += 1;
  return `<${kind}-${ctx.counters[kind]}>`;
}

function scrubStrings(str, ctx) {
  let out = str;
  for (const [from, to] of ctx.paths) out = out.split(from).join(to);
  return out
    .replace(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?\b/g,
      () => nextPlaceholder(ctx, "TS"),
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      () => nextPlaceholder(ctx, "UUID"),
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, () => nextPlaceholder(ctx, "HEX"))
    .replace(/\b\d{13,15}\b/g, () => nextPlaceholder(ctx, "TS"));
}

function sanitizeValue(value, ctx, key = null) {
  if (key != null && TOKEN_KEY.test(String(key))) return undefined;
  if (key === "env") return undefined;
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      const s = sanitizeValue(v, ctx, null);
      if (s !== undefined) out.push(s);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (TOKEN_KEY.test(k) || k === "env") continue;
      const s = sanitizeValue(v, ctx, k);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  if (typeof value === "string") return scrubStrings(value, ctx);
  return value;
}

function sanitizeRecord(record, ctx = makeSanitizeCtx()) {
  // The raw stdin string may embed JSON whose keys carry secrets. Re-sanitize it
  // through the parser so token-like keys and env objects are actually removed
  // rather than surviving as raw text inside a string value.
  if (record && typeof record === "object" && typeof record.stdin === "string") {
    try {
      const parsed = JSON.parse(record.stdin);
      record.stdin = JSON.stringify(sanitizeValue(parsed, ctx), null, 2);
    } catch {
      // Not JSON: the generic pass below scrubs paths and ids from the raw string.
    }
  }
  return sanitizeValue(record, ctx);
}

const [cmd, ...rest] = process.argv.slice(2);

function dispatch() {
  if (cmd === "setup") return setup();
  if (cmd === "status") return status();
  if (cmd === "teardown") return teardown();
  if (cmd === "collect") return collect(rest);
  console.error("usage: probe.mjs <setup|status|collect|teardown>");
  process.exit(2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    dispatch();
  } catch (err) {
    console.error(`probe: ${err.message}`);
    process.exit(1);
  }
}

export { setup, status, teardown, collect, findDeny, sanitizeRecord, makeSanitizeCtx };
