import assert from "node:assert/strict";
import test from "node:test";

import {
  chatModelSetting,
  createChatModelResolver,
  parseResolveResult,
  preselectFor,
  resolveChatModelRole,
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

test("resolveChatModelRole buckets plan/build/freehand as secondary and everything else as primary", () => {
  for (const role of ["plan", "build", "freehand"]) {
    assert.equal(resolveChatModelRole(role), "secondary", `${role} is secondary`);
  }
  for (const role of ["primary", "unmanaged", null, "unknown"]) {
    assert.equal(resolveChatModelRole(role), "primary", `${String(role)} is primary`);
  }
});

function resolverHarness(setting: "off" | "local" | "copilot", overrides: Partial<Parameters<typeof createChatModelResolver>[0]> = {}) {
  const runs: { args: string[]; root: string; runOptions?: { timeoutMs?: number } }[] = [];
  const listedVendors: (string | undefined)[] = [];
  const runCli = async (args: string[], root: string, runOptions?: { timeoutMs?: number }) => {
    runs.push({ args, root, runOptions });
    return { code: 0, json: { status: "ok", command: "delivery-status", role: "secondary", qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" }, stderr: "" };
  };
  const listModels = async (vendor?: string) => {
    listedVendors.push(vendor);
    return [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", vendor: "copilot" }];
  };
  const resolve = createChatModelResolver({
    pluginRoot: "/repo",
    sessionRole: "plan",
    setting,
    runCli,
    listModels,
    commandName: (command) => (command.startsWith("/agento ") ? command.split(/\s+/)[1] : null),
    timeoutMs: 5000,
    ...overrides,
  });
  return { resolve, runs, listedVendors };
}

test("the resolver passes --role secondary for plan/build/freehand and primary otherwise", async () => {
  for (const sessionRole of ["plan", "build", "freehand"] as const) {
    const { resolve, runs } = resolverHarness("off", { sessionRole });
    const result = await resolve("/agento delivery-status");
    assert.deepEqual(runs[0]!.args, ["models", "resolve", "delivery-status", "--role", "secondary", "--plugin-root", "/repo"], `${sessionRole} → secondary`);
    assert.equal(result.selector, null);
    assert.ok("off" in result);
  }
  for (const sessionRole of ["primary", "unmanaged", null] as const) {
    const { resolve, runs } = resolverHarness("off", { sessionRole });
    await resolve("/agento delivery-status");
    assert.deepEqual(runs[0]!.args, ["models", "resolve", "delivery-status", "--role", "primary", "--plugin-root", "/repo"], `${String(sessionRole)} → primary`);
  }
});

test("the resolver sends { vendor, id } for local and lists models filtered by vendor", async () => {
  const { resolve, runs, listedVendors } = resolverHarness("local");
  const result = await resolve("/agento delivery-status");
  assert.deepEqual(result, { selector: { vendor: "copilot", id: "gpt-5.6-luna" } });
  assert.equal(runs.length, 1);
  assert.equal(runOptionsOf(runs[0]), 5000);
  assert.deepEqual(listedVendors, ["copilot"]);
});

test("the resolver sends { id } for copilot without a vscode.lm lookup", async () => {
  const { resolve, listedVendors } = resolverHarness("copilot");
  const result = await resolve("/agento delivery-status");
  assert.deepEqual(result, { selector: { id: "gpt-5.6-luna" } });
  assert.deepEqual(listedVendors, [], "copilot performs no vscode.lm lookup");
});

test("the resolver returns the off shape without a vscode.lm lookup", async () => {
  const { resolve, listedVendors } = resolverHarness("off");
  const result = await resolve("/agento delivery-status");
  assert.deepEqual(result, { selector: null, off: { qualified: "GPT 5.6 Luna (copilot)", copilotModel: "gpt-5.6-luna" } });
  assert.deepEqual(listedVendors, [], "off performs no vscode.lm lookup");
});

test("the resolver falls back on a missing root, a CLI error, a timeout, and a non-canonical command", async () => {
  const noRoot = resolverHarness("local", { pluginRoot: null });
  assert.deepEqual(await noRoot.resolve("/agento delivery-status"), { selector: null, reason: "no plugin root" });

  const cliError = resolverHarness("local", { runCli: async () => { throw new Error("CLI exploded"); } });
  assert.deepEqual(await cliError.resolve("/agento delivery-status"), { selector: null, reason: "CLI exploded" });

  const timedOut = resolverHarness("local", { runCli: async () => { throw new Error("Agento CLI timed out after 5000 ms"); } });
  assert.deepEqual(await timedOut.resolve("/agento delivery-status"), { selector: null, reason: "Agento CLI timed out after 5000 ms" });

  const nonCanonical = resolverHarness("local");
  assert.deepEqual(await nonCanonical.resolve("hello there"), { selector: null, reason: "not a canonical /agento command: hello there" });
});

test("the resolver surfaces an unpinned resolve as a reason and a listModels failure as a reason", async () => {
  const unpinned = resolverHarness("local", {
    runCli: async () => ({ code: 0, json: { status: "ok", command: "delivery-status", role: "secondary", qualified: null, name: null, vendor: null, copilotModel: null }, stderr: "" }),
  });
  assert.deepEqual(await unpinned.resolve("/agento delivery-status"), { selector: null, reason: "no pin for delivery-status in the secondary role" });

  const listFailure = resolverHarness("local", { listModels: async () => { throw new Error("vscode.lm unavailable"); } });
  assert.deepEqual(await listFailure.resolve("/agento delivery-status"), { selector: null, reason: "vscode.lm unavailable" });
});

function runOptionsOf(run: { args: string[]; root: string; runOptions?: { timeoutMs?: number } }): number | undefined {
  return run.runOptions?.timeoutMs;
}

test("the resolver reads a setting getter on every dispatch", async () => {
  let current: "off" | "local" | "copilot" = "off";
  const resolve = createChatModelResolver({
    pluginRoot: "/repo",
    sessionRole: "plan",
    setting: () => current,
    runCli: async () => ({ code: 0, json: { status: "ok", command: "delivery-status", role: "secondary", qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" }, stderr: "" }),
    listModels: async () => [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", vendor: "copilot" }],
    commandName: (command) => command.split(/\s+/)[1] ?? null,
  });
  assert.ok("off" in await resolve("/agento delivery-status"));
  current = "copilot";
  assert.deepEqual(await resolve("/agento delivery-status"), { selector: { id: "gpt-5.6-luna" } });
  current = "local";
  assert.deepEqual(await resolve("/agento delivery-status"), { selector: { vendor: "copilot", id: "gpt-5.6-luna" } });
});

test("the resolver reads pluginRoot and sessionRole getters on every dispatch", async () => {
  let pluginRoot: string | null = null;
  let sessionRole: string | null = "primary";
  const runs: string[][] = [];
  const resolve = createChatModelResolver({
    pluginRoot: () => pluginRoot,
    sessionRole: () => sessionRole,
    setting: "local",
    runCli: async (args) => { runs.push(args); return { code: 0, json: { status: "ok", command: "delivery-status", role: "primary", qualified: "GPT 5.6 Luna (copilot)", name: "GPT 5.6 Luna", vendor: "copilot", copilotModel: "gpt-5.6-luna" }, stderr: "" }; },
    listModels: async () => [{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", vendor: "copilot" }],
    commandName: (command) => command.split(/\s+/)[1] ?? null,
  });
  assert.deepEqual(await resolve("/agento delivery-status"), { selector: null, reason: "no plugin root" });
  pluginRoot = "/repo";
  assert.deepEqual(await resolve("/agento delivery-status"), { selector: { vendor: "copilot", id: "gpt-5.6-luna" } });
  assert.equal(runs[0]![3], "--role");
  assert.equal(runs[0]![4], "primary");
  sessionRole = "build";
  await resolve("/agento delivery-status");
  assert.equal(runs[1]![4], "secondary", "the role getter is read per dispatch");
});
