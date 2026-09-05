import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Structural checks for the Copilot customization files. One malformed agent file
// silently drops every custom agent, and a mistyped agent name silently breaks a
// prompt or handoff — so these are asserted here rather than discovered in the editor.

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rel = (...parts) => path.join(repoRoot, ...parts);

function listFiles(dir, suffix) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(dir, name))
    .sort();
}

function splitFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  assert.ok(match, `${path.relative(repoRoot, file)} has no closed frontmatter block`);
  return { frontmatter: match[1], body: match[2] };
}

// Minimal parser for the YAML subset these files use: top-level `key: value`, quoted
// strings, flow sequences `[a, b]`, and a `handoffs:` block list of maps.
function parseFrontmatter(raw, file) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let listKey = null;
  let current = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    assert.doesNotMatch(line, /\t/, `${file}: tab in frontmatter`);
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      listKey = null;
      const [, key, value] = top;
      if (value === "") {
        result[key] = [];
        listKey = key;
      } else {
        result[key] = parseScalar(value, file);
      }
      continue;
    }
    const item = line.match(/^ {2}- ([A-Za-z][\w-]*):\s*(.*)$/);
    if (item && listKey) {
      current = { [item[1]]: parseScalar(item[2], file) };
      result[listKey].push(current);
      continue;
    }
    const field = line.match(/^ {4}([A-Za-z][\w-]*):\s*(.*)$/);
    if (field && current) {
      current[field[1]] = parseScalar(field[2], file);
      continue;
    }
    assert.fail(`${file}: unexpected frontmatter line: ${JSON.stringify(line)}`);
  }
  return result;
}

function parseScalar(value, file) {
  if (value.startsWith("[")) {
    assert.ok(value.endsWith("]"), `${file}: unterminated list ${value}`);
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^["']|["']$/g, ""));
  }
  if (/^".*"$/.test(value)) return JSON.parse(value);
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  assert.doesNotMatch(value, /^[^"'].*: /, `${file}: unquoted colon in value ${JSON.stringify(value)}`);
  return value;
}

const agentFiles = listFiles(rel(".github", "agents"), ".agent.md");
const promptFiles = listFiles(rel(".github", "prompts"), ".prompt.md");
const instructionFiles = listFiles(rel(".github", "instructions"), ".instructions.md");

const agents = new Map();
for (const file of agentFiles) {
  const { frontmatter } = splitFrontmatter(file);
  agents.set(file, parseFrontmatter(frontmatter, path.relative(repoRoot, file)));
}
const agentNames = new Set([...agents.values()].map((a) => a.name));
const knownSubagents = new Set([...agentNames, "Explore"]);

test("every agent has a unique name, description, and tool list", () => {
  assert.ok(agentFiles.length > 0);
  assert.equal(agentNames.size, agentFiles.length, "duplicate agent names");
  for (const [file, meta] of agents) {
    const label = path.relative(repoRoot, file);
    assert.ok(typeof meta.name === "string" && meta.name.trim(), `${label}: missing name`);
    assert.match(meta.description ?? "", /Use when/, `${label}: description should start with a trigger phrase`);
    assert.ok(Array.isArray(meta.tools) && meta.tools.length > 0, `${label}: missing tools`);
    if (meta.agents) {
      assert.ok(meta.tools.includes("agent"), `${label}: lists agents: but not the agent tool`);
      for (const sub of meta.agents) {
        assert.ok(knownSubagents.has(sub), `${label}: unknown subagent ${JSON.stringify(sub)}`);
      }
    }
    for (const handoff of meta.handoffs ?? []) {
      assert.ok(handoff.label && handoff.agent && handoff.prompt, `${label}: incomplete handoff`);
      assert.ok(agentNames.has(handoff.agent), `${label}: handoff to unknown agent ${JSON.stringify(handoff.agent)}`);
    }
  }
});

test("every prompt dispatches to a real agent and has no name override", () => {
  assert.ok(promptFiles.length > 0);
  for (const file of promptFiles) {
    const label = path.relative(repoRoot, file);
    const { frontmatter, body } = splitFrontmatter(file);
    const meta = parseFrontmatter(frontmatter, label);
    assert.ok(meta.description, `${label}: missing description`);
    assert.equal(meta.name, undefined, `${label}: name: overrides the slash command; use the filename`);
    if (meta.agent !== undefined) {
      assert.ok(meta.agent === "agent" || agentNames.has(meta.agent), `${label}: agent ${JSON.stringify(meta.agent)} does not exist`);
    }
    assert.ok(body.trim().length > 0, `${label}: empty body`);
  }
});

test("every instruction file has a description and applyTo", () => {
  for (const file of instructionFiles) {
    const label = path.relative(repoRoot, file);
    const meta = parseFrontmatter(splitFrontmatter(file).frontmatter, label);
    assert.ok(meta.description, `${label}: missing description`);
    assert.ok(meta.applyTo, `${label}: missing applyTo`);
  }
});

test("relative links inside agents, prompts, and instructions resolve", () => {
  for (const file of [...agentFiles, ...promptFiles, ...instructionFiles]) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, target] of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+|[\w-]+\.instructions\.md)\)/g)) {
      const resolved = path.resolve(path.dirname(file), target);
      assert.ok(fs.existsSync(resolved), `${path.relative(repoRoot, file)}: broken link ${target}`);
    }
  }
});

test("every slash command is documented in README.md and docs/commands.md", () => {
  const readme = fs.readFileSync(rel("README.md"), "utf8");
  const commands = fs.readFileSync(rel("docs", "commands.md"), "utf8");
  for (const file of promptFiles) {
    const command = "/" + path.basename(file, ".prompt.md");
    assert.ok(readme.includes(command), `README.md does not list ${command}`);
    assert.ok(commands.includes(command), `docs/commands.md does not list ${command}`);
  }
});

test("plugin manifest and hook wiring point at existing executable files", () => {
  const plugin = JSON.parse(fs.readFileSync(rel("plugin.json"), "utf8"));
  assert.ok(fs.existsSync(rel(plugin.agents)), `plugin.agents ${plugin.agents} missing`);
  assert.ok(fs.existsSync(rel(plugin.commands)), `plugin.commands ${plugin.commands} missing`);
  const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version, "plugin.json and package.json versions differ");

  const checkHooks = (file, resolve) => {
    const wiring = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const entries of Object.values(wiring.hooks)) {
      for (const entry of entries) {
        const script = resolve(entry.command);
        assert.ok(fs.existsSync(script), `${path.relative(repoRoot, file)}: ${entry.command} missing`);
        assert.ok(fs.statSync(script).mode & 0o111, `${script} is not executable`);
        assert.ok(Number.isInteger(entry.timeout) && entry.timeout > 0, `${entry.command}: timeout missing`);
      }
    }
  };
  checkHooks(rel(plugin.hooks), (cmd) => rel(cmd.replace("${PLUGIN_ROOT}/", "")));
  for (const file of listFiles(rel(".github", "hooks"), ".json")) {
    checkHooks(file, (cmd) => rel(cmd.replace(/^\.\//, "")));
  }
});
