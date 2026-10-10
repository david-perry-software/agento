import assert from "node:assert/strict";
import test from "node:test";

import { aggregateMetrics, deriveMetrics, parseArtifactLog, parseMergeLog } from "./delivery-metrics.mjs";

const DIR = "features/2026/10/x";

// One commit of `git log --format='%x00commit %H %cI' -p --unified=0` output.
// files: [{ path, add?: string[], del?: string[], created?: boolean, deleted?: boolean }]
function commit(sha, at, files) {
  const patches = files.map(({ path, add = [], del = [], created = false, deleted = false }) =>
    [
      `diff --git a/${path} b/${path}`,
      ...(created ? ["new file mode 100644"] : deleted ? ["deleted file mode 100644"] : []),
      "index 0000000..1111111 100644",
      created ? "--- /dev/null" : `--- a/${path}`,
      deleted ? "+++ /dev/null" : `+++ b/${path}`,
      `@@ -${del.length ? 1 : 0},${del.length} +${add.length ? 1 : 0},${add.length} @@`,
      ...del.map((l) => `-${l}`),
      ...add.map((l) => `+${l}`),
    ].join("\n"),
  );
  return `\u0000commit ${sha} ${at}\n\n${patches.join("\n")}\n`;
}

const roadmap = (add, del = [], extra = {}) => ({ path: `${DIR}/roadmap.md`, add, del, ...extra });
const review = (add, del = [], extra = {}) => ({ path: `${DIR}/review.md`, add, del, ...extra });
const status = (from, to) => roadmap([`status: ${to}`], from ? [`status: ${from}`] : [], { created: !from });

const record = (fields = {}) => ({ type: "feature", slug: "x", dir: DIR, roadmap: `${DIR}/roadmap.md`, branch: "feature/x", status: "complete", postShipPending: 0, ...fields });
const NOW = "2026-10-05T00:00:00Z";
const eventsOf = (text) => parseArtifactLog(text).get(DIR) ?? [];
const metricsOf = (text, fields, merged = new Map()) => deriveMetrics({ record: record(fields), events: eventsOf(text), merged, now: NOW, ref: "origin/main" });

const lifecycle = [
  commit("a1", "2026-10-01T10:00:00+00:00", [status(null, "planned")]),
  commit("a2", "2026-10-01T11:00:00+00:00", [status("planned", "in-progress")]),
  commit("a3", "2026-10-02T11:00:00+00:00", [status("in-progress", "in-review")]),
  commit("a4", "2026-10-02T13:00:00+00:00", [status("in-review", "complete")]),
].join("");

test("full lifecycle: planned → in-progress → in-review → complete with exact seconds", () => {
  const m = metricsOf(lifecycle);
  assert.deepEqual(m.phases, {
    planned: { start: "2026-10-01T10:00:00+00:00", end: "2026-10-01T11:00:00+00:00", seconds: 3600, open: false },
    build: { start: "2026-10-01T11:00:00+00:00", end: "2026-10-02T11:00:00+00:00", seconds: 86400, open: false },
    review: { start: "2026-10-02T11:00:00+00:00", end: "2026-10-02T13:00:00+00:00", seconds: 7200, open: false },
  });
  assert.deepEqual(m.cycle, { start: "2026-10-01T10:00:00+00:00", end: "2026-10-02T13:00:00+00:00", seconds: 97200, open: false });
  assert.deepEqual(m.events.map((e) => [e.sha, e.kind, e.value]), [["a1", "status", "planned"], ["a2", "status", "in-progress"], ["a3", "status", "in-review"], ["a4", "status", "complete"]]);
  assert.deepEqual(m.pauses, { count: 0, seconds: 0, open: false });
  assert.equal(m.reviewRounds, 0);
  assert.equal(m.ref, "origin/main");
  assert.deepEqual(m.warnings, ["no merge commit names feature/x"]);
});

