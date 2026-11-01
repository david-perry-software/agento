// The model-profiles machinery shared by the `models` command and the doctor
// `model-profile` check, moved unchanged from the legacy `scripts/agento.mjs`.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CLI_DIR, companionWorktreesDir, config, emit, git, primaryWorktreesDir, productWorktrees, roleCwd } from "./context.mjs";
import { gitRun } from "./git.mjs";
import { primaryCheckoutOf } from "./copilot.mjs";
import { cleanText } from "../model-filter.mjs";
import { deriveRole } from "../session-state.mjs";
import {
  AGENT_ALIASES,
  byokTierWarning,
  detectActive,
  differsBeyondModel,
  errorsFor,
  frontmatterField,
  handoffModelLines,
  handoffTargets,
  missingAliasWarning,
  parseModelValue,
  parseProfiles,
  parseRoles,
  profilesFile,
  profilesHash,
  readModel,
  resolveTargets,
  rolesFile,
  serializeProfiles,
  serializeRoles,
  setHandoffModels,
  setModel,
  unqualifiedWarning,
} from "../model-profiles.mjs";

// --- model profiles --------------------------------------------------------

const MODELS_HINT =
  "pins are applied by a local git filter (filter.agento-models) and survive pull, merge, switch, and stash; commits never contain them and linked worktrees inherit them; after an update adds agents or prompts (filter.unrecorded), re-run `models apply <name>`";

// The git clean/smudge filter that carries pins (scripts/model-filter.mjs): the
// script, its one import, and the per-file pin state live in <common-dir>/agento/,
// shared with every linked worktree through the common config and info/attributes.
const MODEL_FILTER = "agento-models";
const MODEL_FILTER_FILES = ["model-filter.mjs", "model-profiles.mjs"];
const MODEL_PINS_FILE = "model-pins.json";
const MODEL_ATTR_BEGIN = "# >>> agento model pins (managed by `agento.mjs models`) >>>";
const MODEL_ATTR_END = "# <<< agento model pins <<<";
const MODEL_ATTR_PATTERNS = ["/.github/agents/*.agent.md", "/.github/prompts/*.prompt.md", "/skills/agento/commands/*.md"];
const modelFilterCommand = (mode) => `node "$(git rev-parse --path-format=absolute --git-common-dir)/agento/model-filter.mjs" ${mode} %f`;

// null when git is at least 2.31 (`rev-parse --path-format`), else the reason.
function gitTooOld() {
  const version = git(process.cwd(), "--version").match(/(\d+)\.(\d+)/);
  if (!version) return "git --version is unreadable";
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major > 2 || (major === 2 && minor >= 31) ? null : `git ${version[1]}.${version[2]} is older than 2.31 (needed for rev-parse --path-format)`;
}

function modelCommonDir(pluginRoot) {
  return git(pluginRoot, "rev-parse", "--path-format=absolute", "--git-common-dir") || null;
}

function stripAttributeBlock(text) {
  const lines = text.split("\n");
  const begin = lines.indexOf(MODEL_ATTR_BEGIN);
  const end = lines.indexOf(MODEL_ATTR_END, begin);
  if (begin === -1 || end === -1) return text;
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
}

// records: { [file]: { model, handoffs } } for every target file (null when unpinned).
function installModelFilter(pluginRoot, records) {
  const common = modelCommonDir(pluginRoot);
  const dir = path.join(common, "agento");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of MODEL_FILTER_FILES) fs.copyFileSync(path.join(CLI_DIR, file), path.join(dir, file));
  fs.writeFileSync(path.join(dir, MODEL_PINS_FILE), `${JSON.stringify({ version: 1, files: records }, null, 2)}\n`);
  for (const [key, value] of [["clean", modelFilterCommand("clean")], ["smudge", modelFilterCommand("smudge")], ["required", "true"]]) {
    const set = gitRun(pluginRoot, ["config", "--local", `filter.${MODEL_FILTER}.${key}`, value]);
    if (!set.ok) throw new Error(`git config filter.${MODEL_FILTER}.${key}: ${set.stderr}`);
  }
  const attributes = path.join(common, "info", "attributes");
  const before = fs.existsSync(attributes) ? stripAttributeBlock(fs.readFileSync(attributes, "utf8")) : "";
  const block = [MODEL_ATTR_BEGIN, ...MODEL_ATTR_PATTERNS.map((p) => `${p} filter=${MODEL_FILTER}`), MODEL_ATTR_END].join("\n");
  fs.mkdirSync(path.dirname(attributes), { recursive: true });
  fs.writeFileSync(attributes, `${before === "" || before.endsWith("\n") ? before : `${before}\n`}${block}\n`);
}

