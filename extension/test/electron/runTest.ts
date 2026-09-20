import { execFileSync } from "node:child_process";
import { access, chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runTests } from "@vscode/test-electron";

interface Scenario {
  name: "in-repo" | "companion";
  workspace: string;
  cleanup: string;
  bin: string;
}

const roadmap = (slug: string, status: string, ticked: number, total: number) => `\`\`\`yaml
status: ${status}
branch: feature/${slug}
last-updated: 2026-09-19
next-step: "Fixture step"
initiative: "agento-extension"
\`\`\`

## Phase 1: Fixture

${Array.from({ length: total }, (_, index) => `- [${index < ticked ? "x" : " "}] 1.${index + 1} Fixture step`).join("\n")}
`;

function initRepository(directory: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["-c", "user.name=Agento Test", "-c", "user.email=agento@example.invalid", "commit", "-m", "fixture"], { cwd: directory });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: directory });
  execFileSync("git", ["update-ref", "refs/remotes/origin/feature/anomalous-delivery", head], { cwd: directory });
}

async function writeDeliveries(root: string): Promise<void> {
  const fixtures = [
    { slug: "planned-delivery", status: "planned", ticked: 1, total: 3 },
    { slug: "building-delivery", status: "in-progress", ticked: 2, total: 4 },
    { slug: "anomalous-delivery", status: "in-review", ticked: 2, total: 2 },
    { slug: "complete-delivery", status: "complete", ticked: 1, total: 1 },
  ];
  for (const fixture of fixtures) {
    const directory = path.join(root, "features", "2026", "09", fixture.slug);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "roadmap.md"), roadmap(fixture.slug, fixture.status, fixture.ticked, fixture.total));
  }
  await mkdir(path.join(root, "features", "2026", "09", "x"), { recursive: true });
}

async function writeInitiative(root: string): Promise<void> {
  const directory = path.join(root, "initiatives", "2026", "09", "agento-extension");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "breakdown.md"),
    `\`\`\`yaml
initiative: agento-extension
created: 2026-09-01
last-updated: 2026-09-19
\`\`\`

# Agento Extension

## Goal

Exercise the Initiatives tree.

## Features

### ready-delivery
- Summary: Ready work
- Requires: none
- Recommended after: none
- Wave: 1
- Size: S

### planned-delivery
- Summary: Planned work
- Requires: none
- Recommended after: none
- Wave: 1
- Size: S

### building-delivery
- Summary: Active work
- Requires: none
- Recommended after: planned-delivery
- Wave: 1
- Size: S

### anomalous-delivery
- Summary: Merged active work
- Requires: none
- Recommended after: building-delivery
- Wave: 1
- Size: S

### blocked-delivery
- Summary: Blocked work
- Requires: building-delivery
- Recommended after: none
- Wave: 2
- Size: S

### complete-delivery
- Summary: Complete work
- Requires: none
- Recommended after: none
- Wave: 1
- Size: S

## Recommended order

Fixture order.
`,
  );
}

async function createGhStub(root: string): Promise<string> {
  const bin = path.join(root, "bin");
  const executable = path.join(bin, "gh");
  await mkdir(bin, { recursive: true });
  await writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version fixture"
  exit 0
fi
case "$PWD" in
  */artifacts) number=202 ;;
  *) number=101 ;;
esac
printf '{"number":%s,"state":"OPEN","isDraft":true,"mergeStateStatus":"CLEAN","url":"https://example.test/pr/%s"}\n' "$number" "$number"
`,
  );
  await chmod(executable, 0o755);
  return bin;
}

async function createScenario(sourceFixture: string, name: Scenario["name"]): Promise<Scenario> {
  const cleanup = await mkdtemp(path.join(os.tmpdir(), `agento-extension-${name}-`));
  const workspace = path.join(cleanup, "product");
  await cp(sourceFixture, workspace, { recursive: true });
  const bin = await createGhStub(cleanup);

  if (name === "companion") {
    const artifacts = path.join(cleanup, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeDeliveries(artifacts);
    await writeInitiative(artifacts);
    await writeFile(
      path.join(workspace, ".github", "agento.json"),
      JSON.stringify({
        artifacts: {
          features: "features",
          issues: "issues",
          initiatives: "initiatives",
          repo: { name: "artifacts", dir: "../artifacts" },
        },
        worktrees: { dir: null },
        branches: { default: "main", feature: "feature/", issue: "issue/", freehand: "changes/", postShip: "post-ship/" },
        checks: { releaseWorkflow: null },
      }),
    );
    initRepository(artifacts);
  } else {
    await writeDeliveries(workspace);
    await writeInitiative(workspace);
  }
  initRepository(workspace);
  return { name, workspace, cleanup, bin };
}

async function assertRemoved(directory: string): Promise<void> {
  try {
    await access(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Temporary Electron scenario was not removed: ${directory}`);
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(import.meta.dirname, "../../..");
  const extensionTestsPath = path.join(import.meta.dirname, "suite.js");
  const sourceFixture = path.join(extensionDevelopmentPath, "test", "fixtures", "workspace");
  for (const name of ["in-repo", "companion"] as const) {
    const scenario = await createScenario(sourceFixture, name);
    try {
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        version: "1.125.0",
        launchArgs: [scenario.workspace, "--disable-extensions"],
        extensionTestsEnv: {
          ...process.env,
          AGENTO_ELECTRON_SCENARIO: scenario.name,
          PATH: `${scenario.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });
    } finally {
      await rm(scenario.cleanup, { recursive: true, force: true });
      await assertRemoved(scenario.cleanup);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});