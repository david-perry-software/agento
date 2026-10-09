import * as vscode from "vscode";

import type { InitiativeTreeModel } from "./initiativeTreeModel.js";
import {
  initiativeTreeChildren,
  initiativeTreeItemSpec,
  type InitiativeTreeElement,
} from "./initiativeTreePresentation.js";
import type { TreeIdScope } from "./treeItemIds.js";

export type { InitiativeTreeElement } from "./initiativeTreePresentation.js";

export interface InitiativeTreeSnapshot {
  model: InitiativeTreeModel;
  artifactRoot: string;
}

export class InitiativeTreeProvider implements vscode.TreeDataProvider<InitiativeTreeElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<InitiativeTreeElement | undefined>();
  private snapshot: InitiativeTreeSnapshot;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(artifactRoot: string, private readonly treeId: TreeIdScope) {
    this.snapshot = {
      model: { kind: "empty", message: "No initiatives found." },
      artifactRoot,
    };
  }

  get current(): InitiativeTreeSnapshot {
    return this.snapshot;
  }

  update(snapshot: InitiativeTreeSnapshot): void {
    this.snapshot = snapshot;
    this.didChangeTreeData.fire(undefined);
  }

  getTreeItem(element: InitiativeTreeElement): vscode.TreeItem {
    const spec = initiativeTreeItemSpec(element, this.snapshot.artifactRoot);
    const collapsibleState = spec.collapsible === "collapsed"
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(spec.label, collapsibleState);
    if (spec.idParts) {
      item.id = this.treeId("initiatives", ...spec.idParts);
    }
    item.contextValue = spec.contextValue;
    item.iconPath = new vscode.ThemeIcon(spec.icon, spec.color ? new vscode.ThemeColor(spec.color) : undefined);
    item.description = spec.description;
    item.tooltip = spec.tooltip;
    if (spec.command) {
      item.command = {
        command: spec.command.id,
        title: spec.command.title,
        arguments: [vscode.Uri.file(spec.command.path)],
      };
    }
    return item;
  }

  getChildren(element?: InitiativeTreeElement): InitiativeTreeElement[] {
    return initiativeTreeChildren(this.snapshot.model, element);
  }

  dispose(): void {
    this.didChangeTreeData.dispose();
  }
}
