import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { deliveryActionSource, pickCommandAction } from "./actionPicker.js";
import { CliClient } from "./cliClient.js";
import { consumePendingCommands, dispatchCommandAction, dispatchCommandToTarget, type ChatModeResolver, type CommandExecutor, type CommandFileResolver } from "./commandDispatcher.js";
import { resolveChatMode, resolveCommandFile } from "./commandAgent.js";
import type { CommandAction } from "./commandActions.js";
import { formatDashboardTimings, splitDashboardDocument } from "./dashboardDocument.js";
import { createTimelineRows } from "./deliveryTimeline.js";
import { createDeliveryTreeError, createDeliveryTreeModel } from "./deliveryTreeModel.js";
import { DeliveryTreeProvider, type DeliveryTreeElement, type DeliveryTreeSnapshot } from "./deliveryTreeProvider.js";
import { FilePendingDispatchStore } from "./filePendingDispatchStore.js";
import { resolveGitDir, type GitDirectories } from "./gitDir.js";
import { initiativeMemberActionSource } from "./initiativeMemberActions.js";
import { createInitiativeTreeError, createInitiativeTreeModel } from "./initiativeTreeModel.js";
import { InitiativeTreeProvider, type InitiativeTreeElement, type InitiativeTreeSnapshot } from "./initiativeTreeProvider.js";
import { LatestDeliveryRefresh } from "./latestDeliveryRefresh.js";
import { missingPluginRootMessage, resolvePluginRoot, selectionToArgs, summarizeModelsResult, toQuickPickItems } from "./modelProfiles.js";
import { openArtifactPreview } from "./openArtifact.js";
import {
  primaryInitiativeTarget,
  runNewInitiativeFlow,
  submittedInitiativeBrief,
  type NewInitiativeFlowDependencies,
  type NewInitiativeFlowResult,
  type NewInitiativeInput,
} from "./newInitiativeFlow.js";
import {
  createInitiativePlanRequest,
  createNewPlanRequest,
  runNewPlanFlow,
  type NewPlanFlowDependencies,
  type NewPlanFlowResult,
  type NewPlanRequest,
} from "./newPlanFlow.js";
import { RefreshScheduler } from "./refreshScheduler.js";
import { createSessionDoctorError, createSessionDoctorModel, type SessionDoctorModel } from "./sessionDoctorModel.js";
import { SessionDoctorProvider } from "./sessionDoctorProvider.js";
import { cliStartSession, OPEN_IN_CHAT } from "./startSessionCli.js";
import { createTreeIdScope } from "./treeItemIds.js";
import { createWatchers } from "./watchers.js";
import { createWindowBannerModel } from "./windowBanner.js";
import { WindowBannerProvider } from "./windowBannerProvider.js";
import { CLOSED_GATE, gateRejection, windowGate, type WindowGate } from "./windowGate.js";

export interface ExtensionApi {
  client: CliClient;
  scheduler: RefreshScheduler;
  deliveries: DeliveryTreeProvider;
  initiatives: InitiativeTreeProvider;
  sessionDoctor: SessionDoctorProvider;
  sessionDoctorView: vscode.TreeView<unknown>;
  statusBar: vscode.StatusBarItem;
  windowBanner: WindowBannerProvider;
  output: vscode.OutputChannel;
  dispatchAction: (action: CommandAction, slug?: string, executeCommand?: CommandExecutor) => Promise<unknown>;
  startNewPlan: (
    request: NewPlanRequest,
    dependencies?: NewPlanFlowDependencies,
  ) => Promise<NewPlanFlowResult>;
  setNewPlanRunner: (runner?: (request: NewPlanRequest) => Promise<NewPlanFlowResult>) => void;
  setNewPlanPrompts: (prompts?: NewPlanPrompts) => void;
  startNewInitiative: (input: NewInitiativeInput, dependencies?: NewInitiativeFlowDependencies) => Promise<NewInitiativeFlowResult>;
  setNewInitiativeRunner: (runner?: (input: NewInitiativeInput) => Promise<NewInitiativeFlowResult>) => void;
  setNewInitiativePrompts: (prompts?: NewInitiativePrompts) => void;
  windowGate: () => WindowGate;
}

