import * as vscode from "vscode";

import type { CommandAction } from "./commandActions.js";
import type { DeliveryTreeElement } from "./deliveryTreeProvider.js";

interface ActionSource {
  slug?: string;
  actions: CommandAction[];
}

export function deliveryActionSource(element: DeliveryTreeElement | undefined): ActionSource | null {
  return element?.kind === "delivery" ? { slug: element.item.slug, actions: element.item.actions } : null;
}

export async function pickCommandAction(source: ActionSource): Promise<CommandAction | undefined> {
  const items = source.actions.map((action) => ({
    label: action.command,
    description: action.window === "here" ? "This window" : `${action.window} window`,
    detail: action.reason ?? undefined,
    action,
  }));
  return (await vscode.window.showQuickPick(items, { title: source.slug ? `Actions for ${source.slug}` : "Session actions" }))?.action;
}