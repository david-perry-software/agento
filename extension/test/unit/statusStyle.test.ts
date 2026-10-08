import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { healthStyle, initiativeGroupStyle, lifecycleStyle, STATUS_COLOR_IDS } from "../../src/statusStyle.js";

test("lifecycleStyle maps every delivery lifecycle to a status glyph and color", () => {
  assert.deepEqual(
    ["planned", "building", "paused", "in-review", "approved", "shipped", "post-ship-pending"].map(lifecycleStyle),
    [
      { icon: "circle-large-outline", color: "agento.status.planned" },
      { icon: "sync", color: "agento.status.building" },
      { icon: "debug-pause", color: "agento.status.paused" },
      { icon: "eye", color: "agento.status.inReview" },
      { icon: "check", color: "agento.status.approved" },
      { icon: "pass-filled", color: "agento.status.shipped" },
      { icon: "clock", color: "agento.status.postShipPending" },
    ],
  );
});

test("lifecycleStyle falls back to an uncolored folder for unknown lifecycles", () => {
  for (const lifecycle of ["no-delivery", "someday", "", "constructor", "toString"]) {
    assert.deepEqual(lifecycleStyle(lifecycle), { icon: "folder" });
  }
});

test("initiativeGroupStyle maps every member group", () => {
  assert.deepEqual(
    (["ready", "in-flight", "blocked", "complete"] as const).map(initiativeGroupStyle),
    [
      { icon: "play-circle", color: "agento.status.ready" },
      { icon: "sync", color: "agento.status.inFlight" },
      { icon: "lock", color: "agento.status.blocked" },
      { icon: "pass-filled", color: "agento.status.complete" },
    ],
  );
});

test("healthStyle maps ok and warn and treats anything else as a failure", () => {
  assert.deepEqual(healthStyle("ok"), { icon: "pass", color: "agento.health.ok" });
  assert.deepEqual(healthStyle("warn"), { icon: "warning", color: "agento.health.warn" });
  for (const status of ["fail", "error", ""]) {
    assert.deepEqual(healthStyle(status), { icon: "error", color: "agento.health.fail" });
  }
});

test("returned styles are copies callers cannot use to mutate the mapping", () => {
  lifecycleStyle("planned").color = "mutated";
  initiativeGroupStyle("ready").icon = "mutated";
  healthStyle("ok").color = "mutated";
  assert.equal(lifecycleStyle("planned").color, "agento.status.planned");
  assert.equal(initiativeGroupStyle("ready").icon, "play-circle");
  assert.equal(healthStyle("ok").color, "agento.health.ok");
});

test("every bundled CLI lifecycle except no-delivery has a colored style", async () => {
  const { LIFECYCLES } = (await import(pathToFileURL(path.resolve("cli/session-state.mjs")).href)) as {
    LIFECYCLES: string[];
  };
  assert.ok(LIFECYCLES.includes("no-delivery"));
  for (const lifecycle of LIFECYCLES.filter((value) => value !== "no-delivery")) {
    const style = lifecycleStyle(lifecycle);
    assert.ok(style.color, `${lifecycle} has no color`);
    assert.ok(STATUS_COLOR_IDS.includes(style.color), `${lifecycle} color is not in STATUS_COLOR_IDS`);
  }
});

test("STATUS_COLOR_IDS lists every emitted color id exactly once", () => {
  assert.deepEqual([...STATUS_COLOR_IDS].sort(), [
    "agento.health.fail",
    "agento.health.ok",
    "agento.health.warn",
    "agento.status.approved",
    "agento.status.blocked",
    "agento.status.building",
    "agento.status.complete",
    "agento.status.inFlight",
    "agento.status.inReview",
    "agento.status.paused",
    "agento.status.planned",
    "agento.status.postShipPending",
    "agento.status.ready",
    "agento.status.shipped",
  ]);
});

test("the manifest declares exactly the emitted agento colors, each with all four theme defaults", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: { colors?: Array<{ id: string; description?: string; defaults?: Record<string, string> }> };
  };
  const declared = (manifest.contributes.colors ?? []).filter((color) => color.id.startsWith("agento."));
  const expectedDefaults: Record<string, string> = {
    "agento.status.planned": "charts.blue",
    "agento.status.ready": "charts.blue",
    "agento.status.building": "charts.yellow",
    "agento.status.inFlight": "charts.yellow",
    "agento.health.warn": "charts.yellow",
    "agento.status.paused": "charts.orange",
    "agento.status.postShipPending": "charts.orange",
    "agento.status.inReview": "charts.purple",
    "agento.status.approved": "charts.green",
    "agento.status.shipped": "charts.green",
    "agento.status.complete": "charts.green",
    "agento.health.ok": "charts.green",
    "agento.status.blocked": "charts.red",
    "agento.health.fail": "charts.red",
  };

  assert.deepEqual(declared.map((color) => color.id).sort(), [...STATUS_COLOR_IDS].sort());
  for (const color of declared) {
    assert.ok(color.description, `${color.id} has no description`);
    for (const theme of ["dark", "light", "highContrast", "highContrastLight"]) {
      assert.equal(color.defaults?.[theme], expectedDefaults[color.id], `${color.id} ${theme}`);
    }
  }
});
