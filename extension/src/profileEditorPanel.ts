import * as vscode from "vscode";

import { CliClient } from "./cliClient.js";
import { aliasSetArgs, renameProfileArgs, summarizeModelsResult, updateProfileArgs } from "./modelProfiles.js";
import { makeNonce, renderEditorHtml } from "./profileEditorHtml.js";
import {
  diffFields,
  formToProfile,
  modelChoices,
  parseWebviewMessage,
  profileToForm,
  type WebviewForm,
} from "./profileEditorModel.js";

/** Supplies the models VS Code knows about, replaceable for tests. */
export type ModelSource = () => Promise<unknown[]>;

export interface ProfileEditorHost {
  /** The resolved plugin root, or null when none is reachable. */
  pluginRoot: () => string | null;
  /** Reload the Model Profiles tree view (and its file watchers). */
  reload: () => Promise<void>;
  /** Apply a profile through the existing `models apply` path. */
  apply: (profile: string) => Promise<unknown>;
  /** Open the profiles file for raw editing. */
  openFile: () => Promise<void>;
}

interface PanelState {
  panel: vscode.WebviewPanel;
  name: string;
  hash: string | null;
  dirty: boolean;
  baseBody: Record<string, unknown>;
  unknown: Record<string, unknown>;
  lastPosted: unknown;
  /** Bumped by every load and by marking dirty, so a load that finishes after the
   *  panel turned dirty (or a newer load started) never clobbers the draft. */
  loadToken: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// One `WebviewPanel` per profile name; a second open reveals the existing panel.
export class ProfileEditorPanels {
  private readonly panels = new Map<string, PanelState>();
  private modelSource: ModelSource;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: CliClient,
    private readonly output: vscode.OutputChannel,
    private readonly host: ProfileEditorHost,
  ) {
    this.modelSource = async () => {
      const models = await vscode.lm.selectChatModels();
      return models as unknown[];
    };
  }

  setModelSource(source: ModelSource): void {
    this.modelSource = source;
  }

  get openNames(): string[] {
    return [...this.panels.keys()];
  }

  lastPosted(name: string): unknown {
    return this.panels.get(name)?.lastPosted ?? null;
  }

