import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";
import { createDeliveryTreeError } from "../../src/deliveryTreeModel.js";
import type { DeliveryTreeElement } from "../../src/deliveryTreeProvider.js";
import { createInitiativeTreeError, createInitiativeTreeModel } from "../../src/initiativeTreeModel.js";
import type { InitiativeTreeElement } from "../../src/initiativeTreeProvider.js";

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

async function waitForReadyInitiatives(api: ExtensionApi): Promise<void> {
  if (api.initiatives.current.model.kind === "ready") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Initiatives tree; current state: ${api.initiatives.current.model.kind}`));
    }, 15_000);
    const subscription = api.initiatives.onDidChangeTreeData(() => {
      if (api.initiatives.current.model.kind !== "ready") {
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

async function waitForTree(
  api: ExtensionApi,
  predicate: () => boolean,
  description: string,
  action: () => Thenable<void>,
): Promise<void> {
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Deliveries tree ${description}`));
    }, api.scheduler.debounceMs + 12_000);
    const subscription = api.deliveries.onDidChangeTreeData(() => {
      if (!predicate()) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
  await action();
  await refreshed;
}

async function waitForInitiativeTree(
  api: ExtensionApi,
  predicate: () => boolean,
  description: string,
  action: () => Thenable<void>,
): Promise<void> {
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Initiatives tree ${description}`));
    }, api.scheduler.debounceMs + 12_000);
    const subscription = api.initiatives.onDidChangeTreeData(() => {
      if (!predicate()) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
  await action();
  await refreshed;
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
  assert.ok(commands.includes("agento.openBreakdown"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  await waitForReadyTree(api);
  await waitForReadyInitiatives(api);
  const groups = api.deliveries.getChildren();
  assert.deepEqual(
    groups.map((group) => api.deliveries.getTreeItem(group).label),
    ["Planned", "Building", "In Review", "Shipped"],
  );
  const items = groups.flatMap((group) => deliveryElements(api, group));
  assert.deepEqual(
    items.map((item) => api.deliveries.getTreeItem(item).label),
    ["planned-delivery", "building-delivery", "anomalous-delivery", "complete-delivery"],
  );
  assert.equal(api.deliveries.getTreeItem(items[0]!).description, "feature | 1/3 | planned | PR #101 draft");
  if (process.env.AGENTO_ELECTRON_SCENARIO === "companion") {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: #202 OPEN draft CLEAN/);
  } else {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: none/);
  }

  const activeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture, ".github", "agento.json")));
  const activeEditor = await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  const deliveryTreeItem = api.deliveries.getTreeItem(items[0]!);
  assert.ok(deliveryTreeItem.command);
  await vscode.commands.executeCommand(deliveryTreeItem.command.command, ...(deliveryTreeItem.command.arguments ?? []));
  const roadmapUri = deliveryTreeItem.command.arguments?.[0];
  assert.ok(roadmapUri instanceof vscode.Uri);
  const roadmapEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === roadmapUri.fsPath);
  assert.ok(roadmapEditor, "delivery activation opens its roadmap");
  assert.equal(activeEditor.viewColumn, vscode.ViewColumn.One);
  assert.equal(roadmapEditor.viewColumn, vscode.ViewColumn.Two);

  const initiative = api.initiatives.getChildren()[0];
  assert.ok(initiative?.kind === "initiative");
  const initiativeItem = api.initiatives.getTreeItem(initiative);
  assert.equal(initiativeItem.label, "agento-extension");
  assert.equal(initiativeItem.description, "1/6 complete | 3 in flight | 1 ready");
  const initiativeChildren = api.initiatives.getChildren(initiative);
  const diagnostic = initiativeChildren.find((element) => element.kind === "diagnostic");
  assert.ok(diagnostic);
  assert.match(String(api.initiatives.getTreeItem(diagnostic).label), /anomalous-delivery: merged-but-not-complete/);
  const initiativeGroups = initiativeChildren.filter((element): element is Extract<InitiativeTreeElement, { kind: "group" }> => element.kind === "group");
  assert.deepEqual(initiativeGroups.map((group) => api.initiatives.getTreeItem(group).label), [
    "Ready (1)",
    "In flight (3)",
    "Blocked (1)",
    "Complete (1)",
  ]);
  const initiativeMembers = initiativeGroups.flatMap((group) => api.initiatives.getChildren(group));
  assert.deepEqual(initiativeMembers.map((member) => api.initiatives.getTreeItem(member).label), [
    "ready-delivery",
    "planned-delivery",
    "building-delivery",
    "anomalous-delivery",
    "blocked-delivery",
    "complete-delivery",
  ]);
  const blockedMember = initiativeMembers.find((member) => api.initiatives.getTreeItem(member).label === "blocked-delivery");
  assert.ok(blockedMember);
  assert.match(String(api.initiatives.getTreeItem(blockedMember).tooltip), /Wave: 2/);
  assert.match(String(api.initiatives.getTreeItem(blockedMember).tooltip), /Blocked by: building-delivery/);
  const readyMember = initiativeMembers.find((member) => api.initiatives.getTreeItem(member).label === "ready-delivery");
  assert.ok(readyMember);
  assert.match(String(api.initiatives.getTreeItem(readyMember).tooltip), /Ready: yes\nNext: yes/);

  const memberTreeItem = api.initiatives.getTreeItem(readyMember);
  assert.ok(memberTreeItem.command);
  await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  await vscode.commands.executeCommand(memberTreeItem.command.command, ...(memberTreeItem.command.arguments ?? []));
  const breakdownUri = memberTreeItem.command.arguments?.[0];
  assert.ok(breakdownUri instanceof vscode.Uri);
  const expectedArtifactRoot = process.env.AGENTO_ELECTRON_SCENARIO === "companion"
    ? path.join(path.dirname(fixture), "artifacts")
    : fixture;
  assert.equal(breakdownUri.fsPath, path.join(expectedArtifactRoot, "initiatives", "2026", "09", "agento-extension", "breakdown.md"));
  const breakdownEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === breakdownUri.fsPath);
  assert.ok(breakdownEditor, "initiative member activation opens its breakdown");
  assert.equal(breakdownEditor.viewColumn, vscode.ViewColumn.Two);

  const buildingRoadmap = vscode.Uri.file(path.join(expectedArtifactRoot, "features", "2026", "09", "building-delivery", "roadmap.md"));
  const buildingContents = Buffer.from(await vscode.workspace.fs.readFile(buildingRoadmap)).toString("utf8");
  await waitForInitiativeTree(
    api,
    () => {
      const current = api.initiatives.getChildren()[0];
      return current?.kind === "initiative"
        && api.initiatives.getTreeItem(current).description === "2/6 complete | 2 in flight | 2 ready";
    },
    "to reflect a completed member roadmap",
    () => vscode.workspace.fs.writeFile(buildingRoadmap, Buffer.from(buildingContents.replace("status: in-progress", "status: complete"))),
  );
  const refreshedInitiative = api.initiatives.getChildren()[0];
  assert.ok(refreshedInitiative?.kind === "initiative");
  const refreshedGroups = api.initiatives.getChildren(refreshedInitiative).filter(
    (element): element is Extract<InitiativeTreeElement, { kind: "group" }> => element.kind === "group",
  );
  assert.deepEqual(refreshedGroups.map((group) => api.initiatives.getTreeItem(group).label), ["Ready (2)", "In flight (2)", "Complete (2)"]);
  const refreshedDeliveryLabels = api.deliveries.getChildren().flatMap((group) => deliveryElements(api, group)).map((item) => api.deliveries.getTreeItem(item).label);
  assert.ok(refreshedDeliveryLabels.includes("building-delivery"), "Deliveries remains populated after initiative refresh");

  const roadmapContents = Buffer.from(await vscode.workspace.fs.readFile(roadmapUri)).toString("utf8");
  await waitForTree(
    api,
    () => {
      const currentGroup = api.deliveries.getChildren()[0];
      const currentDelivery = currentGroup && deliveryElements(api, currentGroup)[0];
      return currentDelivery ? api.deliveries.getTreeItem(currentDelivery).description === "feature | 2/3 | planned | PR #101 draft" : false;
    },
    "to show updated roadmap progress",
    () => vscode.workspace.fs.writeFile(roadmapUri, Buffer.from(roadmapContents.replace("- [ ] 1.2", "- [x] 1.2"))),
  );

  const deliveryDir = path.join(expectedArtifactRoot, "features", "2026", "09", "x");
  const roadmapPath = path.join(deliveryDir, "roadmap.md");
  await waitForRoadmapRefresh(api, vscode.Uri.file(roadmapPath));

  api.deliveries.update({
    model: { kind: "empty", message: "No deliveries found.", warnings: [] },
    roadmapRoot: fixture,
  });
  const emptyItem = api.deliveries.getTreeItem(api.deliveries.getChildren()[0]!);
  assert.equal(emptyItem.label, "No deliveries found.");
  assert.equal(emptyItem.contextValue, "agento.empty");

  api.deliveries.update({
    model: createDeliveryTreeError(new Error("fixture status failure")),
    roadmapRoot: fixture,
  });
  const errorItem = api.deliveries.getTreeItem(api.deliveries.getChildren()[0]!);
  assert.equal(errorItem.label, "Unable to load deliveries: fixture status failure");
  assert.equal(errorItem.contextValue, "agento.error");

  const artifactRoot = api.initiatives.current.artifactRoot;
  const healthyModel = api.initiatives.current.model;
  assert.equal(healthyModel.kind, "ready");
  if (healthyModel.kind !== "ready") return;
  api.initiatives.update({ model: { kind: "empty", message: "No initiatives found." }, artifactRoot });
  const emptyInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.equal(emptyInitiative.label, "No initiatives found.");
  assert.equal(emptyInitiative.contextValue, "agento.empty");

  api.initiatives.update({
    model: createInitiativeTreeModel({ status: "ok", items: [{ slug: "malformed" }] }, new Map()),
    artifactRoot,
  });
  const malformedInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.match(String(malformedInitiative.label), /Invalid initiative list response/);
  assert.equal(malformedInitiative.contextValue, "agento.error");

  api.initiatives.update({ model: createInitiativeTreeError(new Error("fixture initiative failure")), artifactRoot });
  const errorInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.equal(errorInitiative.label, "Unable to load initiatives: fixture initiative failure");
  assert.equal(errorInitiative.contextValue, "agento.error");

  const healthy = healthyModel.items[0]!;
  api.initiatives.update({
    model: {
      kind: "ready",
      items: [
        {
          ...healthy,
          slug: "invalid-initiative",
          valid: false,
          groups: [],
          diagnostics: [{ kind: "error", message: "dependency cycle among: a, b" }],
        },
        healthy,
      ],
    },
    artifactRoot,
  });
  const partialRoots = api.initiatives.getChildren();
  assert.deepEqual(partialRoots.map((element) => api.initiatives.getTreeItem(element).label), ["invalid-initiative", "agento-extension"]);
  const invalidDiagnostic = api.initiatives.getChildren(partialRoots[0]).find((element) => element.kind === "diagnostic");
  assert.ok(invalidDiagnostic);
  assert.equal(api.initiatives.getTreeItem(invalidDiagnostic).label, "dependency cycle among: a, b");
  assert.ok(api.initiatives.getChildren(partialRoots[1]).some((element) => element.kind === "group"), "healthy initiative remains usable");

  console.log(`Electron ${process.env.AGENTO_ELECTRON_SCENARIO} scenario passed: rendering, navigation, roadmap refresh, partial diagnostics, empty/error rows, Deliveries retained`);
}