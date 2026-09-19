import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";

async function waitForRoadmapRefresh(api: ExtensionApi, roadmap: vscode.Uri): Promise<void> {
  const observedReasons: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const refreshed = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        resolve(false);
      }, api.scheduler.debounceMs + 2000);
      const subscription = api.scheduler.onDidRefresh(({ reasons }) => {
        observedReasons.push(...reasons);
        if (!reasons.some((reason) => reason === `create ${roadmap.fsPath}` || reason === `change ${roadmap.fsPath}`)) {
          return;
        }
        clearTimeout(timeout);
        subscription.dispose();
        resolve(true);
      });
    });
    await vscode.workspace.fs.writeFile(roadmap, Buffer.from(`# Fixture ${attempt}\n`));
    if (await refreshed) {
      return;
    }
  }

  throw new Error(`Timed out waiting for roadmap refresh; observed: ${observedReasons.join(", ") || "none"}`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("david-perry-software.agento-dashboard");
  assert.ok(extension, "Agento extension is installed in the test host");
  const api = await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("agento.refresh"));
  assert.ok(commands.includes("agento.showOutput"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  const deliveryDir = path.join(fixture, "features", "2026", "09", "x");
  const roadmapPath = path.join(deliveryDir, "roadmap.md");
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(deliveryDir));
  await waitForRoadmapRefresh(api, vscode.Uri.file(roadmapPath));
  console.log("Extension activation test passed: active, commands, CLI session, watcher refresh");
}