import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  healthStyle,
  initiativeGroupStyle,
  lifecycleStyle,
  ROLE_FOREGROUND_COLOR,
  roleBannerColor,
  STATUS_COLOR_IDS,
} from "../../src/statusStyle.js";

const ROLE_DEFAULTS: Record<string, string> = {
  "agento.role.primary": "#0063B1",
  "agento.role.plan": "#7B2CBF",
  "agento.role.build": "#1E7B34",
  "agento.role.freehand": "#00796B",
  "agento.role.unmanaged": "#C62828",
  "agento.role.unavailable": "#5F6368",
  "agento.role.foreground": "#FFFFFF",
};

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

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

test("roleBannerColor maps every session role and falls back to unavailable", () => {
  assert.deepEqual(
    ["primary", "plan", "build", "freehand", "unmanaged"].map(roleBannerColor),
    ["agento.role.primary", "agento.role.plan", "agento.role.build", "agento.role.freehand", "agento.role.unmanaged"],
  );
  for (const role of ["unknown", "", "constructor", "toString"]) {
    assert.equal(roleBannerColor(role), "agento.role.unavailable");
  }
  assert.equal(ROLE_FOREGROUND_COLOR, "agento.role.foreground");
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
    "agento.role.build",
    "agento.role.foreground",
    "agento.role.freehand",
    "agento.role.plan",
    "agento.role.primary",
    "agento.role.unavailable",
    "agento.role.unmanaged",
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
    ...ROLE_DEFAULTS,
  };

  assert.deepEqual(declared.map((color) => color.id).sort(), [...STATUS_COLOR_IDS].sort());
  for (const color of declared) {
    assert.ok(color.description, `${color.id} has no description`);
    for (const theme of ["dark", "light", "highContrast", "highContrastLight"]) {
      assert.equal(color.defaults?.[theme], expectedDefaults[color.id], `${color.id} ${theme}`);
    }
  }
});

test("every default role banner background meets WCAG AA contrast against the default foreground", () => {
  const foreground = ROLE_DEFAULTS[ROLE_FOREGROUND_COLOR]!;
  const backgrounds = Object.entries(ROLE_DEFAULTS).filter(([id]) => id !== ROLE_FOREGROUND_COLOR);
  assert.equal(backgrounds.length, 6);
  for (const [id, background] of backgrounds) {
    const ratio = contrastRatio(background, foreground);
    assert.ok(ratio >= 4.5, `${id} ${background} contrast ${ratio.toFixed(2)} < 4.5`);
  }
});
