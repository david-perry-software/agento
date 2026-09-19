import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCliArgs, CliClient, CliError, CliParseError, parseCliOutput } from "../../src/cliClient.js";

const extensionRoot = process.cwd();
const cliPath = path.join(extensionRoot, "cli", "agento.mjs");
const output = { appendLine() {} };

test("buildCliArgs appends the checkout root", () => {
  assert.deepEqual(buildCliArgs("cli.mjs", ["session"], "/repo"), ["cli.mjs", "session", "--root", "/repo"]);
  assert.throws(() => buildCliArgs("cli.mjs", ["session", "--root"], "/repo"), CliError);
});

test("parseCliOutput parses JSON and rejects non-JSON with an excerpt", () => {
  assert.deepEqual(parseCliOutput('{"status":"ok"}'), { status: "ok" });
  assert.throws(() => parseCliOutput("not json"), (error) => error instanceof CliParseError && error.message.includes("not json"));
});

test("CliClient resolves usable JSON for exit 0 and exit 3", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agento-cli-client-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".github"), { recursive: true });
  await writeFile(
    path.join(root, ".github", "agento.json"),
    JSON.stringify({ artifacts: { features: "features", issues: "issues", initiatives: "initiatives", repo: { name: null, dir: null } } }),
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: root });

  const client = new CliClient({ nodePath: process.execPath, cliPath, output });
  const session = await client.run(["session"], root);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  const missing = await client.run(["find", "nope"], root);
  assert.equal(missing.code, 3);
  assert.equal((missing.json as { status?: unknown }).status, "missing");
});

test("CliClient rejects malformed output with CliParseError", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agento-cli-output-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "invalid.mjs");
  await writeFile(script, 'process.stdout.write("not json")');
  const client = new CliClient({ nodePath: process.execPath, cliPath: script, output });
  await assert.rejects(client.run([], root), CliParseError);
});

test("CliClient names agento.nodePath when spawning fails", async () => {
  const client = new CliClient({ nodePath: "/missing/node", cliPath, output });
  await assert.rejects(client.run(["session"], extensionRoot), (error) => error instanceof CliError && error.message.includes("agento.nodePath"));
});