import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(import.meta.dirname, "../../..");
  const extensionTestsPath = path.join(import.meta.dirname, "suite.js");
  const sourceFixture = path.join(extensionDevelopmentPath, "test", "fixtures", "workspace");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "agento-extension-electron-"));

  try {
    await cp(sourceFixture, fixture, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture });
    execFileSync("git", ["-c", "user.name=Agento Test", "-c", "user.email=agento@example.invalid", "commit", "-m", "fixture"], { cwd: fixture });
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: "1.125.0",
      launchArgs: [fixture, "--disable-extensions"],
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});