// Removes the config section, the attribute block (other lines stay), and the state
// directory; needs no filter script, so it also repairs a broken install.
function removeModelFilter(pluginRoot) {
  const common = modelCommonDir(pluginRoot);
  if (!common) return;
  if (git(pluginRoot, "config", "--local", "--get-regexp", `^filter\\.${MODEL_FILTER}\\.`)) gitRun(pluginRoot, ["config", "--local", "--remove-section", `filter.${MODEL_FILTER}`]);
  const attributes = path.join(common, "info", "attributes");
  if (fs.existsSync(attributes)) {
    const text = fs.readFileSync(attributes, "utf8");
    const after = stripAttributeBlock(text);
    if (after !== text) {
      if (after.trim() === "") fs.rmSync(attributes);
      else fs.writeFileSync(attributes, after);
    }
  }
  fs.rmSync(path.join(common, "agento"), { recursive: true, force: true });
}

// The files a profile rewrites, relative to the plugin root: every agent, every
// prompt, and each prompt's skills/agento/commands/<name>.md mirror (what plugin
// mode reads).
function modelTargetFiles(pluginRoot) {
  const list = (rel, suffix) => {
    const dir = path.join(pluginRoot, rel);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).sort().map((f) => `${rel}/${f}`) : [];
  };
  const read = (file) => fs.readFileSync(path.join(pluginRoot, file), "utf8");
  const agents = list(".github/agents", ".agent.md").map((file) => ({ file, name: frontmatterField(read(file), "name"), handoffs: handoffTargets(read(file)) }));
  const prompts = list(".github/prompts", ".prompt.md").map((file) => ({ file, name: path.basename(file, ".prompt.md"), agent: frontmatterField(read(file), "agent") }));
  const mirrors = {};
  for (const prompt of prompts) {
    const mirror = `skills/agento/commands/${prompt.name}.md`;
    if (fs.existsSync(path.join(pluginRoot, mirror))) mirrors[prompt.file] = mirror;
  }
  const files = [...agents.map((a) => a.file), ...prompts.flatMap((p) => (mirrors[p.file] ? [p.file, mirrors[p.file]] : [p.file]))];
  return { agents, prompts, mirrors, files };
}

function loadProfiles() {
  const file = profilesFile();
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, "utf8") : null;
  if (!exists) return { profilesFile: { path: file, exists, hash: null }, raw, profiles: {}, copilotModels: {}, errors: [] };
  const { profiles, copilotModels, errors } = parseProfiles(raw);
  return { profilesFile: { path: file, exists, hash: profilesHash(raw) }, raw, profiles, copilotModels, errors };
}

// The roles file: `{ secondary: <profile-name|null> }` beside the profiles file.
// An absent file means the secondary role is off; an unparseable one keeps `errors`
// non-empty while the callers fall back to file pins and warn.
function loadRoles() {
  const file = rolesFile();
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, "utf8") : null;
  if (!exists) return { rolesFile: { path: file, exists, hash: null }, raw, secondary: null, errors: [] };
  const { secondary, errors } = parseRoles(raw);
  return { rolesFile: { path: file, exists, hash: profilesHash(raw) }, raw, secondary, errors };
}

