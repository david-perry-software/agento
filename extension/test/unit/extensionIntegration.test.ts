import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest contributes CLI-backed action surfaces without static lifecycle commands", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    contributes: {
      views: { agento: Array<{ id: string; name: string; type?: string }> };
      commands: Array<{ command: string }>;
      menus: {
        "view/title": Array<{ command: string; when: string; group: string }>;
        "view/item/context": Array<{ command: string; when: string; group: string }>;
      };
    };
  };

  assert.deepEqual(manifest.contributes.views.agento, [
    { id: "agento.windowBanner", name: "Window", type: "webview", initialSize: 1 },
    { id: "agento.deliveries", name: "Deliveries" },
    { id: "agento.initiatives", name: "Initiatives" },
    { id: "agento.sessionDoctor", name: "Session & Doctor" },
  ]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openRoadmap"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openBreakdown"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.newPlan"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.newInitiative"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.planInitiativeMember"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.showActions"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.selectModelProfile"));
  assert.ok(!manifest.contributes.commands.some((command) => /\.(?:build|review|ship|ap)$/.test(command.command)));
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.refresh"),
    [
      { command: "agento.refresh", when: "view == agento.deliveries", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.initiatives", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.sessionDoctor", group: "navigation" },
    ],
  );
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.newPlan"),
    [
      { command: "agento.newPlan", when: "view == agento.deliveries && agento.canPlan", group: "navigation@2" },
      { command: "agento.newPlan", when: "view == agento.sessionDoctor && agento.canPlan", group: "navigation@2" },
    ],
  );
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.newInitiative"),
    [{ command: "agento.newInitiative", when: "view == agento.initiatives && agento.primary", group: "navigation@2" }],
  );
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.showActions"),
    [{ command: "agento.showActions", when: "view == agento.sessionDoctor", group: "navigation@3" }],
  );
  assert.deepEqual(manifest.contributes.menus["view/item/context"], [
    { command: "agento.showActions", when: "view == agento.deliveries && viewItem == agento.delivery", group: "inline" },
    { command: "agento.planInitiativeMember", when: "view == agento.initiatives && viewItem == agento.initiativeMember.ready && agento.canPlan", group: "inline" },
    { command: "agento.showActions", when: "view == agento.initiatives && viewItem == agento.initiativeMember.in-flight", group: "inline" },
  ]);
});

test("extension refreshes all dashboard views without polling", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.match(source, /createTreeView\("agento\.deliveries", \{ treeDataProvider: deliveries \}\)/);
  assert.match(source, /createTreeView\("agento\.initiatives", \{ treeDataProvider: initiatives \}\)/);
  assert.match(source, /createTreeView\("agento\.sessionDoctor", \{ treeDataProvider: sessionDoctor \}\)/);
  assert.match(source, /registerWebviewViewProvider\("agento\.windowBanner", windowBanner\)/);
  assert.match(source, /client\.run\(\["dashboard", "--pr", \.\.\.\(root \? \["--plugin-root", root\] : \[\]\)\]/);
  const refresh = source.slice(source.indexOf("scheduler.onDidRefresh"), source.indexOf('registerCommand("agento.refresh"'));
  assert.ok(refresh.length > 0, "the refresh handler precedes the refresh command");
  assert.equal(refresh.match(/client\.run\(/g)?.length, 1, "one CLI spawn per refresh");
  assert.match(refresh, /client\.run\(\["dashboard"/);
  assert.doesNotMatch(refresh, /client\.run\(\["(session|doctor|status|initiative)"/);
  assert.doesNotMatch(refresh, /\["doctor"/);
  assert.match(source, /splitDashboardDocument\(result\.json\)/);
  assert.equal(source.match(/new LatestDeliveryRefresh\(\)/g)?.length, 1);
  assert.doesNotMatch(source, /latestInitiativeRefresh/);
  assert.match(source, /registerCommand\("agento\.selectModelProfile"/);
  assert.match(source, /getConfiguration\("chat"\)\.get<Record<string, unknown>>\("pluginLocations"\)/);
  assert.match(source, /sessionDoctorView\.onDidChangeVisibility/);
  assert.match(source, /statusBar\.command = "agento\.sessionDoctor\.focus"/);
  assert.match(source, /registerCommand\("agento\.showActions"/);
  assert.match(source, /registerCommand\("agento\.dispatchAction"/);
  assert.match(source, /registerCommand\("agento\.newPlan"/);
  assert.match(source, /registerCommand\("agento\.newInitiative"/);
  assert.match(source, /registerCommand\(\s*"agento\.planInitiativeMember"/);
  assert.match(source, /showQuickPick/);
  assert.match(source, /showInputBox/);
  assert.match(source, /openTextDocument\(\{ language: "markdown", content: "" \}\)/);
  assert.match(source, /showOpenDialog/);
  assert.match(source, /createNewPlanRequest/);
  assert.match(source, /onDidChangeWindowState/);
  assert.match(source, /await consumePending\(\)/);
  assert.match(source, /new FilePendingDispatchStore/);
  assert.match(source, /slug: sessionDoctor\.current\.session\.deliverySlug/);
  assert.match(source, /startNewPlan, setNewPlanRunner, setNewPlanPrompts/);
  assert.match(source, /startNewInitiative, setNewInitiativeRunner, setNewInitiativePrompts/);
  assert.match(source, /scheduler\.onDidRefresh/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
  assert.doesNotMatch(source, /registerCommand\([^\n]*(repair|doctor)/i);
});

test("activate creates one tree id scope and hands it to all three tree providers", async () => {
  const source = await readFile("src/extension.ts", "utf8");

  assert.equal(source.match(/createTreeIdScope\(/g)?.length, 1);
  assert.match(source, /const treeId = createTreeIdScope\(\);/);
  assert.match(source, /new DeliveryTreeProvider\([^\n]*, treeId\)/);
  assert.match(source, /new InitiativeTreeProvider\([^\n]*, treeId\)/);
  assert.match(source, /new SessionDoctorProvider\(treeId\)/);
});

test("New Plan and start-session dispatch run the CLI directly, with no chat round-trip or poll", async () => {
  const source = await readFile("src/extension.ts", "utf8");
  assert.match(source, /const startSession = cliStartSession\(client\)/);
  assert.match(source, /startSession: async \(args, root\) => vscode\.window\.withProgress/);
  assert.match(source, /\(\) => startSession\(args, folder\.uri\.fsPath\)/);
  assert.match(source, /offerOpenInChat: async \(message\) => vscode\.window\.showErrorMessage\(message, OPEN_IN_CHAT\)/);
  assert.match(source, /offerOpenInChat: \(message\) => vscode\.window\.showErrorMessage\(message, OPEN_IN_CHAT\)/);
  assert.doesNotMatch(source, /NEW_PLAN_FLOW_DEFAULTS|pollIntervalMs|isCancellationRequested/);
  const flow = await readFile("src/newPlanFlow.ts", "utf8");
  assert.doesNotMatch(flow, /sleep|timeoutMs|"ambiguous"|"timeout"/);
  const cli = await readFile("src/startSessionCli.ts", "utf8");
  assert.match(cli, /\["start-session", \.\.\.args, "--no-open"\]/);
  assert.match(cli, /timeoutMs: START_SESSION_TIMEOUT_MS/);
});