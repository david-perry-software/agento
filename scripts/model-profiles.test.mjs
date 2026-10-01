import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AGENT_ALIASES, detectActive, differsBeyondModel, errorsFor, frontmatterField, parseProfiles, profilesFile, readModel, renderModel, resolveTargets, setModel } from "./model-profiles.mjs";

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

const AGENTS = Object.entries(AGENT_ALIASES).map(([alias, file]) => ({ file: `.github/agents/${file}`, name: `Agento ${alias}` }));
const PROMPTS = [
  { file: ".github/prompts/build-feature.prompt.md", name: "build-feature", agent: "Agento builder" },
  { file: ".github/prompts/new-feature.prompt.md", name: "new-feature", agent: "Agento planner" },
  { file: ".github/prompts/doctor.prompt.md", name: "doctor", agent: "agent" },
  { file: ".github/prompts/start-session.prompt.md", name: "start-session", agent: null },
];
const valueOf = (targets, file) => targets.find((t) => t.file.endsWith(file)).value;

test("frontmatterField reads quoted and plain scalars from the leading block only", () => {
  const text = '---\nname: "📋 Agento Planner"\r\nagent: \'it\'\'s\'\ntools: [read]\n---\nname: body\n';
  assert.equal(frontmatterField(text, "name"), "📋 Agento Planner");
  assert.equal(frontmatterField(text, "agent"), "it's");
  assert.equal(frontmatterField(text, "tools"), "[read]");
  assert.equal(frontmatterField(text, "model"), null);
  assert.equal(frontmatterField("no frontmatter\n", "name"), null);
});

test("resolveTargets: agent aliases, default, and missing → null", () => {
  const { targets, errors } = resolveTargets({ profile: { default: "Cheap", agents: { planner: "Strong", reviewer: ["A", "B"] } }, agents: AGENTS, prompts: [] });
  assert.deepEqual(errors, []);
  assert.equal(valueOf(targets, "delivery-planner.agent.md"), "Strong");
  assert.deepEqual(valueOf(targets, "delivery-reviewer.agent.md"), ["A", "B"]);
  assert.equal(valueOf(targets, "delivery-builder.agent.md"), "Cheap");
  const bare = resolveTargets({ profile: { agents: { planner: "Strong" } }, agents: AGENTS, prompts: [] }).targets;
  assert.equal(valueOf(bare, "delivery-builder.agent.md"), null);
  assert.equal(bare.length, 6);
});

test("resolveTargets: custom-agent prompts inherit, built-in prompts use prompts.<name> ?? default", () => {
  const { targets, errors } = resolveTargets({
    profile: { default: "Cheap", agents: { builder: "Mid", planner: "Strong" }, prompts: { doctor: "Tiny" } },
    agents: AGENTS,
    prompts: PROMPTS,
  });
  assert.deepEqual(errors, []);
  assert.equal(valueOf(targets, "build-feature.prompt.md"), "Mid");
  assert.equal(valueOf(targets, "new-feature.prompt.md"), "Strong");
  assert.equal(valueOf(targets, "doctor.prompt.md"), "Tiny");
  assert.equal(valueOf(targets, "start-session.prompt.md"), "Cheap");
  const unpinned = resolveTargets({ profile: { agents: { planner: "Strong" } }, agents: AGENTS, prompts: PROMPTS }).targets;
  assert.equal(valueOf(unpinned, "doctor.prompt.md"), null);
  assert.equal(valueOf(unpinned, "build-feature.prompt.md"), null);
  assert.equal(valueOf(unpinned, "new-feature.prompt.md"), "Strong");
});

test("resolveTargets: prompts.<name> on a custom-agent prompt and unknown prompt keys are errors", () => {
  const { errors } = resolveTargets({ profile: { prompts: { "build-feature": "X", nope: "Y" } }, agents: AGENTS, prompts: PROMPTS });
  assert.deepEqual(errors, [
    'prompts.nope: no prompt named "nope" in .github/prompts',
    "prompts.build-feature: runs on Agento builder and inherits its model; set the agent's model instead",
  ]);
});

const AGENT_DOC = '---\nname: "X"\ndescription: "d"\nargument-hint: "h"\ntools: [read]\n---\n\nBody model: no\n';

