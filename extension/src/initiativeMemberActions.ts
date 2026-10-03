import type { CommandAction } from "./commandActions.js";
import type { DeliveryTreeModel } from "./deliveryTreeModel.js";
import type { InitiativeTreeElement } from "./initiativeTreePresentation.js";

export interface InitiativeMemberActionSource {
  slug: string;
  actions: CommandAction[];
}

export function initiativeMemberActionSource(
  element: InitiativeTreeElement | undefined,
  model: DeliveryTreeModel,
): InitiativeMemberActionSource | null {
  if (element?.kind !== "member" || element.groupKind !== "in-flight") return null;
  const slug = element.item.slug;
  const match = model.kind === "ready"
    ? model.groups.flatMap((group) => group.items).find((item) => item.slug === slug)
    : undefined;
  return { slug, actions: match?.actions ?? [] };
}
