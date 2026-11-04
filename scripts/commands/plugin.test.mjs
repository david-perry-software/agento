import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentPluginsDir,
  detectInUse,
  expandHome,
  inUseSnapshots,
  listSnapshots,
  planPrune,
  pluginLocations,
  snapshotDirName,
  snapshotsToPrune,
  vscodeSettingsPath,
  windowPinnedSnapshots,
} from "../lib/plugin.mjs";
import { handoffModelLines, readModel, setHandoffModels, setModel } from "../model-profiles.mjs";
import { baseEnv, git, makeRepo, runWith } from "../test-helpers/agento-fixtures.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agento-plugin-"));

const gitInit = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
};

test("agentPluginsDir: override, XDG_CONFIG_HOME, and platform defaults", () => {
  assert.equal(agentPluginsDir({ AGENTO_VSCODE_AGENT_PLUGINS: "/tmp/ap" }), "/tmp/ap");
  assert.equal(agentPluginsDir({ XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "Code", "agentPlugins"));
  assert.equal(agentPluginsDir({}), path.join(os.homedir(), ".config", "Code", "agentPlugins"));
});

test("vscodeSettingsPath and expandHome shared with doctor", () => {
  assert.equal(vscodeSettingsPath({ AGENTO_VSCODE_SETTINGS: "/tmp/settings.json" }), "/tmp/settings.json");
  assert.equal(vscodeSettingsPath({ XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "Code", "User", "settings.json"));
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  assert.equal(expandHome("/abs/x"), "/abs/x");
});

test("snapshotDirName maps a file:// uri and a plain path to VS Code's staged directory name", () => {
  assert.equal(snapshotDirName("file:///home/david/DP/agento-plugin"), "file-home-david-DP-agento-plugin");
  assert.equal(snapshotDirName("/home/david/DP/agento-plugin"), "file-home-david-DP-agento-plugin");
  assert.equal(snapshotDirName("~/agento-plugin"), `file-${os.homedir().slice(1).replace(/\//g, "-")}-agento-plugin`);
});

test("listSnapshots lists only hex-named children, oldest first, newest = largest nonce, nonce = hex mtime", () => {
  const root = tmp();
  const agents = path.join(root, "agentPlugins");
  const locationDir = path.join(agents, "file-home-david-DP-agento-plugin");
  const nonces = ["1a14d7020a8", "1a16a70f607", "1a18e5b18c2"];
  for (const nonce of nonces) {
    const dir = path.join(locationDir, nonce);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "file.txt"), "x".repeat(2048));
    const ms = parseInt(nonce, 16);
    fs.utimesSync(dir, new Date(ms), new Date(ms));
  }
  // Non-hex names and non-directories must be ignored.
  fs.mkdirSync(path.join(locationDir, "not-hex"));
  fs.writeFileSync(path.join(locationDir, "cache.json"), "[]");

  const env = { AGENTO_VSCODE_AGENT_PLUGINS: agents };
  const snapshots = listSnapshots("/home/david/DP/agento-plugin", env);
  assert.deepEqual(snapshots.map((s) => s.nonce), nonces);
  for (const snapshot of snapshots) {
    // The nonce is the hex millisecond mtime; allow a tick of timestamp rounding.
    assert.ok(Math.abs(snapshot.mtime - parseInt(snapshot.nonce, 16)) <= 2, `${snapshot.nonce}: mtime ${snapshot.mtime}`);
    assert.equal(snapshot.path, path.join(locationDir, snapshot.nonce));
    assert.ok(snapshot.bytes >= 2048, "bytes covers at least the file's apparent size");
  }
  assert.equal(snapshots[snapshots.length - 1].nonce, "1a18e5b18c2");
  fs.rmSync(root, { recursive: true, force: true });
});

