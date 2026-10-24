import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openWindows, parseJsonc, runningNames, storedWindows, vscodeUserDir, windowFor, workspaceFolders } from "./vscode-windows.mjs";

const STATUS = `Version:          Code 1.106.0
Window (Agento Mission Control (127.0.0.1:3117) - freehand-20261024-173037 (Workspace) - Visual Studio Code)
|  Window (agento (Workspace) - Visual Studio Code)
|  Window (Agento Mission Control (127.0.0.1:3117) - freehand-20261024-173037 (Workspace) - Visual Studio Code)
|  Window (notes.md - scratch - Visual Studio Code)
|    Folder (agento): 1805 files
|    Folder (agento-docs): 524 files
|    Folder (freehand-20261024-173037): 566 files
|    Folder (scratch): 12 files
`;

function storage(entries) {
  return JSON.stringify({ windowsState: { lastActiveWindow: entries[0], openedWindows: entries } });
}

test("vscodeUserDir honors the override and platform defaults", () => {
  assert.equal(vscodeUserDir({ AGENTO_VSCODE_USER_DIR: "/x" }, "/h", "linux"), "/x");
  assert.equal(vscodeUserDir({}, "/h", "linux"), "/h/.config/Code/User");
  assert.equal(vscodeUserDir({ XDG_CONFIG_HOME: "/cfg" }, "/h", "linux"), "/cfg/Code/User");
  assert.equal(vscodeUserDir({}, "/h", "darwin"), "/h/Library/Application Support/Code/User");
});

test("storedWindows reads workspace and folder windows, local files only, de-duplicated", () => {
  const text = storage([
    { workspaceIdentifier: { id: "a", configURIPath: "file:///home/u/DP/agento.code-workspace" } },
    { folder: "file:///home/u/scratch" },
    { workspaceIdentifier: { id: "a", configURIPath: "file:///home/u/DP/agento.code-workspace" } },
    { folder: "vscode-remote://ssh-remote+box/home/u/remote" },
    {},
  ]);
  assert.deepEqual(storedWindows(text), [
    { kind: "workspace", path: "/home/u/DP/agento.code-workspace" },
    { kind: "folder", path: "/home/u/scratch" },
  ]);
  assert.deepEqual(storedWindows("not json"), []);
});

test("runningNames parses workspace titles and folder lines", () => {
  const names = runningNames(STATUS);
  assert.deepEqual([...names.workspaces].sort(), ["agento", "freehand-20261024-173037"]);
  assert.ok(names.folders.has("scratch") && names.folders.has("agento-docs"));
});

test("parseJsonc accepts comments and trailing commas but keeps // inside strings", () => {
  assert.deepEqual(parseJsonc('{\n // c\n "folders": [{ "path": "a//b" }, /* x */],\n}'), { folders: [{ path: "a//b" }] });
});

test("workspaceFolders resolves relative paths against the file", () => {
  const files = { "/w/agento.code-workspace": '{ "folders": [{ "path": "agento" }, { "path": "/abs/docs" }] }' };
  assert.deepEqual(workspaceFolders("/w/agento.code-workspace", (p) => files[p]), ["/w/agento", "/abs/docs"]);
  assert.deepEqual(workspaceFolders("/missing", () => { throw new Error("ENOENT"); }), []);
});

test("openWindows keeps only running windows and windowFor picks the window holding a checkout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-windows-"));
  const primaryWs = path.join(dir, "agento.code-workspace");
  const freehandWs = path.join(dir, "freehand-20261024-173037.code-workspace");
  const closedWs = path.join(dir, "plan-1.code-workspace");
  fs.writeFileSync(primaryWs, JSON.stringify({ folders: [{ path: "agento" }, { path: "agento-docs" }, { path: "shared" }] }));
  fs.writeFileSync(freehandWs, JSON.stringify({ folders: [{ path: path.join(dir, "wt", "freehand-20261024-173037") }] }));
  fs.writeFileSync(closedWs, JSON.stringify({ folders: [{ path: "plan-1" }] }));
  const storageText = storage([
    { workspaceIdentifier: { configURIPath: `file://${primaryWs}` } },
    { workspaceIdentifier: { configURIPath: `file://${freehandWs}` } },
    { workspaceIdentifier: { configURIPath: `file://${closedWs}` } },
    { folder: `file://${path.join(dir, "scratch")}` },
  ]);
  const windows = openWindows({ storageText, statusText: STATUS });
  assert.deepEqual(windows.map((w) => path.basename(w.path)), ["agento.code-workspace", "freehand-20261024-173037.code-workspace", "scratch"], "the stale plan-1 window is not running");

  assert.deepEqual(windowFor(path.join(dir, "agento"), windows), { open: true, target: primaryWs, kind: "workspace" });
  assert.deepEqual(windowFor(path.join(dir, "wt", "freehand-20261024-173037"), windows, freehandWs), { open: true, target: freehandWs, kind: "workspace" });
  assert.deepEqual(windowFor(path.join(dir, "plan-1"), windows, closedWs), { open: false, target: closedWs, kind: "workspace" });
  assert.deepEqual(windowFor(path.join(dir, "elsewhere"), windows), { open: false, target: path.join(dir, "elsewhere"), kind: "folder" });
});

test("windowFor prefers the window whose first folder is the checkout", () => {
  const windows = [
    { kind: "workspace", path: "/w/agento.code-workspace", folders: ["/w/agento", "/w/soshiki"] },
    { kind: "workspace", path: "/w/soshiki.code-workspace", folders: ["/w/soshiki", "/w/soshiki-docs"] },
  ];
  assert.equal(windowFor("/w/soshiki", windows).target, "/w/soshiki.code-workspace");
});
