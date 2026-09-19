import * as vscode from "vscode";

import type { SessionDoctorModel } from "./sessionDoctorModel.js";

interface GroupElement {
  kind: "group";
  id: "session" | "companion" | "warnings" | "doctor";
  label: string;
}

interface RowElement {
  kind: "row";
  label: string;
  description: string;
  tooltip?: string;
  icon?: string;
}

interface ErrorElement {
  kind: "error";
  label: string;
}

export type SessionDoctorElement = GroupElement | RowElement | ErrorElement;

export class SessionDoctorProvider implements vscode.TreeDataProvider<SessionDoctorElement> {
  private readonly didChangeTreeData = new vscode.EventEmitter<SessionDoctorElement | undefined>();
  private model: SessionDoctorModel = {
    kind: "error",
    message: "Session & Doctor has not loaded.",
    statusBarText: "Agento: unavailable",
  };

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  get current(): SessionDoctorModel {
    return this.model;
  }

  update(model: SessionDoctorModel): void {
    this.model = model;
    this.didChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SessionDoctorElement): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `agento.sessionDoctor.${element.id}`;
      item.iconPath = new vscode.ThemeIcon(element.id === "doctor" ? "pulse" : "folder");
      return item;
    }
    if (element.kind === "error") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "agento.sessionDoctor.error";
      item.iconPath = new vscode.ThemeIcon("error");
      item.command = { command: "agento.refresh", title: "Retry" };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = "agento.sessionDoctor.row";
    if (element.icon) {
      item.iconPath = new vscode.ThemeIcon(element.icon);
    }
    return item;
  }

  getChildren(element?: SessionDoctorElement): SessionDoctorElement[] {
    if (this.model.kind === "error") {
      return element ? [] : [{ kind: "error", label: this.model.message }];
    }
    if (!element) {
      return [
        { kind: "group", id: "session", label: "Session" },
        { kind: "group", id: "companion", label: "Companion" },
        ...(this.model.warnings.length > 0
          ? [{ kind: "group" as const, id: "warnings" as const, label: "Warnings" }]
          : []),
        { kind: "group", id: "doctor", label: "Doctor" },
      ];
    }
    if (element.kind !== "group") {
      return [];
    }
    if (element.id === "session") {
      return [
        this.row("Role", this.model.session.role),
        this.row("Worktree", this.model.session.worktreePath),
        this.row("Branch", this.model.session.branch),
        this.row("Lifecycle", this.model.session.lifecycle),
        this.row("Workspace", this.model.session.workspace),
      ];
    }
    if (element.id === "companion") {
      return this.model.companion
        ? [
            this.row("Path", this.model.companion.path),
            this.row("Branch", this.model.companion.branch),
            this.row("State", this.model.companion.state),
            this.row("Sync", this.model.companion.sync),
          ]
        : [this.row("Companion", "none")];
    }
    if (element.id === "warnings") {
      return this.model.warnings.map((warning) => this.row("Warning", warning, warning, "warning"));
    }
    return this.model.checks.map((check) =>
      this.row(
        check.id,
        check.status,
        `Detail: ${check.detail}\nFallback: ${check.fallback ?? "none"}`,
        check.status === "ok" ? "pass" : check.status === "warn" ? "warning" : "error",
      ),
    );
  }

  dispose(): void {
    this.didChangeTreeData.dispose();
  }

  private row(label: string, description: string, tooltip?: string, icon?: string): RowElement {
    return { kind: "row", label, description, tooltip, icon };
  }
}