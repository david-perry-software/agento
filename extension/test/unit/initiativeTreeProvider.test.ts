import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { InitiativeTreeModel } from "../../src/initiativeTreeModel.js";
import { initiativeTreeChildren, initiativeTreeItemSpec } from "../../src/initiativeTreePresentation.js";

const model: InitiativeTreeModel = {
  kind: "ready",
  items: [{
    slug: "agento-extension",
    dir: "initiatives/2026/09/agento-extension",
    breakdown: "initiatives/2026/09/agento-extension/breakdown.md",
    valid: true,
    done: false,
    description: "1/2 complete | 0 in flight | 1 ready",
    tooltip: "Next: initiatives-tree",
    diagnostics: [{ kind: "anomaly", message: "old: merged-but-not-complete (feature/old)" }],
    groups: [{
      kind: "ready",
      label: "Ready",
      items: [{
        slug: "initiatives-tree",
        state: "unplanned",
        roadmap: null,
        branch: "feature/initiatives-tree",
        wave: 2,
        computedWave: 2,
        blockedBy: [],
        ready: true,
        description: "unplanned | wave 2 | ready",
        tooltip: "Ready: yes",
      }],
    }],
  }],
};

test("initiative provider presentation builds initiative, diagnostic, group, and member hierarchy", () => {
  const roots = initiativeTreeChildren(model);
  assert.deepEqual(roots.map((element) => element.kind), ["initiative"]);
  const children = initiativeTreeChildren(model, roots[0]);
  assert.deepEqual(children.map((element) => element.kind), ["diagnostic", "group"]);
  const members = initiativeTreeChildren(model, children[1]);
  assert.deepEqual(members.map((element) => element.kind), ["member"]);
  assert.equal(members[0]?.kind === "member" ? members[0].initiativeSlug : undefined, "agento-extension");
  assert.deepEqual(initiativeTreeChildren(model, members[0]), []);
});

test("initiative provider presentation assigns context values and icons", () => {
  const initiative = initiativeTreeChildren(model)[0]!;
  const [diagnostic, group] = initiativeTreeChildren(model, initiative);
  const member = initiativeTreeChildren(model, group)[0]!;

  assert.deepEqual(
    [initiative, diagnostic, group, member].map((element) => {
      const spec = initiativeTreeItemSpec(element, "/artifacts");
      return [spec.contextValue, spec.icon];
    }),
    [
      ["agento.initiative", "type-hierarchy"],
      ["agento.initiativeDiagnostic.anomaly", "warning"],
      ["agento.initiativeGroup.ready", "play-circle"],
      ["agento.initiativeMember.ready", "play-circle"],
    ],
  );
});

test("initiative provider presentation resolves CLI breakdown paths for initiative and member commands", () => {
  const initiative = initiativeTreeChildren(model)[0]!;
  const group = initiativeTreeChildren(model, initiative)[1]!;
  const member = initiativeTreeChildren(model, group)[0]!;
  const expected = path.resolve("/artifacts", "initiatives/2026/09/agento-extension/breakdown.md");

  assert.deepEqual(initiativeTreeItemSpec(initiative, "/artifacts").command, {
    id: "agento.openBreakdown",
    title: "Open Breakdown",
    path: expected,
  });
  assert.deepEqual(initiativeTreeItemSpec(member, "/artifacts").command, {
    id: "agento.openBreakdown",
    title: "Open Breakdown",
    path: expected,
  });
});

test("initiative provider presentation collapses initiatives and groups with stable id parts", () => {
  const initiative = initiativeTreeChildren(model)[0]!;
  const [diagnostic, group] = initiativeTreeChildren(model, initiative);
  const member = initiativeTreeChildren(model, group)[0]!;

  assert.deepEqual(
    [initiative, group, diagnostic, member].map((element) => {
      const spec = initiativeTreeItemSpec(element, "/artifacts");
      return [spec.collapsible, spec.idParts];
    }),
    [
      ["collapsed", ["initiative", "agento-extension"]],
      ["collapsed", ["group", "agento-extension", "ready"]],
      ["none", undefined],
      ["none", undefined],
    ],
  );
});

type ReadyModel = Extract<InitiativeTreeModel, { kind: "ready" }>;
type Item = ReadyModel["items"][number];

