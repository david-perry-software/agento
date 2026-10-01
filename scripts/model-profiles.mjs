// Model profiles: pure helpers behind `agento.mjs models`. A profile names the model
// each Agento agent and built-in-agent prompt pins through its `model:` frontmatter
// line; the CLI rewrites the plugin clone from the resolved targets.

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

export const AGENT_ALIASES = {
  planner: "delivery-planner.agent.md",
  builder: "delivery-builder.agent.md",
  reviewer: "delivery-reviewer.agent.md",
  autopilot: "delivery-autopilot.agent.md",
  mechanic: "copilot-mechanic.agent.md",
  architect: "initiative-architect.agent.md",
};

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
    return { profiles: {}, errors: [`invalid JSON: ${error.message}`] };
  }
  if (!isObject(data)) return { profiles: {}, errors: ["top level must be an object with a `profiles` key"] };
  const errors = [];
  for (const key of Object.keys(data)) if (key !== "profiles") errors.push(`unknown top-level key ${JSON.stringify(key)}`);
  if (!isObject(data.profiles)) return { profiles: {}, errors: [...errors, "`profiles` must be an object"] };
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
  return { profiles: data.profiles, errors };
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

export function frontmatterField(text, key) {
  const fm = frontmatter(text);
  if (!fm) return null;
  const line = fm.lines.slice(1, fm.end).find((l) => l.startsWith(`${key}:`));
  if (line === undefined) return null;
  const raw = line.slice(key.length + 1).replace(/\r$/, "").trim();
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

const BUILT_IN_AGENT = "agent";

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
  const promptEntries = profile.prompts ?? {};
  const known = new Set(prompts.map((p) => p.name));
  for (const key of Object.keys(promptEntries)) {
    if (!known.has(key)) errors.push(`prompts.${key}: no prompt named ${JSON.stringify(key)} in .github/prompts`);
  }
  for (const prompt of prompts) {
    const custom = prompt.agent && prompt.agent !== BUILT_IN_AGENT && byName.has(prompt.agent);
    if (custom) {
      if (Object.hasOwn(promptEntries, prompt.name)) errors.push(`prompts.${prompt.name}: runs on ${prompt.agent} and inherits its model; set the agent's model instead`);
      targets.push({ file: prompt.file, value: byName.get(prompt.agent) });
    } else {
      targets.push({ file: prompt.file, value: promptEntries[prompt.name] ?? fallback });
    }
  }
  return { targets, errors };
}
