import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes all Agento views and their title refresh actions", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: {
      views: { agento: Array<{ id: string; name: string }> };
      commands: Array<{ command: string }>;
      menus: { "view/title": Array<{ command: string; when: string; group: string }> };
    };
  };

  assert.deepEqual(manifest.contributes.views.agento, [
    { id: "agento.deliveries", name: "Deliveries" },
    { id: "agento.initiatives", name: "Initiatives" },
    { id: "agento.sessionDoctor", name: "Session & Doctor" },
  ]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openRoadmap"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openBreakdown"));
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.refresh"),
    [
      { command: "agento.refresh", when: "view == agento.deliveries", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.initiatives", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.sessionDoctor", group: "navigation" },
    ],
  );
});

test("extension refreshes all dashboard views without polling", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.match(source, /createTreeView\("agento\.deliveries", \{ treeDataProvider: deliveries \}\)/);
  assert.match(source, /createTreeView\("agento\.initiatives", \{ treeDataProvider: initiatives \}\)/);
  assert.match(source, /createTreeView\("agento\.sessionDoctor", \{ treeDataProvider: sessionDoctor \}\)/);
  assert.match(source, /client\.run\(\["session", "--pr"\]/);
  assert.match(source, /client\.run\(\["doctor"\]/);
  assert.match(source, /client\.run\(\["status", "--pr"\]/);
  assert.match(source, /client\.run\(\["initiative"\]/);
  assert.match(source, /client\.run\(\["initiative", slug\]/);
  assert.match(source, /Promise\.all\(initiativeSlugs/);
  assert.match(source, /const latestInitiativeRefresh = new LatestDeliveryRefresh\(\)/);
  assert.match(source, /Promise\.all\(/);
  assert.match(source, /sessionDoctorView\.onDidChangeVisibility/);
  assert.match(source, /statusBar\.command = "agento\.sessionDoctor\.focus"/);
  assert.match(source, /return \{ client, scheduler, deliveries, initiatives, sessionDoctor, sessionDoctorView, statusBar, output \}/);
  assert.match(source, /scheduler\.onDidRefresh/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /registerCommand\([^\n]*(repair|doctor)/i);
});