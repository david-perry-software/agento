import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultCodeStatus, findOccupants } from "./worktree-occupants.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const noCode = () => "";

// A fake /proc: each entry is [pid, cwd, comm|null]; comm null leaves the file out.
function fakeProc(entries) {
  const dir = tmp("agento-proc-");
  for (const [pid, cwd, comm] of entries) {
    fs.mkdirSync(path.join(dir, pid));
    fs.symlinkSync(cwd, path.join(dir, pid, "cwd"));
    if (comm !== null) fs.writeFileSync(path.join(dir, pid, "comm"), `${comm}\n`);
  }
  fs.mkdirSync(path.join(dir, "self"));
  return dir;
}

const TARGET = "/work/repo-worktrees/plan-20261009-182342";

test("findOccupants: processes whose cwd is the target or under it, sanitised names, sibling prefixes ignored", () => {
  const procDir = fakeProc([
    ["101", TARGET, "bash"],
    ["102", `${TARGET}/src/deep`, "my proc!"],
    ["103", `${TARGET}0`, "node"],
    ["104", "/elsewhere", "vim"],
    ["105", TARGET, null],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.deepEqual(result.processes, ["PID 101 (bash)", "PID 102 (my?proc?)"]);
  assert.equal(result.folderWindow, false);
  assert.equal(result.workspaceWindow, false);
  assert.deepEqual(result.details, ["PID 101 (bash)", "PID 102 (my?proc?)"]);
});

test("findOccupants: at most three PIDs, then 'and N more processes'", () => {
  const procDir = fakeProc(["201", "202", "203", "204", "205"].map((pid) => [pid, TARGET, "sh"]));
  const { processes, details } = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.equal(processes.length, 5);
  assert.deepEqual(details, ["PID 201 (sh)", "PID 202 (sh)", "PID 203 (sh)", "and 2 more processes"]);
});

test("findOccupants: no occupants is an empty details list", () => {
  const procDir = fakeProc([["301", "/elsewhere", "bash"]]);
  assert.deepEqual(findOccupants(TARGET, { procDir, codeStatus: noCode }), { processes: [], folderWindow: false, workspaceWindow: false, details: [] });
});

test("findOccupants: code --status Folder line names the target's basename", () => {
  const status = ["Version:          Code 1.105.0", "|  Window (plan.md - plan-20261009-182342 - Visual Studio Code)", "|    Folder (plan-20261009-182342): 412 files", "|    Folder (other): 3 files"].join("\n");
  const result = findOccupants(TARGET, { procDir: fakeProc([]), codeStatus: () => status });
  assert.equal(result.folderWindow, true);
  assert.equal(result.workspaceWindow, false);
  assert.deepEqual(result.details, ["a matching VS Code folder"]);
});

test("findOccupants: Workspace (<name>) and Window (… <name> (Workspace)) forms both match", () => {
  for (const line of ["|  Workspace (plan-20261009-182342)", "|  Window (roadmap.md - plan-20261009-182342 (Workspace) - Visual Studio Code)"]) {
    const result = findOccupants(TARGET, { procDir: fakeProc([]), codeStatus: () => `Version: x\n${line}\n` });
    assert.equal(result.workspaceWindow, true, line);
    assert.deepEqual(result.details, ["a matching VS Code workspace window"], line);
  }
  const other = findOccupants(TARGET, { procDir: fakeProc([]), codeStatus: () => "|  Window (x - plan-20261009-999999 (Workspace) - Code)\n|    Folder (plan-2026): 1 files\n" });
  assert.deepEqual(other.details, []);
});

test("findOccupants: details order is PIDs, more, folder, workspace", () => {
  const procDir = fakeProc(["1", "2", "3", "4"].map((pid) => [pid, TARGET, "zsh"]));
  const status = "|    Folder (plan-20261009-182342): 1 files\n|  Workspace (plan-20261009-182342)\n";
  assert.deepEqual(findOccupants(TARGET, { procDir, codeStatus: () => status }).details, [
    "PID 1 (zsh)",
    "PID 2 (zsh)",
    "PID 3 (zsh)",
    "and 1 more processes",
    "a matching VS Code folder",
    "a matching VS Code workspace window",
  ]);
});

test("findOccupants: a non-Linux platform skips the process scan; a throwing codeStatus is no match", () => {
  const result = findOccupants(TARGET, { platform: "darwin", codeStatus: () => { throw new Error("boom"); } });
  assert.deepEqual(result, { processes: [], folderWindow: false, workspaceWindow: false, details: [] });
});

test("defaultCodeStatus: code missing is empty text; a nonzero exit keeps its stdout", (t) => {
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  const empty = tmp("agento-nocode-");
  process.env.PATH = empty;
  assert.equal(defaultCodeStatus(), "");
  const bin = tmp("agento-code-");
  fs.writeFileSync(path.join(bin, "code"), "#!/bin/sh\necho '|    Folder (x): 1 files'\nexit 1\n", { mode: 0o755 });
  process.env.PATH = bin;
  assert.equal(defaultCodeStatus(), "|    Folder (x): 1 files\n");
});
