import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AGENT_ALIASES, errorsFor, parseProfiles, profilesFile } from "./model-profiles.mjs";

const parse = (data) => parseProfiles(JSON.stringify(data));

test("profilesFile: AGENTO_CONFIG_HOME, then XDG_CONFIG_HOME/agento, then ~/.config/agento", () => {
  assert.equal(profilesFile({ AGENTO_CONFIG_HOME: "/t", XDG_CONFIG_HOME: "/x" }, "/home/u"), path.join("/t", "model-profiles.json"));
  assert.equal(profilesFile({ XDG_CONFIG_HOME: "/x" }, "/home/u"), path.join("/x", "agento", "model-profiles.json"));
  assert.equal(profilesFile({}, "/home/u"), path.join("/home/u", ".config", "agento", "model-profiles.json"));
  assert.equal(profilesFile({ XDG_CONFIG_HOME: "" }, "/home/u"), path.join("/home/u", ".config", "agento", "model-profiles.json"));
});

test("parseProfiles accepts the documented schema", () => {
  const { profiles, errors } = parse({
    profiles: {
      mixed: { description: "d", default: "Cheap", agents: { planner: "Strong", reviewer: ["A", "B"] }, prompts: { doctor: "Cheap" } },
      "all-strong": { default: "Strong" },
      empty: {},
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(profiles), ["mixed", "all-strong", "empty"]);
  assert.deepEqual(Object.keys(AGENT_ALIASES), ["planner", "builder", "reviewer", "autopilot", "mechanic", "architect"]);
});

test("parseProfiles rejects malformed files and top-level shapes", () => {
  assert.match(parseProfiles("{").errors[0], /^invalid JSON/);
  assert.match(parseProfiles("[]").errors[0], /top level must be an object/);
  assert.deepEqual(parse({ profiles: [] }).errors, ["`profiles` must be an object"]);
  assert.deepEqual(parse({ profiles: {}, extra: 1 }).errors, ['unknown top-level key "extra"']);
});

test("parseProfiles reports each schema error with its path", () => {
  const { errors } = parse({
    profiles: {
      Bad_Name: {},
      notobj: "x",
      p: {
        description: 5,
        default: 7,
        agents: { planner: [], builder: [""], reviewer: "<strong>", autopilot: "a\nmodel: x", nobody: "M", mechanic: ["ok", 3] },
        prompts: { "Bad/Path": "M", doctor: "  " },
        extra: true,
      },
      q: { agents: "x", prompts: [] },
    },
  });
  const expected = [
    "profiles.Bad_Name: profile names must match [a-z0-9-]+",
    "profiles.notobj: must be an object",
    'profiles.p: unknown key "extra"',
    "profiles.p.description: must be a string",
    "profiles.p.default: must be a model name or a non-empty list of model names",
    "profiles.p.agents.planner: must not be an empty list",
    "profiles.p.agents.builder: model names must be non-empty strings",
    'profiles.p.agents.reviewer: placeholder "<strong>" must be replaced with a model name',
    'profiles.p.agents.autopilot: "a\\nmodel: x" contains a control character',
    'profiles.p.agents: unknown agent alias "nobody"; known: planner, builder, reviewer, autopilot, mechanic, architect',
    "profiles.p.agents.mechanic: model names must be non-empty strings",
    'profiles.p.prompts: prompt names must match [a-z0-9-]+, got "Bad/Path"',
    "profiles.p.prompts.doctor: model names must be non-empty strings",
    "profiles.q.agents: must be an object",
    "profiles.q.prompts: must be an object",
  ];
  assert.deepEqual(errors, expected);
});

test("parseProfiles rejects DEL and closing placeholders too", () => {
  assert.equal(parse({ profiles: { p: { default: "a\u007f" } } }).errors.length, 1);
  assert.equal(parse({ profiles: { p: { default: "model>" } } }).errors.length, 1);
});

test("errorsFor keeps file-level errors and the named profile's own errors", () => {
  const errors = ["unknown top-level key \"x\"", "profiles.a.default: e1", "profiles.a: e2", "profiles.a-b.default: e3", "profiles.b: e4"];
  assert.deepEqual(errorsFor(errors, "a"), ["unknown top-level key \"x\"", "profiles.a.default: e1", "profiles.a: e2"]);
  assert.deepEqual(errorsFor(errors, "a-b"), ["unknown top-level key \"x\"", "profiles.a-b.default: e3"]);
});
