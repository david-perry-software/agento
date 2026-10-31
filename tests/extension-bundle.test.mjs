import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.join(repositoryRoot, "extension");
const scriptsDirectory = path.join(repositoryRoot, "scripts");

// Mirrors extension/scripts/copy-cli.mjs: the curated flat modules plus the
// recursive lib/ and commands/ trees, excluding test files and test-helpers/.
const flatFiles = [
  "agento-config.mjs",
  "agento.mjs",
  "delivery-metrics.mjs",
  "delivery-roadmap-resolver.mjs",
  "harness.mjs",
  "merge-state.mjs",
  "model-filter.mjs",
  "model-profiles.mjs",
  "pending-dispatch.mjs",
  "release-state.mjs",
  "session-state.mjs",
  "vscode-windows.mjs",
  "worktree-occupants.mjs",
];

function collectSync(dir, prefix = "") {
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of names.sort()) {
    if (name === "test-helpers") continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = fs.statSync(full);
    if (info.isDirectory()) {
      entries.push(...collectSync(full, rel));
    } else if (info.isFile() && name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
      entries.push(rel);
    }
  }
  return entries;
}

const cliFiles = [
  ...flatFiles,
  ...collectSync(path.join(scriptsDirectory, "lib"), "lib"),
  ...collectSync(path.join(scriptsDirectory, "commands"), "commands"),
].sort();

function bundledFilesSync(dir, prefix = "") {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      entries.push(...bundledFilesSync(full, rel));
    } else {
      entries.push(rel);
    }
  }
  return entries;
}

test("extension CLI bundle contains exactly the source modules", () => {
  const bundledFiles = bundledFilesSync(path.join(extensionRoot, "cli")).sort();
  assert.deepEqual(bundledFiles, cliFiles);

  for (const file of cliFiles) {
    const source = fs.readFileSync(path.join(scriptsDirectory, file));
    const bundled = fs.readFileSync(path.join(extensionRoot, "cli", file));
    assert.ok(bundled.equals(source), `extension/cli/${file} differs from scripts/${file}`);
  }
});

test("extension carries the repository license byte for byte", () => {
  const source = fs.readFileSync(path.join(repositoryRoot, "LICENSE"));
  const bundled = fs.readFileSync(path.join(extensionRoot, "LICENSE"));
  assert.ok(bundled.equals(source), "extension/LICENSE differs from LICENSE");
});

test("extension manifest preserves packaging invariants", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "extension must have no runtime dependencies");
  assert.match(manifest.engines.vscode, /^\^1\.\d+\.\d+$/);
});

test("copy-cli is the only extension script that writes the CLI bundle", () => {
  const scriptsDirectory = path.join(extensionRoot, "scripts");
  const writers = fs
    .readdirSync(scriptsDirectory)
    .filter((name) => {
      const source = fs.readFileSync(path.join(scriptsDirectory, name), "utf8");
      return source.includes("cli") && /\b(?:copyFile|rm)\s*\(/.test(source);
    });
  assert.deepEqual(writers, ["copy-cli.mjs"]);
});