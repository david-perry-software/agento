import type * as vscode from "vscode";

import type { CommandAction } from "./commandActions.js";
import { routeCommandAction, type CurrentWindow, type DispatchRoute } from "./dispatchRouting.js";
import {
  pendingDispatchKey,
  savePendingDispatch,
  takePendingDispatch,
  type PendingDispatchStore,
} from "./pendingDispatch.js";

export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

export interface CommandDispatcherDependencies {
  currentWindow: () => CurrentWindow;
  loadNext: (slug: string) => Promise<unknown>;
  executeCommand: CommandExecutor;
  reportError: (message: string) => Thenable<unknown>;
  reportInfo: (message: string, action: string) => Thenable<string | undefined>;
  output: Pick<vscode.OutputChannel, "appendLine">;
  pendingStore: PendingDispatchStore;
  openTarget: (target: Extract<DispatchRoute, { kind: "open" }>["target"]) => Thenable<unknown>;
}

export async function dispatchCommandAction(
  action: CommandAction,
  slug: string | undefined,
  dependencies: CommandDispatcherDependencies,
  executeCommand = dependencies.executeCommand,
): Promise<DispatchRoute> {
  try {
    const next = slug ? await dependencies.loadNext(slug) : undefined;
    const route = routeCommandAction(action, { currentWindow: dependencies.currentWindow(), slug, next });
    if (route.kind === "reject") {
      await dependencies.reportError(route.reason);
      return route;
    }
    if (route.kind === "open") {
      await savePendingDispatch(dependencies.pendingStore, {
        target: route.target.path,
        command: route.command,
        createdAt: Date.now(),
      });
      try {
        await dependencies.openTarget(route.target);
      } catch (error) {
        await dependencies.pendingStore.update(pendingDispatchKey(route.target.path), undefined);
        throw error;
      }
      const selection = await dependencies.reportInfo(route.reason, "Focus target");
      if (selection === "Focus target") {
        await dependencies.openTarget(route.target);
      }
      return route;
    }

    await executeCommand("workbench.action.chat.open", { query: route.command, mode: "agent" });
    return route;
  } catch (error) {
    const message = `Unable to dispatch Agento command: ${error instanceof Error ? error.message : String(error)}`;
    dependencies.output.appendLine(message);
    await dependencies.reportError(message);
    return { kind: "reject", reason: message };
  }
}

export async function consumePendingCommands(
  targets: string[],
  dependencies: Pick<CommandDispatcherDependencies, "pendingStore" | "executeCommand" | "reportError" | "output">,
): Promise<void> {
  const results = await Promise.all([...new Set(targets)].map(async (target) => ({
    target,
    result: await takePendingDispatch(dependencies.pendingStore, target),
  })));
  const ready = results.filter((entry) => entry.result.kind === "ready");
  for (const entry of results) {
    if (entry.result.kind === "discarded") {
      const message = `Discarded pending Agento command for ${entry.target}: ${entry.result.reason}.`;
      dependencies.output.appendLine(message);
      await dependencies.reportError(message);
    }
  }
  if (ready.length === 0) return;
  if (ready.length > 1) {
    const message = "Discarded duplicate pending Agento commands for this window.";
    dependencies.output.appendLine(message);
    await dependencies.reportError(message);
  }
  const result = ready[0]!.result;
  if (result.kind === "ready") {
    try {
      await dependencies.executeCommand("workbench.action.chat.open", { query: result.command, mode: "agent" });
    } catch (error) {
      const message = `Unable to submit pending Agento command: ${error instanceof Error ? error.message : String(error)}`;
      dependencies.output.appendLine(message);
      await dependencies.reportError(message);
    }
  }
}