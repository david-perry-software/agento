#!/usr/bin/env node
// Git clean/smudge filter for model-profile pins (`agento.mjs models apply|adopt`
// installs it as `filter.agento-models`). Usage: model-filter.mjs clean|smudge <path>,
// file content on stdin, filtered content on stdout. Pins come from model-pins.json
// next to this script; a path it does not record passes through byte-identical.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoffModelLines, readModel, renderModel, setHandoffModels, setModel } from "./model-profiles.mjs";

export const STATE_FILE = "model-pins.json";

// { files: { [path]: { model, handoffs: [{ target, value }] } } }; a missing or empty
// file is an empty state; anything unparseable throws.
export function loadState(dir) {
  const file = path.join(dir, STATE_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, files: {} };
    throw error;
  }
  if (!text.trim()) return { version: 1, files: {} };
  const data = JSON.parse(text);
  if (data === null || typeof data !== "object" || data.version !== 1 || data.files === null || typeof data.files !== "object" || Array.isArray(data.files)) {
    throw new Error("expected { \"version\": 1, \"files\": { … } }");
  }
  return data;
}

const topLine = (text) => readModel(setHandoffModels(text, null));

// Removes only the pins equal to the recorded values; every other byte stays.
export function cleanText(text, record) {
  if (!record) return text;
  let out = text;
  const top = renderModel(record.model ?? null);
  if (top !== null && topLine(out) === top) out = setModel(out, null);
  const recorded = record.handoffs ?? [];
  const items = handoffModelLines(out);
  const removals = [];
  for (const { target, value } of recorded) {
    const line = renderModel(value ?? null);
    if (line === null) continue;
    const mine = items.filter((item) => item.target === target);
    if (mine.length && mine.every((item) => item.line === line)) removals.push({ target, value: null });
  }
  return removals.length ? setHandoffModels(out, removals) : out;
}

// Inserts the recorded pins into slots that carry none; an existing pin is kept.
export function smudgeText(text, record) {
  if (!record) return text;
  let out = text;
  if ((record.model ?? null) !== null && topLine(out) === null) {
    try {
      out = setModel(out, record.model);
    } catch {
      return text;
    }
  }
  const items = handoffModelLines(out);
  const inserts = (record.handoffs ?? []).filter(({ target, value }) => (value ?? null) !== null && items.some((i) => i.target === target) && items.filter((i) => i.target === target).every((i) => i.line === null));
  return inserts.length ? setHandoffModels(out, inserts) : out;
}

function main([mode, file]) {
  if ((mode !== "clean" && mode !== "smudge") || !file) {
    process.stderr.write("usage: model-filter.mjs clean|smudge <path>\n");
    return 2;
  }
  const input = fs.readFileSync(0);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let state;
  try {
    state = loadState(dir);
  } catch (error) {
    process.stderr.write(`agento model filter: ${path.join(dir, STATE_FILE)} is invalid (${error.message}); run \`agento.mjs models clear\` or \`agento.mjs models adopt\` on the plugin clone\n`);
    return 1;
  }
  const key = file.split(path.sep).join("/").replace(/^\.\//, "");
  const record = Object.hasOwn(state.files, key) ? state.files[key] : null;
  if (!record) {
    process.stdout.write(input);
    return 0;
  }
  const text = input.toString("utf8");
  const output = mode === "clean" ? cleanText(text, record) : smudgeText(text, record);
  process.stdout.write(output === text ? input : Buffer.from(output, "utf8"));
  return 0;
}

const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
