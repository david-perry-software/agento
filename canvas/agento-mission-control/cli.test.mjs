import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { CliError, cloneRoot, runArtifacts, runDashboard, runHandoff, runWindows } from "./cli.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agento-cli-"));
}

function writeStub(dir, body) {
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, body);
  return file;
}

const stubJson = (value) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});\n`;
const stubEchoArgs = () => `process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));\n`;

test("cloneRoot resolves the repo root two levels up", () => {
  const root = cloneRoot();
  assert.ok(fs.existsSync(path.join(root, "scripts", "agento.mjs")), "cloneRoot does not point at the repo root");
});

test("cloneRoot prefers the stamp clone in stamped-copy mode", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".agento-stamp.json"), JSON.stringify({ format: "agento-mission-control", version: 1, clone: "/stamped/clone", sha256: "x" }));
  const marker = path.join(dir, "anything.mjs");
  fs.writeFileSync(marker, "");
  assert.equal(cloneRoot(pathToFileURL(marker).href), "/stamped/clone");
});

test("runDashboard parses JSON and passes the dashboard argument", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, stubJson({ ok: true, deliveries: [] }));
  const out = await runDashboard({ script });
  assert.deepEqual(out, { ok: true, deliveries: [] });
});

test("runDashboard adds --pr only when requested", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, stubEchoArgs());
  assert.deepEqual((await runDashboard({ script })).args, ["dashboard"]);
  assert.deepEqual((await runDashboard({ script, pr: true })).args, ["dashboard", "--pr"]);
});

test("runDashboard maps a non-zero exit to CliError exit", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, `process.stderr.write("boom\\n"); process.exit(3);\n`);
  await assert.rejects(runDashboard({ script }), (err) => err instanceof CliError && err.code === "exit" && /boom/.test(err.message));
});

test("runDashboard maps a timeout to CliError timeout", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, `setTimeout(() => process.stdout.write("{}"), 2000);\n`);
  await assert.rejects(runDashboard({ script, timeoutMs: 200 }), (err) => err instanceof CliError && err.code === "timeout");
});

test("runDashboard maps invalid JSON to CliError parse", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, `process.stdout.write("not json");\n`);
  await assert.rejects(runDashboard({ script }), (err) => err instanceof CliError && err.code === "parse");
});

test("runDashboard maps a missing executable to CliError spawn", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, stubJson({}));
  await assert.rejects(runDashboard({ script, executable: "/no/such/node-binary" }), (err) => err instanceof CliError && err.code === "spawn");
});

test("concurrent identical calls coalesce into one invocation", async () => {
  const dir = tmpdir();
  const counter = path.join(dir, "count.txt");
  fs.writeFileSync(counter, "");
  const script = writeStub(
    dir,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x\\n"); await new Promise((r) => setTimeout(r, 150)); process.stdout.write(JSON.stringify({ done: true }));`,
  );
  const [a, b] = await Promise.all([runDashboard({ script }), runDashboard({ script })]);
  assert.deepEqual(a, { done: true });
  assert.equal(b, a);
  assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 1, "expected a single coalesced invocation");
});

test("different --pr requests do not coalesce with each other", async () => {
  const dir = tmpdir();
  const counter = path.join(dir, "count.txt");
  fs.writeFileSync(counter, "");
  const script = writeStub(
    dir,
    `import fs from "node:fs"; fs.appendFileSync(${JSON.stringify(counter)}, "x\\n"); process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));`,
  );
  const [noPr, withPr] = await Promise.all([runDashboard({ script }), runDashboard({ script, pr: true })]);
  assert.deepEqual(noPr.args, ["dashboard"]);
  assert.deepEqual(withPr.args, ["dashboard", "--pr"]);
  assert.equal(fs.readFileSync(counter, "utf8").trim().split("\n").length, 2);
});

test("runWindows passes the checkouts and returns the windows list", async () => {
  const dir = tmpdir();
  const script = writeStub(dir, `const a = process.argv.slice(2); process.stdout.write(JSON.stringify({ status: "ok", windows: a.slice(1).map((c) => ({ checkout: c, open: a[0] === "windows" })) }));\n`);
  assert.deepEqual(await runWindows(["/a", "/b"], { script }), [{ checkout: "/a", open: true }, { checkout: "/b", open: true }]);
});

test("runHandoff passes checkout and command as two arguments and resolves a refusal's JSON on exit 3", async () => {
  const dir = tmpdir();
  const ok = writeStub(dir, stubEchoArgs());
  assert.deepEqual(await runHandoff({ checkout: "/repo", command: "/agento ship widget" }, { script: ok }), { args: ["handoff", "/repo", "/agento ship widget"] });

  const refusing = path.join(dir, "refuse.mjs");
  fs.writeFileSync(refusing, `process.stdout.write(JSON.stringify({ status: "failed", reason: "code CLI not found on PATH" })); process.exitCode = 3;\n`);
  assert.deepEqual(await runHandoff({ checkout: "/repo", command: "/agento ship widget" }, { script: refusing }), { status: "failed", reason: "code CLI not found on PATH" });

  const crashing = path.join(dir, "crash.mjs");
  fs.writeFileSync(crashing, `process.stderr.write("boom"); process.exitCode = 1;\n`);
  await assert.rejects(() => runHandoff({ checkout: "/repo", command: "/agento ship widget" }, { script: crashing }), (err) => err instanceof CliError && err.code === "exit" && /handoff exited 1: boom/.test(err.message));
});

test("runArtifacts passes type and slug and resolves a missing delivery's JSON on exit 3", async () => {
  const dir = tmpdir();
  assert.deepEqual(await runArtifacts({ type: "issue", slug: "bug" }, { script: writeStub(dir, stubEchoArgs()) }), { args: ["artifacts", "issue", "bug"] });
  const missing = path.join(dir, "missing.mjs");
  fs.writeFileSync(missing, `process.stdout.write(JSON.stringify({ status: "missing" })); process.exitCode = 3;\n`);
  assert.deepEqual(await runArtifacts({ type: "feature", slug: "x" }, { script: missing }), { status: "missing" });
});
