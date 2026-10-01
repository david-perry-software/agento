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
