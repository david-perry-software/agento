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
import {
  createProfileArgs,
  deleteProfileArgs,
  initProfilesArgs,
  missingPluginRootMessage,
  needsPrimaryConfirm,
  renameProfileArgs,
  resolvePluginRoot,
  selectionToArgs,
  summarizeModelsResult,
  toQuickPickItems,
  type ModelsSelection,
  type ModelsSummary,
} from "./modelProfiles.js";
import { ModelProfilesProvider } from "./modelProfilesProvider.js";
import { ProfileEditorPanels, type ModelSource } from "./profileEditorPanel.js";
import {
  createModelProfilesModel,
  suggestCopyName,
  validateProfileName,
  windowProfileRole,
  type ModelProfileEntry,
  type ModelProfilesElement,
  type ModelProfilesModelInput,
  type ProfileRole,
} from "./modelProfilesTree.js";
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
  modelProfiles: ModelProfilesProvider;
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
  setModelProfilePrompts: (prompts?: ModelProfilePrompts) => void;
  profileEditor: ProfileEditorPanels;
  setProfileEditorModelSource: (source: ModelSource) => void;
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

export interface ModelProfileNamePrompt {
  title: string;
  prompt: string;
  placeHolder: string;
  value?: string;
  validate?: (value: string) => string | undefined;
}

export type ModelProfileNewKind = { kind: "empty" } | { kind: "copy"; from: string };

