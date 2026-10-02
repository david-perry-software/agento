import type * as vscode from "vscode";

import { commandName } from "./commandAgent.js";
import type { CommandAction } from "./commandActions.js";
import { routeCommandAction, type CurrentWindow, type DispatchRoute } from "./dispatchRouting.js";
import {
  pendingDispatchKey,
  savePendingDispatch,
  takePendingDispatch,
  type PendingDispatchStore,
} from "./pendingDispatch.js";

export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

export type ChatModeResolution = { mode: string } | { mode: null; reason: string };

export type ChatModeResolver = (command: string) => ChatModeResolution;

export type CommandFileResolver = (command: string) => { file: unknown } | { file: null; reason: string };

export interface CommandDispatcherDependencies {
  currentWindow: () => CurrentWindow;
  loadNext: (slug: string) => Promise<unknown>;
  executeCommand: CommandExecutor;
  reportError: (message: string) => Thenable<unknown>;
  reportInfo: (message: string, action: string) => Thenable<string | undefined>;
  output: Pick<vscode.OutputChannel, "appendLine">;
  pendingStore: PendingDispatchStore;
  openTarget: (target: Extract<DispatchRoute, { kind: "open" }>["target"]) => Thenable<unknown>;
  chatMode: ChatModeResolver;
  commandFile: CommandFileResolver;
}

function chatOpenOptions(
  command: string,
  dependencies: {
    executeCommand: CommandExecutor;
    chatMode: ChatModeResolver;
    commandFile: CommandFileResolver;
    output: Pick<vscode.OutputChannel, "appendLine">;
  },
): Thenable<unknown> {
  const resolution = dependencies.chatMode(command);
  const options: { query: string; mode?: string; attachFiles?: unknown[] } = { query: command };
  if (resolution.mode === null) {
    dependencies.output.appendLine(`dispatch: no mode for ${command}: ${resolution.reason}`);
  } else {
    options.mode = resolution.mode;
  }
  const file = dependencies.commandFile(command);
  if ("reason" in file) {
    dependencies.output.appendLine(`dispatch: no command file for ${commandName(command) ?? command}: ${file.reason}`);
  } else {
    options.attachFiles = [file.file];
  }
  return dependencies.executeCommand("workbench.action.chat.open", options);
}

export async function dispatchCommandToTarget(
  command: string,
  target: Extract<DispatchRoute, { kind: "open" }>["target"],
  reason: string,
  dependencies: Pick<CommandDispatcherDependencies, "executeCommand" | "reportInfo" | "pendingStore" | "openTarget" | "chatMode" | "commandFile" | "output">,
  isCurrentTarget: boolean,
): Promise<void> {
  if (isCurrentTarget) {
    await chatOpenOptions(command, dependencies);
    return;
  }
  await savePendingDispatch(dependencies.pendingStore, { target: target.path, command, createdAt: Date.now() });
  try {
    await dependencies.openTarget(target);
  } catch (error) {
    await dependencies.pendingStore.update(pendingDispatchKey(target.path), undefined);
    throw error;
  }
  void Promise.resolve(dependencies.reportInfo(reason, "Focus target"))
    .then((selection) => selection === "Focus target" ? dependencies.openTarget(target) : undefined)
    .catch(() => undefined);
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
      await dispatchCommandToTarget(route.command, route.target, route.reason, dependencies, false);
      return route;
    }

    await chatOpenOptions(route.command, { executeCommand, chatMode: dependencies.chatMode, commandFile: dependencies.commandFile, output: dependencies.output });
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
  dependencies: Pick<CommandDispatcherDependencies, "pendingStore" | "executeCommand" | "reportError" | "output" | "chatMode" | "commandFile">,
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
      await chatOpenOptions(result.command, dependencies);
    } catch (error) {
      const message = `Unable to submit pending Agento command: ${error instanceof Error ? error.message : String(error)}`;
      dependencies.output.appendLine(message);
      await dependencies.reportError(message);
    }
  }
}