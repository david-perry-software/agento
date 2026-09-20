import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";
import { createDeliveryTreeError } from "../../src/deliveryTreeModel.js";
import type { DeliveryTreeElement } from "../../src/deliveryTreeProvider.js";
import { createSessionDoctorError } from "../../src/sessionDoctorModel.js";
import type { SessionDoctorElement } from "../../src/sessionDoctorProvider.js";
import type { CliResult } from "../../src/cliClient.js";

async function waitForReadyTree(api: ExtensionApi): Promise<void> {
  if (api.deliveries.current.model.kind === "ready") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Deliveries tree; current state: ${api.deliveries.current.model.kind}`));
    }, 15_000);
    const subscription = api.deliveries.onDidChangeTreeData(() => {
      if (api.deliveries.current.model.kind !== "ready") {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
}

async function waitForSessionDoctor(
  api: ExtensionApi,
  predicate: () => boolean,
  description: string,
  action?: () => Thenable<void> | void,
): Promise<void> {
  if (predicate()) {
    return;
  }
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Session & Doctor ${description}`));
    }, 15_000);
    const subscription = api.sessionDoctor.onDidChangeTreeData(() => {
      if (!predicate()) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
  await action?.();
  await refreshed;
}

async function focusSessionDoctor(api: ExtensionApi): Promise<void> {
  if (api.sessionDoctorView.visible) {
    await vscode.commands.executeCommand("agento.sessionDoctor.focus");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for Session & Doctor view to become visible"));
    }, 15_000);
    const subscription = api.sessionDoctorView.onDidChangeVisibility((event) => {
      if (!event.visible) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
    void vscode.commands.executeCommand("agento.sessionDoctor.focus").then(undefined, reject);
  });
}

function sessionDoctorRows(api: ExtensionApi, label: string): SessionDoctorElement[] {
  const group = api.sessionDoctor.getChildren().find((element) => api.sessionDoctor.getTreeItem(element).label === label);
  assert.ok(group, `${label} group is present`);
  return api.sessionDoctor.getChildren(group);
}

function sessionResponse(role: string, warnings: string[] = []) {
  return {
    status: "ok",
    role,
    lifecycle: "building",
    worktree: { path: "/fixture/product", branch: "feature/session-doctor-panel", detached: false },
    workspace: { path: "/fixture/session.code-workspace", exists: true },
    companion: {
      path: "/fixture/artifacts",
      branch: "feature/session-doctor-panel",
      detached: false,
      dirty: false,
      ahead: 2,
      behind: 1,
      registered: true,
    },
    warnings,
  };
}

const doctorResponse = {
  status: "warn",
  checks: [
    { id: "node", status: "ok", detail: "node fixture", fallback: null },
    { id: "browser", status: "warn", detail: "browser fixture warning", fallback: "run headless verification" },
    { id: "gh", status: "fail", detail: "gh fixture failure", fallback: "run gh auth login" },
  ],
};

function statusResponse(active: number) {
  return {
    status: "ok",
    lifecycles: ["planned", "building", "in-review", "shipped"],
    items: [],
    warnings: [],
    resumable: Array.from({ length: active }, (_, index) => ({ slug: `active-${index}` })),
  };
}

function deliveryElements(api: ExtensionApi, group: DeliveryTreeElement): DeliveryTreeElement[] {
  return api.deliveries.getChildren(group);
}

