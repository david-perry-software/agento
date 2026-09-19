import * as vscode from "vscode";

import type { GitDirectories } from "./gitDir.js";

export interface WatcherOptions {
  roots: vscode.Uri[];
  gitDirs: GitDirectories[];
  onEvent(reason: string): void;
  output?: Pick<vscode.OutputChannel, "appendLine">;
}

export function createWatchers(options: WatcherOptions): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const patterns = new Map<string, vscode.GlobPattern>();
  let hasWorkspaceRoot = false;

  for (const root of options.roots) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(root);
    if (workspaceFolder?.uri.fsPath === root.fsPath) {
      hasWorkspaceRoot = true;
      continue;
    }
    patterns.set(`${root.fsPath}:roadmap`, new vscode.RelativePattern(root, "**/roadmap.md"));
    patterns.set(`${root.fsPath}:review`, new vscode.RelativePattern(root, "**/review.md"));
  }
  if (hasWorkspaceRoot) {
    patterns.set("workspace:roadmap", "**/roadmap.md");
    patterns.set("workspace:review", "**/review.md");
  }
  for (const directories of options.gitDirs) {
    patterns.set(`${directories.gitDir}:HEAD`, new vscode.RelativePattern(directories.gitDir, "HEAD"));
    patterns.set(`${directories.commonDir}:refs`, new vscode.RelativePattern(directories.commonDir, "refs/**"));
  }

  for (const pattern of patterns.values()) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => options.onEvent(`create ${uri.fsPath}`));
      watcher.onDidChange((uri) => options.onEvent(`change ${uri.fsPath}`));
      watcher.onDidDelete((uri) => options.onEvent(`delete ${uri.fsPath}`));
      disposables.push(watcher);
    } catch (error) {
      const description = typeof pattern === "string" ? pattern : pattern.pattern;
      options.output?.appendLine(`watcher: ${description} failed: ${String(error)}`);
    }
  }

  return disposables;
}