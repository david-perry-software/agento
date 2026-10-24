// A small, safe Markdown renderer for delivery artifacts (plan.md, roadmap.md,
// review.md) on the delivery page. No DOM and no dependencies, so node:test
// imports it directly.
//
// Safety: every piece of source text is HTML-escaped before inline formatting is
// applied, raw HTML is never passed through, and only http(s)/mailto links become
// real anchors (opened in a new tab, rel="noopener noreferrer"). Links between the
// delivery's own artifacts (`plan.md`, `roadmap.md`, `review.md`) become in-page
// tab switches (`data-doc`); `#anchor` links become in-page jumps (`data-anchor`);
// other relative paths (evidence files) render as labelled text.
//
// Supported: ATX headings (shifted down so a document `#` sits under the page's
// h2), paragraphs with soft and hard breaks, **strong**, *em*, ~~del~~, `code`,
// fenced code blocks, block quotes, nested ordered/unordered lists, task lists,
// GFM pipe tables with alignment, horizontal rules, links, images (as labels).

const HEADING_SHIFT = 2;

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const ARTIFACT_DOCS = new Set(["plan", "roadmap", "review"]);

function linkHtml(label, href, ctx) {
  const inner = inline(label, ctx);
  const url = href.trim();
  if (/^(https?:|mailto:)/i.test(url)) {
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  }
  if (url.startsWith("#")) {
    return `<a class="md-ref" role="link" tabindex="0" data-anchor="${escapeHtml(slugify(url.slice(1)))}">${inner}</a>`;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//")) {
    const name = url.split(/[?#]/)[0].split("/").pop() ?? "";
    const doc = name.replace(/\.md$/i, "");
    if (/\.md$/i.test(name) && ARTIFACT_DOCS.has(doc.toLowerCase())) {
      return `<a class="md-ref" role="link" tabindex="0" data-doc="${escapeHtml(doc.toLowerCase())}">${inner}</a>`;
    }
    return `<span class="md-path" title="${escapeHtml(url)}">${inner}</span>`;
  }
  return inner;
}

// Inline formatting. Code spans, links, and images are rendered first into slots so
// their contents are never re-formatted; the remaining text is escaped, then
// emphasis is applied to the escaped text, then slots are restored.
function inline(text, ctx = {}) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text ?? "").replace(/\u0000/g, "");
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code) => hold(`<code>${escapeHtml(code.trim())}</code>`));
  const url = String.raw`((?:[^()\s]|\([^()\s]*\))+)`;
  s = s.replace(new RegExp(String.raw`!\[([^\]]*)\]\(\s*${url}(?:\s+"[^"]*")?\s*\)`, "g"), (_, alt, src) => hold(`<span class="md-image" title="${escapeHtml(src)}">${escapeHtml(alt || src)}</span>`));
  s = s.replace(new RegExp(String.raw`\[([^\]]+)\]\(\s*${url}(?:\s+"[^"]*")?\s*\)`, "g"), (_, label, href) => hold(linkHtml(label, href, ctx)));
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|[^*\w\\])\*(?=[^\s*])([^*]*?[^\s*\\])\*(?![*\w])/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, "$1");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s/g, "-");
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const isBlank = (line) => /^\s*$/.test(line);

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || (line.includes("|") && next != null && TABLE_SEPARATOR.test(next) && next.includes("-"));
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function tableHtml(lines, ctx) {
  const header = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
  const cell = (tag, text, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${inline(text, ctx)}</${tag}>`;
  const head = `<tr>${header.map((h, i) => cell("th", h, i)).join("")}</tr>`;
  const body = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    return `<tr>${header.map((_, i) => cell("td", cells[i] ?? "", i)).join("")}</tr>`;
  }).join("");
  return `<div class="md-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

// One list starting at lines[start]; returns [html, nextIndex].
function listHtml(lines, start, ctx) {
  const first = lines[start].match(LIST_ITEM);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (!m || indentOf(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        const next = lines.slice(i + 1).find((l) => !isBlank(l));
        if (next != null && indentOf(next) > baseIndent) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent > baseIndent) {
        body.push(line.replace(/\t/g, "    ").slice(Math.min(indent, contentIndent)));
        i++;
        continue;
      }
      if (LIST_ITEM.test(line) || startsBlock(line, lines[i + 1])) break;
      body.push(line.trim());
      i++;
    }
    items.push(body);
  }
  const html = items.map((body) => {
    let text = body[0];
    let task = "";
    const box = text.match(/^\[([ xX])\]\s+(.*)$/);
    if (box) {
      task = `<input type="checkbox" disabled${box[1] === " " ? "" : " checked"} aria-label="${box[1] === " " ? "not done" : "done"}"> `;
      text = box[2];
    }
    const rest = body.slice(1);
    const tight = !rest.some((l) => isBlank(l));
    const leadEnd = rest.findIndex((l) => isBlank(l) || startsBlock(l, undefined));
    const lead = [text, ...(leadEnd === -1 ? rest : rest.slice(0, leadEnd))];
    const tail = leadEnd === -1 ? [] : rest.slice(leadEnd);
    const leadHtml = tight ? inline(lead.join(" "), ctx) : `<p>${inline(lead.join(" "), ctx)}</p>`;
    const tailHtml = tail.length ? blocks(tail, ctx) : "";
    return `<li${task ? ' class="md-task"' : ""}>${task}${leadHtml}${tailHtml}</li>`;
  }).join("");
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNumber !== 1 ? ` start="${startNumber}"` : "";
  return [`<${tag}${startAttr}${items.some((b) => /^\[[ xX]\]\s/.test(b[0])) ? ' class="md-tasks"' : ""}>${html}</${tag}>`, i];
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
      i++;
      const lang = fence[3] ? ` class="language-${escapeHtml(fence[3])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(6, heading[1].length + HEADING_SHIFT);
      const base = slugify(heading[2]) || "section";
      const count = ctx.ids.get(base) ?? 0;
      ctx.ids.set(base, count + 1);
      const id = count ? `${base}-${count}` : base;
      out.push(`<h${level} id="${escapeHtml(`${ctx.idPrefix}${id}`)}" data-anchor-id="${escapeHtml(id)}">${inline(heading[2], ctx)}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i], lines[i + 1]))) {
        quoted.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      out.push(`<blockquote>${blocks(quoted, ctx)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(lines[i++]);
      out.push(tableHtml(rows, ctx));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [html, next] = listHtml(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    // Format the paragraph as one string so a link label or emphasis may wrap
    // lines; \u0001 marks a hard break until after inline formatting.
    const text = para
      .map((l, n) => (n < para.length - 1 && /( {2,}|\\)$/.test(l) ? `${l.replace(/( {2,}|\\)$/, "").trim()}\u0001` : l.trim()))
      .join("\n");
    out.push(`<p>${inline(text, ctx).replace(/\u0001/g, "<br>")}</p>`);
  }
  return out.join("\n");
}

// Render `text` to an HTML string. `idPrefix` namespaces heading ids so several
// documents can share one page.
export function renderMarkdown(text, { idPrefix = "md-" } = {}) {
  // \u0000 and \u0001 are the renderer's own placeholders; source text never keeps them.
  const lines = String(text ?? "").replace(/[\u0000\u0001]/g, "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines, { idPrefix, ids: new Map() });
}
