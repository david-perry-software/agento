import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasStatus,
  diffFields,
  formToProfile,
  modelChoices,
  parseWebviewMessage,
  profileToForm,
  suggestAlias,
  validateRename,
} from "../../src/profileEditorModel.js";

const pinnable = { agents: ["planner", "builder", "reviewer", "autopilot", "mechanic", "architect"], prompts: ["doctor", "new-feature"] };

test("profileToForm maps a body to an editable form with the six agents and set prompts", () => {
  const form = profileToForm(
    { description: "d", default: "Cheap (copilot)", agents: { planner: "Strong (copilot)", reviewer: ["A (copilot)", "B (copilot)"] }, prompts: { doctor: "Tiny (copilot)" } },
    pinnable,
  );
  assert.equal(form.name, "");
  assert.equal(form.description, "d");
  assert.deepEqual(form.default, ["Cheap (copilot)"]);
  assert.deepEqual(form.agents, {
    planner: ["Strong (copilot)"],
    builder: [],
    reviewer: ["A (copilot)", "B (copilot)"],
    autopilot: [],
    mechanic: [],
    architect: [],
  });
  assert.deepEqual(form.prompts, { doctor: ["Tiny (copilot)"] });
  assert.deepEqual(form.unknown, {});
});

test("profileToForm of an empty or missing body gives an all-empty form", () => {
  const empty = profileToForm({}, pinnable);
  assert.equal(empty.description, "");
  assert.deepEqual(empty.default, []);
  assert.deepEqual(empty.agents.planner, []);
  assert.deepEqual(empty.prompts, {});
  assert.deepEqual(empty.unknown, {});
  const missing = profileToForm(undefined, pinnable);
  assert.equal(missing.description, "");
  assert.deepEqual(missing.default, []);
});

test("formToProfile writes one-item lists as strings, omits empty fields, and keeps stable key order", () => {
  const body = formToProfile({
    name: "mixed",
    description: "d",
    default: ["Cheap (copilot)"],
    agents: { planner: ["Strong (copilot)"], builder: [], reviewer: ["A (copilot)", "B (copilot)"] },
    prompts: { doctor: ["Tiny (copilot)"] },
    unknown: {},
  });
  assert.deepEqual(body, {
    description: "d",
    default: "Cheap (copilot)",
    agents: { planner: "Strong (copilot)", reviewer: ["A (copilot)", "B (copilot)"] },
    prompts: { doctor: "Tiny (copilot)" },
  });
  assert.deepEqual(Object.keys(body), ["description", "default", "agents", "prompts"]);
});

test("formToProfile drops empty and whitespace-only entries and omits empty sections", () => {
  const body = formToProfile({
    name: "",
    description: "   ",
    default: ["", "  ", "Only (copilot)"],
    agents: { planner: [""], builder: [] },
    prompts: { doctor: [""] },
    unknown: {},
  });
  assert.deepEqual(body, { default: "Only (copilot)" });
});

test("profileToForm/formToProfile round-trips a body and preserves unknown keys with a notice", () => {
  const original = { description: "d", default: ["A (copilot)", "B (copilot)"], agents: { planner: "P (copilot)" }, prompts: { doctor: "D (copilot)" }, extra: { kept: true } };
  const form = profileToForm(original, pinnable);
  assert.deepEqual(form.unknown, { extra: { kept: true } });
  assert.deepEqual(formToProfile(form), original);
});

test("modelChoices groups by vendor, labels <name> (<vendor>), sorts, and de-duplicates", () => {
  const choices = modelChoices([
    { id: "b", name: "Beta", vendor: "copilot" },
    { id: "a", name: "Alpha", vendor: "copilot" },
    { id: "a", name: "Alpha", vendor: "copilot" }, // duplicate label
    { id: "x", name: "Xray", vendor: "byok" },
    { name: "NoId", vendor: "copilot" },
    { id: 7, name: "Seven", vendor: "copilot" },
    { name: "NoVendor", id: "n" },
    "not an object",
    null,
  ]);
  assert.deepEqual(choices, [
    { id: "x", name: "Xray", vendor: "byok", label: "Xray (byok)" },
    { id: "a", name: "Alpha", vendor: "copilot", label: "Alpha (copilot)" },
    { id: "b", name: "Beta", vendor: "copilot", label: "Beta (copilot)" },
    { id: null, name: "NoId", vendor: "copilot", label: "NoId (copilot)" },
    { id: null, name: "Seven", vendor: "copilot", label: "Seven (copilot)" },
  ]);
  assert.deepEqual(modelChoices(undefined), []);
});

test("suggestAlias: Copilot id, already-qualified id, other vendor, and no id", () => {
  assert.equal(suggestAlias({ id: "claude-opus-5", vendor: "copilot" }), "claude-opus-5");
  assert.equal(suggestAlias({ id: "deepseek/deepseek-v4", vendor: "deepseek" }), "deepseek/deepseek-v4");
  assert.equal(suggestAlias({ id: "grok-4", vendor: "grok" }), "grok/grok-4");
  assert.equal(suggestAlias({ id: null, vendor: "copilot" }), null);
  assert.equal(suggestAlias({ id: "", vendor: "copilot" }), null);
});

