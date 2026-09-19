import path from "node:path";
import * as vscode from "vscode";

import type { DeliveryTreeGroup, DeliveryTreeItem, DeliveryTreeModel } from "./deliveryTreeModel.js";

interface GroupElement {
  kind: "group";
  group: DeliveryTreeGroup;
}

interface DeliveryElement {
  kind: "delivery";
  item: DeliveryTreeItem;
}

interface MessageElement {
  kind: "message";
  label: string;
  severity: "empty" | "error";
}

export type DeliveryTreeElement = GroupElement | DeliveryElement | MessageElement;

export interface DeliveryTreeSnapshot {
  model: DeliveryTreeModel;
  roadmapRoot: string;
}

export class DeliveryTreeProvider implements vscode.TreeDataProvider<DeliveryTreeElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<DeliveryTreeElement | undefined>();
  private snapshot: DeliveryTreeSnapshot;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(roadmapRoot: string) {
    this.snapshot = {
      model: { kind: "empty", message: "No deliveries found.", warnings: [] },
      roadmapRoot,
    };
  }

  get current(): DeliveryTreeSnapshot {
    return this.snapshot;
  }

  update(snapshot: DeliveryTreeSnapshot): void {
    this.snapshot = snapshot;
    this.didChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DeliveryTreeElement): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "agento.lifecycle";
      item.iconPath = new vscode.ThemeIcon("folder");
      return item;
    }
    if (element.kind === "message") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = `agento.${element.severity}`;
      item.iconPath = new vscode.ThemeIcon(element.severity === "error" ? "error" : "info");
      return item;
    }

    const item = new vscode.TreeItem(element.item.slug, vscode.TreeItemCollapsibleState.None);
    item.description = element.item.description;
    item.tooltip = element.item.tooltip;
    item.contextValue = "agento.delivery";
    item.iconPath = new vscode.ThemeIcon("git-pull-request");
    item.command = {
      command: "agento.openRoadmap",
      title: "Open Roadmap",
      arguments: [vscode.Uri.file(path.resolve(this.snapshot.roadmapRoot, element.item.roadmap))],
    };
    return item;
  }

  getChildren(element?: DeliveryTreeElement): DeliveryTreeElement[] {
    if (element?.kind === "group") {
      return element.group.items.map((item) => ({ kind: "delivery", item }));
    }
    if (element) {
      return [];
    }
    if (this.snapshot.model.kind === "ready") {
      return this.snapshot.model.groups.map((group) => ({ kind: "group", group }));
    }
    return [
      {
        kind: "message",
        label: this.snapshot.model.message,
        severity: this.snapshot.model.kind,
      },
    ];
  }

  dispose(): void {
    this.didChangeTreeData.dispose();
  }
}

export async function openRoadmap(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
}