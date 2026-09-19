import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
}

async function writeDeliveries(root: string): Promise<void> {
  const fixtures = [
    { slug: "planned-delivery", status: "planned", ticked: 1, total: 3 },
    { slug: "building-delivery", status: "in-progress", ticked: 2, total: 4 },
  ];
  for (const fixture of fixtures) {
    const directory = path.join(root, "features", "2026", "09", fixture.slug);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "roadmap.md"), roadmap(fixture.slug, fixture.status, fixture.ticked, fixture.total));
  }
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
  }
  initRepository(workspace);
  return { name, workspace, cleanup, bin };
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
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});