test("aliasStatus reports existing, suggested, and none", () => {
  const choices = modelChoices([
    { id: "claude-opus-5", name: "Claude Opus 5", vendor: "copilot" },
    { id: "grok-4", name: "Grok 4", vendor: "grok" },
  ]);
  assert.deepEqual(aliasStatus("Claude Opus 5 (copilot)", { "Claude Opus 5 (copilot)": "claude-opus-5" }, choices), { status: "existing", id: "claude-opus-5" });
  assert.deepEqual(aliasStatus("Claude Opus 5 (copilot)", {}, choices), { status: "suggested", id: "claude-opus-5" });
  assert.deepEqual(aliasStatus("Grok 4 (grok)", {}, choices), { status: "suggested", id: "grok/grok-4" });
  assert.deepEqual(aliasStatus("Unknown (copilot)", {}, choices), { status: "none" });
  assert.deepEqual(aliasStatus("NoId (copilot)", {}, choices), { status: "none" });
});

test("parseWebviewMessage accepts every schema message", () => {
  const form = { name: "mixed", description: "", default: ["A (copilot)"], agents: { planner: [] }, prompts: {} };
  assert.deepEqual(parseWebviewMessage({ type: "ready" }), { ok: true, message: { type: "ready" } });
  assert.deepEqual(parseWebviewMessage({ type: "reload" }), { ok: true, message: { type: "reload" } });
  assert.deepEqual(parseWebviewMessage({ type: "openFile" }), { ok: true, message: { type: "openFile" } });
  assert.deepEqual(parseWebviewMessage({ type: "change", form, dirty: true }), { ok: true, message: { type: "change", form, dirty: true } });
  assert.deepEqual(parseWebviewMessage({ type: "validate", form }), { ok: true, message: { type: "validate", form } });
  assert.deepEqual(parseWebviewMessage({ type: "save", form }), { ok: true, message: { type: "save", form } });
  assert.deepEqual(parseWebviewMessage({ type: "saveAndApply", form }), { ok: true, message: { type: "saveAndApply", form } });
  assert.deepEqual(parseWebviewMessage({ type: "addAlias", value: "Claude Opus 5 (copilot)", id: "claude-opus-5" }), {
    ok: true,
    message: { type: "addAlias", value: "Claude Opus 5 (copilot)", id: "claude-opus-5" },
  });
});

test("parseWebviewMessage rejects malformed and unknown messages", () => {
  const form = { name: "", description: "", default: [], agents: {}, prompts: {} };
  assert.deepEqual(parseWebviewMessage(null), { ok: false, error: "message is not an object" });
  assert.deepEqual(parseWebviewMessage([]), { ok: false, error: "message is not an object" });
  assert.deepEqual(parseWebviewMessage({ type: "bogus" }), { ok: false, error: 'unknown message type "bogus"' });
  assert.deepEqual(parseWebviewMessage({ type: "ready", extra: 1 }), { ok: false, error: 'message "ready" has unexpected keys' });
  assert.deepEqual(parseWebviewMessage({ type: "change", form, dirty: "yes" }), { ok: false, error: 'message "change" has invalid fields' });
  assert.deepEqual(parseWebviewMessage({ type: "change", form: { ...form, extra: 1 }, dirty: true }), { ok: false, error: 'message "change" has invalid fields' });
  assert.deepEqual(parseWebviewMessage({ type: "addAlias", value: 7, id: "x" }), { ok: false, error: 'message "addAlias" has invalid fields' });
});

test("diffFields lists changed field paths between two stored bodies", () => {
  const base = { description: "d", default: "A (copilot)", agents: { planner: "P (copilot)", builder: "B (copilot)" }, prompts: { doctor: "D (copilot)" } };
  const latest = { description: "d2", default: ["A (copilot)", "B (copilot)"], agents: { planner: "P (copilot)", builder: "Changed (copilot)" }, prompts: {} };
  assert.deepEqual(diffFields(base, latest), ["description", "default", "agents.builder", "prompts.doctor"]);
  assert.deepEqual(diffFields(base, base), []);
  assert.deepEqual(diffFields(undefined, {}), []);
});

test("validateRename enforces the CLI name rule and uniqueness", () => {
  assert.equal(validateRename("mixed", []), null);
  assert.equal(validateRename("a-b-2", []), null);
  assert.equal(validateRename("Bad_Name", []), 'Profile names match [a-z0-9-]+, got "Bad_Name"');
  assert.equal(validateRename("", []), 'Profile names match [a-z0-9-]+, got ""');
  assert.equal(validateRename("taken", ["other", "taken"]), 'A profile named "taken" already exists');
});
