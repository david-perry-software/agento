import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import type { ExtensionApi } from "../../src/extension.js";
// @ts-expect-error generated CLI bundle ships runtime JS only
import { SESSION_WORKSPACE_SETTINGS } from "../../../cli/session-state.mjs";
import { dispatchCommandAction, dispatchCommandToTarget } from "../../src/commandDispatcher.js";
import { createTimelineRow } from "../../src/deliveryTimeline.js";
import { createDeliveryTreeError } from "../../src/deliveryTreeModel.js";
import type { DeliveryTreeElement } from "../../src/deliveryTreeProvider.js";
import { initiativeMemberActionSource } from "../../src/initiativeMemberActions.js";
import { createInitiativeTreeError, createInitiativeTreeModel } from "../../src/initiativeTreeModel.js";
import type { InitiativeTreeElement } from "../../src/initiativeTreeProvider.js";
import { runNewInitiativeFlow, submittedInitiativeBrief, type NewInitiativeTarget } from "../../src/newInitiativeFlow.js";
import { runNewPlanFlow, type NewPlanTarget } from "../../src/newPlanFlow.js";
import { createSessionDoctorError } from "../../src/sessionDoctorModel.js";
import type { SessionDoctorElement } from "../../src/sessionDoctorProvider.js";
import { lifecycleStyle } from "../../src/statusStyle.js";
import type { CliResult } from "../../src/cliClient.js";
import { cliStartSession } from "../../src/startSessionCli.js";
import { CLOSED_GATE, gateRejection, windowGate, type GatedCommand } from "../../src/windowGate.js";

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

async function focusWindowBanner(api: ExtensionApi): Promise<string> {
  await vscode.commands.executeCommand("agento.windowBanner.focus");
  const deadline = Date.now() + 15_000;
  while (api.windowBanner.html === undefined) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the window banner webview to resolve");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return api.windowBanner.html;
}

const MARKDOWN_PREVIEW_VIEW_TYPE = "vscode.markdown.preview.editor";

function previewTabsFor(uri: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) =>
    tab.input instanceof vscode.TabInputCustom
    && tab.input.viewType === MARKDOWN_PREVIEW_VIEW_TYPE
    && tab.input.uri.fsPath === uri.fsPath);
}

