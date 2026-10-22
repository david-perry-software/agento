// Model profiles: pure helpers behind `agento.mjs models`. A profile names the model
// each Agento agent and built-in-agent prompt pins through its `model:` frontmatter
// line; the CLI rewrites the plugin clone from the resolved targets.

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const PROFILE_NAME = /^[a-z0-9-]+$/;
const PROFILE_KEYS = new Set(["description", "default", "agents", "prompts"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

export function profilesFile(env = process.env, home = os.homedir()) {
  if (env.AGENTO_CONFIG_HOME) return path.join(env.AGENTO_CONFIG_HOME, "model-profiles.json");
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "agento", "model-profiles.json");
}

// The per-window-role assignment file lives beside the profiles file, so the same
// AGENTO_CONFIG_HOME / XDG / home resolution applies; only the name differs.
export function rolesFile(env = process.env, home = os.homedir()) {
  return path.join(path.dirname(profilesFile(env, home)), "model-roles.json");
}

export const AGENT_ALIASES = {
  planner: "delivery-planner.agent.md",
  builder: "delivery-builder.agent.md",
  reviewer: "delivery-reviewer.agent.md",
  autopilot: "delivery-autopilot.agent.md",
  mechanic: "copilot-mechanic.agent.md",
  architect: "initiative-architect.agent.md",
};

// The profiles file as written to disk: 2-space-indented JSON plus a trailing
// newline. Key order is insertion order, so it is preserved across a rewrite.
export function serializeProfiles(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

// The roles file on disk: the same stable serializer as the profiles file. Hashing
// reuses `profilesHash`.
export function serializeRoles(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

// The two window buckets: primary (the clone's file pins) and secondary (the
// per-window-role profile for plan, build, and freehand windows).
export const ROLE_BUCKETS = ["primary", "secondary"];

// Maps a window role to the profile bucket it reads. plan, build, and freehand are
// secondary windows; primary, unmanaged, and anything else are primary (Q5).
export function roleBucket(windowRole) {
  return windowRole === "plan" || windowRole === "build" || windowRole === "freehand" ? "secondary" : "primary";
}

// The sha256 hex digest of a file's bytes, used for `--expect` compare-and-swap.
export function profilesHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The `copilotModels` value rules, applied to a picker name and a Copilot model id
// independently: each must be a non-empty string with no `<`/`>` placeholder and no
// control character. Returns an array of error strings (empty when both are valid).
export function aliasErrors(picker, id) {
  const errors = [];
  for (const [value, label] of [[picker, "alias picker"], [id, "Copilot model id"]]) {
    if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
    else if (/[<>]/.test(value)) errors.push(`${label}: ${JSON.stringify(value)} must not contain a placeholder`);
    else if (CONTROL.test(value)) errors.push(`${label}: ${JSON.stringify(value)} must not contain a control character`);
  }
  return errors;
}

// Pure mutation helpers. Each takes the parsed file object
// `{ profiles, copilotModels? }` and returns a new object with the change applied;
// the input is never mutated. They handle structure only: callers check that names
// exist or are free, so a helper cannot fail halfway.

// Appends `name` last. With `from`, the new profile is a deep copy of that profile;
// with `description`, that value is set or overrides a copied one; otherwise `{}`.
export function createProfile(data, name, { from, description } = {}) {
  const source = from === undefined || from === null ? {} : data.profiles[from] ?? {};
  const body = structuredClone(source);
  if (description !== undefined) body.description = description;
  const profiles = { ...data.profiles };
  profiles[name] = body;
  return { ...data, profiles };
}

// Replaces a profile's body in place, keeping its position.
export function replaceProfile(data, name, body) {
  const profiles = { ...data.profiles };
  profiles[name] = structuredClone(body);
  return { ...data, profiles };
}

// Rebuilds `profiles` with the same order and the key swapped.
export function renameProfile(data, old, next) {
  const profiles = {};
  for (const [key, value] of Object.entries(data.profiles)) {
    profiles[key === old ? next : key] = value;
  }
  return { ...data, profiles };
}

export function deleteProfile(data, name) {
  const profiles = { ...data.profiles };
  delete profiles[name];
  return { ...data, profiles };
}

// Inserts or updates a `copilotModels` entry in place, creating the map when absent.
export function setAlias(data, picker, id) {
  const copilotModels = { ...(data.copilotModels ?? {}) };
  copilotModels[picker] = id;
  return { ...data, copilotModels };
}

// Removes one entry and leaves an empty `copilotModels: {}` in place.
export function removeAlias(data, picker) {
  const copilotModels = { ...(data.copilotModels ?? {}) };
  delete copilotModels[picker];
  return { ...data, copilotModels };
}

function valueErrors(value, where) {
  const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (!strings) return [`${where}: must be a model name or a non-empty list of model names`];
  if (!strings.length) return [`${where}: must not be an empty list`];
  const errors = [];
  for (const s of strings) {
    if (typeof s !== "string" || !s.trim()) errors.push(`${where}: model names must be non-empty strings`);
    else if (/[<>]/.test(s)) errors.push(`${where}: placeholder ${JSON.stringify(s)} must be replaced with a model name`);
    else if (CONTROL.test(s)) errors.push(`${where}: ${JSON.stringify(s)} contains a control character`);
  }
  return errors;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Errors are strings prefixed with the JSON path; `profiles.<name>…` ones belong to
// that profile alone (errorsFor), every other one invalidates the whole file.
export function parseProfiles(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { profiles: {}, copilotModels: {}, errors: [`invalid JSON: ${error.message}`] };
  }
  if (!isObject(data)) return { profiles: {}, copilotModels: {}, errors: ["top level must be an object with a `profiles` key"] };
  const errors = [];
  for (const key of Object.keys(data)) if (key !== "profiles" && key !== "copilotModels") errors.push(`unknown top-level key ${JSON.stringify(key)}`);
  // An optional top-level map of qualified picker name → Copilot `task` model id
  // (bare id for Copilot-hosted models, `<vendor>/<id>` for BYOK). Every value is
  // validated like a model name; an unknown shape invalidates the whole file.
  const copilotModels = {};
  if (data.copilotModels !== undefined) {
    if (!isObject(data.copilotModels)) {
      errors.push("`copilotModels` must be an object mapping a qualified picker name to a Copilot model id");
    } else {
      for (const [picker, id] of Object.entries(data.copilotModels)) {
        if (typeof id !== "string" || !id.trim()) errors.push(`copilotModels.${picker}: Copilot model ids must be non-empty strings`);
        else if (/[<>]/.test(id)) errors.push(`copilotModels.${picker}: placeholder ${JSON.stringify(id)} must be replaced with a model id`);
        else if (CONTROL.test(id)) errors.push(`copilotModels.${picker}: ${JSON.stringify(id)} contains a control character`);
        else copilotModels[picker] = id;
      }
    }
  }
  if (!isObject(data.profiles)) return { profiles: {}, copilotModels, errors: [...errors, "`profiles` must be an object"] };
  for (const [name, profile] of Object.entries(data.profiles)) {
    const at = `profiles.${name}`;
    if (!PROFILE_NAME.test(name)) {
      errors.push(`${at}: profile names must match [a-z0-9-]+`);
      continue;
    }
    if (!isObject(profile)) {
      errors.push(`${at}: must be an object`);
      continue;
    }
    for (const key of Object.keys(profile)) if (!PROFILE_KEYS.has(key)) errors.push(`${at}: unknown key ${JSON.stringify(key)}`);
    if (profile.description !== undefined && typeof profile.description !== "string") errors.push(`${at}.description: must be a string`);
    if (profile.default !== undefined) errors.push(...valueErrors(profile.default, `${at}.default`));
    for (const section of ["agents", "prompts"]) {
      if (profile[section] === undefined) continue;
      if (!isObject(profile[section])) {
        errors.push(`${at}.${section}: must be an object`);
        continue;
      }
      for (const [key, value] of Object.entries(profile[section])) {
        if (section === "agents" && !Object.hasOwn(AGENT_ALIASES, key)) errors.push(`${at}.agents: unknown agent alias ${JSON.stringify(key)}; known: ${Object.keys(AGENT_ALIASES).join(", ")}`);
        else if (section === "prompts" && !PROFILE_NAME.test(key)) errors.push(`${at}.prompts: prompt names must match [a-z0-9-]+, got ${JSON.stringify(key)}`);
        else errors.push(...valueErrors(value, `${at}.${section}.${key}`));
      }
    }
  }
  return { profiles: data.profiles, copilotModels, errors };
}

// The roles file is `{ "secondary": <profile-name|null> }`. The only allowed key is
// `secondary`; its value is a profile name ([a-z0-9-]+) or null (role off). Any
// other key or bad value is an error; an absent key means the secondary role is off.
export function parseRoles(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { secondary: null, errors: [`invalid JSON: ${error.message}`] };
  }
  if (!isObject(data)) return { secondary: null, errors: ["top level must be an object with a `secondary` key"] };
  const errors = [];
  for (const key of Object.keys(data)) if (key !== "secondary") errors.push(`unknown top-level key ${JSON.stringify(key)}`);
  let secondary = null;
  if (data.secondary !== undefined && data.secondary !== null) {
    if (typeof data.secondary !== "string" || !PROFILE_NAME.test(data.secondary)) {
      errors.push("`secondary` must be a profile name matching [a-z0-9-]+ or null");
    } else {
      secondary = data.secondary;
    }
  }
  return { secondary, errors };
}

export function errorsFor(errors, name) {
  return errors.filter((e) => !e.startsWith("profiles.") || e.startsWith(`profiles.${name}.`) || e.startsWith(`profiles.${name}:`));
}

// Lines split on "\n" keep their "\r"; `end` is the index of the closing `---`.
function frontmatter(text) {
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.replace(/\r$/, "") === "---");
  return end > 0 ? { lines, end } : null;
}

function parseScalar(raw) {
  const value = raw.replace(/\r$/, "").trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function frontmatterField(text, key) {
  const fm = frontmatter(text);
  if (!fm) return null;
  const line = fm.lines.slice(1, fm.end).find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return null;
  return parseScalar(line.slice(key.length + 1));
}

const BUILT_IN_AGENT = "agent";

// A prompt is pinnable — a profile can set `prompts.<command>` — unless it runs on
// a custom agent known by `name:` (`agentNames` is the set of agent `name:` values);
// such a prompt inherits its agent's model instead. `resolveTargets` applies exactly
// this rule, so the two cannot drift.
export function isPinnablePrompt(prompt, agentNames) {
  return !(prompt.agent && prompt.agent !== BUILT_IN_AGENT && agentNames.has(prompt.agent));
}

// agents: [{ file, name }] (`name:` of each agent file); prompts: [{ file, name, agent }]
// with `name` the command name and `agent` its `agent:` value or null. Returns one
// target per agent and prompt; value null means "no model: line".
export function resolveTargets({ profile, agents, prompts }) {
  const errors = [];
  const fallback = profile.default ?? null;
  const aliasOf = Object.fromEntries(Object.entries(AGENT_ALIASES).map(([alias, file]) => [file, alias]));
  const byName = new Map();
  const targets = [];
  for (const agent of agents) {
    const alias = aliasOf[path.basename(agent.file)];
    const value = (alias && profile.agents?.[alias]) ?? fallback;
    if (agent.name) byName.set(agent.name, value);
    targets.push({ file: agent.file, value });
  }
  const handoffValue = (name) => {
    const value = byName.get(name) ?? null;
    return Array.isArray(value) ? value[0] : value;
  };
  const handoffs = {};
  for (const agent of agents) {
    if (!agent.handoffs?.length) continue;
    handoffs[agent.file] = agent.handoffs.map((name) => ({ target: name, value: handoffValue(name) }));
  }
  const promptEntries = profile.prompts ?? {};
  const known = new Set(prompts.map((p) => p.name));
  for (const key of Object.keys(promptEntries)) {
    if (!known.has(key)) errors.push(`prompts.${key}: no prompt named ${JSON.stringify(key)} in .github/prompts`);
  }
  for (const prompt of prompts) {
    const custom = !isPinnablePrompt(prompt, byName);
    if (custom) {
      if (Object.hasOwn(promptEntries, prompt.name)) errors.push(`prompts.${prompt.name}: runs on ${prompt.agent} and inherits its model; set the agent's model instead`);
      targets.push({ file: prompt.file, value: byName.get(prompt.agent) });
    } else {
      targets.push({ file: prompt.file, value: promptEntries[prompt.name] ?? fallback });
    }
  }
  return { targets, handoffs, errors };
}

export function renderModel(value) {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? `model: [${value.map((v) => JSON.stringify(v)).join(", ")}]` : `model: ${JSON.stringify(value)}`;
}

// The full expected per-file state `readModel` returns: the top-level model line
// plus one line per handoff pin, in handoff order.
export function renderFileModel(value, handoffs) {
  const parts = [];
  const top = renderModel(value);
  if (top !== null) parts.push(top);
  for (const { value: handoff } of handoffs ?? []) {
    if (handoff !== null) parts.push(renderModel(handoff));
  }
  return parts.length ? parts.join("\n") : null;
}

// A top-level key's block: its line plus following indented or `- ` continuation lines.
function blockEnd(lines, start, end) {
  let i = start + 1;
  while (i < end && /^([ \t]|-( |\r?$))/.test(lines[i])) i += 1;
  return i;
}

function keyBlocks(lines, end, key) {
  const blocks = [];
  for (let i = 1; i < end; i += 1) {
    if (lines[i].startsWith(`${key}:`)) blocks.push([i, blockEnd(lines, i, end)]);
  }
  return blocks;
}

// Each `handoffs:` list item: `- label:` then indented `agent:`, `prompt:`,
// `send:` keys. Returns [{ target, indent, modelLine, lastKey }] in file order;
// `modelLine` is the item's nested `model:` line index (-1 when absent) and
// `lastKey` the item's last key line (the insertion point for a new pin).
function handoffItems(lines, end) {
  const [block] = keyBlocks(lines, end, "handoffs");
  if (!block) return [];
  const spans = [];
  let start = -1;
  for (let i = block[0] + 1; i < block[1]; i += 1) {
    if (/^\s*-( |\r?$)/.test(lines[i])) {
      if (start !== -1) spans.push([start, i]);
      start = i;
    }
  }
  if (start !== -1) spans.push([start, block[1]]);
  return spans.map(([from, to]) => {
    let indent = null;
    let target = null;
    let modelLine = -1;
    let lastKey = from;
    for (let i = from + 1; i < to; i += 1) {
      const m = lines[i].match(/^(\s*)([A-Za-z][\w-]*):(.*\r?)$/);
      if (!m) continue;
      if (indent === null) indent = m[1];
      if (m[2] === "agent") target = parseScalar(m[3]);
      else if (m[2] === "model") modelLine = i;
      lastKey = i;
    }
    return { target, indent: indent ?? "    ", modelLine, lastKey };
  });
}

// The agent names a file's `handoffs:` items target, in file order.
export function handoffTargets(text) {
  const fm = frontmatter(text);
  if (!fm) return [];
  return handoffItems(fm.lines, fm.end).map((item) => item.target);
}

// Each handoff item's target and its nested pin normalized to `model: <value>`
// (null when the item carries none), in file order.
export function handoffModelLines(text) {
  const fm = frontmatter(text);
  if (!fm) return [];
  return handoffItems(fm.lines, fm.end).map((item) => ({
    target: item.target,
    line: item.modelLine === -1 ? null : `model: ${fm.lines[item.modelLine].slice(item.indent.length + "model:".length).replace(/\r$/, "").trim()}`,
  }));
}

// The current per-file state: the top-level `model:` block (continuation lines
// joined by "\n", "\r" stripped) plus each handoff item's nested `model:` line,
// normalized to `model: <value>`; null when nothing is pinned.
export function readModel(text) {
  const fm = frontmatter(text);
  if (!fm) return null;
  const parts = [];
  const [block] = keyBlocks(fm.lines, fm.end, "model");
  if (block) parts.push(fm.lines.slice(block[0], block[1]).map((l) => l.replace(/\r$/, "")).join("\n"));
  for (const item of handoffItems(fm.lines, fm.end)) {
    if (item.modelLine === -1) continue;
    const raw = fm.lines[item.modelLine].slice(item.indent.length + "model:".length).replace(/\r$/, "");
    parts.push(`model: ${raw.trim()}`);
  }
  return parts.length ? parts.join("\n") : null;
}

// Leaves exactly one `model:` line (none for null): replaced in place, else inserted
// after `argument-hint:`, else after `description:`, else before the closing `---`.
// Every other byte is unchanged; the inserted line copies the first line's ending.
export function setModel(text, value) {
  const fm = frontmatter(text);
  const line = renderModel(value);
  if (!fm) {
    if (line === null) return text;
    throw new Error("no leading --- frontmatter block to carry a model: line");
  }
  const { lines } = fm;
  const cr = lines[0].endsWith("\r") ? "\r" : "";
  const blocks = keyBlocks(lines, fm.end, "model");
  let at;
  if (blocks.length) at = blocks[0][0];
  else {
    const anchor = keyBlocks(lines, fm.end, "argument-hint")[0] ?? keyBlocks(lines, fm.end, "description")[0];
    at = anchor ? anchor[1] : fm.end;
  }
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === at && line !== null) out.push(line + cr);
    if (blocks.some(([s, e]) => i >= s && i < e)) continue;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// Sets the nested `model:` line of each `handoffs:` list item. `values` is either
// null (remove every handoff pin) or an array of `{ target, value }` — the value
// for the item whose `agent:` is `target`, null to remove it; unknown targets are
// left untouched. A line is replaced in place, else inserted after the item's last
// key at the item's key indentation; CRLF and every other byte are preserved.
export function setHandoffModels(text, values) {
  const fm = frontmatter(text);
  if (!fm) return text;
  const { lines } = fm;
  const items = handoffItems(lines, fm.end);
  if (!items.length) return text;
  const cr = lines[0].endsWith("\r") ? "\r" : "";
  const insertions = new Map();
  const deletions = new Set();
  for (const item of items) {
    const entry = values === null ? { value: null } : values?.find((e) => e.target === item.target);
    if (entry === undefined) continue;
    const line = renderModel(entry.value);
    if (line === null) {
      if (item.modelLine !== -1) deletions.add(item.modelLine);
    } else if (item.modelLine !== -1) {
      deletions.add(item.modelLine);
      insertions.set(item.modelLine, [item.indent + line + cr]);
    } else {
      const at = item.lastKey + 1;
      if (!insertions.has(at)) insertions.set(at, []);
      insertions.get(at).push(item.indent + line + cr);
    }
  }
  if (!insertions.size && !deletions.size) return text;
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const inserts = insertions.get(i);
    if (inserts) out.push(...inserts);
    if (deletions.has(i)) continue;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// profiles: [{ name, targets: [{ file, value }] }] (resolved, valid ones, in file
// order); current: { [file]: readModel(text) }. null when nothing is pinned, the
// first profile whose rendering matches every file, else "custom".
export function detectActive({ profiles, current }) {
  if (Object.values(current).every((line) => line === null)) return null;
  const match = profiles.find(({ targets, handoffs }) => targets.length > 0 && Object.keys(current).every((file) => {
    const target = targets.find((t) => t.file === file);
    const expected = target ? renderFileModel(target.value, handoffs?.[file]) : null;
    return expected === current[file];
  }));
  return match ? match.name : "custom";
}

// True when a working file differs from its committed bytes beyond its model: lines
// (the top-level pin and every handoff pin); skip-worktree would hide such edits,
// so apply refuses them.
export function differsBeyondModel(headText, workText) {
  return stripModels(headText) !== stripModels(workText);
}

function stripModels(text) {
  return setHandoffModels(setModel(text, null), null);
}

// The parsed top-level `model:` value: a string, a list, or null when unpinned.
export function parseModelValue(text) {
  const fm = frontmatter(text);
  if (!fm) return null;
  const [block] = keyBlocks(fm.lines, fm.end, "model");
  if (!block) return null;
  const raw = fm.lines.slice(block[0], block[1]).map((l) => l.replace(/\r$/, "")).join("\n").slice("model:".length).trim();
  if (raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}

// The vendor part of a qualified `<name> (<vendor>)` model name, else null.
export function vendorOf(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/\(([^()]+)\)\s*$/);
  return match ? match[1] : null;
}

// Decision 2 tier warning: when autopilot is pinned to a non-copilot (bring-your-
// own-key) vendor while builder or reviewer pins a copilot model, VS Code may
// refuse the higher-tier Copilot model. Returns the warning string, or null.
export function byokTierWarning({ autopilot, builder, reviewer }) {
  const first = (value) => (Array.isArray(value) ? value[0] : value);
  const autopilotPin = first(autopilot ?? null);
  const autopilotVendor = autopilotPin ? vendorOf(autopilotPin) : null;
  if (!autopilotVendor || autopilotVendor === "copilot") return null;
  const delegates = [];
  for (const [alias, value] of [["builder", builder], ["reviewer", reviewer]]) {
    const pin = first(value ?? null);
    if (pin && vendorOf(pin) === "copilot") delegates.push({ alias, pin });
  }
  if (!delegates.length) return null;
  const named = delegates.map((d) => `${d.alias} ${JSON.stringify(d.pin)}`).join(" and ");
  return `autopilot is pinned to ${JSON.stringify(autopilotPin)} (a bring-your-own-key model) but delegates to ${named} on a Copilot model; VS Code may refuse the higher-tier Copilot model — pin autopilot at least as high as the highest-tier model it delegates to, then re-apply`;
}

// Model values without a `(vendor)` suffix: `entries` is `[{ where, value }]` with a
// string or list value; each distinct bare value is named once with every place it
// is used. Returns the warning string, or null when every value is qualified.
export function unqualifiedWarning(entries) {
  const places = new Map();
  for (const { where, value } of entries) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string" || item === "" || vendorOf(item)) continue;
      if (!places.has(item)) places.set(item, []);
      if (!places.get(item).includes(where)) places.get(item).push(where);
    }
  }
  if (!places.size) return null;
  const named = [...places].map(([value, where]) => `${JSON.stringify(value)} (${where.join(", ")})`).join("; ");
  return `model values without a (vendor) suffix: ${named}; VS Code resolves an unqualified name only for some Copilot models and silently ignores it otherwise — use "<picker name> (<vendor>)", then re-apply`;
}

// Pinned agents whose first entry has no `copilotModels` alias: `entries` is
// `[{ alias, value }]` with a string or list value; `copilotModels` the parsed
// top-level map. Returns the warning string, or null when every pinned agent is
// aliased (or no map is defined).
export function missingAliasWarning(entries, copilotModels) {
  if (!copilotModels || !Object.keys(copilotModels).length) return null;
  const missing = [];
  for (const { alias, value } of entries) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first !== "" && !Object.hasOwn(copilotModels, first)) missing.push(`${alias} ${JSON.stringify(first)}`);
  }
  if (!missing.length) return null;
  return `agent pins without a Copilot alias: ${missing.join(" and ")}; add each picker name to the top-level copilotModels map so the Autopilot can pin Copilot subagents`;
}
