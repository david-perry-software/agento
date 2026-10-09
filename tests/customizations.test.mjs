import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

// VS Code Autopilot mode auto-selects `send: true` handoffs, so a cycle among them
// (Reviewer → Builder → Reviewer on an approve) never terminates.
test("auto-sent handoffs form no cycle", () => {
  const byName = new Map([...agents.values()].map((a) => [a.name, a]));
  const visit = (name, trail) => {
    assert.ok(!trail.includes(name), `send: true handoff cycle: ${[...trail, name].join(" → ")}`);
    for (const handoff of byName.get(name)?.handoffs ?? []) {
      if (handoff.send === true) visit(handoff.agent, [...trail, name]);
    }
  };
  for (const name of byName.keys()) visit(name, []);
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

test("policy section references (§N) point at sections that exist", () => {
  const policy = fs.readFileSync(rel(".github", "instructions", "delivery-policy.instructions.md"), "utf8");
  const sections = new Set([...policy.matchAll(/^## (\d+)\. /gm)].map((m) => m[1]));
  assert.ok(sections.size >= 12, "policy file lost sections");
  for (const file of [...agentFiles, ...promptFiles, ...instructionFiles]) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, n] of text.matchAll(/§(\d+)/g)) {
      assert.ok(sections.has(n), `${path.relative(repoRoot, file)}: §${n} does not exist in delivery-policy.instructions.md`);
    }
  }
});

test("every command and agent opens and closes with the §9 receipt", () => {
  const missing = [];
  for (const file of [...promptFiles, ...agentFiles]) {
    if (!/§9\b/.test(splitFrontmatter(file).body)) missing.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(missing, [], `files that do not cite policy §9 (execution receipts):\n${missing.join("\n")}`);
});

test("every command and agent declares its window check (§11)", () => {
  const missing = [];
  for (const file of [...promptFiles, ...agentFiles]) {
    if (!/Window check per .*§11.*requires role/.test(splitFrontmatter(file).body)) missing.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(missing, [], `files that do not declare a §11 window check (requires role):\n${missing.join("\n")}`);
});

test("every command and agent cites the §12 command presentation rule", () => {
  const missing = [];
  for (const file of [...promptFiles, ...agentFiles]) {
    if (!/§12\b/.test(splitFrontmatter(file).body)) missing.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(missing, [], `files that do not cite policy §12 (command presentation):\n${missing.join("\n")}`);
});

test("next-feature prints one command per fenced block", () => {
  // The only prompt that scripts a multi-command report; policy §12 wants one bare
  // block per command so the chat copy button yields a paste-ready command.
  const file = rel(".github", "prompts", "next-feature.prompt.md");
  const lines = splitFrontmatter(file).body.split(/\r?\n/);
  let block = null;
  let blocks = 0;
  lines.forEach((line, index) => {
    const fence = line.match(/^\s*(```.*)$/);
    if (!fence) {
      if (block && line.trim()) block.push(line.trim());
      return;
    }
    if (!block) {
      assert.equal(fence[1], "```", `next-feature.prompt.md:${index + 1}: fenced block must have no language tag`);
      block = [];
      return;
    }
    blocks += 1;
    assert.equal(block.length, 1, `next-feature.prompt.md:${index + 1}: fenced block must hold exactly one command, got ${JSON.stringify(block)}`);
    assert.match(block[0], /^\/agento /, `next-feature.prompt.md:${index + 1}: block content must be an /agento command`);
    assert.doesNotMatch(block[0], /#/, `next-feature.prompt.md:${index + 1}: block content must not carry a # comment`);
    block = null;
  });
  assert.equal(block, null, "next-feature.prompt.md: unterminated fenced block");
  assert.ok(blocks >= 5, `next-feature.prompt.md: expected the five-step command list, found ${blocks} blocks`);
});

test("build and review handoffs offer the /agento ap alternative", () => {
  // Policy §12: every build-<type>/review-<type> command block is followed by an
  // `/agento ap <slug>` block as the unattended alternative.
  const files = [
    rel(".github", "agents", "delivery-builder.agent.md"),
    rel(".github", "agents", "delivery-reviewer.agent.md"),
    rel(".github", "agents", "delivery-planner.agent.md"),
    rel(".github", "prompts", "next-feature.prompt.md"),
    rel(".github", "prompts", "ship.prompt.md"),
    rel(".github", "prompts", "new-feature.prompt.md"),
    rel(".github", "prompts", "new-issue.prompt.md"),
  ];
  const missing = files
    .filter((file) => !/\/agento ap <(?:feature-)?slug>/.test(splitFrontmatter(file).body))
    .map((file) => path.relative(repoRoot, file));
  assert.deepEqual(missing, [], `files whose build/review handoff lacks the /agento ap alternative:\n${missing.join("\n")}`);
  assert.match(
    fs.readFileSync(rel("docs", "commands.md"), "utf8"),
    /## Receipts[\s\S]*?\/agento ap[\s\S]*?\n## /,
    "docs/commands.md ## Receipts must mention the /agento ap alternative",
  );
});

test("status: paused is reserved for the user; the Autopilot resumes session breaks", () => {
  // Policy §3 "Pause kinds": a Builder stopping for session length keeps
  // `in-progress`; `paused` carries a `(manual)` or `blocked:` marker in next-step,
  // and the Autopilot only stops on that marker — never on a bare `paused`.
  const policy = fs.readFileSync(rel(".github", "instructions", "delivery-policy.instructions.md"), "utf8");
  assert.match(policy, /\*\*Pause kinds\.\*\*/, "delivery-policy §3 must define the pause kinds");
  assert.match(policy, /session break/, "delivery-policy §3 must name the session break");
  const builder = splitFrontmatter(rel(".github", "agents", "delivery-builder.agent.md")).body;
  assert.match(builder, /\*\*Session break\*\*[\s\S]*?`status: in-progress`/, "Builder pause protocol must keep in-progress on a session break");
  assert.match(builder, /\*\*Pause\*\*[\s\S]*?`status: paused`[\s\S]*?\(manual\)[\s\S]*?blocked:/, "Builder pause protocol must mark paused next-steps");
  const autopilot = splitFrontmatter(rel(".github", "agents", "delivery-autopilot.agent.md")).body;
  assert.doesNotMatch(autopilot, /If `status:\s+paused`, relay/, "Autopilot preflight must not stop on every paused roadmap");
  assert.match(autopilot, /`status:\s+paused` and `next-step` carries a `\(manual\)` or `blocked:` marker/, "Autopilot preflight must inspect the next-step marker");
  assert.match(autopilot, /legacy session break/, "Autopilot must resume a legacy paused roadmap without a marker");
  assert.match(autopilot, /`status: in-progress` \(the Builder took a session break/, "Autopilot loop must re-invoke the Builder after a session break");
  for (const file of [rel(".github", "prompts", "ap.prompt.md"), rel("commands", "ap.md")]) {
    assert.match(fs.readFileSync(file, "utf8"), /session break/, `${path.relative(repoRoot, file)} must describe session-break resumption`);
  }
});

test("start-session and start-freehand write the workspace file through the CLI (#58 session-auto-approve)", () => {
  // start-session delegates the whole start (workspace file included) to `agento.mjs start-session`.
  const pairs = [
    [rel(".github", "prompts", "start-session.prompt.md"), rel("commands", "start-session.md"), /agento\.mjs start-session/],
    [rel(".github", "prompts", "start-freehand.prompt.md"), rel("commands", "start-freehand.md"), /agento\.mjs workspace/],
  ];
  for (const [prompt, mirror, call] of pairs) {
    const promptBody = splitFrontmatter(prompt).body;
    const mirrorBody = fs.readFileSync(mirror, "utf8");
    assert.doesNotMatch(promptBody, /settings:\s*\{\}/, `${path.relative(repoRoot, prompt)} should not hand-write settings: {}`);
    assert.match(promptBody, call, `${path.relative(repoRoot, prompt)} should call ${call.source}`);
    assert.doesNotMatch(mirrorBody, /settings:\s*\{\}/, `${path.relative(repoRoot, mirror)} should not hand-write settings: {}`);
    assert.match(mirrorBody, call, `${path.relative(repoRoot, mirror)} should call ${call.source}`);
  }
});

test("start-session is one agento.mjs start-session call with no hand-run fallback procedure", () => {
  const prompt = rel(".github", "prompts", "start-session.prompt.md");
  const body = splitFrontmatter(prompt).body;
  assert.equal(fs.readFileSync(rel("commands", "start-session.md"), "utf8"), fs.readFileSync(prompt, "utf8"), "commands/start-session.md must mirror the prompt byte for byte");
  assert.match(body, /node <agento-root>\/scripts\/agento\.mjs start-session /);
  assert.doesNotMatch(body, /git -C <\w+> worktree add/, "the CLI runs git worktree add; the prompt must not");
  assert.doesNotMatch(body, /date -u \+%Y/, "the CLI generates the session id; the prompt must not");
});

test("only worktree-mutating commands inspect `git worktree list --porcelain`", () => {
  // Everyone else reads the session record (policy §11). `ship` stays here until
  // `ship-audit-first` removes its worktree precondition, then the list shrinks to three.
  const allowlist = new Set(["start-session", "start-freehand", "close-session", "ship"]);
  const offenders = [];
  for (const file of [...promptFiles, ...listFiles(rel("commands"), ".md"), ...agentFiles]) {
    const name = path.basename(file).replace(/(?:\.prompt|\.agent)?\.md$/, "");
    if (allowlist.has(name)) continue;
    if (/worktree list\s+--porcelain/.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(offenders, [], `files that inspect worktrees instead of the session record:\n${offenders.join("\n")}`);
});

// The §10 vocabulary, parsed from the policy's "- `<token>` — <meaning>" bullets.
function policyCapabilities() {
  const policy = fs.readFileSync(rel(".github", "instructions", "delivery-policy.instructions.md"), "utf8");
  const section = policy.match(/^## 10\. Capability preflight\r?\n([\s\S]*?)(?=^## |$(?![\r\n]))/m);
  assert.ok(section, "policy has no ## 10. Capability preflight section");
  const vocabulary = section[1].match(/\*\*Vocabulary\*\*[\s\S]*?\n\n([\s\S]*?)\n\n/);
  assert.ok(vocabulary, "§10 has no Vocabulary list");
  const tokens = [...vocabulary[1].matchAll(/^- `([a-z0-9-]+)` — /gm)].map((m) => m[1]);
  assert.ok(tokens.length >= 7, `§10 vocabulary too short: ${tokens.join(", ")}`);
  return new Set(tokens);
}

// The first two non-blank body lines: `Needs: a, b` and `Fallback: …`.
function declarations(file) {
  const label = path.relative(repoRoot, file);
  const lines = splitFrontmatter(file).body.split(/\r?\n/).filter((l) => l.trim());
  const needs = lines[0]?.match(/^Needs: (.+)$/);
  const fallback = lines[1]?.match(/^Fallback: (.+)$/);
  assert.ok(needs, `${label}: first body line must be "Needs: <capability>[, …]", got ${JSON.stringify(lines[0])}`);
  assert.ok(fallback, `${label}: second body line must be "Fallback: <…>", got ${JSON.stringify(lines[1])}`);
  assert.ok(fallback[1].trim(), `${label}: Fallback: is empty`);
  return { label, needs: needs[1].split(",").map((s) => s.trim()), fallback: fallback[1] };
}

test("every command and agent declares Needs: and Fallback: from the §10 vocabulary", () => {
  const vocabulary = policyCapabilities();
  for (const file of [...promptFiles, ...agentFiles]) {
    const { label, needs } = declarations(file);
    assert.ok(needs.length > 0, `${label}: Needs: lists nothing`);
    for (const token of needs) {
      assert.ok(vocabulary.has(token), `${label}: Needs: token ${JSON.stringify(token)} is not in the §10 vocabulary`);
    }
    assert.equal(new Set(needs).size, needs.length, `${label}: Needs: repeats a capability`);
  }
});

// VS Code gives an agent with a `tools:` list only those tools, and no alias covers this one.
const ASK_QUESTIONS_TOOL = "vscode/askQuestions";

test("every agent or tool-restricted prompt that needs ask-questions lists vscode/askQuestions (#90 planner-ask-questions-tool)", () => {
  const missing = [];
  let checked = 0;
  for (const file of [...agentFiles, ...promptFiles]) {
    const label = path.relative(repoRoot, file);
    const meta = parseFrontmatter(splitFrontmatter(file).frontmatter, label);
    if (!Array.isArray(meta.tools) || !declarations(file).needs.includes("ask-questions")) continue;
    checked += 1;
    if (!meta.tools.includes(ASK_QUESTIONS_TOOL)) missing.push(`${path.basename(file)} tools=[${meta.tools.join(", ")}]`);
  }
  assert.ok(checked >= 2, `expected at least the Planner and Architect to be checked, got ${checked}`);
  assert.deepEqual(missing, [], `files that need ask-questions but do not list ${ASK_QUESTIONS_TOOL} in tools:\n${missing.join("\n")}`);
});

test("ask-questions clarification always offers a §10 recommended choice (#90 planner-ask-questions-tool)", () => {
  const policy = fs.readFileSync(rel(".github", "instructions", "delivery-policy.instructions.md"), "utf8");
  const section = policy.match(/^## 10\. Capability preflight\r?\n([\s\S]*?)(?=^## |$(?![\r\n]))/m)?.[1] ?? "";
  const paragraph = section.match(/\*\*Recommended choice\.\*\*[\s\S]*?(?=\n\n|$)/)?.[0];
  assert.ok(paragraph, "delivery-policy §10 must define a **Recommended choice.** paragraph");
  assert.match(paragraph, /`recommended: true`/, "§10 recommended choice must set recommended: true in the question tool");
  assert.match(paragraph, /\(recommended\)/, "§10 recommended choice must mark the fallback option (recommended)");
  const askers = [];
  const missing = [];
  for (const file of [...promptFiles, ...agentFiles, ...listFiles(rel("commands"), ".md")]) {
    const text = fs.readFileSync(file, "utf8");
    if (!/ask-questions\s+tool/.test(text)) continue;
    askers.push(path.basename(file));
    if (!/§10\s+recommended\s+choice/.test(text)) missing.push(path.relative(repoRoot, file));
  }
  for (const agent of ["delivery-planner.agent.md", "initiative-architect.agent.md"]) {
    assert.ok(askers.includes(agent), `${agent} should ask clarifying questions with the ask-questions tool`);
  }
  assert.deepEqual(missing, [], `files that use the ask-questions tool without citing the §10 recommended choice:\n${missing.join("\n")}`);
});

test("prompts and agents never direct users to gh pr edit --body", () => {
  const offenders = [];
  for (const file of [...promptFiles, ...agentFiles]) {
    const text = fs.readFileSync(file, "utf8");
    const hit = text.match(/gh pr edit\b[^\n]*--body/);
    if (hit) offenders.push(`${path.relative(repoRoot, file)}: ${hit[0]}`);
  }
  assert.deepEqual(offenders, [], `customization files still instructing gh pr edit --body:\n${offenders.join("\n")}`);
});

test("the companion concurrency pointer template matches concurrent-delivery's applyTo and names it by plugin path", () => {
  const template = rel("templates", "companion-concurrency.instructions.md");
  assert.ok(fs.existsSync(template), "templates/companion-concurrency.instructions.md is missing");
  const { frontmatter, body } = splitFrontmatter(template);
  const fields = parseFrontmatter(frontmatter, "templates/companion-concurrency.instructions.md");
  assert.equal(typeof fields.description, "string");
  assert.ok(fields.description.length > 0, "pointer template needs a description");
  const policy = parseFrontmatter(splitFrontmatter(rel(".github", "instructions", "concurrent-delivery.instructions.md")).frontmatter, "concurrent-delivery.instructions.md");
  assert.equal(fields.applyTo, policy.applyTo);
  assert.match(body, /`<agento-root>\/\.github\/instructions\/concurrent-delivery\.instructions\.md`/);
  assert.match(body, /Agento CLI: node <agento-root>\/scripts\/agento\.mjs/);
  assert.doesNotMatch(body, /\]\([^)]*concurrent-delivery/, "the pointer must not use a relative link");
});

test("every git clean in prompts, agents, and command mirrors uses --literal-pathspecs (#88 ship-untracked-byproducts)", () => {
  const offenders = [];
  let cleans = 0;
  for (const file of [...promptFiles, ...agentFiles, ...listFiles(rel("commands"), ".md")]) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!/\bclean -f\b/.test(line)) continue;
      cleans += 1;
      if (!/--literal-pathspecs clean -f -- /.test(line)) offenders.push(`${path.relative(repoRoot, file)}: ${line.trim()}`);
    }
  }
  assert.ok(cleans >= 2, "expected the ship prompt's byproduct cleanup and its command mirror");
  assert.deepEqual(offenders, [], `git clean without --literal-pathspecs deletes unlisted glob matches:\n${offenders.join("\n")}`);
});

test("REST PATCH examples render real blank-line newlines (#62 pr-cross-linking-deprecation)", () => {
  const examples = [];
  for (const file of [...promptFiles, ...agentFiles, ...listFiles(rel("commands"), ".md")]) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/gh api repos\/[^\n]+?\/pulls\/[^\n]+? -X PATCH -f body=([^;]+); fi/g)) {
      examples.push({ label: path.relative(repoRoot, file), expression: match[1] });
    }
  }

  assert.equal(examples.length, 9, "expected every PR-body REST PATCH example and command mirror");
  for (const { label, expression } of examples) {
    const rendered = execFileSync("bash", ["-c", `current_body='Existing body'; printf '%s' ${expression}`], { encoding: "utf8" });
    assert.match(rendered, /^Existing body\n\n(?:Companion PR: |Product PR: |Fixes #)\S/, `${label}: body must contain a real blank line`);
    assert.doesNotMatch(rendered, /\$'/, `${label}: body contains literal ANSI-C quote syntax`);
  }
});

test("exactly the commands that need gh, code, or network run doctor --for themselves", () => {
  for (const file of promptFiles) {
    const name = path.basename(file, ".prompt.md");
    const { label, needs } = declarations(file);
    const body = splitFrontmatter(file).body;
    const mustRun = needs.some((n) => ["gh", "code", "network"].includes(n));
    const cites = new RegExp(`doctor --for ${name}\\b`).test(body);
    assert.equal(cites, mustRun, mustRun ? `${label}: needs gh/code/network but never runs doctor --for ${name}` : `${label}: runs doctor --for but declares none of gh, code, network`);
    const others = [...body.matchAll(/doctor --for ([a-z0-9-]+)/g)].map((m) => m[1]).filter((n) => n !== name && n !== "<command>");
    assert.deepEqual(others, [], `${label}: runs doctor --for another command`);
  }
});

test("the CLI needs table agrees with every prompt's Needs: line", () => {
  const cli = path.join(repoRoot, "scripts", "agento.mjs");
  for (const file of promptFiles) {
    const name = path.basename(file, ".prompt.md");
    const { label, needs } = declarations(file);
    const result = spawnSync("node", [cli, "doctor", "--for", name], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: restrictedBin() } });
    assert.notEqual(result.status, 1, `${label}: agento.mjs doctor --for ${name} is a usage error (command missing from the CLI table)`);
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.for, { command: name, needs }, `${label}: CLI table disagrees with the prompt's Needs: line`);
  }
});

// A PATH with node and git only, so the cross-check never probes real gh/code/python3.
let restrictedBinDir;
function restrictedBin() {
  if (restrictedBinDir) return restrictedBinDir;
  restrictedBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-customizations-bin-"));
  fs.symlinkSync(process.execPath, path.join(restrictedBinDir, "node"));
  fs.symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(restrictedBinDir, "git"));
  return restrictedBinDir;
}
test("the policy file is the only place the shared rules are spelled out", () => {
  // Phrases that used to be duplicated across agents/prompts; each may now appear in
  // the policy file and nowhere else in the customization set.
  const canaries = [
    /materially unfaithful/,
    /changed-files-only lint/i,
    /SIGPIPE/,
    /evidence\/step-<N-M>-<short-name>\.png/,
    /never (?:ask|hand) .*(?:the user|to the user).*run the command/i,
    /Receipt: accepted/,
    /Receipt: rejected/,
    /Result: completed/,
    /Result: failed/,
    /duplicate of <op-id>/,
    /^Preflight: /m,
    /; fallback: </,
    /switch to Agent mode/,
    /copyable command block/,
    /delete\s+them, never commit them/,
  ];
  for (const file of [...agentFiles, ...promptFiles, ...instructionFiles]) {
    if (file.endsWith("delivery-policy.instructions.md")) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const canary of canaries) {
      assert.doesNotMatch(text, canary, `${path.relative(repoRoot, file)} restates a policy rule (${canary}); link delivery-policy.instructions.md instead`);
    }
  }
  assert.match(fs.readFileSync(rel(".github", "instructions", "delivery-policy.instructions.md"), "utf8"), /delete\s+them, never commit them/, "policy §7 lost its clean-handoff rule");
  // The ship prompt owns its teardown pause wording (ship-audit-first); nothing else
  // in the customization set restates it.
  const teardownPause = /paused at teardown/;
  for (const file of [...agentFiles, ...promptFiles, ...instructionFiles]) {
    const text = fs.readFileSync(file, "utf8");
    if (file.endsWith("ship.prompt.md")) assert.match(text, teardownPause, "ship.prompt.md lost its teardown pause result line");
    else assert.doesNotMatch(text, teardownPause, `${path.relative(repoRoot, file)} restates the ship teardown pause; only ship.prompt.md spells it out`);
  }
});

test("every slash command is documented in README.md and docs/commands.md", () => {
  const readme = fs.readFileSync(rel("README.md"), "utf8");
  const commands = fs.readFileSync(rel("docs", "commands.md"), "utf8");
  const invocation = commands.match(/^## Invocation\r?\n([\s\S]*?)(?=^## )/m);
  assert.ok(invocation, "docs/commands.md has no ## Invocation section");
  for (const file of promptFiles) {
    const command = "/agento " + path.basename(file, ".prompt.md");
    assert.ok(readme.includes(command), `README.md does not list ${command}`);
    assert.ok(commands.includes(command), `docs/commands.md does not list ${command}`);
    assert.ok(invocation[1].includes(command), `docs/commands.md ## Invocation does not list ${command}`);
  }
});

const commandNames = promptFiles.map((file) => path.basename(file, ".prompt.md"));
const guidanceFiles = [
  rel("README.md"),
  rel("AGENTS.md"),
  ...agentFiles,
  ...promptFiles,
  ...instructionFiles,
  ...listFiles(rel("commands"), ".md"),
  ...listFiles(rel("docs"), ".md"),
  ...listFiles(rel("templates"), ".md"),
];

test("active guidance qualifies Agento slash commands with the plugin name", () => {
  const bareCommand = new RegExp(`(?<![\\w.-])/(?:${commandNames.join("|")})\\b`);
  for (const file of guidanceFiles) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      bareCommand,
      `${path.relative(repoRoot, file)} contains an unqualified Agento command`,
    );
  }
});

test("guidance never writes a command with a .prompt or .md suffix (agento-init.prompt defect)", () => {
  // `/agento agento-init.prompt` was once exported with the wrong path and suffix and
  // then treated as prose. Only the invocation instruction file may quote the bad
  // forms (as redirect examples) and CHANGELOG.md records them as history.
  const suffixedCommand = new RegExp(
    `(?:/agento\\s+|(?<![\\w.-])/)(?:${commandNames.join("|")})\\.(?:prompt\\.md|prompt|md)\\b`,
  );
  const allowlist = new Set(["CHANGELOG.md", ".github/instructions/command-invocation.instructions.md"]);
  for (const file of [...guidanceFiles, rel("CHANGELOG.md")]) {
    const label = path.relative(repoRoot, file);
    if (allowlist.has(label)) continue;
    const hit = fs.readFileSync(file, "utf8").match(suffixedCommand);
    assert.equal(hit, null, `${label} writes a suffixed command ${JSON.stringify(hit?.[0])}; use /agento <name>`);
  }
});

test("guidance never sequences close-session before ship (ship-audit-first)", () => {
  // `/agento ship` audits while the build worktree is open and tears it down after
  // the merge, so no guidance may tell the user to close the session first. Only
  // CHANGELOG.md records the old order as history.
  const closeThenShip = /\/agento close-session\b[^\n]*?(→|\bthen\b|and then)[^\n]*?\/agento ship\b/;
  const shipAfterClose = /\/agento ship\b[^\n]*?\bafter\b[^\n]*?\/agento close-session\b/;
  const allowlist = new Set(["CHANGELOG.md"]);
  const offenders = [];
  for (const file of guidanceFiles) {
    const label = path.relative(repoRoot, file);
    if (allowlist.has(label)) continue;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n\s*\r?\n/)) {
      // Paragraphs wrap; the order is judged on the unwrapped text.
      const paragraph = raw.replace(/\s+/g, " ");
      const hit = paragraph.match(closeThenShip) ?? paragraph.match(shipAfterClose);
      if (hit) offenders.push(`${label}: ${JSON.stringify(hit[0])}`);
    }
  }
  assert.deepEqual(offenders, [], `guidance that sequences close-session before ship:\n${offenders.join("\n")}`);
});