async function runOpenCommandUntilPreviewActive(command: vscode.Command, uri: vscode.Uri, label: string): Promise<vscode.Tab> {
  await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  const deadline = Date.now() + 15_000;
  for (;;) {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab?.input instanceof vscode.TabInputCustom && tab.input.uri.fsPath === uri.fsPath) {
      return tab;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label} to open as the active preview tab`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function assertOpensMarkdownPreview(command: vscode.Command, activeDocument: vscode.TextDocument, label: string): Promise<vscode.Uri> {
  const uri = command.arguments?.[0];
  assert.ok(uri instanceof vscode.Uri);
  await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  const tab = await runOpenCommandUntilPreviewActive(command, uri, label);
  const markdown = vscode.extensions.getExtension("vscode.markdown-language-features");
  assert.ok(markdown?.isActive, "the built-in Markdown extension is active in the test host");
  assert.equal(vscode.window.tabGroups.all.length, 1, `${label} opens in the active group without a split`);
  assert.ok(tab.input instanceof vscode.TabInputCustom);
  assert.equal(tab.input.viewType, MARKDOWN_PREVIEW_VIEW_TYPE, `${label} opens as a Markdown preview`);
  assert.equal(tab.isPreview, false, `${label} opens as a pinned tab`);
  assert.equal(tab.group.viewColumn, vscode.ViewColumn.One);
  assert.equal(
    vscode.window.visibleTextEditors.some((editor) => editor.document.uri.fsPath === uri.fsPath),
    false,
    `${label} shows no source text editor`,
  );

  await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
  await runOpenCommandUntilPreviewActive(command, uri, label);
  assert.equal(previewTabsFor(uri).length, 1, `a repeat ${label} click focuses the existing preview tab`);
  assert.equal(vscode.window.tabGroups.all.length, 1);
  return uri;
}

function sessionDoctorRows(api: ExtensionApi, label: string): SessionDoctorElement[] {
  const group = api.sessionDoctor.getChildren().find((element) => api.sessionDoctor.getTreeItem(element).label === label);
  assert.ok(group, `${label} group is present`);
  return api.sessionDoctor.getChildren(group);
}

function iconOf(item: vscode.TreeItem): [string, string | undefined] {
  assert.ok(item.iconPath instanceof vscode.ThemeIcon, `${String(item.label)} has a ThemeIcon`);
  return [item.iconPath.id, item.iconPath.color?.id];
}

function statusBarColors(api: ExtensionApi): [string | undefined, string | undefined] {
  const color = api.statusBar.color;
  assert.ok(color === undefined || color instanceof vscode.ThemeColor, "status bar color is a ThemeColor");
  return [color?.id, api.statusBar.backgroundColor?.id];
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

// One `agento.mjs dashboard --pr` document composed from the per-subcommand fixtures.
function dashboardResponse(
  session: unknown,
  doctor: unknown,
  status: unknown,
  initiatives: unknown = { list: { status: "ok", items: [] }, details: {} },
  metrics: unknown = metricsResponse(status),
) {
  return {
    status: "ok",
    session,
    doctor,
    deliveries: status,
    initiatives,
    metrics,
    timings: { session: 1, doctor: 1, deliveries: 1, initiatives: 1, metrics: 1, total: 5 },
    root: "/fixture/product",
    configSource: null,
  };
}

const timelineDelivery = {
  type: "feature",
  slug: "timeline-delivery",
  lifecycle: "building",
  status: "in-progress",
  roadmap: "features/2026/10/timeline-delivery/roadmap.md",
  steps: { ticked: 1, total: 2 },
  pr: null,
  companionPr: null,
  owner: null,
  workspace: null,
  companion: null,
  allowed: [],
  elsewhere: [],
};

// The `metrics` item for a status item: a closed plan phase, an open build, one round, one pause.
function metricsItem(delivery: { type: string; slug: string; roadmap: string; status: string }) {
  return {
    type: delivery.type,
    slug: delivery.slug,
    roadmap: delivery.roadmap,
    status: delivery.status,
    ref: `origin/feature/${delivery.slug}`,
    events: [
      { at: "2026-10-01T10:00:00+00:00", sha: "a1", kind: "status", value: "planned" },
      { at: "2026-10-01T12:00:00+00:00", sha: "a2", kind: "status", value: "in-progress" },
    ],
    phases: {
      planned: { start: "2026-10-01T10:00:00+00:00", end: "2026-10-01T12:00:00+00:00", seconds: 7200, open: false },
      build: { start: "2026-10-01T12:00:00+00:00", end: null, seconds: 3 * 3600 + 5 * 60, open: true },
      review: null,
    },
    cycle: { start: "2026-10-01T10:00:00+00:00", end: null, seconds: 5 * 3600 + 5 * 60, open: true },
    reviewRounds: 1,
    pauses: { count: 1, seconds: 1800, open: false },
    merged: null,
    postShip: { total: 0, ticked: 0, lastTickAt: null, latencySeconds: null, pending: false },
    warnings: [],
  };
}

function metricsResponse(status: unknown) {
  const items = (status as { items?: Array<{ type: string; slug: string; roadmap: string; status: string }> }).items ?? [];
  return { status: "ok", generatedAt: "2026-10-01T15:05:00.000Z", ref: { artifacts: "origin/main", product: "origin/main" }, items: items.map(metricsItem), aggregate: { count: items.length } };
}

// A throwaway primary checkout with a bare origin (plus, for `companion`, an `artifacts`
// companion clone with its own bare origin) for the real `agento.mjs start-session`.
function makeStartSessionFixture(companion: boolean): { base: string; product: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agento-e2e-start-session-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Agento Test", "-c", "user.email=agento@example.invalid", ...args], { cwd, stdio: "ignore" });
  const clone = (name: string, files: Record<string, string>) => {
    const origin = path.join(base, `${name}.git`);
    const work = path.join(base, name);
    git(base, "init", "--bare", "-q", "-b", "main", origin);
    git(base, "clone", "-q", origin, work);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
      fs.writeFileSync(path.join(work, rel), content);
    }
    git(work, "add", "-A");
    git(work, "commit", "-q", "--allow-empty", "-m", "fixture");
    git(work, "push", "-q", "-u", "origin", "main");
  };
  clone("product", { ".github/agento.json": JSON.stringify(companion ? { artifacts: { repo: { name: "artifacts" } } } : {}) });
  if (companion) clone("artifacts", {});
  return { base, product: path.join(base, "product") };
}

async function assertNewPlanCommand(
  api: ExtensionApi,
  expectedCommand: string,
  companion: boolean,
  execute: () => Thenable<unknown>,
  prompts?: string[],
): Promise<void> {
  const startFixture = makeStartSessionFixture(companion);
  const submitted: Array<{ command: string; target: NewPlanTarget }> = [];
  const opened: NewPlanTarget[] = [];
  const pending = new Map<string, unknown>();

  api.setNewPlanRunner((request) => runNewPlanFlow(request, {
      readSession: async () => (await api.client.run(["session"], startFixture.product)).json,
      startSession: cliStartSession(api.client),
      submitCommand: async (command, target) => { submitted.push({ command, target }); },
      pendingStore: {
        get: <T>(key: string) => pending.get(key) as T | undefined,
        update: async (key, value) => {
          if (value === undefined) pending.delete(key);
          else pending.set(key, value);
        },
      },
      openTarget: async (target) => { opened.push(target); },
      now: () => 1,
      offerRecovery: async () => undefined,
      offerOpenInChat: async (message) => assert.fail(message),
    }));

  try {
    await execute();
    assert.deepEqual(submitted, [], "a successful New Plan never submits to chat");
    assert.equal(opened.length, 1);
    const target = opened[0]!;
    const plan = /plan-\d{8}-\d{6}(?:-\d+)?/;
    const worktrees = path.join(startFixture.base, "product-worktrees");
    if (companion) {
      assert.equal(target.kind, "workspace");
      assert.equal(path.dirname(target.path), worktrees);
      assert.match(path.basename(target.path), new RegExp(`^${plan.source}\\.code-workspace$`));
    } else {
      assert.equal(target.kind, "folder");
      assert.equal(path.dirname(target.path), worktrees);
      assert.match(path.basename(target.path), new RegExp(`^${plan.source}$`));
    }
    assert.ok(fs.existsSync(target.path), `${target.path} was created by agento.mjs start-session`);
    const records = [...pending.values()] as Array<{ target: string; command: string }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.target, target.path, "the pending command is queued for the returned target");
    assert.equal(records[0]!.command, expectedCommand);
    if (prompts) assert.deepEqual(prompts, ["quickPick", "input:feature"]);
  } finally {
    api.setNewPlanRunner();
    api.setNewPlanPrompts();
    fs.rmSync(startFixture.base, { recursive: true, force: true });
  }
}

async function assertNewInitiativeCommand(
  api: ExtensionApi,
  fixture: string,
  inputKind: "brief" | "file",
): Promise<void> {
  const brief = "Improve planning\n\nPreserve this text exactly. ";
  const filePath = path.join(fixture, "briefs", "initiative plan.md");
  const expectedCommand = inputKind === "brief"
    ? `/agento new-initiative ${brief}`
    : "/agento new-initiative briefs/initiative plan.md";
  const promptEvents: string[] = [];
  const targets: NewInitiativeTarget[] = [];
  const chatCalls: unknown[][] = [];

  api.setNewInitiativePrompts({
    chooseInput: async () => { promptEvents.push("quickPick"); return inputKind; },
    enterBrief: async () => { promptEvents.push("editor"); return brief; },
    pickFile: async (primaryPath) => { promptEvents.push(`file:${primaryPath}`); return filePath; },
  });
  api.setNewInitiativeRunner((input) => runNewInitiativeFlow(input, {
    readSession: async () => ({
      status: "ok",
      worktrees: [{ path: fixture, role: "primary", isManaged: false, dirPrefix: null, repo: "product" }],
    }),
    isRegularFile: async () => true,
    dispatch: async (command, target) => {
      targets.push(target);
      await dispatchCommandToTarget(command, target, "Continue in primary.", {
        executeCommand: async (...args) => { chatCalls.push(args); },
        reportInfo: async () => undefined,
        pendingStore: { get: () => undefined, update: async () => undefined },
        openTarget: async () => undefined,
        chatMode: () => ({ mode: null, reason: "unused" }),
        commandFile: () => ({ file: null, reason: "unused" }),
        output: { appendLine() {} },
      }, true);
    },
  }));

  try {
    await vscode.commands.executeCommand("agento.newInitiative");
  } finally {
    api.setNewInitiativeRunner();
    api.setNewInitiativePrompts();
  }

  assert.deepEqual(targets, [{ kind: "folder", path: fixture }]);
  // The fixture resolves no plugin root, so the injected chatMode reports no mode and chatOpenOptions stays at { query }.
  assert.deepEqual(chatCalls, [["workbench.action.chat.open", { query: expectedCommand }]]);
  assert.deepEqual(promptEvents, inputKind === "brief" ? ["quickPick", "editor"] : ["quickPick", `file:${fixture}`]);
}

async function assertClosedInitiativeBriefRejected(api: ExtensionApi): Promise<void> {
  const errors: string[] = [];
  let dispatchAttempts = 0;

  api.setNewInitiativePrompts({
    chooseInput: async () => "brief",
    enterBrief: () => submittedInitiativeBrief(
      {
        isClosed: true,
        getText: () => assert.fail("closed document content must not be read"),
      },
      "Submit",
      async (message) => { errors.push(message); },
    ),
    pickFile: async () => undefined,
  });
  api.setNewInitiativeRunner(async () => {
    dispatchAttempts += 1;
    return { kind: "cancelled" };
  });

  try {
    await vscode.commands.executeCommand("agento.newInitiative");
  } finally {
    api.setNewInitiativeRunner();
    api.setNewInitiativePrompts();
  }

  assert.deepEqual(errors, ["The initiative brief editor was closed before submission."]);
  assert.equal(dispatchAttempts, 0, "closed briefs reach neither Chat nor pending dispatch");
}

async function assertOrphanMemberShowsMessage(api: ExtensionApi, inFlightMember: InitiativeTreeElement): Promise<void> {
  assert.ok(inFlightMember.kind === "member");
  const slug = "orphan-delivery";
  const orphan: InitiativeTreeElement = { ...inFlightMember, item: { ...inFlightMember.item, slug } };
  assert.deepEqual(initiativeMemberActionSource(orphan, api.deliveries.current.model), { slug, actions: [] });
  const window = vscode.window as { -readonly [K in keyof typeof vscode.window]: (typeof vscode.window)[K] };
  const originalInfo = window.showInformationMessage;
  const originalQuickPick = window.showQuickPick;
  const messages: string[] = [];
  let pickerShown = false;
  window.showInformationMessage = (async (message: string) => { messages.push(message); return undefined; }) as typeof window.showInformationMessage;
  window.showQuickPick = (async () => { pickerShown = true; return undefined; }) as typeof window.showQuickPick;
  try {
    await vscode.commands.executeCommand("agento.showActions", orphan);
  } finally {
    window.showInformationMessage = originalInfo;
    window.showQuickPick = originalQuickPick;
  }
  assert.deepEqual(messages, [`No Agento actions are available for ${slug} in this window.`]);
  assert.equal(pickerShown, false, "no actions picker for a member without a Deliveries row");
}

function deliveryElements(api: ExtensionApi, group: DeliveryTreeElement): DeliveryTreeElement[] {
  return api.deliveries.getChildren(group);
}

function assertCollapsedGroup(item: vscode.TreeItem): string {
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, `${String(item.label)} starts collapsed`);
  assert.match(String(item.id), /^agento:/, `${String(item.label)} has a per-window id`);
  return item.id!;
}

function assertLeaf(item: vscode.TreeItem): void {
  assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.None, `${String(item.label)} is a leaf`);
  assert.equal(item.id, undefined, `${String(item.label)} keeps a label-derived handle`);
}

// A delivery row's single child: the Timeline leaf, with no click command.
function timelineItem(api: ExtensionApi, delivery: DeliveryTreeElement): vscode.TreeItem {
  const children = api.deliveries.getChildren(delivery);
  assert.equal(children.length, 1, "one Timeline child per delivery");
  assert.equal(children[0]?.kind, "timeline");
  const item = api.deliveries.getTreeItem(children[0]!);
  assert.equal(item.label, "Timeline");
  assertLeaf(item);
  assert.deepEqual(iconOf(item), ["history", undefined]);
  assert.equal(item.contextValue, "agento.timeline");
  assert.equal(item.command, undefined);
  assert.deepEqual(api.deliveries.getChildren(children[0]!), []);
  return item;
}

function deliveryRows(api: ExtensionApi): DeliveryTreeElement[] {
  return api.deliveries.getChildren().flatMap((group) => deliveryElements(api, group));
}

async function assertGatedCommandsRejected(api: ExtensionApi, commands: Array<[GatedCommand, unknown?]>): Promise<void> {
  const window = vscode.window as { -readonly [K in keyof typeof vscode.window]: (typeof vscode.window)[K] };
  const originalError = window.showErrorMessage;
  const errors: string[] = [];
  window.showErrorMessage = (async (message: string) => { errors.push(message); return undefined; }) as typeof window.showErrorMessage;
  api.setNewPlanPrompts({
    chooseKind: async () => assert.fail("gated New Plan must not prompt for a kind"),
    describe: async () => assert.fail("gated New Plan must not prompt for a description"),
  });
  api.setNewPlanRunner(async () => assert.fail("gated New Plan / Plan must not run the plan flow"));
  api.setNewInitiativePrompts({
    chooseInput: async () => assert.fail("gated New Initiative must not prompt for input"),
    enterBrief: async () => assert.fail("gated New Initiative must not open a brief editor"),
    pickFile: async () => assert.fail("gated New Initiative must not pick a file"),
  });
  api.setNewInitiativeRunner(async () => assert.fail("gated New Initiative must not dispatch"));
  try {
    for (const [command, argument] of commands) {
      await vscode.commands.executeCommand(command, argument);
    }
  } finally {
    window.showErrorMessage = originalError;
    api.setNewPlanPrompts();
    api.setNewPlanRunner();
    api.setNewInitiativePrompts();
    api.setNewInitiativeRunner();
  }
  assert.deepEqual(errors, commands.map(([command]) => gateRejection(command, api.windowGate())));
  for (const message of errors) assert.match(message, /primary window/);
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
  assert.ok(commands.includes("agento.newPlan"));
  assert.ok(commands.includes("agento.newInitiative"));
  assert.ok(commands.includes("agento.planInitiativeMember"));
  assert.ok(commands.includes("agento.selectModelProfile"));

  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(fixture, "fixture workspace is open");
  if (process.env.AGENTO_ELECTRON_SCENARIO === "no-markdown") {
    assert.equal(vscode.extensions.getExtension("vscode.markdown-language-features"), undefined, "the built-in Markdown extension is disabled");
    await waitForReadyTree(api);
    const leaf = api.deliveries.getChildren().flatMap((group) => deliveryElements(api, group))[0];
    assert.ok(leaf);
    const command = api.deliveries.getTreeItem(leaf).command;
    assert.ok(command);
    const uri = command.arguments?.[0];
    assert.ok(uri instanceof vscode.Uri);
    const activeDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(fixture, ".github", "agento.json")));
    await vscode.window.showTextDocument(activeDocument, vscode.ViewColumn.One);
    const result = await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    assert.equal(result, "source", "the delivery roadmap falls back to source text");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputText, "the fallback opens a text editor tab");
    assert.equal(tab.input.uri.fsPath, uri.fsPath);
    assert.equal(tab.isPreview, false, "the fallback tab is pinned");
    assert.equal(tab.group.viewColumn, vscode.ViewColumn.One);
    assert.equal(vscode.window.tabGroups.all.length, 1, "the fallback opens in the active group without a split");
    assert.equal(previewTabsFor(uri).length, 0);
    console.log("Electron no-markdown scenario passed: source fallback in the active group");
    return;
  }
  if (process.env.AGENTO_ELECTRON_SCENARIO === "workspace") {
    assert.equal(vscode.workspace.workspaceFile?.fsPath, path.join(path.dirname(fixture), "plan-e2e.code-workspace"));
    for (const [key, value] of Object.entries(SESSION_WORKSPACE_SETTINGS)) {
      assert.deepEqual(vscode.workspace.getConfiguration().inspect(key)?.workspaceValue, value);
    }
    await waitForSessionDoctor(
      api,
      () => !(api.sessionDoctor.current.kind === "error" && api.sessionDoctor.current.message === "Session & Doctor has not loaded."),
      "to apply a session refresh",
    );
    const liveSession = await api.client.run(["session"], fixture);
    assert.deepEqual(api.windowGate(), windowGate(liveSession.json));
    assert.deepEqual(api.windowGate(), { primary: false, canPlan: true }, "a detached plan window keeps New Plan but not New Initiative");
    console.log("Electron workspace scenario passed: workspace file, scoped settings, window gate");
    return;
  }

  const session = await api.client.run(["session"], fixture);
  assert.equal(session.code, 0);
  assert.equal(typeof (session.json as { role?: unknown }).role, "string");

  await waitForReadyTree(api);
  await waitForReadyInitiatives(api);
  await waitForSessionDoctor(api, () => api.sessionDoctor.current.kind === "ready", "to load");
  assert.deepEqual(api.windowGate(), { primary: true, canPlan: true });
  assert.equal(api.statusBar.text, "Agento: primary · 2 active");
  assert.equal(api.statusBar.command, "agento.sessionDoctor.focus");
  assert.equal(api.sessionDoctor.current.kind, "ready");
  if (api.sessionDoctor.current.kind !== "ready") return;
  assert.equal(statusBarColors(api)[0], lifecycleStyle(api.sessionDoctor.current.session.lifecycle).color);
  assert.equal(api.windowBanner.current.title, "PRIMARY WINDOW");
  assert.equal(api.windowBanner.current.tone, "primary");
  assert.equal(api.windowBanner.current.colorId, "agento.role.primary");
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
  await vscode.commands.executeCommand("agento.dispatchAction", sessionAction, undefined, executeCommand);
  // The fixture has no plugin root, so resolveChatMode reports no mode and the submission stays { query }.
  assert.deepEqual(submitted.pop(), {
    command: "workbench.action.chat.open",
    options: { query: sessionAction.command },
  });

  const groups = api.deliveries.getChildren();
  assert.deepEqual(
    groups.map((group) => api.deliveries.getTreeItem(group).label),
    ["Planned", "Building", "In Review", "Shipped"],
  );
  groups.forEach((group) => assertCollapsedGroup(api.deliveries.getTreeItem(group)));
  assert.deepEqual(groups.map((group) => iconOf(api.deliveries.getTreeItem(group))), [
    ["circle-large-outline", "agento.status.planned"],
    ["sync", "agento.status.building"],
    ["eye", "agento.status.inReview"],
    ["pass-filled", "agento.status.shipped"],
  ]);
  for (const group of groups) {
    const [, groupColor] = iconOf(api.deliveries.getTreeItem(group));
    for (const leaf of deliveryElements(api, group)) {
      assert.deepEqual(iconOf(api.deliveries.getTreeItem(leaf)), ["git-pull-request", groupColor], "leaves share their group color");
    }
  }
  const items = groups.flatMap((group) => deliveryElements(api, group));
  const deliveryIds = items.map((item) => assertCollapsedGroup(api.deliveries.getTreeItem(item)));
  assert.equal(new Set(deliveryIds).size, deliveryIds.length, "each delivery row has its own id");
  for (const item of items) {
    assert.equal(api.deliveries.getTreeItem(item).command?.command, "agento.openRoadmap", "the label click still opens the roadmap");
    const timeline = timelineItem(api, item);
    assert.equal(typeof timeline.description, "string");
    assert.match(String(timeline.tooltip), /^Planned: .*\nBuild: .*\nReview: .*\nCycle: .*\nReview rounds: \d+\nPauses: \d+.*\nMerged: .*\nPost-ship: .*\nSource: origin\/\S+/);
  }
  // The fixture commits every roadmap at once, so a complete delivery's cycle is that one commit.
  assert.equal(timelineItem(api, items[3]!).description, "cycle <1m");
  assert.deepEqual(
    items.map((item) => api.deliveries.getTreeItem(item).label),
    ["planned-delivery", "building-delivery", "anomalous-delivery", "complete-delivery", "finished-delivery"],
  );
  assert.equal(api.deliveries.getTreeItem(items[0]!).description, "feature | 1/3 | planned | PR #101 draft");
  assert.ok(items[0]?.kind === "delivery");
  // A non-start-session action still submits to chat even though the refreshed next is start-session.
  const deliveryAction = items[0].item.actions.find((action) => action.window === "here" && action.command === "/agento delivery-status");
  assert.ok(deliveryAction);
  await vscode.commands.executeCommand("agento.dispatchAction", deliveryAction, items[0].item.slug, executeCommand);
  // Same fallback: no plugin root in the fixture, so { query } is the expected options shape.
  assert.deepEqual(submitted.pop(), {
    command: "workbench.action.chat.open",
    options: { query: deliveryAction.command },
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
      chatMode: () => ({ mode: null, reason: "unused" }),
      commandFile: () => ({ file: null, reason: "unused" }),
      startSession: async () => assert.fail("cross-window routes never run start-session"),
      offerOpenInChat: async () => undefined,
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
  assert.equal(activeEditor.viewColumn, vscode.ViewColumn.One);
  const roadmapUri = await assertOpensMarkdownPreview(deliveryTreeItem.command, activeDocument, "delivery roadmap");

  const initiativeRoots = api.initiatives.getChildren();
  assert.deepEqual(initiativeRoots.map((element) => api.initiatives.getTreeItem(element).label), ["agento-extension", "Completed (1)"]);
  const completedFolder = initiativeRoots[1]!;
  const completedFolderItem = api.initiatives.getTreeItem(completedFolder);
  assertCollapsedGroup(completedFolderItem);
  assert.match(String(completedFolderItem.id), /initiatives\/completed$/);
  assert.equal(completedFolderItem.contextValue, "agento.initiativesCompleted");
  assert.equal(completedFolderItem.command, undefined);
  assert.deepEqual(iconOf(completedFolderItem), ["archive", "agento.status.complete"]);
  const completedInitiatives = api.initiatives.getChildren(completedFolder);
  assert.deepEqual(completedInitiatives.map((element) => api.initiatives.getTreeItem(element).label), ["finished-initiative"]);
  assert.equal(api.initiatives.getTreeItem(completedInitiatives[0]!).contextValue, "agento.initiative");
  assert.deepEqual(iconOf(api.initiatives.getTreeItem(completedInitiatives[0]!)), ["type-hierarchy", "agento.status.complete"]);

  const initiative = api.initiatives.getChildren()[0];
  assert.ok(initiative?.kind === "initiative");
  const initiativeItem = api.initiatives.getTreeItem(initiative);
  assert.equal(initiativeItem.label, "agento-extension");
  assert.deepEqual(iconOf(initiativeItem), ["type-hierarchy", undefined]);
  assert.equal(initiativeItem.description, "1/6 complete | 3 in flight | 1 ready");
  assertCollapsedGroup(initiativeItem);
  const initiativeChildren = api.initiatives.getChildren(initiative);
  const diagnostic = initiativeChildren.find((element) => element.kind === "diagnostic");
  assert.ok(diagnostic);
  assert.match(String(api.initiatives.getTreeItem(diagnostic).label), /anomalous-delivery: merged-but-not-complete/);
  assert.deepEqual(iconOf(api.initiatives.getTreeItem(diagnostic)), ["warning", "agento.health.warn"]);
  const initiativeGroups = initiativeChildren.filter((element): element is Extract<InitiativeTreeElement, { kind: "group" }> => element.kind === "group");
  assert.deepEqual(initiativeGroups.map((group) => api.initiatives.getTreeItem(group).label), [
    "Ready (1)",
    "In flight (3)",
    "Blocked (1)",
    "Complete (1)",
  ]);
  const [readyGroupId] = initiativeGroups.map((group) => assertCollapsedGroup(api.initiatives.getTreeItem(group)));
  assert.deepEqual(initiativeGroups.map((group) => iconOf(api.initiatives.getTreeItem(group))), [
    ["play-circle", "agento.status.ready"],
    ["sync", "agento.status.inFlight"],
    ["lock", "agento.status.blocked"],
    ["pass-filled", "agento.status.complete"],
  ]);
  for (const group of initiativeGroups) {
    const groupIcon = iconOf(api.initiatives.getTreeItem(group));
    for (const member of api.initiatives.getChildren(group)) {
      assert.deepEqual(iconOf(api.initiatives.getTreeItem(member)), groupIcon, "members share their group glyph and color");
    }
  }
  const initiativeMembers = initiativeGroups.flatMap((group) => api.initiatives.getChildren(group));
  initiativeMembers.forEach((member) => assertLeaf(api.initiatives.getTreeItem(member)));
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
  const buildingMember = initiativeMembers.find((member) => api.initiatives.getTreeItem(member).label === "building-delivery");
  assert.ok(buildingMember);
  assert.equal(api.initiatives.getTreeItem(buildingMember).contextValue, "agento.initiativeMember.in-flight");
  const buildingDelivery = items.find((item) => item.kind === "delivery" && item.item.slug === "building-delivery");
  assert.ok(buildingDelivery?.kind === "delivery");
  assert.ok(buildingDelivery.item.actions.length > 0);
  assert.deepEqual(
    initiativeMemberActionSource(buildingMember, api.deliveries.current.model)?.actions,
    buildingDelivery.item.actions,
  );
  await assertOrphanMemberShowsMessage(api, buildingMember);

  await waitForSessionDoctor(api, () => api.windowGate().primary && api.windowGate().canPlan, "to open the window gate");
  const promptEvents: string[] = [];
  api.setNewPlanPrompts({
    chooseKind: async () => { promptEvents.push("quickPick"); return "feature"; },
    describe: async (kind) => { promptEvents.push(`input:${kind}`); return "Add guided planning"; },
  });
  await assertNewPlanCommand(
    api,
    "/agento new-feature Add guided planning",
    process.env.AGENTO_ELECTRON_SCENARIO === "companion",
    () => vscode.commands.executeCommand("agento.newPlan"),
    promptEvents,
  );
  await assertNewInitiativeCommand(api, fixture, "brief");
  await assertNewInitiativeCommand(api, fixture, "file");
  await assertClosedInitiativeBriefRejected(api);
  assert.equal(readyMember.kind, "member");
  if (readyMember.kind !== "member") return;
  await assertNewPlanCommand(
    api,
    `/agento new-feature initiative:${readyMember.initiativeSlug}/${readyMember.item.slug}`,
    process.env.AGENTO_ELECTRON_SCENARIO === "companion",
    () => vscode.commands.executeCommand("agento.planInitiativeMember", readyMember),
  );

  const memberTreeItem = api.initiatives.getTreeItem(readyMember);
  assert.ok(memberTreeItem.command);
  const breakdownUri = await assertOpensMarkdownPreview(memberTreeItem.command, activeDocument, "initiative member breakdown");
  const expectedArtifactRoot = process.env.AGENTO_ELECTRON_SCENARIO === "companion"
    ? path.join(path.dirname(fixture), "artifacts")
    : fixture;
  assert.equal(breakdownUri.fsPath, path.join(expectedArtifactRoot, "initiatives", "2026", "09", "agento-extension", "breakdown.md"));

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
  assert.equal(api.initiatives.getTreeItem(refreshedGroups[0]!).id, readyGroupId, "the ready group keeps its id across a count change");
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
  assert.deepEqual(iconOf(emptyItem), ["info", undefined]);

  api.deliveries.update({
    model: createDeliveryTreeError(new Error("fixture status failure")),
    roadmapRoot: fixture,
  });
  const errorItem = api.deliveries.getTreeItem(api.deliveries.getChildren()[0]!);
  assert.equal(errorItem.label, "Unable to load deliveries: fixture status failure");
  assert.equal(errorItem.contextValue, "agento.error");
  assert.deepEqual(iconOf(errorItem), ["error", "agento.health.fail"]);

  const artifactRoot = api.initiatives.current.artifactRoot;
  const healthyModel = api.initiatives.current.model;
  assert.equal(healthyModel.kind, "ready");
  if (healthyModel.kind !== "ready") return;
  api.initiatives.update({ model: { kind: "empty", message: "No initiatives found." }, artifactRoot });
  const emptyInitiative = api.initiatives.getTreeItem(api.initiatives.getChildren()[0]!);
  assert.equal(emptyInitiative.label, "No initiatives found.");
  assert.equal(emptyInitiative.contextValue, "agento.empty");
  assert.deepEqual(iconOf(emptyInitiative), ["info", undefined]);

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
  assert.deepEqual(iconOf(errorInitiative), ["error", "agento.health.fail"]);

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
  assert.deepEqual(iconOf(api.initiatives.getTreeItem(partialRoots[0]!)), ["warning", "agento.health.fail"]);
  const invalidDiagnostic = api.initiatives.getChildren(partialRoots[0]).find((element) => element.kind === "diagnostic");
  assert.ok(invalidDiagnostic);
  assert.equal(api.initiatives.getTreeItem(invalidDiagnostic).label, "dependency cycle among: a, b");
  assert.deepEqual(iconOf(api.initiatives.getTreeItem(invalidDiagnostic)), ["error", "agento.health.fail"]);
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
    assert.equal(pending.length, 2, "one CLI spawn per refresh");
    assert.deepEqual(pending.map((request) => request.args.slice(0, 2)), [["dashboard", "--pr"], ["dashboard", "--pr"]]);

    const resolveBatch = (batch: number, role: string, active: number, warnings: string[]) => {
      pending[batch]!.resolve({ code: 0, json: dashboardResponse(sessionResponse(role, warnings), doctorResponse, statusResponse(active)), stderr: "" });
    };

    const newerApplied = waitForSessionDoctor(
      api,
      () => api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role === "build",
      "newer overlapping refresh",
    );
    resolveBatch(1, "build", 1, ["fixture CLI warning"]);
    await newerApplied;
    assert.equal(api.statusBar.text, "Agento: build · 1 active");
    assert.deepEqual(statusBarColors(api), ["agento.status.building", "statusBarItem.warningBackground"]);
    assert.deepEqual(api.windowBanner.current, {
      tone: "build",
      title: "BUILD WINDOW",
      detail: "session-doctor-panel · feature/session-doctor-panel · building",
      tooltip: "/fixture/product\nClick to open Session & Doctor",
      colorId: "agento.role.build",
    });
    assert.deepEqual(api.windowGate(), CLOSED_GATE, "a build window closes the gate");
    await assertGatedCommandsRejected(api, [
      ["agento.newPlan"],
      ["agento.newInitiative"],
      ["agento.planInitiativeMember", readyMember],
    ]);

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
        chatMode: () => ({ mode: null, reason: "unused" }),
        commandFile: () => ({ file: null, reason: "unused" }),
        startSession: async () => assert.fail("cross-window routes never run start-session"),
        offerOpenInChat: async () => undefined,
      },
    );
    assert.equal(route.kind, "open");
    assert.deepEqual(loadedSlugs, ["session-doctor-panel"]);
    assert.deepEqual(openedTargets, ["/fixture/primary"]);

    const sessionDoctorGroups = api.sessionDoctor.getChildren();
    assert.deepEqual(sessionDoctorGroups.map((group) => api.sessionDoctor.getTreeItem(group).label), ["Session", "Companion", "Warnings", "Doctor"]);
    sessionDoctorGroups.forEach((group) => assertCollapsedGroup(api.sessionDoctor.getTreeItem(group)));
    assert.deepEqual(sessionDoctorGroups.map((group) => iconOf(api.sessionDoctor.getTreeItem(group))), [
      ["folder", undefined],
      ["folder", undefined],
      ["folder", undefined],
      ["pulse", "agento.health.fail"],
    ]);
    const lifecycleRow = sessionDoctorRows(api, "Session").find((element) => api.sessionDoctor.getTreeItem(element).label === "Lifecycle");
    assert.ok(lifecycleRow);
    assert.deepEqual(iconOf(api.sessionDoctor.getTreeItem(lifecycleRow)), ["sync", "agento.status.building"]);
    assert.deepEqual(iconOf(api.sessionDoctor.getTreeItem(sessionDoctorRows(api, "Warnings")[0]!)), ["warning", "agento.health.warn"]);

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
    assert.deepEqual(doctorRows.map(iconOf), [
      ["pass", "agento.health.ok"],
      ["warning", "agento.health.warn"],
      ["error", "agento.health.fail"],
    ]);
    assert.equal(doctorRows[0]?.tooltip, "Detail: node fixture\nFallback: none");
    assert.equal(doctorRows[1]?.tooltip, "Detail: browser fixture warning\nFallback: run headless verification");
    assert.equal(doctorRows[2]?.tooltip, "Detail: gh fixture failure\nFallback: run gh auth login");

    resolveBatch(0, "primary", 0, []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role, "build");
    assert.equal(api.statusBar.text, "Agento: build · 1 active");
    assert.deepEqual(api.windowGate(), CLOSED_GATE, "a stale primary refresh does not reopen the gate");

    const refreshWith = async (json: unknown, predicate: () => boolean, description: string) => {
      const start = pending.length;
      await vscode.commands.executeCommand("agento.refresh");
      assert.equal(pending.length, start + 1);
      assert.equal(pending[start]!.args[0], "dashboard");
      const applied = waitForSessionDoctor(api, predicate, description);
      pending[start]!.resolve({ code: 0, json, stderr: "" });
      await applied;
    };
    const refreshWithSession = (sessionJson: unknown, predicate: () => boolean, description: string) =>
      refreshWith(dashboardResponse(sessionJson, doctorResponse, statusResponse(0)), predicate, description);
    const detachedPlan = sessionResponse("plan");
    await refreshWithSession(
      { ...detachedPlan, worktree: { ...detachedPlan.worktree, branch: null, detached: true } },
      () => api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role === "plan",
      "detached plan refresh",
    );
    assert.equal(api.windowBanner.current.title, "PLAN WINDOW");
    assert.equal(api.windowBanner.current.tone, "plan");
    assert.match(api.windowBanner.current.detail, /^detached\b/);
    assert.deepEqual(api.windowGate(), { primary: false, canPlan: true }, "a detached plan window opens canPlan only");
    await assertGatedCommandsRejected(api, [["agento.newInitiative"]]);
    await refreshWithSession(
      { status: "failed", role: "primary" },
      () => api.sessionDoctor.current.kind === "error",
      "invalid session refresh",
    );
    assert.deepEqual(api.windowGate(), CLOSED_GATE, "an invalid session record closes the gate");
    assert.equal(api.statusBar.text, "Agento: unavailable");
    assert.deepEqual(statusBarColors(api), [undefined, "statusBarItem.errorBackground"]);
    assert.equal(api.windowBanner.current.title, "AGENTO UNAVAILABLE");
    assert.equal(api.windowBanner.current.tone, "unavailable");
    assert.match(api.windowBanner.current.detail, /^Invalid Session & Doctor response:/);
    const bannerHtml = await focusWindowBanner(api);
    assert.ok(bannerHtml.includes("AGENTO UNAVAILABLE"), "the banner resolves with the latest state");
    assert.ok(bannerHtml.includes("--vscode-agento-role-unavailable"));
    assert.ok(bannerHtml.includes("command:agento.sessionDoctor.focus"));
    assert.doesNotMatch(bannerHtml, /<script/i);

    // A failing dashboard section renders only the error state of the views that read it.
    await refreshWith(
      dashboardResponse(sessionResponse("primary"), doctorResponse, statusResponse(2), { status: "error", message: "fixture breakdown unreadable" }),
      () => api.sessionDoctor.current.kind === "ready" && api.sessionDoctor.current.session.role === "primary",
      "initiatives section error",
    );
    assert.equal(api.initiatives.current.model.kind, "error");
    assert.equal(api.initiatives.current.model.kind === "error" && api.initiatives.current.model.message, "Unable to load initiatives: fixture breakdown unreadable");
    assert.notEqual(api.deliveries.current.model.kind, "error");
    assert.equal(api.statusBar.text, "Agento: primary · 2 active");
    assert.deepEqual(api.windowGate(), { primary: true, canPlan: true });
    await refreshWith(
      dashboardResponse(sessionResponse("primary"), { status: "error", message: "fixture doctor crashed" }, statusResponse(1)),
      () => api.sessionDoctor.current.kind === "error",
      "doctor section error",
    );
    // Read through a widened type: the earlier `kind === "ready"` guard narrowed the property.
    const failedModel = api.sessionDoctor.current as { kind: string; message?: string };
    assert.deepEqual([failedModel.kind, failedModel.message], ["error", "Unable to load Session & Doctor: fixture doctor crashed"]);
    assert.notEqual(api.deliveries.current.model.kind, "error");
    assert.notEqual(api.initiatives.current.model.kind, "error");
    assert.deepEqual(api.windowGate(), { primary: true, canPlan: true }, "a doctor failure leaves the session's gate open");

    // The Timeline row reads the metrics section of the same document.
    const timelineStatus = { ...statusResponse(1), items: [timelineDelivery] };
    const hasTimelineDelivery = () => deliveryRows(api).some((row) => row.kind === "delivery" && row.item.slug === "timeline-delivery");
    await refreshWith(
      dashboardResponse(sessionResponse("primary"), doctorResponse, timelineStatus),
      () => api.sessionDoctor.current.kind === "ready" && hasTimelineDelivery(),
      "metrics section",
    );
    const [timelineRow] = deliveryRows(api);
    assert.ok(timelineRow);
    assertCollapsedGroup(api.deliveries.getTreeItem(timelineRow));
    const fixtureTimeline = timelineItem(api, timelineRow);
    assert.equal(fixtureTimeline.description, "plan 2h 00m · build 3h 05m… · 1 round · paused 30m");
    assert.equal(fixtureTimeline.tooltip, createTimelineRow(metricsItem(timelineDelivery)).tooltip);
    assert.match(String(fixtureTimeline.tooltip), /^Build: 2026-10-01 12:00 \+00:00 → now \(3h 05m…\)$/m);
    assert.match(String(fixtureTimeline.tooltip), /^Source: origin\/feature\/timeline-delivery$/m);

    await refreshWith(
      dashboardResponse(sessionResponse("primary"), doctorResponse, timelineStatus, undefined, { status: "error", message: "fixture git log failed" }),
      () => api.sessionDoctor.current.kind === "ready" && deliveryRows(api).every((row) => timelineItem(api, row).description === "unavailable"),
      "metrics section error",
    );
    assert.equal(api.deliveries.current.model.kind, "ready", "a metrics failure leaves Deliveries ready");
    for (const row of deliveryRows(api)) {
      const failed = timelineItem(api, row);
      assert.equal(failed.description, "unavailable");
      assert.equal(failed.tooltip, "fixture git log failed");
    }
  } finally {
    api.client.run = originalRun;
  }

  api.sessionDoctor.update(createSessionDoctorError(new Error("fixture session failure")));
  const retryItem = api.sessionDoctor.getTreeItem(api.sessionDoctor.getChildren()[0]!);
  assert.equal(retryItem.label, "Unable to load Session & Doctor: fixture session failure");
  assert.equal(retryItem.contextValue, "agento.sessionDoctor.error");
  assert.equal(retryItem.command?.command, "agento.refresh");
  assert.deepEqual(iconOf(retryItem), ["error", "agento.health.fail"]);
  await waitForSessionDoctor(
    api,
    () => api.sessionDoctor.current.kind === "ready",
    "inline retry",
    () => vscode.commands.executeCommand(retryItem.command!.command),
  );
  assert.deepEqual(api.windowGate(), { primary: true, canPlan: true }, "the live primary session reopens the gate");
  assert.equal(api.windowBanner.current.title, "PRIMARY WINDOW");
  assert.ok(api.windowBanner.html?.includes("PRIMARY WINDOW"), "an attached banner re-renders on refresh");
  assert.ok(api.windowBanner.html?.includes("--vscode-agento-role-primary"));

  console.log(`Electron ${process.env.AGENTO_ELECTRON_SCENARIO} scenario passed: initiatives, deliveries, session doctor, window banner, roadmap refresh, diagnostics, stale/error handling`);
}