test("a pause and its end: the interval up to the next status of another value", () => {
  const text = [
    commit("b1", "2026-10-01T10:00:00Z", [status(null, "planned")]),
    commit("b2", "2026-10-01T11:00:00Z", [status("planned", "in-progress")]),
    commit("b3", "2026-10-01T12:00:00Z", [status("in-progress", "paused")]),
    commit("b4", "2026-10-01T12:30:00Z", [status("paused", "in-progress")]),
  ].join("");
  const m = metricsOf(text, { status: "in-progress" });
  assert.deepEqual(m.pauses, { count: 1, seconds: 1800, open: false });
  assert.deepEqual(m.phases.build, { start: "2026-10-01T11:00:00Z", end: null, seconds: 3 * 86400 + 13 * 3600, open: true });
  assert.equal(m.phases.review, null);
  assert.equal(m.cycle.open, true);
});

test("an open pause is measured to now", () => {
  const text = [
    commit("c1", "2026-10-04T20:00:00Z", [status(null, "in-progress")]),
    commit("c2", "2026-10-04T22:00:00Z", [status("in-progress", "paused")]),
  ].join("");
  assert.deepEqual(metricsOf(text, { status: "paused" }).pauses, { count: 1, seconds: 7200, open: true });
});

test("two request-changes rounds then approve: re-reviews with an unchanged Verdict line still count", () => {
  const text = [
    lifecycle.split("\u0000commit a4")[0],
    commit("r1", "2026-10-02T11:10:00Z", [review(["# Review: x", "", "Verdict: request-changes"], [], { created: true })]),
    commit("r2", "2026-10-02T11:40:00Z", [review(["Reviewed again."], ["Reviewed once."])]),
    commit("r3", "2026-10-02T12:10:00Z", [review(["Verdict: approve"], ["Verdict: request-changes"])]),
    commit("a4", "2026-10-02T13:00:00+00:00", [status("in-review", "complete")]),
  ].join("");
  const m = metricsOf(text);
  assert.equal(m.reviewRounds, 2);
  assert.deepEqual(m.events.filter((e) => e.kind === "review").map((e) => [e.sha, e.value]), [["r1", "request-changes"], ["r2", "request-changes"], ["r3", "approve"]]);
});

test("a post-ship tick after the merge: latency from merged.at to the last tick", () => {
  const text = [
    lifecycle,
    commit("p1", "2026-10-02T15:00:00Z", [roadmap(["- [x] 2.1 (manual, post-ship) confirm the release — verify: x"], ["- [ ] 2.1 (manual, post-ship) confirm the release — verify: x"])]),
  ].join("");
  const merged = parseMergeLog("m1\t2026-10-02T13:30:00Z\tMerge pull request #7 from owner/feature/x\n");
  const m = metricsOf(text, {}, merged);
  assert.deepEqual(m.merged, { at: "2026-10-02T13:30:00Z", sha: "m1", pr: 7 });
  assert.deepEqual(m.postShip, { total: 1, ticked: 1, lastTickAt: "2026-10-02T15:00:00Z", latencySeconds: 5400, pending: false });
  assert.deepEqual(m.warnings, []);
  const pending = metricsOf(lifecycle, { postShipPending: 1 }, merged);
  assert.deepEqual(pending.postShip, { total: 1, ticked: 0, lastTickAt: null, latencySeconds: null, pending: true });
  // Without a merge commit the latency falls back to cycle.end.
  assert.equal(metricsOf(text).postShip.latencySeconds, 7200);
});

test("a roadmap created directly in-progress: phases.planned is null and cycle.start is the first event", () => {
  const text = [
    commit("d1", "2026-10-01T10:00:00Z", [status(null, "in-progress")]),
    commit("d2", "2026-10-01T12:00:00Z", [status("in-progress", "in-review")]),
    commit("d3", "2026-10-01T13:00:00Z", [status("in-review", "complete")]),
  ].join("");
  const m = metricsOf(text);
  assert.equal(m.phases.planned, null);
  assert.equal(m.cycle.start, "2026-10-01T10:00:00Z");
  assert.equal(m.cycle.seconds, 3 * 3600);
  assert.equal(m.phases.build.seconds, 7200);
});