test("setModel inserts after argument-hint, replaces in place, and removes byte-exactly", () => {
  const pinned = setModel(AGENT_DOC, "Strong");
  assert.equal(pinned, '---\nname: "X"\ndescription: "d"\nargument-hint: "h"\nmodel: "Strong"\ntools: [read]\n---\n\nBody model: no\n');
  assert.equal(readModel(pinned), 'model: "Strong"');
  const replaced = setModel(pinned, ["A (copilot)", 'B "q"']);
  assert.equal(replaced, '---\nname: "X"\ndescription: "d"\nargument-hint: "h"\nmodel: ["A (copilot)", "B \\"q\\""]\ntools: [read]\n---\n\nBody model: no\n');
  assert.equal(setModel(replaced, null), AGENT_DOC);
  assert.equal(setModel(AGENT_DOC, null), AGENT_DOC);
  assert.equal(setModel(pinned, "Strong"), pinned);
  assert.equal(readModel(AGENT_DOC), null);
});

test("setModel falls back to description:, then the closing ---", () => {
  const noHint = '---\ndescription: "a\n  b"\nagent: "agent"\n---\nbody\n';
  assert.equal(setModel(noHint, "M"), '---\ndescription: "a\n  b"\nmodel: "M"\nagent: "agent"\n---\nbody\n');
  const bare = "---\nagent: x\n---\n";
  assert.equal(setModel(bare, "M"), '---\nagent: x\nmodel: "M"\n---\n');
  assert.equal(setModel("plain\n", null), "plain\n");
  assert.throws(() => setModel("plain\n", "M"), /frontmatter/);
});

test("setModel preserves CRLF and collapses block-list or duplicate model keys to one line", () => {
  const crlf = AGENT_DOC.replace(/\n/g, "\r\n");
  const pinned = setModel(crlf, "M");
  assert.equal(pinned, '---\r\nname: "X"\r\ndescription: "d"\r\nargument-hint: "h"\r\nmodel: "M"\r\ntools: [read]\r\n---\r\n\r\nBody model: no\r\n');
  assert.equal(readModel(pinned), 'model: "M"');
  assert.equal(setModel(pinned, null), crlf);
  const block = '---\ndescription: d\nmodel:\n  - A\n  - B\ntools: [x]\nmodel: "C"\n---\n';
  assert.equal(readModel(block), "model:\n  - A\n  - B");
  assert.equal(setModel(block, "M"), '---\ndescription: d\nmodel: "M"\ntools: [x]\n---\n');
  assert.equal(setModel(block, null), "---\ndescription: d\ntools: [x]\n---\n");
});

test("renderModel serializes strings and lists as JSON-quoted YAML", () => {
  assert.equal(renderModel(null), null);
  assert.equal(renderModel("GPT-5 (copilot)"), 'model: "GPT-5 (copilot)"');
  assert.equal(renderModel(["a", "b"]), 'model: ["a", "b"]');
});

test("detectActive: null when unpinned, the matching profile, else custom", () => {
  const targets = (planner, doctor) => [{ file: "a.agent.md", value: planner }, { file: "doctor.prompt.md", value: doctor }];
  const profiles = [
    { name: "mixed", targets: targets("Strong", "Cheap") },
    { name: "solo", targets: targets("Strong", null) },
  ];
  assert.equal(detectActive({ profiles, current: { "a.agent.md": null, "doctor.prompt.md": null } }), null);
  assert.equal(detectActive({ profiles, current: { "a.agent.md": 'model: "Strong"', "doctor.prompt.md": 'model: "Cheap"' } }), "mixed");
  assert.equal(detectActive({ profiles, current: { "a.agent.md": 'model: "Strong"', "doctor.prompt.md": null } }), "solo");
  assert.equal(detectActive({ profiles, current: { "a.agent.md": 'model: "Edited"', "doctor.prompt.md": 'model: "Cheap"' } }), "custom");
  assert.equal(detectActive({ profiles: [], current: { "a.agent.md": 'model: "X"' } }), "custom");
  assert.equal(detectActive({ profiles: [{ name: "arr", targets: [{ file: "a.agent.md", value: ["A", "B"] }] }], current: { "a.agent.md": 'model: ["A", "B"]' } }), "arr");
});

test("differsBeyondModel ignores only the model: line", () => {
  assert.equal(differsBeyondModel(AGENT_DOC, setModel(AGENT_DOC, "M")), false);
  assert.equal(differsBeyondModel(AGENT_DOC, AGENT_DOC), false);
  assert.equal(differsBeyondModel(AGENT_DOC, setModel(AGENT_DOC, "M").replace("Body", "Edited")), true);
  assert.equal(differsBeyondModel(AGENT_DOC, AGENT_DOC.replace(/\n/g, "\r\n")), true);
});
