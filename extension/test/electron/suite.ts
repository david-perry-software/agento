import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";

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
  const observedReasons: string[] = [];
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for roadmap refresh; observed: ${observedReasons.join(", ") || "none"}`)),
      api.scheduler.debounceMs + 2000,
    );
    const subscription = api.scheduler.onDidRefresh(({ reasons }) => {
      observedReasons.push(...reasons);
      if (!reasons.some((reason) => reason === `create ${roadmapPath}` || reason === `change ${roadmapPath}`)) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(deliveryDir));
  await vscode.workspace.fs.writeFile(vscode.Uri.file(roadmapPath), Buffer.from("# Fixture\n"));
  await refreshed;
  console.log("Extension activation test passed: active, commands, CLI session, watcher refresh");
}