test("listSnapshots returns [] when the location has no staged directory", () => {
  const root = tmp();
  assert.deepEqual(listSnapshots("/home/david/DP/agento-plugin", { AGENTO_VSCODE_AGENT_PLUGINS: path.join(root, "agentPlugins") }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pluginLocations classifies enabled entries as missing/export/clone/other and skips disabled entries", () => {
  const root = tmp();
  const missing = path.join(root, "missing");
  const exported = path.join(root, "exported");
  const clone = path.join(root, "clone");
  const other = path.join(root, "other");
  const off = path.join(root, "off");

  fs.mkdirSync(exported, { recursive: true });
  fs.writeFileSync(path.join(exported, ".agento-export.json"), "{}");
  gitInit(clone);
  fs.mkdirSync(path.join(clone, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(clone, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "readme.md"), "not an export or clone");
  fs.mkdirSync(off, { recursive: true });

  const settings = path.join(root, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      "chat.pluginLocations": {
        [missing]: true,
        [exported]: true,
        [clone]: true,
        [other]: true,
        [off]: false,
        "~/somewhere": true,
      },
    }),
  );

  const locations = pluginLocations({ AGENTO_VSCODE_SETTINGS: settings });
  assert.deepEqual(
    locations.map((l) => [l.dir, l.kind]),
    [
      [missing, "missing"],
      [exported, "export"],
      [clone, "clone"],
      [other, "other"],
      ["~/somewhere", "missing"],
    ],
  );
  assert.equal(locations.find((l) => l.dir === "~/somewhere").path, path.join(os.homedir(), "somewhere"));
  assert.equal(locations.find((l) => l.dir === clone).path, clone);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pluginLocations returns [] for unreadable or empty settings", () => {
  const root = tmp();
  assert.deepEqual(pluginLocations({ AGENTO_VSCODE_SETTINGS: path.join(root, "none.json") }), []);
  const settings = path.join(root, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ "editor.tabSize": 2 }));
  assert.deepEqual(pluginLocations({ AGENTO_VSCODE_SETTINGS: settings }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- plugin export (roadmap step 2.2) ---

const walk = (root) => {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out.sort();
};

const contentMap = (dir) => {
  const map = {};
  for (const rel of walk(dir)) map[rel] = fs.readFileSync(path.join(dir, rel), "utf8");
  return map;
};

test("plugin export builds a tracked-only tree, re-exports, and refuses a bad ref and a non-git source", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "dep.js"), "ignored\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "files");
  git(repo, "push", "-q", "origin", "main");

  const dest = path.join(os.tmpdir(), `agento-export-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const first = runWith({ cwd: repo }, "plugin", "export", "--source", repo, "--dest", dest);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.equal(first.json.status, "ok");
  assert.equal(first.json.source.commit, git(repo, "rev-parse", "origin/main"));

  const expected = [...git(repo, "ls-tree", "-r", "--name-only", "origin/main").split("\n").filter(Boolean), ".agento-export.json"].sort();
  assert.deepEqual(walk(dest), expected);
  assert.ok(!fs.existsSync(path.join(dest, ".git")), "no .git in the export");
  assert.ok(!fs.existsSync(path.join(dest, "node_modules")), "no node_modules in the export");
  const stamp = JSON.parse(fs.readFileSync(path.join(dest, ".agento-export.json"), "utf8"));
  assert.equal(stamp.source.commit, git(repo, "rev-parse", "origin/main"));
  assert.equal(stamp.source.ref, "origin/main");
  assert.ok(Array.isArray(stamp.carriedPins));

  // Re-export over an earlier export replaces it.
  fs.writeFileSync(path.join(repo, "src", "index.js"), "module.exports = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "files v2");
  git(repo, "push", "-q", "origin", "main");
  const second = runWith({ cwd: repo }, "plugin", "export", "--source", repo, "--dest", dest);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  assert.equal(fs.readFileSync(path.join(dest, "src", "index.js"), "utf8"), "module.exports = 2;\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, ".agento-export.json"), "utf8")).source.commit, git(repo, "rev-parse", "origin/main"));

  // A bad ref is refused before the swap: dest byte-identical, no temp dirs.
  const before = contentMap(dest);
  const bad = runWith({ cwd: repo }, "plugin", "export", "--source", repo, "--dest", dest, "--ref", "origin/nope");
  assert.equal(bad.code, 3, JSON.stringify(bad.json));
  assert.equal(bad.json.status, "refused");
  assert.deepEqual(contentMap(dest), before);
  const stray = fs.readdirSync(path.dirname(dest)).filter((n) => n.startsWith(`${path.basename(dest)}.agento-`));
  assert.deepEqual(stray, []);

  // A staged snapshot (non-git) as source is refused.
  const snapshot = path.join(os.tmpdir(), `agento-snapshot-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, "file.txt"), "staged\n");
  const staged = runWith({ cwd: repo }, "plugin", "export", "--source", snapshot, "--dest", `${dest}-2`);
  assert.equal(staged.code, 3, JSON.stringify(staged.json));
  assert.match(staged.json.message, /not a git checkout/);

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(snapshot, { recursive: true, force: true });
});

