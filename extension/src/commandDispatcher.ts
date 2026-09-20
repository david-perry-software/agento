import type * as vscode from "vscode";

import type { CommandAction } from "./commandActions.js";
import { routeCommandAction, type CurrentWindow, type DispatchRoute } from "./dispatchRouting.js";

export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

export interface CommandDispatcherDependencies {
  currentWindow: () => CurrentWindow;
  loadNext: (slug: string) => Promise<unknown>;
  executeCommand: CommandExecutor;
  reportError: (message: string) => Thenable<unknown>;
  output: Pick<vscode.OutputChannel, "appendLine">;
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
      const reason = "Cross-window dispatch is not available yet.";
      await dependencies.reportError(reason);
      return { kind: "reject", reason };
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