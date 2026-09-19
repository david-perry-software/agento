import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";
import type { DeliveryTreeElement } from "../../src/deliveryTreeProvider.js";

async function waitForReadyTree(api: ExtensionApi): Promise<void> {
  if (api.deliveries.current.model.kind === "ready") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Deliveries tree; current state: ${api.deliveries.current.model.kind}`));
    }, 15_000);
    const subscription = api.deliveries.onDidChangeTreeData(() => {
      if (api.deliveries.current.model.kind !== "ready") {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
}

function deliveryElements(api: ExtensionApi, group: DeliveryTreeElement): DeliveryTreeElement[] {
  return api.deliveries.getChildren(group);
}

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
  assert.ok(commands.includes("agento.openRoadmap"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  await waitForReadyTree(api);
  const groups = api.deliveries.getChildren();
  assert.deepEqual(
    groups.map((group) => api.deliveries.getTreeItem(group).label),
    ["Planned", "Building"],
  );
  const items = groups.flatMap((group) => deliveryElements(api, group));
  assert.deepEqual(
    items.map((item) => api.deliveries.getTreeItem(item).label),
    ["planned-delivery", "building-delivery"],
  );
  assert.equal(api.deliveries.getTreeItem(items[0]!).description, "feature | 1/3 | planned | PR #101 draft");
  if (process.env.AGENTO_ELECTRON_SCENARIO === "companion") {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: #202 OPEN draft CLEAN/);
  } else {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: none/);
  }

  const deliveryDir = path.join(fixture, "features", "2026", "09", "x");
  const roadmapPath = path.join(deliveryDir, "roadmap.md");
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(deliveryDir));
  await waitForRoadmapRefresh(api, vscode.Uri.file(roadmapPath));
  console.log(`Electron ${process.env.AGENTO_ELECTRON_SCENARIO} scenario passed: deliveries, metadata, watcher refresh`);
}