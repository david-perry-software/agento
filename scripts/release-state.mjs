// Release-wait decision core for `agento.mjs release`: pure functions over facts
// already fetched from the GitHub REST API. No I/O, no clocks — `now` is passed in.

// GitHub workflow filter glob → RegExp. A leading `!` is stripped and reported as
// `negated` on the returned RegExp.
export function globToRegExp(pattern) {
  const negated = pattern.startsWith("!");
  const body = negated ? pattern.slice(1) : pattern;
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "*") {
      if (body[i + 1] === "*") {
        if (body[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "+") out += "+";
    else if (ch === "[") {
      const close = body.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        out += body.slice(i, close + 1);
        i = close;
      }
    } else out += ch.replace(/[.^$|(){}\\/]/g, "\\$&");
  }
  let re;
  try {
    re = new RegExp(`^${out}$`);
  } catch {
    re = new RegExp(`^${body.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
  }
  re.negated = negated;
  return re;
}

// GitHub's rule for filter lists: the last matching pattern wins, `!` patterns exclude.
export function matchesFilter(patterns, value) {
  let matched = false;
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    if (re.test(value)) matched = !re.negated;
  }
  return matched;
}

const FILTER_KEYS = { branches: "branches", "branches-ignore": "branchesIgnore", paths: "paths", "paths-ignore": "pathsIgnore", tags: "tags", "tags-ignore": "tagsIgnore" };
const EMPTY_VALUES = new Set(["", "null", "~", "{}"]);

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
const indentOf = (line) => line.length - line.trimStart().length;

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

function flowList(text) {
  const inner = text.trim();
  if (!inner.startsWith("[") || !inner.endsWith("]")) return null;
  const body = inner.slice(1, -1).trim();
  return body ? body.split(",").map(unquote) : [];
}

// Small line-based reader for a workflow's `on:` key. Anything outside the
// supported forms sets `unparsed: true`; callers then assume the workflow runs.
export function parseWorkflowTriggers(yamlText) {
  const result = { push: null, dispatch: false, unparsed: false };
  const unparsed = () => ({ ...result, push: null, unparsed: true });
  const lines = String(yamlText ?? "").split(/\r?\n/).map(stripComment);
  const start = lines.findIndex((l) => /^(?:on|"on"|'on'):/.test(l));
  if (start === -1) return unparsed();
  const inline = lines[start].replace(/^(?:on|"on"|'on'):/, "").trim();
  const emptyPush = () => ({ branches: null, branchesIgnore: null, paths: null, pathsIgnore: null, tags: null, tagsIgnore: null });
  const addEvent = (name) => {
    if (name === "push") result.push = emptyPush();
    else if (name === "workflow_dispatch") result.dispatch = true;
  };

  if (inline) {
    const list = flowList(inline);
    if (list) list.forEach(addEvent);
    else if (/^[A-Za-z_]+$/.test(inline)) addEvent(inline);
    else return unparsed();
    return result;
  }

  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  if (!block.length) return unparsed();
  const eventIndent = indentOf(block[0]);

  for (let i = 0; i < block.length; i += 1) {
    const line = block[i];
    const indent = indentOf(line);
    if (indent < eventIndent) return unparsed();
    if (indent > eventIndent) continue;
    const text = line.trim();
    const item = text.match(/^-\s+(.+)$/);
    if (item) {
      addEvent(unquote(item[1]));
      continue;
    }
    const entry = text.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!entry) return unparsed();
    const [, name, value] = entry;
    if (name !== "push") {
      addEvent(name);
      continue;
    }
    result.push = emptyPush();
    if (!EMPTY_VALUES.has(value)) return unparsed();
    const children = [];
    while (i + 1 < block.length && indentOf(block[i + 1]) > eventIndent) children.push(block[++i]);
    if (!parsePushFilters(children, result.push)) return unparsed();
  }
  return result;
}

function parsePushFilters(children, push) {
  if (!children.length) return true;
  const keyIndent = indentOf(children[0]);
  let current = null;
  for (const line of children) {
    const indent = indentOf(line);
    const text = line.trim();
    const item = text.match(/^-\s+(.+)$/);
    if (item && current && indent >= keyIndent) {
      push[current].push(unquote(item[1]));
      continue;
    }
    if (indent !== keyIndent) return false;
    const entry = text.match(/^([a-z-]+):\s*(.*)$/);
    if (!entry || !Object.hasOwn(FILTER_KEYS, entry[1])) return false;
    current = FILTER_KEYS[entry[1]];
    if (entry[2]) {
      const list = flowList(entry[2]);
      push[current] = list ?? [unquote(entry[2])];
      current = null;
    } else push[current] = [];
  }
  return true;
}

// Whether a push to `branch` starts the workflow, ignoring path filters.
export function branchTriggered(push, branch) {
  if (!push) return false;
  if (push.branches) return matchesFilter(push.branches, branch);
  if (push.branchesIgnore) return !matchesFilter(push.branchesIgnore, branch);
  // Only tag filters defined: branch pushes do not trigger the workflow.
  return !(push.tags || push.tagsIgnore);
}

// Whether pushing `files` to `branch` starts the workflow. Unknown workflow shape
// or a truncated file list errs toward "triggered".
export function pushTriggered({ triggers, branch, files = [], filesTruncated = false }) {
  if (!triggers || triggers.unparsed) return true;
  const { push } = triggers;
  if (!branchTriggered(push, branch)) return false;
  if (filesTruncated) return true;
  if (push.paths) return files.some((file) => matchesFilter(push.paths, file));
  if (push.pathsIgnore) return files.some((file) => !matchesFilter(push.pathsIgnore, file));
  return true;
}
