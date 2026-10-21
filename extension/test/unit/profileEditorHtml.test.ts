import assert from "node:assert/strict";
import test from "node:test";

import { makeNonce, renderEditorHtml } from "../../src/profileEditorHtml.js";

test("makeNonce returns a fresh 32-hex-char nonce", () => {
  const nonce = makeNonce();
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(nonce, makeNonce());
});

test("renderEditorHtml emits the exact CSP with the nonce on its only script tag", () => {
  const html = renderEditorHtml({
    nonce: "abc123",
    cspSource: "vscode-webview",
    scriptUri: "vscode-webview://file/media/profileEditor.js",
    styleUri: "vscode-webview://file/media/profileEditor.css",
    title: "Model profile",
  });
  assert.ok(
    html.includes(`content="default-src 'none'; style-src vscode-webview; script-src 'nonce-abc123'; img-src vscode-webview data:; font-src vscode-webview"`),
    html,
  );
  assert.equal(html.match(/<script/g)?.length ?? 0, 1, html);
  assert.ok(html.includes('<script nonce="abc123" src="vscode-webview://file/media/profileEditor.js"></script>'), html);
  assert.ok(html.includes('<link rel="stylesheet" href="vscode-webview://file/media/profileEditor.css">'), html);
  assert.ok(html.includes("<title>Model profile</title>"), html);
});

test("renderEditorHtml has no inline handlers and no remote URLs of its own", () => {
  const html = renderEditorHtml({
    nonce: "abc123",
    cspSource: "vscode-webview",
    scriptUri: "vscode-webview://file/media/profileEditor.js",
    styleUri: "vscode-webview://file/media/profileEditor.css",
    title: "Model profile",
  });
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, html);
  assert.equal(html.includes("http://"), false, html);
  assert.equal(html.includes("https://"), false, html);
});

test("renderEditorHtml escapes the title and attribute values", () => {
  const html = renderEditorHtml({
    nonce: "a&b",
    cspSource: "vscode-webview",
    scriptUri: "vscode-webview://file/media/profileEditor.js",
    styleUri: "vscode-webview://file/media/profileEditor.css",
    title: "A <b>& 'q'</b>",
  });
  assert.ok(html.includes("<title>A &lt;b&gt;&amp; &#39;q&#39;&lt;/b&gt;</title>"), html);
  assert.ok(html.includes('nonce="a&amp;b"'), html);
});