function initiative(slug: string, done: boolean, valid: boolean): Item {
  const base = (model as ReadyModel).items[0]!;
  return {
    ...base,
    slug,
    dir: `initiatives/2026/09/${slug}`,
    breakdown: `initiatives/2026/09/${slug}/breakdown.md`,
    done,
    valid,
    diagnostics: valid ? [] : [{ kind: "error", message: `${slug}: breakdown error` }],
  };
}

function slugsOf(elements: ReturnType<typeof initiativeTreeChildren>): string[] {
  return elements.map((element) => {
    if (element.kind === "initiative") return element.item.slug;
    if (element.kind === "completed") return `completed:${element.items.map((item) => item.slug).join(",")}`;
    return element.kind;
  });
}

test("initiative provider presentation moves done and valid initiatives into a trailing Completed folder", () => {
  const mixed: InitiativeTreeModel = {
    kind: "ready",
    items: [
      initiative("shipped-one", true, true),
      initiative("active", false, true),
      initiative("done-invalid", true, false),
      initiative("shipped-two", true, true),
    ],
  };
  const roots = initiativeTreeChildren(mixed);
  assert.deepEqual(slugsOf(roots), ["active", "done-invalid", "completed:shipped-one,shipped-two"]);
  assert.deepEqual(slugsOf(initiativeTreeChildren(mixed, roots[2])), ["shipped-one", "shipped-two"]);
  assert.deepEqual(
    initiativeTreeChildren(mixed, roots[1]).map((element) => element.kind),
    ["diagnostic", "group"],
  );
});

test("initiative provider presentation shows only the folder when all are done and no folder when none are", () => {
  const allDone: InitiativeTreeModel = {
    kind: "ready",
    items: [initiative("a", true, true), initiative("b", true, true)],
  };
  assert.deepEqual(slugsOf(initiativeTreeChildren(allDone)), ["completed:a,b"]);

  const noneDone: InitiativeTreeModel = {
    kind: "ready",
    items: [initiative("a", false, true), initiative("b", true, false)],
  };
  assert.deepEqual(slugsOf(initiativeTreeChildren(noneDone)), ["a", "b"]);
});

test("initiative provider presentation renders the Completed folder collapsed with a stable id", () => {
  const twoDone: InitiativeTreeModel = {
    kind: "ready",
    items: [initiative("a", true, true), initiative("b", true, true)],
  };
  const folder = initiativeTreeChildren(twoDone)[0]!;
  assert.deepEqual(initiativeTreeItemSpec(folder, "/artifacts"), {
    label: "Completed (2)",
    collapsible: "collapsed",
    idParts: ["completed"],
    contextValue: "agento.initiativesCompleted",
    icon: "archive",
    tooltip: "2 completed initiatives",
  });

  const oneDone: InitiativeTreeModel = { kind: "ready", items: [initiative("a", true, true)] };
  const single = initiativeTreeItemSpec(initiativeTreeChildren(oneDone)[0]!, "/artifacts");
  assert.equal(single.label, "Completed (1)");
  assert.equal(single.tooltip, "1 completed initiative");
  assert.equal(single.command, undefined);
});

test("initiative provider presentation renders nested completed initiatives like root ones", () => {
  const item = initiative("shipped", true, true);
  const nested = initiativeTreeChildren(
    { kind: "ready", items: [item] },
    initiativeTreeChildren({ kind: "ready", items: [item] })[0],
  )[0]!;
  const root = { kind: "initiative", item } as const;
  const emptyModel: InitiativeTreeModel = { kind: "ready", items: [] };

  assert.deepEqual(nested, root);
  assert.deepEqual(initiativeTreeItemSpec(nested, "/artifacts"), initiativeTreeItemSpec(root, "/artifacts"));
  assert.deepEqual(initiativeTreeChildren(emptyModel, nested), initiativeTreeChildren(emptyModel, root));
});

test("initiative provider presentation renders explicit empty and error rows", () => {
  for (const [kind, message, contextValue, icon] of [
    ["empty", "No initiatives found.", "agento.empty", "info"],
    ["error", "Unable to load initiatives.", "agento.error", "error"],
  ] as const) {
    const element = initiativeTreeChildren({ kind, message })[0]!;
    const spec = initiativeTreeItemSpec(element, "/artifacts");
    assert.equal(spec.label, message);
    assert.equal(spec.contextValue, contextValue);
    assert.equal(spec.icon, icon);
    assert.equal(spec.collapsible, "none");
    assert.equal(spec.idParts, undefined);
  }
});