  async open(name: string): Promise<void> {
    const existing = this.panels.get(name);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("agento.modelProfileEditor", `Profile: ${name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    const state: PanelState = { panel, name, hash: null, dirty: false, baseBody: {}, unknown: {}, lastPosted: null, loadToken: 0 };
    this.panels.set(name, state);
    panel.onDidDispose(() => {
      if (this.panels.get(state.name) === state) this.panels.delete(state.name);
    });
    panel.webview.onDidReceiveMessage((raw) => {
      void this.handleMessage(state.name, raw);
    });
    this.render(panel);
    await this.load(name);
  }

  async notifyProfilesChanged(): Promise<void> {
    for (const name of [...this.panels.keys()]) {
      const state = this.panels.get(name);
      if (!state) continue;
      if (state.dirty) continue;
      await this.load(name);
    }
  }

  dispose(): void {
    for (const state of this.panels.values()) state.panel.dispose();
    this.panels.clear();
  }

  private render(panel: vscode.WebviewPanel): void {
    const nonce = makeNonce();
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "profileEditor.js"));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "profileEditor.css"));
    panel.webview.html = renderEditorHtml({
      nonce,
      cspSource: panel.webview.cspSource,
      scriptUri: scriptUri.toString(),
      styleUri: styleUri.toString(),
      title: panel.title,
    });
  }

  private post(name: string, message: unknown): void {
    const state = this.panels.get(name);
    if (!state) return;
    state.lastPosted = message;
    void state.panel.webview.postMessage(message);
  }

  private updateTitle(name: string): void {
    const state = this.panels.get(name);
    if (!state) return;
    state.panel.title = `${state.dirty ? "● " : ""}Profile: ${state.name}`;
  }

  private rekey(oldName: string, newName: string, hash: string | null): void {
    const state = this.panels.get(oldName);
    if (!state) return;
    this.panels.delete(oldName);
    state.name = newName;
    state.hash = hash;
    this.panels.set(newName, state);
    this.updateTitle(newName);
  }

  private async load(name: string, opts: { keepDraft?: boolean } = {}): Promise<void> {
    const state = this.panels.get(name);
    if (!state) return;
    state.loadToken += 1;
    const token = state.loadToken;
    const root = this.host.pluginRoot();
    if (!root) return;

    const show = await this.client.run(["models", "show", name, "--plugin-root", root], root);
    if (!opts.keepDraft && (state.loadToken !== token || state.dirty)) return;
    const showJson = isRecord(show.json) ? show.json : {};
    if (show.code === 3 && showJson.status === "not-found") {
      this.post(name, { type: "deleted" });
      return;
    }

    const list = await this.client.run(["models", "list", "--plugin-root", root], root);
    const listJson = isRecord(list.json) ? list.json : {};
    const pinnable = isRecord(listJson.pinnable)
      ? { agents: arrayOfStrings(listJson.pinnable.agents), prompts: arrayOfStrings(listJson.pinnable.prompts) }
      : { agents: [], prompts: [] };
    const copilotModels = isRecord(listJson.copilotModels) ? listJson.copilotModels : {};
    const body = isRecord(showJson.body) ? showJson.body : {};
    const hash = isRecord(showJson.profilesFile) && typeof showJson.profilesFile.hash === "string" ? showJson.profilesFile.hash : null;

    const form = profileToForm(body, pinnable);
    if (!opts.keepDraft && (state.loadToken !== token || state.dirty)) return;
    form.name = name;
    state.baseBody = body;
    state.unknown = form.unknown;
    state.hash = hash;
    if (!opts.keepDraft) {
      state.dirty = false;
      this.updateTitle(name);
    }

    this.post(name, {
      type: "state",
      name,
      form: { name: form.name, description: form.description, default: form.default, agents: form.agents, prompts: form.prompts },
      pinnable,
      choices: modelChoices(await this.modelSource()),
      copilotModels,
      hash,
      unknownKeys: Object.keys(form.unknown),
      ...(opts.keepDraft ? { keepDraft: true } : {}),
    });
  }

  async handleMessage(name: string, raw: unknown): Promise<void> {
    const parsed = parseWebviewMessage(raw);
    if (!parsed.ok) {
      this.output.appendLine(`model profile editor: ${name}: ${parsed.error}`);
      return;
    }
    if (!this.panels.has(name)) return;
    switch (parsed.message.type) {
      case "ready":
        await this.load(name);
        break;
      case "change":
        this.markDirty(name, parsed.message.dirty);
        break;
      case "validate":
        await this.validate(name, parsed.message.form);
        break;
      case "save":
        await this.save(name, parsed.message.form, false);
        break;
      case "saveAndApply":
        await this.save(name, parsed.message.form, true);
        break;
      case "addAlias":
        await this.addAlias(name, parsed.message.value, parsed.message.id);
        break;
      case "reload":
        await this.load(name);
        break;
      case "openFile":
        await this.host.openFile();
        break;
    }
  }

  private markDirty(name: string, dirty: boolean): void {
    const state = this.panels.get(name);
    if (!state) return;
    if (dirty) state.loadToken += 1; // cancel any in-flight load
    state.dirty = dirty;
    this.updateTitle(name);
  }

  private bodyOf(name: string, form: WebviewForm): Record<string, unknown> {
    const state = this.panels.get(name);
    return formToProfile({ ...form, unknown: state?.unknown ?? {} });
  }

  private async validate(name: string, form: WebviewForm): Promise<void> {
    const root = this.host.pluginRoot();
    if (!root) return;
    const result = await this.client.run(updateProfileArgs(name, root, { dryRun: true }), root, { input: JSON.stringify(this.bodyOf(name, form)) });
    const json = isRecord(result.json) ? result.json : {};
    this.post(name, { type: "validateResult", errors: arrayOfStrings(json.errors), warnings: arrayOfStrings(json.warnings) });
  }

  private async save(name: string, form: WebviewForm, apply: boolean): Promise<void> {
    const root = this.host.pluginRoot();
    if (!root) return;
    const state = this.panels.get(name);
    if (!state) return;
    const body = this.bodyOf(name, form);

    // Dry-run first; stop on errors without writing.
    const dry = await this.client.run(updateProfileArgs(name, root, { dryRun: true }), root, { input: JSON.stringify(body) });
    const dryJson = isRecord(dry.json) ? dry.json : {};
    const dryErrors = arrayOfStrings(dryJson.errors);
    if (dryErrors.length) {
      this.post(name, { type: "validateResult", errors: dryErrors, warnings: arrayOfStrings(dryJson.warnings) });
      return;
    }

    let hash = state.hash;
    let currentName = name;
    if (form.name && form.name !== name) {
      const renameResult = await this.client.run(renameProfileArgs(name, form.name, root, { hash }), root);
      const renameJson = isRecord(renameResult.json) ? renameResult.json : {};
      if (renameJson.status === "conflict") {
        await this.conflict(name);
        return;
      }
      if (renameResult.code !== 0) {
        this.post(name, { type: "validateResult", errors: [typeof renameJson.message === "string" ? renameJson.message : "The rename failed"], warnings: [] });
        return;
      }
      hash = isRecord(renameJson.profilesFile) && typeof renameJson.profilesFile.hash === "string" ? renameJson.profilesFile.hash : null;
      this.rekey(name, form.name, hash);
      currentName = form.name;
    }

    const updateResult = await this.client.run(updateProfileArgs(currentName, root, { expect: hash }), root, { input: JSON.stringify(body) });
    const updateJson = isRecord(updateResult.json) ? updateResult.json : {};
    if (updateJson.status === "conflict") {
      await this.conflict(currentName);
      return;
    }
    if (updateResult.code !== 0) {
      this.post(currentName, { type: "validateResult", errors: arrayOfStrings(updateJson.errors), warnings: [] });
      return;
    }

    // A successful save is no longer dirty; clear it before the reload so `load`
    // posts the new state and hash instead of returning early on `state.dirty`
    // (which left the stale hash and `●` marker, and made the next Save answer a
    // spurious conflict).
    state.dirty = false;
    this.updateTitle(currentName);
    await this.load(currentName);
    await this.host.reload();
    const summary = summarizeModelsResult(updateResult.json);
    if (summary.ok) void vscode.window.showInformationMessage(summary.message);
    if (apply) await this.host.apply(currentName);
  }

  private async addAlias(name: string, value: string, id: string): Promise<void> {
    const root = this.host.pluginRoot();
    if (!root) return;
    const state = this.panels.get(name);
    if (!state) return;
    const result = await this.client.run(aliasSetArgs(value, id, root, { expect: state.hash }), root);
    const json = isRecord(result.json) ? result.json : {};
    if (json.status === "conflict") {
      await this.conflict(name);
      return;
    }
    if (result.code !== 0) {
      this.post(name, { type: "validateResult", errors: [typeof json.message === "string" ? json.message : "The alias was not saved"], warnings: [] });
      return;
    }
    await this.host.reload();
    // The alias changed `copilotModels`; re-post the full editor state (so the
    // webview has everything `renderForm` reads) while keeping any unsaved
    // draft. The previous partial `{ type: "state", keepDraft: true, name,
    // copilotModels, hash }` message crashed `receiveState`/`renderForm` on the
    // missing `unknownKeys`.
    await this.load(state.name, { keepDraft: true });
  }

  private async conflict(name: string): Promise<void> {
    const root = this.host.pluginRoot();
    if (!root) return;
    const state = this.panels.get(name);
    if (!state) return;
    const show = await this.client.run(["models", "show", name, "--plugin-root", root], root);
    const showJson = isRecord(show.json) ? show.json : {};
    if (showJson.status === "not-found") {
      this.post(name, { type: "deleted" });
      return;
    }
    const latest = isRecord(showJson.body) ? showJson.body : {};
    this.post(name, { type: "conflict", changed: diffFields(state.baseBody, latest) });
  }
}
