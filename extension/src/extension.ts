import path from "node:path";
import * as vscode from "vscode";

import { deliveryActionSource, pickCommandAction } from "./actionPicker.js";
import { CliClient } from "./cliClient.js";
import { consumePendingCommands, dispatchCommandAction, type CommandExecutor } from "./commandDispatcher.js";
import type { CommandAction } from "./commandActions.js";
import { createDeliveryTreeError, createDeliveryTreeModel } from "./deliveryTreeModel.js";
import { DeliveryTreeProvider, openRoadmap, type DeliveryTreeElement, type DeliveryTreeSnapshot } from "./deliveryTreeProvider.js";
import { resolveGitDir, type GitDirectories } from "./gitDir.js";
import { createInitiativeTreeError, createInitiativeTreeModel, initiativeSlugs } from "./initiativeTreeModel.js";
import { InitiativeTreeProvider, openBreakdown, type InitiativeTreeSnapshot } from "./initiativeTreeProvider.js";
import { LatestDeliveryRefresh } from "./latestDeliveryRefresh.js";
import { RefreshScheduler } from "./refreshScheduler.js";
import { createSessionDoctorError, createSessionDoctorModel } from "./sessionDoctorModel.js";
import { SessionDoctorProvider } from "./sessionDoctorProvider.js";
import { createWatchers } from "./watchers.js";

export interface ExtensionApi {
  client: CliClient;
  scheduler: RefreshScheduler;
  deliveries: DeliveryTreeProvider;
  initiatives: InitiativeTreeProvider;
  sessionDoctor: SessionDoctorProvider;
  sessionDoctorView: vscode.TreeView<unknown>;
  statusBar: vscode.StatusBarItem;
  output: vscode.OutputChannel;
  dispatchAction: (action: CommandAction, slug?: string, executeCommand?: CommandExecutor) => Promise<unknown>;
}

interface ConfigResult {
  artifactsRoot?: unknown;
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
  const deliveries = new DeliveryTreeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath);
  const initiatives = new InitiativeTreeProvider(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionPath);
  const sessionDoctor = new SessionDoctorProvider();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.name = "Agento Session & Doctor";
  statusBar.text = "Agento: unavailable";
  statusBar.tooltip = "Open Session & Doctor";
  statusBar.command = "agento.sessionDoctor.focus";
  statusBar.show();
  const latestDeliveryRefresh = new LatestDeliveryRefresh();
  const latestInitiativeRefresh = new LatestDeliveryRefresh();
  const roadmapRoots = new Map<string, string>();
  let watcherDisposables: vscode.Disposable[] = [];

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
      deliveries.update({ model: createDeliveryTreeError(message), roadmapRoot: context.extensionPath });
      initiatives.update({ model: createInitiativeTreeError(message), artifactRoot: context.extensionPath });
      const model = createSessionDoctorError(message);
      sessionDoctor.update(model);
      statusBar.text = model.statusBarText;
      output.appendLine(message);
      return;
    }
    void latestDeliveryRefresh.run<{ deliveries: DeliveryTreeSnapshot; sessionDoctor: ReturnType<typeof createSessionDoctorModel> }>(
      async () => {
        const [sessionResult, doctorResult, statusResult] = await Promise.all([
          client.run(["session", "--pr"], folder.uri.fsPath),
          client.run(["doctor"], folder.uri.fsPath),
          client.run(["status", "--pr"], folder.uri.fsPath),
        ]);
        return {
          deliveries: {
            model: createDeliveryTreeModel(statusResult.json),
            roadmapRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
          },
          sessionDoctor: createSessionDoctorModel(sessionResult.json, doctorResult.json, statusResult.json),
        };
      },
      (snapshot) => {
        deliveries.update(snapshot.deliveries);
        sessionDoctor.update(snapshot.sessionDoctor);
        statusBar.text = snapshot.sessionDoctor.statusBarText;
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
      },
      (error) => {
        deliveries.update({
          model: createDeliveryTreeError(error),
          roadmapRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
        });
        const model = createSessionDoctorError(error);
        sessionDoctor.update(model);
        statusBar.text = model.statusBarText;
        output.appendLine(String(error));
      },
    );
    void latestInitiativeRefresh.run<InitiativeTreeSnapshot>(
      async () => {
        const listResult = await client.run(["initiative"], folder.uri.fsPath);
        const details = await Promise.all(initiativeSlugs(listResult.json).map(async (slug) => {
          try {
            const detailResult = await client.run(["initiative", slug], folder.uri.fsPath);
            return [slug, detailResult.json] as const;
          } catch (error) {
            return [slug, error instanceof Error ? error : new Error(String(error))] as const;
          }
        }));
        return {
          model: createInitiativeTreeModel(listResult.json, new Map(details)),
          artifactRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
        };
      },
      (snapshot) => {
        initiatives.update(snapshot);
        if (snapshot.model.kind === "error") {
          output.appendLine(snapshot.model.message);
        } else if (snapshot.model.kind === "ready") {
          for (const item of snapshot.model.items) {
            for (const diagnostic of item.diagnostics) {
              output.appendLine(`initiative ${item.slug}: ${diagnostic.message}`);
            }
          }
        }
      },
      (error) => {
        initiatives.update({
          model: createInitiativeTreeError(error),
          artifactRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
        });
        output.appendLine(String(error));
      },
    );
  });

  const refreshCommand = vscode.commands.registerCommand("agento.refresh", () => scheduler.refreshNow("command"));
  const showOutputCommand = vscode.commands.registerCommand("agento.showOutput", () => output.show());
  const openRoadmapCommand = vscode.commands.registerCommand("agento.openRoadmap", openRoadmap);
  const openBreakdownCommand = vscode.commands.registerCommand("agento.openBreakdown", openBreakdown);
  const openTarget = (target: { kind: "folder" | "workspace"; path: string }) => vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.file(target.path),
    { forceNewWindow: true },
  );
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
      pendingStore: context.globalState,
      openTarget,
    },
    executeCommand,
  );
  const dispatchActionCommand = vscode.commands.registerCommand("agento.dispatchAction", dispatchAction);
  const showActionsCommand = vscode.commands.registerCommand("agento.showActions", async (element?: DeliveryTreeElement) => {
    const source = deliveryActionSource(element) ?? (sessionDoctor.current.kind === "ready" ? { actions: sessionDoctor.current.actions } : null);
    if (!source || source.actions.length === 0) {
      await vscode.window.showInformationMessage("No Agento actions are available in this window.");
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
      pendingStore: context.globalState,
      executeCommand: vscode.commands.executeCommand,
      reportError: (message) => vscode.window.showErrorMessage(message),
      output,
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
    dispatchActionCommand,
    showActionsCommand,
    deliveriesView,
    initiativesView,
    sessionDoctorView,
    sessionDoctorVisibility,
    windowFocusSubscription,
    workspaceSubscription,
    watcherManager,
  );
  await rebuildWatchers();
  await consumePending();
  scheduler.refreshNow("activate");
  return { client, scheduler, deliveries, initiatives, sessionDoctor, sessionDoctorView, statusBar, output, dispatchAction };
}

export function deactivate(): void {}