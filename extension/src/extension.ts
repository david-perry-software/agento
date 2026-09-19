import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Agento");
  output.appendLine("activated");
  context.subscriptions.push(output);
}

export function deactivate(): void {}