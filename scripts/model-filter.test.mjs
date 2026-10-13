import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanText, smudgeText } from "./model-filter.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const prompt = "---\ndescription: \"Ship it\"\nargument-hint: \"<slug>\"\nagent: agent\n---\n\nBody.\n";
const agent = [
  "---",
  "name: Delivery Builder",
  "description: \"Builds\"",
  "handoffs:",
  "  - label: Review",
  "    agent: Delivery Reviewer",
  "    prompt: Review it",
  "    send: false",
  "  - label: Plan",
  "    agent: Delivery Planner",
  "    prompt: Plan it",
  "---",
  "",
  "Body.",
  "",
].join("\n");

const cases = [
  ["top-level string pin", prompt, { model: "GPT-5 (copilot)", handoffs: [] }],
  ["top-level list pin", prompt, { model: ["Claude Opus 4.6 (copilot)", "GPT-5 (copilot)"], handoffs: [] }],
  ["handoff pins", agent, { model: "GPT-5 (copilot)", handoffs: [{ target: "Delivery Reviewer", value: "Claude Opus 4.6 (copilot)" }, { target: "Delivery Planner", value: null }] }],
  ["CRLF file", prompt.replace(/\n/g, "\r\n"), { model: "GPT-5 (copilot)", handoffs: [] }],
  ["CRLF handoffs", agent.replace(/\n/g, "\r\n"), { model: null, handoffs: [{ target: "Delivery Planner", value: "GPT-5 (copilot)" }] }],
];

for (const [name, text, record] of cases) {
  test(`model filter round-trips: ${name}`, () => {
    const pinned = smudgeText(text, record);
    assert.notEqual(pinned, text, "smudge inserts the recorded pins");
    assert.equal(cleanText(pinned, record), text, "clean(smudge(x)) === x");
    assert.equal(smudgeText(cleanText(pinned, record), record), pinned, "smudge(clean(y)) === y");
    assert.equal(cleanText(text, record), text, "clean of pin-free content is identity");
    assert.equal(smudgeText(pinned, record), pinned, "smudge leaves existing pins alone");
  });
}

test("model filter keeps CRLF endings on inserted pins", () => {
  const pinned = smudgeText(prompt.replace(/\n/g, "\r\n"), { model: "GPT-5 (copilot)" });
  assert.match(pinned, /\r\nmodel: "GPT-5 \(copilot\)"\r\n/);
  assert.doesNotMatch(pinned.replace(/\r\n/g, ""), /\n/);
});

test("model filter passes mismatched (hand-edited) pins through clean", () => {
  const record = { model: "GPT-5 (copilot)", handoffs: [{ target: "Delivery Reviewer", value: "GPT-5 (copilot)" }] };
  const handEdited = smudgeText(agent, { model: "Other (copilot)", handoffs: [{ target: "Delivery Reviewer", value: "Other (copilot)" }] });
  assert.equal(cleanText(handEdited, record), handEdited);
});

test("model filter passes files without frontmatter through", () => {
  const plain = "# No frontmatter\n";
  const record = { model: "GPT-5 (copilot)", handoffs: [{ target: "X", value: "GPT-5 (copilot)" }] };
  assert.equal(smudgeText(plain, record), plain);
  assert.equal(cleanText(plain, record), plain);
});

function filterDir(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agento-filter-"));
  for (const file of ["model-filter.mjs", "model-profiles.mjs"]) fs.copyFileSync(path.join(scriptsDir, file), path.join(dir, file));
  if (state !== undefined) fs.writeFileSync(path.join(dir, "model-pins.json"), state);
  return dir;
}

const run = (dir, mode, file, input) => spawnSync(process.execPath, [path.join(dir, "model-filter.mjs"), mode, file], { input, encoding: "utf8" });

test("model filter CLI applies recorded pins and passes unrecorded paths through", () => {
  const record = { model: "GPT-5 (copilot)", handoffs: [] };
  const dir = filterDir(JSON.stringify({ version: 1, files: { ".github/prompts/ship.prompt.md": record } }));
  try {
    const smudged = run(dir, "smudge", ".github/prompts/ship.prompt.md", prompt);
    assert.equal(smudged.status, 0, smudged.stderr);
    assert.equal(smudged.stdout, smudgeText(prompt, record));
    const cleaned = run(dir, "clean", ".github/prompts/ship.prompt.md", smudged.stdout);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stdout, prompt);
    for (const mode of ["clean", "smudge"]) {
      const other = run(dir, mode, ".github/prompts/other.prompt.md", smudged.stdout);
      assert.equal(other.status, 0, other.stderr);
      assert.equal(other.stdout, smudged.stdout, `${mode} passes an unrecorded path through`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model filter CLI passes everything through without a state file", () => {
  const dir = filterDir();
  try {
    const result = run(dir, "smudge", ".github/prompts/ship.prompt.md", prompt);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, prompt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model filter CLI exits nonzero with one stderr line on invalid state", () => {
  for (const state of ["{not json", JSON.stringify({ version: 2, files: {} }), JSON.stringify({ version: 1, files: [] })]) {
    const dir = filterDir(state);
    try {
      for (const mode of ["clean", "smudge"]) {
        const result = run(dir, mode, ".github/prompts/ship.prompt.md", prompt);
        assert.notEqual(result.status, 0, `${mode} with ${state}`);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.trim().split("\n").length, 1);
        assert.match(result.stderr, /model-pins\.json is invalid.*models clear.*models adopt/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
