import assert from "node:assert/strict";
import test from "node:test";

import { formatDashboardTimings, splitDashboardDocument } from "../../src/dashboardDocument.js";

const session = { status: "ok", role: "primary" };
const doctor = { status: "warn", checks: [] };
const deliveries = { status: "ok", items: [], resumable: [] };
const list = { status: "ok", items: [{ slug: "alpha" }, { slug: "beta" }] };
const alpha = { status: "ok", features: [] };
const beta = { status: "invalid", features: [] };

function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    session,
    doctor,
    deliveries,
    initiatives: { list, details: { alpha, beta } },
    timings: { session: 3, doctor: 40, deliveries: 5, initiatives: 2, total: 60 },
    root: "/fixture",
    configSource: null,
    ...overrides,
  };
}

test("splitDashboardDocument returns each section as its standalone document", () => {
  const split = splitDashboardDocument(dashboard());
  assert.equal(split.session, session);
  assert.equal(split.doctor, doctor);
  assert.equal(split.deliveries, deliveries);
  assert.ok(!(split.initiatives instanceof Error));
  if (split.initiatives instanceof Error) return;
  assert.equal(split.initiatives.list, list);
  assert.deepEqual([...split.initiatives.details], [["alpha", alpha], ["beta", beta]]);
  assert.deepEqual(split.timings, { session: 3, doctor: 40, deliveries: 5, initiatives: 2, total: 60 });
});

test("splitDashboardDocument turns a per-section error into an Error and leaves the others intact", () => {
  const split = splitDashboardDocument(dashboard({ deliveries: { status: "error", message: "EACCES: roadmap.md" } }));
  assert.ok(split.deliveries instanceof Error);
  assert.equal((split.deliveries as Error).message, "EACCES: roadmap.md");
  assert.equal(split.session, session);
  assert.equal(split.doctor, doctor);
  assert.ok(!(split.initiatives instanceof Error));

  const initiatives = splitDashboardDocument(dashboard({ initiatives: { status: "error", message: "breakdown unreadable" } })).initiatives;
  assert.ok(initiatives instanceof Error);
  assert.equal(initiatives.message, "breakdown unreadable");
  const unnamed = splitDashboardDocument(dashboard({ doctor: { status: "error" } })).doctor;
  assert.ok(unnamed instanceof Error);
  assert.equal(unnamed.message, "dashboard.doctor failed");
});

test("splitDashboardDocument rejects a malformed envelope", () => {
  assert.throws(() => splitDashboardDocument(null), /status must be ok/);
  assert.throws(() => splitDashboardDocument({ status: "usage-error", message: "unknown command dashboard" }), /status must be ok/);
  assert.throws(() => splitDashboardDocument(dashboard({ session: undefined })), /dashboard\.session must be an object/);
  assert.throws(() => splitDashboardDocument(dashboard({ initiatives: { list, details: [] } })), /initiatives\.details must be an object/);
});

test("splitDashboardDocument keys details by initiativeSlugs(list), dropping slugs the list does not name", () => {
  const split = splitDashboardDocument(dashboard({ initiatives: { list: { status: "ok", items: [{ slug: "beta" }, { slug: "gamma" }] }, details: { alpha, beta } } }));
  assert.ok(!(split.initiatives instanceof Error));
  if (split.initiatives instanceof Error) return;
  assert.deepEqual([...split.initiatives.details.keys()], ["beta"]);
  assert.equal(splitDashboardDocument(dashboard({ timings: undefined })).timings, null);
});

test("splitDashboardDocument carries the metrics section: present, error, and absent", () => {
  const metrics = { status: "ok", items: [], aggregate: { count: 0 } };
  assert.equal(splitDashboardDocument(dashboard({ metrics })).metrics, metrics);
  const failed = splitDashboardDocument(dashboard({ metrics: { status: "error", message: "git log failed" } }));
  assert.ok(failed.metrics instanceof Error);
  assert.equal((failed.metrics as Error).message, "git log failed");
  assert.equal(failed.session, session);
  assert.ok(!(failed.deliveries instanceof Error));
  assert.equal(splitDashboardDocument(dashboard()).metrics, null, "an older CLI without the section");
  assert.throws(() => splitDashboardDocument(dashboard({ metrics: "bad" })), /dashboard\.metrics must be an object/);
});

test("formatDashboardTimings renders one output-channel line", () => {
  assert.equal(formatDashboardTimings({ session: 3, total: 60 }), "dashboard timings: session 3 ms, total 60 ms");
  assert.equal(formatDashboardTimings(null), null);
  assert.equal(formatDashboardTimings({}), null);
});
