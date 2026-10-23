import assert from "node:assert/strict";
import test from "node:test";

import {
  chatModelSetting,
  parseResolveResult,
  preselectFor,
  selectorFor,
  selectorForCopilot,
  type ChatModelEntry,
  type ResolvedModel,
} from "../../src/chatModel.js";

const luna: ChatModelEntry = { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", vendor: "copilot", family: "gpt-5.6-luna" };
const lunaAgentHost: ChatModelEntry = { id: "agent-host-copilotcli:gpt-5.6-luna", name: "GPT 5.6 Luna", vendor: "agent-host-copilotcli" };
const grok: ChatModelEntry = { id: "grok-4", name: "Grok 4", vendor: "grok", family: "grok-4" };
const models = [luna, lunaAgentHost, grok];

const lunaQualified: ResolvedModel = { qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" };
const lunaUnqualified: ResolvedModel = { qualified: "GPT 5.6 Luna", name: "GPT 5.6 Luna", vendor: null, copilotModel: "gpt-5.6-luna" };
const noAlias: ResolvedModel = { qualified: "Grok 4 (grok)", name: "Grok 4", vendor: "grok", copilotModel: null };

test("parseResolveResult parses a qualified resolve", () => {
  const parsed = parseResolveResult({ status: "ok", command: "delivery-status", role: "secondary", qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" });
  assert.deepEqual(parsed, { kind: "resolved", model: { qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" } });
});

test("parseResolveResult parses an unqualified resolve as vendor null", () => {
  const parsed = parseResolveResult({ status: "ok", command: "delivery-status", role: "secondary", qualified: "GPT 5.6 Luna", name: "GPT 5.6 Luna", vendor: null, copilotModel: "gpt-5.6-luna" });
  assert.deepEqual(parsed, { kind: "resolved", model: { qualified: "GPT 5.6 Luna", name: "GPT 5.6 Luna", vendor: null, copilotModel: "gpt-5.6-luna" } });
});

test("parseResolveResult treats an unpinned command as a no-pin reason", () => {
  const parsed = parseResolveResult({ status: "ok", command: "delivery-status", role: "secondary", qualified: null, name: null, vendor: null, copilotModel: null });
  assert.deepEqual(parsed, { kind: "reason", reason: "no pin for delivery-status in the secondary role" });
});

test("parseResolveResult surfaces a not-found message", () => {
  const parsed = parseResolveResult({ status: "not-found", command: "bogus", message: "no prompt named \"bogus\" in .github/prompts" });
  assert.deepEqual(parsed, { kind: "reason", reason: "no prompt named \"bogus\" in .github/prompts" });
});

test("parseResolveResult rejects non-object, invalid, and unknown-status output", () => {
  for (const input of [null, undefined, "json", 42, [], { status: "error", message: "boom" }]) {
    assert.deepEqual(parseResolveResult(input), { kind: "reason", reason: input && (input as { message?: string }).message ? "boom" : "unable to parse models resolve output" });
  }
});

test("selectorFor matches an exact vendor + name", () => {
  assert.deepEqual(selectorFor(lunaQualified, models), { selector: { vendor: "copilot", id: "gpt-5.6-luna" } });
});

test("selectorFor matches a unique unqualified name across vendors", () => {
  assert.deepEqual(selectorFor({ ...lunaUnqualified, name: "Grok 4", qualified: "Grok 4" }, models), { selector: { vendor: "grok", id: "grok-4" } });
});

test("selectorFor rejects an ambiguous unqualified name", () => {
  // "GPT 5.6 Luna" exists under both `copilot` and `agent-host-copilotcli`.
  const result = selectorFor(lunaUnqualified, models);
  assert.equal(result.selector, null);
  assert.match((result as { reason: string }).reason, /ambiguous model name GPT 5\.6 Luna/);
});

test("selectorFor reports no installed model for a qualified value", () => {
  const result = selectorFor({ qualified: "Claude Opus 5.5 (anthropic)", name: "Claude Opus 5.5", vendor: "anthropic", copilotModel: null }, models);
  assert.deepEqual(result, { selector: null, reason: "no installed model matches Claude Opus 5.5 (anthropic)" });
});

test("selectorFor skips an entry without an id", () => {
  const result = selectorFor({ qualified: "Grok 4 (grok)", name: "Grok 4", vendor: "grok", copilotModel: null }, [{ id: null, name: "Grok 4", vendor: "grok" }]);
  assert.deepEqual(result, { selector: null, reason: "no installed model matches Grok 4 (grok)" });
});

test("selectorForCopilot sends the Copilot id", () => {
  assert.deepEqual(selectorForCopilot(lunaQualified), { selector: { id: "gpt-5.6-luna" } });
});

test("selectorForCopilot names the alias verb when there is no Copilot id", () => {
  const result = selectorForCopilot(noAlias);
  assert.equal(result.selector, null);
  assert.deepEqual(result, { selector: null, reason: "no Copilot id for Grok 4 (grok); set one with agento.mjs models alias set <picker> <id>" });
});

test("preselectFor routes local, copilot, and off", () => {
  assert.deepEqual(preselectFor("local", { kind: "resolved", model: lunaQualified }, models), { selector: { vendor: "copilot", id: "gpt-5.6-luna" } });
  assert.deepEqual(preselectFor("copilot", { kind: "resolved", model: lunaQualified }, models), { selector: { id: "gpt-5.6-luna" } });
  assert.deepEqual(preselectFor("off", { kind: "resolved", model: lunaQualified }, models), {
    selector: null,
    off: { qualified: "GPT 5.6 Luna (copilot)", copilotModel: "gpt-5.6-luna" },
  });
});

test("preselectFor falls through to a reason when the resolve has no model", () => {
  const reason = { kind: "reason", reason: "no pin for delivery-status in the secondary role" } as const;
  for (const setting of ["off", "local", "copilot"] as const) {
    assert.deepEqual(preselectFor(setting, reason, models), { selector: null, reason: "no pin for delivery-status in the secondary role" });
  }
});

test("chatModelSetting normalizes unknown values to off", () => {
  assert.equal(chatModelSetting("local"), "local");
  assert.equal(chatModelSetting("copilot"), "copilot");
  assert.equal(chatModelSetting("off"), "off");
  assert.equal(chatModelSetting(undefined), "off");
  assert.equal(chatModelSetting("garbage"), "off");
  assert.equal(chatModelSetting(3), "off");
});
