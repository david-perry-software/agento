"use strict";

// Agento Dispatch Probe: a dependency-free development extension.
//
// It contributes two commands:
// - "Agento Probe: Dispatch variant" — a QuickPick of the V1–V8 variants from
//   variants.js.
// - "Agento Probe: Dispatch with model" — lists the installed chat models and the
//   /chat.*model/i command ids, asks for a target model, then runs one of the
//   M1–M5 model variants from model-variants.js.
// Both call workbench.action.chat.open with the chosen payload and log the payload,
// the command's settled value or thrown error, and the elapsed time to the
// "Agento Dispatch Probe" output channel.

const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildVariants } = require("./variants.js");
const { buildModelVariants } = require("./model-variants.js");

const OUTPUT_CHANNEL_NAME = "Agento Dispatch Probe";
const COMMAND_ID = "agentoDispatchProbe.runVariant";
const MODEL_COMMAND_ID = "agentoDispatchProbe.runModelVariant";

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

// Opens `variant.payload` in chat and logs the settled value or thrown error.
// Returns true when the open settled, false when it threw.
async function openChat(channel, variant) {
  channel.appendLine(`[${variant.id}] open ${JSON.stringify(variant.payload)}`);
  const started = Date.now();
  try {
    const settled = await vscode.commands.executeCommand("workbench.action.chat.open", variant.payload);
    channel.appendLine(`[${variant.id}] settled ${JSON.stringify(settled)} in ${Date.now() - started} ms`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channel.appendLine(`[${variant.id}] threw ${message} after ${Date.now() - started} ms`);
    void vscode.window.showErrorMessage(`Agento Dispatch Probe ${variant.id}: ${message}`);
    return false;
  }
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

      const opened = await openChat(channel, variant);
      if (!opened || !variant.followUp) return;

      channel.appendLine(`[${variant.id}] follow-up ${variant.followUp}`);
      const followStarted = Date.now();
      try {
        await vscode.commands.executeCommand(variant.followUp);
        channel.appendLine(`[${variant.id}] follow-up settled in ${Date.now() - followStarted} ms`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[${variant.id}] follow-up threw ${message} after ${Date.now() - followStarted} ms`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(MODEL_COMMAND_ID, async () => {
      const models = await vscode.lm.selectChatModels();
      for (const model of models) {
        channel.appendLine(
          `[model] ${JSON.stringify({ id: model.id, name: model.name, vendor: model.vendor, family: model.family, version: model.version })}`,
        );
      }
      if (models.length === 0) {
        channel.appendLine("[models] none");
        void vscode.window.showErrorMessage("Agento Dispatch Probe: no chat models available");
        return;
      }

      const commands = await vscode.commands.getCommands(true);
      const modelCommands = commands.filter((id) => /chat.*model/i.test(id));
      for (const id of modelCommands) {
        channel.appendLine(`[model-command] ${id}`);
      }

      const targetPick = await vscode.window.showQuickPick(
        models.map((model) => ({
          label: model.name,
          description: model.vendor ? `${model.vendor} · ${model.id}` : model.id,
          model,
        })),
        { placeHolder: "Choose a target model", title: "Agento Probe: Dispatch with model" },
      );
      if (!targetPick) return;

      let file;
      try {
        file = resolveCommandFile();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        channel.appendLine(`[resolve] ${message}`);
        void vscode.window.showErrorMessage(`Agento Dispatch Probe: ${message}`);
        return;
      }

      const target = {
        id: targetPick.model.id,
        vendor: targetPick.model.vendor,
        family: targetPick.model.family,
      };
      const variants = buildModelVariants(file, target);
      const m5 = variants.find((variant) => variant.id === "M5");
      if (m5) m5.modelChangeCommand = modelCommands[0] ?? null;

      const pick = await vscode.window.showQuickPick(
        variants.map((variant) => ({
          label: variant.id,
          description: JSON.stringify(variant.payload),
          detail: "modelChangeCommand" in variant ? `model-change: ${variant.modelChangeCommand ?? "n/a"}` : "",
        })),
        { placeHolder: "Choose a model variant", title: "Agento Probe: Dispatch with model" },
      );
      if (!pick) return;

      const variant = variants.find((candidate) => candidate.id === pick.label);
      if (!variant) return;

      if (variant.id === "M5") {
        if (!variant.modelChangeCommand) {
          channel.appendLine("[M5] n/a (no /chat.*model/i command discovered)");
          return;
        }
        channel.appendLine(`[M5] run ${variant.modelChangeCommand} ${JSON.stringify({ vendor: target.vendor, id: target.id })}`);
        try {
          await vscode.commands.executeCommand(variant.modelChangeCommand, { vendor: target.vendor, id: target.id });
          channel.appendLine("[M5] model-change settled");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          channel.appendLine(`[M5] model-change threw ${message}`);
        }
      }

      await openChat(channel, variant);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