// The errors a candidate file would report for `name`: the re-parsed errors that
// belong to `name` (or are file-level) plus the layout errors from resolveTargets.
function candidateErrors(loaded, next, name, layout) {
  const reparsed = parseProfiles(serializeProfiles(next));
  const candidate = { ...loaded, profiles: next.profiles, copilotModels: next.copilotModels ?? loaded.copilotModels ?? {}, errors: reparsed.errors };
  return resolveProfile(candidate, name, layout).errors;
}

// The full new profiles-file object for a write: the existing file's top-level key
// order is preserved, and an existing `copilotModels` key is kept even when empty.
// A brand-new file puts `profiles` first; an alias write to a file without
// `copilotModels` appends it after `profiles`. `loaded.raw` is only consulted for
// key order — `writeProfiles` re-reads and re-validates the bytes before writing.
function nextProfilesObject(loaded, profiles, copilotModels) {
  if (loaded.raw !== null) {
    try {
      const base = JSON.parse(loaded.raw);
      const next = { ...base };
      next.profiles = profiles;
      if (Object.hasOwn(base, "copilotModels") || Object.keys(copilotModels ?? {}).length) next.copilotModels = copilotModels;
      return next;
    } catch {
      // Unparseable raw is refused by writeProfiles before anything is written.
    }
  }
  const next = { profiles };
  if (Object.keys(copilotModels ?? {}).length) next.copilotModels = copilotModels;
  return next;
}