test("command-invocation instructions apply everywhere and list every command", () => {
  const file = rel(".github", "instructions", "command-invocation.instructions.md");
  const label = path.relative(repoRoot, file);
  const { frontmatter, body } = splitFrontmatter(file);
  assert.equal(parseFrontmatter(frontmatter, label).applyTo, "**", `${label}: applyTo must be "**"`);
  for (const name of commandNames) {
    assert.ok(body.includes(`/agento ${name}`), `${label} does not list /agento ${name}`);
  }
  const known = new Set(commandNames);
  for (const [, token] of body.matchAll(/\/agento ([a-z0-9-]+)\b/g)) {
    assert.ok(known.has(token), `${label} lists /agento ${token}, which has no .github/prompts/${token}.prompt.md`);
  }
});

test("plugin manifest uses suffix-less command names and hook wiring points at existing executable files", () => {
  const plugin = JSON.parse(fs.readFileSync(rel(".claude-plugin", "plugin.json"), "utf8"));
  assert.ok(fs.existsSync(rel(plugin.agents)), `plugin.agents ${plugin.agents} missing`);
  assert.ok(fs.existsSync(rel(plugin.commands)), `plugin.commands ${plugin.commands} missing`);
  for (const name of fs.readdirSync(rel(plugin.commands))) {
    assert.match(name, /^[a-z0-9-]+\.md$/, `${plugin.commands}/${name}: command files are <name>.md only (no .prompt suffix)`);
  }
  const pluginCommands = listFiles(rel(plugin.commands), ".md");
  assert.ok(pluginCommands.length > 0, "plugin.commands has no .md command files");
  assert.deepEqual(
    pluginCommands.map((file) => path.basename(file, ".md")),
    promptFiles.map((file) => path.basename(file, ".prompt.md")),
    "plugin commands must mirror workspace prompts without the .prompt suffix",
  );
  for (const commandFile of pluginCommands) {
    const name = path.basename(commandFile, ".md");
    const promptFile = rel(".github", "prompts", `${name}.prompt.md`);
    assert.equal(
      fs.readFileSync(commandFile, "utf8"),
      fs.readFileSync(promptFile, "utf8"),
      `plugin command ${name}.md differs from its workspace prompt`,
    );
  }
  const pkg = JSON.parse(fs.readFileSync(rel("package.json"), "utf8"));
  const extensionPkg = JSON.parse(fs.readFileSync(rel("extension", "package.json"), "utf8"));
  assert.equal(
    plugin.version,
    pkg.version,
    ".claude-plugin/plugin.json, package.json, and extension/package.json versions differ",
  );
  assert.equal(
    extensionPkg.version,
    pkg.version,
    ".claude-plugin/plugin.json, package.json, and extension/package.json versions differ",
  );

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
  checkHooks(rel(plugin.hooks.replace(/^\.\//, "")), (cmd) => {
    assert.match(cmd, /^\$\{CLAUDE_PLUGIN_ROOT\}\//, `plugin hook must use the compatible root token: ${cmd}`);
    return rel(cmd.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  });
  for (const file of listFiles(rel(".github", "hooks"), ".json")) {
    checkHooks(file, (cmd) => rel(cmd.replace(/^\.\//, "")));
  }
});

test("plugin layout is Claude format so VS Code expands ${CLAUDE_PLUGIN_ROOT} (#36 plugin-hooks-layout)", () => {
  // A root plugin.json + hooks.json (Copilot format 0) is parsed by VS Code without
  // substituting the plugin-root token, so every hook spawns as `/scripts/hooks/…`
  // and fails with "not found". Only the .claude-plugin/ + hooks/ layout substitutes.
  const manifestPath = rel(".claude-plugin", "plugin.json");
  assert.ok(fs.existsSync(manifestPath), ".claude-plugin/plugin.json missing");
  const plugin = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.ok(!fs.existsSync(rel("plugin.json")), "root plugin.json must not exist (would shadow the Claude layout)");
  assert.ok(!fs.existsSync(rel("hooks.json")), "root hooks.json must not exist (never read under the Claude layout)");
  assert.equal(plugin.hooks, "./hooks/hooks.json", "manifest hooks field must name ./hooks/hooks.json");
  const hooksPath = rel("hooks", "hooks.json");
  assert.ok(fs.existsSync(hooksPath), "hooks/hooks.json missing");
  const wiring = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  const commands = Object.values(wiring.hooks).flat().map((entry) => entry.command);
  assert.ok(commands.length > 0, "hooks/hooks.json wires no hooks");
  for (const cmd of commands) {
    assert.match(cmd, /^\$\{CLAUDE_PLUGIN_ROOT\}\//, `hook command must start with \${CLAUDE_PLUGIN_ROOT}/: ${cmd}`);
    const script = cmd.replace("${CLAUDE_PLUGIN_ROOT}", repoRoot);
    assert.ok(fs.existsSync(script), `${cmd} does not resolve under the plugin root`);
    assert.ok(fs.statSync(script).isFile() && fs.statSync(script).mode & 0o111, `${script} is not an executable file`);
  }
});

test("committed agents, prompts, and command mirrors carry no model: line", () => {
  const gitOut = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const files = gitOut("ls-tree", "-r", "--name-only", "HEAD", "--", ".github/agents", ".github/prompts", "commands")
    .split("\n")
    .filter((f) => /\.(agent|prompt)\.md$/.test(f) || /^commands\/[^/]+\.md$/.test(f));
  assert.ok(files.length > 0, "no agents, prompts, or command mirrors at HEAD");
  for (const file of files) {
    const frontmatter = gitOut("show", `HEAD:${file}`).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "";
    assert.doesNotMatch(frontmatter, /^[ \t]*model:/m, `${file} is committed with a model: line (top-level or inside a handoffs: item); model profiles are applied locally — run \`agento.mjs models clear\`, then commit`);
  }
});

test("the Autopilot pins subagent models via models pins and stops on a tier refusal (#79)", () => {
  const autopilot = splitFrontmatter(rel(".github", "agents", "delivery-autopilot.agent.md")).body;
  assert.match(autopilot, /models pins/, "Autopilot must read pins via `agento.mjs models pins`");
  assert.match(autopilot, /`runSubagent` `model`/, "Autopilot must pass the runSubagent model");
  assert.match(autopilot, /`pins\.builder\.subagentModel`/, "Autopilot must pass the Builder's pin");
  assert.match(autopilot, /`pins\.reviewer\.subagentModel`/, "Autopilot must pass the Reviewer's pin");
  assert.match(autopilot, /Tier refusal halts the run/, "Autopilot must stop on a tier refusal");
  assert.match(autopilot, /pin `autopilot` at least as high as the\s+highest-tier model/, "Autopilot must name the tier-refusal fix");
});
