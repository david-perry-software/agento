// The pure startup-brief machinery: dispatch modes, per-role policy priority,
// the block model, and deterministic pagination/rendering. No I/O, no process
// spawning — `scripts/commands/brief.mjs` reads the files and preflight document
// and hands the assembled blocks here.

export const BRIEF_BUDGET = 7000;

// The command file's `agent:` frontmatter decides how it runs (router SKILL.md
// step 5; a test asserts this table equals that step's table).
export const DISPATCH_MODES = {
  "📋 Agento Planner": "inline-as-agent",
  "🏛️ Agento Architect": "inline-as-agent",
  "🛠️ Agento Mechanic": "inline-as-agent",
  "🤖 Agento Autopilot": "inline-as-agent",
  "🔨 Agento Builder": "subagent",
  "🔍 Agento Reviewer": "subagent",
};

export function dispatchMode(agent) {
  if (!agent || agent === "agent") return "inline";
  return DISPATCH_MODES[agent] ?? "inline";
}

export const DEFAULT_POLICY_PRIORITY = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];

// The order a role's declared policy sections are included in when the budget is
// tight. Each list is a permutation of that role's declared set; sections not
// declared by the command are skipped. Inline commands use numeric order.
export const BRIEF_POLICY_PRIORITY = {
  "🔨 Agento Builder": ["9", "7", "1", "2", "3", "5", "11", "10", "12", "8", "4"],
  "🔍 Agento Reviewer": ["9", "7", "2", "1", "5", "3", "11", "10", "12", "8", "4"],
  "📋 Agento Planner": ["9", "7", "1", "2", "5", "10", "11", "12", "4"],
  "🤖 Agento Autopilot": ["9", "7", "1", "3", "8", "11", "10", "12"],
  "🏛️ Agento Architect": ["9", "7", "1", "6", "10", "11", "12"],
  "🛠️ Agento Mechanic": ["9", "1", "10", "11", "12"],
};

const byteLength = (text) => Buffer.byteLength(text, "utf8");

