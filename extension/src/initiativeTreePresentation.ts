import path from "node:path";

import type {
  InitiativeDiagnostic,
  InitiativeMemberGroup,
  InitiativeMemberItem,
  InitiativeTreeItem,
  InitiativeTreeModel,
} from "./initiativeTreeModel.js";

interface InitiativeElement {
  kind: "initiative";
  item: InitiativeTreeItem;
}

interface GroupElement {
  kind: "group";
  group: InitiativeMemberGroup;
  breakdown?: string;
}

interface MemberElement {
  kind: "member";
  item: InitiativeMemberItem;
  groupKind: InitiativeMemberGroup["kind"];
  breakdown?: string;
}

interface DiagnosticElement {
  kind: "diagnostic";
  diagnostic: InitiativeDiagnostic;
}

interface MessageElement {
  kind: "message";
  label: string;
  severity: "empty" | "error";
}

export type InitiativeTreeElement = InitiativeElement | GroupElement | MemberElement | DiagnosticElement | MessageElement;

export interface InitiativeTreeItemSpec {
  label: string;
  collapsible: "none" | "expanded";
  contextValue: string;
  icon: string;
  description?: string;
  tooltip?: string;
  command?: {
    id: "agento.openBreakdown";
    title: "Open Breakdown";
    path: string;
  };
}

const GROUP_ICONS: Record<InitiativeMemberGroup["kind"], string> = {
  ready: "play-circle",
  "in-flight": "sync",
  blocked: "lock",
  complete: "pass-filled",
};

function breakdownCommand(artifactRoot: string, breakdown?: string): InitiativeTreeItemSpec["command"] {
  return breakdown
    ? {
        id: "agento.openBreakdown",
        title: "Open Breakdown",
        path: path.resolve(artifactRoot, breakdown),
      }
    : undefined;
}

export function initiativeTreeChildren(model: InitiativeTreeModel, element?: InitiativeTreeElement): InitiativeTreeElement[] {
  if (!element) {
    if (model.kind === "ready") {
      return model.items.map((item) => ({ kind: "initiative", item }));
    }
    return [{ kind: "message", label: model.message, severity: model.kind }];
  }
  if (element.kind === "initiative") {
    return [
      ...element.item.diagnostics.map((diagnostic): DiagnosticElement => ({ kind: "diagnostic", diagnostic })),
      ...element.item.groups.map((group): GroupElement => ({ kind: "group", group, breakdown: element.item.breakdown })),
    ];
  }
  if (element.kind === "group") {
    return element.group.items.map((item) => ({
      kind: "member",
      item,
      groupKind: element.group.kind,
      breakdown: element.breakdown,
    }));
  }
  return [];
}

export function initiativeTreeItemSpec(element: InitiativeTreeElement, artifactRoot: string): InitiativeTreeItemSpec {
  if (element.kind === "initiative") {
    return {
      label: element.item.slug,
      collapsible: "expanded",
      contextValue: "agento.initiative",
      icon: element.item.valid ? "type-hierarchy" : "warning",
      description: element.item.description,
      tooltip: element.item.tooltip,
      command: breakdownCommand(artifactRoot, element.item.breakdown),
    };
  }
  if (element.kind === "group") {
    return {
      label: `${element.group.label} (${element.group.items.length})`,
      collapsible: "expanded",
      contextValue: `agento.initiativeGroup.${element.group.kind}`,
      icon: GROUP_ICONS[element.group.kind],
    };
  }
  if (element.kind === "member") {
    return {
      label: element.item.slug,
      collapsible: "none",
      contextValue: `agento.initiativeMember.${element.groupKind}`,
      icon: GROUP_ICONS[element.groupKind],
      description: element.item.description,
      tooltip: element.item.tooltip,
      command: breakdownCommand(artifactRoot, element.breakdown),
    };
  }
  if (element.kind === "diagnostic") {
    return {
      label: element.diagnostic.message,
      collapsible: "none",
      contextValue: `agento.initiativeDiagnostic.${element.diagnostic.kind}`,
      icon: element.diagnostic.kind === "error" ? "error" : "warning",
      tooltip: element.diagnostic.message,
    };
  }
  return {
    label: element.label,
    collapsible: "none",
    contextValue: `agento.${element.severity}`,
    icon: element.severity === "error" ? "error" : "info",
  };
}