test("plugin export handles a repository archive larger than the default maxBuffer", () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "big file");
  git(repo, "push", "-q", "origin", "main");
  const dest = path.join(os.tmpdir(), `agento-big-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const result = runWith({ cwd: repo }, "plugin", "export", "--source", repo, "--dest", dest);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(fs.statSync(path.join(dest, "big.bin")).size, 2 * 1024 * 1024);
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

test("plugin export with no --dest refuses when no or several Agento plugin locations are registered", () => {
  const repo = makeRepo();
  const settings = path.join(os.tmpdir(), `agento-settings-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  const clone1 = path.join(os.tmpdir(), `agento-loc1-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const clone2 = path.join(os.tmpdir(), `agento-loc2-${process.pid}-${Math.random().toString(16).slice(2)}`);
  for (const c of [clone1, clone2]) {
    fs.mkdirSync(path.join(c, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(c, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
    execFileSync("git", ["-C", c, "init", "-q"], { stdio: "ignore" });
  }

  fs.writeFileSync(settings, JSON.stringify({}));
  const none = runWith({ cwd: repo, env: { ...baseEnv, AGENTO_VSCODE_SETTINGS: settings } }, "plugin", "export", "--source", repo);
  assert.equal(none.code, 3, JSON.stringify(none.json));
  assert.equal(none.json.status, "refused");

  fs.writeFileSync(settings, JSON.stringify({ "chat.pluginLocations": { [clone1]: true, [clone2]: true } }));
  const several = runWith({ cwd: repo, env: { ...baseEnv, AGENTO_VSCODE_SETTINGS: settings } }, "plugin", "export", "--source", repo);
  assert.equal(several.code, 3, JSON.stringify(several.json));
  assert.equal(several.json.status, "refused");
  assert.deepEqual(several.json.candidates.sort(), [clone1, clone2].sort());

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  fs.rmSync(settings, { force: true });
  fs.rmSync(clone1, { recursive: true, force: true });
  fs.rmSync(clone2, { recursive: true, force: true });
});

// --- plugin export destination safety (roadmap step 2.3) ---

const AGENT_FILE = "---\nname: planner\ndescription: Plans features.\nmodel: claude-sonnet-5\n---\n# Planner\n\nPlans.\n";

const makeAgentoClone = () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
  fs.mkdirSync(path.join(repo, ".github", "agents"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".github", "agents", "planner.agent.md"), AGENT_FILE);
  fs.writeFileSync(path.join(repo, "README.md"), "clone\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\nextension/node_modules/\n");
  fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "dep", "a.js"), "ignored\n");
  fs.mkdirSync(path.join(repo, "extension", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "extension", "node_modules", "z.js"), "ignored ext\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "agento clone");
  git(repo, "push", "-q", "origin", "main");
  return repo;
};

const makeRelease = () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
  fs.writeFileSync(path.join(repo, "release.txt"), "v1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "release");
  git(repo, "push", "-q", "origin", "main");
  return repo;
};

test("plugin export destination safety: clone needs --replace-clone; clean clone with ignored bytes is replaced", () => {
  const source = makeRelease();
  const clone = makeAgentoClone();

  const without = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", clone);
  assert.equal(without.code, 3, JSON.stringify(without.json));
  assert.match(without.json.message, /--replace-clone/);

  const replaced = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", clone, "--replace-clone");
  assert.equal(replaced.code, 0, JSON.stringify(replaced.json));
  assert.ok(replaced.json.droppedIgnoredBytes > 0, "ignored node_modules bytes are reported as dropped");
  assert.ok(fs.existsSync(path.join(clone, "release.txt")), "clone was replaced by the export");
  assert.ok(!fs.existsSync(path.join(clone, "node_modules")), "ignored node_modules dropped");
  assert.ok(!fs.existsSync(path.join(clone, ".git")), "no .git in the export");

  fs.rmSync(path.dirname(source), { recursive: true, force: true });
  fs.rmSync(path.dirname(clone), { recursive: true, force: true });
});

test("plugin export destination safety: clone changes beyond pins, untracked files, local commits, and stashes are each refused", () => {
  const source = makeRelease();

  // Changes beyond model pins (description edited, model line untouched).
  const dirty = makeAgentoClone();
  fs.writeFileSync(path.join(dirty, ".github", "agents", "planner.agent.md"), AGENT_FILE.replace("Plans features.", "Plans features differently."));
  const dirtyRun = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", dirty, "--replace-clone");
  assert.equal(dirtyRun.code, 3, JSON.stringify(dirtyRun.json));
  assert.match(dirtyRun.json.message, /changes beyond model pins/);

  // Untracked non-ignored file.
  const untracked = makeAgentoClone();
  fs.writeFileSync(path.join(untracked, "scratch.txt"), "not ignored\n");
  const untrackedRun = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", untracked, "--replace-clone");
  assert.equal(untrackedRun.code, 3, JSON.stringify(untrackedRun.json));
  assert.match(untrackedRun.json.message, /untracked non-ignored files/);

  // A commit missing from every remote.
  const local = makeAgentoClone();
  fs.writeFileSync(path.join(local, "local.txt"), "local only\n");
  git(local, "add", "-A");
  git(local, "commit", "-q", "-m", "local only");
  const localRun = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", local, "--replace-clone");
  assert.equal(localRun.code, 3, JSON.stringify(localRun.json));
  assert.match(localRun.json.message, /commits missing from every remote/);

  // Stash entries.
  const stashed = makeAgentoClone();
  fs.writeFileSync(path.join(stashed, "README.md"), "clone (stashed edit)\n");
  git(stashed, "stash", "push", "-q", "-m", "wip");
  const stashRun = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", stashed, "--replace-clone");
  assert.equal(stashRun.code, 3, JSON.stringify(stashRun.json));
  assert.match(stashRun.json.message, /stash entries/);

  fs.rmSync(path.dirname(source), { recursive: true, force: true });
  fs.rmSync(path.dirname(dirty), { recursive: true, force: true });
  fs.rmSync(path.dirname(untracked), { recursive: true, force: true });
  fs.rmSync(path.dirname(local), { recursive: true, force: true });
  fs.rmSync(path.dirname(stashed), { recursive: true, force: true });
});

test("plugin export destination safety: a non-empty non-export/non-clone destination is refused", () => {
  const source = makeRelease();
  const plain = path.join(os.tmpdir(), `agento-plain-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "file.txt"), "occupied\n");
  const run = runWith({ cwd: source }, "plugin", "export", "--source", source, "--dest", plain);
  assert.equal(run.code, 3, JSON.stringify(run.json));
  assert.match(run.json.message, /neither an earlier export nor/);

  fs.rmSync(path.dirname(source), { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

// --- plugin export model-pin carry-over (roadmap step 2.4) ---

const PLANNER = "---\nname: planner\ndescription: Plans.\nhandoffs:\n  - label: Build\n    agent: builder\n    prompt: build\n    send: true\n---\n# Planner\n\nPlans.\n";
const BUILDER = "---\nname: builder\ndescription: Builds.\n---\n# Builder\n\nBuilds.\n";
const REVIEWER = "---\nname: reviewer\ndescription: Reviews.\n---\n# Reviewer\n\nReviews.\n";

const makePluginTemplate = (agents) => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "agento" }));
  fs.mkdirSync(path.join(repo, ".github", "agents"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".github", "prompts"), { recursive: true });
  for (const [name, content] of Object.entries(agents)) fs.writeFileSync(path.join(repo, ".github", "agents", `${name}.agent.md`), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "template");
  git(repo, "push", "-q", "origin", "main");
  return repo;
};

