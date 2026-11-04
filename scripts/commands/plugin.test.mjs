import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentPluginsDir,
  expandHome,
  listSnapshots,
  pluginLocations,
  snapshotDirName,
  vscodeSettingsPath,
} from "../lib/plugin.mjs";
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
