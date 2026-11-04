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
