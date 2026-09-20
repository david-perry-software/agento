import * as vscode from "vscode";

import type { InitiativeTreeModel } from "./initiativeTreeModel.js";
import {
  initiativeTreeChildren,
  initiativeTreeItemSpec,
  type InitiativeTreeElement,
} from "./initiativeTreePresentation.js";

export type { InitiativeTreeElement } from "./initiativeTreePresentation.js";

export interface InitiativeTreeSnapshot {
  model: InitiativeTreeModel;
  artifactRoot: string;
}

export class InitiativeTreeProvider implements vscode.TreeDataProvider<InitiativeTreeElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<InitiativeTreeElement | undefined>();
  private snapshot: InitiativeTreeSnapshot;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(artifactRoot: string) {
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
    const collapsibleState = spec.collapsible === "expanded"
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(spec.label, collapsibleState);
    item.contextValue = spec.contextValue;
    item.iconPath = new vscode.ThemeIcon(spec.icon);
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

export async function openBreakdown(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
}