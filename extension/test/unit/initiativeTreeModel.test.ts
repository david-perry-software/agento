import assert from "node:assert/strict";
import test from "node:test";

import { createInitiativeTreeError, createInitiativeTreeModel } from "../../src/initiativeTreeModel.js";

const listItem = {
  slug: "agento-extension",
  dir: "initiatives/2026/09/agento-extension",
  created: "2026-09-01",
  lastUpdated: "2026-09-19",
  total: 4,
  complete: 1,
  inFlight: 1,
  ready: 1,
  done: false,
  valid: true,
};

function member(slug: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    state,
    roadmap: state === "unplanned" ? null : `features/2026/09/${slug}/roadmap.md`,
    branch: `feature/${slug}`,
    artifactPr: null,
    requires: [],
    recommendedAfter: [],
    wave: 1,
    computedWave: 1,
    order: 0,
    blockedBy: [],
    ready: false,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    errors: [],
    features: [
      member("ready", "unplanned", { ready: true, order: 0 }),
      member("building", "in-progress", { order: 1 }),
      member("blocked", "unplanned", { blockedBy: ["building"], wave: 2, computedWave: 2, order: 2 }),
      member("done", "complete", { order: 3 }),
    ],
    waves: [["ready", "building", "done"], ["blocked"]],
    next: "ready",
    done: false,
    initiative: {
      slug: "agento-extension",
      dir: "initiatives/2026/09/agento-extension",
      breakdown: "initiatives/2026/09/agento-extension/breakdown.md",
      created: "2026-09-01",
      lastUpdated: "2026-09-19",
    },
    anomalies: [],
    ...overrides,
  };
}

function model(listOverrides: Record<string, unknown> = {}, detailOverrides: Record<string, unknown> = {}) {
  return createInitiativeTreeModel(
    { status: "ok", initiativesRoot: "initiatives", items: [{ ...listItem, ...listOverrides }] },
    new Map([["agento-extension", detail(detailOverrides)]]),
  );
}

test("initiative model validates list and detail responses and preserves CLI initiative order", () => {
  const second = { ...listItem, slug: "workflow", dir: "initiatives/2026/09/workflow" };
  const secondDetail = detail({ initiative: { ...detail().initiative, slug: "workflow", dir: second.dir } });
  const result = createInitiativeTreeModel(
    { status: "ok", items: [second, listItem] },
    new Map([["workflow", secondDetail], ["agento-extension", detail()]]),
  );

  assert.equal(result.kind, "ready");
  if (result.kind === "ready") {
    assert.deepEqual(result.items.map((item) => item.slug), ["workflow", "agento-extension"]);
  }
});

test("initiative model applies group precedence and preserves feature order", () => {
  const result = model({}, {
    features: [
      member("planned-ready", "planned", { ready: true, order: 0 }),
      member("ready-b", "unplanned", { ready: true, order: 1 }),
      member("ready-a", "unplanned", { ready: true, order: 2 }),
      member("blocked", "unplanned", { blockedBy: ["planned-ready"], order: 3 }),
      member("done", "complete", { ready: true, order: 4 }),
    ],
  });

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.deepEqual(result.items[0]?.groups.map((group) => group.label), ["Ready", "In flight", "Blocked", "Complete"]);
  assert.deepEqual(result.items[0]?.groups.map((group) => group.items.map((item) => item.slug)), [
    ["ready-b", "ready-a"],
    ["planned-ready"],
    ["blocked"],
    ["done"],
  ]);
});

test("initiative model formats counts and member metadata without deriving dependencies", () => {
  const result = model();

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const initiative = result.items[0];
  const ready = initiative?.groups[0]?.items[0];
  const blocked = initiative?.groups[2]?.items[0];
  assert.equal(initiative?.description, "1/4 complete | 1 in flight | 1 ready");
  assert.match(initiative?.tooltip ?? "", /Next: ready/);
  assert.equal(ready?.description, "unplanned | wave 1 | ready");
  assert.match(ready?.tooltip ?? "", /Ready: yes\nNext: yes/);
  assert.equal(blocked?.description, "unplanned | wave 2 | blocked by building");
  assert.match(blocked?.tooltip ?? "", /Blocked by: building/);
});

test("initiative model retains invalid errors and anomalies as diagnostics", () => {
  const result = model({ valid: false }, {
    status: "invalid",
    errors: ["dependency cycle among: a, b"],
    anomalies: [{ slug: "building", kind: "merged-but-not-complete", branch: "feature/building" }],
  });

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.items[0]?.valid, false);
  assert.match(result.items[0]?.description ?? "", /invalid/);
  assert.deepEqual(result.items[0]?.diagnostics, [
    { kind: "error", message: "dependency cycle among: a, b" },
    { kind: "anomaly", message: "building: merged-but-not-complete (feature/building)" },
  ]);
});

test("initiative model keeps healthy initiatives when one detail is malformed", () => {
  const broken = { ...listItem, slug: "broken", dir: "initiatives/2026/09/broken" };
  const result = createInitiativeTreeModel(
    { status: "ok", items: [broken, listItem] },
    new Map<string, unknown>()
      .set("broken", { status: "ok" })
      .set("agento-extension", detail()),
  );

  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.deepEqual(result.items.map((item) => item.valid), [false, true]);
  assert.match(result.items[0]?.diagnostics[0]?.message ?? "", /initiative must be an object/);
  assert.equal(result.items[1]?.groups.length, 4);
});

test("initiative model returns explicit empty and malformed list states", () => {
  assert.deepEqual(createInitiativeTreeModel({ status: "ok", items: [] }, new Map()), {
    kind: "empty",
    message: "No initiatives found.",
  });
  assert.deepEqual(createInitiativeTreeModel({ status: "ok", items: [{ slug: "missing-fields" }] }, new Map()), {
    kind: "error",
    message: "Invalid initiative list response: dir must be a non-empty string",
  });
  assert.deepEqual(createInitiativeTreeError(new Error("exit 3")), {
    kind: "error",
    message: "Unable to load initiatives: exit 3",
  });
});