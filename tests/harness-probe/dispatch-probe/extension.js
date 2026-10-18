"use strict";

// Agento Dispatch Probe: a dependency-free development extension.
//
// It contributes one command, "Agento Probe: Dispatch variant", which shows a
// QuickPick of the V1–V8 variants from variants.js and calls
// workbench.action.chat.open with the chosen payload. It logs the payload, the
// command's settled value or thrown error, and the elapsed time to the
// "Agento Dispatch Probe" output channel.

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildVariants } = require("./variants.js");

const OUTPUT_CHANNEL_NAME = "Agento Dispatch Probe";
const COMMAND_ID = "agentoDispatchProbe.runVariant";

// Resolves skills/agento/commands/delivery-status.md from the realpath of
// ~/.copilot/skills/agento, two levels up (the installed router skill's plugin
// root), matching how the real extension resolves the command file.
function resolveCommandFile() {
  const skillLink = path.join(os.homedir(), ".copilot", "skills", "agento");
  const real = fs.realpathSync(skillLink);
  const pluginRoot = path.resolve(real, "..", "..");
  const file = path.join(pluginRoot, "skills", "agento", "commands", "delivery-status.md");
  if (!fs.existsSync(file)) {
    throw new Error(`command file missing: ${file}`);
  }
  return vscode.Uri.file(file);
}

function activate(context) {
  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(channel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, async () => {
      let file;
      try {
        file = resolveCommandFile();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[resolve] ${message}`);
        void vscode.window.showErrorMessage(`Agento Dispatch Probe: ${message}`);
        return;
      }

      const variants = buildVariants(file);
      const pick = await vscode.window.showQuickPick(
        variants.map((variant) => ({
          label: variant.id,
          description: JSON.stringify(variant.payload),
          detail: variant.followUp ? `follow-up: ${variant.followUp}` : "",
        })),
        { placeHolder: "Choose a dispatch variant", title: "Agento Probe: Dispatch variant" },
      );
      if (!pick) return;

      const variant = variants.find((candidate) => candidate.id === pick.label);
      if (!variant) return;

      channel.appendLine(`[${variant.id}] open ${JSON.stringify(variant.payload)}`);
      const started = Date.now();
      try {
        const settled = await vscode.commands.executeCommand("workbench.action.chat.open", variant.payload);
        channel.appendLine(`[${variant.id}] settled ${JSON.stringify(settled)} in ${Date.now() - started} ms`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[${variant.id}] threw ${message} after ${Date.now() - started} ms`);
        void vscode.window.showErrorMessage(`Agento Dispatch Probe ${variant.id}: ${message}`);
        return;
      }

      if (variant.followUp) {
        channel.appendLine(`[${variant.id}] follow-up ${variant.followUp}`);
        try {
          await vscode.commands.executeCommand(variant.followUp);
          channel.appendLine(`[${variant.id}] follow-up settled in ${Date.now() - started} ms`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          channel.appendLine(`[${variant.id}] follow-up threw ${message} after ${Date.now() - started} ms`);
        }
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
