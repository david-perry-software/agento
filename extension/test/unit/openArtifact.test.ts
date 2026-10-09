import assert from "node:assert/strict";
import test from "node:test";

import { MARKDOWN_PREVIEW_VIEW_TYPE, openArtifactPreview } from "../../src/openArtifact.js";

const URI = "/repo/features/2026/10/demo/roadmap.md";

test("openArtifactPreview opens the Markdown preview custom editor", async () => {
  const openWith: Array<[string, string]> = [];
  const openSource: string[] = [];
  const logs: string[] = [];
  const result = await openArtifactPreview(URI, {
    openWith: async (uri, viewType) => { openWith.push([uri, viewType]); },
    openSource: async (uri) => { openSource.push(uri); },
    log: (message) => { logs.push(message); },
  });
  assert.equal(MARKDOWN_PREVIEW_VIEW_TYPE, "vscode.markdown.preview.editor");
  assert.equal(result, "preview");
  assert.deepEqual(openWith, [[URI, "vscode.markdown.preview.editor"]]);
  assert.deepEqual(openSource, []);
  assert.deepEqual(logs, []);
});

test("openArtifactPreview falls back to source text and logs once when the preview rejects", async () => {
  const openSource: string[] = [];
  const logs: string[] = [];
  const result = await openArtifactPreview(URI, {
    openWith: async () => { throw new Error("markdown extension disabled"); },
    openSource: async (uri) => { openSource.push(uri); },
    log: (message) => { logs.push(message); },
  });
  assert.equal(result, "source");
  assert.deepEqual(openSource, [URI]);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /markdown extension disabled/);
});
