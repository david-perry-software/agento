import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";

import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("david-perry-software.agento-dashboard");
  assert.ok(extension, "the installed Agento extension is discoverable");
  assert.equal(await realpath(extension.extensionPath), process.env.AGENTO_EXPECTED_EXTENSION_PATH);

  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of ["agento.refresh", "agento.showActions", "agento.newPlan", "agento.planInitiativeMember"]) {
    assert.ok(commands.includes(command), `${command} is contributed by the installed VSIX`);
  }

  const viewIds = extension.packageJSON.contributes.views.agento.map((view: { id: string }) => view.id);
  assert.deepEqual(viewIds, ["agento.deliveries", "agento.initiatives", "agento.sessionDoctor"]);
}