// The delivery page's Markdown renderer (public/markdown.js): block and inline
// coverage of what plan.md / roadmap.md / review.md use, and its safety rules.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { renderMarkdown, slugify } from "./public/markdown.js";

test("headings shift under the page title and get unique, prefixed ids", () => {
  const html = renderMarkdown("# Title\n## Steps\n## Steps", { idPrefix: "plan-" });
  assert.match(html, /^<h3 id="plan-title" data-anchor-id="title">Title<\/h3>/);
  assert.match(html, /<h4 id="plan-steps" data-anchor-id="steps">Steps<\/h4>/);
  assert.match(html, /<h4 id="plan-steps-1" data-anchor-id="steps-1">Steps<\/h4>/);
});

test("paragraphs join soft breaks and keep hard breaks", () => {
  assert.equal(renderMarkdown("one\ntwo"), "<p>one\ntwo</p>");
  assert.equal(renderMarkdown("one  \ntwo"), "<p>one<br>\ntwo</p>");
  assert.equal(renderMarkdown("<\u0001>"), "<p>&lt;&gt;</p>", "a stray control character never becomes markup");
});

test("inline strong, em, del, code, and escapes", () => {
  assert.equal(renderMarkdown("**b** *i* _u_ ~~d~~ `a <b> *c*`"), "<p><strong>b</strong> <em>i</em> <em>u</em> <del>d</del> <code>a &lt;b&gt; *c*</code></p>");
  assert.equal(renderMarkdown("snake_case_name and 2*3*4"), "<p>snake_case_name and 2*3*4</p>");
  assert.equal(renderMarkdown("\\*not em\\*"), "<p>*not em*</p>");
});

test("raw HTML is escaped, never passed through", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("links: http(s) open safely, artifact links switch tabs, anchors jump, unsafe schemes are dropped", () => {
  assert.equal(renderMarkdown("[gh](https://github.com)"), '<p><a href="https://github.com" target="_blank" rel="noopener noreferrer">gh</a></p>');
  assert.equal(renderMarkdown("see [roadmap](./roadmap.md)"), '<p>see <a class="md-ref" role="link" tabindex="0" data-doc="roadmap">roadmap</a></p>');
  assert.equal(renderMarkdown("[up](#Open-Questions)"), '<p><a class="md-ref" role="link" tabindex="0" data-anchor="open-questions">up</a></p>');
  assert.equal(renderMarkdown("[x](javascript:alert(1))"), "<p>x</p>");
  assert.equal(renderMarkdown("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"), '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">wiki</a></p>');
  assert.equal(renderMarkdown('[e](evidence/a.png "shot")'), '<p><span class="md-path" title="evidence/a.png">e</span></p>');
  assert.equal(renderMarkdown("![board](evidence/b.png)"), '<p><span class="md-image" title="evidence/b.png">board</span></p>');
  assert.equal(renderMarkdown('[a"b](https://x.test/?q="1")'), '<p><a href="https://x.test/?q=&quot;1&quot;" target="_blank" rel="noopener noreferrer">a&quot;b</a></p>');
});

test("a link label wrapped across lines still links", () => {
  assert.match(renderMarkdown("Proof: [the spike\nscreenshot](evidence/step-1.png) shows it."), /<span class="md-path" title="evidence\/step-1.png">the spike\nscreenshot<\/span>/);
});

test("fenced code keeps its text verbatim and escaped", () => {
  assert.equal(renderMarkdown("```yaml\nstatus: <x>\n  - **y**\n```"), '<pre><code class="language-yaml">status: &lt;x&gt;\n  - **y**</code></pre>');
});

test("nested lists, ordered starts, and task items", () => {
  const html = renderMarkdown("- [x] 1.1 done\n- [ ] 1.2 todo\n  - nested\n\n3. three\n4. four");
  assert.match(html, /<ul class="md-tasks"><li class="md-task"><input type="checkbox" disabled checked aria-label="done"> 1.1 done<\/li>/);
  assert.match(html, /<li class="md-task"><input type="checkbox" disabled aria-label="not done"> 1.2 todo<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(html, /<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/);
});

test("list item continuation lines join the item", () => {
  assert.equal(renderMarkdown("- first line\n  continues here\n- second"), "<ul><li>first line continues here</li><li>second</li></ul>");
});

test("tables with alignment and escaped pipes", () => {
  const html = renderMarkdown("| A | B |\n|:--|--:|\n| `x|y` | 2 \\| 3 |");
  assert.match(html, /<th style="text-align:left">A<\/th><th style="text-align:right">B<\/th>/);
  assert.match(html, /<td style="text-align:left"><code>x\|y<\/code><\/td><td style="text-align:right">2 \| 3<\/td>/);
});

test("block quotes and rules", () => {
  assert.equal(renderMarkdown("> quoted **text**\n> more\n\n---"), "<blockquote><p>quoted <strong>text</strong>\nmore</p></blockquote>\n<hr>");
});

test("slugify", () => {
  assert.equal(slugify("Open Questions & Risks"), "open-questions--risks");
});

test("renders the real roadmap fixture without throwing and with every task box", () => {
  const roadmap = "```yaml\nstatus: in-progress\nbranch: feature/widget\n```\n\n# Roadmap: widget\n\n## Phase 1\n\n- [x] 1.1 One — verify: `node --test`\n- [ ] 1.2 Two — verify: see [plan](plan.md)\n";
  const html = renderMarkdown(roadmap);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.match(html, /data-doc="plan"/);
  assert.ok(fs);
});
