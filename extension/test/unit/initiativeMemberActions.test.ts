// Regression test for #82 initiative-member-play-button
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { CommandAction } from "../../src/commandActions.js";
import type { DeliveryTreeItem, DeliveryTreeModel } from "../../src/deliveryTreeModel.js";
import { initiativeMemberActionSource } from "../../src/initiativeMemberActions.js";
import type { InitiativeGroupKind, InitiativeMemberItem } from "../../src/initiativeTreeModel.js";
import type { InitiativeTreeElement } from "../../src/initiativeTreePresentation.js";

const buildActions: CommandAction[] = [
  { command: "/agento build-feature building-delivery", window: "here", reason: null },
  { command: "/agento ship building-delivery", window: "primary", reason: "after approval" },
];

function delivery(slug: string, actions: CommandAction[]): DeliveryTreeItem {
  return {
    type: "feature",
    slug,
    lifecycle: "building",
    status: "in-progress",
    roadmap: `features/2026/10/${slug}/roadmap.md`,
    description: "",
    tooltip: "",
    actions,
  };
}

const deliveries: DeliveryTreeModel = {
  kind: "ready",
  groups: [
    { lifecycle: "planned", label: "Planned", items: [delivery("planned-delivery", [])] },
    { lifecycle: "building", label: "Building", items: [delivery("building-delivery", buildActions)] },
  ],
  warnings: [],
};

function member(slug: string, groupKind: InitiativeGroupKind, state = "in-progress"): InitiativeTreeElement {
  const item: InitiativeMemberItem = {
    slug,
    state,
    roadmap: null,
    branch: `feature/${slug}`,
    wave: 1,
    computedWave: 1,
    blockedBy: [],
    ready: groupKind === "ready",
    description: "",
    tooltip: "",
  };
  return { kind: "member", item, groupKind, initiativeSlug: "agento-extension" };
}

test("manifest contributes an inline play action on in-flight initiative members", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: { menus: { "view/item/context": Array<{ command: string; when: string; group: string }> } };
  };

  assert.ok(manifest.contributes.menus["view/item/context"].some((entry) =>
    entry.command === "agento.showActions"
    && entry.when === "view == agento.initiatives && viewItem == agento.initiativeMember.in-flight"
    && entry.group === "inline"));
});

test("in-flight member resolves to the matching delivery's actions", () => {
  assert.deepEqual(initiativeMemberActionSource(member("building-delivery", "in-flight"), deliveries), {
    slug: "building-delivery",
    actions: buildActions,
  });
});

test("in-flight member without a matching delivery resolves to empty actions", () => {
  assert.deepEqual(initiativeMemberActionSource(member("missing-delivery", "in-flight"), deliveries), {
    slug: "missing-delivery",
    actions: [],
  });
  assert.deepEqual(
    initiativeMemberActionSource(member("building-delivery", "in-flight"), { kind: "error", message: "boom", warnings: [] }),
    { slug: "building-delivery", actions: [] },
  );
});

test("other members and non-member elements resolve to null", () => {
  assert.equal(initiativeMemberActionSource(member("building-delivery", "ready", "unplanned"), deliveries), null);
  assert.equal(initiativeMemberActionSource(member("building-delivery", "blocked", "unplanned"), deliveries), null);
  assert.equal(initiativeMemberActionSource(member("building-delivery", "complete", "complete"), deliveries), null);
  assert.equal(initiativeMemberActionSource({ kind: "message", label: "No initiatives", severity: "empty" }, deliveries), null);
  assert.equal(initiativeMemberActionSource(undefined, deliveries), null);
});
