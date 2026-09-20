import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";

interface ExtensionManifest {
  name: string;
  publisher: string;
  version: string;
}

function initRepository(directory: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["-c", "user.name=Agento Test", "-c", "user.email=agento@example.invalid", "commit", "-m", "fixture"], { cwd: directory });
}

async function assertRemoved(directory: string): Promise<void> {
  try {
    await access(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Temporary VSIX profile was not removed: ${directory}`);
}

async function main(): Promise<void> {
  const extensionRoot = path.resolve(import.meta.dirname, "../../..");
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, "package.json"), "utf8")) as ExtensionManifest;
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const vsixPath = path.join(extensionRoot, `${manifest.name}-${manifest.version}.vsix`);
  const cleanup = await mkdtemp(path.join(os.tmpdir(), "agento-vsix-"));
  const userDataDir = path.join(cleanup, "user-data");
  const extensionsDir = path.join(cleanup, "extensions");
  const workspace = path.join(cleanup, "workspace");

  try {
    await mkdir(userDataDir, { recursive: true });
    await mkdir(extensionsDir, { recursive: true });
    await cp(path.join(extensionRoot, "test", "fixtures", "workspace"), workspace, { recursive: true });
    initRepository(workspace);

    const vscodeExecutablePath = await downloadAndUnzipVSCode("1.125.0");
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const isolatedCliArgs = cliArgs.filter((argument) => !argument.startsWith("--user-data-dir=") && !argument.startsWith("--extensions-dir="));
    execFileSync(cli!, [
      ...isolatedCliArgs,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      "--install-extension",
      vsixPath,
      "--force",
    ], { stdio: "inherit", timeout: 60_000 });

    const installedName = (await readdir(extensionsDir)).find((entry) => entry.startsWith(`${extensionId}-`));
    assert.ok(installedName, `${extensionId} was not installed into the isolated extensions directory`);
    const installedPath = await realpath(path.join(extensionsDir, installedName));
    const installedManifest = JSON.parse(await readFile(path.join(installedPath, "package.json"), "utf8")) as ExtensionManifest;
    assert.equal(installedManifest.version, manifest.version);

    execFileSync(vscodeExecutablePath, [
      workspace,
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--extensionDevelopmentPath=${installedPath}`,
      `--extensionTestsPath=${path.join(import.meta.dirname, "suite.js")}`,
    ], {
      env: { ...process.env, AGENTO_EXPECTED_EXTENSION_PATH: installedPath },
      stdio: "inherit",
      timeout: 120_000,
    });

    console.log(`VSIX install smoke passed: ${path.basename(vsixPath)} activated from an isolated profile`);
  } finally {
    await rm(cleanup, { recursive: true, force: true });
    await assertRemoved(cleanup);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});