test("a missing in-review: review is null, build is open while not complete and closed by complete", () => {
  const text = [
    commit("e1", "2026-10-04T10:00:00Z", [status(null, "planned")]),
    commit("e2", "2026-10-04T12:00:00Z", [status("planned", "in-progress")]),
  ].join("");
  const open = metricsOf(text, { status: "in-progress" });
  assert.equal(open.phases.review, null);
  assert.deepEqual(open.phases.build, { start: "2026-10-04T12:00:00Z", end: null, seconds: 12 * 3600, open: true });
  assert.deepEqual(open.warnings, []);
  const done = metricsOf(text + commit("e3", "2026-10-04T18:00:00Z", [status("in-progress", "complete")]));
  assert.equal(done.phases.review, null);
  assert.deepEqual(done.phases.build, { start: "2026-10-04T12:00:00Z", end: "2026-10-04T18:00:00Z", seconds: 6 * 3600, open: false });
  assert.deepEqual(done.warnings, ["no in-review transition", "no merge commit names feature/x"]);
});

test("a reopened delivery: the cycle ends at the final complete run and review never ends before it starts", () => {
  const text = [
    commit("h1", "2026-10-01T10:00:00Z", [status(null, "complete")]),
    commit("h2", "2026-10-01T11:00:00Z", [status("complete", "in-progress")]),
    commit("h3", "2026-10-01T12:00:00Z", [status("in-progress", "complete")]),
    commit("h4", "2026-10-01T13:00:00Z", [status("complete", "in-review")]),
    commit("h5", "2026-10-01T14:00:00Z", [status("in-review", "complete")]),
  ].join("");
  const m = metricsOf(text);
  assert.equal(m.phases.planned, null);
  assert.deepEqual(m.cycle, { start: "2026-10-01T10:00:00Z", end: "2026-10-01T14:00:00Z", seconds: 4 * 3600, open: false });
  assert.deepEqual(m.phases.build, { start: "2026-10-01T11:00:00Z", end: "2026-10-01T13:00:00Z", seconds: 7200, open: false });
  assert.deepEqual(m.phases.review, { start: "2026-10-01T13:00:00Z", end: "2026-10-01T14:00:00Z", seconds: 3600, open: false });
  const reopened = metricsOf(text.split("\u0000commit h5")[0], { status: "in-review" });
  assert.equal(reopened.cycle.open, true);
  assert.equal(reopened.phases.review.open, true);
});

test("two +status: lines in one commit are deduplicated", () => {
  const text = commit("f1", "2026-10-01T10:00:00Z", [roadmap(["status: planned", "status: planned"], [], { created: true })]);
  assert.deepEqual(eventsOf(text).map((e) => [e.sha, e.value]), [["f1", "planned"]]);
  // The same commit seen in two logs (default branch and branch-only) also dedupes.
  const twice = deriveMetrics({ record: record({ status: "planned" }), events: [...eventsOf(text), ...eventsOf(text)], now: NOW });
  assert.equal(twice.events.length, 1);
});

test("a quoted status value, other dirs, and deleted files parse as expected", () => {
  const other = "issues/2026/10/y/roadmap.md";
  const text = [
    commit("g1", "2026-10-01T10:00:00Z", [roadmap(['status: "in-progress"  # resumed'], [], { created: true }), { path: other, add: ["status: planned"], created: true }]),
    commit("g2", "2026-10-01T11:00:00Z", [review(["Verdict: approve"], [], { created: true })]),
    commit("g3", "2026-10-01T12:00:00Z", [review([], ["Verdict: approve"], { deleted: true })]),
  ].join("");
  const map = parseArtifactLog(text);
  assert.deepEqual(map.get(DIR).map((e) => [e.kind, e.value]), [["status", "in-progress"], ["review", "approve"]]);
  assert.deepEqual(map.get("issues/2026/10/y").map((e) => e.value), ["planned"]);
  assert.deepEqual([...parseArtifactLog("").keys()], []);
});

