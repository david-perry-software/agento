import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultCodeStatus, findOccupants, isMissionControlHost, stopOrphanSdkHosts } from "./worktree-occupants.mjs";

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const noCode = () => "";

// A fake /proc: each entry is [pid, cwd, comm|null, cmdline?, environ?]; comm null
// leaves the file out; cmdline (array) and environ (object) are written NUL-separated.
function fakeProc(entries) {
  const dir = tmp("agento-proc-");
  for (const [pid, cwd, comm, cmdline, environ] of entries) {
    fs.mkdirSync(path.join(dir, pid));
    fs.symlinkSync(cwd, path.join(dir, pid, "cwd"));
    if (comm !== null) fs.writeFileSync(path.join(dir, pid, "comm"), `${comm}\n`);
    if (cmdline !== undefined) fs.writeFileSync(path.join(dir, pid, "cmdline"), cmdline.join("\0"));
    if (environ !== undefined) {
      fs.writeFileSync(path.join(dir, pid, "environ"), Object.entries(environ).map(([key, value]) => `${key}=${value}`).join("\0"));
    }
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

test("findOccupants names an orphaned Copilot SDK extension host instead of an anonymous (code) (#143 sdk-host-blocks-teardown)", () => {
  const procDir = fakeProc([
    ["402", TARGET, "sh"],
    ["403", TARGET, "sh"],
    ["404", TARGET, "sh"],
    ["405", TARGET, "sh"],
    ["401", TARGET, "code",
      ["/usr/share/code/code", "/x/copilot-sdk-linux-x64/preloads/extension_bootstrap.mjs"],
      { SESSION_ID: "e927bde1-9912-4cab-bb3c-7a245a38e240", EXTENSION_PATH: "/home/u/.copilot/extensions/agento-mission-control/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "999", GITHUB_TOKEN: "planted-secret-must-not-appear" },
    ],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.equal(result.details[0], "PID 401 (Copilot SDK extension host: agento-mission-control, session e927bde1)");
  assert.deepEqual(result.sdkHosts, [{ pid: 401, sessionId: "e927bde1-9912-4cab-bb3c-7a245a38e240", extensionPath: "/home/u/.copilot/extensions/agento-mission-control/extension.mjs", extension: "agento-mission-control", parentPid: 999 }]);
  assert.ok(!JSON.stringify(result).includes("planted-secret"));
});

test("findOccupants: a host running as node (comm node) is still classified as an SDK host", () => {
  const procDir = fakeProc([
    ["501", TARGET, "node", ["/usr/bin/node", "/x/preloads/extension_bootstrap.mjs"], { SESSION_ID: "abc12345-session", EXTENSION_PATH: "/e/agento-mission-control/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "7" }],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.deepEqual(result.sdkHosts, [{ pid: 501, sessionId: "abc12345-session", extensionPath: "/e/agento-mission-control/extension.mjs", extension: "agento-mission-control", parentPid: 7 }]);
  assert.equal(result.details[0], "PID 501 (Copilot SDK extension host: agento-mission-control, session abc12345)");
});

test("findOccupants: an SDK host without EXTENSION_PATH is labelled extension unknown", () => {
  const procDir = fakeProc([
    ["502", TARGET, "code", ["/usr/share/code/code", "/x/preloads/extension_bootstrap.mjs"], { SESSION_ID: "xyz98765-session", COPILOT_EXTENSION_PARENT_PID: "8" }],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.deepEqual(result.sdkHosts, [{ pid: 502, sessionId: "xyz98765-session", extensionPath: "", extension: "unknown", parentPid: 8 }]);
  assert.equal(result.details[0], "PID 502 (Copilot SDK extension host: unknown, session xyz98765)");
});

test("findOccupants: a non-host process's environ is never read (a planted token never appears)", () => {
  const procDir = fakeProc([
    ["503", TARGET, "bash", ["/bin/bash"], { GITHUB_TOKEN: "planted-secret-must-not-appear" }],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.equal(result.sdkHosts, undefined);
  assert.deepEqual(result.processes, ["PID 503 (bash)"]);
  assert.ok(!JSON.stringify(result).includes("planted-secret"));
});

test("findOccupants: an SDK host outside the target is ignored", () => {
  const procDir = fakeProc([
    ["504", "/elsewhere", "code", ["/usr/share/code/code", "/x/preloads/extension_bootstrap.mjs"], { SESSION_ID: "outside-session", EXTENSION_PATH: "/e/agento-mission-control/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "9" }],
  ]);
  const result = findOccupants(TARGET, { procDir, codeStatus: noCode });
  assert.equal(result.sdkHosts, undefined);
  assert.deepEqual(result.processes, []);
});

test("isMissionControlHost: true only for the agento-mission-control extension path", () => {
  assert.equal(isMissionControlHost({ extensionPath: "/home/u/.copilot/extensions/agento-mission-control/extension.mjs" }), true);
  assert.equal(isMissionControlHost({ extensionPath: "/home/u/.copilot/extensions/other-ext/extension.mjs" }), false);
  assert.equal(isMissionControlHost({ extensionPath: "/home/u/.copilot/extensions/agento-mission-control/not-extension.mjs" }), false);
  assert.equal(isMissionControlHost({ extensionPath: "" }), false);
});

const SDK_HOST_ENTRY = (pid, environ) => [pid, TARGET, "code", ["/usr/share/code/code", "/x/copilot-sdk-linux-x64/preloads/extension_bootstrap.mjs"], environ];
const MC_ENVIRON = { SESSION_ID: "orphan-0001", EXTENSION_PATH: "/home/u/.copilot/extensions/agento-mission-control/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "10" };

test("stopOrphanSdkHosts: an orphaned Mission Control host is signalled once with SIGTERM and reported stopped", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("601", MC_ENVIRON)]);
  const calls = [];
  const result = stopOrphanSdkHosts(TARGET, {
    procDir,
    codeStatus: noCode,
    callerSessionId: "caller",
    signal: (pid, sig) => {
      calls.push([pid, sig]);
      fs.rmSync(path.join(procDir, String(pid)), { recursive: true });
    },
  });
  assert.deepEqual(calls, [[601, "SIGTERM"]]);
  assert.deepEqual(result.stopped.map((h) => h.pid), [601]);
  assert.deepEqual(result.skipped, []);
});

test("stopOrphanSdkHosts: a matching VS Code folder or workspace window skips every host as window-open", () => {
  for (const status of ["|    Folder (plan-20261009-182342): 12 files", "|  Workspace (plan-20261009-182342)"]) {
    const procDir = fakeProc([SDK_HOST_ENTRY("602", MC_ENVIRON)]);
    const calls = [];
    const result = stopOrphanSdkHosts(TARGET, { procDir, codeStatus: () => status, callerSessionId: "caller", signal: (pid, sig) => calls.push([pid, sig]) });
    assert.deepEqual(calls, [], status);
    assert.equal(result.stopped.length, 0, status);
    assert.equal(result.skipped.length, 1, status);
    assert.equal(result.skipped[0].reason, "window-open", status);
  }
});

test("stopOrphanSdkHosts: the calling session's own host is skipped", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("603", MC_ENVIRON)]);
  const calls = [];
  const result = stopOrphanSdkHosts(TARGET, { procDir, codeStatus: noCode, callerSessionId: "orphan-0001", signal: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(calls, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.skipped[0].reason, "calling-session");
});

test("stopOrphanSdkHosts: a foreign extension host is skipped and never signalled", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("604", { SESSION_ID: "orphan-0002", EXTENSION_PATH: "/home/u/.copilot/extensions/other-ext/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "11" })]);
  const calls = [];
  const result = stopOrphanSdkHosts(TARGET, { procDir, codeStatus: noCode, callerSessionId: "caller", signal: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(calls, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.skipped[0].reason, "foreign-extension");
});

test("stopOrphanSdkHosts: a host whose SESSION_ID changed between scan and signal is skipped as changed", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("605", { SESSION_ID: "session-a", EXTENSION_PATH: "/home/u/.copilot/extensions/agento-mission-control/extension.mjs", COPILOT_EXTENSION_PARENT_PID: "12" })]);
  const calls = [];
  const result = stopOrphanSdkHosts(TARGET, {
    procDir,
    codeStatus: () => {
      fs.writeFileSync(path.join(procDir, "605", "environ"), "SESSION_ID=session-b\0EXTENSION_PATH=/home/u/.copilot/extensions/agento-mission-control/extension.mjs\0COPILOT_EXTENSION_PARENT_PID=12\0");
      return "";
    },
    callerSessionId: "caller",
    signal: (pid, sig) => calls.push([pid, sig]),
  });
  assert.deepEqual(calls, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.skipped[0].reason, "changed");
});

test("stopOrphanSdkHosts: dryRun reports would-stop and sends no signal", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("606", MC_ENVIRON)]);
  const calls = [];
  const result = stopOrphanSdkHosts(TARGET, { procDir, codeStatus: noCode, callerSessionId: "caller", dryRun: true, signal: (pid, sig) => calls.push([pid, sig]) });
  assert.deepEqual(calls, []);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.skipped[0].reason, "would-stop");
});

test("stopOrphanSdkHosts: a survivor after waitMs is reported still-running", () => {
  const procDir = fakeProc([SDK_HOST_ENTRY("607", MC_ENVIRON)]);
  const calls = [];
  const started = Date.now();
  const result = stopOrphanSdkHosts(TARGET, {
    procDir,
    codeStatus: noCode,
    callerSessionId: "caller",
    signal: (pid, sig) => calls.push([pid, sig]),
    waitMs: 50,
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(calls, [[607, "SIGTERM"]]);
  assert.equal(result.stopped.length, 0);
  assert.equal(result.skipped[0].reason, "still-running");
  assert.ok(elapsed < 1000, `elapsed ${elapsed}ms`);
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

test("findOccupants: a live child process inside the target appears, then disappears after it exits", { skip: process.platform !== "linux" && "the /proc scan is Linux-only" }, async () => {
  const dir = tmp("agento-live-");
  const child = spawn("sleep", ["30"], { cwd: path.join(dir), stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const during = findOccupants(dir, { codeStatus: noCode });
  assert.ok(during.processes.includes(`PID ${child.pid} (sleep)`), during.processes.join(", "));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
  const after = findOccupants(dir, { codeStatus: noCode });
  assert.ok(!after.processes.some((p) => p.startsWith(`PID ${child.pid} `)), after.processes.join(", "));
});