// The atomic, validated write of the profiles file. `loaded` is the snapshot the
// caller read; `next` the full new file object ({ profiles, copilotModels });
// `names` the profiles this write is responsible for (their re-parsed errors block
// the write). Returns { code, result } ready to emit.
function writeProfiles(pluginRoot, loaded, next, { expect, names = [] } = {}) {
  const file = loaded.profilesFile.path;
  const before = modelsState(pluginRoot, loaded);
  const currentRaw = loaded.profilesFile.exists ? fs.readFileSync(file, "utf8") : null;
  const actual = currentRaw === null ? null : profilesHash(currentRaw);
  const conflict = (message, expected) => ({ code: 3, result: { status: "conflict", message, expected, actual, ...modelsReport(pluginRoot, loaded, before) } });
  // 1. The file must still be what the caller read; --expect must match it. An
  //    absent file never matches an --expect value.
  if (currentRaw !== loaded.raw) return conflict("the profiles file changed since it was read; re-read it and re-run", loaded.profilesFile.hash);
  if (expect !== undefined && expect !== null && (currentRaw === null || actual !== expect)) return conflict("the profiles file does not match --expect; re-read profilesFile.hash and re-run", expect);
  // 2. Refuse a current file with file-level errors.
  const fileErrors = loaded.errors.filter((e) => !e.startsWith("profiles."));
  if (fileErrors.length) return { code: 3, result: { status: "invalid", errors: fileErrors, message: "the profiles file has errors and was left untouched", ...modelsReport(pluginRoot, loaded, before) } };
  // 3. Serialize and re-parse: no new file-level errors and none for the written names.
  const reparsed = parseProfiles(serializeProfiles(next));
  const writtenErrors = reparsed.errors.filter((e) => !e.startsWith("profiles.") || names.some((n) => e.startsWith(`profiles.${n}.`) || e.startsWith(`profiles.${n}:`)));
  if (writtenErrors.length) return { code: 3, result: { status: "invalid", errors: writtenErrors, message: "the new file would be invalid and was not written", ...modelsReport(pluginRoot, loaded, before) } };
  // 4. Atomic write: a temp file with the existing mode, fsynced, then renamed.
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const mode = loaded.profilesFile.exists ? fs.statSync(file).mode : 0o644;
  const tmp = path.join(dir, `.model-profiles.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, serializeProfiles(next), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return { code: 3, result: { status: "failed", message: `writing the profiles file failed: ${error.message}; re-send is safe`, ...modelsReport(pluginRoot, loaded, before) } };
  }
  let reformatted = false;
  if (currentRaw !== null) {
    try {
      reformatted = serializeProfiles(JSON.parse(currentRaw)) !== currentRaw;
    } catch {
      reformatted = true;
    }
  }
  const reloaded = loadProfiles();
  const after = modelsState(pluginRoot, reloaded);
  return { code: 0, result: { status: "ok", written: true, previousHash: loaded.profilesFile.hash, reformatted, activeBefore: before.active, active: after.active, ...modelsReport(pluginRoot, reloaded, after) } };
}

// The atomic, validated write of the roles file, mirroring writeProfiles. `loaded`
// is the snapshot `loadRoles` returned; `next` the full new file object
// ({ secondary }). Returns { code, result } ready to emit; a failed or refused
// write leaves the file byte-identical.
function writeRoles(loaded, next, { expect } = {}) {
  const file = loaded.rolesFile.path;
  const currentRaw = loaded.rolesFile.exists ? fs.readFileSync(file, "utf8") : null;
  const actual = currentRaw === null ? null : profilesHash(currentRaw);
  const conflict = (message, expected) => ({ code: 3, result: { status: "conflict", message, expected, actual } });
  // 1. The file must still be what the caller read; --expect must match it. An
  //    absent file never matches an --expect value.
  if (currentRaw !== loaded.raw) return conflict("the roles file changed since it was read; re-read it and re-run", loaded.rolesFile.hash);
  if (expect !== undefined && expect !== null && (currentRaw === null || actual !== expect)) return conflict("the roles file does not match --expect; re-read rolesFile.hash and re-run", expect);
  // 2. The roles file is CLI-owned (only `models use --role secondary`, `rename`,
  //    and `delete --force` write it) and this write is a full-file replacement, so
  //    a current file with errors is repaired here rather than refused — unlike the
  //    user-authored profiles file, which writeProfiles leaves untouched. Step 1 has
  //    already pinned the current bytes (no concurrent change) and honoured --expect,
  //    so the replacement is safe.
  // 3. Serialize and re-parse: no new errors.
  const reparsed = parseRoles(serializeRoles(next));
  if (reparsed.errors.length) return { code: 3, result: { status: "invalid", errors: reparsed.errors, message: "the new roles file would be invalid and was not written" } };
  // 4. Atomic write: a temp file with the existing mode, fsynced, then renamed.
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const mode = loaded.rolesFile.exists ? fs.statSync(file).mode : 0o644;
  const tmp = path.join(dir, `.model-roles.json.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, serializeRoles(next), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return { code: 3, result: { status: "failed", message: `writing the roles file failed: ${error.message}; re-send is safe` } };
  }
  const reloaded = loadRoles();
  return { code: 0, result: { status: "ok", written: true, previousHash: loaded.rolesFile.hash, roles: { secondary: reloaded.secondary }, rolesFile: reloaded.rolesFile, rolesErrors: reloaded.errors } };
}

// Resolved targets (mirrors included) plus every error that blocks applying `name`.
function resolveProfile(loaded, name, layout) {
  const parseErrors = errorsFor(loaded.errors, name);
  if (parseErrors.length) return { targets: [], handoffs: {}, errors: parseErrors };
  const { targets, handoffs, errors } = resolveTargets({ profile: loaded.profiles[name], agents: layout.agents, prompts: layout.prompts });
  const withMirrors = targets.flatMap((t) => (layout.mirrors[t.file] ? [t, { file: layout.mirrors[t.file], value: t.value }] : [t]));
  return { targets: withMirrors, handoffs, errors: errors.map((e) => `profiles.${name}.${e}`) };
}

