import { randomBytes } from "node:crypto";

export interface EditorHtmlOptions {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  title: string;
}

/** A fresh per-render nonce for the editor webview's CSP. */
export function makeNonce(): string {
  return randomBytes(16).toString("hex");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The editor webview document: a strict CSP with one nonce'd script tag, a linked
// stylesheet, and no inline handlers or remote URLs of its own. Every value comes
// from `webview.asWebviewUri` / `webview.cspSource`, never a hard-coded URL.
export function renderEditorHtml({ nonce, cspSource, scriptUri, styleUri, title }: EditorHtmlOptions): string {
  const safeNonce = escapeHtml(nonce);
  const safeCsp = escapeHtml(cspSource);
  const safeScript = escapeHtml(scriptUri);
  const safeStyle = escapeHtml(styleUri);
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${safeCsp}; script-src 'nonce-${safeNonce}'; img-src ${safeCsp} data:; font-src ${safeCsp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<link rel="stylesheet" href="${safeStyle}">
</head>
<body>
<div id="root"></div>
<script nonce="${safeNonce}" src="${safeScript}"></script>
</body>
</html>`;
}
