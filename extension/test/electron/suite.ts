import assert from "node:assert/strict";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";
import { dispatchCommandAction } from "../../src/commandDispatcher.js";
import { createDeliveryTreeError } from "../../src/deliveryTreeModel.js";
import type { DeliveryTreeElement } from "../../src/deliveryTreeProvider.js";
import { createInitiativeTreeError, createInitiativeTreeModel } from "../../src/initiativeTreeModel.js";
import type { InitiativeTreeElement } from "../../src/initiativeTreeProvider.js";
import { createInitiativePlanRequest, createNewPlanRequest, type NewPlanRequest, type NewPlanTarget } from "../../src/newPlanFlow.js";
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

async function waitForReadyInitiatives(api: ExtensionApi): Promise<void> {
  if (api.initiatives.current.model.kind === "ready") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Initiatives tree; current state: ${api.initiatives.current.model.kind}`));
    }, 15_000);
    const subscription = api.initiatives.onDidChangeTreeData(() => {
      if (api.initiatives.current.model.kind !== "ready") {
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
  const deliverySlug = "session-doctor-panel";
  return {
    status: "ok",
    role,
    lifecycle: "building",
    allowed: ["/agento delivery-status"],
    elsewhere: role === "build"
      ? [{ command: `/agento ship ${deliverySlug}`, window: "primary", reason: "ship from primary" }]
      : [],
    delivery: role === "build" ? { type: "feature", slug: deliverySlug } : null,
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

async function assertNewPlanDispatch(
  api: ExtensionApi,
  request: NewPlanRequest,
  fixture: string,
  companion: boolean,
): Promise<void> {
  const planPath = path.join(path.dirname(fixture), `plan-${request.command.includes("initiative:") ? "member" : "generic"}`);
  const workspacePath = `${planPath}.code-workspace`;
  const primary = { path: fixture, role: "primary", isManaged: false, dirPrefix: null, repo: "product" };
  const planned = { path: planPath, role: "plan", isManaged: true, dirPrefix: "plan", repo: "product" };
  const snapshots = [
    { status: "ok", worktrees: [primary] },
    { status: "ok", worktrees: [primary, planned] },
    {
      status: "ok",
      worktrees: [primary, planned],
      companion: companion ? { path: `${planPath}-artifacts`, registered: true } : null,
      workspace: companion ? { path: workspacePath, exists: true } : null,
    },
  ];
  const submitted: Array<{ command: string; target: NewPlanTarget }> = [];
  const opened: NewPlanTarget[] = [];
  const pending = new Map<string, unknown>();
  let snapshot = 0;

  const result = await api.startNewPlan(request, {
    readSession: async () => snapshots[Math.min(snapshot++, snapshots.length - 1)],
    submitCommand: async (command, target) => { submitted.push({ command, target }); },
    pendingStore: {
      get: <T>(key: string) => pending.get(key) as T | undefined,
      update: async (key, value) => {
        if (value === undefined) pending.delete(key);
        else pending.set(key, value);
      },
    },
    openTarget: async (target) => { opened.push(target); },
    sleep: async () => undefined,
    now: () => 1,
    isCancellationRequested: () => false,
    offerRecovery: async () => undefined,
  }, { pollIntervalMs: 1, timeoutMs: 10 });

  const expectedTarget: NewPlanTarget = companion
    ? { kind: "workspace", path: workspacePath }
    : { kind: "folder", path: planPath };
  assert.equal(result.kind, "complete");
  assert.deepEqual(submitted, [{ command: "/agento start-session", target: { kind: "folder", path: fixture } }]);
  assert.deepEqual(opened, [expectedTarget]);
  assert.equal(
    [...pending.values()].map((value) => (value as { command: string }).command).at(0),
    request.command,
  );
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

async function waitForInitiativeTree(
  api: ExtensionApi,
  predicate: () => boolean,
  description: string,
  action: () => Thenable<void>,
): Promise<void> {
  const refreshed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Timed out waiting for Initiatives tree ${description}`));
    }, api.scheduler.debounceMs + 12_000);
    const subscription = api.initiatives.onDidChangeTreeData(() => {
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
  assert.ok(commands.includes("agento.openBreakdown"));
  assert.ok(commands.includes("agento.showActions"));
  assert.ok(commands.includes("agento.dispatchAction"));
  assert.ok(commands.includes("agento.sessionDoctor.focus"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  await waitForReadyTree(api);
  await waitForReadyInitiatives(api);
  await waitForSessionDoctor(api, () => api.sessionDoctor.current.kind === "ready", "to load");
  assert.equal(api.statusBar.text, "Agento: primary · 2 active");
  assert.equal(api.statusBar.command, "agento.sessionDoctor.focus");
  await focusSessionDoctor(api);
  assert.equal(api.sessionDoctorView.visible, true);

  const submitted: Array<{ command: string; options: unknown }> = [];
  const executeCommand = async (command: string, options: unknown) => {
    submitted.push({ command, options });
  };
  assert.equal(api.sessionDoctor.current.kind, "ready");
  if (api.sessionDoctor.current.kind !== "ready") return;
  const sessionAction = api.sessionDoctor.current.actions.find((action) => action.window === "here");
  assert.ok(sessionAction);
  await api.dispatchAction(sessionAction, undefined, executeCommand);
  assert.deepEqual(submitted.pop(), {
    command: "workbench.action.chat.open",
    options: { query: sessionAction.command, mode: "agent" },
  });

  const groups = api.deliveries.getChildren();
  assert.deepEqual(
    groups.map((group) => api.deliveries.getTreeItem(group).label),
    ["Planned", "Building", "In Review", "Shipped"],
  );
  const items = groups.flatMap((group) => deliveryElements(api, group));
  assert.deepEqual(
    items.map((item) => api.deliveries.getTreeItem(item).label),
    ["planned-delivery", "building-delivery", "anomalous-delivery", "complete-delivery"],
  );
  assert.equal(api.deliveries.getTreeItem(items[0]!).description, "feature | 1/3 | planned | PR #101 draft");
  assert.ok(items[0]?.kind === "delivery");
  const deliveryAction = items[0].item.actions.find((action) => action.window === "here");
  assert.ok(deliveryAction);
  await api.dispatchAction(deliveryAction, items[0].item.slug, executeCommand);
  assert.deepEqual(submitted.pop(), {
    command: "workbench.action.chat.open",
    options: { query: deliveryAction.command, mode: "agent" },
  });

  const routedTargets: string[] = [];
  const target = process.env.AGENTO_ELECTRON_SCENARIO === "companion"
    ? { kind: "workspace" as const, path: path.join(path.dirname(fixture), "feature.code-workspace") }
    : { kind: "folder" as const, path: fixture };
  const crossWindowRoute = await dispatchCommandAction(
    { command: "/agento review-feature planned-delivery", window: "secondary", reason: "review there" },
    "planned-delivery",
    {
      currentWindow: () => "primary",
      loadNext: async () => ({
        status: "ok",
        next: {
          window: "secondary",
          target: target.kind === "workspace"
            ? { path: path.dirname(target.path), workspace: { path: target.path, exists: true } }
            : { path: target.path, workspace: null },
          reason: "Continue in the delivery window.",
        },
      }),
      executeCommand,
      reportError: async (message) => { assert.fail(message); },
      reportInfo: async () => undefined,
      output: api.output,
      pendingStore: {
        get: () => undefined,
        update: async () => undefined,
      },
      openTarget: async (opened) => { routedTargets.push(`${opened.kind}:${opened.path}`); },
    },
  );
  assert.equal(crossWindowRoute.kind, "open");
  assert.deepEqual(routedTargets, [`${target.kind}:${target.path}`]);
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

  const initiative = api.initiatives.getChildren()[0];
  assert.ok(initiative?.kind === "initiative");
  const initiativeItem = api.initiatives.getTreeItem(initiative);
  assert.equal(initiativeItem.label, "agento-extension");
  assert.equal(initiativeItem.description, "1/6 complete | 3 in flight | 1 ready");
  const initiativeChildren = api.initiatives.getChildren(initiative);
  const diagnostic = initiativeChildren.find((element) => element.kind === "diagnostic");
  assert.ok(diagnostic);
  assert.match(String(api.initiatives.getTreeItem(diagnostic).label), /anomalous-delivery: merged-but-not-complete/);
  const initiativeGroups = initiativeChildren.filter((element): element is Extract<InitiativeTreeElement, { kind: "group" }> => element.kind === "group");
  assert.deepEqual(initiativeGroups.map((group) => api.initiatives.getTreeItem(group).label), [
    "Ready (1)",
    "In flight (3)",
    "Blocked (1)",
    "Complete (1)",
  ]);
  const initiativeMembers = initiativeGroups.flatMap((group) => api.initiatives.getChildren(group));
  assert.deepEqual(initiativeMembers.map((member) => api.initiatives.getTreeItem(member).label), [
    "ready-delivery",
    "planned-delivery",
    "building-delivery",
    "anomalous-delivery",
    "blocked-delivery",
    "complete-delivery",
  ]);
  const blockedMember = initiativeMembers.find((member) => api.initiatives.getTreeItem(member).label === "blocked-delivery");
  assert.ok(blockedMember);
  assert.match(String(api.initiatives.getTreeItem(blockedMember).tooltip), /Wave: 2/);
  assert.match(String(api.initiatives.getTreeItem(blockedMember).tooltip), /Blocked by: building-delivery/);
  const readyMember = initiativeMembers.find((member) => api.initiatives.getTreeItem(member).label === "ready-delivery");
  assert.ok(readyMember);
  assert.match(String(api.initiatives.getTreeItem(readyMember).tooltip), /Ready: yes\nNext: yes/);

  await assertNewPlanDispatch(api, createNewPlanRequest("feature", "Add guided planning"), fixture, process.env.AGENTO_ELECTRON_SCENARIO === "companion");
  assert.equal(readyMember.kind, "member");
  if (readyMember.kind !== "member") return;
  await assertNewPlanDispatch(
    api,
    createInitiativePlanRequest(readyMember.initiativeSlug, readyMember.item.slug),
    fixture,
    process.env.AGENTO_ELECTRON_SCENARIO === "companion",
  );

  const memberTreeItem = api.initiatives.getTreeItem(readyMember);
  assert.ok(memberTreeItem.command);
  await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  await vscode.commands.executeCommand(memberTreeItem.command.command, ...(memberTreeItem.command.arguments ?? []));
  const breakdownUri = memberTreeItem.command.arguments?.[0];
  assert.ok(breakdownUri instanceof vscode.Uri);
  const expectedArtifactRoot = process.env.AGENTO_ELECTRON_SCENARIO === "companion"
    ? path.join(path.dirname(fixture), "artifacts")
    : fixture;
  assert.equal(breakdownUri.fsPath, path.join(expectedArtifactRoot, "initiatives", "2026", "09", "agento-extension", "breakdown.md"));
  const breakdownEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.fsPath === breakdownUri.fsPath);
  assert.ok(breakdownEditor, "initiative member activation opens its breakdown");
  assert.equal(breakdownEditor.viewColumn, vscode.ViewColumn.Two);

  const buildingRoadmap = vscode.Uri.file(path.join(expectedArtifactRoot, "features", "2026", "09", "building-delivery", "roadmap.md"));
  const buildingContents = Buffer.from(await vscode.workspace.fs.readFile(buildingRoadmap)).toString("utf8");
  await waitForInitiativeTree(
    api,
    () => {
      const current = api.initiatives.getChildren()[0];
      return current?.kind === "initiative"
        && api.initiatives.getTreeItem(current).description === "2/6 complete | 2 in flight | 2 ready";
    },
    "to reflect a completed member roadmap",
    () => vscode.workspace.fs.writeFile(buildingRoadmap, Buffer.from(buildingContents.replace("status: in-progress", "status: complete"))),
  );
  const refreshedInitiative = api.initiatives.getChildren()[0];
  assert.ok(refreshedInitiative?.kind === "initiative");
  const refreshedGroups = api.initiatives.getChildren(refreshedInitiative).filter(
    (element): element is Extract<InitiativeTreeElement, { kind: "group" }> => element.kind === "group",
  );
  assert.deepEqual(refreshedGroups.map((group) => api.initiatives.getTreeItem(group).label), ["Ready (2)", "In flight (2)", "Complete (2)"]);
  const refreshedDeliveryLabels = api.deliveries.getChildren().flatMap((group) => deliveryElements(api, group)).map((item) => api.deliveries.getTreeItem(item).label);
  assert.ok(refreshedDeliveryLabels.includes("building-delivery"), "Deliveries remains populated after initiative refresh");

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

  const deliveryDir = path.join(expectedArtifactRoot, "features", "2026", "09", "x");
  const roadmapPath = path.join(deliveryDir, "roadmap.md");
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

  const artifactRoot = api.initiatives.current.artifactRoot;
  const healthyModel = api.initiatives.current.model;
  assert.equal(healthyModel.kind, "ready");
  if (healthyModel.kind !== "ready") return;
  api.initiatives.update({ model: { kind: "empty", message: "No initiatives found." }, artifactRoot });
  const emptyInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.equal(emptyInitiative.label, "No initiatives found.");
  assert.equal(emptyInitiative.contextValue, "agento.empty");

  api.initiatives.update({
    model: createInitiativeTreeModel({ status: "ok", items: [{ slug: "malformed" }] }, new Map()),
    artifactRoot,
  });
  const malformedInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.match(String(malformedInitiative.label), /Invalid initiative list response/);
  assert.equal(malformedInitiative.contextValue, "agento.error");

  api.initiatives.update({ model: createInitiativeTreeError(new Error("fixture initiative failure")), artifactRoot });
  const errorInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.equal(errorInitiative.label, "Unable to load initiatives: fixture initiative failure");
  assert.equal(errorInitiative.contextValue, "agento.error");

  const healthy = healthyModel.items[0]!;
  api.initiatives.update({
    model: {
      kind: "ready",
      items: [
        {
          ...healthy,
          slug: "invalid-initiative",
          valid: false,
          groups: [],
          diagnostics: [{ kind: "error", message: "dependency cycle among: a, b" }],
        },
        healthy,
      ],
    },
    artifactRoot,
  });
  const partialRoots = api.initiatives.getChildren();
  assert.deepEqual(partialRoots.map((element) => api.initiatives.getTreeItem(element).label), ["invalid-initiative", "agento-extension"]);
  const invalidDiagnostic = api.initiatives.getChildren(partialRoots[0]).find((element) => element.kind === "diagnostic");
  assert.ok(invalidDiagnostic);
  assert.equal(api.initiatives.getTreeItem(invalidDiagnostic).label, "dependency cycle among: a, b");
  assert.ok(api.initiatives.getChildren(partialRoots[1]).some((element) => element.kind === "group"), "healthy initiative remains usable");

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
    assert.equal(pending.length, 8);

    const resolveBatch = (batch: number, role: string, active: number, warnings: string[]) => {
      for (const request of pending.slice(batch * 4, batch * 4 + 4)) {
        const command = request.args[0];
        const json = command === "session"
          ? sessionResponse(role, warnings)
          : command === "doctor"
            ? doctorResponse
            : command === "initiative"
              ? { status: "ok", items: [] }
              : statusResponse(active);
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

    assert.equal(api.sessionDoctor.current.kind, "ready");
    if (api.sessionDoctor.current.kind !== "ready") return;
    const sessionCrossWindowAction = api.sessionDoctor.current.actions.find((action) => action.window === "primary");
    assert.ok(sessionCrossWindowAction);
    const loadedSlugs: string[] = [];
    const openedTargets: string[] = [];
    const route = await dispatchCommandAction(
      sessionCrossWindowAction,
      api.sessionDoctor.current.session.deliverySlug ?? undefined,
      {
        currentWindow: () => "secondary",
        loadNext: async (slug) => {
          loadedSlugs.push(slug);
          return {
            status: "ok",
            next: { window: "primary", target: { path: "/fixture/primary", workspace: null }, reason: "Continue in primary." },
          };
        },
        executeCommand,
        reportError: async (message) => { assert.fail(message); },
        reportInfo: async () => undefined,
        output: api.output,
        pendingStore: { get: () => undefined, update: async () => undefined },
        openTarget: async (target) => { openedTargets.push(target.path); },
      },
    );
    assert.equal(route.kind, "open");
    assert.deepEqual(loadedSlugs, ["session-doctor-panel"]);
    assert.deepEqual(openedTargets, ["/fixture/primary"]);

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

  console.log(`Electron ${process.env.AGENTO_ELECTRON_SCENARIO} scenario passed: initiatives, deliveries, session doctor, roadmap refresh, diagnostics, stale/error handling`);
}