const cloneOf = (source) => {
  const dest = path.join(os.tmpdir(), `agento-carry-${process.pid}-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["clone", "-q", git(source, "remote", "get-url", "origin"), dest], { stdio: "ignore" });
  execFileSync("git", ["-C", dest, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", dest, "config", "user.name", "Test"], { stdio: "ignore" });
  return dest;
};

const pinProfile = (env) => {
  fs.mkdirSync(env.AGENTO_CONFIG_HOME, { recursive: true });
  fs.writeFileSync(path.join(env.AGENTO_CONFIG_HOME, "model-profiles.json"), JSON.stringify({ profiles: { a: { default: "M (copilot)" } } }));
};

const applyPins = (root, files) => {
  for (const name of files) {
    const p = path.join(root, ".github", "agents", `${name}.agent.md`);
    let text = fs.readFileSync(p, "utf8");
    text = setModel(text, "M (copilot)");
    if (name === "planner") text = setHandoffModels(text, [{ target: "builder", value: "M (copilot)" }]);
    fs.writeFileSync(p, text);
  }
};

test("plugin export carries model pins from a clone and re-export carries them from an export; active profile stays the same", () => {
  const template = makePluginTemplate({ planner: PLANNER, builder: BUILDER });
  const oldDest = cloneOf(template);
  const home = path.join(os.tmpdir(), `agento-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const env = { ...baseEnv, AGENTO_CONFIG_HOME: home };
  pinProfile(env);
  applyPins(oldDest, ["planner", "builder"]);

  const before = runWith({ cwd: template, env }, "models", "list", "--plugin-root", oldDest);
  assert.equal(before.code, 0, JSON.stringify(before.json));
  assert.equal(before.json.active, "a");

  const exp = runWith({ cwd: template, env }, "plugin", "export", "--source", template, "--dest", oldDest, "--replace-clone");
  assert.equal(exp.code, 0, JSON.stringify(exp.json));
  assert.deepEqual(exp.json.carriedPins.sort(), [".github/agents/builder.agent.md", ".github/agents/planner.agent.md"]);
  assert.deepEqual(exp.json.unpinned, []);
  assert.match(exp.json.fallback, /models apply a --plugin-root/);

  const plannerText = fs.readFileSync(path.join(oldDest, ".github", "agents", "planner.agent.md"), "utf8");
  assert.match(readModel(plannerText), /M \(copilot\)/);
  assert.deepEqual(handoffModelLines(plannerText).map((h) => h.line), ["model: \"M (copilot)\""]);
  assert.match(readModel(fs.readFileSync(path.join(oldDest, ".github", "agents", "builder.agent.md"), "utf8")), /M \(copilot\)/);

  const after = runWith({ cwd: template, env }, "models", "list", "--plugin-root", oldDest);
  assert.equal(after.code, 0, JSON.stringify(after.json));
  assert.equal(after.json.active, "a");

  // Re-export over an export: no --replace-clone needed, pins carry again.
  const re = runWith({ cwd: template, env }, "plugin", "export", "--source", template, "--dest", oldDest);
  assert.equal(re.code, 0, JSON.stringify(re.json));
  assert.deepEqual(re.json.carriedPins.sort(), [".github/agents/builder.agent.md", ".github/agents/planner.agent.md"]);
  const afterRe = runWith({ cwd: template, env }, "models", "list", "--plugin-root", oldDest);
  assert.equal(afterRe.json.active, "a");

  fs.rmSync(path.dirname(template), { recursive: true, force: true });
  fs.rmSync(oldDest, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// --- plugin snapshots and prune-snapshots (roadmap step 3.1) ---

test("snapshotsToPrune keeps the newest, the running CLI, and in-use snapshots", () => {
  const snapshots = [
    { nonce: "1", path: "/ap/file-x/1" },
    { nonce: "2", path: "/ap/file-x/2" },
    { nonce: "3", path: "/ap/file-x/3" },
  ];
  assert.deepEqual(snapshotsToPrune(snapshots, "/somewhere/else").remove, snapshots.slice(0, 2));
  const running = snapshotsToPrune(snapshots, "/ap/file-x/1/nested/cli");
  assert.deepEqual(running.keep.map((p) => p.split("/").pop()).sort(), ["1", "3"]);
  assert.deepEqual(running.remove.map((s) => s.nonce), ["2"]);
  assert.deepEqual(running.inUse, []);

  const inUse = snapshotsToPrune(snapshots, "/somewhere/else", ["/ap/file-x/2/nested/hook"]);
  assert.deepEqual(inUse.keep.map((p) => p.split("/").pop()).sort(), ["2", "3"]);
  assert.deepEqual(inUse.remove.map((s) => s.nonce), ["1"]);
  assert.deepEqual(inUse.inUse.map((p) => p.split("/").pop()), ["2"]);

  // An in-use path that is already kept as the newest is not re-listed as inUse.
  const newestInUse = snapshotsToPrune(snapshots, "/somewhere/else", ["/ap/file-x/3/nested/hook"]);
  assert.deepEqual(newestInUse.inUse, []);
  assert.deepEqual(newestInUse.remove.map((s) => s.nonce), ["1", "2"]);
});

test("inUseSnapshots maps referenced process paths to the snapshots containing them; null when unavailable", () => {
  const snapshots = [
    { nonce: "1", path: "/ap/file-x/1" },
    { nonce: "2", path: "/ap/file-x/2" },
  ];
  const inUse = inUseSnapshots(snapshots, {
    scan: () => new Set(["/ap/file-x/2/scripts/hooks/session-context.sh", "/unrelated", "/ap/file-x/9"]),
  });
  assert.deepEqual(inUse, ["/ap/file-x/2"]);
  assert.equal(inUseSnapshots(snapshots, { scan: () => null }), null);
});

test("planPrune blocks deletion without in-use detection unless forced; dry run is allowed", () => {
  const snapshots = [
    { nonce: "1", path: "/ap/file-x/1" },
    { nonce: "2", path: "/ap/file-x/2" },
    { nonce: "3", path: "/ap/file-x/3" },
  ];
  const blocked = planPrune(snapshots, "/elsewhere", null);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.available, false);
  assert.match(blocked.reason, /detection is unavailable/);

  const dry = planPrune(snapshots, "/elsewhere", null, { dryRun: true });
  assert.equal(dry.blocked, false);
  assert.equal(dry.available, false);
  assert.deepEqual(dry.remove.map((s) => s.nonce), ["1", "2"]);

  const forced = planPrune(snapshots, "/elsewhere", null, { force: true });
  assert.equal(forced.blocked, false);
  assert.equal(forced.forced, true);
  assert.deepEqual(forced.remove.map((s) => s.nonce), ["1", "2"]);

  const detected = planPrune(snapshots, "/elsewhere", ["/ap/file-x/2/nested"]);
  assert.equal(detected.available, true);
  assert.deepEqual(detected.remove.map((s) => s.nonce), ["1"]);
  assert.deepEqual(detected.inUse.map((p) => p.split("/").pop()), ["2"]);
});

// --- window-anchored in-use detection (roadmap step 7.1) ---

test("windowPinnedSnapshots pins the newest snapshot whose nonce is at or before each VS Code process start", () => {
  const snapshots = [
    { nonce: "1a14d7020a8", path: "/ap/file-x/1a14d7020a8" },
    { nonce: "1a16a70f607", path: "/ap/file-x/1a16a70f607" },
    { nonce: "1a18e5b18c2", path: "/ap/file-x/1a18e5b18c2" },
  ];
  const starts = [
    { pid: 10, comm: "code", kind: "window", startMs: parseInt("1a16a70f607", 16) + 5000 }, // after B, before C -> B
    { pid: 11, comm: "code", kind: "extensionHost", startMs: parseInt("1a18e5b18c2", 16) + 1 }, // after C -> C
    { pid: 12, comm: "code", kind: "process", startMs: parseInt("1a14d7020a8", 16) - 1 }, // before A -> nothing
  ];
  const pinned = windowPinnedSnapshots(snapshots, { scan: () => starts });
  assert.deepEqual(
    pinned.map((entry) => [entry.pid, entry.nonce]),
    [
      [10, "1a16a70f607"],
      [11, "1a18e5b18c2"],
    ],
  );
  assert.equal(windowPinnedSnapshots(snapshots, { scan: () => null }), null);
  assert.deepEqual(windowPinnedSnapshots([], { scan: () => starts }), []);
});

test("detectInUse combines the path scan and the window anchor; available only when the process list is readable", () => {
  const snapshots = [
    { nonce: "1a14d7020a8", path: "/ap/file-x/1a14d7020a8" },
    { nonce: "1a18e5b18c2", path: "/ap/file-x/1a18e5b18c2" },
  ];
  const startMs = parseInt("1a18e5b18c2", 16) + 1;
  const windows = [{ pid: 10, comm: "code", kind: "window", startMs }];
  const result = detectInUse(snapshots, {
    scan: () => new Set(["/ap/file-x/1a14d7020a8/scripts/hooks/session-context.sh"]),
    windowScan: () => windows,
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.inUse.sort(), ["/ap/file-x/1a14d7020a8", "/ap/file-x/1a18e5b18c2"]);
  assert.deepEqual(Object.keys(result.usedBy), ["/ap/file-x/1a18e5b18c2"]);
  assert.deepEqual(result.usedBy["/ap/file-x/1a18e5b18c2"], [{ pid: 10, comm: "code", kind: "window", startMs }]);

  const unavailable = detectInUse(snapshots, { scan: () => null, windowScan: () => null });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.inUse, []);
  assert.deepEqual(unavailable.usedBy, {});
});

test("plugin snapshots and prune-snapshots on a fixture agentPlugins tree", () => {
  const repo = makeRepo();
  const root = tmp();
  const agents = path.join(root, "agentPlugins");
  const locationDir = path.join(agents, "file-home-david-DP-agento-plugin");
  const otherDir = path.join(agents, "file-somewhere-else");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "keep.txt"), "other location\n");
  fs.writeFileSync(path.join(agents, "cache.json"), "[]");
  const write = (nonce, text) => {
    fs.mkdirSync(path.join(locationDir, nonce), { recursive: true });
    fs.writeFileSync(path.join(locationDir, nonce, "file.txt"), text);
  };
  write("1a14d7020a8", "old".repeat(2048));
  write("1a16a70f607", "middle".repeat(2048));
  write("1a18e5b18c2", "newest".repeat(2048));
  fs.mkdirSync(path.join(locationDir, "not-hex"), { recursive: true });
  fs.writeFileSync(path.join(locationDir, "not-hex", "keep.txt"), "non-hex\n");
  const env = { ...baseEnv, AGENTO_VSCODE_AGENT_PLUGINS: agents };

  const list = runWith({ cwd: repo, env }, "plugin", "snapshots", "--dest", "/home/david/DP/agento-plugin");
  assert.equal(list.code, 0, JSON.stringify(list.json));
  assert.equal(list.json.count, 3);
  assert.equal(list.json.newest, "1a18e5b18c2");
  assert.deepEqual(list.json.snapshots.map((s) => s.nonce), ["1a14d7020a8", "1a16a70f607", "1a18e5b18c2"]);
  assert.ok(list.json.total > 0);

  const dry = runWith({ cwd: repo, env }, "plugin", "prune-snapshots", "--dest", "/home/david/DP/agento-plugin", "--dry-run");
  assert.equal(dry.code, 0, JSON.stringify(dry.json));
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.inUseDetection, true);
  assert.deepEqual(dry.json.inUse, []);
  assert.deepEqual(dry.json.removed, []);
  assert.deepEqual(dry.json.wouldRemove.sort(), ["1a14d7020a8", "1a16a70f607"]);
  assert.ok(dry.json.freedBytes > 0);
  assert.ok(fs.existsSync(path.join(locationDir, "1a14d7020a8")), "dry-run deletes nothing");

  const prune = runWith({ cwd: repo, env }, "plugin", "prune-snapshots", "--dest", "/home/david/DP/agento-plugin");
  assert.equal(prune.code, 0, JSON.stringify(prune.json));
  assert.deepEqual(prune.json.removed.sort(), ["1a14d7020a8", "1a16a70f607"]);
  assert.ok(fs.existsSync(path.join(locationDir, "1a18e5b18c2")), "newest kept");
  assert.ok(fs.existsSync(path.join(locationDir, "not-hex", "keep.txt")), "non-hex name untouched");
  assert.ok(fs.existsSync(path.join(agents, "cache.json")), "cache.json untouched");
  assert.ok(fs.existsSync(path.join(otherDir, "keep.txt")), "other location untouched");

  const after = runWith({ cwd: repo, env }, "plugin", "snapshots", "--dest", "/home/david/DP/agento-plugin");
  assert.equal(after.json.count, 1);
  assert.equal(after.json.newest, "1a18e5b18c2");

  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("plugin export lists files with no prior pin under unpinned", () => {
  const template = makePluginTemplate({ planner: PLANNER, builder: BUILDER });
  const oldDest = cloneOf(template);
  // A new agent added to the release after the clone was made.
  fs.writeFileSync(path.join(template, ".github", "agents", "reviewer.agent.md"), REVIEWER);
  git(template, "add", "-A");
  git(template, "commit", "-q", "-m", "add reviewer");
  git(template, "push", "-q", "origin", "main");

  const home = path.join(os.tmpdir(), `agento-home-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const env = { ...baseEnv, AGENTO_CONFIG_HOME: home };
  pinProfile(env);
  applyPins(oldDest, ["planner", "builder"]);

  const exp = runWith({ cwd: template, env }, "plugin", "export", "--source", template, "--dest", oldDest, "--replace-clone");
  assert.equal(exp.code, 0, JSON.stringify(exp.json));
  assert.deepEqual(exp.json.unpinned, [".github/agents/reviewer.agent.md"]);
  assert.deepEqual(exp.json.carriedPins.sort(), [".github/agents/builder.agent.md", ".github/agents/planner.agent.md"]);

  fs.rmSync(path.dirname(template), { recursive: true, force: true });
  fs.rmSync(oldDest, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
