import path from "node:path";
import * as vscode from "vscode";

import { CliClient } from "./cliClient.js";
import { resolveGitDir, type GitDirectories } from "./gitDir.js";
import { RefreshScheduler } from "./refreshScheduler.js";
import { createWatchers } from "./watchers.js";

export interface ExtensionApi {
  client: CliClient;
  scheduler: RefreshScheduler;
  output: vscode.OutputChannel;
}

interface ConfigResult {
  artifactsRoot?: unknown;
}

interface SessionResult {
  role?: unknown;
  lifecycle?: unknown;
  delivery?: { slug?: unknown } | null;
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
  let watcherDisposables: vscode.Disposable[] = [];

  const rebuildWatchers = async (): Promise<void> => {
    for (const disposable of watcherDisposables) {
      disposable.dispose();
    }
    watcherDisposables = [];

    const roots = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.set(folder.uri.fsPath, folder.uri);
      try {
        const result = await client.run(["config"], folder.uri.fsPath);
        const artifactsRoot = (result.json as ConfigResult).artifactsRoot;
        if (typeof artifactsRoot === "string") {
          roots.set(artifactsRoot, vscode.Uri.file(artifactsRoot));
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
      output.appendLine("session: no workspace folder");
      return;
    }
    void client.run(["session"], folder.uri.fsPath).then(
      (result) => {
        const session = result.json as SessionResult;
        const delivery = session.delivery && typeof session.delivery.slug === "string" ? session.delivery.slug : "none";
        output.appendLine(`session: role=${String(session.role)} lifecycle=${String(session.lifecycle)} delivery=${delivery}`);
      },
      (error) => output.appendLine(`session: ${String(error)}`),
    );
  });

  const refreshCommand = vscode.commands.registerCommand("agento.refresh", () => scheduler.refreshNow("command"));
  const showOutputCommand = vscode.commands.registerCommand("agento.showOutput", () => output.show());
  const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuildWatchers());
  const watcherManager = { dispose: () => watcherDisposables.splice(0).forEach((disposable) => disposable.dispose()) };

  context.subscriptions.push(
    output,
    scheduler,
    refreshSubscription,
    refreshCommand,
    showOutputCommand,
    workspaceSubscription,
    watcherManager,
  );
  await rebuildWatchers();
  scheduler.refreshNow("activate");
  return { client, scheduler, output };
}

export function deactivate(): void {}