async function waitForTree(
  api: ExtensionApi,
  predicate: () => boolean,
  description: string,
  action: () => Thenable<void>,
): Promise<void> {
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Deliveries tree ${description}`));
    }, api.scheduler.debounceMs + 12_000);
    const subscription = api.deliveries.onDidChangeTreeData(() => {
      if (!predicate()) {
        return;
      }
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
  await action();
  await refreshed;
}

async function waitForRoadmapRefresh(api: ExtensionApi, roadmap: vscode.Uri): Promise<void> {
  const observedReasons: string[] = [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const refreshed = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        resolve(false);
      }, api.scheduler.debounceMs + 2000);
      const subscription = api.scheduler.onDidRefresh(({ reasons }) => {
        observedReasons.push(...reasons);
        if (!reasons.some((reason) => reason === `create ${roadmap.fsPath}` || reason === `change ${roadmap.fsPath}`)) {
          return;
        }
        clearTimeout(timeout);
        subscription.dispose();
        resolve(true);
      });
    });
    await vscode.workspace.fs.writeFile(roadmap, Buffer.from(`# Fixture ${attempt}\n`));
    if (await refreshed) {
      return;
    }
  }

  throw new Error(`Timed out waiting for roadmap refresh; observed: ${observedReasons.join(", ") || "none"}`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>("david-perry-software.agento-dashboard");
  assert.ok(extension, "Agento extension is installed in the test host");
  const api = await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("agento.refresh"));
  assert.ok(commands.includes("agento.showOutput"));
  assert.ok(commands.includes("agento.openRoadmap"));
  assert.ok(commands.includes("agento.sessionDoctor.focus"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  await waitForReadyTree(api);
  await waitForSessionDoctor(api, () => api.sessionDoctor.current.kind === "ready", "to load");
  assert.equal(api.statusBar.text, "Agento: primary · 1 active");
  assert.equal(api.statusBar.command, "agento.sessionDoctor.focus");
  await focusSessionDoctor(api);
  assert.equal(api.sessionDoctorView.visible, true);

  const groups = api.deliveries.getChildren();
  assert.deepEqual(
    groups.map((group) => api.deliveries.getTreeItem(group).label),
    ["Planned", "Building"],
  );
  const items = groups.flatMap((group) => deliveryElements(api, group));
  assert.deepEqual(
    items.map((item) => api.deliveries.getTreeItem(item).label),
    ["planned-delivery", "building-delivery"],
  );
  assert.equal(api.deliveries.getTreeItem(items[0]!).description, "feature | 1/3 | planned | PR #101 draft");
  if (process.env.AGENTO_ELECTRON_SCENARIO === "companion") {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: #202 OPEN draft CLEAN/);
  } else {
    assert.match(String(api.deliveries.getTreeItem(items[0]!).tooltip), /Companion PR: none/);
  }

  const activeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture, ".github", "agento.json")));
  const activeEditor = await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  const deliveryTreeItem = api.deliveries.getTreeItem(items[0]!);
  assert.ok(deliveryTreeItem.command);
  await vscode.commands.executeCommand(deliveryTreeItem.command.command, ...(deliveryTreeItem.command.arguments ?? []));
  const roadmapUri = deliveryTreeItem.command.arguments?.[0];
  assert.ok(roadmapUri instanceof vscode.Uri);
  const roadmapEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === roadmapUri.fsPath);
  assert.ok(roadmapEditor, "delivery activation opens its roadmap");
  assert.equal(activeEditor.viewColumn, vscode.ViewColumn.One);
  assert.equal(roadmapEditor.viewColumn, vscode.ViewColumn.Two);

  const roadmapContents = Buffer.from(await vscode.workspace.fs.readFile(roadmapUri)).toString("utf8");
  await waitForTree(
    api,
    () => {
      const currentGroup = api.deliveries.getChildren()[0];
      const currentDelivery = currentGroup && deliveryElements(api, currentGroup)[0];
      return currentDelivery ? api.deliveries.getTreeItem(currentDelivery).description === "feature | 2/3 | planned | PR #101 draft" : false;
    },
    "to show updated roadmap progress",
    () => vscode.workspace.fs.writeFile(roadmapUri, Buffer.from(roadmapContents.replace("- [ ] 1.2", "- [x] 1.2"))),
  );

  const deliveryDir = path.join(fixture, "features", "2026", "09", "x");
  const roadmapPath = path.join(deliveryDir, "roadmap.md");
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(deliveryDir));
  await waitForRoadmapRefresh(api, vscode.Uri.file(roadmapPath));

  api.deliveries.update({
    model: { kind: "empty", message: "No deliveries found.", warnings: [] },
    roadmapRoot: fixture,
  });
  const emptyItem = api.deliveries.getTreeItem(api.deliveries.getChildren()[0]!);
  assert.equal(emptyItem.label, "No deliveries found.");
  assert.equal(emptyItem.contextValue, "agento.empty");

  api.deliveries.update({
    model: createDeliveryTreeError(new Error("fixture status failure")),
    roadmapRoot: fixture,
  });
  const errorItem = api.deliveries.getTreeItem(api.deliveries.getChildren()[0]!);
  assert.equal(errorItem.label, "Unable to load deliveries: fixture status failure");
  assert.equal(errorItem.contextValue, "agento.error");

  await waitForSessionDoctor(
    api,
    () => api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role === "primary",
    "manual refresh",
    () => vscode.commands.executeCommand("agento.refresh"),
  );

  const originalRun = api.client.run.bind(api.client);
  const pending: Array<{ args: string[]; resolve: (result: CliResult) => void }> = [];
  api.client.run = (args: string[]) =>
    new Promise<CliResult>((resolve) => {
      pending.push({ args, resolve });
    });
  try {
    await vscode.commands.executeCommand("agento.refresh");
    await vscode.commands.executeCommand("agento.refresh");
    assert.equal(pending.length, 6);

    const resolveBatch = (batch: number, role: string, active: number, warnings: string[]) => {
      for (const request of pending.slice(batch * 3, batch * 3 + 3)) {
        const command = request.args[0];
        const json = command === "session" ? sessionResponse(role, warnings) : command === "doctor" ? doctorResponse : statusResponse(active);
        request.resolve({ code: 0, json, stderr: "" });
      }
    };

    const newerApplied = waitForSessionDoctor(
      api,
      () => api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role === "build",
      "newer overlapping refresh",
    );
    resolveBatch(1, "build", 1, ["fixture CLI warning"]);
    await newerApplied;
    assert.equal(api.statusBar.text, "Agento: build · 1 active");

    assert.deepEqual(
      sessionDoctorRows(api, "Session").map((element) => [api.sessionDoctor.getTreeItem(element).label, api.sessionDoctor.getTreeItem(element).description]),
      [
        ["Role", "build"],
        ["Worktree", "/fixture/product"],
        ["Branch", "feature/session-doctor-panel"],
        ["Lifecycle", "building"],
        ["Workspace", "/fixture/session.code-workspace (exists)"],
      ],
    );
    assert.deepEqual(
      sessionDoctorRows(api, "Companion").map((element) => api.sessionDoctor.getTreeItem(element).description),
      ["/fixture/artifacts", "feature/session-doctor-panel", "registered, attached, clean", "ahead 2, behind 1"],
    );
    assert.equal(api.sessionDoctor.getTreeItem(sessionDoctorRows(api, "Warnings")[0]!).description, "fixture CLI warning");
    const doctorRows = sessionDoctorRows(api, "Doctor").map((element) => api.sessionDoctor.getTreeItem(element));
    assert.deepEqual(doctorRows.map((item) => [item.label, item.description]), [
      ["node", "ok"],
      ["browser", "warn"],
      ["gh", "fail"],
    ]);
    assert.equal(doctorRows[0]?.tooltip, "Detail: node fixture\nFallback: none");
    assert.equal(doctorRows[1]?.tooltip, "Detail: browser fixture warning\nFallback: run headless verification");
    assert.equal(doctorRows[2]?.tooltip, "Detail: gh fixture failure\nFallback: run gh auth login");

    resolveBatch(0, "primary", 0, []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role, "build");
    assert.equal(api.statusBar.text, "Agento: build · 1 active");
  } finally {
    api.client.run = originalRun;
  }

  api.sessionDoctor.update(createSessionDoctorError(new Error("fixture session failure")));
  const retryItem = api.sessionDoctor.getTreeItem(api.sessionDoctor.getChildren()[0]!);
  assert.equal(retryItem.label, "Unable to load Session & Doctor: fixture session failure");
  assert.equal(retryItem.contextValue, "agento.sessionDoctor.error");
  assert.equal(retryItem.command?.command, "agento.refresh");
  await waitForSessionDoctor(
    api,
    () => api.sessionDoctor.current.kind === "ready",
    "inline retry",
    () => vscode.commands.executeCommand(retryItem.command!.command),
  );

  console.log(`Electron ${process.env.AGENTO_ELECTRON_SCENARIO} scenario passed: deliveries, session doctor, status focus, refresh, stale/error handling`);
}