import * as vscode from "vscode";

import {
  createModelProfilesModel,
  modelProfilesChildren,
  modelProfilesItemSpec,
  type ModelProfilesElement,
  type ModelProfilesModel,
} from "./modelProfilesTree.js";

export type { ModelProfilesElement } from "./modelProfilesTree.js";

// The TreeDataProvider over the pure Model Profiles model. It exposes `current`
// and `update(model)`, sets the `agento.modelProfiles.state` context key for the
// viewsWelcome and menu when-clauses, and renders no children in the two empty
// states the welcome content covers.
export class ModelProfilesProvider implements vscode.TreeDataProvider<ModelProfilesElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<ModelProfilesElement | undefined>();
  private model: ModelProfilesModel;

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor() {
    this.model = createModelProfilesModel({ pluginRoot: null });
  }

  get current(): ModelProfilesModel {
    return this.model;
  }

  update(model: ModelProfilesModel): void {
    this.model = model;
    void vscode.commands.executeCommand("setContext", "agento.modelProfiles.state", model.state);
    this.didChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ModelProfilesElement): vscode.TreeItem {
    const spec = modelProfilesItemSpec(element, this.model.active);
    const item = new vscode.TreeItem(spec.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = spec.contextValue;
    item.iconPath = new vscode.ThemeIcon(spec.icon);
    item.description = spec.description;
    item.tooltip = spec.tooltip;
    return item;
  }

  getChildren(element?: ModelProfilesElement): ModelProfilesElement[] {
    if (element) return [];
    return modelProfilesChildren(this.model);
  }

  dispose(): void {
    this.didChangeTreeData.dispose();
  }
}
