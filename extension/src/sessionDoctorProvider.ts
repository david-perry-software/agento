import * as vscode from "vscode";

import type { SessionDoctorModel } from "./sessionDoctorModel.js";
import { healthStyle, lifecycleStyle, type StatusStyle } from "./statusStyle.js";
import type { TreeIdScope } from "./treeItemIds.js";

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
  color?: string;
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
    statusBarStyle: { background: "error" },
  };

  readonly onDidChangeTreeData = this.didChangeTreeData.event;

  constructor(private readonly treeId: TreeIdScope) {}

  get current(): SessionDoctorModel {
    return this.model;
  }

  update(model: SessionDoctorModel): void {
    this.model = model;
    this.didChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SessionDoctorElement): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = this.treeId("sessionDoctor", "group", element.id);
      item.contextValue = `agento.sessionDoctor.${element.id}`;
      item.iconPath = element.id === "doctor"
        ? themeIcon({ icon: "pulse", color: healthStyle(this.worstCheckStatus()).color })
        : new vscode.ThemeIcon("folder");
      return item;
    }
    if (element.kind === "error") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = "agento.sessionDoctor.error";
      item.iconPath = themeIcon(healthStyle("fail"));
      item.command = { command: "agento.refresh", title: "Retry" };
      return item;
    }

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = "agento.sessionDoctor.row";
    if (element.icon) {
      item.iconPath = themeIcon({ icon: element.icon, color: element.color });
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
      const lifecycle = lifecycleStyle(this.model.session.lifecycle);
      return [
        this.row("Role", this.model.session.role),
        this.row("Worktree", this.model.session.worktreePath),
        this.row("Branch", this.model.session.branch),
        this.row("Lifecycle", this.model.session.lifecycle, undefined, lifecycle.color ? lifecycle : undefined),
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
      return this.model.warnings.map((warning) => this.row("Warning", warning, warning, healthStyle("warn")));
    }
    return this.model.checks.map((check) =>
      this.row(
        check.id,
        check.status,
        `Detail: ${check.detail}\nFallback: ${check.fallback ?? "none"}`,
        healthStyle(check.status),
      ),
    );
  }

  dispose(): void {
    this.didChangeTreeData.dispose();
  }

  private worstCheckStatus(): "ok" | "warn" | "fail" {
    const statuses = this.model.kind === "ready" ? this.model.checks.map((check) => check.status) : ["fail"];
    if (statuses.some((status) => status !== "ok" && status !== "warn")) return "fail";
    return statuses.includes("warn") ? "warn" : "ok";
  }

  private row(label: string, description: string, tooltip?: string, style?: StatusStyle): RowElement {
    return { kind: "row", label, description, tooltip, icon: style?.icon, color: style?.color };
  }
}

function themeIcon(style: StatusStyle): vscode.ThemeIcon {
  return new vscode.ThemeIcon(style.icon, style.color ? new vscode.ThemeColor(style.color) : undefined);
}