function gitShowHead(pluginRoot, file) {
  try {
    return execFileSync("git", ["-C", pluginRoot, "show", `HEAD:./${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// The derived state every `models` verb reports: no journal, read from the files.
function modelsState(pluginRoot, loaded) {
  const layout = modelTargetFiles(pluginRoot);
  const texts = Object.fromEntries(layout.files.map((f) => [f, fs.readFileSync(path.join(pluginRoot, f), "utf8")]));
  const current = Object.fromEntries(layout.files.map((f) => [f, readModel(texts[f])]));
  const names = loaded.errors.some((e) => !e.startsWith("profiles.")) ? [] : Object.keys(loaded.profiles);
  const resolved = names.map((name) => ({ name, ...resolveProfile(loaded, name, layout) }));
  const active = detectActive({ profiles: resolved.filter((p) => !p.errors.length), current });
  const isGit = git(pluginRoot, "rev-parse", "--show-toplevel") !== "";
  let legacySkipWorktree = null;
  let tracked = new Set();
  let dirtyBeyondModel = [];
  let dirty = [];
  let heads = {};
  const filter = isGit ? modelFilterStatus(pluginRoot, layout.files) : null;
  if (isGit) {
    const entries = git(pluginRoot, "ls-files", "-v", "--", ...layout.files).split("\n").filter(Boolean);
    tracked = new Set(entries.map((l) => l.slice(2)));
    legacySkipWorktree = entries.filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
    heads = Object.fromEntries(layout.files.filter((f) => tracked.has(f)).map((f) => [f, gitShowHead(pluginRoot, f)]));
    dirtyBeyondModel = layout.files.filter((f) => heads[f] != null && differsBeyondModel(heads[f], texts[f]));
    // Under the filter a model: line that is not the recorded pin is a change git sees.
    const records = filter?.installed ? filter.records : null;
    dirty = layout.files.filter((f) => dirtyBeyondModel.includes(f) || (records && heads[f] != null && cleanText(texts[f], records[f] ?? null) !== heads[f]));
  }
  return { layout, texts, current, resolved, active, isGit, tracked, heads, legacySkipWorktree, dirtyBeyondModel, dirty, filter };
}

// Health of the installed filter; `records` (the per-file pins) is internal.
function modelFilterStatus(pluginRoot, files) {
  const common = modelCommonDir(pluginRoot);
  if (!common) return null;
  const dir = path.join(common, "agento");
  const stateFile = path.join(dir, MODEL_PINS_FILE);
  let records = null;
  let state = "missing";
  if (fs.existsSync(stateFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (data?.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) throw new Error("bad shape");
      records = data.files;
      state = "ok";
    } catch {
      state = "invalid";
    }
  }
  const config = ["clean", "smudge"].every((mode) => git(pluginRoot, "config", "--local", `filter.${MODEL_FILTER}.${mode}`) === modelFilterCommand(mode))
    && git(pluginRoot, "config", "--local", "--bool", `filter.${MODEL_FILTER}.required`) === "true";
  const attributesFile = path.join(common, "info", "attributes");
  const attributes = fs.existsSync(attributesFile) && fs.readFileSync(attributesFile, "utf8").split("\n").includes(MODEL_ATTR_BEGIN);
  const scriptCurrent = MODEL_FILTER_FILES.every((f) => {
    const copy = path.join(dir, f);
    return fs.existsSync(copy) && fs.readFileSync(copy).equals(fs.readFileSync(path.join(CLI_DIR, f)));
  });
  const pinned = records !== null && Object.values(records).some(hasPin);
  return {
    installed: config && attributes && state === "ok",
    config,
    attributes,
    state,
    stateFile,
    script: path.join(dir, "model-filter.mjs"),
    scriptCurrent,
    unrecorded: pinned ? files.filter((f) => !Object.hasOwn(records, f)) : [],
    records,
  };
}

const hasPin = (record) => (record?.model ?? null) !== null || (record?.handoffs ?? []).some((h) => (h.value ?? null) !== null);

// The value of a normalized `model: <raw>` handoff line.
function parsePinLine(line) {
  const raw = line.slice("model:".length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^["']|["']$/g, "");
  }
}

function modelsReport(pluginRoot, loaded, state) {
  const { records, ...filter } = state.filter ?? {};
  return {
    profilesFile: loaded.profilesFile,
    pluginRoot,
    active: state.active,
    legacySkipWorktree: state.legacySkipWorktree,
    // Alias of legacySkipWorktree for one release, for consumers that still read it.
    skipWorktree: state.legacySkipWorktree,
    filter: state.filter ? filter : null,
    dirty: state.dirty,
    hint: MODELS_HINT,
  };
}

// The window role of the current cwd, derived with the same inputs sessionContext
// uses and no gh/PR lookups. Any failure (outside a repository, an unreadable
// config, a missing worktree list) falls back to `unmanaged`, which maps to the
// primary bucket (today's file pins).
function currentWindowRole() {
  try {
    const worktrees = productWorktrees();
    const worktreesDir = primaryWorktreesDir(worktrees);
    const { role } = deriveRole({ cwd: roleCwd, worktrees, worktreesDir, config, env: process.env, companionWorktreesDir });
    return role;
  } catch {
    return "unmanaged";
  }
}

// The shared secondary-profile lookup for `models pins` and `models resolve`.
// Returns { profile, source, warnings, resolved }: `profile` is the active primary
// profile for file pins or the assigned secondary profile name; `source` is
// "role-profile" or "file-pins"; `warnings` the role warnings (dangling/invalid
// assignments and a broken roles file); `resolved` the assigned profile's
// resolveProfile result, or null. Both verbs default the role identically, so the
// two cannot drift.
function secondaryProfileLookup(loaded, loadedRoles, state, role) {
  const filePins = (warnings) => ({ profile: state.active, source: "file-pins", warnings, resolved: null });
  if (role !== "secondary") return filePins([]);
  const roleWarnings = [];
  if (loadedRoles.errors.length) {
    roleWarnings.push(`the roles file ${loadedRoles.rolesFile.path} has errors and was ignored; run models use none --role secondary to turn the secondary role off`);
    return filePins(roleWarnings);
  }
  if (loadedRoles.secondary === null) return filePins(roleWarnings);
  const assigned = loadedRoles.secondary;
  if (!Object.hasOwn(loaded.profiles, assigned)) {
    roleWarnings.push(`secondary role ${JSON.stringify(assigned)} names a profile that does not exist; run models use none --role secondary to turn it off, or create it and run models use ${assigned} --role secondary`);
    return filePins(roleWarnings);
  }
  const resolved = resolveProfile(loaded, assigned, state.layout);
  if (resolved.errors.length) {
    roleWarnings.push(`secondary role ${JSON.stringify(assigned)} has errors; run models use none --role secondary to turn it off, or fix it and run models use ${assigned} --role secondary`);
    return filePins(roleWarnings);
  }
  return { profile: assigned, source: "role-profile", warnings: roleWarnings, resolved };
}

// The pins a secondary role profile resolves: the same shape as modelsPins, but the
// values come from the profile's resolved targets instead of the files.
function rolePins(pluginRoot, loaded, state, name) {
  const resolved = resolveProfile(loaded, name, state.layout);
  const pins = {};
  for (const [alias, file] of Object.entries(AGENT_ALIASES)) {
    const rel = `.github/agents/${file}`;
    const abs = path.join(pluginRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const model = agentTargetValue(resolved.targets, alias);
    const subagentModel = Array.isArray(model) ? model[0] : model;
    pins[alias] = {
      name: frontmatterField(text, "name"),
      file: rel,
      model,
      subagentModel,
      copilotModel: typeof subagentModel === "string" ? (loaded.copilotModels[subagentModel] ?? null) : null,
    };
  }
  return pins;
}

// The pin each agent file currently carries, read from the plugin root's files:
// { alias: { name, file, model, subagentModel, copilotModel } }. `model` is the
// parsed top-level pin (a string, a list, or null); `subagentModel` is the string
// or the first entry of a list; `copilotModel` is the `copilotModels` alias of
// that first entry, else null; all three are null when the agent is unpinned.
function modelsPins(pluginRoot, copilotModels = {}) {
  const pins = {};
  for (const [alias, file] of Object.entries(AGENT_ALIASES)) {
    const rel = `.github/agents/${file}`;
    const abs = path.join(pluginRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    const model = parseModelValue(text);
    const subagentModel = Array.isArray(model) ? model[0] : model;
    pins[alias] = {
      name: frontmatterField(text, "name"),
      file: rel,
      model,
      subagentModel,
      copilotModel: typeof subagentModel === "string" ? (copilotModels[subagentModel] ?? null) : null,
    };
  }
  return pins;
}

// The pin a profile resolves for one agent alias, or null.
function agentTargetValue(targets, alias) {
  return targets.find((t) => t.file === `.github/agents/${AGENT_ALIASES[alias]}`)?.value ?? null;
}

// Model warnings for a resolved target set: the Decision 2 BYOK tier warning, then
// the unqualified-value warning over the profile's own entries (none for clear).
function tierWarnings(targets, profile = null, copilotModels = null) {
  const byok = byokTierWarning({ autopilot: agentTargetValue(targets, "autopilot"), builder: agentTargetValue(targets, "builder"), reviewer: agentTargetValue(targets, "reviewer") });
  const entries = profile
    ? [
        ...(profile.default !== undefined ? [{ where: "default", value: profile.default }] : []),
        ...Object.entries(profile.agents ?? {}).map(([alias, value]) => ({ where: alias, value })),
        ...Object.entries(profile.prompts ?? {}).map(([prompt, value]) => ({ where: `prompts.${prompt}`, value })),
      ]
    : [];
  const agentEntries = Object.entries(AGENT_ALIASES).map(([alias]) => ({ alias, value: agentTargetValue(targets, alias) }));
  return [byok, unqualifiedWarning(entries), missingAliasWarning(agentEntries, copilotModels)].filter(Boolean);
}

// The same three warnings over the agents' current pins (`models pins`, doctor).
function pinWarnings(pins, copilotModels = null) {
  return {
    byok: byokTierWarning({ autopilot: pins.autopilot?.model, builder: pins.builder?.model, reviewer: pins.reviewer?.model }),
    unqualified: unqualifiedWarning(Object.entries(pins).map(([alias, pin]) => ({ where: alias, value: pin.model }))),
    missingAlias: missingAliasWarning(Object.entries(pins).map(([alias, pin]) => ({ alias, value: pin.model })), copilotModels),
  };
}

// apply | adopt | clear — and `use --role primary` — share this tail: resolve the
// targets, gate on worktree/git/dirty, write each file's model line(s), update the
// filter, and report. `mode` drives the behavior (apply, adopt, or clear); `verb`
// is the reported verb.
function pinModels({ mode, verb, name, pluginRoot, loaded, state }) {
  const primaryCheckout = state.isGit ? primaryCheckoutOf(pluginRoot) : null;
  let targets = state.layout.files.map((file) => ({ file, value: null }));
  let handoffs = null;
  if (mode === "apply" || mode === "adopt") {
    let resolved = null;
    if (mode === "apply") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      resolved = resolveProfile(loaded, name, state.layout);
      if (resolved.errors.length) emit({ status: "invalid", verb, profile: name, errors: resolved.errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
    }
    if (primaryCheckout) {
      emit({ status: "worktree", verb, profile: name ?? null, primaryCheckout, message: `${pluginRoot} is a linked worktree of ${primaryCheckout}, not the registered plugin clone; linked worktrees inherit the clone's pins through its git filter — ${mode} on the clone with --plugin-root ${primaryCheckout}`, ...modelsReport(pluginRoot, loaded, state) }, 3);
    }
    const tooOld = state.isGit ? gitTooOld() : null;
    if (tooOld) emit({ status: "git-too-old", verb, profile: name ?? null, message: `${tooOld}; upgrade git to pin models`, ...modelsReport(pluginRoot, loaded, state) }, 3);
    const dirty = mode === "apply" ? state.dirty : state.dirtyBeyondModel;
    if (dirty.length) {
      emit({ status: "dirty", verb, profile: name ?? null, message: "these files carry changes git would see beyond their recorded model pins (a body edit, or a model: line other than the recorded pin) — commit, stash, or restore them first (git restore re-applies the recorded pin)", ...modelsReport(pluginRoot, loaded, state), dirty }, 3);
    }
    if (resolved) {
      targets = resolved.targets;
      handoffs = resolved.handoffs;
    } else {
      // adopt: the pins the files carry now become the recorded state.
      targets = state.layout.files.map((file) => ({ file, value: parseModelValue(state.texts[file]) }));
      handoffs = Object.fromEntries(state.layout.files.map((file) => [file, handoffModelLines(state.texts[file]).filter((h) => h.line !== null).map((h) => ({ target: h.target, value: parsePinLine(h.line) }))]));
    }
  }
  const writes = [];
  for (const { file, value } of targets) {
    const abs = path.join(pluginRoot, file);
    const before = state.texts[file] ?? fs.readFileSync(abs, "utf8");
    let after;
    try {
      after = setModel(before, value);
      after = setHandoffModels(after, handoffs === null ? null : handoffs[file]);
    } catch (error) {
      emit({ status: "invalid", verb, profile: name ?? null, errors: [`${file}: ${error.message}`], ...modelsReport(pluginRoot, loaded, state) }, 3);
    }
    if (after !== before) writes.push({ file, abs, after });
  }
  const records = Object.fromEntries(targets.map((t) => [t.file, { model: t.value, handoffs: handoffs?.[t.file] ?? [] }]));
  const fail = (message) => emit({ status: "failed", verb, profile: name ?? null, changed: [], message: `${message}; re-run the same command` }, 3);
  if (state.isGit) {
    const legacy = state.legacySkipWorktree.filter((f) => state.tracked.has(f));
    if (legacy.length) {
      const unset = gitRun(pluginRoot, ["update-index", "--no-skip-worktree", "--", ...legacy]);
      if (!unset.ok) fail(`git update-index --no-skip-worktree failed: ${unset.stderr}`);
    }
    try {
      if (mode !== "clear" && Object.values(records).some(hasPin)) installModelFilter(pluginRoot, records);
      else if (!primaryCheckout) removeModelFilter(pluginRoot);
    } catch (error) {
      fail(`installing the model filter failed: ${error.message}`);
    }
  }
  for (const w of writes) fs.writeFileSync(w.abs, w.after);
  if (state.isGit) {
    // Git trusts a size change as a modification, so re-record the stat of each file
    // whose cleaned content is exactly HEAD; anything else would be staged.
    const staged = new Set(git(pluginRoot, "diff", "--cached", "--name-only", "--", ...state.layout.files).split("\n").filter(Boolean));
    const finalText = (f) => writes.find((w) => w.file === f)?.after ?? state.texts[f];
    const cleaned = (f) => (mode === "clear" ? finalText(f) : cleanText(finalText(f), records[f]));
    const restat = state.layout.files.filter((f) => state.heads[f] != null && !staged.has(f) && cleaned(f) === state.heads[f]);
    const updated = restat.length ? gitRun(pluginRoot, ["update-index", "--", ...restat], 120000) : { ok: true };
    if (!updated.ok) fail(`git update-index failed: ${updated.stderr}`);
  }
  emit({ status: "ok", verb, profile: name ?? null, changed: writes.map((w) => w.file), warnings: tierWarnings(targets, mode === "apply" ? loaded.profiles[name] : null, loaded.copilotModels), ...(mode === "clear" && primaryCheckout ? { primaryCheckout } : {}), ...modelsReport(pluginRoot, loaded, modelsState(pluginRoot, loaded)) });
}
export {
  loadProfiles,
  loadRoles,
  candidateErrors,
  nextProfilesObject,
  writeProfiles,
  writeRoles,
  resolveProfile,
  modelsState,
  modelsReport,
  currentWindowRole,
  secondaryProfileLookup,
  rolePins,
  modelsPins,
  tierWarnings,
  pinWarnings,
  pinModels,
};
