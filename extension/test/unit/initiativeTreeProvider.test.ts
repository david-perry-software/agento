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
  }
});