// Splits `text` into chunks each ≤ `max` bytes, cutting at the best boundary
// within the budget: paragraph (`\n\n`), then heading (`\n## `), then line
// (`\n`), and finally a hard UTF-8-safe cut for an oversized single line.
export function splitText(text, max) {
  const chunks = [];
  let rest = text;
  while (byteLength(rest) > max) {
    const cut = bestSplit(rest, max);
    if (cut <= 0) {
      const head = truncateUtf8(rest, max);
      chunks.push(head);
      rest = rest.slice(head.length);
    } else {
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    rest = rest.replace(/^[\t ]*\r?\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function bestSplit(text, max) {
  const paragraph = text.lastIndexOf("\n\n", max);
  if (paragraph > 0) return paragraph + 2;
  const heading = text.lastIndexOf("\n## ", max);
  if (heading > 0) return heading + 1;
  const line = text.lastIndexOf("\n", max);
  if (line > 0) return line + 1;
  return 0;
}

function truncateUtf8(text, max) {
  if (byteLength(text) <= max) return text;
  let end = max;
  while (end > 0 && (text.charCodeAt(end) & 0xc0) === 0x80) end -= 1;
  return text.slice(0, end);
}

// A page under construction: appended chunks joined by blank lines, measured in
// UTF-8 bytes including the separators.
function pageBuilder(budget) {
  const chunks = [];
  let size = 0;
  return {
    get text() {
      return chunks.join("\n\n");
    },
    get size() {
      return size;
    },
    append(text) {
      if (!text) return true;
      const add = byteLength(text);
      const sep = chunks.length ? 2 : 0;
      if (size + sep + add > budget) return false;
      chunks.push(text);
      size += sep + add;
      return true;
    },
  };
}

// Packs already-budgeted chunks into as many pages as needed, each ≤ `budget`.
function packChunks(chunks, budget) {
  const pages = [];
  let current = pageBuilder(budget);
  for (const chunk of chunks) {
    if (!current.append(chunk)) {
      pages.push(current.text);
      current = pageBuilder(budget);
      current.append(chunk);
    }
  }
  if (current.size) pages.push(current.text);
  return pages;
}

function buildFooter({ more, pageCommand, onDemand }) {
  const lines = [];
  if (more.length) {
    lines.push(`More: ${more.map((n) => `\`${pageCommand} --page ${n}\``).join(", ")}`);
  }
  if (onDemand.length) {
    lines.push(`On demand: ${onDemand.map((p) => `\`policy ${p.n} — ${p.title} (${p.bytes} B)\``).join(", ")}`);
  }
  return lines.length ? lines.join("\n") : null;
}

// Orders the declared policy blocks by the role's priority, numeric fallback for
// sections the priority list does not name.
function orderPolicy(policy, agent) {
  const priority = BRIEF_POLICY_PRIORITY[agent] ?? DEFAULT_POLICY_PRIORITY;
  const byId = new Map(policy.map((b) => [b.id, b]));
  const ordered = priority.filter((n) => byId.has(n)).map((n) => byId.get(n));
  const named = new Set(priority);
  const extras = policy.filter((b) => !named.has(b.id)).sort((a, b) => Number(a.id) - Number(b.id));
  return [...ordered, ...extras];
}

// Assembles a page from core, a flow prefix, and sections. Returns null when the
// core or any flow chunk does not fit (never silently drops content).
function assemblePage(core, flowChunks, flowIndex, sections, budget) {
  const page = pageBuilder(budget);
  for (const text of core) {
    if (!page.append(text)) return null;
  }
  for (let j = 0; j < flowIndex; j += 1) {
    if (!page.append(flowChunks[j])) return null;
  }
  for (const section of sections) page.append(section.text);
  return page;
}

function toPointer(section) {
  return { n: section.id, title: section.title, bytes: section.bytes };
}

// Lays the assembled blocks out into pages. `blocks` is an array of
// `{ kind, id, text, bytes }` entries where `kind` is one of `receipt`,
// `session`, `delivery`, `command`, `agent`, or `policy` (policy blocks carry
// `id`/`title`/`bytes`). Returns the rendered pages, the continuation page
// numbers, the policy sections relegated to on-demand pointers, and a page
// placement map keyed by block id (page 1-based; `null` means on-demand).
export function paginateBrief({ blocks, budget = BRIEF_BUDGET, pageCommand, agent = null }) {
  const receipt = blocks.filter((b) => b.kind === "receipt").map((b) => b.text).join("\n\n");
  const session = blocks.filter((b) => b.kind === "session").map((b) => b.text).join("\n\n");
  const delivery = blocks.filter((b) => b.kind === "delivery").map((b) => b.text).join("\n\n");
  const mandatory = blocks.filter((b) => b.kind === "command" || b.kind === "agent");
  const policy = orderPolicy(blocks.filter((b) => b.kind === "policy"), agent);

  // Mandatory content (command, agent) becomes chunks that each fit one page;
  // record each block's first chunk index so placement can be computed later.
  const flowChunks = [];
  const firstChunk = new Map();
  for (const block of mandatory) {
    firstChunk.set(block.id, flowChunks.length);
    flowChunks.push(...splitText(block.text, budget));
  }

  const core = [receipt, session, delivery].filter(Boolean);

  // Page 1 holds the receipt (page 1 only), then session, delivery, as much
  // mandatory content as fits, then policy, then the footer. Try the largest
  // possible flow prefix first; shed policy (never mandatory content) so the
  // footer always fits. The footer lists the pages a reader must still fetch
  // and the policy sections that became on-demand pointers.
  for (let flowIndex = flowChunks.length; flowIndex >= 0; flowIndex -= 1) {
    const continuationPages = packChunks(flowChunks.slice(flowIndex), budget);
    const more = continuationPages.map((_, index) => index + 2);

    const base = assemblePage(core, flowChunks, flowIndex, [], budget);
    if (!base) continue; // this flow prefix does not fit page 1

    const included = [];
    const onDemand = [];
    for (const section of policy) {
      if (base.append(section.text)) included.push(section);
      else onDemand.push(toPointer(section));
    }

    const footer = buildFooter({ more, pageCommand, onDemand });
    if (!footer || base.append(footer)) {
      return finish({ page: base, continuationPages, more, included, onDemand, flowIndex, firstChunk, policy });
    }

    // The footer does not fit: shed the lowest-priority included sections.
    const trimmedIncluded = [...included];
    const trimmedOnDemand = [...onDemand];
    while (trimmedIncluded.length) {
      const last = trimmedIncluded.pop();
      trimmedOnDemand.push(toPointer(last));
      trimmedOnDemand.sort((a, b) => Number(a.n) - Number(b.n));
      const rebuilt = assemblePage(core, flowChunks, flowIndex, trimmedIncluded, budget);
      const rebuiltFooter = buildFooter({ more, pageCommand, onDemand: trimmedOnDemand });
      if (rebuilt && (!rebuiltFooter || rebuilt.append(rebuiltFooter))) {
        return finish({ page: rebuilt, continuationPages, more, included: trimmedIncluded, onDemand: trimmedOnDemand, flowIndex, firstChunk, policy });
      }
    }
    // Even with no policy the footer did not fit: shrink the flow prefix.
  }

  // Defensive fallback (unreachable for real inputs): page 1 carries no policy
  // and every policy section is an on-demand pointer.
  const continuationPages = packChunks(flowChunks, budget);
  const noPolicy = policy.map(toPointer);
  const footer = buildFooter({ more: continuationPages.map((_, i) => i + 2), pageCommand, onDemand: noPolicy });
  const page = assemblePage(core, flowChunks, 0, [], budget);
  if (footer && page) page.append(footer);
  return finish({ page: page ?? pageBuilder(budget), continuationPages, more: continuationPages.map((_, i) => i + 2), included: [], onDemand: noPolicy, flowIndex: 0, firstChunk, policy });
}

function finish({ page, continuationPages, more, included, onDemand, flowIndex, firstChunk, policy }) {
  const placement = new Map();
  for (const [id, start] of firstChunk) {
    placement.set(id, start < flowIndex ? 1 : 2 + (start - flowIndex));
  }
  const includedIds = new Set(included.map((s) => s.id));
  for (const section of policy) placement.set(section.id, includedIds.has(section.id) ? 1 : null);
  return {
    pages: [page.text, ...continuationPages],
    more,
    onDemand,
    included: included.map(toPointer),
    placement,
  };
}
