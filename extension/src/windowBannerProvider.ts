import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { BANNER_CLICK_COMMAND, renderWindowBannerHtml, type WindowBannerModel } from "./windowBanner.js";

export class WindowBannerProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private lastHtml: string | undefined;

  constructor(private banner: WindowBannerModel) {}

  get current(): WindowBannerModel {
    return this.banner;
  }

  get html(): string | undefined {
    return this.lastHtml;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: false,
      enableCommandUris: [BANNER_CLICK_COMMAND],
      localResourceRoots: [],
    };
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    this.render();
  }

  update(banner: WindowBannerModel): void {
    this.banner = banner;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.lastHtml = renderWindowBannerHtml(this.banner, randomBytes(16).toString("hex"));
    this.view.webview.html = this.lastHtml;
  }
}