interface NewPlanPrompts {
  chooseKind: () => Promise<"feature" | "issue" | undefined>;
  describe: (kind: "feature" | "issue") => Promise<string | undefined>;
}

interface NewInitiativePrompts {
  chooseInput: () => Promise<"brief" | "file" | undefined>;
  enterBrief: () => Promise<string | undefined>;
  pickFile: (primaryPath: string) => Promise<string | undefined>;
}

interface ConfigResult {
  artifactsRoot?: unknown;
}

function applyStatusBar(statusBar: vscode.StatusBarItem, model: SessionDoctorModel): void {
  const { color, background } = model.statusBarStyle;
  statusBar.text = model.statusBarText;
  statusBar.color = color ? new vscode.ThemeColor(color) : undefined;
  statusBar.backgroundColor = background ? new vscode.ThemeColor(`statusBarItem.${background}Background`) : undefined;
}

function applySessionIndicators(statusBar: vscode.StatusBarItem, windowBanner: WindowBannerProvider, model: SessionDoctorModel): void {
  applyStatusBar(statusBar, model);
  windowBanner.update(createWindowBannerModel(model));
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel("Agento");
  const configuration = vscode.workspace.getConfiguration("agento");
  const client = new CliClient({
    nodePath: configuration.get<string>("nodePath", "node"),
    cliPath: path.join(context.extensionPath, "cli", "agento.mjs"),
    output,
  });
  const scheduler = new RefreshScheduler(configuration.get<number>("refreshDebounceMs", 3000));
  const treeId = createTreeIdScope();
  const deliveries = new DeliveryTreeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath, treeId);
  const initiatives = new InitiativeTreeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath, treeId);
  const sessionDoctor = new SessionDoctorProvider(treeId);
  const pendingStore = new FilePendingDispatchStore(path.join(context.globalStorageUri.fsPath, "pending-dispatch"));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "Agento Session & Doctor";
  statusBar.text = "Agento: unavailable";
  statusBar.tooltip = "Open Session & Doctor";
  statusBar.command = "agento.sessionDoctor.focus";
  statusBar.show();
  const windowBanner = new WindowBannerProvider(createWindowBannerModel(sessionDoctor.current));
  const latestDeliveryRefresh = new LatestDeliveryRefresh();
  const roadmapRoots = new Map<string, string>();
  let watcherDisposables: vscode.Disposable[] = [];
  let gate = CLOSED_GATE;
  const applyGate = (next: WindowGate): void => {
    gate = next;
    void vscode.commands.executeCommand("setContext", "agento.primary", next.primary);
    void vscode.commands.executeCommand("setContext", "agento.canPlan", next.canPlan);
  };
  applyGate(CLOSED_GATE);
  const pluginRoot = (): string | null => resolvePluginRoot({
    configured: vscode.workspace.getConfiguration("agento").get<string>("pluginRoot", ""),
    pluginLocations: vscode.workspace.getConfiguration("chat").get<Record<string, unknown>>("pluginLocations"),
    homedir: os.homedir(),
    exists: (filePath) => fs.existsSync(filePath),
    readJson: (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")),
  });
  const chatMode: ChatModeResolver = (command) => resolveChatMode(command, {
    pluginRoot: pluginRoot(),
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });
  const commandFile: CommandFileResolver = (command) => {
    const resolution = resolveCommandFile(command, {
      pluginRoot: pluginRoot(),
      exists: (filePath) => fs.existsSync(filePath),
    });
    if (resolution.path === null) return { file: null, reason: resolution.reason };
    return { file: vscode.Uri.file(resolution.path) };
  };

  const rebuildWatchers = async (): Promise<void> => {
    for (const disposable of watcherDisposables) {
      disposable.dispose();
    }
    watcherDisposables = [];

    const roots = new Map<string, vscode.Uri>();
    roadmapRoots.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.set(folder.uri.fsPath, folder.uri);
      roadmapRoots.set(folder.uri.fsPath, folder.uri.fsPath);
      try {
        const result = await client.run(["config"], folder.uri.fsPath);
        const artifactsRoot = (result.json as ConfigResult).artifactsRoot;
        if (typeof artifactsRoot === "string") {
          roots.set(artifactsRoot, vscode.Uri.file(artifactsRoot));
          roadmapRoots.set(folder.uri.fsPath, artifactsRoot);
        }
      } catch (error) {
        output.appendLine(`config: ${folder.uri.fsPath}: ${String(error)}`);
      }
    }

    const gitDirs: GitDirectories[] = [];
    for (const root of roots.values()) {
      try {
        gitDirs.push(await resolveGitDir(root.fsPath));
      } catch (error) {
        output.appendLine(`gitdir: ${root.fsPath}: ${String(error)}`);
      }
    }
    watcherDisposables = createWatchers({
      roots: [...roots.values()],
      gitDirs,
      onEvent: (reason) => scheduler.schedule(reason),
      output,
    });
  };

  const refreshSubscription = scheduler.onDidRefresh(({ reasons }) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    output.appendLine(`refresh: ${reasons.join(", ")}`);
    if (!folder) {
      const message = "No workspace folder is open.";
      applyGate(CLOSED_GATE);
      deliveries.update({ model: createDeliveryTreeError(message), roadmapRoot: context.extensionPath });
      initiatives.update({ model: createInitiativeTreeError(message), artifactRoot: context.extensionPath });
      const model = createSessionDoctorError(message);
      sessionDoctor.update(model);
      applySessionIndicators(statusBar, windowBanner, model);
      output.appendLine(message);
      return;
    }
    void latestDeliveryRefresh.run<{
      deliveries: DeliveryTreeSnapshot;
      sessionDoctor: ReturnType<typeof createSessionDoctorModel>;
      gate: WindowGate;
      initiatives: InitiativeTreeSnapshot;
      timings: string | null;
    }>(
      async () => {
        const root = pluginRoot();
        const result = await client.run(["dashboard", "--pr", ...(root ? ["--plugin-root", root] : [])], folder.uri.fsPath);
        const { session, doctor, deliveries: status, initiatives: initiativeSection, metrics, timings } = splitDashboardDocument(result.json);
        const artifactRoot = roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath;
        // Session & Doctor reads the session, doctor, and status documents; it errors only when one of them did.
        const sessionDoctorError = [session, doctor, status].find((value) => value instanceof Error);
        return {
          deliveries: {
            model: status instanceof Error ? createDeliveryTreeError(status) : createDeliveryTreeModel(status, metrics === null ? null : createTimelineRows(metrics)),
            roadmapRoot: artifactRoot,
          },
          sessionDoctor: sessionDoctorError ? createSessionDoctorError(sessionDoctorError) : createSessionDoctorModel(session, doctor, status),
          gate: session instanceof Error ? CLOSED_GATE : windowGate(session),
          initiatives: {
            model: initiativeSection instanceof Error
              ? createInitiativeTreeError(initiativeSection)
              : createInitiativeTreeModel(initiativeSection.list, initiativeSection.details),
            artifactRoot,
          },
          timings: formatDashboardTimings(timings),
        };
      },
      (snapshot) => {
        applyGate(snapshot.gate);
        deliveries.update(snapshot.deliveries);
        sessionDoctor.update(snapshot.sessionDoctor);
        applySessionIndicators(statusBar, windowBanner, snapshot.sessionDoctor);
        initiatives.update(snapshot.initiatives);
        if (snapshot.timings) {
          output.appendLine(snapshot.timings);
        }
        for (const warning of snapshot.deliveries.model.warnings) {
          output.appendLine(warning);
        }
        if (snapshot.deliveries.model.kind === "error") {
          output.appendLine(snapshot.deliveries.model.message);
        }
        if (snapshot.sessionDoctor.kind === "ready") {
          for (const warning of snapshot.sessionDoctor.warnings) {
            output.appendLine(warning);
          }
        } else {
          output.appendLine(snapshot.sessionDoctor.message);
        }
        if (snapshot.initiatives.model.kind === "error") {
          output.appendLine(snapshot.initiatives.model.message);
        } else if (snapshot.initiatives.model.kind === "ready") {
          for (const item of snapshot.initiatives.model.items) {
            for (const diagnostic of item.diagnostics) {
              output.appendLine(`initiative ${item.slug}: ${diagnostic.message}`);
            }
          }
        }
      },
      (error) => {
        applyGate(CLOSED_GATE);
        const artifactRoot = roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath;
        deliveries.update({ model: createDeliveryTreeError(error), roadmapRoot: artifactRoot });
        const model = createSessionDoctorError(error);
        sessionDoctor.update(model);
        applySessionIndicators(statusBar, windowBanner, model);
        initiatives.update({ model: createInitiativeTreeError(error), artifactRoot });
        output.appendLine(String(error));
      },
    );
  });

  const refreshCommand = vscode.commands.registerCommand("agento.refresh", () => scheduler.refreshNow("command"));
  const showOutputCommand = vscode.commands.registerCommand("agento.showOutput", () => output.show());
  const openArtifact = (uri: vscode.Uri) => openArtifactPreview(uri, {
    previewAvailable: () => vscode.extensions.getExtension("vscode.markdown-language-features") !== undefined,
    openWith: (target, viewType) => vscode.commands.executeCommand(
      "vscode.openWith",
      target,
      viewType,
      { viewColumn: vscode.ViewColumn.Active, preview: false },
    ),
    openSource: (target) => vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Active, preview: false }),
    log: (message) => output.appendLine(message),
  });
  const openRoadmapCommand = vscode.commands.registerCommand("agento.openRoadmap", openArtifact);
  const openBreakdownCommand = vscode.commands.registerCommand("agento.openBreakdown", openArtifact);
  const openTarget = (target: { kind: "folder" | "workspace"; path: string }) => vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(target.path),
    { forceNewWindow: true },
  );
  const startSession = cliStartSession(client);
  const dispatchAction = (action: CommandAction, slug?: string, executeCommand?: CommandExecutor) => dispatchCommandAction(
    action,
    slug,
    {
      currentWindow: () => sessionDoctor.current.kind === "ready" && sessionDoctor.current.session.role === "primary" ? "primary" : "secondary",
      loadNext: async (deliverySlug) => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error("No workspace folder is open.");
        return (await client.run(["next", deliverySlug], folder.uri.fsPath)).json;
      },
      executeCommand: vscode.commands.executeCommand,
      reportError: (message) => vscode.window.showErrorMessage(message),
      reportInfo: (message, actionLabel) => vscode.window.showInformationMessage(message, actionLabel),
      output,
      pendingStore,
      openTarget,
      chatMode,
      commandFile,
      startSession: async (args) => {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error("No workspace folder is open.");
        return vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Starting Agento session" },
          () => startSession(args, folder.uri.fsPath),
        );
      },
      offerOpenInChat: (message) => vscode.window.showErrorMessage(message, OPEN_IN_CHAT),
    },
    executeCommand,
  );
  const currentTargetPaths = (): Set<string> => new Set([
    vscode.workspace.workspaceFile?.fsPath,
    ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  ].filter((target): target is string => Boolean(target)));
  const productionNewPlanDependencies = (): NewPlanFlowDependencies => ({
    readSession: async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) throw new Error("No workspace folder is open.");
      return (await client.run(["session"], root)).json;
    },
    startSession: async (args, root) => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Starting Agento planning session" },
      () => startSession(args, root),
    ),
    submitCommand: (command, target) => dispatchCommandToTarget(
      command,
      target,
      "Continue starting the planning session in the primary window.",
      {
        executeCommand: vscode.commands.executeCommand,
        reportInfo: (message, actionLabel) => vscode.window.showInformationMessage(message, actionLabel),
        pendingStore,
        openTarget,
        chatMode,
        commandFile,
        output,
      },
      currentTargetPaths().has(target.path),
    ),
    pendingStore,
    openTarget,
    now: Date.now,
    offerRecovery: async (message, actions) => vscode.window.showWarningMessage(message, ...actions),
    offerOpenInChat: async (message) => vscode.window.showErrorMessage(message, OPEN_IN_CHAT),
  });
  const startNewPlan = async (
    request: NewPlanRequest,
    dependencies?: NewPlanFlowDependencies,
  ): Promise<NewPlanFlowResult> => {
    if (dependencies) return runNewPlanFlow(request, dependencies);
    const result = await runNewPlanFlow(request, productionNewPlanDependencies());
    if (result.kind === "failed" && !result.reported) await vscode.window.showErrorMessage(result.reason);
    return result;
  };
  let newPlanRunner = (request: NewPlanRequest) => startNewPlan(request);
  const setNewPlanRunner = (runner?: (request: NewPlanRequest) => Promise<NewPlanFlowResult>): void => {
    newPlanRunner = runner ?? ((request) => startNewPlan(request));
  };
  const defaultNewPlanPrompts: NewPlanPrompts = {
    chooseKind: async () => (await vscode.window.showQuickPick(
      [
        { label: "Feature", description: "Plan a new capability", planKind: "feature" as const },
        { label: "Issue", description: "Plan a defect fix", planKind: "issue" as const },
      ],
      { title: "New Plan", placeHolder: "Choose the kind of work" },
    ))?.planKind,
    describe: async (kind) => vscode.window.showInputBox({
      title: `New ${kind === "feature" ? "Feature" : "Issue"}`,
      prompt: "Describe the work in one line",
      placeHolder: kind === "feature" ? "Add a guided planning flow" : "Fix planning window handoff",
      validateInput: (value) => {
        try {
          createNewPlanRequest(kind, value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    }),
  };
  let newPlanPrompts = defaultNewPlanPrompts;
  const setNewPlanPrompts = (prompts?: NewPlanPrompts): void => {
    newPlanPrompts = prompts ?? defaultNewPlanPrompts;
  };
  const newPlanCommand = vscode.commands.registerCommand("agento.newPlan", async () => {
    const rejection = gateRejection("agento.newPlan", gate);
    if (rejection) {
      output.appendLine(`new plan: ${rejection}`);
      await vscode.window.showErrorMessage(rejection);
      return;
    }
    const kind = await newPlanPrompts.chooseKind();
    if (!kind) return;
    const description = await newPlanPrompts.describe(kind);
    if (description === undefined) return;
    return newPlanRunner(createNewPlanRequest(kind, description));
  });
  const readSession = async (): Promise<unknown> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error("No workspace folder is open.");
    return (await client.run(["session"], root)).json;
  };
  const productionNewInitiativeDependencies: NewInitiativeFlowDependencies = {
    readSession,
    isRegularFile: async (filePath) => ((await vscode.workspace.fs.stat(vscode.Uri.file(filePath))).type & vscode.FileType.File) !== 0,
    dispatch: (command, target) => dispatchCommandToTarget(
      command,
      target,
      "Continue creating the initiative in the primary window.",
      {
        executeCommand: vscode.commands.executeCommand,
        reportInfo: (message, actionLabel) => vscode.window.showInformationMessage(message, actionLabel),
        pendingStore,
        openTarget,
        chatMode,
        commandFile,
        output,
      },
      currentTargetPaths().has(target.path),
    ),
  };
  const startNewInitiative = async (
    input: NewInitiativeInput,
    dependencies: NewInitiativeFlowDependencies = productionNewInitiativeDependencies,
  ): Promise<NewInitiativeFlowResult> => runNewInitiativeFlow(input, dependencies);
  let newInitiativeRunner = (input: NewInitiativeInput) => startNewInitiative(input);
  const setNewInitiativeRunner = (runner?: (input: NewInitiativeInput) => Promise<NewInitiativeFlowResult>): void => {
    newInitiativeRunner = runner ?? ((input) => startNewInitiative(input));
  };
  const defaultNewInitiativePrompts: NewInitiativePrompts = {
    chooseInput: async () => (await vscode.window.showQuickPick(
      [
        { label: "Enter brief", description: "Write a multi-line initiative brief", inputKind: "brief" as const },
        { label: "Pick a file", description: "Use a brief from the primary repository", inputKind: "file" as const },
      ],
      { title: "New Initiative", placeHolder: "Choose an initiative brief source" },
    ))?.inputKind,
    enterBrief: async () => {
      const document = await vscode.workspace.openTextDocument({ language: "markdown", content: "" });
      await vscode.window.showTextDocument(document);
      const selection = await vscode.window.showInformationMessage(
        "Submit the initiative brief from this editor.",
        "Submit",
        "Cancel",
      );
      return submittedInitiativeBrief(document, selection, (message) => vscode.window.showErrorMessage(message));
    },
    pickFile: async (primaryPath) => (await vscode.window.showOpenDialog({
      title: "Select Initiative Brief",
      defaultUri: vscode.Uri.file(primaryPath),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    }))?.[0]?.fsPath,
  };
  let newInitiativePrompts = defaultNewInitiativePrompts;
  const setNewInitiativePrompts = (prompts?: NewInitiativePrompts): void => {
    newInitiativePrompts = prompts ?? defaultNewInitiativePrompts;
  };
  const newInitiativeCommand = vscode.commands.registerCommand("agento.newInitiative", async () => {
    const rejection = gateRejection("agento.newInitiative", gate);
    if (rejection) {
      output.appendLine(`new initiative: ${rejection}`);
      await vscode.window.showErrorMessage(rejection);
      return;
    }
    try {
      const inputKind = await newInitiativePrompts.chooseInput();
      if (!inputKind) return;
      const input = inputKind === "brief"
        ? { kind: "brief" as const, text: await newInitiativePrompts.enterBrief() }
        : { kind: "file" as const, path: await newInitiativePrompts.pickFile(primaryInitiativeTarget(await readSession()).path) };
      if ((input.kind === "brief" ? input.text : input.path) === undefined) return;
      const result = await newInitiativeRunner(input as NewInitiativeInput);
      if (result.kind === "failed") {
        output.appendLine(`new initiative: ${result.reason}`);
        await vscode.window.showErrorMessage(result.reason);
      }
      return result;
    } catch (error) {
      const message = `Unable to create initiative: ${error instanceof Error ? error.message : String(error)}`;
      output.appendLine(message);
      await vscode.window.showErrorMessage(message);
      return { kind: "failed", reason: message } satisfies NewInitiativeFlowResult;
    }
  });
  const planInitiativeMemberCommand = vscode.commands.registerCommand(
    "agento.planInitiativeMember",
    async (element?: InitiativeTreeElement) => {
      const rejection = gateRejection("agento.planInitiativeMember", gate);
      if (rejection) {
        output.appendLine(`plan initiative member: ${rejection}`);
        await vscode.window.showErrorMessage(rejection);
        return;
      }
      if (!element || element.kind !== "member" || element.groupKind !== "ready") {
        await vscode.window.showErrorMessage("Only ready initiative members can be planned.");
        return;
      }
      return newPlanRunner(createInitiativePlanRequest(element.initiativeSlug, element.item.slug));
    },
  );
  const dispatchActionCommand = vscode.commands.registerCommand("agento.dispatchAction", dispatchAction);
  const selectModelProfileCommand = vscode.commands.registerCommand("agento.selectModelProfile", async () => {
    const reportError = async (message: string) => {
      output.appendLine(`models: ${message}`);
      await vscode.window.showErrorMessage(message);
    };
    const root = pluginRoot();
    if (!root) {
      await reportError(missingPluginRootMessage(vscode.workspace.getConfiguration("agento").get<string>("pluginRoot", ""), os.homedir()));
      return;
    }
    try {
      const list = await client.run(["models", "list", "--plugin-root", root], root);
      if (list.code !== 0) {
        await reportError(summarizeModelsResult(list.json).message);
        return;
      }
      const profilesFile = (list.json as { profilesFile?: { path?: unknown } }).profilesFile?.path;
      const picked = await vscode.window.showQuickPick(toQuickPickItems(list.json), {
        title: "Agento: Select Model Profile",
        placeHolder: `Profiles from ${typeof profilesFile === "string" ? profilesFile : "model-profiles.json"}, applied to ${root}`,
      });
      if (!picked) return;
      const result = await client.run(selectionToArgs(picked.selection, root), root);
      const summary = summarizeModelsResult(result.json);
      if (summary.ok) {
        void vscode.window.showInformationMessage(summary.message);
        scheduler.refreshNow("model profile");
      } else {
        await reportError(summary.message);
      }
      return result.json;
    } catch (error) {
      await reportError(`Unable to select a model profile: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const showActionsCommand = vscode.commands.registerCommand("agento.showActions", async (element?: DeliveryTreeElement | InitiativeTreeElement) => {
    const source = element?.kind === "member"
      ? initiativeMemberActionSource(element, deliveries.current.model) ?? { slug: element.item.slug, actions: [] }
      : deliveryActionSource(element) ?? (sessionDoctor.current.kind === "ready"
        ? { slug: sessionDoctor.current.session.deliverySlug ?? undefined, actions: sessionDoctor.current.actions }
        : null);
    if (!source || source.actions.length === 0) {
      await vscode.window.showInformationMessage(
        source?.slug ? `No Agento actions are available for ${source.slug} in this window.` : "No Agento actions are available in this window.",
      );
      return;
    }
    const action = await pickCommandAction(source);
    if (action) {
      await vscode.commands.executeCommand("agento.dispatchAction", action, source.slug);
    }
  });
  const deliveriesView = vscode.window.createTreeView("agento.deliveries", { treeDataProvider: deliveries });
  const initiativesView = vscode.window.createTreeView("agento.initiatives", { treeDataProvider: initiatives });
  const sessionDoctorView = vscode.window.createTreeView("agento.sessionDoctor", { treeDataProvider: sessionDoctor });
  const windowBannerRegistration = vscode.window.registerWebviewViewProvider("agento.windowBanner", windowBanner);
  let sessionDoctorWasVisible = false;
  const sessionDoctorVisibility = sessionDoctorView.onDidChangeVisibility(({ visible }) => {
    if (visible && !sessionDoctorWasVisible) {
      sessionDoctorWasVisible = true;
      scheduler.refreshNow("session doctor visible");
    }
  });
  const consumePending = () => consumePendingCommands(
    [vscode.workspace.workspaceFile?.fsPath, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)].filter(
      (target): target is string => Boolean(target),
    ),
    {
      pendingStore,
      executeCommand: vscode.commands.executeCommand,
      reportError: (message) => vscode.window.showErrorMessage(message),
      output,
      chatMode,
      commandFile,
    },
  );
  const windowFocusSubscription = vscode.window.onDidChangeWindowState(({ focused }) => {
    if (focused) void consumePending();
  });
  const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuildWatchers());
  const watcherManager = { dispose: () => watcherDisposables.splice(0).forEach((disposable) => disposable.dispose()) };

  context.subscriptions.push(
    output,
    scheduler,
    deliveries,
    initiatives,
    sessionDoctor,
    statusBar,
    refreshSubscription,
    refreshCommand,
    showOutputCommand,
    openRoadmapCommand,
    openBreakdownCommand,
    newPlanCommand,
    newInitiativeCommand,
    planInitiativeMemberCommand,
    dispatchActionCommand,
    selectModelProfileCommand,
    showActionsCommand,
    deliveriesView,
    initiativesView,
    sessionDoctorView,
    windowBannerRegistration,
    sessionDoctorVisibility,
    windowFocusSubscription,
    workspaceSubscription,
    watcherManager,
  );
  await rebuildWatchers();
  await consumePending();
  scheduler.refreshNow("activate");
  return {
    client, scheduler, deliveries, initiatives, sessionDoctor, sessionDoctorView, statusBar, windowBanner, output, dispatchAction,
    startNewPlan, setNewPlanRunner, setNewPlanPrompts,
    startNewInitiative, setNewInitiativeRunner, setNewInitiativePrompts,
    windowGate: () => gate,
  };
}

export function deactivate(): void {}