import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes the Deliveries view and roadmap command", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: {
      views: { agento: Array<{ id: string; name: string }> };
      commands: Array<{ command: string }>;
    };
  };

  assert.deepEqual(manifest.contributes.views.agento, [{ id: "agento.deliveries", name: "Deliveries" }]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openRoadmap"));
});

test("extension refreshes Deliveries from status --pr without polling", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.match(source, /registerTreeDataProvider\("agento\.deliveries", deliveries\)/);
  assert.match(source, /client\.run\(\["status", "--pr"\]/);
  assert.match(source, /scheduler\.onDidRefresh/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
});