// The `models` subcommand, moved unchanged from the legacy switch in
// `scripts/agento.mjs`. The model constants and filter/profile/pin helpers it
// shares with the doctor `model-profile` check live in `lib/models.mjs`.

import fs from "node:fs";
import path from "node:path";

import { emit, options, PLUGIN_ROOT, rest, usage } from "../lib/context.mjs";
import {
  candidateErrors,
  currentWindowRole,
  loadProfiles,
  loadRoles,
  modelsPins,
  modelsReport,
  modelsState,
  nextProfilesObject,
  pinModels,
  pinWarnings,
  resolveProfile,
  rolePins,
  secondaryProfileLookup,
  tierWarnings,
  writeProfiles,
  writeRoles,
} from "../lib/models.mjs";
import {
  AGENT_ALIASES,
  aliasErrors,
  createProfile,
  deleteProfile,
  errorsFor,
  isPinnablePrompt,
  parseModelValue,
  parseProfiles,
  renameProfile,
  replaceProfile,
  roleBucket,
  serializeProfiles,
  setAlias,
  removeAlias,
  splitQualified,
} from "../model-profiles.mjs";

export const commands = {
  models() {
    // Each verb: its positional count, which positionals are profile names, the
    // options it accepts beyond --plugin-root, and whether it writes the file.
    const MODEL_VERBS = {
      list: { argc: 0, names: [], accepts: [], writes: false },
      pins: { argc: 0, names: [], accepts: ["role"], writes: false },
      resolve: { argc: 1, names: [], accepts: ["role"], writes: false },
      show: { argc: 1, names: [0], accepts: [], writes: false },
      apply: { argc: 1, names: [0], accepts: [], writes: true },
      adopt: { argc: 0, names: [], accepts: [], writes: true },
      clear: { argc: 0, names: [], accepts: [], writes: true },
      use: { argc: 1, names: [0], accepts: ["role", "expect"], writes: true },
      init: { argc: 0, names: [], accepts: [], writes: true },
      create: { argc: 1, names: [0], accepts: ["from", "description", "expect"], writes: true },
      update: { argc: 1, names: [0], accepts: ["dryRun", "expect"], writes: true },
      rename: { argc: 2, names: [0, 1], accepts: ["expect"], writes: true },
      delete: { argc: 1, names: [0], accepts: ["force", "expect"], writes: true },
      "alias set": { argc: 2, names: [], accepts: ["expect"], writes: true },
      "alias remove": { argc: 1, names: [], accepts: ["expect"], writes: true },
    };
    const [head = "list", ...modelsArgs] = rest;
    let verb = head;
    let args = modelsArgs;
    if (head === "alias") {
      const [sub = "", ...subArgs] = modelsArgs;
      if (sub === "set" || sub === "remove") { verb = `alias ${sub}`; args = subArgs; }
      else usage(`models alias: unknown sub-verb ${JSON.stringify(sub)}; known: set, remove`);
    }
    const spec = MODEL_VERBS[verb];
    if (!spec) usage(`models: unknown verb ${verb}; known: ${Object.keys(MODEL_VERBS).join(", ")}`);
    if (args.length !== spec.argc) usage(`models ${verb} takes ${spec.argc === 0 ? "no arguments" : `exactly ${spec.argc} ${spec.argc === 1 ? "argument" : "arguments"}`}`);
    for (const at of spec.names) if (!/^[a-z0-9-]+$/.test(args[at])) usage(`models ${verb}: profile names match [a-z0-9-]+, got ${JSON.stringify(args[at])}`);
    for (const option of ["force", "dryRun", "from", "description", "expect", "role"]) {
      if (options[option] !== undefined && !spec.accepts.includes(option)) usage(`models ${verb} does not accept --${option}`);
    }
    const name = args[0];
    const pluginRoot = path.resolve(options.pluginRoot ?? PLUGIN_ROOT);
    if (!fs.existsSync(path.join(pluginRoot, ".github", "agents"))) usage(`--plugin-root ${pluginRoot} is not an Agento plugin clone (no .github/agents)`);
    const loaded = loadProfiles();
    const loadedRoles = loadRoles();

    if (verb === "init") {
      let created = false;
      if (!loaded.profilesFile.exists) {
        const template = path.join(pluginRoot, "templates", "model-profiles.json");
        if (!fs.existsSync(template)) emit({ status: "missing", verb, message: `${template} not found`, profilesFile: loaded.profilesFile, pluginRoot }, 3);
        fs.mkdirSync(path.dirname(loaded.profilesFile.path), { recursive: true });
        fs.copyFileSync(template, loaded.profilesFile.path, fs.constants.COPYFILE_EXCL);
        created = true;
      }
      const reloaded = loadProfiles();
      emit({ status: "ok", verb, created, ...modelsReport(pluginRoot, reloaded, modelsState(pluginRoot, reloaded)) });
    }

    const state = modelsState(pluginRoot, loaded);
    if (verb === "list") {
      const fileErrors = loaded.errors.filter((e) => !e.startsWith("profiles."));
      const profiles = Object.keys(loaded.profiles).map((n) => {
        const resolved = state.resolved.find((p) => p.name === n);
        const errors = resolved?.errors ?? errorsFor(loaded.errors, n);
        const targets = errors.length ? [] : (resolved?.targets ?? []);
        return {
          name: n,
          description: typeof loaded.profiles[n]?.description === "string" ? loaded.profiles[n].description : null,
          errors,
          warnings: errors.length ? [] : tierWarnings(targets, loaded.profiles[n], loaded.copilotModels),
          targets,
        };
      });
      const pinnable = {
        agents: Object.keys(AGENT_ALIASES),
        prompts: state.layout.prompts.filter((p) => isPinnablePrompt(p, new Set(state.layout.agents.map((a) => a.name).filter(Boolean)))).map((p) => p.name).sort(),
      };
      emit({ status: "ok", verb, profiles, pinnable, copilotModels: loaded.copilotModels, errors: fileErrors, roles: { primary: state.active, secondary: loadedRoles.secondary }, rolesFile: loadedRoles.rolesFile, rolesErrors: loadedRoles.errors, ...modelsReport(pluginRoot, loaded, state) });
    }

    if (verb === "show") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const { targets, errors } = resolveProfile(loaded, name, state.layout);
      const description = typeof loaded.profiles[name]?.description === "string" ? loaded.profiles[name].description : null;
      const warnings = tierWarnings(targets, loaded.profiles[name], loaded.copilotModels);
      emit({ status: errors.length ? "invalid" : "ok", verb, profile: name, description, body: loaded.profiles[name], targets, errors, warnings, ...modelsReport(pluginRoot, loaded, state) }, errors.length ? 3 : 0);
    }

    if (verb === "pins") {
      const windowRole = currentWindowRole();
      const role = options.role ?? roleBucket(windowRole);
      const roleSource = options.role !== undefined ? "flag" : "window";
      const { profile, source, warnings: roleWarnings } = secondaryProfileLookup(loaded, loadedRoles, state, role);
      const pins = source === "role-profile" ? rolePins(pluginRoot, loaded, state, profile) : modelsPins(pluginRoot, loaded.copilotModels);
      const { byok, unqualified, missingAlias } = pinWarnings(pins, loaded.copilotModels);
      const warnings = [byok, unqualified, missingAlias, ...roleWarnings].filter(Boolean);
      emit({ status: "ok", verb, pins, warnings, role, roleSource, windowRole, profile, source, ...modelsReport(pluginRoot, loaded, state) });
    }

    if (verb === "resolve") {
      const command = args[0];
      const prompt = state.layout.prompts.find((p) => p.name === command);
      if (!prompt) emit({ status: "not-found", verb, command, message: `no prompt named ${JSON.stringify(command)} in .github/prompts`, known: state.layout.prompts.map((p) => p.name).sort(), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const windowRole = currentWindowRole();
      const role = options.role ?? roleBucket(windowRole);
      const roleSource = options.role !== undefined ? "flag" : "window";
      const { profile, source, warnings, resolved } = secondaryProfileLookup(loaded, loadedRoles, state, role);
      const model = source === "role-profile" ? (resolved.targets.find((t) => t.file === prompt.file)?.value ?? null) : parseModelValue(state.texts[prompt.file]);
      const qualified = Array.isArray(model) ? (model[0] ?? null) : model;
      const { name, vendor } = splitQualified(qualified);
      const copilotModel = typeof qualified === "string" ? (loaded.copilotModels[qualified] ?? null) : null;
      emit({ status: "ok", verb, command, agent: prompt.agent ?? null, role, roleSource, windowRole, profile, source, model, qualified, name, vendor, copilotModel, warnings, ...modelsReport(pluginRoot, loaded, state) });
    }

    if (verb === "create") {
      if (name === "none") usage("models create: the name none is reserved (models use none turns a role off); pick another name");
      if (Object.hasOwn(loaded.profiles, name)) emit({ status: "exists", verb, profile: name, message: `profile ${name} already exists in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      if (options.from !== undefined && !Object.hasOwn(loaded.profiles, options.from)) emit({ status: "not-found", verb, profile: name, from: options.from, message: `no profile ${options.from} to copy from`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const created = createProfile(loaded, name, { from: options.from, description: options.description });
      const next = nextProfilesObject(loaded, created.profiles, loaded.copilotModels);
      const errors = candidateErrors(loaded, next, name, state.layout);
      if (errors.length) emit({ status: "invalid", verb, profile: name, errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const { code, result } = writeProfiles(pluginRoot, loaded, next, { expect: options.expect, names: [name] });
      emit({ verb, profile: name, ...result }, code);
    }

    if (verb === "update") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}; create it first with models create ${name}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      if (process.stdin.isTTY) usage("models update reads the profile JSON from stdin");
      let body;
      try {
        body = JSON.parse(fs.readFileSync(0, "utf8"));
      } catch (error) {
        emit({ status: "invalid", verb, profile: name, errors: [`invalid JSON on stdin: ${error.message}`], ...modelsReport(pluginRoot, loaded, state) }, 3);
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) emit({ status: "invalid", verb, profile: name, errors: ["the profile body must be a JSON object"], ...modelsReport(pluginRoot, loaded, state) }, 3);
      const replaced = replaceProfile(loaded, name, body);
      const next = nextProfilesObject(loaded, replaced.profiles, loaded.copilotModels);
      const reparsed = parseProfiles(serializeProfiles(next));
      const candidate = { ...loaded, profiles: next.profiles, copilotModels: next.copilotModels ?? loaded.copilotModels ?? {}, errors: reparsed.errors };
      const resolved = resolveProfile(candidate, name, state.layout);
      const warnings = tierWarnings(resolved.targets, next.profiles[name], candidate.copilotModels);
      if (options.dryRun) {
        emit({ status: "ok", verb, profile: name, dryRun: true, written: false, errors: resolved.errors, warnings, ...modelsReport(pluginRoot, loaded, state) });
      }
      if (resolved.errors.length) emit({ status: "invalid", verb, profile: name, errors: resolved.errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const { code, result } = writeProfiles(pluginRoot, loaded, next, { expect: options.expect, names: [name] });
      if (result.status === "ok" && result.active !== result.activeBefore) result.reapply = `agento.mjs models apply ${name} --plugin-root ${pluginRoot}`;
      emit({ verb, profile: name, ...result }, code);
    }

    if (verb === "rename") {
      const [old, next] = args;
      if (next === "none") usage("models rename: the name none is reserved (models use none turns a role off); pick another name");
      if (!Object.hasOwn(loaded.profiles, old)) emit({ status: "not-found", verb, profile: old, message: `no profile ${old} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      if (Object.hasOwn(loaded.profiles, next)) emit({ status: "exists", verb, profile: next, message: `profile ${next} already exists in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      const renamed = renameProfile(loaded, old, next);
      const nextData = nextProfilesObject(loaded, renamed.profiles, loaded.copilotModels);
      const { code, result } = writeProfiles(pluginRoot, loaded, nextData, { expect: options.expect, names: [next] });
      if (code !== 0) emit({ verb, profile: old, ...result }, code);
      if (loadedRoles.secondary === old) {
        const rolesWrite = writeRoles(loadedRoles, { secondary: next }, {});
        if (rolesWrite.code !== 0) emit({ verb, profile: old, ...result, status: "roles-failed", message: `profile ${old} was renamed to ${next}, but writing the roles file failed: ${rolesWrite.result.message}`, secondaryBefore: loadedRoles.secondary, rolesWrite: rolesWrite.result }, rolesWrite.code);
        emit({ verb, profile: old, ...result, secondaryBefore: loadedRoles.secondary, roles: rolesWrite.result.roles, rolesFile: rolesWrite.result.rolesFile, rolesErrors: rolesWrite.result.rolesErrors }, 0);
      }
      emit({ verb, profile: old, ...result }, 0);
    }

    if (verb === "delete") {
      if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
      if (state.active === name && !options.force) emit({ status: "active", verb, profile: name, message: `profile ${name} is applied in ${pluginRoot}; run agento.mjs models clear or pass --force to delete it`, ...modelsReport(pluginRoot, loaded, state) }, 3);
      if (loadedRoles.secondary === name && !options.force) emit({ status: "assigned", verb, profile: name, message: `profile ${name} is assigned to the secondary role; run models use none --role secondary to turn the role off, or pass --force to delete it and turn the role off`, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const deleted = deleteProfile(loaded, name);
      const nextData = nextProfilesObject(loaded, deleted.profiles, loaded.copilotModels);
      const { code, result } = writeProfiles(pluginRoot, loaded, nextData, { expect: options.expect, names: [name] });
      if (code !== 0) emit({ verb, profile: name, ...result }, code);
      if (loadedRoles.secondary === name) {
        const rolesWrite = writeRoles(loadedRoles, { secondary: null }, {});
        if (rolesWrite.code !== 0) emit({ verb, profile: name, ...result, status: "roles-failed", message: `profile ${name} was deleted, but writing the roles file failed: ${rolesWrite.result.message}`, secondaryBefore: loadedRoles.secondary, rolesWrite: rolesWrite.result }, rolesWrite.code);
        emit({ verb, profile: name, ...result, secondaryBefore: loadedRoles.secondary, roles: rolesWrite.result.roles, rolesFile: rolesWrite.result.rolesFile, rolesErrors: rolesWrite.result.rolesErrors }, 0);
      }
      emit({ verb, profile: name, ...result }, 0);
    }

    if (verb === "alias set") {
      const [picker, id] = args;
      const errors = aliasErrors(picker, id);
      if (errors.length) emit({ status: "invalid", verb, picker, errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const aliased = setAlias(loaded, picker, id);
      const nextData = nextProfilesObject(loaded, loaded.profiles, aliased.copilotModels);
      const { code, result } = writeProfiles(pluginRoot, loaded, nextData, { expect: options.expect });
      emit({ verb, picker, copilotModels: aliased.copilotModels, ...result }, code);
    }

    if (verb === "alias remove") {
      const [picker] = args;
      if (!Object.hasOwn(loaded.copilotModels ?? {}, picker)) emit({ status: "not-found", verb, picker, message: `no alias for picker ${JSON.stringify(picker)}`, ...modelsReport(pluginRoot, loaded, state) }, 3);
      const removed = removeAlias(loaded, picker);
      const nextData = nextProfilesObject(loaded, loaded.profiles, removed.copilotModels);
      const { code, result } = writeProfiles(pluginRoot, loaded, nextData, { expect: options.expect });
      emit({ verb, picker, copilotModels: removed.copilotModels, ...result }, code);
    }

    if (verb === "use") {
      if (options.role === undefined) usage("models use requires --role primary or secondary");
      if (options.role === "primary") {
        if (options.expect !== undefined) usage("models use --role primary does not accept --expect (nothing in the profiles file is written)");
        pinModels({ mode: name === "none" ? "clear" : "apply", verb, name: name === "none" ? null : name, pluginRoot, loaded, state });
      } else {
        if (name === "none") {
          const { code, result } = writeRoles(loadedRoles, { secondary: null }, { expect: options.expect });
          emit({ verb, role: "secondary", profile: null, secondaryBefore: loadedRoles.secondary, ...result }, code);
        } else {
          if (!Object.hasOwn(loaded.profiles, name)) emit({ status: "not-found", verb, role: "secondary", profile: name, message: `no profile ${name} in ${loaded.profilesFile.path}`, known: Object.keys(loaded.profiles), ...modelsReport(pluginRoot, loaded, state) }, 3);
          const resolved = resolveProfile(loaded, name, state.layout);
          if (resolved.errors.length) emit({ status: "invalid", verb, role: "secondary", profile: name, errors: resolved.errors, ...modelsReport(pluginRoot, loaded, state) }, 3);
          const { code, result } = writeRoles(loadedRoles, { secondary: name }, { expect: options.expect });
          emit({ verb, role: "secondary", profile: name, secondaryBefore: loadedRoles.secondary, ...result }, code);
        }
      }
    }

    // apply | adopt | clear
    pinModels({ mode: verb, verb, name, pluginRoot, loaded, state });
  },
};
