import assert from "node:assert/strict";
import test from "node:test";

import { createDeliveryTreeError, createDeliveryTreeModel } from "../../src/deliveryTreeModel.js";

const delivery = {
  type: "feature",
  slug: "deliveries-tree",
  lifecycle: "building",
  status: "in-progress",
  roadmap: "features/2026/09/deliveries-tree/roadmap.md",
  steps: { ticked: 2, total: 8 },
  initiative: "agento-extension",
  owner: { path: "/repo/worktree", role: "build", dirPrefix: "plan", id: "123" },
  workspace: { path: "/repo/worktree.code-workspace", exists: true },
  companion: {
    path: "/repo/docs-worktree",
    branch: "feature/deliveries-tree",
    detached: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    registered: true,
  },
  pr: { number: 51, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", url: "https://example.test/pr/51" },
  companionPr: { number: 8, state: "OPEN", isDraft: true, mergeStateStatus: "CLEAN", url: "https://example.test/pr/8" },
  allowed: ["/agento continue", "/agento build-feature deliveries-tree", "/agento ap deliveries-tree"],
  elsewhere: [{ command: "/agento ship deliveries-tree", window: "primary", reason: "ship from primary" }],
};

function response(items: unknown[], warnings: string[] = []) {
  return {
    status: "ok",
    lifecycles: ["planned", "building", "in-review", "shipped"],
    warnings,
    items,
  };
}

test("delivery model preserves lifecycle ordering and omits empty groups", () => {
  const model = createDeliveryTreeModel(
    response([
      { ...delivery, slug: "done", lifecycle: "shipped", status: "complete" },
      delivery,
    ]),
  );

  assert.equal(model.kind, "ready");
  if (model.kind !== "ready") {
    return;
  }
  assert.deepEqual(model.groups.map((group) => group.lifecycle), ["building", "shipped"]);
  assert.deepEqual(model.groups.map((group) => group.label), ["Building", "Shipped"]);
  assert.deepEqual(model.groups.flatMap((group) => group.items.map((item) => item.slug)), ["deliveries-tree", "done"]);
});

test("delivery model includes compact metadata and complete tooltip fields", () => {
  const model = createDeliveryTreeModel(response([delivery]));

  assert.equal(model.kind, "ready");
  if (model.kind !== "ready") {
    return;
  }
  const item = model.groups[0]?.items[0];
  assert.ok(item);
  assert.equal(item.description, "feature | 2/8 | in-progress | PR #51 draft");
  assert.deepEqual(item.actions.map((action) => action.command), [
    "/agento continue",
    "/agento build-feature deliveries-tree",
    "/agento ap deliveries-tree",
    "/agento ship deliveries-tree",
  ]);
  for (const text of [
    "Roadmap: features/2026/09/deliveries-tree/roadmap.md",
    "PR: #51 OPEN draft CLEAN https://example.test/pr/51",
    "Companion PR: #8 OPEN draft CLEAN https://example.test/pr/8",
    "Owner: build/plan/123 at /repo/worktree",
    "Workspace: /repo/worktree.code-workspace (exists)",
    "Companion: feature/deliveries-tree at /repo/docs-worktree (registered, attached, clean, ahead 0, behind 0)",
    "Initiative: agento-extension",
  ]) {
    assert.match(item.tooltip, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("delivery model renders null PR and optional metadata explicitly", () => {
  const model = createDeliveryTreeModel(
    response([{ ...delivery, steps: null, pr: null, companionPr: null, owner: null, workspace: null, companion: null, initiative: null }]),
  );

  assert.equal(model.kind, "ready");
  if (model.kind !== "ready") {
    return;
  }
  const item = model.groups[0]?.items[0];
  assert.ok(item);
  assert.equal(item.description, "feature | no steps | in-progress | PR none");
  assert.match(item.tooltip, /PR: none/);
  assert.match(item.tooltip, /Companion PR: none/);
  assert.match(item.tooltip, /Initiative: none/);
});

test("delivery model preserves CLI warnings", () => {
  const model = createDeliveryTreeModel(response([delivery], ["gh unavailable", "preview stale"]));

  assert.deepEqual(model.warnings, ["gh unavailable", "preview stale"]);
});

test("delivery model returns an explicit empty result", () => {
  assert.deepEqual(createDeliveryTreeModel(response([])), {
    kind: "empty",
    message: "No deliveries found.",
    warnings: [],
  });
});

test("delivery model returns an explicit malformed input error", () => {
  const model = createDeliveryTreeModel({ status: "ok", lifecycles: ["building"], warnings: [], items: [{ slug: "missing-fields" }] });

  assert.equal(model.kind, "error");
  if (model.kind === "error") {
    assert.match(model.message, /^Invalid status --pr response: type must be a non-empty string$/);
  }
});

test("delivery model returns an explicit CLI error", () => {
  assert.deepEqual(createDeliveryTreeError(new Error("exit 3")), {
    kind: "error",
    message: "Unable to load deliveries: exit 3",
    warnings: [],
  });
});