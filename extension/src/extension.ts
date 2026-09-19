import path from "node:path";
import * as vscode from "vscode";

import { CliClient } from "./cliClient.js";
import { createDeliveryTreeError, createDeliveryTreeModel } from "./deliveryTreeModel.js";
import { DeliveryTreeProvider, openRoadmap, type DeliveryTreeSnapshot } from "./deliveryTreeProvider.js";
import { resolveGitDir, type GitDirectories } from "./gitDir.js";
import { LatestDeliveryRefresh } from "./latestDeliveryRefresh.js";
import { RefreshScheduler } from "./refreshScheduler.js";
import { createWatchers } from "./watchers.js";

export interface ExtensionApi {
  client: CliClient;
  scheduler: RefreshScheduler;
  deliveries: DeliveryTreeProvider;
  output: vscode.OutputChannel;
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
  const latestDeliveryRefresh = new LatestDeliveryRefresh();
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
      output.appendLine(message);
      return;
    }
    void latestDeliveryRefresh.run<DeliveryTreeSnapshot>(
      async () => {
        const result = await client.run(["status", "--pr"], folder.uri.fsPath);
        return {
          model: createDeliveryTreeModel(result.json),
          roadmapRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
        };
      },
      (snapshot) => {
        deliveries.update(snapshot);
        for (const warning of snapshot.model.warnings) {
          output.appendLine(warning);
        }
        if (snapshot.model.kind === "error") {
          output.appendLine(snapshot.model.message);
        }
      },
      (error) => {
        deliveries.update({
          model: createDeliveryTreeError(error),
          roadmapRoot: roadmapRoots.get(folder.uri.fsPath) ?? folder.uri.fsPath,
        });
        output.appendLine(String(error));
      },
    );
  });

  const refreshCommand = vscode.commands.registerCommand("agento.refresh", () => scheduler.refreshNow("command"));
  const showOutputCommand = vscode.commands.registerCommand("agento.showOutput", () => output.show());
  const openRoadmapCommand = vscode.commands.registerCommand("agento.openRoadmap", openRoadmap);
  const deliveriesView = vscode.window.registerTreeDataProvider("agento.deliveries", deliveries);
  const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuildWatchers());
  const watcherManager = { dispose: () => watcherDisposables.splice(0).forEach((disposable) => disposable.dispose()) };

  context.subscriptions.push(
    output,
    scheduler,
    deliveries,
    refreshSubscription,
    refreshCommand,
    showOutputCommand,
    openRoadmapCommand,
    deliveriesView,
    workspaceSubscription,
    watcherManager,
  );
  await rebuildWatchers();
  scheduler.refreshNow("activate");
  return { client, scheduler, deliveries, output };
}

export function deactivate(): void {}