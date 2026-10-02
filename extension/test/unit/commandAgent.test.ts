import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { commandName, readCommandAgent, resolveChatMode, resolveCommandFile } from "../../src/commandAgent.js";

test("commandName extracts the canonical command name", () => {
  assert.equal(commandName("/agento new-feature widget"), "new-feature");
  assert.equal(commandName("/agento delivery-status"), "delivery-status");
  assert.equal(commandName("/agento ap"), "ap");
});

test("commandName returns null for non-canonical commands", () => {
  assert.equal(commandName("/agento"), null);
  assert.equal(commandName("agento new-feature"), null);
  assert.equal(commandName("/agento New-Feature widget"), null);
  assert.equal(commandName(""), null);
});

test("readCommandAgent returns the quoted agent scalar", () => {
  assert.equal(readCommandAgent('---\nagent: "📋 Agento Planner"\n---\n'), "📋 Agento Planner");
});

test("readCommandAgent returns a bare agent scalar", () => {
  assert.equal(readCommandAgent('---\nagent: agent\n---\n'), "agent");
});

test("readCommandAgent returns null without frontmatter or an agent line", () => {
  assert.equal(readCommandAgent("no frontmatter"), null);
  assert.equal(readCommandAgent('---\ndescription: hi\n---\n'), null);
  assert.equal(readCommandAgent('---\nunterminated'), null);
});

test("resolveChatMode resolves a planner command to its agent name", () => {
  const result = resolveChatMode("/agento new-feature widget", {
    pluginRoot: "/plugin",
    readFile: (filePath) => {
      assert.equal(filePath, path.join("/plugin", "commands", "new-feature.md"));
      return '---\nagent: "📋 Agento Planner"\n---\n';
    },
  });
  assert.deepEqual(result, { mode: "📋 Agento Planner" });
});

test("resolveChatMode maps built-in and missing agent to the built-in agent", () => {
  assert.deepEqual(resolveChatMode("/agento delivery-status", {
    pluginRoot: "/plugin",
    readFile: () => '---\nagent: "agent"\n---\n',
  }), { mode: "agent" });
  assert.deepEqual(resolveChatMode("/agento agento-init", {
    pluginRoot: "/plugin",
    readFile: () => '---\ndescription: no agent line\n---\n',
  }), { mode: "agent" });
});

test("resolveChatMode reports a missing plugin root", () => {
  assert.deepEqual(resolveChatMode("/agento new-feature widget", {
    pluginRoot: null,
    readFile: () => { throw new Error("unused"); },
  }), { mode: null, reason: "no plugin root" });
});

test("resolveChatMode reports an unreadable command file", () => {
  assert.deepEqual(resolveChatMode("/agento new-feature widget", {
    pluginRoot: "/plugin",
    readFile: () => { throw new Error("ENOENT"); },
  }), { mode: null, reason: "unreadable command file /plugin/commands/new-feature.md: ENOENT" });
});

test("resolveChatMode reports a non-canonical command", () => {
  assert.deepEqual(resolveChatMode("not a command", {
    pluginRoot: "/plugin",
    readFile: () => { throw new Error("unused"); },
  }), { mode: null, reason: "not a canonical /agento command" });
});

test("resolveCommandFile resolves the command file path", () => {
  assert.deepEqual(resolveCommandFile("/agento new-feature widget", {
    pluginRoot: "/plugin",
    exists: (filePath) => {
      assert.equal(filePath, path.join("/plugin", "commands", "new-feature.md"));
      return true;
    },
  }), { path: path.join("/plugin", "commands", "new-feature.md") });
});

test("resolveCommandFile reports a non-canonical command", () => {
  assert.deepEqual(resolveCommandFile("not a command", {
    pluginRoot: "/plugin",
    exists: () => { throw new Error("unused"); },
  }), { path: null, reason: "not a canonical /agento command" });
});

test("resolveCommandFile reports a missing plugin root", () => {
  assert.deepEqual(resolveCommandFile("/agento new-feature widget", {
    pluginRoot: null,
    exists: () => { throw new Error("unused"); },
  }), { path: null, reason: "no plugin root" });
});

test("resolveCommandFile reports a missing command file", () => {
  assert.deepEqual(resolveCommandFile("/agento new-feature widget", {
    pluginRoot: "/plugin",
    exists: () => false,
  }), { path: null, reason: "missing command file /plugin/commands/new-feature.md" });
});
