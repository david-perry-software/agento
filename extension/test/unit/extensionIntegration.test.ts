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
      configuration: {
        properties: Record<string, { type?: string; enum?: string[]; default?: unknown; description?: string }>;
      };
    };
  };

  assert.deepEqual(manifest.contributes.views.agento, [
    { id: "agento.windowBanner", name: "Window", type: "webview", initialSize: 1 },
    { id: "agento.deliveries", name: "Deliveries" },
    { id: "agento.initiatives", name: "Initiatives" },
    { id: "agento.sessionDoctor", name: "Session & Doctor" },
    { id: "agento.modelProfiles", name: "Model Profiles" },
  ]);
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openRoadmap"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.openBreakdown"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.newPlan"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.newInitiative"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.planInitiativeMember"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.showActions"));
  assert.ok(manifest.contributes.commands.some((command) => command.command === "agento.selectModelProfile"));
  for (const command of ["apply", "new", "clear", "openFile", "edit", "duplicate", "rename", "delete", "init"]) {
    assert.ok(
      manifest.contributes.commands.some((entry) => entry.command === `agento.modelProfiles.${command}`),
      `agento.modelProfiles.${command} is contributed`,
    );
  }
  assert.ok(!manifest.contributes.commands.some((command) => /\.(?:build|review|ship|ap)$/.test(command.command)));
  const chatModelPreselect = manifest.contributes.configuration.properties["agento.chatModelPreselect"];
  assert.deepEqual(
    { type: chatModelPreselect?.type, enum: chatModelPreselect?.enum, default: chatModelPreselect?.default },
    { type: "string", enum: ["off", "local", "copilot"], default: "off" },
    "agento.chatModelPreselect is contributed with the three opt-in values and off as the default",
  );
  assert.ok(typeof chatModelPreselect?.description === "string" && chatModelPreselect.description.length > 0, "the setting has a description");
  assert.deepEqual(
    manifest.contributes.menus["view/title"].filter((item) => item.command === "agento.refresh"),
    [
      { command: "agento.refresh", when: "view == agento.deliveries", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.initiatives", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.sessionDoctor", group: "navigation" },
      { command: "agento.refresh", when: "view == agento.modelProfiles", group: "navigation@3" },
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
    { command: "agento.modelProfiles.apply", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile(\\.(primary|secondary|invalid))*$/", group: "inline" },
    { command: "agento.modelProfiles.usePrimary", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile(\\.(secondary|here|invalid))*$/", group: "0_roles@1" },
    { command: "agento.modelProfiles.useSecondary", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile(\\.(primary|here|invalid))*$/", group: "0_roles@2" },
    { command: "agento.modelProfiles.offPrimary", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile\\.primary/", group: "0_roles@3" },
    { command: "agento.modelProfiles.offSecondary", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile(\\.primary)?\\.secondary/", group: "0_roles@4" },
    { command: "agento.modelProfiles.offPrimary", when: "view == agento.modelProfiles && viewItem == agento.modelRole.primary.on", group: "inline" },
    { command: "agento.modelProfiles.offSecondary", when: "view == agento.modelProfiles && viewItem == agento.modelRole.secondary.on", group: "inline" },
    { command: "agento.modelProfiles.edit", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile/", group: "1_modify@1" },
    { command: "agento.modelProfiles.duplicate", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile/", group: "1_modify@2" },
    { command: "agento.modelProfiles.rename", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile/", group: "1_modify@3" },
    { command: "agento.modelProfiles.delete", when: "view == agento.modelProfiles && viewItem =~ /^agento\\.modelProfile/", group: "1_modify@4" },
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
  assert.match(refresh, /createDeliveryTreeModel\(status, metrics === null \? null : createTimelineRows\(metrics\)\)/, "Timeline rows come from the same dashboard document");
  assert.equal(source.match(/new LatestDeliveryRefresh\(\)/g)?.length, 2);
  assert.doesNotMatch(source, /latestInitiativeRefresh/);
  assert.match(source, /void reloadModelProfiles\(\)/);
  assert.match(source, /client\.run\(\["models", "list", "--plugin-root", root\], root\)/);
  assert.match(source, /createModelProfilesModel\(/);
  assert.match(source, /createTreeView\("agento\.modelProfiles", \{ treeDataProvider: modelProfiles \}\)/);
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