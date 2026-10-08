import path from "node:path";

import type {
  InitiativeDiagnostic,
  InitiativeMemberGroup,
  InitiativeMemberItem,
  InitiativeTreeItem,
  InitiativeTreeModel,
} from "./initiativeTreeModel.js";
import { healthStyle, initiativeGroupStyle } from "./statusStyle.js";

interface InitiativeElement {
  kind: "initiative";
  item: InitiativeTreeItem;
}

interface GroupElement {
  kind: "group";
  group: InitiativeMemberGroup;
  initiativeSlug: string;
  breakdown?: string;
}

interface MemberElement {
  kind: "member";
  item: InitiativeMemberItem;
  groupKind: InitiativeMemberGroup["kind"];
  initiativeSlug: string;
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

interface CompletedFolderElement {
  kind: "completed";
  items: InitiativeTreeItem[];
}

export type InitiativeTreeElement =
  | InitiativeElement
  | CompletedFolderElement
  | GroupElement
  | MemberElement
  | DiagnosticElement
  | MessageElement;

export interface InitiativeTreeItemSpec {
  label: string;
  collapsible: "none" | "collapsed";
  idParts?: string[];
  contextValue: string;
  icon: string;
  color?: string;
  description?: string;
  tooltip?: string;
  command?: {
    id: "agento.openBreakdown";
    title: "Open Breakdown";
    path: string;
  };
}

const COMPLETE_COLOR = initiativeGroupStyle("complete").color;
const FAIL_COLOR = healthStyle("fail").color;
const WARN_COLOR = healthStyle("warn").color;

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
      // Done-but-invalid initiatives stay at the root so their diagnostics remain visible.
      const completed = model.items.filter((item) => item.done && item.valid);
      const roots: InitiativeTreeElement[] = model.items
        .filter((item) => !(item.done && item.valid))
        .map((item) => ({ kind: "initiative", item }));
      return completed.length > 0 ? [...roots, { kind: "completed", items: completed }] : roots;
    }
    return [{ kind: "message", label: model.message, severity: model.kind }];
  }
  if (element.kind === "completed") {
    return element.items.map((item) => ({ kind: "initiative", item }));
  }
  if (element.kind === "initiative") {
    return [
      ...element.item.diagnostics.map((diagnostic): DiagnosticElement => ({ kind: "diagnostic", diagnostic })),
      ...element.item.groups.map((group): GroupElement => ({
        kind: "group",
        group,
        initiativeSlug: element.item.slug,
        breakdown: element.item.breakdown,
      })),
    ];
  }
  if (element.kind === "group") {
    return element.group.items.map((item) => ({
      kind: "member",
      item,
      groupKind: element.group.kind,
      initiativeSlug: element.initiativeSlug,
      breakdown: element.breakdown,
    }));
  }
  return [];
}

export function initiativeTreeItemSpec(element: InitiativeTreeElement, artifactRoot: string): InitiativeTreeItemSpec {
  if (element.kind === "initiative") {
    return {
      label: element.item.slug,
      collapsible: "collapsed",
      idParts: ["initiative", element.item.slug],
      contextValue: "agento.initiative",
      icon: element.item.valid ? "type-hierarchy" : "warning",
      color: !element.item.valid ? FAIL_COLOR : element.item.done ? COMPLETE_COLOR : undefined,
      description: element.item.description,
      tooltip: element.item.tooltip,
      command: breakdownCommand(artifactRoot, element.item.breakdown),
    };
  }
  if (element.kind === "completed") {
    const count = element.items.length;
    return {
      label: `Completed (${count})`,
      collapsible: "collapsed",
      idParts: ["completed"],
      contextValue: "agento.initiativesCompleted",
      icon: "archive",
      color: COMPLETE_COLOR,
      tooltip: `${count} completed initiative${count === 1 ? "" : "s"}`,
    };
  }
  if (element.kind === "group") {
    return {
      label: `${element.group.label} (${element.group.items.length})`,
      collapsible: "collapsed",
      idParts: ["group", element.initiativeSlug, element.group.kind],
      contextValue: `agento.initiativeGroup.${element.group.kind}`,
      ...initiativeGroupStyle(element.group.kind),
    };
  }
  if (element.kind === "member") {
    return {
      label: element.item.slug,
      collapsible: "none",
      contextValue: `agento.initiativeMember.${element.groupKind}`,
      ...initiativeGroupStyle(element.groupKind),
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
      color: element.diagnostic.kind === "error" ? FAIL_COLOR : WARN_COLOR,
      tooltip: element.diagnostic.message,
    };
  }
  return {
    label: element.label,
    collapsible: "none",
    contextValue: `agento.${element.severity}`,
    icon: element.severity === "error" ? "error" : "info",
    color: element.severity === "error" ? FAIL_COLOR : undefined,
  };
}