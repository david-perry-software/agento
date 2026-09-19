import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes the Deliveries and Initiatives views and open commands", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: {
      views: { agento: Array<{ id: string; name: string }> };
      commands: Array<{ command: string }>;
    };
  };

  assert.deepEqual(manifest.contributes.views.agento, [
    { id: "agento.deliveries", name: "Deliveries" },
    { id: "agento.initiatives", name: "Initiatives" },
  ]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openRoadmap"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openBreakdown"));
});

test("extension refreshes Deliveries and Initiatives from exact CLI calls without polling", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.match(source, /registerTreeDataProvider\("agento\.deliveries", deliveries\)/);
  assert.match(source, /registerTreeDataProvider\("agento\.initiatives", initiatives\)/);
  assert.match(source, /client\.run\(\["status", "--pr"\]/);
  assert.match(source, /client\.run\(\["initiative"\]/);
  assert.match(source, /client\.run\(\["initiative", slug\]/);
  assert.match(source, /Promise\.all\(initiativeSlugs/);
  assert.match(source, /const latestInitiativeRefresh = new LatestDeliveryRefresh\(\)/);
  assert.match(source, /scheduler\.onDidRefresh/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
});