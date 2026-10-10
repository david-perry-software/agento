import path from "node:path";
import * as vscode from "vscode";

import type { DeliveryTreeGroup, DeliveryTreeItem, DeliveryTreeModel } from "./deliveryTreeModel.js";
import { healthStyle, lifecycleStyle } from "./statusStyle.js";
import type { TreeIdScope } from "./treeItemIds.js";

interface GroupElement {
  kind: "group";
  group: DeliveryTreeGroup;
}

interface DeliveryElement {
  kind: "delivery";
  item: DeliveryTreeItem;
}

interface TimelineElement {
  kind: "timeline";
  item: DeliveryTreeItem;
}

interface MessageElement {
  kind: "message";
  label: string;
  severity: "empty" | "error";
}

export type DeliveryTreeElement = GroupElement | DeliveryElement | TimelineElement | MessageElement;

export interface DeliveryTreeSnapshot {
  model: DeliveryTreeModel;
  roadmapRoot: string;
}

export class DeliveryTreeProvider implements vscode.TreeDataProvider<DeliveryTreeElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<DeliveryTreeElement | undefined>();
  private snapshot: DeliveryTreeSnapshot;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(roadmapRoot: string, private readonly treeId: TreeIdScope) {
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
      const item = new vscode.TreeItem(element.group.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = this.treeId("deliveries", "group", element.group.lifecycle);
      item.contextValue = "agento.lifecycle";
      const style = lifecycleStyle(element.group.lifecycle);
      item.iconPath = new vscode.ThemeIcon(style.icon, style.color ? new vscode.ThemeColor(style.color) : undefined);
      return item;
    }
    if (element.kind === "message") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = `agento.${element.severity}`;
      const fail = healthStyle("fail");
      item.iconPath = element.severity === "error"
        ? new vscode.ThemeIcon(fail.icon, new vscode.ThemeColor(fail.color!))
        : new vscode.ThemeIcon("info");
      return item;
    }
    if (element.kind === "timeline") {
      const timeline = element.item.timeline ?? { description: "unavailable", tooltip: "No metrics in this dashboard document." };
      const item = new vscode.TreeItem("Timeline", vscode.TreeItemCollapsibleState.None);
      item.description = timeline.description;
      item.tooltip = timeline.tooltip;
      item.contextValue = "agento.timeline";
      item.iconPath = new vscode.ThemeIcon("history");
      return item;
    }

    const item = new vscode.TreeItem(element.item.slug, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = this.treeId("deliveries", "delivery", element.item.roadmap);
    item.description = element.item.description;
    item.tooltip = element.item.tooltip;
    item.contextValue = "agento.delivery";
    const color = lifecycleStyle(element.item.lifecycle).color;
    item.iconPath = new vscode.ThemeIcon("git-pull-request", color ? new vscode.ThemeColor(color) : undefined);
    item.command = {
      command: "agento.openRoadmap",
      title: "Open Roadmap",
      arguments: [vscode.Uri.file(path.resolve(element.item.roadmapRoot ?? this.snapshot.roadmapRoot, element.item.roadmap))],
    };
    return item;
  }

  getChildren(element?: DeliveryTreeElement): DeliveryTreeElement[] {
    if (element?.kind === "group") {
      return element.group.items.map((item) => ({ kind: "delivery", item }));
    }
    if (element?.kind === "delivery") {
      return [{ kind: "timeline", item: element.item }];
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
