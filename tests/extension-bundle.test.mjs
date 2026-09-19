import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionRoot = path.join(repositoryRoot, "extension");
const cliFiles = [
  "agento-config.mjs",
  "agento.mjs",
  "delivery-roadmap-resolver.mjs",
  "session-state.mjs",
];

test("extension CLI bundle contains exactly the source modules", () => {
  const bundledFiles = fs.readdirSync(path.join(extensionRoot, "cli")).sort();
  assert.deepEqual(bundledFiles, cliFiles);

  for (const file of cliFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, "scripts", file));
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