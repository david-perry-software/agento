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
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME || homedir();
const cacheDir = path.join(home, ".cache", "agento-harness-probe");
const logDir = process.env.AGENTO_PROBE_LOG_DIR || path.join(cacheDir, "logs");
const workspaceSrc = path.join(here, "workspace");
const workspaceDst = path.join(cacheDir, "workspace");
const loggerPath = path.join(here, "log-payload.mjs");
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
  // Implemented in roadmap step 1.4.
  console.error("probe: collect is not implemented yet");
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "setup") setup();
  else if (cmd === "status") status();
  else if (cmd === "teardown") teardown();
  else if (cmd === "collect") collect(rest);
  else {
    console.error("usage: probe.mjs <setup|status|collect|teardown>");
    process.exit(2);
  }
} catch (err) {
  console.error(`probe: ${err.message}`);
  process.exit(1);
}