export interface ModelProfilePrompts {
  enterName: (options: ModelProfileNamePrompt) => Promise<string | undefined>;
  chooseNewKind: (existing: string[]) => Promise<ModelProfileNewKind | undefined>;
  confirmDelete: (profile: { name: string; applied: boolean; assignedSecondary: boolean }) => Promise<boolean>;
  confirmPrimaryChange: () => Promise<boolean>;
  pickProfile: (listJson: unknown, placeHolder: string, role?: ProfileRole) => Promise<ModelsSelection | undefined>;
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
  const modelProfiles = new ModelProfilesProvider();
  const pendingStore = new FilePendingDispatchStore(path.join(context.globalStorageUri.fsPath, "pending-dispatch"));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "Agento Session & Doctor";
  statusBar.text = "Agento: unavailable";
  statusBar.tooltip = "Open Session & Doctor";
  statusBar.command = "agento.sessionDoctor.focus";
  statusBar.show();
  const windowBanner = new WindowBannerProvider(createWindowBannerModel(sessionDoctor.current));
  const latestDeliveryRefresh = new LatestDeliveryRefresh();
  const latestModelProfilesRefresh = new LatestDeliveryRefresh();
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
  // The window's role bucket, derived from the live Session & Doctor model (no
  // session yet counts as primary).
  const currentWindowRole = (): ProfileRole =>
    sessionDoctor.current.kind === "ready" ? windowProfileRole(sessionDoctor.current.session.role) : "primary";
  // Rebuilt whenever the plugin root or the profiles-file path changes; assigned
  // after `scheduleModelProfilesReload` below.
  let rebuildModelProfileWatchers = (): void => {};
  // The last `models list` input, kept so a session update can rebuild the model
  // with the new window role without an extra CLI call.
  let lastModelProfilesInput: ModelProfilesModelInput | null = null;
  const applyModelProfilesModel = (input: ModelProfilesModelInput): void => {
    modelProfiles.update(createModelProfilesModel(input));
    rebuildModelProfileWatchers();
    void profileEditor.notifyProfilesChanged();
  };
  const reloadModelProfiles = async (): Promise<void> => {
    const root = pluginRoot();
    await latestModelProfilesRefresh.run(
      async (): Promise<ModelProfilesModelInput> => {
        if (root === null) return { pluginRoot: null, windowRole: currentWindowRole() };
        const result = await client.run(["models", "list", "--plugin-root", root], root);
        const listError =
          result.code !== 0 && typeof (result.json as { message?: unknown } | null)?.message === "string"
            ? ((result.json as { message: string }).message)
            : null;
        return { pluginRoot: root, listResult: result.json, listError, windowRole: currentWindowRole() };
      },
      (input) => {
        lastModelProfilesInput = input;
        applyModelProfilesModel(input);
      },
      (error) => {
        const input: ModelProfilesModelInput = { pluginRoot: root, listError: String(error), windowRole: currentWindowRole() };
        lastModelProfilesInput = input;
        applyModelProfilesModel(input);
        output.appendLine(`model profiles: ${String(error)}`);
      },
    );
  };
  const rebuildModelProfilesForWindowRole = (): void => {
    if (!lastModelProfilesInput) return;
    applyModelProfilesModel({ ...lastModelProfilesInput, windowRole: currentWindowRole() });
  };
  let modelProfileDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleModelProfilesReload = (reason: string): void => {
    output.appendLine(`model profiles: ${reason}`);
    if (modelProfileDebounceTimer !== undefined) clearTimeout(modelProfileDebounceTimer);
    modelProfileDebounceTimer = setTimeout(() => {
      modelProfileDebounceTimer = undefined;
      void reloadModelProfiles();
    }, 500);
  };
  let modelProfileWatcherDisposables: vscode.Disposable[] = [];
  let modelProfileWatcherKey: string | null = null;
  rebuildModelProfileWatchers = (): void => {
    const root = pluginRoot();
    const profilesFilePath = modelProfiles.current.profilesFile?.path ?? null;
    const key = `${root ?? ""}\u0000${profilesFilePath ?? ""}`;
    if (key === modelProfileWatcherKey) return;
    modelProfileWatcherKey = key;
    for (const disposable of modelProfileWatcherDisposables) disposable.dispose();
    modelProfileWatcherDisposables = [];
    if (root) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(root), ".github/agents/*.agent.md"),
        );
        watcher.onDidCreate((uri) => scheduleModelProfilesReload(`agent created ${uri.fsPath}`));
        watcher.onDidChange((uri) => scheduleModelProfilesReload(`agent changed ${uri.fsPath}`));
        watcher.onDidDelete((uri) => scheduleModelProfilesReload(`agent deleted ${uri.fsPath}`));
        modelProfileWatcherDisposables.push(watcher);
      } catch (error) {
        output.appendLine(`model profiles watcher (agents): ${String(error)}`);
      }
    }
    if (profilesFilePath) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(profilesFilePath)), "model-profiles.json"),
        );
        watcher.onDidCreate((uri) => scheduleModelProfilesReload(`profiles file created ${uri.fsPath}`));
        watcher.onDidChange((uri) => scheduleModelProfilesReload(`profiles file changed ${uri.fsPath}`));
        watcher.onDidDelete((uri) => scheduleModelProfilesReload(`profiles file deleted ${uri.fsPath}`));
        modelProfileWatcherDisposables.push(watcher);
      } catch (error) {
        output.appendLine(`model profiles watcher (profiles file): ${String(error)}`);
      }
    }
  };
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
    void reloadModelProfiles();
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
        rebuildModelProfilesForWindowRole();
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
        rebuildModelProfilesForWindowRole();
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
  const reportModelsError = async (summary: ModelsSummary): Promise<void> => {
    output.appendLine(`models: ${summary.message}`);
    if (summary.dirty.length) {
      const choice = await vscode.window.showErrorMessage(summary.message, "Open Output", "Show in Source Control");
      if (choice === "Open Output") output.show();
      if (choice === "Show in Source Control") void vscode.commands.executeCommand("workbench.view.scm");
      return;
    }
    await vscode.window.showErrorMessage(summary.message);
  };
  const resolveModelsRoot = (): string | null => {
    const root = pluginRoot();
    if (root) return root;
    const message = missingPluginRootMessage(vscode.workspace.getConfiguration("agento").get<string>("pluginRoot", ""), os.homedir());
    output.appendLine(`models: ${message}`);
    void vscode.window.showErrorMessage(message);
    return null;
  };
  const handleModelsSummary = async (summary: ModelsSummary): Promise<void> => {
    if (summary.ok) {
      void vscode.window.showInformationMessage(summary.message);
      void reloadModelProfiles();
      scheduler.refreshNow("model profile");
    } else if (summary.conflict) {
      output.appendLine(`models: ${summary.message}`);
      void vscode.window.showWarningMessage("The profiles file changed since the view loaded — refreshed; try again.");
      void reloadModelProfiles();
    } else {
      await reportModelsError(summary);
    }
  };
  const runModelsAction = async (args: string[], root: string): Promise<unknown> => {
    const result = await client.run(args, root);
    await handleModelsSummary(summarizeModelsResult(result.json));
    return result.json;
  };
  const runModelsSelection = async (selection: ModelsSelection): Promise<unknown> => {
    const root = resolveModelsRoot();
    if (!root) return undefined;
    return runModelsAction(selectionToArgs(selection, root, { rolesHash: modelProfilesRolesHash() }), root);
  };
  const runRoleSelection = async (role: ProfileRole, profile: string | null): Promise<unknown> => {
    if (needsPrimaryConfirm(role, currentWindowRole())) {
      const proceed = await modelProfilePrompts.confirmPrimaryChange();
      if (!proceed) return undefined;
    }
    return runModelsSelection(profile === null ? { kind: "off", role } : { kind: "use", role, profile });
  };
  const modelProfilesHash = (): string | null => modelProfiles.current.profilesFile?.hash ?? null;
  const modelProfilesRolesHash = (): string | null => modelProfiles.current.roles?.rolesFile?.hash ?? null;
  const modelProfileNames = (): string[] => modelProfiles.current.profiles.map((profile) => profile.name);
  const profileOf = (element?: ModelProfilesElement): ModelProfileEntry | undefined =>
    element?.kind === "profile" ? element.profile : undefined;
  const openProfilesFile = async (profileKey?: string): Promise<void> => {
    const file = modelProfiles.current.profilesFile?.path;
    if (!file) {
      await vscode.window.showInformationMessage("The model profiles file does not exist yet; create a profile first.");
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (profileKey === undefined) {
      await vscode.window.showTextDocument(document);
      return;
    }
    const key = `"${profileKey}"`;
    const index = document.getText().indexOf(key);
    if (index < 0) {
      await vscode.window.showTextDocument(document);
      return;
    }
    const start = document.positionAt(index);
    const end = document.positionAt(index + key.length);
    await vscode.window.showTextDocument(document, { selection: new vscode.Selection(start, end) });
  };

  const profileEditor = new ProfileEditorPanels(context.extensionUri, client, output, {
    pluginRoot,
    reload: async () => {
      await reloadModelProfiles();
    },
    apply: (profile) => runModelsSelection({ kind: "use", role: currentWindowRole(), profile }),
    openFile: async () => {
      await openProfilesFile();
    },
  });

  const defaultModelProfilePrompts: ModelProfilePrompts = {
    enterName: async (options) => vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      placeHolder: options.placeHolder,
      value: options.value,
      validateInput: options.validate,
    }),
    chooseNewKind: async (existing) => {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Empty profile", description: "No pins; resolves nothing", newKind: "empty" as const },
          ...existing.map((name) => ({ label: `Copy from ${name}`, description: "Duplicate the profile's pins", newKind: "copy" as const, from: name })),
        ],
        { title: "New Model Profile", placeHolder: "Start empty or copy an existing profile" },
      );
      if (!picked) return undefined;
      return picked.newKind === "empty" ? { kind: "empty" } : { kind: "copy", from: picked.from };
    },
    confirmDelete: async (profile) => {
      const roles = [profile.applied ? "primary" : null, profile.assignedSecondary ? "secondary" : null].filter((role): role is string => role !== null);
      const message = roles.length
        ? `Delete model profile ${profile.name}? It is used by ${roles.join(" and ")} windows, which will fall back to their pins.`
        : `Delete model profile ${profile.name}?`;
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Delete");
      return choice === "Delete";
    },
    confirmPrimaryChange: async () => {
      const choice = await vscode.window.showWarningMessage(
        "This changes the clone's file pins, used by every primary window and by directly selected agents.",
        { modal: true },
        "Change Primary Profile",
      );
      return choice === "Change Primary Profile";
    },
    pickProfile: async (listJson, placeHolder, role) => {
      const picked = await vscode.window.showQuickPick(toQuickPickItems(listJson, role ?? currentWindowRole()), {
        title: "Agento: Select Model Profile",
        placeHolder,
      });
      return picked?.selection;
    },
  };
  let modelProfilePrompts = defaultModelProfilePrompts;
  const setModelProfilePrompts = (prompts?: ModelProfilePrompts): void => {
    modelProfilePrompts = prompts ?? defaultModelProfilePrompts;
  };

  const selectModelProfileCommand = vscode.commands.registerCommand("agento.selectModelProfile", async () => {
    const root = resolveModelsRoot();
    if (!root) return;
    try {
      const list = await client.run(["models", "list", "--plugin-root", root], root);
      if (list.code !== 0) {
        await reportModelsError(summarizeModelsResult(list.json));
        return;
      }
      const profilesFile = (list.json as { profilesFile?: { path?: unknown } }).profilesFile?.path;
      const selection = await modelProfilePrompts.pickProfile(
        list.json,
        `${currentWindowRole() === "primary" ? "Primary windows" : "Secondary windows"} — profiles from ${typeof profilesFile === "string" ? profilesFile : "model-profiles.json"}`,
      );
      if (!selection) return;
      return runModelsSelection(selection);
    } catch (error) {
      const message = `Unable to select a model profile: ${error instanceof Error ? error.message : String(error)}`;
      output.appendLine(`models: ${message}`);
      await vscode.window.showErrorMessage(message);
    }
  });
  const modelProfilesApplyCommand = vscode.commands.registerCommand("agento.modelProfiles.apply", async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    return runModelsSelection({ kind: "use", role: currentWindowRole(), profile: profile.name });
  });
  const modelProfilesClearCommand = vscode.commands.registerCommand("agento.modelProfiles.clear", () => runModelsSelection({ kind: "off", role: currentWindowRole() }));
  const useRoleCommand = (role: ProfileRole) => vscode.commands.registerCommand(`agento.modelProfiles.${role === "primary" ? "usePrimary" : "useSecondary"}`, async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    return runRoleSelection(role, profile.name);
  });
  const offRoleCommand = (role: ProfileRole) => vscode.commands.registerCommand(`agento.modelProfiles.${role === "primary" ? "offPrimary" : "offSecondary"}`, () => runRoleSelection(role, null));
  const modelProfilesUsePrimaryCommand = useRoleCommand("primary");
  const modelProfilesUseSecondaryCommand = useRoleCommand("secondary");
  const modelProfilesOffPrimaryCommand = offRoleCommand("primary");
  const modelProfilesOffSecondaryCommand = offRoleCommand("secondary");
  const modelProfilesPickForRoleCommand = vscode.commands.registerCommand("agento.modelProfiles.pickForRole", async (role?: unknown) => {
    const targetRole: ProfileRole = role === "secondary" ? "secondary" : "primary";
    const root = resolveModelsRoot();
    if (!root) return;
    try {
      const list = await client.run(["models", "list", "--plugin-root", root], root);
      if (list.code !== 0) {
        await reportModelsError(summarizeModelsResult(list.json));
        return;
      }
      const selection = await modelProfilePrompts.pickProfile(
        list.json,
        targetRole === "primary" ? "Use in primary windows" : "Use in secondary windows",
        targetRole,
      );
      if (!selection) return;
      return runRoleSelection(selection.role, selection.kind === "use" ? selection.profile : null);
    } catch (error) {
      const message = `Unable to pick a model profile: ${error instanceof Error ? error.message : String(error)}`;
      output.appendLine(`models: ${message}`);
      await vscode.window.showErrorMessage(message);
    }
  });
  const modelProfilesNewCommand = vscode.commands.registerCommand("agento.modelProfiles.new", async () => {
    const root = resolveModelsRoot();
    if (!root) return;
    const existing = modelProfileNames();
    const name = await modelProfilePrompts.enterName({
      title: "New Model Profile",
      prompt: "Name the new profile (lowercase letters, digits, and hyphens).",
      placeHolder: "copilot-daily",
      validate: (value) => validateProfileName(value, existing) ?? undefined,
    });
    if (!name) return;
    const kind = await modelProfilePrompts.chooseNewKind(existing);
    if (!kind) return;
    await runModelsAction(
      createProfileArgs(name, root, { ...(kind.kind === "copy" ? { from: kind.from } : {}), hash: modelProfilesHash() }),
      root,
    );
    await profileEditor.open(name);
  });
  const modelProfilesDuplicateCommand = vscode.commands.registerCommand("agento.modelProfiles.duplicate", async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    const root = resolveModelsRoot();
    if (!root) return;
    const existing = modelProfileNames();
    const suggested = suggestCopyName(profile.name, existing);
    const name = await modelProfilePrompts.enterName({
      title: "Duplicate Model Profile",
      prompt: "Name the copy.",
      placeHolder: suggested,
      value: suggested,
      validate: (value) => validateProfileName(value, existing) ?? undefined,
    });
    if (!name) return;
    await runModelsAction(createProfileArgs(name, root, { from: profile.name, hash: modelProfilesHash() }), root);
    await profileEditor.open(name);
  });
  const modelProfilesRenameCommand = vscode.commands.registerCommand("agento.modelProfiles.rename", async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    const root = resolveModelsRoot();
    if (!root) return;
    const existing = modelProfileNames().filter((name) => name !== profile.name);
    const name = await modelProfilePrompts.enterName({
      title: "Rename Model Profile",
      prompt: "Rename the profile.",
      placeHolder: profile.name,
      value: profile.name,
      validate: (value) => validateProfileName(value, existing) ?? undefined,
    });
    if (!name || name === profile.name) return;
    return runModelsAction(renameProfileArgs(profile.name, name, root, { hash: modelProfilesHash() }), root);
  });
  const modelProfilesDeleteCommand = vscode.commands.registerCommand("agento.modelProfiles.delete", async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    const root = resolveModelsRoot();
    if (!root) return;
    const applied = modelProfiles.current.active === profile.name;
    const assignedSecondary =
      modelProfiles.current.roles?.secondary === profile.name && modelProfiles.current.roles.secondaryState === "on";
    const confirmed = await modelProfilePrompts.confirmDelete({ name: profile.name, applied, assignedSecondary });
    if (!confirmed) return;
    return runModelsAction(deleteProfileArgs(profile.name, root, { force: applied || assignedSecondary, hash: modelProfilesHash() }), root);
  });
  const modelProfilesEditCommand = vscode.commands.registerCommand("agento.modelProfiles.edit", async (element?: ModelProfilesElement) => {
    const profile = profileOf(element);
    if (!profile) {
      await vscode.window.showErrorMessage("No model profile selected.");
      return;
    }
    if (!resolveModelsRoot()) return;
    await profileEditor.open(profile.name);
  });
  const editModelProfileCommand = vscode.commands.registerCommand("agento.editModelProfile", async () => {
    const root = resolveModelsRoot();
    if (!root) return;
    if (modelProfiles.current.state === "no-file") {
      const choice = await vscode.window.showInformationMessage("The model profiles file does not exist yet.", "Create Profiles File");
      if (choice === "Create Profiles File") return runModelsAction(initProfilesArgs(root), root);
      return;
    }
    const profiles = modelProfiles.current.profiles;
    if (profiles.length === 0) {
      await vscode.window.showInformationMessage("There are no model profiles to edit; create one first.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({ label: profile.name, description: profile.description ?? undefined })),
      { title: "Agento: Edit Model Profile", placeHolder: "Pick a profile to edit" },
    );
    if (!picked) return;
    await profileEditor.open(picked.label);
  });
  const modelProfilesOpenFileCommand = vscode.commands.registerCommand("agento.modelProfiles.openFile", async () => {
    if (!resolveModelsRoot()) return;
    await openProfilesFile();
  });
  const modelProfilesInitCommand = vscode.commands.registerCommand("agento.modelProfiles.init", async () => {
    const root = resolveModelsRoot();
    if (!root) return;
    return runModelsAction(initProfilesArgs(root), root);
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
  const modelProfilesView = vscode.window.createTreeView("agento.modelProfiles", { treeDataProvider: modelProfiles });
  const windowBannerRegistration = vscode.window.registerWebviewViewProvider("agento.windowBanner", windowBanner);
  let sessionDoctorWasVisible = false;
  const sessionDoctorVisibility = sessionDoctorView.onDidChangeVisibility(({ visible }) => {
    if (visible && !sessionDoctorWasVisible) {
      sessionDoctorWasVisible = true;
      scheduler.refreshNow("session doctor visible");
    }
  });
  const modelProfilesVisibility = modelProfilesView.onDidChangeVisibility(({ visible }) => {
    if (visible) scheduleModelProfilesReload("view visible");
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
    if (focused) {
      void consumePending();
      scheduleModelProfilesReload("window focus");
    }
  });
  const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuildWatchers());
  const modelProfileConfigSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("agento.pluginRoot") || event.affectsConfiguration("chat.pluginLocations")) {
      rebuildModelProfileWatchers();
      scheduleModelProfilesReload("plugin root changed");
    }
  });
  const watcherManager = { dispose: () => watcherDisposables.splice(0).forEach((disposable) => disposable.dispose()) };
  const modelProfileWatcherManager = {
    dispose: () => {
      if (modelProfileDebounceTimer !== undefined) {
        clearTimeout(modelProfileDebounceTimer);
        modelProfileDebounceTimer = undefined;
      }
      for (const disposable of modelProfileWatcherDisposables.splice(0)) disposable.dispose();
    },
  };

  context.subscriptions.push(
    output,
    scheduler,
    deliveries,
    initiatives,
    sessionDoctor,
    modelProfiles,
    profileEditor,
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
    modelProfilesApplyCommand,
    modelProfilesClearCommand,
    modelProfilesUsePrimaryCommand,
    modelProfilesUseSecondaryCommand,
    modelProfilesOffPrimaryCommand,
    modelProfilesOffSecondaryCommand,
    modelProfilesPickForRoleCommand,
    modelProfilesNewCommand,
    modelProfilesDuplicateCommand,
    modelProfilesRenameCommand,
    modelProfilesDeleteCommand,
    modelProfilesEditCommand,
    editModelProfileCommand,
    modelProfilesOpenFileCommand,
    modelProfilesInitCommand,
    showActionsCommand,
    deliveriesView,
    initiativesView,
    sessionDoctorView,
    modelProfilesView,
    windowBannerRegistration,
    sessionDoctorVisibility,
    modelProfilesVisibility,
    windowFocusSubscription,
    workspaceSubscription,
    modelProfileConfigSubscription,
    watcherManager,
    modelProfileWatcherManager,
  );
  await rebuildWatchers();
  await consumePending();
  scheduler.refreshNow("activate");
  return {
    client, scheduler, deliveries, initiatives, sessionDoctor, modelProfiles, profileEditor, sessionDoctorView, statusBar, windowBanner, output, dispatchAction,
    startNewPlan, setNewPlanRunner, setNewPlanPrompts,
    startNewInitiative, setNewInitiativeRunner, setNewInitiativePrompts,
    setModelProfilePrompts,
    setProfileEditorModelSource: (source) => profileEditor.setModelSource(source),
    windowGate: () => gate,
  };
}

export function deactivate(): void {}