test("a merge log ignores non-matching subjects and keeps a branch's first merge", () => {
  const merged = parseMergeLog([
    "m3\t2026-10-03T10:00:00Z\tMerge pull request #9 from owner/feature/x",
    "m2\t2026-10-02T10:00:00Z\tMerge remote-tracking branch 'origin/main' into feature/x",
    "m1\t2026-10-01T10:00:00Z\tMerge pull request #7 from owner/feature/x",
    "m0\t2026-09-30T10:00:00Z\tMerge pull request #6 from owner/issue/y-z",
    "garbage",
    "",
  ].join("\n"));
  assert.deepEqual([...merged.entries()], [
    ["feature/x", { at: "2026-10-01T10:00:00Z", sha: "m1", pr: 7 }],
    ["issue/y-z", { at: "2026-09-30T10:00:00Z", sha: "m0", pr: 6 }],
  ]);
});

test("no history: every derived field is nullable and warned about", () => {
  const m = metricsOf("", { status: "complete" });
  assert.deepEqual([m.phases, m.cycle, m.merged], [{ planned: null, build: null, review: null }, null, null]);
  assert.deepEqual(m.warnings, [`no status transitions for ${DIR}/roadmap.md on origin/main`, "no merge commit names feature/x"]);
});

const item = (fields) => ({
  status: "complete",
  phases: { planned: null, build: null, review: null },
  cycle: null,
  reviewRounds: 0,
  pauses: { count: 0, seconds: 0, open: false },
  postShip: { total: 0, ticked: 0, lastTickAt: null, latencySeconds: null, pending: false },
  ...fields,
});
const closed = (seconds) => ({ start: "s", end: "e", seconds, open: false });
const open = (seconds) => ({ start: "s", end: null, seconds, open: true });

test("aggregate medians: odd and even sample counts, open intervals excluded, null without a sample", () => {
  const odd = aggregateMetrics([
    item({ phases: { planned: closed(10), build: closed(100), review: null }, cycle: closed(300), reviewRounds: 2 }),
    item({ phases: { planned: closed(30), build: closed(300), review: null }, cycle: closed(100), reviewRounds: 0 }),
    item({ phases: { planned: closed(20), build: open(9999), review: null }, cycle: closed(200), reviewRounds: 1, pauses: { count: 1, seconds: 60, open: false } }),
  ]);
  assert.deepEqual(odd, {
    count: 3,
    complete: 3,
    median: { plannedSeconds: 20, buildSeconds: 200, reviewSeconds: null, cycleSeconds: 200, pauseSeconds: 60, reviewRounds: 1, postShipLatencySeconds: null },
  });
  const even = aggregateMetrics([
    item({ cycle: closed(100), reviewRounds: 1, postShip: { total: 1, ticked: 1, lastTickAt: "t", latencySeconds: 40, pending: false } }),
    item({ cycle: closed(300), reviewRounds: 2, postShip: { total: 1, ticked: 1, lastTickAt: "t", latencySeconds: 80, pending: false } }),
    item({ status: "in-progress", cycle: open(5000), reviewRounds: 7, pauses: { count: 1, seconds: 500, open: true } }),
  ]);
  assert.deepEqual(even.median, { plannedSeconds: null, buildSeconds: null, reviewSeconds: null, cycleSeconds: 200, pauseSeconds: null, reviewRounds: 1.5, postShipLatencySeconds: 60 });
  assert.deepEqual(even.count, 3);
  assert.deepEqual(even.complete, 2);
  assert.deepEqual(aggregateMetrics([]), { count: 0, complete: 0, median: { plannedSeconds: null, buildSeconds: null, reviewSeconds: null, cycleSeconds: null, pauseSeconds: null, reviewRounds: null, postShipLatencySeconds: null } });
});
