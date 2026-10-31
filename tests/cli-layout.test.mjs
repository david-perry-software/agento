import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(repositoryRoot, "scripts");
const commandsDir = path.join(scriptsDir, "commands");
const libDir = path.join(scriptsDir, "lib");
const dispatcher = path.join(scriptsDir, "agento.mjs");

const dispatcherSource = fs.readFileSync(dispatcher, "utf8");

function usageHeaderCommands() {
  const matches = [...dispatcherSource.matchAll(/^\/\/   node scripts\/agento\.mjs ([a-z][a-z-]*)/gm)];
  return matches.map((m) => m[1]);
}

function commandModulesTable() {
  const block = dispatcherSource.match(/const COMMAND_MODULES = \{([\s\S]*?)\};/);
  assert.ok(block, "COMMAND_MODULES table is present");
  const entries = {};
  for (const m of block[1].matchAll(/"?([a-z-]+)"?:\s*"([a-z-]+)"/g)) {
    entries[m[1]] = m[2];
  }
  return entries;
}

function importSpecifiers(file) {
  const source = fs.readFileSync(file, "utf8");
  const specs = [];
  for (const m of source.matchAll(/(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/g)) {
    specs.push(m[1]);
  }
  return specs;
}

function listModules(dir, excludeTest = false) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && !(excludeTest && f.endsWith(".test.mjs"))).sort();
}

test("scripts/agento.mjs is a thin dispatcher of at most 200 lines with no function declarations", () => {
  const lines = dispatcherSource.split("\n").length;
  assert.ok(lines <= 200, `dispatcher is ${lines} lines, expected <= 200`);
  assert.ok(!/function\b/.test(dispatcherSource), "dispatcher declares no function keyword");
  assert.ok(!/=>/.test(dispatcherSource), "dispatcher declares no arrow functions");
});

test("COMMAND_MODULES and the usage-header subcommands match, both ways", () => {
  const table = commandModulesTable();
  const header = usageHeaderCommands();
  const tableKeys = Object.keys(table).sort();
  const headerSorted = [...header].sort();
  assert.deepEqual(tableKeys, [...new Set(headerSorted)], "every subcommand is in COMMAND_MODULES");
  assert.deepEqual(headerSorted, tableKeys, "every COMMAND_MODULES entry is in the usage header");
});

test("every COMMAND_MODULES entry resolves to a module exporting that handler", async () => {
  const table = commandModulesTable();
  const modules = new Set(Object.values(table));
  for (const module of modules) {
    const mod = await import(`../scripts/commands/${module}.mjs`);
    assert.ok(mod.commands, `${module}.mjs exports a commands map`);
  }
  for (const [command, module] of Object.entries(table)) {
    const mod = await import(`../scripts/commands/${module}.mjs`);
    assert.equal(typeof mod.commands[command], "function", `${module}.mjs exports handler for ${command}`);
  }
});

test("no command module imports another command module or agento.mjs; no lib module imports commands/", () => {
  const commandModules = listModules(commandsDir, true);
  const libModules = listModules(libDir, true);
  for (const file of commandModules) {
    for (const spec of importSpecifiers(path.join(commandsDir, file))) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(path.join(commandsDir, file)), spec);
      assert.ok(
        !resolved.startsWith(commandsDir + path.sep) && resolved !== dispatcher,
        `${file} must not import ${spec}`,
      );
    }
  }
  for (const file of libModules) {
    for (const spec of importSpecifiers(path.join(libDir, file))) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(path.join(libDir, file)), spec);
      assert.ok(!resolved.startsWith(commandsDir + path.sep), `${file} must not import ${spec}`);
    }
  }
});

test("no non-test module under scripts/commands/ or scripts/lib/ exceeds 1,500 lines", () => {
  const files = [
    ...listModules(commandsDir, true).map((f) => path.join(commandsDir, f)),
    ...listModules(libDir, true).map((f) => path.join(libDir, f)),
  ];
  for (const full of files) {
    const lines = fs.readFileSync(full, "utf8").split("\n").length;
    assert.ok(lines <= 1500, `${path.relative(repositoryRoot, full)} is ${lines} lines, expected <= 1500`);
  }
});
